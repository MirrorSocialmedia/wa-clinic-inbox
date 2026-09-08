import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { requireAdmin, invalidateGroupCache } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { assertGroupMembersBound } from "@/lib/skill-groups";

/**
 * /api/admin/skill-groups — ★ cwi-routing-20260906（MD §4.1）：技能組管理（ADMIN-only）。
 *
 * GET  → 組列表（name/code/members[]/clinicIds/memberCount/enabled）
 * POST → 建組 { name, memberIds?, clinicIds?, description? }（code 自動生成）
 */

export const GET = handle(async (req: NextRequest) => {
  await requireAdmin(req);
  const [groups, members, groupClinics] = await Promise.all([
    prisma.skillGroup.findMany({ orderBy: [{ name: "asc" }] }),
    prisma.skillGroupMember.findMany({ select: { groupId: true, staffId: true } }),
    prisma.skillGroupClinic.findMany({ select: { groupId: true, clinicId: true } }),
  ]);
  const [staff, clinics] = await Promise.all([
    prisma.staffUser.findMany({ where: { active: true }, select: { id: true, name: true } }),
    prisma.clinic.findMany({ select: { id: true, code: true, name: true }, orderBy: { code: "asc" } }),
  ]);
  const staffName = new Map(staff.map((s) => [s.id, s.name]));
  const clinicCode = new Map(clinics.map((c) => [c.id, c.code]));

  const byGroup = <T extends { groupId: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const arr = m.get(r.groupId) ?? [];
      arr.push(r);
      m.set(r.groupId, arr);
    }
    return m;
  };
  const memberByGroup = byGroup(members);
  const clinicByGroup = byGroup(groupClinics);

  const items = groups.map((g) => {
    const ms = memberByGroup.get(g.id) ?? [];
    const cs = clinicByGroup.get(g.id) ?? [];
    return {
      id: g.id,
      name: g.name,
      code: g.code,
      description: g.description,
      enabled: g.enabled,
      memberCount: ms.length,
      members: ms.map((m) => ({ id: m.staffId, name: staffName.get(m.staffId) ?? "（已停用）" })),
      memberIds: ms.map((m) => m.staffId),
      clinicIds: cs.map((c) => c.clinicId),
      clinicCodes: cs.map((c) => clinicCode.get(c.clinicId) ?? null),
    };
  });
  // 管理頁編輯用：全部 active staff + 全部店（一次過返 — 編輯器多選源）
  return NextResponse.json({
    groups: items,
    staff: staff.map((s) => ({ id: s.id, name: s.name })),
    clinics: clinics.map((c) => ({ id: c.id, name: c.name, code: c.code })),
  });
});

const createSchema = {
  name: (v: unknown) => (typeof v === "string" && v.trim().length > 0 && v.trim().length <= 40),
  memberIds: (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string"),
  clinicIds: (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string"),
  description: (v: unknown) => v === null || (typeof v === "string" && v.length <= 200),
};

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAdmin(req);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !createSchema.name(body.name)) {
    return NextResponse.json({ error: "bad_request", message: "body: { name, memberIds?, clinicIds?, description? }" }, { status: 400 });
  }
  if (body.memberIds !== undefined && !createSchema.memberIds(body.memberIds)) {
    return NextResponse.json({ error: "bad_request", message: "memberIds must be string[]" }, { status: 400 });
  }
  if (body.clinicIds !== undefined && !createSchema.clinicIds(body.clinicIds)) {
    return NextResponse.json({ error: "bad_request", message: "clinicIds must be string[]" }, { status: 400 });
  }
  const name = (body.name as string).trim();

  // code 自動生成：name → 大寫 alnum（中文 → 用拼音首碼太 heavy；用 G + 隨機尾碼保底）
  const base = name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "G";
  let code = base;
  for (let i = 2; ; i++) {
    const exists = await prisma.skillGroup.findUnique({ where: { code } });
    if (!exists) break;
    code = `${base}${i}`;
    if (i > 99) {
      return NextResponse.json({ error: "code_conflict", message: "too many same-prefix groups" }, { status: 409 });
    }
  }

  const group = await prisma.skillGroup.create({
    data: { name, code, description: (body.description as string) ?? null, enabled: true },
  });
  const memberIds = (body.memberIds as string[]) ?? [];
  const clinicIds = (body.clinicIds as string[]) ?? [];
  // ★ cwi-auditfix-20260908（B-1）：成員必綁定全部服務店 — 否則被 route 嘅對話對佢鎖死
  const boundErr = await assertGroupMembersBound(prisma, memberIds, clinicIds);
  if (boundErr) {
    // 回滾剛建嘅空組（保持 hermetic — 唔留殘屍）
    await prisma.skillGroup.delete({ where: { id: group.id } }).catch(() => undefined);
    return NextResponse.json({ error: "member_not_bound", message: boundErr }, { status: 400 });
  }
  if (memberIds.length > 0) {
    await prisma.skillGroupMember.createMany({
      data: memberIds.map((staffId) => ({ groupId: group.id, staffId })),
    });
    // ★ cwi-auditfix-20260908（B-1）：新成員入組 → 路由放行 cache 即時失效
    invalidateGroupCache();
  }
  if (clinicIds.length > 0) {
    await prisma.skillGroupClinic.createMany({
      data: clinicIds.map((clinicId) => ({ groupId: group.id, clinicId })),
    });
  }
  // audit（零 PII：只記組 code + 操作者 id）
  await prisma.auditLog
    .create({
      data: {
        staffId: ctx.staff.id,
        action: "SKILL_GROUP_CREATED",
        entity: "SkillGroup",
        entityId: group.id,
        meta: { code, name, memberCount: memberIds.length, clinicCount: clinicIds.length } as Prisma.InputJsonValue,
      },
    })
    .catch(() => undefined);
  return NextResponse.json({ id: group.id, code });
});

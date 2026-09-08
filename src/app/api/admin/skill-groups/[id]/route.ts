import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { requireAdmin, invalidateGroupCache, RbacError } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { assertGroupMembersBound } from "@/lib/skill-groups";

/**
 * /api/admin/skill-groups/[id] — ★ cwi-routing-20260906（MD §4.1）：技能組編輯（ADMIN-only）。
 *
 * PATCH → { name?, description?, memberIds?, clinicIds?, enabled? }
 *   memberIds / clinicIds = 完整列表（replace 語義：撳咗先留，冇撳咗就移出 — UI 送全量）。
 * DELETE → 删組；被路由規則引用（target/escalate）→ 409（防規則指向死組）。
 */

export const PATCH = handle(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAdmin(req);
    const { id } = await params;
    const group = await prisma.skillGroup.findUnique({ where: { id } });
    if (!group) return NextResponse.json({ error: "not found" }, { status: 404 });

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "bad_request" }, { status: 400 });

    if (body.name !== undefined) {
      if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.trim().length > 40) {
        return NextResponse.json({ error: "bad_request", message: "name must be 1-40 chars" }, { status: 400 });
      }
      group.name = body.name.trim();
    }
    if (body.description !== undefined) {
      if (body.description !== null && (typeof body.description !== "string" || body.description.length > 200)) {
        return NextResponse.json({ error: "bad_request", message: "description must be null or ≤200 chars" }, { status: 400 });
      }
      group.description = body.description as string | null;
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        return NextResponse.json({ error: "bad_request", message: "enabled must be boolean" }, { status: 400 });
      }
      group.enabled = body.enabled;
    }
    const memberIds = Array.isArray(body.memberIds) && body.memberIds.every((x) => typeof x === "string")
      ? (body.memberIds as string[])
      : null;
    const clinicIds = Array.isArray(body.clinicIds) && body.clinicIds.every((x) => typeof x === "string")
      ? (body.clinicIds as string[])
      : null;
    if (body.memberIds !== undefined && memberIds === null) {
      return NextResponse.json({ error: "bad_request", message: "memberIds must be string[]" }, { status: 400 });
    }
    if (body.clinicIds !== undefined && clinicIds === null) {
      return NextResponse.json({ error: "bad_request", message: "clinicIds must be string[]" }, { status: 400 });
    }

    const r = await prisma.$transaction(async (tx) => {
      const g = await tx.skillGroup.update({
        where: { id },
        data: {
          name: group.name,
          description: group.description,
          enabled: group.enabled,
        },
      });
      // ★ cwi-auditfix-20260908（B-1）：replace 語義下先算最終狀態（memberIds/clinicIds 未送 = 維持現狀），
      //   再驗證「每個成員 × 每間服務店」全部有 StaffClinic — 擋「加成員」同「加新服務店」兩種壞路徑。
      const curMembers = await tx.skillGroupMember.findMany({ where: { groupId: id }, select: { staffId: true } });
      const curClinics = await tx.skillGroupClinic.findMany({ where: { groupId: id }, select: { clinicId: true } });
      const finalMembers = memberIds ? memberIds : curMembers.map((m) => m.staffId);
      const finalClinics = clinicIds ? clinicIds : curClinics.map((c) => c.clinicId);
      const boundErr = await assertGroupMembersBound(tx, finalMembers, finalClinics);
      if (boundErr) throw new RbacError(400, boundErr);
      if (memberIds) {
        // replace 語義：撳咗先留（createMany skipDuplicates 冪等）
        const current = await tx.skillGroupMember.findMany({ where: { groupId: id }, select: { staffId: true } });
        const keep = new Set(memberIds);
        const drop = current.filter((m) => !keep.has(m.staffId)).map((m) => m.staffId);
        if (drop.length > 0) {
          await tx.skillGroupMember.deleteMany({ where: { groupId: id, staffId: { in: drop } } });
        }
        await tx.skillGroupMember.createMany({
          data: memberIds.map((staffId) => ({ groupId: id, staffId })),
          skipDuplicates: true,
        });
      }
      if (clinicIds) {
        const current = await tx.skillGroupClinic.findMany({ where: { groupId: id }, select: { clinicId: true } });
        const keep = new Set(clinicIds);
        const drop = current.filter((m) => !keep.has(m.clinicId)).map((m) => m.clinicId);
        if (drop.length > 0) {
          await tx.skillGroupClinic.deleteMany({ where: { groupId: id, clinicId: { in: drop } } });
        }
        await tx.skillGroupClinic.createMany({
          data: clinicIds.map((clinicId) => ({ groupId: id, clinicId })),
          skipDuplicates: true,
        });
      }
      return g;
    });

    // ★ cwi-auditfix-20260908（B-1）：成員變動 → 路由放行 cache 即時失效
    if (memberIds || clinicIds) invalidateGroupCache();

    await prisma.auditLog
      .create({
        data: {
          staffId: ctx.staff.id,
          action: "SKILL_GROUP_UPDATED",
          entity: "SkillGroup",
          entityId: id,
          meta: { code: r.code, fields: Object.keys(body).filter((k) => k !== "name" || body.name !== undefined) } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
    return NextResponse.json({ ok: true });
  });

export const DELETE = handle(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireAdmin(req);
    const { id } = await params;
    const group = await prisma.skillGroup.findUnique({ where: { id } });
    if (!group) return NextResponse.json({ error: "not found" }, { status: 404 });

    // 被路由規則引用（主目標 ∨ 升級目標）→ 409（先改規則再删組 — 防規則指向死組）
    const [asTarget, asEscalate] = await Promise.all([
      prisma.routingRule.count({ where: { targetGroupId: id, enabled: true } }),
      prisma.routingRule.count({ where: { escalateToGroupId: id, enabled: true } }),
    ]);
    if (asTarget + asEscalate > 0) {
      return NextResponse.json(
        {
          error: "in_use",
          message: `呢個組被 ${asTarget + asEscalate} 條啟用中嘅路由規則引用 — 先改規則再删組`,
        },
        { status: 409 }
      );
    }

    await prisma.$transaction([
      prisma.skillGroupMember.deleteMany({ where: { groupId: id } }),
      prisma.skillGroupClinic.deleteMany({ where: { groupId: id } }),
      prisma.skillGroup.delete({ where: { id } }),
    ]);
    // ★ cwi-auditfix-20260908（B-1）：組删 → 成員路由放行集合變動，cache 即時失效
    invalidateGroupCache();

    await prisma.auditLog
      .create({
        data: {
          staffId: ctx.staff.id,
          action: "SKILL_GROUP_DELETED",
          entity: "SkillGroup",
          entityId: id,
          meta: { code: group.code, name: group.name } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
    return NextResponse.json({ ok: true });
  });

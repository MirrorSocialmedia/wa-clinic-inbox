import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { validateRuleBody, assertTargetsExist } from "@/lib/routing/rule-validate";

/**
 * /api/admin/routing-rules — ★ cwi-routing-20260906（MD §4.2）：路由規則管理（ADMIN-only）。
 *
 * GET  → 規則列表（priority 排序；帶目標/升級組名 + 店名 — 管理頁一次過 render）
 * POST → 建新規則（MD §4.2 編輯面板字段）
 *
 * 排序鐵律：priority 細數行先、首個命中即停 — UI 拖拉 reorder 走 /reorder。
 */

export const GET = handle(async (req: NextRequest) => {
  await requireAdmin(req);
  const url = new URL(req.url);
  const clinicParam = url.searchParams.get("clinicId"); // null | "all" | <id>

  const where: Record<string, unknown> = {};
  if (clinicParam && clinicParam !== "all") where.clinicId = clinicParam;
  const [rules, groups, staff, clinics] = await Promise.all([
    prisma.routingRule.findMany({ where, orderBy: [{ priority: "asc" }, { name: "asc" }] }),
    prisma.skillGroup.findMany({ select: { id: true, name: true, code: true, enabled: true } }),
    prisma.staffUser.findMany({ select: { id: true, name: true, active: true } }),
    prisma.clinic.findMany({ select: { id: true, name: true, code: true } }),
  ]);
  const groupName = new Map(groups.map((g) => [g.id, g]));
  const staffName = new Map(staff.map((s) => [s.id, s.name]));
  const clinicMap = new Map(clinics.map((c) => [c.id, c]));

  const items = rules.map((r) => ({
    id: r.id,
    name: r.name,
    clinicId: r.clinicId,
    clinicName: r.clinicId ? (clinicMap.get(r.clinicId)?.name ?? null) : null,
    clinicCode: r.clinicId ? (clinicMap.get(r.clinicId)?.code ?? null) : null,
    priority: r.priority,
    enabled: r.enabled,
    intents: r.intents,
    keywords: r.keywords,
    patientType: r.patientType,
    targetType: r.targetType,
    targetGroupId: r.targetGroupId,
    targetGroupName: r.targetGroupId ? (groupName.get(r.targetGroupId)?.name ?? null) : null,
    targetGroupCode: r.targetGroupId ? (groupName.get(r.targetGroupId)?.code ?? null) : null,
    targetStaffId: r.targetStaffId,
    targetStaffName: r.targetStaffId ? (staffName.get(r.targetStaffId) ?? null) : null,
    autoReplyTemplate: r.autoReplyTemplate,
    escalateAfterMin: r.escalateAfterMin,
    escalateToGroupId: r.escalateToGroupId,
    escalateToGroupName: r.escalateToGroupId ? (groupName.get(r.escalateToGroupId)?.name ?? null) : null,
    updatedAt: r.updatedAt,
  }));
  // 管理頁編輯用：組 / staff / 店 全量（一次過返 — 下拉源）
  return NextResponse.json({
    rules: items,
    groups: groups.map((g) => ({ id: g.id, name: g.name, code: g.code, enabled: g.enabled })),
    staff: staff.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name })),
    clinics: clinics.map((c) => ({ id: c.id, name: c.name, code: c.code })),
  });
});

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAdmin(req);
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const [err, rule] = validateRuleBody(raw);
  if (err) return NextResponse.json({ error: "bad_request", message: err }, { status: 400 });
  const targetErr = await assertTargetsExist(rule!);
  if (targetErr) return NextResponse.json({ error: "bad_request", message: targetErr }, { status: 400 });

  // 同名 + 同 clinic 域 → 409（防意外重複規則）
  const dup = await prisma.routingRule.findFirst({
    where: { name: rule!.name, clinicId: rule!.clinicId },
    select: { id: true },
  });
  if (dup) {
    return NextResponse.json({ error: "duplicate", message: "同名規則已存在（同一店域）" }, { status: 409 });
  }

  const created = await prisma.routingRule.create({
    data: {
      name: rule!.name,
      clinicId: rule!.clinicId,
      priority: rule!.priority,
      enabled: rule!.enabled,
      intents: rule!.intents,
      keywords: rule!.keywords,
      patientType: rule!.patientType,
      targetType: rule!.targetType,
      targetGroupId: rule!.targetGroupId,
      targetStaffId: rule!.targetStaffId,
      autoReplyTemplate: rule!.autoReplyTemplate,
      escalateAfterMin: rule!.escalateAfterMin,
      escalateToGroupId: rule!.escalateToGroupId,
      createdBy: ctx.staff.id,
    },
  });

  await prisma.auditLog
    .create({
      data: {
        staffId: ctx.staff.id,
        action: "ROUTING_RULE_CREATED",
        entity: "RoutingRule",
        entityId: created.id,
        meta: { name: rule!.name, clinicId: rule!.clinicId, priority: rule!.priority, targetType: rule!.targetType } as Prisma.InputJsonValue,
      },
    })
    .catch(() => undefined);
  return NextResponse.json({ id: created.id, priority: created.priority });
});

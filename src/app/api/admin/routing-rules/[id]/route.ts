import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { validateRuleBody, assertTargetsExist } from "@/lib/routing/rule-validate";

/**
 * /api/admin/routing-rules/[id] — ★ cwi-routing-20260906（MD §4.2）：規則編輯（ADMIN-only）。
 *
 * PATCH → partial 更新（送咗先改；name/priority 改動即時生效 — engine 每次匹配都查 DB，無 cache）
 * DELETE → 删規則（對話行嘅 routed* 標記保留 — 歷史痕跡；engine 唔會再命中）
 */

export const PATCH = handle(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireAdmin(req);
  const { id } = await params;
  const current = await prisma.routingRule.findUnique({ where: { id } });
  if (!current) return NextResponse.json({ error: "not found" }, { status: 404 });

  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const [err, rule] = validateRuleBody(raw, {
    partial: true,
    current: {
      name: current.name,
      clinicId: current.clinicId,
      priority: current.priority,
      enabled: current.enabled,
      intents: current.intents,
      keywords: current.keywords,
      patientType: current.patientType,
      targetType: current.targetType,
      targetGroupId: current.targetGroupId,
      targetStaffId: current.targetStaffId,
      autoReplyTemplate: current.autoReplyTemplate,
      escalateAfterMin: current.escalateAfterMin,
      escalateToGroupId: current.escalateToGroupId,
    },
  });
  if (err) return NextResponse.json({ error: "bad_request", message: err }, { status: 400 });
  const targetErr = await assertTargetsExist(rule!);
  if (targetErr) return NextResponse.json({ error: "bad_request", message: targetErr }, { status: 400 });

  // 同名衝突（改 name / clinicId 時）
  if (rule!.name !== current.name || rule!.clinicId !== current.clinicId) {
    const dup = await prisma.routingRule.findFirst({
      where: { name: rule!.name, clinicId: rule!.clinicId, id: { not: id } },
      select: { id: true },
    });
    if (dup) return NextResponse.json({ error: "duplicate", message: "同名規則已存在（同一店域）" }, { status: 409 });
  }

  const updated = await prisma.routingRule.update({
    where: { id },
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
    },
  });

  await prisma.auditLog
    .create({
      data: {
        staffId: ctx.staff.id,
        action: "ROUTING_RULE_UPDATED",
        entity: "RoutingRule",
        entityId: id,
        meta: { name: updated.name, fields: Object.keys(raw) } as Prisma.InputJsonValue,
      },
    })
    .catch(() => undefined);
  return NextResponse.json({ ok: true, priority: updated.priority });
});

export const DELETE = handle(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireAdmin(req);
  const { id } = await params;
  const rule = await prisma.routingRule.findUnique({ where: { id } });
  if (!rule) return NextResponse.json({ error: "not found" }, { status: 404 });

  await prisma.routingRule.delete({ where: { id } });
  await prisma.auditLog
    .create({
      data: {
        staffId: ctx.staff.id,
        action: "ROUTING_RULE_DELETED",
        entity: "RoutingRule",
        entityId: id,
        meta: { name: rule.name, clinicId: rule.clinicId, priority: rule.priority } as Prisma.InputJsonValue,
      },
    })
    .catch(() => undefined);
  return NextResponse.json({ ok: true });
});

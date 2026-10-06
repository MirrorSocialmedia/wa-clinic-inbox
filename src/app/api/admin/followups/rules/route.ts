import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAdmin, configReadWhere, assertConfigScope } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { FOLLOWUP_TRIGGER_LABELS } from "@/lib/followup/factory-defaults";

/**
 * ★ cwi-followup-p3-20260916（followup-v2 MD §4.7 驗收 #6：規則管理）：follow-up 規則（ADMIN-only）。
 *
 * GET /api/admin/followups/rules
 *   → { rules: [{ id, name, enabled, trigger, delayValue, delayUnit, templateName,
 *               templateApproved, level, maxSends, cancelOn*... }] }
 *   templateApproved = 該規則引用 template 嘅審批狀態（UI 提示：未審批 + 窗口過 → SKIPPED(NO_TEMPLATE)）。
 *
 * ★ cwi-setfix F-1：POST /api/admin/followups/rules — 新增規則（以前冇入口 — 生產 DB 唔行 seed → 規則表永遠空）。
 *   body { name, trigger, delayValue, delayUnit, templateName, reasonCodes?, clinicId? }
 *   - clinicId 缺／null = 全局（global admin）；有值 = 店規則（scope 內）
 *   - 新規則一律 enabled=false（管理員檢查完先喺表度開 — BEFORE_APPOINTMENT 開時照行首啟用確認）
 *   - level 恒 L1（v3 建議層）；templateName 必須存在（FollowupTemplate.key）
 */
export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAdmin(req);
  const [rules, templates] = await Promise.all([
    // ★ cwi-final S3-1：全局規則 + scope 內店規則（global admin = 全部）
    prisma.followupRule.findMany({ where: configReadWhere(ctx), orderBy: [{ enabled: "desc" }, { name: "asc" }] }),
    prisma.followupTemplate.findMany({ select: { key: true, approved: true } }),
  ]);
  const approvedMap = new Map(templates.map((t) => [t.key, t.approved]));
  return NextResponse.json({
    rules: rules.map((r) => ({ ...r, templateApproved: approvedMap.get(r.templateName) ?? false })),
  });
});

const UNITS = new Set(["HOUR", "DAY", "WEEK", "MONTH"]);
const TRIGGERS = new Set(Object.keys(FOLLOWUP_TRIGGER_LABELS));

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAdmin(req);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const clinicId = typeof body.clinicId === "string" && body.clinicId ? body.clinicId : null;
  assertConfigScope(ctx, clinicId); // scope 先（唔洩漏 template 存在性）
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 60) return NextResponse.json({ error: "name 1-60 字" }, { status: 400 });
  const trigger = String(body.trigger ?? "");
  if (!TRIGGERS.has(trigger)) return NextResponse.json({ error: "bad trigger" }, { status: 400 });
  const delayValue = Number(body.delayValue);
  if (!Number.isInteger(delayValue) || delayValue < 1 || delayValue > 365) return NextResponse.json({ error: "delayValue 1-365" }, { status: 400 });
  const delayUnit = String(body.delayUnit ?? "");
  if (!UNITS.has(delayUnit)) return NextResponse.json({ error: "bad delayUnit" }, { status: 400 });
  const reasonCodes = Array.isArray(body.reasonCodes)
    ? body.reasonCodes.map((x) => String(x).trim()).filter((x) => x.length > 0 && x.length <= 20)
    : [];
  if (reasonCodes.length > 20) return NextResponse.json({ error: "reasonCodes 最多 20 個" }, { status: 400 });
  const templateName = String(body.templateName ?? "");
  const tpl = templateName ? await prisma.followupTemplate.findUnique({ where: { key: templateName }, select: { key: true } }) : null;
  if (!tpl) return NextResponse.json({ error: "template not found" }, { status: 400 });

  const rule = await prisma.followupRule.create({
    data: {
      clinicId,
      name,
      enabled: false,
      trigger: trigger as never,
      delayValue,
      delayUnit: delayUnit as never,
      reasonCodes,
      templateName,
      level: "L1",
      maxSends: 1,
      createdBy: ctx.staff.id,
    },
  });
  await prisma.auditLog.create({
    data: {
      staffId: ctx.staff.id,
      action: "FOLLOWUP_RULE_CREATED",
      entity: "FollowupRule",
      entityId: rule.id,
      meta: { trigger, clinicId, templateName } as object,
    },
  });
  return NextResponse.json({ rule }, { status: 201 });
});

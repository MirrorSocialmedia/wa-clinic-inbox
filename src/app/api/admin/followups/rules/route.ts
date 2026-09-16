import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";

/**
 * ★ cwi-followup-p3-20260916（followup-v2 MD §4.7 驗收 #6：規則管理）：follow-up 規則（ADMIN-only）。
 *
 * GET /api/admin/followups/rules
 *   → { rules: [{ id, name, enabled, trigger, delayValue, delayUnit, minAmount, templateName,
 *               templateApproved, level, maxSends, cancelOn*... }] }
 *   templateApproved = 該規則引用 template 嘅審批狀態（UI 提示：未審批 + 窗口過 → SKIPPED(NO_TEMPLATE)）。
 */
export const dynamic = "force-dynamic";

export const GET = handle(async (_req: NextRequest) => {
  await requireAdmin(_req);
  const [rules, templates] = await Promise.all([
    prisma.followupRule.findMany({ orderBy: [{ enabled: "desc" }, { name: "asc" }] }),
    prisma.followupTemplate.findMany({ select: { key: true, approved: true } }),
  ]);
  const approvedMap = new Map(templates.map((t) => [t.key, t.approved]));
  return NextResponse.json({
    rules: rules.map((r) => ({ ...r, templateApproved: approvedMap.get(r.templateName) ?? false })),
  });
});

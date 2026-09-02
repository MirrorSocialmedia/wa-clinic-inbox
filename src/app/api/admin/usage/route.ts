import { type NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { getUsageSummary } from "@/lib/ops/usage";

/**
 * GET /api/admin/usage — cwi-window-20260901（P4 / W-4）
 *
 * 本月用量（按店 × 類別 × 人手/AI/系統）+ App 跟進次數 + 週趨勢 + AI 自動覆佔比。
 * ADMIN 限定（STAFF → 403）。只出條數 — 唔硬編費率。
 */
export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  await requireAdmin(req);
  const summary = await getUsageSummary();
  return NextResponse.json({
    month: summary.month,
    from: summary.fromUtc.toISOString(),
    to: summary.toUtc.toISOString(),
    rows: summary.rows,
    appHandoff: summary.appHandoff,
    weekTrend: summary.weekTrend,
    totals: summary.totals,
  });
});

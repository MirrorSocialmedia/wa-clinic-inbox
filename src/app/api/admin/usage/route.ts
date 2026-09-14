import { type NextRequest, NextResponse } from "next/server";
import { requireAdmin, scopedClinicSet } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { getUsageSummary, getUsageCompanies } from "@/lib/ops/usage";

/**
 * GET /api/admin/usage — cwi-window-20260901（P4 / W-4）
 *
 * 本月用量（按店 × 類別 × 人手/AI/系統）+ App 跟進次數 + 週趨勢 + AI 自動覆佔比。
 * ADMIN 限定（STAFF → 403）。只出條數 — 唔硬編費率。
 *
 * ★ cwi-hub-a-20260914（A.4）：公司分組
 *   - clinic 集合一律由 scopedClinicSet(ctx) 得出（鐵律 — 本 route 唔自行算）。
 *   - ALL scope → null（全部）；COMPANY/CLINICS → 範圍內 id 集合（rows/appHandoff/weekTrend 全部過濾）。
 *   - 返回 `companies`（公司 + 旗下診所）→ UI 先按公司、再按店分組。
 */
export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAdmin(req);
  // null = ALL（無限制）；非 null = 範圍內診所 id 集合
  const clinicIds = scopedClinicSet(ctx);
  const [summary, companies] = await Promise.all([
    getUsageSummary(new Date(), clinicIds),
    getUsageCompanies(clinicIds),
  ]);
  return NextResponse.json({
    month: summary.month,
    from: summary.fromUtc.toISOString(),
    to: summary.toUtc.toISOString(),
    rows: summary.rows,
    appHandoff: summary.appHandoff,
    weekTrend: summary.weekTrend,
    totals: summary.totals,
    companies,
  });
});

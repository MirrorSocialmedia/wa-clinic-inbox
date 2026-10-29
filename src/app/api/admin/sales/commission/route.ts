/**
 * ★ cwi-sales 第 3 期：GET /api/admin/sales/commission?month=YYYY-MM — 老闆：當月每個銷售傭金合計（集團管理員）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAdmin, isGlobalAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import log from "@/lib/log";
import { MONTH_RE, commissionSummary, hkMonthNow } from "@/lib/sales/mine";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  const admin = await requireAdmin(req);
  if (!isGlobalAdmin(admin)) return NextResponse.json({ error: "FORBIDDEN", message: "只有集團管理員可以睇傭金" }, { status: 403 });
  const raw = req.nextUrl.searchParams.get("month");
  const month = raw && MONTH_RE.test(raw) ? raw : hkMonthNow();
  try {
    return NextResponse.json(await commissionSummary(month));
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.name : "unknown" }, "sales: commission summary failed");
    return NextResponse.json({ month, closed: false, rows: [], error: "workforce 連唔到 — 傭金暫時拎唔到" });
  }
});

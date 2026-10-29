/**
 * ★ cwi-sales 第 3 期：GET /api/sales/mine?month=YYYY-MM — 「我的銷售」（只可以睇自己；唔係銷售 → 403）。
 * → { month, counts{protected,bound}, ledger{totals, rows[]}, invoices[] }
 * workforce 連唔到 → 503（頁面顯示稍後再試）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import log from "@/lib/log";
import { SalesActionError } from "@/lib/sales/handover";
import { MONTH_RE, hkMonthNow, mySales } from "@/lib/sales/mine";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  const auth = await requireAuth(req);
  const raw = req.nextUrl.searchParams.get("month");
  const month = raw && MONTH_RE.test(raw) ? raw : hkMonthNow();
  try {
    return NextResponse.json(await mySales(auth.staff.id, month));
  } catch (err) {
    if (err instanceof SalesActionError) return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    log.warn({ err: err instanceof Error ? err.name : "unknown" }, "sales: mine failed");
    return NextResponse.json({ error: "WORKFORCE_UNAVAILABLE", message: "暫時拎唔到傭金資料 — 請稍後再試" }, { status: 503 });
  }
});

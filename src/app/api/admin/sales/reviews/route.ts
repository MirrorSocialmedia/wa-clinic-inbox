/**
 * ★ cwi-sales 第 2 期：GET /api/admin/sales/reviews?status=OPEN|APPROVED|REJECTED — 老闆對單隊列（集團管理員）。
 * → { reviews: ReviewView[] }；workforce 連唔到 → 200 + [] + error（頁面照開）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAdmin, isGlobalAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import log from "@/lib/log";
import { listSalesReviews } from "@/lib/sales/reviews";

export const dynamic = "force-dynamic";

const STATUSES = new Set(["OPEN", "APPROVED", "REJECTED"]);

export const GET = handle(async (req: NextRequest) => {
  const admin = await requireAdmin(req);
  if (!isGlobalAdmin(admin)) return NextResponse.json({ error: "FORBIDDEN", message: "只有集團管理員可以睇對單" }, { status: 403 });
  const raw = req.nextUrl.searchParams.get("status");
  const status = raw && STATUSES.has(raw) ? raw : null;
  try {
    return NextResponse.json({ reviews: await listSalesReviews(status) });
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.name : "unknown" }, "sales: list reviews failed");
    return NextResponse.json({ reviews: [], error: "workforce 連唔到 — 對單暫時拎唔到" });
  }
});

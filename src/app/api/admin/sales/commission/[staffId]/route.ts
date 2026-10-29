/**
 * ★ cwi-sales 第 3 期：GET /api/admin/sales/commission/[staffId]?month=YYYY-MM — 老闆睇某個銷售當月明細（集團管理員）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAdmin, isGlobalAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import log from "@/lib/log";
import { MONTH_RE, hkMonthNow, ledgerView } from "@/lib/sales/mine";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ staffId: string }> };

export const GET = handle(async (req: NextRequest, ctxP: Ctx) => {
  const admin = await requireAdmin(req);
  if (!isGlobalAdmin(admin)) return NextResponse.json({ error: "FORBIDDEN", message: "只有集團管理員可以睇傭金" }, { status: 403 });
  const { staffId } = await ctxP.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(staffId)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const raw = req.nextUrl.searchParams.get("month");
  const month = raw && MONTH_RE.test(raw) ? raw : hkMonthNow();
  try {
    return NextResponse.json(await ledgerView(staffId, month));
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.name : "unknown" }, "sales: commission detail failed");
    return NextResponse.json({ error: "WORKFORCE_UNAVAILABLE", message: "暫時拎唔到傭金資料" }, { status: 503 });
  }
});

/**
 * ★ cwi-sales-20261028：POST /api/admin/sales/catalog/refresh —「立即更新名單」（收費項目／醫生／Apricot 用戶；集團管理員）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAdmin, isGlobalAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { refreshSalesCatalog, WorkforceApiError } from "@/lib/workforce/client";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest) => {
  const admin = await requireAdmin(req);
  if (!isGlobalAdmin(admin)) return NextResponse.json({ error: "FORBIDDEN", message: "只有集團管理員可以更新名單" }, { status: 403 });
  try {
    return NextResponse.json({ result: await refreshSalesCatalog(admin.staff.id) });
  } catch (err) {
    if (err instanceof WorkforceApiError && err.status === 409) {
      return NextResponse.json({ error: "ALREADY_RUNNING", message: "名單更新緊，等一陣再撳" }, { status: 409 });
    }
    return NextResponse.json({ error: "WORKFORCE_UNAVAILABLE", message: "workforce 連唔到 — 請稍後再試" }, { status: 502 });
  }
});

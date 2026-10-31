/**
 * ★ cwi-sales 第 4 期：/api/admin/sales/commission-sync — 月結前同步（集團管理員）。
 * GET → { running, last }；POST → workforce 背景開始（全部追蹤緊嘅單慢慢查一次）
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAdmin, isGlobalAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { SalesActionError } from "@/lib/sales/handover";
import { startSync } from "@/lib/sales/close";
import { fetchCommissionSyncState } from "@/lib/workforce/client";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  const admin = await requireAdmin(req);
  if (!isGlobalAdmin(admin)) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  try {
    return NextResponse.json(await fetchCommissionSyncState());
  } catch {
    return NextResponse.json({ running: null, last: null, error: "workforce 連唔到" });
  }
});

export const POST = handle(async (req: NextRequest) => {
  const admin = await requireAdmin(req);
  if (!isGlobalAdmin(admin)) return NextResponse.json({ error: "FORBIDDEN", message: "只有集團管理員可以同步" }, { status: 403 });
  try {
    await startSync(admin.staff.id);
    return NextResponse.json({ started: true }, { status: 202 });
  } catch (e) {
    if (e instanceof SalesActionError) return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    throw e;
  }
});

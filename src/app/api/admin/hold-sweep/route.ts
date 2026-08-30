/**
 * POST /api/admin/hold-sweep — 手動觸發 Flow hold sweep（ADMIN-only；providerslot-20260830 T3）。
 *
 * 同一條 cron `hold-sweep`（每 5 分鐘）用嘅 sweepFlowHolds()：
 * 本地 HELD × workforce held API 對返（IN_APRICOT/EXPIRED 推進）+ held_timeout alert upsert。
 * 冪等 — 重複觸發安全（cron 每 5 分鐘已經喺行）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { sweepFlowHolds } from "@/lib/flows/hold-sweep";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest) => {
  await requireAdmin(req);
  const r = await sweepFlowHolds();
  return NextResponse.json(r);
});

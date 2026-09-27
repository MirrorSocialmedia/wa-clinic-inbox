/**
 * /api/admin/metrics — ★ cwi-final S6-4：ops 健康指標（global admin only）。
 *
 * GET → queue depth／oldest age（+p95）／outbound UNKNOWN 數／AI 成功率／DLQ 數／
 *      listTruncated 回報數／pendingStatusDropped 數。
 * - 全部 metadata only（計數/時間）— 零 PII。
 * - 用途：hub 健康卡顯示 + 人工排障（S1-2/S6-6 觸發觀察指標）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireGlobalAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { collectMetrics } from "@/lib/ops/metrics";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  await requireGlobalAdmin(req);
  return NextResponse.json(await collectMetrics());
});

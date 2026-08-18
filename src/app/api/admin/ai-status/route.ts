import { type NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { getAiStatusSnapshot } from "@/lib/ai/status";

/**
 * GET /api/admin/ai-status — AI triage 狀態（ADMIN-only，fail-closed）。
 *
 * 回傳：mode（mock/real）+ primary/fallback model + breaker + probe（healthz 同源）
 *       + call 統計（totalCalls/okCalls/successRate/lastOkAt/lastError）。
 * 全部 metadata — 零 prompt/response/訊息內容。
 */
export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  await requireAdmin(req); // STAFF / 未登入 → 401/403
  const snapshot = await getAiStatusSnapshot();
  return NextResponse.json(snapshot);
});

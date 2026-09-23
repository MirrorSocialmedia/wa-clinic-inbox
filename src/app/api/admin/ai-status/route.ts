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
  const auth = await requireAdmin(req); // STAFF / 未登入 → 401/403
  const snapshot = await getAiStatusSnapshot();
  // ★ cwi-final S3-1：scoped ADMIN 只見到自己 scope 內嘅店行（讀：clinicId in scope；
  //   model/breaker/stats 係全局 metadata 冇店維度 — 維持照回）
  if (auth.staff.role === "ADMIN" && auth.scopeType !== "ALL") {
    const set = new Set(auth.scopedClinicIds);
    snapshot.clinics = snapshot.clinics.filter((c) => set.has(c.id));
  }
  return NextResponse.json(snapshot);
});

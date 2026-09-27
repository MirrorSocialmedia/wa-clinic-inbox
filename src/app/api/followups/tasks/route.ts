import { type NextRequest, NextResponse } from "next/server";
import { requireAuth, scopedClinicSet } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { buildFollowupTaskViews } from "@/lib/followup/tasks-view";

/**
 * ★ cwi-followup-v3-20260916：follow-up 建議列表（staff+，clinic scope）。
 *
 * GET /api/followups/tasks?status=SUGGESTED&limit=100[&conversationId=X]
 *   → { tasks: [{ id, clinicId, ruleName, trigger, dueAt, status, templateName,
 *                 templateApproved, templateMetaApproved, templateWaCategory,
 *                 templateLanguage, templatePreview,
 *                 patientName, salutation, optOut, contextJson, templateVars, cancelReason, createdAt, conversationId }] }
 *   預設 = SUGGESTED 按 dueAt asc（最急先）；patientName = 顯示用（對話既有資料）。
 *   零臨床全文：contextJson/templateVars 只係顯示用結構化數據。
 *
 * ★ cwi-final S2-5：templateMetaApproved + templateWaCategory = **Meta 側**審批狀態（單一來源
 *   approvedTemplateList — 全部 APPROVED，category 由 caller 決定）：本地 approved 但 Meta 未批 →
 *   templateMetaApproved=false → UI 建議卡「等 template 審批」（發送時 engine 雙 gate 一樣擋）；
 *   MARKETING category → UI 提示「行銷類 template（收費較高）」。fail-soft：Meta 掛 = false（保守唔放發）。
 *
 * ★ cwi-final S6-7：view 構造抽 src/lib/followup/tasks-view.ts（同 conversations/[id]/bundle 共用單一來源）。
 */
export const dynamic = "force-dynamic";

const STATUSES = new Set<string>(["SUGGESTED", "SENT", "SKIPPED", "CANCELLED", "COMPLETED", "EXPIRED"]);

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status") ?? undefined;
  if (status && !STATUSES.has(status)) return NextResponse.json({ error: "bad status" }, { status: 400 });
  const limit = Math.min(Number(sp.get("limit") ?? 100) || 100, 200);
  const conversationId = sp.get("conversationId") ?? undefined;
  const tasks = await buildFollowupTaskViews({
    status,
    conversationId,
    clinicSet: scopedClinicSet(ctx),
    limit,
  });
  return NextResponse.json({ tasks });
});

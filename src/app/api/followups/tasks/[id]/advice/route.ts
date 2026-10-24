import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, scopedClinicSet, assertConversationAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { fetchDoctorAdvice, WorkforceApiError } from "@/lib/workforce/client";
import { DEFAULT_ADVICE_KEYWORDS } from "@/lib/followup/advice";

/**
 * ★ cwi-advice-20261024：GET /api/followups/tasks/:id/advice — 醫生建議跟進卡「原文」（即時問 CWM）。
 *
 * 🔴 wa-inbox 唔存臨床全文：task.contextJson 只有欄名 + 觸發字；原文句每次由 CWM
 *   /clinical-index/advice 攞（CWM 落 EXTERNAL_ADVICE_VIEWED — staffId = 睇卡嘅員工）。本路由 no-store、唔 log 內容。
 *
 * 權限：requireAuth + clinic scope + conversation access（SUPERVISOR 可睇 — 唯讀）。
 * 回：{ matches: [{ field, keyword, snippet }] }；CWM 唔通 → 503 { error: "WORKFORCE_UNAVAILABLE" }（卡照顯示欄名）。
 */
export const dynamic = "force-dynamic";

export const GET = handle(async (req, { params }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;
  const task = await prisma.followupTask.findUnique({ where: { id } });
  if (!task || !task.subjectKey?.startsWith("advice:") || !task.patientApricotId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const clinicSet = scopedClinicSet(ctx);
  if (clinicSet && !clinicSet.includes(task.clinicId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (task.conversationId) {
    const conv = await prisma.conversation.findUnique({
      where: { id: task.conversationId },
      select: { clinicId: true, assigneeId: true, routedStaffId: true, routedGroupId: true, handlingClinicId: true },
    });
    if (!conv) return NextResponse.json({ error: "conversation missing" }, { status: 404 });
    await assertConversationAccess(ctx, conv);
  }
  const c = (task.contextJson ?? {}) as { visitDate?: string; keywords?: string[]; visitId?: string };
  if (!c.visitDate) return NextResponse.json({ matches: [] });
  const rule = task.ruleId
    ? await prisma.followupRule.findUnique({ where: { id: task.ruleId }, select: { keywords: true, excludeKeywords: true } })
    : null;
  // 用規則而家嘅字（同建卡時一致；冇規則 → 建卡時命中嘅字）
  const keywords = rule?.keywords.length ? rule.keywords : c.keywords?.length ? c.keywords : DEFAULT_ADVICE_KEYWORDS;
  try {
    const res = await fetchDoctorAdvice({
      patientApricotId: task.patientApricotId,
      from: c.visitDate,
      to: c.visitDate,
      keywords,
      excludes: rule?.excludeKeywords ?? [],
      staffId: ctx.staff.id,
    });
    const visit = res.visits.find((v) => v.visitId === c.visitId) ?? res.visits[0];
    return NextResponse.json({ matches: visit?.matches ?? [] }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof WorkforceApiError) {
      log.warn({ taskId: id, status: e.status }, "followup: 醫生建議原文攞唔到（CWM）");
      return NextResponse.json({ error: "WORKFORCE_UNAVAILABLE" }, { status: 503 });
    }
    throw e;
  }
});

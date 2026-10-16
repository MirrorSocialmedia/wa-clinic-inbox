import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, assertConversationAccess, assertCanWriteConversation } from "@/lib/rbac";
import { handle } from "@/lib/api-error";

/**
 * ★ wa-meta-compliance-20261016（C.1）：病人明確要求真人 → AI 自動收聲
 *
 * 背景：inbound 命中人工要求詞表（人工/真人/職員/human agent/...）→
 *   Conversation.patientRequestedHuman=true → auto-send gate 全面擋 + 唔開新 session +
 *   pipeline block「patient-requested-human」。呢個 flag 只可 staff 明確「交返 AI」先清。
 *
 * PATCH /api/conversations/:id/patient-requested-human  body { clear: true }
 *   → 清 flag + audit HUMAN_REQUEST_CLEARED（staffId 落痕）
 *   權限：同對話寫入口徑（assertConversationAccess + assertCanWriteConversation — SUPERVISOR 403）。
 *   冪等：flag 已清 → changed=false。
 *
 * 備註：consult-sessions resume/reset 亦會一併清 flag（session 存在時嘅另一入口）—
 *   呢個 endpoint 係「無 session」情境（病人第一句直接要求真人）嘅入口。
 */
export const dynamic = "force-dynamic";

export const PATCH = handle(async (req: NextRequest, { params }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;
  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  await assertConversationAccess(ctx, conv);
  assertCanWriteConversation(ctx); // SUPERVISOR 全店唯讀 → 403

  const body = await req.json().catch(() => null);
  if (!body || (body as { clear?: unknown }).clear !== true) {
    return NextResponse.json({ error: "validation failed", message: "body { clear: true } required" }, { status: 400 });
  }
  if (!conv.patientRequestedHuman) {
    return NextResponse.json({ ok: true, changed: false });
  }
  await prisma.$transaction([
    prisma.conversation.update({
      where: { id },
      data: { patientRequestedHuman: false, patientRequestedHumanAt: null },
    }),
    prisma.auditLog.create({
      data: {
        staffId: ctx.staff.id,
        action: "HUMAN_REQUEST_CLEARED",
        entity: "Conversation",
        entityId: id,
        meta: { clinicId: conv.clinicId } as object,
      },
    }),
  ]);
  // commit-then-emit（R2 鐵律）
  const { publishConvEvent, convRef } = await import("@/lib/notify");
  await publishConvEvent(
    convRef({ id: conv.id, clinicId: conv.clinicId, assigneeId: conv.assigneeId, routedStaffId: conv.routedStaffId, routedGroupId: conv.routedGroupId }),
    "conv:patient-requested-human-cleared",
    { conversationId: id, clinicId: conv.clinicId }
  ).catch(() => undefined);
  return NextResponse.json({ ok: true, changed: true });
});

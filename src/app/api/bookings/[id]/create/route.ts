/**
 * POST /api/bookings/[id]/create — 代落單（booking-ui D：卡上〔幫我喺 Apricot 落單〕）
 *
 * ★ cwi-final S5-1（F1）：async 化 — workforce 寫入搬去 booking-write worker（concurrency 1）：
 * - 前置（404/403/423 Send Lock/400 no_pinned/409 非 PENDING）照舊同步；
 * - 成功 = 202 { ok: true, state: "WRITING" }（claim + enqueue 成功）— CONFIRMED/UNKNOWN/FAILED
 *   由 worker 落 writeState + booking:updated（UI 即時刷新）；
 * - 失敗：409 write_in_progress（WRITING 中）/ 400 前置（visit reason 等）/ 503 QUEUE_UNAVAILABLE。
 *
 * 權限：assertClinicAccess + Send Lock（MD §7：代落單 = 向 Apricot 寫入 → 非負責人 423，
 * 同 rollback/cancel/reschedule 一致）。
 * 24h 窗口邏輯：窗口只影響「自動確認訊息」（worker 側）— 過窗 = SYSTEM notice 提示 staff 覆。
 *
 * ★ Phase C（cwi-sess-20260824-c1）C5：前置校驗 + 條件 claim + enqueue 抽入 confirm-core
 *   （同 L4 AI 自動落單共用）；呢個 route 只餘 auth / RBAC / 423 Send Lock / HTTP 映射。
 */
import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertClinicAccess, assertCanWriteConversation } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { confirmBookingCore } from "@/lib/booking/confirm-core";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;

  const booking = await prisma.bookingRequest.findUnique({ where: { id } });
  if (!booking) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertClinicAccess(ctx, booking.clinicId); // STAFF 別店 → 403
  assertCanWriteConversation(ctx); // ★ cwi-routing-20260906 §8：SUPERVISOR 覆客 403

  if (booking.status !== "PENDING") {
    return NextResponse.json({ error: `booking already ${booking.status}` }, { status: 409 });
  }

  const conv = await prisma.conversation.findUnique({ where: { id: booking.conversationId } });
  const clinic = await prisma.clinic.findUnique({ where: { id: booking.clinicId } });
  if (!conv || !clinic) {
    return NextResponse.json({ error: "conversation missing" }, { status: 500 });
  }

  // Send Lock（MD §7：代落單 = 向 Apricot 寫入，非負責人唔准）
  if (conv.assigneeId && conv.assigneeId !== ctx.staff.id) {
    log.info(
      { clinicId: booking.clinicId, conversationId: booking.conversationId, staffId: ctx.staff.id, assigneeId: conv.assigneeId },
      "bookings: create — 423 SEND_LOCKED"
    );
    return NextResponse.json(
      { error: "SEND_LOCKED", message: "只有負責人可以代落單", assigneeId: conv.assigneeId },
      { status: 423 }
    );
  }

  // 鐵律 A：只對已釘住舊客（pinnedPatientApricotId）先可以代落單
  if (!conv.pinnedPatientApricotId) {
    return NextResponse.json(
      { error: "no_pinned_patient", message: "要喺側欄先釘住舊客先可以代落單" },
      { status: 400 }
    );
  }

  // body：{ visitReasonId?: string }（dictionaries item 嘅 apricotId）
  const body = (await req.json().catch(() => ({}))) as { visitReasonId?: string };

  // ★ Phase C + S5-1：共用 core（前置校驗 / visit reason 解析 / 條件 claim WRITING / enqueue booking-write）
  const result = await confirmBookingCore(
    id,
    { type: "STAFF", staffId: ctx.staff.id },
    { visitReasonId: typeof body.visitReasonId === "string" ? body.visitReasonId : undefined }
  );

  if (!result.ok) {
    if (result.kind === "QUEUE_UNAVAILABLE") {
      return NextResponse.json(
        { error: "QUEUE_UNAVAILABLE", message: result.message, hint: "booking 保持 PENDING — 請稍後重試" },
        { status: 503 }
      );
    }
    // PRECONDITION：write_in_progress（WRITING 中 → 409）/ 其他前置 → 400
    const status = result.code === "write_in_progress" ? 409 : 400;
    return NextResponse.json({ error: result.code, message: result.message }, { status });
  }

  // ── ★ S5-1：受理成功 — 寫入處理緊（結果經 booking:updated / 卡上 writeState 更新）──
  return NextResponse.json(
    { ok: true, state: "WRITING", bookingId: id, hint: "落單處理緊 — 結果會即時顯示喺預約卡" },
    { status: 202 }
  );
});

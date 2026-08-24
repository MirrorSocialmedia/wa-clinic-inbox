/**
 * POST /api/bookings/[id]/create — 代落單（booking-ui D：卡上〔幫我喺 Apricot 落單〕）
 *
 * 狀態機：只 PENDING（其餘 409）。必要條件：
 * - 對話已釘住舊客（pinnedPatientApricotId — 藍掣只喺已釘住時出現；API 層再擋一道）
 * - visitReasonId（body 揀咗嘅 dictionaries apricotId；冇 body → env default code 解析）
 *
 * 成功（workforce 200）：
 * - BookingRequest → CONFIRMED + apricotApptId + visitReasonCode + handledBy/At
 * - AuditLog BOOKING_CREATE（meta 零 PII：只 id/date/code）
 * - 即時刷新三步（booking-ops：L2 invalidate → booking:updated + booking:changed CREATED）
 * - 自動確認訊息（同 confirm route 語義：窗口內 free-form；過窗 → 422 hint 用 template，
 *   booking 照樣 CONFIRMED — 人已喺 Apricot 落咗單）
 *
 * workforce 錯誤分支（MD §3 + 鐵律 6）：
 * - 409 SLOT_TAKEN → 409（卡紅字「時段啱啱滿咗」+ 〔重發 Flow〕）
 * - 422 NEW_PATIENT_DISABLED 等 → 422 人手指示 variant
 * - 503 WRITE_DISABLED / APRICOT_BUSY → 503 人手指示
 * - 502 APRICOT_ERROR / 其他 → 502 人手指示
 *
 * 權限：assertClinicAccess + Send Lock（MD §7：代落單 = 向 Apricot 寫入 → 非負責人 423，
 * 同 rollback/cancel/reschedule 一致）。
 * 24h 窗口邏輯：窗口只影響「自動確認訊息」，唔影響落單本身（同 confirm 一致）。
 *
 * ★ Phase C（cwi-sess-20260824-c1）C5：workforce 寫入 + CONFIRMED + 審計 + 刷新 +
 *   自動確認訊息 已抽入 confirm-core（同 L4 AI 自動落單共用）。
 *   呢個 route 只餘 auth / RBAC / 423 Send Lock / PENDING + pinned 前置 / HTTP 映射 —
 *   response shape 一 byte 不變（前端零改動）。
 */
import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertClinicAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { confirmMessageText } from "@/lib/booking/booking-text";
import { confirmBookingCore } from "@/lib/booking/confirm-core";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;

  const booking = await prisma.bookingRequest.findUnique({ where: { id } });
  if (!booking) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertClinicAccess(ctx, booking.clinicId); // STAFF 別店 → 403

  if (booking.status !== "PENDING") {
    return NextResponse.json({ error: `booking already ${booking.status}` }, { status: 409 });
  }

  const conv = await prisma.conversation.findUnique({ where: { id: booking.conversationId } });
  const clinic = await prisma.clinic.findUnique({ where: { id: booking.clinicId } });
  if (!conv || !clinic) {
    return NextResponse.json({ error: "conversation missing" }, { status: 500 });
  }

  // Send Lock（MD §7：代落單 = 向 Apricot 寫入，非負責人唔准）— ★ Phase C：423 留喺 route（唔搬入 core）
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

  // ★ Phase C：共用 core（visit reason 解析 / workforce 寫入 / CONFIRMED / 審計 / 刷新 / 自動確認訊息）
  const result = await confirmBookingCore(
    id,
    { type: "STAFF", staffId: ctx.staff.id },
    { visitReasonId: typeof body.visitReasonId === "string" ? body.visitReasonId : undefined }
  );

  if (!result.ok) {
    if (result.kind === "PRECONDITION") {
      return NextResponse.json({ error: result.code, message: result.message }, { status: 400 });
    }
    if (result.kind === "SLOT_TAKEN") {
      return NextResponse.json(
        { error: "SLOT_TAKEN", message: "時段啱啱滿咗", retryable: true },
        { status: 409 }
      );
    }
    if (result.kind === "MANUAL_REQUIRED") {
      return NextResponse.json(
        { error: result.code ?? "NEW_PATIENT_DISABLED", manual: true, message: result.message },
        { status: 422 }
      );
    }
    if (result.kind === "WRITE_DISABLED") {
      return NextResponse.json(
        { error: result.code ?? "WRITE_DISABLED", manual: true, message: "Workforce 寫入暫時停用 — 請人手喺 Apricot 落單" },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: "WORKFORCE_UNAVAILABLE", manual: true, message: "Workforce 落單失敗 — 請人手喺 Apricot 落單" },
      { status: 502 }
    );
  }

  // ── 成功分支（response 同舊版 byte-for-byte）────────────────────────
  if (result.autoMessage.sent) {
    return NextResponse.json({
      ok: true,
      confirmed: true,
      apricotApptId: result.apricotApptId,
      autoMessage: { sent: true, messageId: result.autoMessage.messageId },
    });
  }
  if (result.autoMessage.reason === "window_closed") {
    return NextResponse.json(
      {
        ok: true,
        confirmed: true,
        apricotApptId: result.apricotApptId,
        autoMessage: {
          sent: false,
          reason: "window_closed",
          hint: "24 小時客服窗口已過 — 請用帶確認內容嘅 utility template 覆病人",
          suggestedText: confirmMessageText(booking),
        },
      },
      { status: 422 }
    );
  }
  return NextResponse.json(
    {
      ok: true,
      confirmed: true,
      apricotApptId: result.apricotApptId,
      autoMessage: { sent: false, reason: "queue_unavailable", hint: "請手動覆病人" },
    },
    { status: 503 }
  );
});

/**
 * POST /api/bookings/[id]/rollback — 撤銷代落單（booking-ui D：CONFIRMED 卡〔撤銷（mm:ss）〕）
 *
 * MD §3：5 分鐘內 → removeBooking() → 卡彈返 PENDING + AuditLog BOOKING_ROLLBACK
 * + **唔自動出訊息**（多數係撳錯，唔使嘈病人，由員工自行覆）。
 *
 * 條件：
 * - status = CONFIRMED + 有 apricotApptId（workforce 落咗單先有得撤）
 * - 5 分鐘窗口（handledAt + 5min — server 端強制；前端倒數到 0 掣消失）
 * - Send Lock（MD §7：撤銷/改期/取消三動作全部受 Send Lock → 非負責人 423）
 *
 * workforce 失敗（502/503）：booking 保持 CONFIRMED（Apricot 單仲喺度）→ 同人手指示。
 */
import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertClinicAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { publishNotify } from "@/lib/notify";
import { afterBookingWrite, rollbackWindowOpen } from "@/lib/booking/booking-ops";
import { WorkforceApiError, removeBooking } from "@/lib/workforce/client";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;

  const booking = await prisma.bookingRequest.findUnique({ where: { id } });
  if (!booking) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertClinicAccess(ctx, booking.clinicId); // STAFF 別店 → 403

  if (booking.status !== "CONFIRMED" || !booking.apricotApptId) {
    return NextResponse.json(
      { error: "rollback unavailable", message: "只可以撤銷已代落單（CONFIRMED + Apricot 單號）嘅預約" },
      { status: 409 }
    );
  }

  const conv = await prisma.conversation.findUnique({ where: { id: booking.conversationId } });
  const clinic = await prisma.clinic.findUnique({ where: { id: booking.clinicId } });
  if (!conv || !clinic) {
    return NextResponse.json({ error: "conversation missing" }, { status: 500 });
  }

  // Send Lock（MD §7）
  if (conv.assigneeId && conv.assigneeId !== ctx.staff.id) {
    log.info(
      { clinicId: booking.clinicId, conversationId: booking.conversationId, staffId: ctx.staff.id, assigneeId: conv.assigneeId },
      "bookings: rollback — 423 SEND_LOCKED"
    );
    return NextResponse.json(
      { error: "SEND_LOCKED", message: "只有負責人可以撤銷", assigneeId: conv.assigneeId },
      { status: 423 }
    );
  }

  // 5 分鐘窗口（server 強制）
  if (!rollbackWindowOpen(booking.handledAt, new Date())) {
    return NextResponse.json(
      { error: "rollback_window_expired", message: "超過 5 分鐘撤銷窗口 — 請用側欄〔改期〕/〔取消預約〕" },
      { status: 410 }
    );
  }

  // ★ removeBooking（workforce PUT /remove）
  let removed = false;
  try {
    await removeBooking(booking.apricotApptId, { clinicCode: clinic.code, date: booking.requestedDate });
    removed = true;
  } catch (err) {
    const status = err instanceof WorkforceApiError ? err.status : 502;
    log.warn(
      { bookingId: booking.id, clinicId: booking.clinicId, workforceStatus: status, staffId: ctx.staff.id },
      "bookings: rollback — workforce remove failed（保持 CONFIRMED）"
    );
    return NextResponse.json(
      {
        error: "WORKFORCE_REMOVE_FAILED",
        manual: true,
        message: "撤銷失敗（Apricot 單仲喺度）— 請人手喺 Apricot 取消",
        apricotApptId: booking.apricotApptId,
      },
      { status: status >= 500 ? 502 : status }
    );
  }
  if (!removed) {
    return NextResponse.json({ error: "remove failed" }, { status: 502 });
  }

  // ── 成功：彈返 PENDING + 審計 + 即時刷新（唔發自動訊息 — MD §3）──────
  await prisma.bookingRequest.update({
    where: { id: booking.id },
    data: {
      status: "PENDING",
      apricotApptId: null,
      visitReasonCode: null,
      handledByStaffId: null,
      handledAt: null,
    },
  });
  await prisma.auditLog
    .create({
      data: {
        staffId: ctx.staff.id,
        action: "BOOKING_ROLLBACK",
        entity: "BookingRequest",
        entityId: booking.id,
        meta: {
          conversationId: booking.conversationId,
          clinicId: booking.clinicId,
          apricotApptId: booking.apricotApptId,
          date: booking.requestedDate,
        },
      },
    })
    .catch(() => undefined);

  await afterBookingWrite(booking.clinicId, [booking.requestedDate], booking.conversationId, "ROLLED_BACK", booking.requestedDate);

  publishNotify(booking.clinicId, "booking:updated", {
    conversationId: booking.conversationId,
    clinicId: booking.clinicId,
    booking: {
      id: booking.id,
      providerName: booking.providerName,
      requestedDate: booking.requestedDate,
      requestedTime: booking.requestedTime,
      timeOfDay: booking.timeOfDay,
      precheckPassed: booking.precheckPassed,
      status: "PENDING",
      createdAt: booking.createdAt,
      apricotApptId: null,
      visitReasonCode: null,
      handledByStaffName: null,
      handledAt: null,
    },
  });

  log.info(
    { bookingId: booking.id, clinicId: booking.clinicId, staffId: ctx.staff.id },
    "bookings: rollback — removed + card back to PENDING（no auto message by design）"
  );
  return NextResponse.json({ ok: true, rolledBack: true });
});

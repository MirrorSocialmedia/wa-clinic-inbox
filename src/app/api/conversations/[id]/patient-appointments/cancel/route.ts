/**
 * POST /api/conversations/[id]/patient-appointments/cancel — 側欄 Apricot 預約卡〔取消預約〕（booking-ui E）
 *
 * MD §4：二次確認（UI 層）→ updateBookingStatus(id, -7) → 卡轉刪除線
 * → 自動發「已為你取消 X 月 X 日嘅預約，有需要隨時搵我哋」。
 *
 * 條件：
 * - 對話已釘住舊客 + appointment 屬 pinned patient（workforce 回查驗證）
 * - upcoming（0/102）+ 本店
 * - Send Lock（MD §7 → 非負責人 423）
 *
 * 成功：AuditLog BOOKING_CANCEL + 即時刷新三步（L2 invalidate + booking:changed CANCELLED）。
 * workforce 失敗：唔改任何狀態 → 502/503 提示人手處理。
 */
import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertClinicAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { getWindowState } from "@/lib/wa/window";
import { hkDateOffset } from "@/lib/availability";
import { phoneHash } from "@/lib/phone-hash";
import { outboundQueue } from "@/lib/queue";
import { afterBookingWrite } from "@/lib/booking/booking-ops";
import { cancelMessageText } from "@/lib/booking/booking-text";
import { WorkforceApiError, fetchAppointments, updateBookingStatus } from "@/lib/workforce/client";

export const dynamic = "force-dynamic";

const ENQUEUE_TIMEOUT_MS = 1500;

export const POST = handle(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;

  const conv = await prisma.conversation.findUnique({ where: { id } });
  const contact = conv ? await prisma.contact.findUnique({ where: { id: conv.contactId } }) : null;
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertClinicAccess(ctx, conv.clinicId); // STAFF 別店 → 403

  if (!conv.pinnedPatientApricotId) {
    return NextResponse.json({ error: "no_pinned_patient", message: "要喺側欄先釘住舊客" }, { status: 400 });
  }
  if (!contact?.waId) {
    return NextResponse.json({ error: "contact_missing" }, { status: 400 });
  }

  // Send Lock（MD §7）
  if (conv.assigneeId && conv.assigneeId !== ctx.staff.id) {
    log.info(
      { clinicId: conv.clinicId, conversationId: conv.id, staffId: ctx.staff.id, assigneeId: conv.assigneeId },
      "patient-appointments: cancel — 423 SEND_LOCKED"
    );
    return NextResponse.json(
      { error: "SEND_LOCKED", message: "只有負責人才可以取消預約", assigneeId: conv.assigneeId },
      { status: 423 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as { apricotApptId?: string };
  const apricotApptId = typeof body.apricotApptId === "string" ? body.apricotApptId.trim() : "";
  if (!apricotApptId) return NextResponse.json({ error: "apricotApptId required" }, { status: 400 });

  const clinic = await prisma.clinic.findUnique({ where: { id: conv.clinicId } });
  if (!clinic) return NextResponse.json({ error: "clinic missing" }, { status: 500 });

  // 驗證 appointment（upcoming 0/102 + pinned patient + 本店）
  let appt: { apricotApptId: string; clinicCode: string; patientApricotId: string; date: string; start: string; bookingStatus: number };
  try {
    const data = await fetchAppointments(phoneHash(contact.waId), hkDateOffset(-7), hkDateOffset(30));
    const found = data.appointments.find((a) => a.apricotApptId === apricotApptId);
    if (!found) {
      return NextResponse.json(
        { error: "appointment_not_found", message: "預約唔喺 upcoming 範圍（可能已改/已取消）" },
        { status: 400 }
      );
    }
    if (found.patientApricotId !== conv.pinnedPatientApricotId) {
      return NextResponse.json({ error: "patient_mismatch" }, { status: 400 });
    }
    if (found.clinicCode !== clinic.code) {
      return NextResponse.json({ error: "wrong_clinic", message: "預約唔係本店 — 唔可以經呢度取消" }, { status: 400 });
    }
    if (found.bookingStatus !== 0 && found.bookingStatus !== 102) {
      return NextResponse.json(
        { error: "appointment_not_upcoming", message: "預約唔係 upcoming（0/102）狀態" },
        { status: 400 }
      );
    }
    appt = found;
  } catch (err) {
    const status = err instanceof WorkforceApiError ? err.status : 502;
    log.warn({ clinicId: conv.clinicId, workforceStatus: status }, "patient-appointments: cancel — workforce lookup failed");
    return NextResponse.json({ error: "workforce_unavailable", message: "查詢 Apricot 失敗 — 請稍後重試" }, { status: status >= 500 ? 502 : status });
  }

  // ★ updateBookingStatus(-7)（已取消）
  try {
    await updateBookingStatus(apricotApptId, -7, { clinicCode: clinic.code, date: appt.date });
  } catch (err) {
    const status = err instanceof WorkforceApiError ? err.status : 502;
    log.warn(
      { conversationId: conv.id, clinicId: conv.clinicId, workforceStatus: status, staffId: ctx.staff.id },
      "patient-appointments: cancel — workforce status update failed"
    );
    return NextResponse.json(
      { error: "WORKFORCE_CANCEL_FAILED", manual: true, message: "取消失敗 — 請人手喺 Apricot 取消" },
      { status: status >= 500 ? 502 : status }
    );
  }

  // 審計（零 PII：只 id/date）
  await prisma.auditLog
    .create({
      data: {
        staffId: ctx.staff.id,
        action: "BOOKING_CANCEL",
        entity: "Conversation",
        entityId: conv.id,
        meta: { conversationId: conv.id, clinicId: conv.clinicId, apricotApptId, date: appt.date },
      },
    })
    .catch(() => undefined);

  // 即時刷新三步（L2 invalidate + booking:changed CANCELLED）
  await afterBookingWrite(conv.clinicId, [appt.date], conv.id, "CANCELLED", appt.date);

  // 自動取消訊息（窗口內；過窗 = 只改狀態，staff 手覆）
  const win = getWindowState(conv.lastInboundAt);
  if (!win.open) {
    return NextResponse.json(
      { ok: true, cancelled: true, autoMessage: { sent: false, reason: "window_closed", hint: "窗口已過 — 請手覆病人", suggestedText: cancelMessageText(appt.date) } }
    );
  }
  try {
    const now = new Date();
    const msg = await prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: "OUT",
        channel: "API",
        type: "text",
        body: cancelMessageText(appt.date),
        status: "QUEUED",
        sentByStaffId: null,
        aiAutoSent: true,
        waTimestamp: now,
      },
    });
    await Promise.race([
      outboundQueue.add("send", { messageId: msg.id }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("enqueue timeout")), ENQUEUE_TIMEOUT_MS)),
    ]);
    await prisma.$executeRaw`
      UPDATE "Conversation" SET "lastMessageAt" = GREATEST("lastMessageAt", ${now}) WHERE "id" = ${conv.id}`;
    log.info({ conversationId: conv.id, messageId: msg.id, apricotApptId }, "patient-appointments: cancel — auto message queued");
    return NextResponse.json({ ok: true, cancelled: true, autoMessage: { sent: true, messageId: msg.id } });
  } catch (err) {
    log.error(
      { conversationId: conv.id, err: err instanceof Error ? err.message : String(err) },
      "patient-appointments: cancel — auto message enqueue failed（狀態已取消，staff 手覆）"
    );
    return NextResponse.json(
      { ok: true, cancelled: true, autoMessage: { sent: false, reason: "queue_unavailable", hint: "請手覆病人" } },
      { status: 503 }
    );
  }
});

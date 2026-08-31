/**
 * POST /api/conversations/[id]/patient-appointments/reschedule — 側欄 Apricot 預約卡〔改期〕（booking-ui E）
 *
 * MD §4：發 Flow 收新時間 → 病人交齊 → flow-reply 內 rescheduleBooking()（workforce 原子 102+新單）。
 * 呢個 route 只負責「開始改期」：
 * 1. 對話已釘住舊客（appointment 必須係 pinned patient 嘅 — workforce appointments 回查驗證）
 * 2. Send Lock（MD §7：改期/取消/撤銷三動作全部受 Send Lock → 非負責人 423）
 * 3. 24h 窗口（Flow 係 free-form — 過窗 422）
 * 4. Conversation.reschedulingApptId = 舊單號（flow-reply 見到旗標 → 改期路徑而唔係新卡）
 * 5. sendBookingFlow（冪等重用 SENT session）
 *
 * PII 鐵律：raw phone 只喺 server 端算 phoneHash；log 只 metadata。
 */
import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertConversationAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { getWindowState } from "@/lib/wa/window";
import { hkDateOffset } from "@/lib/availability";
import { phoneHash } from "@/lib/phone-hash";
import { sendBookingFlow, WindowClosedError } from "@/lib/flows/send";
import { WorkforceApiError, fetchAppointments } from "@/lib/workforce/client";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;

  const conv = await prisma.conversation.findUnique({ where: { id } });
  const contact = conv ? await prisma.contact.findUnique({ where: { id: conv.contactId } }) : null;
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertConversationAccess(ctx, conv); // STAFF 別店 → 403

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
      "patient-appointments: reschedule — 423 SEND_LOCKED"
    );
    return NextResponse.json(
      { error: "SEND_LOCKED", message: "只有負責人才可以改期", assigneeId: conv.assigneeId },
      { status: 423 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as { apricotApptId?: string };
  const apricotApptId = typeof body.apricotApptId === "string" ? body.apricotApptId.trim() : "";
  if (!apricotApptId) return NextResponse.json({ error: "apricotApptId required" }, { status: 400 });

  // 24h 窗口（Flow free-form — 過窗要 template）
  const win = getWindowState(conv.lastInboundAt);
  if (!win.open) {
    return NextResponse.json(
      { error: "window_closed", message: "24 小時客服窗口已過 — 改期 Flow 需要用帶 Flow 嘅 utility template" },
      { status: 422 }
    );
  }

  // 驗證 appointment 屬於 pinned patient（workforce 回查 — 側欄卡只係 UI，API 唔信）
  const clinic = await prisma.clinic.findUnique({ where: { id: conv.clinicId } });
  if (!clinic) return NextResponse.json({ error: "clinic missing" }, { status: 500 });
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
      return NextResponse.json({ error: "wrong_clinic", message: "預約唔係本店 — 唔可以經呢度改期" }, { status: 400 });
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
    log.warn({ clinicId: conv.clinicId, workforceStatus: status }, "patient-appointments: reschedule — workforce lookup failed");
    return NextResponse.json({ error: "workforce_unavailable", message: "查詢 Apricot 失敗 — 請稍後重試" }, { status: status >= 500 ? 502 : status });
  }

  // 設改期旗標（flow-reply 路由到 reschedule 路徑）+ 發 Flow
  await prisma.conversation.update({ where: { id: conv.id }, data: { reschedulingApptId: apricotApptId } });
  try {
    const r = await sendBookingFlow({ conversationId: conv.id, staffId: ctx.staff.id });
    log.info(
      { conversationId: conv.id, clinicId: conv.clinicId, apricotApptId, apptDate: appt.date, staffId: ctx.staff.id, reused: r.reused },
      "patient-appointments: reschedule flow started"
    );
    return NextResponse.json({ ok: true, flowToken: r.flowToken, messageId: r.messageId, reused: r.reused, apricotApptId });
  } catch (err) {
    // Flow 發唔出 → 清旗標（唔留死狀態）
    await prisma.conversation.update({ where: { id: conv.id }, data: { reschedulingApptId: null } });
    if (err instanceof WindowClosedError) {
      return NextResponse.json({ error: "window_closed" }, { status: 422 });
    }
    log.error(
      { conversationId: conv.id, err: err instanceof Error ? err.message : String(err) },
      "patient-appointments: reschedule flow failed"
    );
    return NextResponse.json({ error: "flow_send_failed" }, { status: 502 });
  }
});

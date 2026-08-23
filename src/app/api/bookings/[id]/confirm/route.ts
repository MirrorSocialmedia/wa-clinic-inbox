/**
 * POST /api/bookings/[id]/confirm — 員工撳〔已喺醫生系統落單〕（MD §8.3）
 *
 * 1. RBAC：assertClinicAccess（STAFF 撳別店 booking → 403 實測）
 * 2. 狀態機：只 PENDING 可以 confirm（其餘 → 409）
 * 3. BookingRequest → CONFIRMED + AuditLog(CONFIRM_BOOKING)
 * 4. 自動發確認訊息：
 *    - 24h 窗口內 → free-form「已為你預約 X 月 X 日 HH:mm 陳醫生，到時見 🙂」
 *    - 過窗 → 422 提示 staff 用 utility template（MD：過窗用 template；
 *      booking 照樣 CONFIRMED — 狀態要反映「人已喺醫生系統落咗單」）
 */
import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertClinicAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { getWindowState } from "@/lib/wa/window";
import { outboundQueue } from "@/lib/queue";
import { publishNotify } from "@/lib/notify";

export const dynamic = "force-dynamic";

/** 確認訊息文字（MD §8.3 格式：「已為你預約 X 月 X 日 HH:mm 陳醫生，到時見 🙂」）
 *  純收需求變體（requestedTime = null + timeOfDay）：「…上晝…，具體時段職員會再同你確認 🙂」 */
const TIME_OF_DAY_LABEL: Record<string, string> = { MORNING: "上晝", AFTERNOON: "下晝", EVENING: "夜晚" };
function confirmMessageText(b: { requestedDate: string; requestedTime: string | null; providerName: string; timeOfDay?: string | null }): string {
  const [, mo, d] = b.requestedDate.split("-");
  if (b.requestedTime) {
    return `已為你預約 ${Number(mo)}月${Number(d)}日 ${b.requestedTime} ${b.providerName}，到時見 🙂`;
  }
  const tod = TIME_OF_DAY_LABEL[b.timeOfDay ?? ""] ?? "";
  return `已為你預約 ${Number(mo)}月${Number(d)}日 ${tod} ${b.providerName}，具體時段職員會再同你確認 🙂`;
}

const ENQUEUE_TIMEOUT_MS = 1500;

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

  // 1) CONFIRMED + AuditLog（先落定狀態，自動訊息係附送）
  const now = new Date();
  await prisma.bookingRequest.update({
    where: { id: booking.id },
    data: { status: "CONFIRMED", handledByStaffId: ctx.staff.id, handledAt: now },
  });
  await prisma.auditLog
    .create({
      data: {
        staffId: ctx.staff.id,
        action: "CONFIRM_BOOKING",
        entity: "BookingRequest",
        entityId: booking.id,
        meta: { conversationId: booking.conversationId, clinicId: booking.clinicId },
      },
    })
    .catch(() => undefined);

  publishNotify(booking.clinicId, "booking:updated", {
    conversationId: booking.conversationId,
    clinicId: booking.clinicId,
    booking: {
      id: booking.id,
      providerName: booking.providerName,
      requestedDate: booking.requestedDate,
      requestedTime: booking.requestedTime,
      status: "CONFIRMED",
      createdAt: booking.createdAt,
    },
  });

  // 2) 自動確認訊息（窗口內 free-form）
  const win = getWindowState(conv.lastInboundAt);
  if (!win.open) {
    log.info(
      { bookingId: booking.id, clinicId: booking.clinicId, staffId: ctx.staff.id },
      "bookings: confirm — window closed, template required"
    );
    return NextResponse.json(
      {
        ok: true,
        confirmed: true,
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

  try {
    const msg = await prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: "OUT",
        channel: "API",
        type: "text",
        body: confirmMessageText(booking),
        status: "QUEUED",
        sentByStaffId: ctx.staff.id,
        waTimestamp: now,
      },
    });
    await Promise.race([
      outboundQueue.add("send", { messageId: msg.id }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("enqueue timeout")), ENQUEUE_TIMEOUT_MS)),
    ]);
    await prisma.$executeRaw`
      UPDATE "Conversation" SET "lastMessageAt" = GREATEST("lastMessageAt", ${now}) WHERE "id" = ${conv.id}`;
    log.info(
      { bookingId: booking.id, messageId: msg.id, clinicId: booking.clinicId, staffId: ctx.staff.id },
      "bookings: confirm — auto confirmation message queued"
    );
    return NextResponse.json({
      ok: true,
      confirmed: true,
      autoMessage: { sent: true, messageId: msg.id },
    });
  } catch (err) {
    // 狀態已 CONFIRMED；訊息 enqueue 失敗 → 503（staff 手動覆）
    log.error(
      { bookingId: booking.id, err: err instanceof Error ? err.message : String(err) },
      "bookings: confirm — auto message enqueue failed（狀態已 CONFIRMED，staff 手動覆）"
    );
    return NextResponse.json(
      {
        ok: true,
        confirmed: true,
        autoMessage: { sent: false, reason: "queue_unavailable", hint: "請手動覆病人" },
      },
      { status: 503 }
    );
  }
});

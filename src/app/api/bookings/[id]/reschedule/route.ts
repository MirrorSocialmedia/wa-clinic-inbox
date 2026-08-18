/**
 * POST /api/bookings/[id]/reschedule — 員工撳〔改期〕→ 重出 Flow（MD §8.3）
 *
 * - 只 PENDING（已 CONFIRMED/EXPIRED → 409）
 * - 24h 窗口：過窗 → 422（Flow 係 free-form，過窗要 template）
 * - 冪等：sendBookingFlow 內部重用 SENT session（已有流緊 flow → 唔重發）
 */
import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertClinicAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { getWindowState } from "@/lib/wa/window";
import { sendBookingFlow, WindowClosedError } from "@/lib/flows/send";

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
  if (!conv) return NextResponse.json({ error: "conversation missing" }, { status: 500 });

  const win = getWindowState(conv.lastInboundAt);
  if (!win.open) {
    return NextResponse.json(
      {
        error: "window_closed",
        message: "24 小時客服窗口已過 — 重出 Flow 需要用帶 Flow 嘅 utility template",
      },
      { status: 422 }
    );
  }

  try {
    const r = await sendBookingFlow({ conversationId: conv.id, staffId: ctx.staff.id });
    await prisma.auditLog
      .create({
        data: {
          staffId: ctx.staff.id,
          action: "BOOKING_RESEND_FLOW",
          entity: "BookingRequest",
          entityId: booking.id,
          meta: { conversationId: conv.id, messageId: r.messageId },
        },
      })
      .catch(() => undefined);
    log.info({ bookingId: booking.id, conversationId: conv.id, reused: r.reused }, "bookings: reschedule — flow re-sent");
    return NextResponse.json({ ok: true, flowToken: r.flowToken, messageId: r.messageId, reused: r.reused });
  } catch (err) {
    if (err instanceof WindowClosedError) {
      return NextResponse.json({ error: "window_closed" }, { status: 422 });
    }
    throw err;
  }
});

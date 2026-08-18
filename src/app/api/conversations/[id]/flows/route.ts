/**
 * POST /api/conversations/[id]/flows — staff 撳「📅 預約」掣 → 發 Booking Flow
 *
 * - RBAC：requireAuth + assertClinicAccess（STAFF 撳別店 → 403）
 * - 24h 窗口：過窗 → 422 window_closed（提示用帶 Flow 嘅 template — MD §8.2.4）
 * - 冪等：對話已有 SENT FlowSession → 重用（200 reused=true，唔重發訊息）
 *
 * Flow 內容（doctor/date/time）唔喺呢度 — 病人行 Flow 時先經
 * /api/flows/endpoint（data_exchange）逐步攞（precheck 原則）。
 */
import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertClinicAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { sendBookingFlow, WindowClosedError } from "@/lib/flows/send";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;

  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertClinicAccess(ctx, conv.clinicId); // STAFF 別店 → 403

  try {
    const r = await sendBookingFlow({ conversationId: conv.id, staffId: ctx.staff.id });
    return NextResponse.json({
      ok: true,
      flowToken: r.flowToken,
      messageId: r.messageId,
      reused: r.reused,
      status: "QUEUED",
    });
  } catch (err) {
    if (err instanceof WindowClosedError) {
      log.info({ conversationId: conv.id, staffId: ctx.staff.id }, "flows: window closed — template required");
      return NextResponse.json(
        {
          error: "window_closed",
          message: "24 小時客服窗口已過 — 發 Flow 需要用帶 Flow 嘅 utility template",
        },
        { status: 422 }
      );
    }
    throw err;
  }
});

/**
 * POST /api/conversations/[id]/flows — staff 撳「📅 預約」掣 → 發 Booking Flow
 *
 * - RBAC：requireAuth + assertConversationAccess（STAFF 撳別店 → 403）
 * - ★ H1 Send Lock（MD §3.2）：有負責人且唔係自己 → 423 SEND_LOCKED（同 free-form 同規則）
 * - 24h 窗口：過窗 → 422 window_closed（提示用帶 Flow 嘅 template — MD §8.2.4）
 * - 冪等：對話已有 SENT FlowSession → 重用（200 reused=true，唔重發訊息）
 *
 * S3-8：response 唔再洩 flowToken（security-sensitive — token 只經 WhatsApp Flow 通道送病人；
 * 內部/測試需要時由 DB FlowSession(flowToken) 讀）。
 *
 * Flow 內容（doctor/date/time）唔喺呢度 — 病人行 Flow 時先經
 * /api/flows/endpoint（data_exchange）逐步攞（precheck 原則）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertConversationAccess, assertCanWriteConversation } from "@/lib/rbac";
import { sendLockResponse } from "@/lib/send-lock";
import { handle } from "@/lib/api-error";
import { getWindowState } from "@/lib/wa/window";
import { assignConversation } from "@/lib/assign";
import { sendBookingFlow, WindowClosedError, FlowsDisabledError } from "@/lib/flows/send";

export const dynamic = "force-dynamic";

// D.3（cwi-schedv2-20260903）：撳格預選 — body.prefill 可選（舊 caller 唔帶 = 正常 Flow）。
const PrefillSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  providerId: z.string().min(1).max(200),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});

export const POST = handle(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;

  // D.3：prefill 可選 — 壞 shape → 400（唔影響其他檢查順序；body 唔合法 JSON = 舊 caller 空 body）
  let prefill: { date: string; providerId: string; start: string } | undefined;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown> | null;
  if (body && typeof body === "object" && body.prefill != null) {
    const parsed = PrefillSchema.safeParse(body.prefill);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid prefill", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    prefill = parsed.data;
  }

  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  await assertConversationAccess(ctx, conv); // STAFF 別店 → 403
  assertCanWriteConversation(ctx); // ★ cwi-routing-20260906 §8：SUPERVISOR 覆客 403

  // ★ H1 Send Lock（MD §3.2）：同 free-form 同規則 — 負責人唔係自己 → 423（INTERNAL note route 冇呢個檢查）。
  // ★ cwi-final S3-3（D-11）：ADMIN 豁免刪走 — 統一經 sendLockResponse（ADMIN 都要先撳〔接手〕；T97 口徑）
  const locked = sendLockResponse(ctx, conv);
  if (locked) {
    log.info(
      { clinicId: conv.clinicId, conversationId: conv.id, staffId: ctx.staff.id, assigneeId: conv.assigneeId },
      "flows: 423 SEND_LOCKED（assignee 係其他 staff）"
    );
    return locked;
  }

  // ★ H1：unassigned + 窗口開緊 → auto-claim（窗口過咗嘅 422 唔會 claim，同 send route 一致）
  if (!conv.assigneeId && getWindowState(conv.lastInboundAt).open) {
    await assignConversation({
      conversationId: conv.id,
      toStaffId: ctx.staff.id,
      by: "AUTO_CLAIM",
      byStaffId: ctx.staff.id,
    });
    conv.assigneeId = ctx.staff.id;
  }

  // ★ Phase C（cwi-sess-20260824-c1）：staff 手動出 Flow 撞 session → 標 CANCELLED
  //   （staff 主動用表格 = 人接管流程；session 唔會再收到病人訊息分流）
  const cancelledSession = await prisma.bookingSession.updateMany({
    where: { conversationId: conv.id, status: { in: ["ACTIVE", "CONFIRMING"] } },
    data: { status: "CANCELLED" },
  });
  if (cancelledSession.count > 0) {
    log.info({ conversationId: conv.id, count: cancelledSession.count }, "flows: staff 手動出 Flow → session CANCELLED（人接管）");
  }

  try {
    const r = await sendBookingFlow({ conversationId: conv.id, staffId: ctx.staff.id, prefill });
    // cwi-h6-20260830（h5 §1 寫入點 4）：發 Flow 成功 — 負責人自己 → 觸 assigneeLastActionAt
    if (conv.assigneeId === ctx.staff.id) {
      await prisma.$executeRaw`UPDATE "Conversation" SET "assigneeLastActionAt" = ${new Date()} WHERE "id" = ${conv.id}`;
    }
    return NextResponse.json({
      ok: true,
      // S3-8：flowToken 剷走（security-sensitive — 唔經 HTTP response 洩）
      messageId: r.messageId,
      reused: r.reused,
      status: "QUEUED",
    });
  } catch (err) {
    if (err instanceof FlowsDisabledError) {
      // ★ cwi-final S0-12：G2 閘未開 — 唔發 Flow（staff 撳時即知）
      log.info({ conversationId: conv.id, staffId: ctx.staff.id }, "flows: SLOT_CLAIM_DISABLED（G2 閘）");
      return NextResponse.json(
        { error: "SLOT_CLAIM_DISABLED", message: "網上預約（Flow）暫停中 — 請直接同病人約時間" },
        { status: 409 }
      );
    }
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

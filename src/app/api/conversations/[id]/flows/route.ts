/**
 * POST /api/conversations/[id]/flows — staff 撳「📅 預約」掣 → 發 Booking Flow
 *
 * - RBAC：requireAuth + assertConversationAccess（STAFF 撳別店 → 403）
 * - ★ H1 Send Lock（MD §3.2）：有負責人且唔係自己 → 423 SEND_LOCKED（同 free-form 同規則）
 * - 24h 窗口：過窗 → 422 window_closed（提示用帶 Flow 嘅 template — MD §8.2.4）
 * - 冪等：對話已有 SENT FlowSession → 重用（200 reused=true，唔重發訊息）
 *
 * Flow 內容（doctor/date/time）唔喺呢度 — 病人行 Flow 時先經
 * /api/flows/endpoint（data_exchange）逐步攞（precheck 原則）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertConversationAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { getWindowState } from "@/lib/wa/window";
import { assignConversation } from "@/lib/assign";
import { sendBookingFlow, WindowClosedError } from "@/lib/flows/send";

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
  assertConversationAccess(ctx, conv); // STAFF 別店 → 403

  // ★ H1 Send Lock（MD §3.2）：同 free-form 同規則 — 負責人唔係自己 → 423（INTERNAL note route 冇呢個檢查）。
  // cwi-h6-20260830：ADMIN 豁免（§8：ADMIN 可接手可覆可放手 — E2E T97）
  if (ctx.staff.role !== "ADMIN" && conv.assigneeId && conv.assigneeId !== ctx.staff.id) {
    log.info(
      { clinicId: conv.clinicId, conversationId: conv.id, staffId: ctx.staff.id, assigneeId: conv.assigneeId },
      "flows: 423 SEND_LOCKED（assignee 係其他 staff）"
    );
    return NextResponse.json(
      {
        error: "SEND_LOCKED",
        message: "此對話已有負責人 — 你只可發內部備註，或撳〔接手〕轉交畀自己",
        assigneeId: conv.assigneeId,
      },
      { status: 423 }
    );
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

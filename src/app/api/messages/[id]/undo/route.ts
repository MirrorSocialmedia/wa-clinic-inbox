import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertConversationAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { outboundQueue } from "@/lib/queue";
import { publishNotify } from "@/lib/notify";

/**
 * DELETE /api/messages/[id]/undo — 8 秒撤回（cwi-inboxfix-20260905，MD §5.2）。
 *
 * 語義（MD §5.2）：
 * - 只收「仲喺撤回窗口」嘅 OUT/API 訊息（status=QUEUED 且 waMessageId=null）。
 * - BullMQ delayed job（jobId = messageId）remove → 工人永遠唔會真發送（病人收唔到）。
 * - Message.status = CANCELLED（獨立 migration 加嘅 enum 值）+ audit MESSAGE_UNDO。
 * - 窗口過咗（job 已 active/completed，或 status 已過 QUEUED）→ 409 ALREADY_SENT
 *   「已經發出，撤回唔到」（UI 轉 §5.3：更正草稿 + 標記已作廢）。
 *
 * RBAC：assertConversationAccess（同其他 message route）+ 只准發送者本人 ∨ ADMIN。
 *
 * race 邊界：job 恰咗好轉 active（worker 正在 Graph 發送中）→ remove 失敗/狀態 active
 *   → 409（保守：寧願話撤唔到，唔會話撤咗但其實發出）。worker 側另有 CANCELLED guard
 *   雙保險（若 remove 抢贏咗 job 啟動前一刻 → worker 見 CANCELLED 直接 skip）。
 *
 * socket：message:status（waMessageId 欄帶 message id — client 按 m.id 對消；零內文）。
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;

  const msg = await prisma.message.findUnique({ where: { id } });
  if (!msg) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (msg.direction !== "OUT" || msg.channel !== "API") {
    return NextResponse.json({ error: "only outbound API messages can be undone" }, { status: 400 });
  }
  const conv = await prisma.conversation.findUnique({ where: { id: msg.conversationId } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertConversationAccess(auth, conv); // STAFF 別店 → 403

  // 只准發送者本人 ∨ ADMIN（AI AUTO 訊息 sentByStaffId=null → 只 ADMIN 可以撤）
  if (msg.sentByStaffId && msg.sentByStaffId !== auth.staff.id && auth.staff.role !== "ADMIN") {
    return NextResponse.json({ error: "only the sender or an admin can undo" }, { status: 403 });
  }

  // 窗口判定（DB 狀態為準）：已出街（waMessageId 已有）或已過 QUEUED → 撤唔到
  if (msg.waMessageId || msg.status !== "QUEUED") {
    return NextResponse.json(
      { error: "ALREADY_SENT", message: "已經發出，撤回唔到。可以再發一句更正。" },
      { status: 409 }
    );
  }

  // 移除 delayed job（jobId = messageId — enqueueOutboundSend 統一入）
  try {
    const job = await outboundQueue.getJob(msg.id);
    if (job) {
      const state = await job.getState();
      if (state === "active" || state === "completed") {
        // active = worker 正在發送（race 輸咗）；completed = 已發出
        return NextResponse.json(
          { error: "ALREADY_SENT", message: "已經發出，撤回唔到。可以再發一句更正。" },
          { status: 409 }
        );
      }
      // delayed / waiting / failed → remove（failed = 已重試失敗未發出 — 撤銷無害）
      await job.remove();
    }
    // job 唔存在（Redis 重啟被清 / 從未 enqueue 成功）→ 訊息永遠唔會發出 → 直接標 CANCELLED
  } catch (err) {
    log.warn(
      { messageId: id, err: err instanceof Error ? err.message : String(err) },
      "undo: job remove failed — treating as not safe to undo"
    );
    return NextResponse.json(
      { error: "ALREADY_SENT", message: "已經發出，撤回唔到。可以再發一句更正。" },
      { status: 409 }
    );
  }

  // DB：CANCELLED + audit（messageId + staffId — MD §5.2）
  await prisma.$transaction([
    prisma.message.update({ where: { id: msg.id }, data: { status: "CANCELLED" } }),
    prisma.auditLog.create({
      data: {
        staffId: auth.staff.id,
        action: "MESSAGE_UNDO",
        entity: "Message",
        entityId: msg.id,
        meta: { conversationId: conv.id, messageId: msg.id, staffId: auth.staff.id },
      },
    }),
  ]);

  // socket：client 氣泡即時轉「已撤回（未發出）」（waMessageId 欄帶 message id 供 client 對消）
  publishNotify(conv.clinicId, "message:status", {
    conversationId: conv.id,
    clinicId: conv.clinicId,
    waMessageId: msg.id,
    status: "CANCELLED",
  });

  log.info({ messageId: msg.id, conversationId: conv.id, staffId: auth.staff.id }, "undo: message cancelled (outbound job removed)");
  return NextResponse.json({ ok: true, status: "CANCELLED" });
});

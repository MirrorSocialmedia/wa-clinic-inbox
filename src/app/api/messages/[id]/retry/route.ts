import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, assertCanWriteConversation, assertConversationAccess } from "@/lib/rbac";
import { sendLockResponse } from "@/lib/send-lock";
import { getWindowState } from "@/lib/wa/window";
import { enqueueOutboundSend } from "@/lib/queue";
import { handle } from "@/lib/api-error";

/**
 * POST /api/messages/[id]/retry — FAILED 訊息人手重試（cwi-final S6-9 ①，P2-02）。
 *
 * 語義（spec 行 3748-3766 逐字）：
 * - requireAuth → assertCanWriteConversation（SUPERVISOR 403）
 * - 只 OUT + API 訊息（IN / APP_ECHO / HISTORY / INTERNAL → 404）
 * - assertConversationAccess（別店 STAFF → 403）
 * - S3-3 sendLock（有負責人而唔係自己 → 423）
 * - text 訊息 24h 窗口檢查（過窗 → 422 WINDOW_CLOSED）
 * - 條件更新 status=FAILED + waMessageId=null → QUEUED（原子佔位 — 並發 retry 只有一個 200，其餘 409 NOT_RETRYABLE）
 * - enqueueOutboundSend（worker 重新走 S1-15 狀態機）+ audit SEND_RETRY
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handle(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireAuth(req);
  assertCanWriteConversation(ctx);
  const { id } = await params;
  const msg = await prisma.message.findUnique({ where: { id } });
  if (!msg || msg.direction !== "OUT" || msg.channel !== "API") return NextResponse.json({ error: "not found" }, { status: 404 });
  const conv = await prisma.conversation.findUnique({ where: { id: msg.conversationId } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  await assertConversationAccess(ctx, conv);
  const locked = sendLockResponse(ctx, conv);
  if (locked) return locked; // S3-3
  if (msg.type === "text" && !getWindowState(conv.lastInboundAt).open) return NextResponse.json({ error: "WINDOW_CLOSED" }, { status: 422 });
  const r = await prisma.message.updateMany({ where: { id, status: "FAILED", waMessageId: null }, data: { status: "QUEUED", errorCode: null } });
  if (r.count !== 1) return NextResponse.json({ error: "NOT_RETRYABLE" }, { status: 409 });
  // ★ G4 gen5（2026-09-28 T693 事故修）：retry 必用 fresh 唯一 jobId。
  //   重用 jobId=messageId 會撞原 job 嘅保留 key（removeOnComplete count:20）→ BullMQ
  //   handleDuplicatedJob 靜默 no-op（唔入 wait list、唔 throw）→ 訊息永久卡 QUEUED。
  //   並發冪等由上面 DB 條件 updateMany 原子佔位保（只有一個 200）— jobId 唔需要再做 dedup。
  //   雙發由 worker 原子 claim（QUEUED→SENDING）保。同 booking-write 嘅 claim-nonce pattern。
  await enqueueOutboundSend(id, `${id}-r${Date.now().toString(36)}`);
  await prisma.auditLog.create({ data: { staffId: ctx.staff.id, action: "SEND_RETRY", entity: "Message", entityId: id } });
  return NextResponse.json({ ok: true });
});

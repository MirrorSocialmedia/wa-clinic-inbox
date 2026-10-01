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
 * 語義（spec 行 3748-3766 逐字 + cwi-qa FX-27/QA-27）：
 * - requireAuth → assertCanWriteConversation（SUPERVISOR 403）
 * - 只 OUT + API 訊息（IN / APP_ECHO / HISTORY / INTERNAL → 404）
 * - assertConversationAccess（別店 STAFF → 403）
 * - S3-3 sendLock（有負責人而唔係自己 → 423）
 * - ★ FX-27：訊息 age > 24h（createdAt < now-24h）→ 409 TOO_OLD（UI 叫員工重新打 —
 *   舊行嘅 template 變數/媒體引用已經過時，直接重打安全過重發）
 * - ★ FX-27：24h 窗口檢查媒體同 text 一樣（舊 code 只查 text — 媒體 FAILED 過窗照重試）
 * - 條件更新 status=FAILED + waMessageId=null → QUEUED（原子佔位 — 並發 retry 只有一個 200，其餘 409 NOT_RETRYABLE）
 * - ★ FX-27：retry 時清 waMediaId — worker 見 null 會重新上載媒體（waMediaId 係 Meta 30 日 token，
 *   唔保留舊值防 stale 引用）；mock/真 mode 同一條路徑（outbound.worker 媒體分支 null → re-upload）
 * - enqueueOutboundSend（worker 重新走 S1-15 狀態機）+ audit SEND_RETRY
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** ★ cwi-qa FX-27（QA-27）：FAILED 訊息 retry age 硬頂（24h）— 過期 → 409 TOO_OLD。 */
const RETRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
  // ★ cwi-qa FX-27（QA-27）：訊息 age 硬頂 24h — 過咗 24h 嘅 FAILED 訊息唔准 retry
  //   （template 變數/媒體引用已過時；UI 收到 TOO_OLD → 提示重新輸入）。
  if (msg.createdAt.getTime() < Date.now() - RETRY_MAX_AGE_MS) {
    return NextResponse.json({ error: "TOO_OLD" }, { status: 409 });
  }
  // ★ FX-27：24h 窗口檢查媒體同 text 一樣（image/document — 舊 code 只查 text）；
  //   template/interactive 豁免（過窗發送本係佢哋嘅合法場景 — 同 send route 分流一致）。
  if ((msg.type === "text" || msg.type === "image" || msg.type === "document") && !getWindowState(conv.lastInboundAt).open) {
    return NextResponse.json({ error: "WINDOW_CLOSED" }, { status: 422 });
  }
  const r = await prisma.message.updateMany({
    where: { id, status: "FAILED", waMessageId: null },
    data: { status: "QUEUED", errorCode: null, waMediaId: null }, // ★ FX-27：清 waMediaId（worker re-upload）
  });
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

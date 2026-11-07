/**
 * ★ cwi-sticker-20261107：POST /api/messages/sticker { conversationId, stickerId, clientMessageId? } — 員工發貼圖。
 *
 * 檢查次序同 /api/messages/media 一致：404 conv → 403 access → 403 SUPERVISOR → replay（clientMessageId）
 *   → 423 SEND_LOCKED → 423 SALES_LOCKED → 422 窗口過（貼圖唔係範本，過窗唔發得）→ 404 貼圖（自己嘅 + 診所嘅先用得）
 *   → 複製一份檔（out-<uuid>.webp；刪貼圖唔影響已發）→ auto-claim → Message(OUT, sticker, QUEUED) → AuditLog → enqueue → 202
 * 冪等：clientMessageId 重發 → 回舊 row（唔重複落碟／入隊）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertConversationAccess, assertCanWriteConversation } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { enqueueOutboundSend } from "@/lib/queue";
import { publishConvEvent, convRef } from "@/lib/notify";
import { getWindowState } from "@/lib/wa/window";
import { BILLING_SERVICE } from "@/lib/wa/billing";
import { assignConversation } from "@/lib/assign";
import { salesLockResponse } from "@/lib/sales/guard";
import { copyStickerFile, touchSticker, usableSticker } from "@/lib/stickers";
import { stickerError } from "@/lib/stickers-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const ENQUEUE_TIMEOUT_MS = 1500;

const schema = z
  .object({
    conversationId: z.string().min(1).max(64),
    stickerId: z.string().min(1).max(64),
    clientMessageId: z.string().uuid().nullish(),
  })
  .strict();

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const { conversationId, stickerId } = parsed.data;
  const clientMessageId = parsed.data.clientMessageId ?? null;

  const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  await assertConversationAccess(ctx, conv);
  assertCanWriteConversation(ctx);

  if (clientMessageId) {
    const existing = await prisma.message.findFirst({ where: { clientMessageId, conversationId: conv.id } });
    if (existing) return NextResponse.json({ ok: true, messageId: existing.id, status: existing.status, idempotentReplay: true }, { status: 200 });
  }
  if (conv.assigneeId && conv.assigneeId !== ctx.staff.id) {
    return NextResponse.json(
      { error: "SEND_LOCKED", message: "此對話已有負責人 — 你只可發內部備註，或撳〔接手〕轉交畀自己", assigneeId: conv.assigneeId },
      { status: 423 },
    );
  }
  {
    const salesLocked = await salesLockResponse(conv.id, ctx.staff.id);
    if (salesLocked) return salesLocked;
  }
  if (!getWindowState(conv.lastInboundAt).open) {
    return NextResponse.json({ error: "window_closed", message: "24 小時客服窗口已過，貼圖唔可以發（只可以發範本）", remainingHours: 0 }, { status: 422 });
  }
  let sticker;
  try {
    sticker = await usableSticker(stickerId, ctx.staff.id);
  } catch (e) {
    return stickerError(e);
  }

  const fileKey = `out-${randomUUID()}.webp`;
  let copied: { path: string; bytes: number };
  try {
    copied = await copyStickerFile(sticker.fileKey, fileKey);
  } catch {
    return NextResponse.json({ error: "STICKER_UNREADABLE", message: "讀唔到呢張貼圖（可能已被刪）" }, { status: 410 });
  }

  if (!conv.assigneeId) {
    await assignConversation({ conversationId: conv.id, toStaffId: ctx.staff.id, by: "AUTO_CLAIM", byStaffId: ctx.staff.id });
    conv.assigneeId = ctx.staff.id;
  }

  const now = new Date();
  let msg;
  try {
    msg = await prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: "OUT",
        channel: "API",
        type: "sticker",
        body: null,
        mediaPath: copied.path,
        mediaKey: fileKey,
        mediaStatus: "READY",
        billingCategory: BILLING_SERVICE,
        status: "QUEUED",
        sentByStaffId: ctx.staff.id,
        sentVia: "HUMAN_TYPED",
        clientMessageId,
        waTimestamp: now,
      },
    });
  } catch (err) {
    await unlink(copied.path).catch(() => undefined);
    if ((err as { code?: string } | null)?.code === "P2002" && clientMessageId) {
      const existing = await prisma.message.findFirst({ where: { clientMessageId, conversationId: conv.id } });
      if (existing) return NextResponse.json({ ok: true, messageId: existing.id, status: existing.status, idempotentReplay: true }, { status: 200 });
    }
    throw err;
  }

  if (conv.status === "RESOLVED") {
    const flipped = await prisma.conversation.updateMany({ where: { id: conv.id, status: "RESOLVED" }, data: { status: "OPEN", reopenedAt: now, resolvedBy: null, resolvedAt: null } });
    if (flipped.count === 1) {
      conv.status = "OPEN";
      await publishConvEvent(convRef(conv), "conv:updated", { conversationId: conv.id, clinicId: conv.clinicId, status: "OPEN", reopenedAt: now }).catch(() => undefined);
    }
  }
  if (conv.assigneeId === ctx.staff.id) await prisma.$executeRaw`UPDATE "Conversation" SET "assigneeLastActionAt" = ${now} WHERE "id" = ${conv.id}`;
  await prisma.$executeRaw`UPDATE "Conversation" SET "lastMessageAt" = GREATEST("lastMessageAt", ${now}) WHERE "id" = ${conv.id}`;
  await prisma.auditLog
    .create({ data: { staffId: ctx.staff.id, action: "SEND_MEDIA", entity: "Message", entityId: msg.id, meta: { kind: "sticker", size: copied.bytes, stickerId } as object } })
    .catch(() => undefined);
  void touchSticker(sticker.id);

  try {
    await Promise.race([
      enqueueOutboundSend(msg.id),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("enqueue timeout")), ENQUEUE_TIMEOUT_MS)),
    ]);
  } catch (err) {
    log.error({ messageId: msg.id, err: err instanceof Error ? err.message : String(err) }, "sticker: enqueue uncertain — stays QUEUED (sweep will requeue)");
    return NextResponse.json({ ok: true, messageId: msg.id, status: "QUEUED", enqueueUncertain: true }, { status: 202 });
  }
  log.info({ clinicId: conv.clinicId, conversationId: conv.id, messageId: msg.id, kind: "sticker" }, "sticker: queued");
  return NextResponse.json({ ok: true, messageId: msg.id, status: "QUEUED", mediaUrl: `/api/media/${fileKey}` }, { status: 202 });
});

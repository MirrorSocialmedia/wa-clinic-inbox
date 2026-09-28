import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertConversationAccess, clinicScope, assertCanWriteConversation } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { enqueueOutboundSend } from "@/lib/queue";
import { publishConvEvent, convRef } from "@/lib/notify";
import { getWindowState } from "@/lib/wa/window";
import { BILLING_SERVICE } from "@/lib/wa/billing";
import { assignConversation } from "@/lib/assign";
import { sniffOutboundMedia, cleanDocName } from "@/lib/wa/media-sniff";
import { saveMediaFile } from "@/lib/wa/media";

/**
 * ★ cwi-final S6-9④（audit3 P2-03）：POST /api/messages/media — 員工發附件（圖片/PDF）。
 *
 * 檢查次序同 /api/messages/send 一致（S3-9：replay 喺 Send Lock 之前）：
 *   400 缺欄/壞 clientMessageId → 413 >10MB（硬頂）→ 404 conv → 403 access → 403 SUPERVISOR
 *   → replay（clientMessageId 命中）→ 423 SEND_LOCKED → 422 窗口過 → 415 類型唔支援
 *   → 413 超該類型上限 → auto-claim → 落碟（即加密）→ Message(OUT, QUEUED)
 *   → AuditLog(SEND_META) → enqueue → 202
 *
 * ★ PII：檔名（可能含病人姓名）只入 DB mediaName + UI + Content-Disposition —
 *   唔入 log、唔入 AuditLog（meta 只 kind/size）。
 * ★ 冪等：clientMessageId（UUID）重發 → 回舊 row（idempotentReplay: true），唔重複落碟/入隊。
 *
 * 註：S3-6 rate limit 未上線（send route 亦無 hit() 調用）→ 該行跳過（spec 口徑）。
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Meta 圖片 5MB / PDF 10MB（自訂）— 入 form 前嘅硬頂（防 client 傳 100MB 先話唔收） */
const HARD_CAP_BYTES = 10 * 1024 * 1024;
const ENQUEUE_TIMEOUT_MS = 1500;

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const conversationId = String(form.get("conversationId") ?? "");
  const clientMessageId = form.get("clientMessageId") ? String(form.get("clientMessageId")) : null;
  const caption = String(form.get("caption") ?? "").trim().slice(0, 1024) || null;
  const file = form.get("file");
  if (!conversationId || !(file instanceof File)) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (clientMessageId && !z.string().uuid().safeParse(clientMessageId).success) {
    return NextResponse.json({ error: "bad clientMessageId" }, { status: 400 });
  }
  if (file.size > HARD_CAP_BYTES) {
    return NextResponse.json({ error: "FILE_TOO_LARGE" }, { status: 413 });
  }

  const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  await assertConversationAccess(ctx, conv); // STAFF 砌別店 URL → 403
  assertCanWriteConversation(ctx); // SUPERVISOR 覆客 403

  // ★ 同 send route（S3-9）：replay 喺 Send Lock 之前 — 命中已存在 Message（同 clientMessageId
  // **且同 conversation**）→ 回舊 row，唔重複落碟/入隊（DB 1 條、病人收 1 條）。
  if (clientMessageId) {
    const existing = await prisma.message.findFirst({
      where: { clientMessageId, conversationId: conv.id },
    });
    if (existing) {
      log.info(
        { clinicId: conv.clinicId, conversationId: conv.id, messageId: existing.id, status: existing.status, clientMessageId },
        "media: idempotent replay（clientMessageId 命中，唔入 queue）"
      );
      return NextResponse.json(
        { ok: true, messageId: existing.id, status: existing.status, idempotentReplay: true },
        { status: 200 }
      );
    }
  }

  // ★ H1 Send Lock（同 send route）：非負責人（包 ADMIN）→ 423
  if (conv.assigneeId && conv.assigneeId !== ctx.staff.id) {
    return NextResponse.json(
      {
        error: "SEND_LOCKED",
        message: "此對話已有負責人 — 你只可發內部備註，或撳〔接手〕轉交畀自己",
        assigneeId: conv.assigneeId,
      },
      { status: 423 }
    );
  }

  // ★ 24h 窗口（fail-closed：lastInboundAt = null → 過窗）— 同打字一樣
  const win = getWindowState(conv.lastInboundAt);
  if (!win.open) {
    return NextResponse.json(
      {
        error: "window_closed",
        message: "24 小時客服窗口已過，附件唔可以發（只可以發 template）",
        remainingHours: 0,
      },
      { status: 422 }
    );
  }

  // ★ 類型偵測：magic bytes（唔信 client MIME／副檔名）— HEIC/Word/Excel/影片 → 415
  const buf = Buffer.from(await file.arrayBuffer());
  const kind = sniffOutboundMedia(buf);
  if (!kind) {
    return NextResponse.json(
      { error: "UNSUPPORTED_TYPE", message: "只可以發 JPG／PNG 圖片或者 PDF" },
      { status: 415 }
    );
  }
  if (buf.length > kind.max) {
    return NextResponse.json({ error: "FILE_TOO_LARGE", maxBytes: kind.max }, { status: 413 });
  }

  // clinicScope belt & braces（同 send route）
  void clinicScope(ctx);

  // ★ H1：unassigned 對話首發 → auto-claim（同 send route；窗口已過唔會 claim — 上面已擋）
  if (!conv.assigneeId) {
    await assignConversation({
      conversationId: conv.id,
      toStaffId: ctx.staff.id,
      by: "AUTO_CLAIM",
      byStaffId: ctx.staff.id,
    });
    conv.assigneeId = ctx.staff.id;
  }

  // 落碟即加密（media.ts S6-3）— fileKey 唔含檔名（PII）；顯示名另存 mediaName
  const fileKey = `out-${randomUUID()}.${kind.ext}`;
  const mediaPath = await saveMediaFile(fileKey, buf);

  const now = new Date();
  let msg;
  try {
    msg = await prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: "OUT" as const,
        channel: "API" as const,
        type: kind.kind, // "image" | "document"
        body: caption, // caption 可以 null（純圖片）
        mediaPath,
        mediaKey: fileKey,
        mediaStatus: "READY" as const,
        mediaName: kind.kind === "document" ? cleanDocName(file.name) : null,
        billingCategory: BILLING_SERVICE,
        status: "QUEUED" as const,
        sentByStaffId: ctx.staff.id,
        // ★ spec 決定：HUMAN_TYPED（真人發送）；**唔設** humanTookOver（附件 ≠ 接管 AI）
        sentVia: "HUMAN_TYPED" as const,
        clientMessageId,
        waTimestamp: now,
      },
    });
  } catch (err) {
    await unlink(mediaPath).catch(() => undefined); // 唔留孤兒檔
    // ★ R1 race（同 send route）：併發同 clientMessageId → P2002 → 回已 commit 嘅 row
    if ((err as { code?: string } | null)?.code === "P2002" && clientMessageId) {
      const existing = await prisma.message.findFirst({
        where: { clientMessageId, conversationId: conv.id },
      });
      if (existing) {
        log.info(
          { clinicId: conv.clinicId, conversationId: conv.id, messageId: existing.id, status: existing.status },
          "media: idempotent replay (P2002 race，唔入 queue)"
        );
        return NextResponse.json(
          { ok: true, messageId: existing.id, status: existing.status, idempotentReplay: true },
          { status: 200 }
        );
      }
    }
    throw err;
  }

  // ★ cwi-final S2-3（同 send route）：員工發送 → RESOLVED 對話重開（commit-then-emit，best-effort）
  if (conv.status === "RESOLVED") {
    const flipped = await prisma.conversation.updateMany({
      where: { id: conv.id, status: "RESOLVED" },
      data: { status: "OPEN", reopenedAt: now, resolvedBy: null, resolvedAt: null },
    });
    if (flipped.count === 1) {
      conv.status = "OPEN";
      await publishConvEvent(convRef(conv), "conv:updated", {
        conversationId: conv.id,
        clinicId: conv.clinicId,
        status: "OPEN",
        reopenedAt: now,
      }).catch((err) => log.warn({ conversationId: conv.id, err: err instanceof Error ? err.message : String(err) }, "media: 重開 conv:updated emit failed（best-effort）"));
    }
  }

  // 同 send route：負責人自己嘅動作 → assigneeLastActionAt
  if (conv.assigneeId && conv.assigneeId === ctx.staff.id) {
    await prisma.$executeRaw`UPDATE "Conversation" SET "assigneeLastActionAt" = ${now} WHERE "id" = ${conv.id}`;
  }

  await prisma.$executeRaw`
    UPDATE "Conversation" SET "lastMessageAt" = GREATEST("lastMessageAt", ${now}) WHERE "id" = ${conv.id}`;

  // ★ AuditLog：只 kind/size — 檔名唔入（可能含病人姓名）
  await prisma.auditLog
    .create({
      data: {
        staffId: ctx.staff.id,
        action: "SEND_MEDIA",
        entity: "Message",
        entityId: msg.id,
        meta: { kind: kind.kind, size: buf.length } as object,
      },
    })
    .catch(() => undefined);

  // ★ S1-15 口徑：enqueue timeout/失敗 = 結果未知 — 唔標 FAILED，回 202 enqueueUncertain
  try {
    await Promise.race([
      enqueueOutboundSend(msg.id),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("enqueue timeout")), ENQUEUE_TIMEOUT_MS)),
    ]);
  } catch (err) {
    log.error(
      { messageId: msg.id, err: err instanceof Error ? err.message : String(err) },
      "media: enqueue uncertain — message stays QUEUED (outbound-sweep will requeue)"
    );
    return NextResponse.json(
      { ok: true, messageId: msg.id, status: "QUEUED", enqueueUncertain: true },
      { status: 202 }
    );
  }

  log.info(
    { clinicId: conv.clinicId, conversationId: conv.id, messageId: msg.id, staffId: ctx.staff.id, kind: kind.kind, size: buf.length },
    "media: queued"
  );

  return NextResponse.json(
    { ok: true, messageId: msg.id, status: "QUEUED", mediaUrl: `/api/media/${fileKey}` },
    { status: 202 }
  );
});

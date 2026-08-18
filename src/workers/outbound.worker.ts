import { Worker, type Job } from "bullmq";
import { outboundQueue, getRedis, QUEUE_PREFIX } from "@/lib/queue";
import { publishNotify } from "@/lib/notify";
import { sendTextMessage } from "@/lib/wa/graph";
import { acquireToken } from "@/lib/rate-limit";
import prisma from "@/lib/prisma";
import log from "@/lib/log";

/**
 * outbound worker — 發訊息 + 重試 + status 回寫（框架 MD §6.3）
 *
 * job.data = { messageId }（Message(OUT, API, QUEUED) 已由 API route 寫好）
 *
 * 流程：
 * 1. 讀 Message + Conversation + Contact + Clinic（攞 waDisplayNumber? 唔 — 攞 waPhoneNumberId + contact.waId）
 * 2. per-number token bucket（80 msg/s 保險）
 * 3. graph.sendTextMessage（mock mode 回假 wamid）
 * 4. 成功 → UPDATE waMessageId + status SENT → Socket 推 message:new
 * 5. 失敗 → throw → BullMQ retry（attempts 3 + 指數 backoff，queue defaultJobOptions）
 * 6. 最終失敗（第 3 次）→ status FAILED + Socket 推 message:status（紅色顯示）
 *
 * ★ 冪等：job 重試時 Message 可能已經有 waMessageId（極端 race：status webhook
 *   先於 retry 到）— 已有 waMessageId + status != QUEUED → 直接 return（skip）。
 *
 * ★ PII 鐵律：log 只帶 messageId / wamid / phone_number_id / status，內文永不入 log。
 */

export interface OutboundJobData {
  messageId: string;
}

async function processOutboundJob(job: Job<OutboundJobData>): Promise<void> {
  const { messageId } = job.data;

  const msg = await prisma.message.findUnique({ where: { id: messageId } });
  if (!msg) {
    log.warn({ messageId }, "outbound: message not found (already cleaned?), skipping");
    return;
  }
  // 冪等 guard：已經發咗（waMessageId 已有且 status 過咗 QUEUED）→ skip
  if (msg.waMessageId && msg.status !== "QUEUED") {
    log.info({ messageId, wamid: msg.waMessageId, status: msg.status }, "outbound: already sent, skip (idempotent)");
    return;
  }

  const conv = await prisma.conversation.findUnique({ where: { id: msg.conversationId } });
  if (!conv) {
    throw new Error(`outbound: conversation missing for message ${messageId}`);
  }
  const clinic = await prisma.clinic.findUnique({ where: { id: conv.clinicId } });
  if (!clinic) {
    throw new Error(`outbound: clinic missing for conversation ${conv.id}`);
  }
  const contactRow = await prisma.contact.findUnique({ where: { id: conv.contactId } });
  if (!contactRow) {
    throw new Error(`outbound: contact missing for conversation ${conv.id}`);
  }

  // 1) rate limit（per phone_number_id, 80 msg/s）
  await acquireToken({ key: clinic.waPhoneNumberId });

  // 2) 發送
  const body = msg.body;
  if (!body) {
    // 空 body 嘅 OUT API message = 壞數據（API route 已擋）→ 標 FAILED 唔重試
    await prisma.message.update({
      where: { id: msg.id },
      data: { status: "FAILED", errorCode: "EMPTY_BODY" },
    });
    publishNotify(clinic.id, "message:status", {
      conversationId: conv.id,
      clinicId: clinic.id,
      waMessageId: msg.waMessageId ?? msg.id,
      status: "FAILED",
      errorCode: "EMPTY_BODY",
    });
    return;
  }

  const maxAttempts = job.opts.attempts ?? 3;
  try {
    const { wamid } = await sendTextMessage({
      phoneNumberId: clinic.waPhoneNumberId,
      to: contactRow.waId,
      body,
    });

    const updated = await prisma.message.update({
      where: { id: msg.id },
      data: { waMessageId: wamid, status: "SENT" },
    });
    await touchConv(clinic.id, conv.id, msg.waTimestamp);
    publishNotify(clinic.id, "message:new", {
      conversationId: conv.id,
      clinicId: clinic.id,
      contact: {
        id: contactRow.id,
        waId: contactRow.waId,
        profileName: contactRow.profileName,
        labels: contactRow.labels,
      },
      message: publicMsg(updated),
      conversation: {
        status: conv.status,
        unreadCount: conv.unreadCount,
        lastMessageAt: conv.lastMessageAt,
        lastInboundAt: conv.lastInboundAt,
      },
    });
    log.info(
      { clinic: clinic.code, messageId, wamid, to: contactRow.waId },
      "outbound: sent OK"
    );
  } catch (err) {
    const isFinal = job.attemptsMade + 1 >= maxAttempts;
    if (isFinal) {
      // 最終失敗 → FAILED + 通知 UI（紅色）
      await prisma.message
        .update({
          where: { id: msg.id },
          data: {
            status: "FAILED",
            errorCode: err instanceof Error ? truncateCode(err.message) : "UNKNOWN",
          },
        })
        .catch(() => undefined);
      publishNotify(clinic.id, "message:status", {
        conversationId: conv.id,
        clinicId: clinic.id,
        waMessageId: msg.waMessageId ?? msg.id,
        status: "FAILED",
        errorCode: "SEND_FAILED",
      });
      log.error(
        { clinic: clinic.code, messageId, attempts: job.attemptsMade + 1, err: err instanceof Error ? err.message : String(err) },
        "outbound: permanently failed"
      );
      return; // 唔再 throw（job 完成，唔好令 queue 記錄成 failed）
    }
    log.warn(
      { clinic: clinic.code, messageId, attempt: job.attemptsMade + 1, err: err instanceof Error ? err.message : String(err) },
      "outbound: send failed, will retry"
    );
    throw err; // → BullMQ 指數 backoff retry
  }
}

function truncateCode(s: string): string {
  return s.slice(0, 60).replace(/\s+/g, "_") || "UNKNOWN";
}

async function touchConv(clinicId: string, convId: string, ts: Date): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "Conversation" SET "lastMessageAt" = GREATEST("lastMessageAt", ${ts}) WHERE "id" = ${convId}`;
  void clinicId;
}

function publicMsg(msg: {
  id: string;
  conversationId: string;
  waMessageId: string | null;
  direction: "IN" | "OUT";
  channel: "API" | "APP_ECHO" | "HISTORY";
  type: string;
  body: string | null;
  mediaPath: string | null;
  status: string;
  errorCode: string | null;
  sentByStaffId: string | null;
  aiAutoSent: boolean;
  waTimestamp: Date;
  createdAt: Date;
}) {
  return {
    id: msg.id,
    conversationId: msg.conversationId,
    waMessageId: msg.waMessageId,
    direction: msg.direction,
    channel: msg.channel,
    type: msg.type,
    body: msg.body,
    mediaPath: msg.mediaPath,
    status: msg.status,
    errorCode: msg.errorCode,
    sentByStaffId: msg.sentByStaffId,
    // Phase 2b：UI 用呢個顯示「AI 自動覆」標記（staff 可審計）
    aiAutoSent: msg.aiAutoSent,
    waTimestamp: msg.waTimestamp,
    createdAt: msg.createdAt,
  };
}

export function startOutboundWorker(): Worker {
  const worker = new Worker<OutboundJobData>(
    outboundQueue.name,
    (job: Job<OutboundJobData>) => processOutboundJob(job),
    { connection: getRedis(), prefix: QUEUE_PREFIX, concurrency: 5 }
  );

  worker.on("completed", (job) => {
    log.info({ jobId: job.id }, "outbound job completed");
  });
  worker.on("failed", (job, err) => {
    log.error({ jobId: job?.id, err: err.message }, "outbound job failed");
  });
  worker.on("error", (err) => {
    log.error(
      { queue: outboundQueue.name, err: err.message },
      "outbound worker error — exiting for PM2 restart"
    );
    process.exit(1);
  });

  return worker;
}

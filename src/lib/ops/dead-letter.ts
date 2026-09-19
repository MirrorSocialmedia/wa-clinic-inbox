/**
 * ★ cwi-final S1-1a — Dead-letter（DLQ）寫入／重放共享層。
 *
 * 寫入：inbound worker 最終失敗（attempts 耗盡）時調 — payload 已 AES-256-GCM 加密
 * （MEDIA_ENC_KEY，同 media key）。最終失敗發生時 DB 本身可以係死嘅（T610 case b：
 * 8 次 retry 耗盡 ~4.2 分鐘，DB 仍 stop 緊）→ 寫入帶短 retry 窗（10/15/30/60s × 6，
 * 累計 ~4 分鐘）；全部失敗只 log.error（failed handler 唔准炸 worker process）。
 * 註：retry loop 喺記憶體 — 期間 worker 被 PM2 重啟 = 呢筆 DLQ 行丟（WebhookEvent
 * metadata 仍留低供 debug；可接受，best-effort 口徑）。
 *
 * 重放：`replayedAt IS NULL` 行 → decrypt → `inboundQueue.add("event", data)` → 標 replayedAt。
 * WebhookEvent claim 冪等（P2002 → Message 已存在 → skip）→ 重放安全（重複事件靜默跳過）。
 *
 * ★ D-2：log 零病人原文 — 只 id / queue / 計數 / error code。payload 永遠唔出 log。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { inboundQueue } from "@/lib/queue";
import { decryptMedia, getMediaKey } from "@/lib/wa/media";

export interface WriteDeadLetterInput {
  queue: string;
  jobId: string;
  payloadEnc: string; // base64（encryptMedia 輸出）
  error: string; // ≤500 字（caller 截斷）
}

const DLQ_WRITE_BACKOFF_MS = [10_000, 15_000, 30_000, 60_000, 60_000, 60_000];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 寫 DLQ 行（帶 retry 窗）。回 true = 落庫成功。永不 throw。 */
export async function writeDeadLetter(input: WriteDeadLetterInput): Promise<boolean> {
  for (let attempt = 0; attempt <= DLQ_WRITE_BACKOFF_MS.length; attempt++) {
    try {
      await prisma.deadLetter.create({
        data: {
          queue: input.queue,
          jobId: input.jobId,
          payloadEnc: input.payloadEnc,
          error: input.error,
        },
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === DLQ_WRITE_BACKOFF_MS.length) {
        log.error(
          { queue: input.queue, jobId: input.jobId, attempts: attempt + 1, err: msg.slice(0, 200) },
          "DLQ: write permanently failed（WebhookEvent metadata 仍存；需人手跟）"
        );
        return false;
      }
      log.warn({ queue: input.queue, jobId: input.jobId, attempt: attempt + 1, err: msg.slice(0, 200) }, "DLQ: write failed — retry");
      await sleep(DLQ_WRITE_BACKOFF_MS[attempt]);
    }
  }
  return false;
}

export interface ReplayResult {
  total: number;
  replayed: number;
  failed: number;
}

/**
 * 重放所有未重放 DLQ 行（queue=inbound）。
 * CLI（scripts/replay-dead-letters.ts）同 admin 重放掣共用。
 */
export async function replayUnreplayedDeadLetters(): Promise<ReplayResult> {
  const rows = await prisma.deadLetter.findMany({
    where: { queue: "inbound", replayedAt: null },
    orderBy: { createdAt: "asc" },
  });
  const result: ReplayResult = { total: rows.length, replayed: 0, failed: 0 };
  if (rows.length === 0) return result;

  const key = getMediaKey();
  if (!key) {
    // dev 無 key 時 encryptMedia 都寫唔到（writer 已 guard）— 呢度 defensive：一行都唔重放。
    log.error({ total: rows.length }, "replay-dead-letters: MEDIA_ENC_KEY 未設 — 無法 decrypt，0 行重放");
    result.failed = rows.length;
    return result;
  }

  for (const r of rows) {
    try {
      const plain = decryptMedia(Buffer.from(r.payloadEnc, "base64"), key);
      const data: unknown = JSON.parse(plain.toString("utf8"));
      await inboundQueue.add("event", data as object);
      await prisma.deadLetter.update({ where: { id: r.id }, data: { replayedAt: new Date() } });
      result.replayed += 1;
    } catch (err) {
      // decrypt/JSON/Redis 任一失敗 → 留 replayedAt=null 俾下次重試（log 零 payload 內容）
      result.failed += 1;
      log.error(
        { id: r.id, queue: r.queue, jobId: r.jobId, err: err instanceof Error ? err.message : String(err) },
        "replay-dead-letters: 行重放失敗（留底，下次再試）"
      );
    }
  }

  log.info({ ...result }, "replay-dead-letters: done");
  return result;
}

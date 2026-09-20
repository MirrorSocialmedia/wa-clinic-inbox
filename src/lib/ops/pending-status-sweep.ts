/**
 * ★ cwi-final S1-1c（C-1③ / audit3 P1-06）— pending-status-sweep：PendingStatus 排水兜底（light cron lane，每 2 分鐘）。
 *
 * 背景：status 早過訊息 parked 入 PendingStatus 後，正常由兩個即時排水點清走
 * （outbound waMessageId 寫入後 / APP_ECHO 落庫後）。如果兩個點都冇命中
 * （例如 outbound job 失敗後重試跨咗 drain 窗口 / worker crash 留 parked 行），
 * 呢個 sweep 每 2 分鐘兜底：
 *
 *  1. drain：SELECT DISTINCT wamid（JOIN Message 配對到嘅，LIMIT 500）逐個 drainPendingStatuses。
 *     配對唔到嘅唔郁（可能 Message 快寫入 — 留俾下一輪）。
 *  2. drop：`receivedAt < now-24h` 剩低嘅行 → deleteMany + log.warn（24h 都配對唔到
 *     = 死行，例如唔屬於我哋嘅 wamid / outbound 永久失敗 — 零 PII，唔需保留）。
 *
 * 冪等：drain 靠 nextStatus monotonic + PendingStatus 行刪除（重跑 no-op）；
 * drop 靠 deleteMany（重跑 0 行）。零 PII：log 只計數。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { drainPendingStatuses } from "@/lib/wa/status-apply";

const PER_ROUND_LIMIT = 500; // 每輪最多 drain 幾個 wamid（保護 DB；积压跨多輪清）
const DROP_AFTER_MS = 24 * 60 * 60 * 1000; // 24h 仍配對唔到 → 丟棄

export interface PendingStatusSweepResult {
  drained: number;
  dropped: number;
}

export async function runPendingStatusSweep(now: number = Date.now()): Promise<PendingStatusSweepResult> {
  // ── 1. drain 配對到嘅 wamid（JOIN Message，LIMIT 500）────────────────
  const matched = await prisma.$queryRaw<{ wamid: string }[]>`
    SELECT DISTINCT ps."wamid"
    FROM "PendingStatus" ps
    JOIN "Message" m ON m."waMessageId" = ps."wamid"
    LIMIT ${PER_ROUND_LIMIT}
  `;
  let drained = 0;
  for (const row of matched) {
    // drain 內部已 catch（唔 throw）— 單個 wamid 失敗唔阻其他
    await drainPendingStatuses(row.wamid);
    drained += 1;
  }

  // ── 2. 24h 仍配對唔到 → 丟棄 ──────────────────────────────────────
  const cutoff = new Date(now - DROP_AFTER_MS);
  const del = await prisma.pendingStatus.deleteMany({ where: { receivedAt: { lt: cutoff } } });
  if (del.count > 0) {
    log.warn({ count: del.count }, "pending-status-sweep: 24h 仍配對唔到 — 已丟棄");
  }

  log.info({ drained, dropped: del.count }, "pending-status-sweep: done");
  return { drained, dropped: del.count };
}

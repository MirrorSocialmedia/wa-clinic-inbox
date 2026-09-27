/**
 * ★ cwi-final S6-4：ops metrics 收集器 — GET /api/admin/metrics（global admin）。
 *
 * 回：
 * - queues：每條 queue 嘅 waiting/active/failed 數 + oldest age（秒）+ oldest age p95（秒，S1-2/S6-6 觸發指標）
 * - outboundUnknown：direction=OUT + status=UNKNOWN 訊息數（S1-15 P0-07 — 需人工核，唔會自動重發）
 * - aiSuccessRate：AiCallStats okCalls/totalCalls（全期累計；null = 未跑過）
 * - dlqCount：DeadLetter 總數（30 日 retention 後嘅現存量）
 * - listTruncatedReports：client 回報列表截斷次數（POST /api/telemetry；S6-6 分區觸發觀察）
 * - pendingStatusDropped：S1-1c sweep 24h 死行 drop 累計
 *
 * ★ metadata only — 全部係計數/時間，零 PII。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import {
  inboundQueue,
  outboundQueue,
  aiQueue,
  aiUrgentQueue,
  cronQueue,
  mediaQueue,
  bookingWriteQueue,
} from "@/lib/queue";
import type { Queue } from "bullmq";

export interface QueueMetric {
  name: string;
  waiting: number;
  active: number;
  failed: number;
  /** 最舊 job 年齡（秒）；無 job = null */
  oldestAgeSec: number | null;
  /** 最舊 job 年齡 p95（秒，sample ≤2000 waiting jobs）；無 job = null */
  oldestAgeP95Sec: number | null;
}

export interface OpsMetrics {
  generatedAt: string;
  queues: QueueMetric[];
  outboundUnknown: number;
  /** 0-1；null = 無數據 */
  aiSuccessRate: number | null;
  aiTotalCalls: number;
  aiOkCalls: number;
  dlqCount: number;
  listTruncatedReports: number;
  pendingStatusDropped: number;
}

const QUEUES: { name: string; q: Queue }[] = [
  { name: "inbound", q: inboundQueue },
  { name: "outbound", q: outboundQueue },
  { name: "ai", q: aiQueue },
  { name: "ai-urgent", q: aiUrgentQueue },
  { name: "media", q: mediaQueue },
  { name: "cron", q: cronQueue },
  { name: "booking-write", q: bookingWriteQueue },
];

const AGE_SAMPLE_LIMIT = 2000; // p95 sample 上限（waiting queue 極度堆積時截斷 — metrics 唔可以打爆 DB/Redis）

async function queueMetric(name: string, q: Queue): Promise<QueueMetric> {
  try {
    const counts = await q.getJobCounts("waiting", "active", "failed");
    const waiting = await q.getJobs(["waiting"], 0, AGE_SAMPLE_LIMIT - 1, true); // asc = 最舊排前
    const now = Date.now();
    const ages = waiting.map((j) => Math.max(0, Math.round((now - j.timestamp) / 1000)));
    ages.sort((a, b) => a - b);
    const oldestAgeSec = ages.length > 0 ? ages[ages.length - 1] : null;
    const oldestAgeP95Sec = ages.length > 0 ? ages[Math.floor(0.95 * (ages.length - 1))] : null;
    return {
      name,
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      failed: counts.failed ?? 0,
      oldestAgeSec,
      oldestAgeP95Sec,
    };
  } catch (err) {
    // Redis 抖動唔可以令成個 metrics 500 — 該 queue 回 null 計數 + warn
    log.warn({ queue: name, err: err instanceof Error ? err.message : String(err) }, "metrics: queue stats failed");
    return { name, waiting: -1, active: -1, failed: -1, oldestAgeSec: null, oldestAgeP95Sec: null };
  }
}

async function telemetryCount(key: string): Promise<number> {
  try {
    const row = await prisma.telemetryCounter.findUnique({ where: { key }, select: { count: true } });
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

export async function collectMetrics(): Promise<OpsMetrics> {
  const [queues, outboundUnknown, aiStats, dlqCount, listTruncated, pendingDropped] = await Promise.all([
    Promise.all(QUEUES.map(({ name, q }) => queueMetric(name, q))),
    prisma.message.count({ where: { direction: "OUT", status: "UNKNOWN" } }),
    prisma.aiCallStats.findUnique({ where: { id: 1 } }),
    prisma.deadLetter.count(),
    telemetryCount("listTruncated"),
    telemetryCount("pendingStatusDropped"),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    queues,
    outboundUnknown,
    aiSuccessRate: aiStats && aiStats.totalCalls > 0 ? Math.round((aiStats.okCalls / aiStats.totalCalls) * 10_000) / 10_000 : null,
    aiTotalCalls: aiStats?.totalCalls ?? 0,
    aiOkCalls: aiStats?.okCalls ?? 0,
    dlqCount,
    listTruncatedReports: listTruncated,
    pendingStatusDropped: pendingDropped,
  };
}

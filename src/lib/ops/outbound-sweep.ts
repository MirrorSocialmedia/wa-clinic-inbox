/**
 * ★ cwi-final S1-15 (P0-07) — outbound-sweep：outbound QUEUED/SENDING 卡死兜底（light cron lane，每 2 分鐘）。
 *
 * 背景：S1-15 語義 = enqueue timeout/失敗 **唔標 FAILED**（job 可能已落隊列 — jobId=messageId
 * 冪等；標 FAILED 會令 row 永遠 claim 唔到 = 訊息丟失）。代價 = message row 可能喺
 * QUEUED/SENDING 停留（web 過程 enqueue 中途 crash / job 丟失）。呢個 sweep 兜底：
 *
 *  1. stale QUEUED：OUT + API + QUEUED + createdAt ∈ (now-6h, now-120s) → 重加 enqueue（take 200）。
 *     - 下界 120s = 留正常 job 被 worker 撿走嘅時間（正常發送 <5s）；
 *     - 上界 6h = 過老 = 歷史殘留（唔再重加 — 留俾 staff 人工睇 inbox）。
 *     - "Job already exists"（job 仲喺隊列 waiting/active/delayed）= 即将/正在執行 —
 *       吞 + log.info（唔係重複發送；completed job 保留期 removeOnComplete count:20 內先會撞）。
 *  2. stuck SENDING：updatedAt < now-5min（claim 咗但無 terminal — worker 發送中途 crash /
 *     Graph 冇回應）→ UNKNOWN + errorCode SENDING_TIMEOUT + upsertAlert(outbound_unknown, HIGH)。
 *     UNKNOWN row：outbound worker claim guard 見到無 wamid 唔會雙發；若 sent webhook 之後
 *     先返嚟會按 status-rank 升返 SENT（UNKNOWN rank=1 < SENT）。
 *
 * 冪等：重加靠 jobId=messageId（BullMQ dedup）；stuck 標記係 updateMany（重跑 = 0 行）；
 * alert 靠 upsertAlert (type, clinicId=null) 未解決只一條。
 * 零 PII：log 只計數 / messageId。
 *
 * ⚠️ outbound_unknown **唔喺** HEALTH_OWNED_TYPES — 唔會俾 runHealthCheck 自動 resolve（S1-1a R-28）。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { enqueueOutboundSend } from "@/lib/queue";
import { upsertAlert } from "@/lib/health/alerts";

const STALE_MIN_MS = 120_000; // QUEUED 超過 120s = job 冇被撿走（正常路徑 <5s）
const STALE_MAX_MS = 6 * 3600_000; // 超過 6h = 歷史殘留，唔重加
const STUCK_MS = 300_000; // SENDING 超過 5 min 無更新 = 卡死
const PER_ROUND_LIMIT = 200; // 每輪最多重加幾多條（保護 Redis/worker；積壓跨多輪清）

export interface OutboundSweepResult {
  requeued: number;
  unknown: number;
}

export async function runOutboundSweep(now: Date = new Date()): Promise<OutboundSweepResult> {
  // ── 1. stale QUEUED → 重加（jobId=messageId 冪等；逐行 try/catch 防單行失敗阻全輪）──
  const stale = await prisma.message.findMany({
    where: {
      direction: "OUT",
      channel: "API",
      status: "QUEUED",
      createdAt: {
        lt: new Date(now.getTime() - STALE_MIN_MS),
        gt: new Date(now.getTime() - STALE_MAX_MS),
      },
    },
    select: { id: true },
    take: PER_ROUND_LIMIT,
  });
  for (const m of stale) {
    try {
      await enqueueOutboundSend(m.id);
    } catch (err) {
      const msgText = err instanceof Error ? err.message : String(err);
      if (/Job already exists/i.test(msgText)) {
        // job 仲喺隊列（waiting/active/delayed/completed 保留期內）= 即将或正在執行 — 唔係重複發送
        log.info({ messageId: m.id }, "outbound-sweep: job still in queue — skip re-enqueue");
        continue;
      }
      log.warn({ messageId: m.id, err: msgText }, "outbound-sweep: re-enqueue failed");
    }
  }

  // ── 2. stuck SENDING → UNKNOWN（updateMany = 冪等；重跑 = 0 行）──
  const stuck = await prisma.message.updateMany({
    where: { status: "SENDING", updatedAt: { lt: new Date(now.getTime() - STUCK_MS) } },
    data: { status: "UNKNOWN", errorCode: "SENDING_TIMEOUT" },
  });
  if (stuck.count > 0) {
    await upsertAlert({ type: "outbound_unknown", severity: "HIGH", detail: { count: stuck.count } });
  }

  if (stale.length > 0 || stuck.count > 0) {
    log.info({ requeued: stale.length, unknown: stuck.count }, "outbound-sweep: done");
  }
  return { requeued: stale.length, unknown: stuck.count };
}

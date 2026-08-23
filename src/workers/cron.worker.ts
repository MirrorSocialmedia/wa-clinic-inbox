/**
 * cron worker — 排程入口（MD §8.3）
 *
 * Job names（由 workers/index.ts 用 upsertJobScheduler 登記；E2E 可手動 enqueue）：
 * - sync-availability  每 15 分鐘（cron pattern: 15 分間隔） → refreshAllClinics()
 *                                       （getSlots 四層降級鏈 — workforce API 逐店刷新 L2 cache；
 *                                       單店失敗唔阻其他店）
 * - bookings-expire    每 5 分鐘（cron pattern: 5 分間隔） → 48h PENDING → EXPIRED + 棄單 Flow 清理
 * - health-check       每 5 分鐘（cron pattern: 5 分間隔） → 6 項健康自檢（MD §9.3）：
 *                                       webhook stale / queue depth / AI breaker / workforce degraded / disk / backup
 * - quality-check      每日 06:30 → 逐號 quality_rating（跌 YELLOW/RED → HIGH alert）
 * - weekly-report      每星期一 07:00 → 上一週營運報表（OpsReport + ALERT_CHANNEL 推送）
 *
 * 反循環：每個 job 都係 DB/queue 讀 + 冪等寫（upsert / 未解決 alert 唔重開）— 重複執行安全。
 */
import { Worker } from "bullmq";
import { cronQueue, getRedis, QUEUE_PREFIX } from "@/lib/queue";
import log from "@/lib/log";
import { refreshAllClinics } from "@/lib/availability";
import { runExpiry } from "@/lib/booking/expiry";
import { runHealthCheck, type HealthOverrides } from "@/lib/health/check";
import { runQualityCheck } from "@/lib/quality/check";
import { runWeeklyReport } from "@/lib/ops/report";

export async function startCronWorker(): Promise<Worker | null> {
  const worker = new Worker(
    cronQueue.name,
    async (job) => {
      switch (job.name) {
        case "sync-availability": {
          const r = await refreshAllClinics();
          log.info(
            { total: r.total, ok: r.ok, failed: r.failed },
            "cron: sync-availability → workforce L2 refresh done"
          );
          return { ok: true, total: r.total, okCount: r.ok, failed: r.failed };
        }
        case "bookings-expire": {
          const r = await runExpiry();
          return { ok: true, ...r };
        }
        case "health-check": {
          // overrides 只係 E2E 注入路徑（job.data.overrides）— production scheduler 唔會傳
          const overrides = (job.data as { overrides?: HealthOverrides } | undefined)?.overrides;
          const r = await runHealthCheck(overrides);
          return { ok: true, created: r.created.length, resolved: r.resolved };
        }
        case "quality-check": {
          const r = await runQualityCheck();
          return { ok: true, ...r };
        }
        case "weekly-report": {
          const r = await runWeeklyReport();
          return { ok: true, scopes: r.scopes };
        }
        default:
          log.warn({ jobName: job.name }, "cron worker: unknown job — skip");
      }
    },
    {
      connection: getRedis(),
      prefix: QUEUE_PREFIX,
      concurrency: 1,
    }
  );

  worker.on("failed", (job, err) => {
    log.error({ job: job?.name, err: err.message }, "cron: job failed");
  });

  log.info({}, "cron worker started");
  return worker;
}

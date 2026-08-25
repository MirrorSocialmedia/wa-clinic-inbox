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
 * - retention-purge    每日 04:00（HK，同其他 job 一樣跟 process TZ）→ P0 自動刪除（§6.0）：
 *                                       Message 24 月（連 NoteReadReceipt/PatientFact）/ 媒體 12 月 / AiDraft 90 日 / StaffNotice 已讀 90 日
 *                                       保留期 env 化（RETENTION_CONV_MONTHS 等三變數）+ 寫 OpsReport
 * - reminder-scan      每 15 分鐘 → T-24h 預約提醒（Phase B，cwi-tmpl-20260824-b1）：
 *                                       CONFIRMED + apricotApptId + 未提醒 + 開診時刻 ∈ [now+23h, now+25h]
 *                                       → template Message + remindedAt 冪等 transaction（寧漏勿重）
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
import { runRetentionPurge } from "@/lib/ops/retention-purge";
import { runReminderScan } from "@/lib/booking/reminder";
import { runWeeklyStats } from "@/lib/ops/automation-stats";
import { runMining } from "@/lib/ops/mining";

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
        case "stats-weekly": {
          // Phase E（cwi-ai-20260825-t5）：週一 05:00 HK — 先統計（上週），接住 mining 出建議卡。
          // 早過 weekly-report 07:00（report 可以引用自動化摘要）。
          const s = await runWeeklyStats();
          const m = await runMining(s.weekStart);
          return { ok: true, weekStart: s.weekStart, statRows: s.rows, miningCards: m.cards };
        }
        case "retention-purge": {
          // P0（§6.0）：每日 04:00 HK；E2E 可手動 enqueue（pnpm e2e:cron retention-purge）
          const r = await runRetentionPurge();
          return { ok: true, ...r };
        }
        case "reminder-scan": {
          // Phase B（cwi-tmpl-20260824-b1）：T-24h 預約提醒；E2E 可手動 enqueue（pnpm e2e:cron reminder-scan）
          const r = await runReminderScan();
          return { ok: true, ...r };
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

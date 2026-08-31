/**
 * worker process 入口 — `node --import tsx dist/workers/index.js` 或直接 tsx
 *
 * 一個 process 行晒 5 個 worker（inbound/outbound/ai/cron/media）。
 * mock E2E 同 dev 都咁跑；production 先拆 process。
 *
 * 啟動首跑：refreshAllClinics()（fire-and-forget）— 立即填 L2 cache + WorkforceSyncState，
 * 唔使等首個 15 分鐘 cron boundary（health check 嘅 workforce_api_degraded 判斷要咁先正確）。
 */
import "./env";
import { startInboundWorker } from "./inbound.worker";
import { startOutboundWorker } from "./outbound.worker";
import { startAiWorker } from "./ai.worker";
import { startCronWorker } from "./cron.worker";
import { startMediaWorker } from "./media.worker";
import { cronQueue, getRedis } from "@/lib/queue";
import { refreshAllClinics } from "@/lib/availability";
import { CONTROL_CHANNEL, type ControlMessage } from "@/lib/notify";
import { applyCacheBust } from "@/lib/cache-bust";
import log from "@/lib/log";

async function registerSchedulers() {
  // Phase 3 排程（BullMQ v6 upsertJobScheduler — id 冪等，重啟唔會重覆）
  await cronQueue.upsertJobScheduler("sched-sync-availability", { pattern: "*/15 * * * *" }, {
    name: "sync-availability",
    data: {},
  });
  await cronQueue.upsertJobScheduler("sched-bookings-expire", { pattern: "*/5 * * * *" }, {
    name: "bookings-expire",
    data: {},
  });
  // Phase 4（MD §9.3）：5 分鐘健康自檢 + 每日 quality_rating + 每星期一週報
  await cronQueue.upsertJobScheduler("sched-health-check", { pattern: "*/5 * * * *" }, {
    name: "health-check",
    data: {},
  });
  // providerslot-20260830 T3：Flow hold 狀態推進 + held_timeout 警報（冪等，可空跑）
  await cronQueue.upsertJobScheduler("sched-hold-sweep", { pattern: "*/5 * * * *" }, {
    name: "hold-sweep",
    data: {},
  });
  // cwi-h6-20260830（h5 §3）：auto-release — 負責人超時未回覆（三條件）→ 放手回隊列（冪等，可空跑）
  await cronQueue.upsertJobScheduler("sched-auto-release", { pattern: "*/5 * * * *" }, {
    name: "auto-release",
    data: {},
  });
  await cronQueue.upsertJobScheduler("sched-quality-check", { pattern: "30 6 * * *" }, {
    name: "quality-check",
    data: {},
  });
  await cronQueue.upsertJobScheduler("sched-weekly-report", { pattern: "0 7 * * 1" }, {
    name: "weekly-report",
    data: {},
  });
  // Phase E（cwi-ai-20260825-t5）：週統計 + mining — 週一 05:00 HK（早過 weekly-report 07:00，
  // 等佢可以引用自動化摘要）
  await cronQueue.upsertJobScheduler("sched-stats-weekly", { pattern: "0 5 * * 1" }, {
    name: "stats-weekly",
    data: {},
  });
  // AI Workflow T1（cwi-ai-20260824-t1）：P0 retention purge — 每日 04:00（HK；跟其他 job 一樣用
  // process 本地時區 — 部署 host TZ=Asia/Hong_Kong）
  await cronQueue.upsertJobScheduler("sched-retention-purge", { pattern: "0 4 * * *" }, {
    name: "retention-purge",
    data: {},
  });
  // Phase B（cwi-tmpl-20260824-b1）：T-24h 預約提醒 — 每 15 分鐘掃（窗口 23–25h 內每 15 分鐘掃一次；
  // remindedAt 冪等 transaction 保證重覆掃描唔會重發）
  await cronQueue.upsertJobScheduler("sched-reminder-scan", { pattern: "*/15 * * * *" }, {
    name: "reminder-scan",
    data: {},
  });
  log.info(
    {},
    "cron: schedulers registered (sync-availability */15m, bookings-expire */5m, health-check */5m, quality-check daily 06:30, stats-weekly Mon 05:00, weekly-report Mon 07:00, retention-purge daily 04:00, reminder-scan */15m)"
  );
}

async function main() {
  await startInboundWorker();
  await startOutboundWorker();
  await startAiWorker();
  await startMediaWorker();
  await startCronWorker();
  await registerSchedulers();
  // ★ Fix B（cwi-fix-20260825-f1）：worker process 訂閱 control channel —
  //   automation/workflow cache 失效唔使等 5 分鐘 TTL（panic 降級要即時生效）。
  //   subscribe 独占 connection → duplicate（同 hub.ts initControlBridge 一樣做法）。
  const controlSub = getRedis().duplicate();
  controlSub.on("error", (err) => {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "worker control subscriber error");
  });
  controlSub.subscribe(CONTROL_CHANNEL, (err) => {
    if (err) log.error({ err: err.message }, "worker control subscribe failed（cache 退回 5 分鐘 TTL）");
  });
  controlSub.on("message", (_ch, raw) => {
    try {
      const data = JSON.parse(raw) as ControlMessage;
      if (data.cmd === "cache:bust") applyCacheBust(data.scope);
      // staff:* cmd 係 web/socket 事 — worker 唔理
    } catch {
      /* bad message ignored（同 hub 語義）*/
    }
  });
  log.info({}, "all workers running — waiting for jobs");

  // 啟動首跑（fire-and-forget — 失敗只 log，*/15 cron 會再試）
  void refreshAllClinics().catch((err) => {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "worker: startup availability refresh failed");
  });
}

main().catch((err) => {
  log.fatal({ err: err instanceof Error ? (err.stack ?? err.message) : String(err) }, "worker fatal");
  process.exit(1);
});

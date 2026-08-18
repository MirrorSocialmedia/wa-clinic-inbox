/**
 * worker process 入口 — `node --import tsx dist/workers/index.js` 或直接 tsx
 *
 * 一個 process 行晒 5 個 worker（inbound/outbound/ai/cron/apricot）。
 * mock E2E 同 dev 都咁跑；production 先拆 process。
 */
import { startInboundWorker } from "./inbound.worker";
import { startOutboundWorker } from "./outbound.worker";
import { startAiWorker } from "./ai.worker";
import { startCronWorker } from "./cron.worker";
import { startApricotWorker } from "./apricot.worker";
import { cronQueue } from "@/lib/queue";
import log from "@/lib/log";

async function registerSchedulers() {
  // Phase 3 排程（BullMQ v6 upsertJobScheduler — id 冪等，重啟唔會重覆）
  await cronQueue.upsertJobScheduler("sched-sync-availability", { pattern: "*/15 * * * *" }, {
    name: "sync-availability",
    data: {},
  });
  await cronQueue.upsertJobScheduler("sched-apricot-keepalive", { pattern: "0 3 */3 * *" }, {
    name: "apricot-keepalive",
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
  await cronQueue.upsertJobScheduler("sched-quality-check", { pattern: "30 6 * * *" }, {
    name: "quality-check",
    data: {},
  });
  await cronQueue.upsertJobScheduler("sched-weekly-report", { pattern: "0 7 * * 1" }, {
    name: "weekly-report",
    data: {},
  });
  log.info(
    {},
    "cron: schedulers registered (sync-availability */15m, apricot-keepalive 3d, bookings-expire */5m, health-check */5m, quality-check daily 06:30, weekly-report Mon 07:00)"
  );
}

async function main() {
  await startInboundWorker();
  await startOutboundWorker();
  await startAiWorker();
  await startCronWorker();
  await startApricotWorker();
  await registerSchedulers();
  log.info({}, "all workers running — waiting for jobs");
}

main().catch((err) => {
  console.error("worker fatal", err);
  process.exit(1);
});

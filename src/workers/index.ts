import log from "@/lib/log";
import { closeRedis } from "@/lib/queue";
import { startInboundWorker } from "./inbound.worker";
import { startOutboundWorker } from "./outbound.worker";
import { startAiWorker } from "./ai.worker";
import { startCronWorker } from "./cron.worker";

/**
 * WA Clinic Inbox — worker process 入口（PM2 `wa-worker`）。
 *
 * 一行起晒 4 個 BullMQ worker（inbound / outbound / ai / cron）。
 * 同 web server（wa-inbox）分離 process：worker 掛咗唔影響收 webhook 秒回 200。
 */
async function main(): Promise<void> {
  const workers = [
    startInboundWorker(),
    startOutboundWorker(),
    startAiWorker(),
    startCronWorker(),
  ];
  log.info(
    { workers: workers.map((w) => w.name) },
    "all workers started"
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down workers");
    await Promise.all(workers.map((w) => w.close().catch(() => undefined)));
    await closeRedis().catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error({ err: err instanceof Error ? err.message : String(err) }, "worker bootstrap failed");
  process.exit(1);
});

/**
 * e2e-cron — 手動 enqueue 一個 cron job（E2E 用：sync-availability / bookings-expire / apricot-keepalive）
 *
 * 用法（repo root）：
 *   pnpm e2e:cron sync-availability
 *   pnpm e2e:cron bookings-expire
 *   pnpm e2e:cron apricot-keepalive
 *
 * 用同一個 shared queue（同 prefix "wa-inbox"）— job 會由跑緊嘅 worker process 食。
 */
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* 靠 process env */
}

import { cronQueue } from "../src/lib/queue";

const name = process.argv[2];
if (!name || !["sync-availability", "bookings-expire", "apricot-keepalive"].includes(name)) {
  console.error("usage: e2e-cron <sync-availability|bookings-expire|apricot-keepalive>");
  process.exit(2);
}

cronQueue
  .add(name, {}, { jobId: `e2e-${name}-${Date.now()}` })
  .then(async (job) => {
    console.log(`OK jobId=${job.id} name=${name}`);
    // ★ 共享 ioredis 連線唔會自動 close（其他 queue 仲用緊）— 顯式 exit 防 hang
    await Promise.race([
      cronQueue.close().catch(() => undefined),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
    process.exit(0);
  })
  .catch((err) => {
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });

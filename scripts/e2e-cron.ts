/**
 * e2e-cron — 手動 enqueue 一個 cron job（E2E 用）。
 *
 * 用法（repo root）：
 *   pnpm e2e:cron sync-availability
 *   pnpm e2e:cron bookings-expire
 *   pnpm e2e:cron health-check
 *   pnpm e2e:cron quality-check
 *   pnpm e2e:cron weekly-report
 *   pnpm e2e:cron retention-purge
 *   pnpm e2e:cron reminder-scan
 *   pnpm e2e:cron health-check '{"overrides":{"queueDepth":{"ai":{"waiting":150,"failed":0}},"breakerState":"open"}}'
 *
 * 第三參數（選填）= JSON job data（Phase 4：health-check overrides 注入 E2E 用）。
 * 用同一個 shared queue（同 prefix "wa-inbox"）— job 會由跑緊嘅 worker process 食。
 */
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* 靠 process env */
}

import { cronQueue } from "../src/lib/queue";

const VALID = ["sync-availability", "bookings-expire", "health-check", "quality-check", "weekly-report", "retention-purge", "reminder-scan"];
const name = process.argv[2];
const dataArg = process.argv[3];

if (!name || !VALID.includes(name)) {
  console.error(`usage: e2e-cron <${VALID.join("|")}> [json-data]`);
  process.exit(2);
}

let data: Record<string, unknown> = {};
if (dataArg) {
  try {
    data = JSON.parse(dataArg);
  } catch {
    console.error(`FAIL: 壞 JSON data: ${dataArg.slice(0, 80)}`);
    process.exit(2);
  }
}

cronQueue
  .add(name, data, { jobId: `e2e-${name}-${Date.now()}` })
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

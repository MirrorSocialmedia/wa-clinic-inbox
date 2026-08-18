/**
 * e2e-quality — 手動跑 quality_rating check（E2E T36 用）。
 *
 * 同 production cron `quality-check` 同一核心（runQualityCheck）。
 * 獨立 process 行 — 所以 `WA_MOCK_QUALITY=RED` 呢類 env inject 只影響呢個 process
 * （server/worker 完全唔受影響）。
 *
 * 用法（repo root）：
 *   pnpm e2e:quality                    # mock 預設 GREEN
 *   WA_MOCK_QUALITY=RED pnpm e2e:quality   # inject RED（E2E 用）
 */
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* 靠 process env */
}

import { runQualityCheck } from "../src/lib/quality/check";
import prisma from "../src/lib/prisma";

runQualityCheck()
  .then((result) => {
    console.log(JSON.stringify(result));
    return prisma.$disconnect();
  })
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`FAIL: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });

/**
 * e2e-control-bust — 手動發一個 control channel 訊息（E2E 用）。
 *
 * 用法（repo root）：
 *   pnpm tsx scripts/e2e-control-bust.ts automation
 *
 * 用途：raw INSERT/UPDATE 改咗 AutomationPolicy 之後（繞咗 API whitelist 403），
 * worker 嘅 in-memory level cache（5 分鐘 TTL）會 stale — 照 API route 同一個
 * publishControl({cmd:"cache:bust",scope:"automation"}) 即時失效（Fix B）。
 *
 * ★ a2 修（2026-09-07 round 4）：publishControl 係 fire-and-forget（唔 await）—
 *   原 `process.exit(0)` 會杀掉 ioredis 未 flush 嘅 PUBLISH → worker 永遠收唔到 bust
 *   （round 3 T256a 根因：pain worker log 零 automation-scope bust 記錄）。
 *   改 await getRedis().publish 確保落 Redis 先 exit。
 */
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* 靠 process env */
}

import { CONTROL_CHANNEL } from "../src/lib/notify";
import { getRedis } from "../src/lib/queue";

const scope = (process.argv[2] ?? "automation") as "automation" | "workflow" | "knowledge";
if (!["automation", "workflow", "knowledge"].includes(scope)) {
  console.error("usage: e2e-control-bust.ts <automation|workflow|knowledge>");
  process.exit(2);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`bust publish failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });

async function main() {
  const msg = JSON.stringify({ cmd: "cache:bust", scope });
  await getRedis().publish(CONTROL_CHANNEL, msg); // await = Redis ACK 先 return
  console.log(`control bust delivered: ${scope}`);
}

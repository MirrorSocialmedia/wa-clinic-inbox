/**
 * ★ Realtime P0 (R4, cwi-rt-20260823-a1) — per-conversation ordering drift guard。
 *
 * 斷言：
 * 1. concurrency.ts 常數：inbound/outbound/ai = 1、media = 3
 * 2. 三個 worker 嘅 Worker options 真用咗常數（唔係硬編碼數字）
 * 3. 三個 worker 檔無任何 `concurrency: <number>` 硬編碼
 *
 * 失敗 → exit 1（CI 紅）。用途：防止有人手癢調大 concurrency 打破 per-conversation 順序。
 * 跑法：pnpm test:ordering
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");

import { INBOUND_CONCURRENCY, OUTBOUND_CONCURRENCY, AI_CONCURRENCY, MEDIA_CONCURRENCY } from "../src/workers/concurrency.js";

let failures = 0;
function check(cond: boolean, label: string, detail?: string): void {
  if (cond) {
    console.log(`  ✅ ${label}`);
  } else {
    failures++;
    console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("ordering-drift-guard (R4): 驗證 per-conversation ordering 唔被 break");

// 1) 常數值
check(INBOUND_CONCURRENCY === 1, "INBOUND_CONCURRENCY = 1", `actual=${INBOUND_CONCURRENCY}`);
check(OUTBOUND_CONCURRENCY === 1, "OUTBOUND_CONCURRENCY = 1", `actual=${OUTBOUND_CONCURRENCY}`);
check(AI_CONCURRENCY === 1, "AI_CONCURRENCY = 1", `actual=${AI_CONCURRENCY}`);
check(MEDIA_CONCURRENCY === 3, "MEDIA_CONCURRENCY = 3（media 無順序依賴，固定 3）", `actual=${MEDIA_CONCURRENCY}`);

// 2) worker 檔真的用常數
const workers: Array<[string, string]> = [
  ["src/workers/inbound.worker.ts", "INBOUND_CONCURRENCY"],
  ["src/workers/outbound.worker.ts", "OUTBOUND_CONCURRENCY"],
  ["src/workers/ai.worker.ts", "AI_CONCURRENCY"],
];
for (const [file, constName] of workers) {
  const src = readFileSync(path.join(ROOT, file), "utf8");
  check(src.includes(`from "./concurrency"`), `${file}: import from ./concurrency`);
  check(
    new RegExp(`concurrency:\\s*${constName}\\b`).test(src),
    `${file}: Worker options 用 ${constName}`
  );
  check(
    !/concurrency:\s*\d+/.test(src),
    `${file}: 無硬編碼 concurrency: <number>`
  );
}
// media worker 用常數（允許調 — 但唔准消失）
const mediaSrc = readFileSync(path.join(ROOT, "src/workers/media.worker.ts"), "utf8");
check(/concurrency:\s*MEDIA_CONCURRENCY\b/.test(mediaSrc), "media.worker.ts: Worker options 用 MEDIA_CONCURRENCY");

if (failures > 0) {
  console.error(`\nORDERING-DRIFT FAIL（${failures} 項）— per-conversation ordering 可能被 break，見 realtime MD R4/R8`);
  process.exit(1);
}
console.log("\nORDERING-DRIFT OK — inbound/outbound/ai concurrency 全部 = 1");

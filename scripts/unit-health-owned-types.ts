/**
 * ★ cwi-final S1-1a — unit：grep check.ts 所有 `type: "..."` breach 字面量 ⊆ HEALTH_OWNED_TYPES。
 *
 * 目的：check.ts 加新 breach type 漏咗入 HEALTH_OWNED_TYPES → 該 type 會被 health-check
 * 自動 resolve（R-28 破）。呢個 test 纯 fs + 集合比較（無 DB / 無 Redis），秒殺。
 *
 * 跑法：pnpm test:unit-health-owned-types
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HEALTH_OWNED_TYPES } from "../src/lib/health/alerts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(path.join(root, "src/lib/health/check.ts"), "utf8");

const types = [...new Set([...src.matchAll(/type:\s*"([^"]+)"/g)].map((m) => m[1]))];

if (types.length === 0) {
  console.error("❌ check.ts 搵唔到任何 `type: \"...\"` 字面量 — grep pattern 可能漂移，檢查 check.ts");
  process.exit(1);
}

let failures = 0;
for (const t of types) {
  const ok = HEALTH_OWNED_TYPES.has(t);
  console.log(`${ok ? "✅" : "❌"} check.ts breach type "${t}" ${ok ? "∈" : "∉"} HEALTH_OWNED_TYPES`);
  if (!ok) failures++;
}

if (failures > 0) {
  console.error(`unit-health-owned-types FAIL: ${failures} 個 breach type 漏入 HEALTH_OWNED_TYPES`);
  process.exit(1);
}
console.log(`unit-health-owned-types OK（${types.length} 個 breach type 全喺 HEALTH_OWNED_TYPES）`);
process.exit(0);

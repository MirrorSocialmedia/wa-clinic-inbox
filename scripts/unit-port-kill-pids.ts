/**
 * unit-port-kill-pids — cwi-labdoc-followup m-7（hermetic — 零 DB / 零網絡 / 唔起 server）。
 *
 * 施工單規格（labdoc-w-followup m-7）：`pkill -f " server.ts"` pattern kill → port-scoped
 * kill-by-PID（`lsof -ti:<port> -sTCP:LISTEN` → 得 PID → kill 嗰啲 PID；冇 listener = no-op）。
 * e2e script 本身禁止本地跑（top-level 自跑 main），parse 邏輯抽成純函數
 * `scripts/_listen-pids.ts#parseListenPids` → 呢度 unit 驗證。
 *
 * 斷言：
 *   1. 正常 lsof 輸出（一行一個 PID）→ 正確 pid 列表
 *   2. 多行 / 尾隨空行 / 混合空白 → 正確
 *   3. 空輸入 = 冇 listener → []（no-op 語義）
 *   4. 異常字元（lsof 錯誤訊息混入 stdout）→ filter 掉、唔 throw（caller best-effort 語義）
 *   5. 0 / 負數 / 非整數 → filter 掉（kill(0) = 打自己 process group — 危險，必 filter）
 *
 * 跑法（repo root）：pnpm tsx scripts/unit-port-kill-pids.ts
 * 退出碼：0 = 全過；1 = 有 fail
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseListenPids } from "./_listen-pids";

test("正常 lsof 輸出（一行一個 PID）", () => {
  assert.deepEqual(parseListenPids("12345\n67890\n"), [12345, 67890]);
  assert.deepEqual(parseListenPids("12345"), [12345]);
});

test("尾隨空行 / 混合空白（space + tab + CRLF）", () => {
  assert.deepEqual(parseListenPids("12345\n\n67890\n"), [12345, 67890]);
  assert.deepEqual(parseListenPids("  12345 \t 67890 \r\n"), [12345, 67890]);
});

test("空輸入 = 冇 listener → []（no-op 語義）", () => {
  assert.deepEqual(parseListenPids(""), []);
  assert.deepEqual(parseListenPids("   \n  \n"), []);
});

test("異常字元混入 → filter 掉、唔 throw", () => {
  // lsof 無權限 / 命令錯誤時 stdout 可能混入文字
  assert.deepEqual(parseListenPids("12345\nwarning: some thing\n67890\n"), [12345, 67890]);
  assert.deepEqual(parseListenPids("PID 12345\n"), [12345]);
});

test("0 / 負數 / 非整數 → filter 掉（kill(0) 會打自己 process group — 危險）", () => {
  assert.deepEqual(parseListenPids("0\n-1\n1.5\n12345\n"), [12345]);
});

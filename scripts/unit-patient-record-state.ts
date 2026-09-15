/**
 * unit-patient-record-state — cwi-followup-p2-20260915（MD §3.1b 五態狀態機）
 *
 * 範圍：
 *   S1 baseSyncState：<1h fresh / 1–24h normal / >24h stale / null none（邊界點）
 *   S2 syncDisplay：五態文案（更新中 / 剛更新 / 正常 / 滯後 / 失敗含 lastSyncedAt）
 *   S3 refreshButton：cooldown 倒數 / rate_limited / failed 重試 / 各態 label
 *   S4 純函數確定性（同輸入同輸出 — 零 I/O）
 *
 * 用法（repo root）：pnpm tsx scripts/unit-patient-record-state.ts
 * 退出碼：0 = 全過；1 = 有 fail。
 */

import {
  baseSyncState,
  syncDisplay,
  refreshButton,
  fmtSyncAt,
  fmtDateShort,
  fmtAmt,
  FRESH_MS,
  STALE_MS,
  REFRESH_COOLDOWN_MS,
  type RefreshPhase,
} from "../src/lib/patient-record-state";

let passes = 0;
let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passes++;
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const NOW = Date.parse("2026-09-15T12:00:00+08:00");
const iso = (ms: number) => new Date(ms).toISOString();

const IDLE: RefreshPhase = { kind: "idle" };

console.log("── S1 baseSyncState 三態 + none ──");
check("fresh：30 分鐘前 → fresh", baseSyncState(iso(NOW - 30 * 60_000), NOW) === "fresh");
check("fresh 邊界：<1h（FRESH_MS-1s）", baseSyncState(iso(NOW - (FRESH_MS - 1000)), NOW) === "fresh");
check("normal 邊界：=1h → normal", baseSyncState(iso(NOW - FRESH_MS), NOW) === "normal");
check("normal：5h → normal", baseSyncState(iso(NOW - 5 * 3600_000), NOW) === "normal");
check("normal 邊界：=24h → normal", baseSyncState(iso(NOW - STALE_MS), NOW) === "normal");
check("stale 邊界：24h+1s → stale", baseSyncState(iso(NOW - (STALE_MS + 1000)), NOW) === "stale");
check("stale：49h → stale", baseSyncState(iso(NOW - 49 * 3600_000), NOW) === "stale");
check("none：syncedAt=null", baseSyncState(null, NOW) === "none");
check("none：壞 ISO", baseSyncState("not-a-date", NOW) === "none");

console.log("── S2 syncDisplay 五態 ──");
check("更新中：spinner 文案", syncDisplay("normal", iso(NOW - 5 * 3600_000), { kind: "refreshing", silent: false }, NOW).text === "更新緊…（由 Apricot 取最新）");
{
  const d = syncDisplay("fresh", iso(NOW - 30 * 60_000), IDLE, NOW);
  check("剛更新：綠 + 時間", d.tone === "green" && d.text.startsWith("● 剛剛更新（") && d.text.includes("11:30"));
  const d2 = syncDisplay("normal", iso(NOW - 5 * 3600_000), IDLE, NOW);
  check("正常：灰 + 資料截至", d2.tone === "gray" && d2.text.startsWith("資料截至"));
  const d3 = syncDisplay("stale", iso(NOW - 49 * 3600_000), IDLE, NOW);
  check("滯後：黃 + ⚠", d3.tone === "yellow" && d3.text.includes("⚠") && d3.text.includes("資料可能滯後"));
  const d4 = syncDisplay("stale", iso(NOW - 49 * 3600_000), { kind: "failed" }, NOW);
  check("失敗：Apricot 未接通 + 舊資料日期", d4.tone === "red" && d4.text.includes("Apricot 未接通") && d4.text.includes("顯示緊"));
  const d5 = syncDisplay("none", null, { kind: "failed" }, NOW);
  check("失敗無 syncedAt：唔話顯示緊（唔扮有舊資料）", d5.tone === "red" && !d5.text.includes("顯示緊"));
  const d6 = syncDisplay("normal", iso(NOW - 5 * 3600_000), { kind: "rate_limited", readyAt: NOW + 37_000, retryAfterSec: 37 }, NOW);
  check("rate_limited：倒數文案", d6.tone === "yellow" && d6.text.includes("37s"));
}

console.log("── S3 refreshButton ──");
check("更新中 → disable", refreshButton("normal", { kind: "refreshing", silent: true }, NOW).disabled === true);
{
  const b1 = refreshButton("fresh", { kind: "cooldown", readyAt: NOW + 42_000 }, NOW);
  check("cooldown：倒數 + disable", b1.disabled && b1.label === "42s 後可再更新");
  check("cooldown 歸零 → disable（0s）", refreshButton("fresh", { kind: "cooldown", readyAt: NOW }, NOW).disabled === true);
  check("rate_limited → disable", refreshButton("normal", { kind: "rate_limited", readyAt: NOW + 37_000, retryAfterSec: 37 }, NOW).disabled === true);
  check("failed → 重試", refreshButton("stale", { kind: "failed" }, NOW).label === "重試");
  check("stale → 立即更新", refreshButton("stale", IDLE, NOW).label === "立即更新");
  check("cooldown 時長 = 60s（§2.8 同口徑）", REFRESH_COOLDOWN_MS === 60_000);
}

console.log("── S4 格式化 ──");
check("fmtSyncAt：MM/DD HH:mm（HK）", fmtSyncAt(iso(NOW)) === "09/15 12:00");
check("fmtSyncAt：null → —", fmtSyncAt(null) === "—");
check("fmtDateShort：09/14", fmtDateShort("2026-09-14") === "09/14");
check("fmtDateShort：null → 空", fmtDateShort(null) === "");
check("fmtAmt：16200 → $16,200", fmtAmt(16200) === "$16,200");
check("fmtAmt：0 → $0", fmtAmt(0) === "$0");
check("fmtAmt：null → —", fmtAmt(null) === "—");
check("純函數確定性：同輸入同輸出", JSON.stringify(syncDisplay("stale", iso(NOW - 49 * 3600_000), { kind: "failed" }, NOW)) === JSON.stringify(syncDisplay("stale", iso(NOW - 49 * 3600_000), { kind: "failed" }, NOW)));

console.log(`\nunit-patient-record-state: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);

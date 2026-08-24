/**
 * unit-reminder — Phase B（cwi-tmpl-20260824-b1）T-24h 提醒窗口 pure unit tests
 *
 * 範圍（零 DB / 零網絡 — 只 pure 邏輯）：
 *   1. hkApptEpochMs — HK（UTC+8 固定）開診時刻 → epoch ms
 *   2. inReminderWindow — 23–25h 窗口邊界（含端點）
 *   3. HK 日界 — 「聽日 09:00 單 + 22:00 掃」唔喺窗口（11h < 23h）；
 *                 「聽日 09:00 單 + 10:00 掃」啱落窗口下邊界（=23h）
 *
 * 用法（repo root）：pnpm test:unit-reminder
 * 退出碼：0 = 全過；1 = 有 fail
 *
 * 註：import reminder.ts 會構造 PrismaClient（零連接 — 只 pure function 被 call）
 */
import { hkApptEpochMs, inReminderWindow } from "../src/lib/booking/reminder";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const H = 3_600_000;

console.log("[1] hkApptEpochMs — HK 固定 UTC+8");
{
  // 2026-08-25T09:00+08:00 = 2026-08-25T01:00:00Z
  const t = hkApptEpochMs("2026-08-25", "09:00");
  const expect = new Date("2026-08-25T01:00:00Z").getTime();
  check("09:00 HK = 01:00 UTC", t === expect, `diff ${t - expect}ms`);
  // 中夜：2026-08-25T23:30+08:00 = 15:30 UTC
  const t2 = hkApptEpochMs("2026-08-25", "23:30");
  const expect2 = new Date("2026-08-25T15:30:00Z").getTime();
  check("23:30 HK = 15:30 UTC", t2 === expect2);
}

console.log("[2] inReminderWindow — 23–25h 邊界");
{
  const now = new Date("2026-08-24T10:00:00+08:00").getTime();
  check("now+24h → 窗口內", inReminderWindow(now + 24 * H, now, 23, 25));
  check("now+22h → 窗口外（太近）", !inReminderWindow(now + 22 * H, now, 23, 25));
  check("now+26h → 窗口外（太遠）", !inReminderWindow(now + 26 * H, now, 23, 25));
  check("now+23h 整點 → 窗口內（含下邊界 >=）", inReminderWindow(now + 23 * H, now, 23, 25));
  check("now+25h 整點 → 窗口內（含上邊界 <=）", inReminderWindow(now + 25 * H, now, 23, 25));
  check("now+22h59m59s → 窗口外", !inReminderWindow(now + 23 * H - 1, now, 23, 25));
  check("now+25h+1s → 窗口外", !inReminderWindow(now + 25 * H + 1, now, 23, 25));
  // 自訂窗口（env 化後嘅極端值）
  check("自訂 0–1h 窗口", inReminderWindow(now + 30 * 60_000, now, 0, 1) && !inReminderWindow(now + 2 * H, now, 0, 1));
}

console.log("[3] HK 日界");
{
  // 聽日 09:00 HK 開診
  const appt = hkApptEpochMs("2026-08-25", "09:00");
  const scan2200 = new Date("2026-08-24T22:00:00+08:00").getTime(); // 22:00 掃 → 距 11h
  const scan1000 = new Date("2026-08-24T10:00:00+08:00").getTime(); // 10:00 掃 → 距 23h
  check("22:00 掃 → 聽日 09:00 單唔喺窗口（11h < 23h）", !inReminderWindow(appt, scan2200, 23, 25));
  check("10:00 掃 → 聽日 09:00 單啱落下邊界（=23h）", inReminderWindow(appt, scan1000, 23, 25));
  // 日界方向：08:30 HK 開診單 — 22:00 掃（距 10.5h）唔到；08:55 掃（距 23h55m）超過上邊界
  const appt2 = hkApptEpochMs("2026-08-25", "08:30");
  const scan0855 = new Date("2026-08-24T08:55:00+08:00").getTime();
  check("08:30 單 + 08:55 掃 → 23.6h 內窗口", inReminderWindow(appt2, scan0855, 23, 25));
}

if (failures > 0) {
  console.error(`\nUNIT FAIL ❌（${failures} 項）`);
  process.exit(1);
}
console.log("\nUNIT PASS ✅（reminder unit）");

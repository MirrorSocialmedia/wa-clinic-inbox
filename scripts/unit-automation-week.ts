/**
 * unit-automation-week — Phase E（cwi-ai-20260825-t5）hkWeekStart / weekRangeUtc / lastFourCompleteWeeks 邊界
 *
 * 範圍（pure — 零 DB / 零網絡）：
 *   1. HK 週日 23:59:59 → 本週週一（唔跳新週）
 *   2. HK 週一 00:00:00 → 新週週一（日界）
 *   3. UTC 跨日（HK 凌晨 = UTC 前一日 16:00–23:59；HK 08:00 = UTC 當日 00:00）
 *   4. 月界 / 年界
 *   5. weekRangeUtc = 7 日；lastFourCompleteWeeks = 4 個週一升序
 *
 * 用法（repo root）：pnpm tsx scripts/unit-automation-week.ts
 * 退出碼：0 = 全過；1 = 有 fail
 */
import { hkWeekStart, weekRangeUtc, lastFourCompleteWeeks } from "../src/lib/ops/automation-stats";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// 2026-08-25 = 星期二（任務日）→ 本週週一 = 2026-08-24；上週 = 2026-08-17
console.log("[1] HK 週日 23:59:59 → 本週週一（唔跳新週）");
{
  // 2026-08-23 = 週日
  check("週日 23:59:59 HK", hkWeekStart(new Date("2026-08-23T23:59:59+08:00")) === "2026-08-17", hkWeekStart(new Date("2026-08-23T23:59:59+08:00")));
  check("週日 12:00 HK", hkWeekStart(new Date("2026-08-23T12:00:00+08:00")) === "2026-08-17");
}

console.log("[2] HK 週一 00:00:00 → 新週");
{
  check("週一 00:00:00 HK", hkWeekStart(new Date("2026-08-24T00:00:00+08:00")) === "2026-08-24", hkWeekStart(new Date("2026-08-24T00:00:00+08:00")));
  check("週一 00:00:01 HK", hkWeekStart(new Date("2026-08-24T00:00:01+08:00")) === "2026-08-24");
  check("週一 00:00:00 前 1 秒（= 週日）", hkWeekStart(new Date("2026-08-23T23:59:59.999+08:00")) === "2026-08-17");
}

console.log("[3] UTC 跨日（HK 固定 UTC+8）");
{
  // HK 週一 00:30 = UTC 週日 16:30（UTC 還喺上週）
  check("HK 週一 00:30 = UTC 前日 16:30", hkWeekStart(new Date("2026-08-23T16:30:00Z")) === "2026-08-24");
  // HK 週一 07:59 = UTC 前日 23:59
  check("HK 週一 07:59 = UTC 前日 23:59", hkWeekStart(new Date("2026-08-23T23:59:00Z")) === "2026-08-24");
  // HK 週一 08:00 = UTC 當日 00:00（UTC 跳入新日）
  check("HK 週一 08:00 = UTC 當日 00:00", hkWeekStart(new Date("2026-08-24T00:00:00Z")) === "2026-08-24");
  // 星期二（任務日）
  check("HK 2026-08-25（二）→ 週一 08-24", hkWeekStart(new Date("2026-08-25T12:00:00+08:00")) === "2026-08-24");
}

console.log("[4] 月界 / 年界");
{
  // 2026-08-31 = 週一；2026-09-01 = 星期二
  check("跨月：HK 2026-09-01（二）→ 2026-08-31", hkWeekStart(new Date("2026-09-01T10:00:00+08:00")) === "2026-08-31", hkWeekStart(new Date("2026-09-01T10:00:00+08:00")));
  // 2026-12-28 = 週一（8/24 + 22 週）；2027-01-01 = 星期五
  check("跨年：HK 2027-01-01（五）→ 2026-12-28", hkWeekStart(new Date("2027-01-01T09:00:00+08:00")) === "2026-12-28", hkWeekStart(new Date("2027-01-01T09:00:00+08:00")));
}

console.log("[5] weekRangeUtc + lastFourCompleteWeeks");
{
  const [lo, hi] = weekRangeUtc("2026-08-24");
  check("週一 00:00 HK = 前日 16:00 UTC", lo.toISOString() === "2026-08-23T16:00:00.000Z", lo.toISOString());
  check("範圍 = 7 日", hi.getTime() - lo.getTime() === 7 * 86_400_000);
  // now = 2026-08-25（本週 = 08-24 起）→ 四個完整週 = 08-17 / 08-10 / 08-03 / 07-27（升序）
  const weeks = lastFourCompleteWeeks(new Date("2026-08-25T12:00:00+08:00"));
  check("四完整週升序", JSON.stringify(weeks) === JSON.stringify(["2026-07-27", "2026-08-03", "2026-08-10", "2026-08-17"]), JSON.stringify(weeks));
  // 週一 05:00（cron 時刻）— 本週 08-24 未完成，窗口唔變
  const weeksMon = lastFourCompleteWeeks(new Date("2026-08-24T05:00:00+08:00"));
  check("週一 05:00 跑 → 同上四週", JSON.stringify(weeksMon) === JSON.stringify(["2026-07-27", "2026-08-03", "2026-08-10", "2026-08-17"]), JSON.stringify(weeksMon));
}

console.log(failures === 0 ? "\n✅ unit-automation-week 全過" : `\n❌ ${failures} 個 fail`);
process.exit(failures === 0 ? 0 : 1);

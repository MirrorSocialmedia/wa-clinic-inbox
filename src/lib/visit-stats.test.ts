/**
 * ★ cwi-ux UX-07 T-UX07i（unit）：computeVisitStats 口徑
 *
 * 運行：npx tsx --test src/lib/visit-stats.test.ts（純函數 — 零 DB/Redis）
 *
 * 口徑（spec §7.3 病人記錄）：
 *   - 只數真到診（1 已到診 / 4 已完成）；爽約 -3 / 已約未到 0 / 改期 102 唔計
 *   - 窗口 = 近 12 個月（365 日，YYYY-MM-DD 字串比較）
 *   - 主診 = 次數最多（平手 → 最近一次較後 → code 升序，決定性）
 *   - lastClinicCode = 主診最近一次為呢位病人當值嘅店
 *   - 無可數行 = null（UI 唔顯示）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeVisitStats, windowCutoff, type VisitStatRow } from "./visit-stats";

const TODAY = "2026-10-01";

function row(p: Partial<VisitStatRow>): VisitStatRow {
  return {
    visitDate: "2026-09-14",
    clinicCode: "TY",
    providerCode: "DR1",
    providerName: "黃醫生",
    bookingStatus: 4,
    ...p,
  };
}

test("T-UX07i: 真到診計入（1 / 4）", () => {
  const s = computeVisitStats(
    [
      row({ visitDate: "2026-09-14", bookingStatus: 4 }),
      row({ visitDate: "2026-08-01", bookingStatus: 1 }),
    ],
    TODAY
  );
  assert.ok(s);
  assert.equal(s.totalVisits12m, 2);
});

test("T-UX07i: 爽約 -3 / 已約未到 0 / 改期 102 唔計", () => {
  const s = computeVisitStats(
    [
      row({ visitDate: "2026-09-14", bookingStatus: -3 }),
      row({ visitDate: "2026-09-10", bookingStatus: 0 }),
      row({ visitDate: "2026-09-05", bookingStatus: 102 }),
    ],
    TODAY
  );
  assert.equal(s, null, "無真到診 → null（UI 唔顯示）");
});

test("T-UX07i: 超過 12 個月嘅到診唔計", () => {
  const s = computeVisitStats(
    [
      row({ visitDate: "2025-09-01" }), // 13 個月前
      row({ visitDate: windowCutoff(TODAY) }), // 剛好 365 日前（邊界 — 計入）
    ],
    TODAY
  );
  assert.ok(s);
  assert.equal(s.totalVisits12m, 1);
  assert.equal(s.latestVisit?.date, windowCutoff(TODAY));
});

test("T-UX07i: 主診 = 次數最多（5/6 口徑）", () => {
  const s = computeVisitStats(
    [
      row({ visitDate: "2026-09-01", providerCode: "DR1", clinicCode: "TY" }),
      row({ visitDate: "2026-08-01", providerCode: "DR1", clinicCode: "YL" }),
      row({ visitDate: "2026-07-01", providerCode: "DR1", clinicCode: "YL" }),
      row({ visitDate: "2026-06-01", providerCode: "DR1", clinicCode: "TKW" }),
      row({ visitDate: "2026-05-01", providerCode: "DR1", clinicCode: "TKW" }),
      row({ visitDate: "2026-04-01", providerCode: "DR2", clinicCode: "TY" }),
    ],
    TODAY
  );
  assert.ok(s);
  assert.equal(s.totalVisits12m, 6);
  assert.equal(s.primaryDoctor?.providerCode, "DR1");
  assert.equal(s.primaryDoctor?.count, 5);
  // lastClinicCode = DR1 最近一次（2026-09-01）嘅店
  assert.equal(s.primaryDoctor?.lastClinicCode, "TY");
  assert.equal(s.primaryDoctor?.lastVisitDate, "2026-09-01");
});

test("T-UX07i: 平手 → 最近一次較後者；再平手 → code 升序", () => {
  // 都係 2 次：DR2 最近（09-10）勝 DR1（09-01）
  let s = computeVisitStats(
    [
      row({ visitDate: "2026-09-10", providerCode: "DR2" }),
      row({ visitDate: "2026-08-10", providerCode: "DR2" }),
      row({ visitDate: "2026-09-01", providerCode: "DR1" }),
      row({ visitDate: "2026-07-01", providerCode: "DR1" }),
    ],
    TODAY
  );
  assert.equal(s?.primaryDoctor?.providerCode, "DR2");
  // 都係 2 次、最近日期同（唔可能同 provider 同日兩條入 byProvider — 用同日 1 條 + code 平手唔會發生；
  //   故 code 升序只喺「同數 + 同最近日」— 直接驗 lastDate 相同嘅情況）
  s = computeVisitStats(
    [
      row({ visitDate: "2026-09-01", providerCode: "DRB", clinicCode: "B" }),
      row({ visitDate: "2026-09-01", providerCode: "DRA", clinicCode: "A" }),
    ],
    TODAY
  );
  assert.equal(s?.primaryDoctor?.providerCode, "DRA", "再平手 → code 升序（決定性）");
});

test("T-UX07i: providerCode null 唔歸屬（計 total 唔計主診）", () => {
  const s = computeVisitStats(
    [
      row({ providerCode: null, providerName: null }),
      row({ visitDate: "2026-09-10", providerCode: "DR1" }),
    ],
    TODAY
  );
  assert.ok(s);
  assert.equal(s.totalVisits12m, 2);
  assert.equal(s.primaryDoctor?.providerCode, "DR1");
  assert.equal(s.primaryDoctor?.count, 1);
});

test("T-UX07i: 全數 providerCode null → primaryDoctor null（latestVisit 照有）", () => {
  const s = computeVisitStats([row({ providerCode: null, providerName: null })], TODAY);
  assert.ok(s);
  assert.equal(s.primaryDoctor, null);
  assert.ok(s.latestVisit);
});

test("T-UX07i: 空陣列 / 全數窗口外 → null", () => {
  assert.equal(computeVisitStats([], TODAY), null);
  assert.equal(
    computeVisitStats([row({ visitDate: "2024-01-01" })], TODAY),
    null,
    "全部超窗 → null"
  );
});

test("T-UX07i: latestVisit = 最近一次真到診（唔係主診嘅）", () => {
  const s = computeVisitStats(
    [
      row({ visitDate: "2026-09-20", providerCode: "DR2", clinicCode: "WTC" }),
      row({ visitDate: "2026-09-01", providerCode: "DR1", clinicCode: "TY" }),
      row({ visitDate: "2026-08-01", providerCode: "DR1", clinicCode: "TY" }),
    ],
    TODAY
  );
  assert.equal(s?.latestVisit?.date, "2026-09-20");
  assert.equal(s?.latestVisit?.clinicCode, "WTC");
  assert.equal(s?.latestVisit?.providerName, "黃醫生");
});

test("windowCutoff: 365 日（HK 日界）", () => {
  assert.equal(windowCutoff("2026-10-01"), "2025-10-01");
  assert.equal(windowCutoff("2026-02-28"), "2025-02-28"); // 非閏年（2025）→ 對返 2/28
  assert.equal(windowCutoff("2026-03-01"), "2025-03-01"); // 2/29 存在（2025-03-01→2026-03-01 含 2026-02-28… 驗 setDate 歸一化）
});

/**
 * 收件箱銷售意向篩選 + 排序 — 含對抗式輸入。
 * 運行：npx tsx --test src/lib/inbox/sales-sort.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { daysLeft, expiryKey, filterByIntent, intentCounts, parseIntentFilter, parseSalesSort, salesCompare } from "./sales-sort";

type R = Parameters<typeof salesCompare>[0] & { id: string };
const r = (id: string, intent: R["salesIntent"], t: string, sales: R["sales"] = null): R => ({ id, salesIntent: intent, lastMessageAt: t, sales });
const P = (until: string | null) => ({ state: "PROTECTED" as const, ownerName: "A", mine: true, protectedUntil: until });
const B = { state: "BOUND" as const, ownerName: "A", mine: true, protectedUntil: null };

test("SS1 意向排序：高 → 中 → 低 → 未設；同級最新訊息先", () => {
  const list = [
    r("none", null, "2026-11-04T10:00:00Z"),
    r("low", "LOW", "2026-11-04T09:00:00Z"),
    r("hi-old", "HIGH", "2026-11-01T00:00:00Z"),
    r("mid", "MEDIUM", "2026-11-04T08:00:00Z"),
    r("hi-new", "HIGH", "2026-11-03T00:00:00Z"),
  ];
  assert.deepEqual([...list].sort((a, b) => salesCompare(a, b, "intent")).map((x) => x.id), ["hi-new", "hi-old", "mid", "low", "none"]);
});

test("SS2 到期排序：保護中最早到期先；綁定／冇人負責排後", () => {
  const list = [
    r("bound", "HIGH", "2026-11-04T10:00:00Z", B),
    r("p-late", null, "2026-11-04T09:00:00Z", P("2026-11-20T00:00:00Z")),
    r("none", "HIGH", "2026-11-04T11:00:00Z"),
    r("p-soon", null, "2026-11-01T00:00:00Z", P("2026-11-06T00:00:00Z")),
  ];
  assert.deepEqual([...list].sort((a, b) => salesCompare(a, b, "expiry")).map((x) => x.id), ["p-soon", "p-late", "none", "bound"]);
});

test("SS3 recent = 0（唔改原本排序）", () => {
  assert.equal(salesCompare(r("a", "HIGH", "2026-11-01T00:00:00Z"), r("b", "LOW", "2026-11-04T00:00:00Z"), "recent"), 0);
});

test("SS4 篩選 + 計數：篩選前計數；ALL 唔篩", () => {
  const list = [r("a", "HIGH", "x"), r("b", "HIGH", "x"), r("c", "LOW", "x"), r("d", null, "x")];
  assert.deepEqual(intentCounts(list), { HIGH: 2, MEDIUM: 0, LOW: 1 });
  assert.deepEqual(filterByIntent(list, "HIGH").map((x) => x.id), ["a", "b"]);
  assert.equal(filterByIntent(list, "ALL").length, 4);
  assert.equal(filterByIntent(list, "MEDIUM").length, 0);
});

test("SS5 對抗：localStorage 爛值 → 預設；壞日期唔炸", () => {
  assert.equal(parseIntentFilter("DROP TABLE"), "ALL");
  assert.equal(parseIntentFilter(null), "ALL");
  assert.equal(parseSalesSort({}), "recent");
  assert.equal(parseSalesSort("intent"), "intent");
  assert.equal(expiryKey(r("x", null, "x", P("not-a-date"))), Number.POSITIVE_INFINITY);
  assert.equal(expiryKey(r("x", null, "x", P(null))), Number.POSITIVE_INFINITY);
  // 怪意向值（舊資料）當未設
  const weird = { ...r("w", null, "2026-11-04T00:00:00Z"), salesIntent: "URGENT" as unknown as "HIGH" };
  assert.equal(salesCompare(weird, r("n", null, "2026-11-04T00:00:00Z"), "intent"), 0);
  assert.deepEqual(intentCounts([weird]), { HIGH: 0, MEDIUM: 0, LOW: 0 });
});

test("SS6 剩幾日：向上取整、過咗 = 0、壞值 null", () => {
  const now = Date.parse("2026-11-04T00:00:00Z");
  assert.equal(daysLeft("2026-11-04T12:00:00Z", now), 1);
  assert.equal(daysLeft("2026-11-09T00:00:00Z", now), 5);
  assert.equal(daysLeft("2026-11-01T00:00:00Z", now), 0);
  assert.equal(daysLeft("bad", now), null);
  assert.equal(daysLeft(null, now), null);
});

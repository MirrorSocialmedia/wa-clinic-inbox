/**
 * 收件箱列表：銷售意向篩選 + 排序（純 function — client 列表用，unit test 覆蓋）。
 *
 * - 疊加喺任何膠囊（全部／未指派／派俾我／我負責／待跟進）之後先做
 * - 急症照舊永遠排頂、已解決照舊排尾（呢度只決定同一級入面嘅次序）
 * - recent = 唔改變現有排序（caller 用返原本邏輯）
 */
import type { ConversationItem } from "@/components/inbox/types";

export type IntentFilter = "ALL" | "HIGH" | "MEDIUM" | "LOW";
export type SalesSort = "recent" | "intent" | "expiry";

export const INTENT_FILTERS: IntentFilter[] = ["ALL", "HIGH", "MEDIUM", "LOW"];
export const SALES_SORTS: SalesSort[] = ["recent", "intent", "expiry"];

export const SALES_SORT_TEXT: Record<SalesSort, string> = {
  recent: "最新訊息",
  intent: "意向高 → 低",
  expiry: "保護期就到期先",
};

type Row = Pick<ConversationItem, "salesIntent" | "sales" | "lastMessageAt">;

const INTENT_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

export function intentRank(r: Row): number {
  return r.salesIntent ? (INTENT_RANK[r.salesIntent] ?? 3) : 3;
}

/** 保護中先、最早到期最前；綁定／冇人負責排後 */
export function expiryKey(r: Row): number {
  if (r.sales?.state !== "PROTECTED" || !r.sales.protectedUntil) return Number.POSITIVE_INFINITY;
  const t = new Date(r.sales.protectedUntil).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

export function intentCounts(list: Row[]): Record<"HIGH" | "MEDIUM" | "LOW", number> {
  const c = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const r of list) if (r.salesIntent && r.salesIntent in c) c[r.salesIntent as keyof typeof c]++;
  return c;
}

export function filterByIntent<T extends Row>(list: T[], f: IntentFilter): T[] {
  return f === "ALL" ? list : list.filter((r) => r.salesIntent === f);
}

/**
 * 同一級（急症／一般／已解決）入面嘅銷售排序；recent → 0（caller 用返原本排序）。
 * 同意向／同到期 → 最新訊息先（穩定、可預測）。
 */
export function salesCompare(a: Row, b: Row, sort: SalesSort): number {
  if (sort === "recent") return 0;
  if (sort === "intent") {
    const d = intentRank(a) - intentRank(b);
    if (d !== 0) return d;
  } else {
    const ea = expiryKey(a);
    const eb = expiryKey(b);
    if (ea !== eb) return ea < eb ? -1 : 1;
  }
  return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime();
}

export function parseIntentFilter(v: unknown): IntentFilter {
  return INTENT_FILTERS.includes(v as IntentFilter) ? (v as IntentFilter) : "ALL";
}
export function parseSalesSort(v: unknown): SalesSort {
  return SALES_SORTS.includes(v as SalesSort) ? (v as SalesSort) : "recent";
}

/** 保護期剩幾日（向上取整；過咗 = 0） */
export function daysLeft(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.ceil((t - now) / 86_400_000));
}

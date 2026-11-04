"use client";

/**
 * 收件箱列表：銷售意向篩選 + 排序（只係銷售帳號先 render）。
 * - 桌面：膠囊下面一行「意向：全部／高／中／低」+ 排序下拉
 * - 窄屏（手機）：一粒「⇅ 意向・排序」掣 → 底部彈出選單；揀咗篩選喺掣旁邊顯示可以 ✕ 嘅提示
 * - 設定記住喺部機（localStorage；讀寫失敗 = 用預設，唔阻列表）
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowUpDown, X } from "lucide-react";
import {
  INTENT_FILTERS,
  SALES_SORTS,
  SALES_SORT_TEXT,
  daysLeft,
  parseIntentFilter,
  parseSalesSort,
  type IntentFilter,
  type SalesSort,
} from "@/lib/inbox/sales-sort";
import type { ConversationItem } from "./types";

const PREF_KEY = "wa:inbox:sales-list";

export const INTENT_CHIP: Record<"HIGH" | "MEDIUM" | "LOW", { short: string; long: string; cls: string }> = {
  HIGH: { short: "高", long: "意向高", cls: "bg-danger-soft text-danger-text font-semibold" },
  MEDIUM: { short: "中", long: "意向中", cls: "bg-warn-soft text-warn-text font-semibold" },
  LOW: { short: "低", long: "意向低", cls: "bg-panel-2 text-t2" },
};

export function useSalesListPrefs(enabled: boolean) {
  const [intent, setIntent] = useState<IntentFilter>("ALL");
  const [sort, setSort] = useState<SalesSort>("recent");
  useEffect(() => {
    if (!enabled) return;
    try {
      const raw = window.localStorage.getItem(PREF_KEY);
      if (!raw) return;
      const v = JSON.parse(raw) as { intent?: unknown; sort?: unknown };
      setIntent(parseIntentFilter(v.intent));
      setSort(parseSalesSort(v.sort));
    } catch {
      /* 私密模式／爛值 → 預設 */
    }
  }, [enabled]);
  const save = useCallback((next: { intent: IntentFilter; sort: SalesSort }) => {
    try {
      window.localStorage.setItem(PREF_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }, []);
  const changeIntent = useCallback(
    (v: IntentFilter) => {
      setIntent(v);
      save({ intent: v, sort });
    },
    [save, sort],
  );
  const changeSort = useCallback(
    (v: SalesSort) => {
      setSort(v);
      save({ intent, sort: v });
    },
    [save, intent],
  );
  // 唔係銷售 → 永遠等同冇篩選／原本排序
  return enabled ? { intent, sort, changeIntent, changeSort } : { intent: "ALL" as IntentFilter, sort: "recent" as SalesSort, changeIntent, changeSort };
}

/** 對話列表行：意向 + 銷售負責標籤（只係銷售帳號先顯示） */
export function SalesRowChips({ c, narrow }: { c: ConversationItem; narrow?: boolean }) {
  const meta = c.salesIntent ? INTENT_CHIP[c.salesIntent] : null;
  const left = c.sales?.state === "PROTECTED" ? daysLeft(c.sales.protectedUntil) : null;
  return (
    <>
      {meta && (
        <span className={`text-[10px] px-2 py-0.5 rounded-full ${meta.cls}`} title="銷售意向" data-e2e="row-sales-intent">
          {narrow ? meta.short : meta.long}
        </span>
      )}
      {c.sales && (
        <span
          className={`text-[10px] px-2 py-0.5 rounded-full ${c.sales.mine ? "bg-brand-soft text-brand-text" : "bg-panel-2 text-t2"}`}
          title={c.sales.state === "BOUND" ? `${c.sales.ownerName} 綁定` : `${c.sales.ownerName} 保護中`}
          data-e2e="row-sales-owner"
        >
          {c.sales.state === "BOUND" ? "綁定" : left != null ? `保護中·剩 ${left} 日` : "保護中"}
          {c.sales.mine ? "" : `·${c.sales.ownerName}`}
        </span>
      )}
    </>
  );
}

function SortMenu({ sort, onSort }: { sort: SalesSort; onSort: (v: SalesSort) => void }) {
  return (
    <label className="ml-auto inline-flex items-center gap-1 text-[11px] text-t2">
      排序
      <select
        value={sort}
        onChange={(e) => onSort(parseSalesSort(e.target.value))}
        className="rounded-full border border-line bg-panel px-2 py-0.5 text-[11px] text-t1"
        data-e2e="sales-sort"
      >
        {SALES_SORTS.map((s) => (
          <option key={s} value={s}>
            {SALES_SORT_TEXT[s]}
            {s === "recent" ? "（預設）" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SalesListControls({
  narrow,
  intent,
  sort,
  counts,
  capsuleLabel,
  onIntent,
  onSort,
}: {
  narrow: boolean;
  intent: IntentFilter;
  sort: SalesSort;
  counts: Record<"HIGH" | "MEDIUM" | "LOW", number>;
  capsuleLabel: string;
  onIntent: (v: IntentFilter) => void;
  onSort: (v: SalesSort) => void;
}) {
  const [open, setOpen] = useState(false);
  const chip = (f: IntentFilter, big = false) => {
    const on = intent === f;
    return (
      <button
        key={f}
        type="button"
        aria-pressed={on}
        onClick={() => onIntent(on && f !== "ALL" ? "ALL" : f)}
        data-e2e={`sales-intent-filter-${f}`}
        className={`${big ? "flex-1 py-2 text-sm" : "px-1.5 py-0.5 text-xs"} rounded-full border whitespace-nowrap inline-flex items-center justify-center gap-1 ${
          on ? "bg-brand text-panel border-brand font-semibold" : "bg-panel border-line text-t1"
        }`}
      >
        {f === "ALL" ? (
          big ? "全部" : "意向：全部"
        ) : (
          <>
            <span className={`px-1.5 rounded-full text-[10px] ${INTENT_CHIP[f].cls}`}>{INTENT_CHIP[f].short}</span>
            {counts[f]}
          </>
        )}
      </button>
    );
  };

  if (!narrow) {
    return (
      <div className="flex items-center gap-1 flex-wrap px-2.5 pb-1.5" data-e2e="sales-list-controls">
        {INTENT_FILTERS.map((f) => chip(f))}
        <SortMenu sort={sort} onSort={onSort} />
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center gap-1.5 px-2.5 pb-1.5" data-e2e="sales-list-controls">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1 rounded-full border border-line bg-panel px-2.5 py-0.5 text-xs text-t1"
          data-e2e="sales-list-open"
        >
          <ArrowUpDown className="w-3 h-3" aria-hidden /> 意向・排序
        </button>
        {intent !== "ALL" && (
          <button
            type="button"
            onClick={() => onIntent("ALL")}
            className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] ${INTENT_CHIP[intent].cls}`}
            aria-label="清除意向篩選"
          >
            {INTENT_CHIP[intent].short} <X className="w-3 h-3" aria-hidden />
          </button>
        )}
        {sort !== "recent" && <span className="ml-auto text-[11px] text-t3">排序：{SALES_SORT_TEXT[sort]}</span>}
      </div>
      {open && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true" aria-label="意向・排序">
          <button type="button" className="absolute inset-0 bg-black/30" aria-label="關閉" onClick={() => setOpen(false)} />
          <div className="relative rounded-t-3xl bg-panel px-5 pt-3 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-xl" data-e2e="sales-list-sheet">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line-strong" />
            <div className="text-[15px] font-semibold text-t1">意向・排序</div>
            <div className="text-[11.5px] text-t3">套用喺目前膠囊「{capsuleLabel}」入面</div>
            <div className="mt-3 mb-1.5 text-[11px] font-semibold text-t2">意向</div>
            <div className="flex gap-1.5">{INTENT_FILTERS.map((f) => chip(f, true))}</div>
            <div className="mt-3 text-[11px] font-semibold text-t2">排序</div>
            <div className="flex flex-col">
              {SALES_SORTS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onSort(s)}
                  className="flex items-center justify-between border-b border-line py-3 text-left text-sm text-t1 last:border-0"
                  data-e2e={`sales-sort-${s}`}
                >
                  {SALES_SORT_TEXT[s]}
                  {s === "recent" ? "（預設）" : ""}
                  <span className="font-semibold text-brand-text">{sort === s ? "✓" : ""}</span>
                </button>
              ))}
            </div>
            <button type="button" onClick={() => setOpen(false)} className="mt-3 w-full rounded-full bg-brand py-2.5 text-sm font-medium text-panel">
              完成
            </button>
          </div>
        </div>
      )}
    </>
  );
}

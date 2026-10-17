"use client";

import { useEffect, useRef, useState } from "react";

/**
 * ★ cwi-inbox-r4（擁有人拍板 2026-10-17）：W 一筆畫載入提示 — 全 app 統一（取代「載入中…」純字／轉圈／灰色骨架）。
 *
 * 三個尺寸：
 *   page   — 綠底方塊（同 app icon）＋ 字；開 app、轉頁、首次載入整頁
 *   card   — 淡色 W 做底、綠線喺上面描；卡片／面板／對話串
 *   inline — 細粒 W 跟住字（按鈕「存緊…」、行內「更新中」）；取代 Loader2 spinner
 *
 * 規則（useDelayedLoading）：0.3 秒內載完唔顯示（快 fetch 唔閃）；一出現最少顯示 0.5 秒；
 *   超過 10 秒 → 字變「仲載入緊… 網絡好似慢」＋（有 onRetry 先）「重試」掣。
 * 讀屏：role="status" + aria-live。
 */

const W_PATH = "M25 29 L39 70 L50 47 L61 70 L75 29";

export function WMark({ size = 16, variant = "inline", className = "" }: { size?: number; variant?: "page" | "card" | "inline"; className?: string }) {
  if (variant === "page") {
    return (
      <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" className={`shrink-0 ${className}`}>
        <rect x="0" y="0" width="100" height="100" rx="24" className="fill-brand" />
        <path d={W_PATH} pathLength={100} className="w-draw stroke-panel" fill="none" strokeWidth={11} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  const sw = variant === "inline" ? 14 : 11;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" className={`shrink-0 ${className}`}>
      {variant === "card" && (
        <path d={W_PATH} fill="none" stroke="currentColor" strokeOpacity={0.18} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
      )}
      <path d={W_PATH} pathLength={100} className="w-draw" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 0.3s 延遲出現 + 最少顯示 0.5s + 10s 慢網絡；回傳 { show, slow } */
export function useDelayedLoading(loading: boolean, { delayMs = 300, minMs = 500, slowMs = 10_000 } = {}) {
  const [show, setShow] = useState(false);
  const [slow, setSlow] = useState(false);
  const shownAtRef = useRef(0);
  useEffect(() => {
    if (loading) {
      const t = setTimeout(() => {
        shownAtRef.current = Date.now();
        setShow(true);
      }, delayMs);
      const s = setTimeout(() => setSlow(true), slowMs);
      return () => {
        clearTimeout(t);
        clearTimeout(s);
      };
    }
    setSlow(false);
    const t = setTimeout(() => setShow(false), Math.max(0, minMs - (Date.now() - shownAtRef.current)));
    return () => clearTimeout(t);
  }, [loading, delayMs, minMs, slowMs]);
  return { show, slow };
}

type LoaderProps = {
  size?: "page" | "card" | "inline";
  label?: string;
  onRetry?: () => void;
  className?: string;
  testId?: string;
};

function LoaderView({ size = "card", label = "載入中…", onRetry, className = "", testId, slow }: LoaderProps & { slow: boolean }) {
  const text = slow ? "仲載入緊… 網絡好似慢" : label;
  if (size === "inline") {
    return (
      <span role="status" aria-live="polite" data-testid={testId} className={`inline-flex items-center gap-1.5 text-t3 ${className}`}>
        <WMark size={14} variant="inline" className="text-brand" />
        {text}
      </span>
    );
  }
  const page = size === "page";
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={testId}
      className={`flex flex-col items-center justify-center gap-2 text-center ${page ? "py-16" : "py-6"} ${className}`}
    >
      <WMark size={page ? 56 : 34} variant={page ? "page" : "card"} className="text-brand-text" />
      <span className={`${page ? "text-sm" : "text-[12px]"} text-t2`}>{text}</span>
      {slow && onRetry && (
        <button type="button" onClick={onRetry} className="text-[12px] px-3 py-1 rounded-full border border-line text-t2 hover:bg-panel-2">
          重試
        </button>
      )}
    </div>
  );
}

/**
 * 載入閘：loading 期間（過咗 0.3s）顯示 W；載完（最少顯示 0.5s 後）先放 children 出嚟。
 * 首 0.3s 乜都唔畫（唔會先閃「冇資料」）。用喺「冇資料」狀態會誤導嘅地方（對話串、病人記錄、備註）。
 */
export function WLoadingGate({ loading, children, ...props }: LoaderProps & { loading: boolean; children: React.ReactNode }) {
  const { show, slow } = useDelayedLoading(loading);
  if (show) return <LoaderView {...props} slow={slow} />;
  if (loading) return <span className="sr-only" role="status">{props.label ?? "載入中…"}</span>;
  return <>{children}</>;
}

/** 載入提示（caller 已經按 loading 條件 render）：0.3s 延遲出現、10s 慢網絡提示。 */
export function WLoading(props: LoaderProps) {
  const { show, slow } = useDelayedLoading(true);
  if (!show) return <span className="sr-only" role="status">{props.label ?? "載入中…"}</span>;
  return <LoaderView {...props} slow={slow} />;
}

/**
 * cwi-setnav NAV-01：手機系統返回鍵（Android ◁／手勢／iOS 左掃）WhatsApp 式圖層堆疊。
 *
 * 設計（工單 §2.3）：
 * - 開圖層（只限 <1024px）：`history.pushState({ waLayer: key, n: ++depth }, "", url?)`
 *   + push 入 module 級 stack（state 保留其他欄位 — Next.js router state 唔會洗走）。
 * - 系統返回（popstate）：stack.pop() → 叫該層 close()（瀏覽器已 pop — 唔再 pushState）。
 * - 用 app 掣閂（「<」、X、撳背景）：移走呢層 **同佢上面所有層** 嘅 stack entry，
 *   並 `history.back()` 咁多次（瀏覽器只能由頂 pop）→ 歷史同畫面永遠同步。
 *   上層圖層嘅 state 由各自 close 邏輯處理（例：關對話連帶收埋 detail/patient —
 *   closeConv；ChatPane remount 自然清掉彈窗 state）。
 * - 換圖層內容（例：列表撳另一條對話）→ `backLayerReplaceUrl`（replaceState 唔疊多層 —
 *   返回一下就返列表）。
 * - 守門：closing 中 flag（防 popstate 同 tick 重複 close）；history 同 stack 失步
 *   （瀏覽器／外部操作）→ 重置 stack（呢次 pop 唔收圖層）；stale `history.state.waLayer`
 *   殘留（重新整理／HMR）→ replaceState 清走。
 * - 圖層 component 卸载時（例：ChatPane 換對話 remount 前仍有 modal entry）→ 該 entry 標
 *   `dead`（close 變 no-op）— 對應嘅 history entry 之後照樣被 pop 消費，唔會令 back 錯層。
 * - 桌面（≥1024px）：零 pushState — 瀏覽器返回照舊（工單 §2.2 拍板行）。
 *
 * 同 Next.js App Router 交互：圖層 pushState 只改 search/state、唔改 pathname（/inbox）—
 *   返回時 pathname 唔變 → client 樹唔會 remount（state 保留）；server component 會再
 *   render 一次（searchParams 變）— 預期行為（返列表 = 重算首屏）。
 */
import { useEffect, useRef } from "react";

interface LayerEntry {
  key: string;
  close: () => void;
  url: string | null;
  n: number;
  /** component 已卸载（close 變 no-op；entry 留埋等對應 history entry 被 pop 消費） */
  dead?: boolean;
}

const stack: LayerEntry[] = [];
let depth = 0;
const closing = new Set<string>();
let popstateInstalled = false;
/** app 掣閂引起嘅 in-flight back() 數 — popstate 见到呢個 > 0 = 已處理過（唔收多一次圖層） */
let pendingBacks = 0;

export function isMobileViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches;
}

function stateFor(key: string, n: number): Record<string, unknown> {
  const prev = (window.history.state ?? {}) as Record<string, unknown>;
  return { ...prev, waLayer: key, n };
}

/** 手動開一個圖層（NAV-03 深連結起手用）。回傳有冇 push 成功（桌面 = false）。 */
export function pushBackLayer(key: string, close: () => void, url?: string | null): boolean {
  if (typeof window === "undefined" || !isMobileViewport()) return false;
  // 同 key 已存在（快開／重入）→ 移去頂，唔疊第二層
  const idx = stack.findIndex((e) => e.key === key);
  if (idx !== -1) stack.splice(idx, 1);
  depth += 1;
  const n = depth;
  stack.push({ key, close, url: url ?? null, n });
  const u = url ?? window.location.pathname;
  window.history.pushState(stateFor(key, n), "", u);
  return true;
}

/** 更新已開圖層嘅 URL（NAV-02 換對話 — replaceState 唔疊多層）。 */
export function backLayerReplaceUrl(key: string, url: string): void {
  if (typeof window === "undefined") return;
  const idx = stack.findIndex((e) => e.key === key);
  if (idx !== -1) {
    stack[idx].url = url;
    window.history.replaceState(stateFor(key, stack[idx].n), "", url);
  } else if (window.location.pathname === "/inbox" && window.location.search.includes("conv=")) {
    // 桌面深連結（唔喺 stack — 桌面零 pushState）：只同步 URL，唔建 history entry
    window.history.replaceState(window.history.state, "", url);
  }
}

/** 測試／除錯用：目前 stack 快照（key 順序 = 開啓順序）。 */
export function backStackSnapshot(): string[] {
  return stack.map((e) => e.key);
}

function popTop(): void {
  const e = stack.pop();
  if (!e) return;
  if (e.dead) return;
  if (closing.has(e.key)) return;
  closing.add(e.key);
  try {
    e.close();
  } finally {
    // 下一 microtask 先放 — 同 tick 內嘅重複觸發（掣 + popstate）唔會雙 close
    queueMicrotask(() => closing.delete(e.key));
  }
}

function ensurePopstate(): void {
  if (popstateInstalled || typeof window === "undefined") return;
  popstateInstalled = true;
  window.addEventListener("popstate", () => {
    // app 掣閂引起嘅 back()（close 已同步跑過）— 只記數，唔收圖層
    if (pendingBacks > 0) {
      pendingBacks -= 1;
      return;
    }
    if (stack.length > 0) {
      // 失步檢查：pop 之後嘅 current entry 應該係 stack 次頂嗰個（或第一個圖層之下）。
      // n 唔匹配 = 歷史被外部改過（多 tab / 手動操作）→ 保守重置 stack（呢次 pop 唔收圖層）。
      const st = window.history.state as { n?: number } | null;
      const below = stack.length >= 2 ? stack[stack.length - 2] : null;
      if (below && (st == null || st.n !== below.n)) {
        stack.length = 0;
        return;
      }
      popTop();
      return;
    }
    // stack 空但 state 殘留 waLayer（重新整理／HMR／dead entry 消費後）→ 清走
    const st = window.history.state as { waLayer?: string } | null;
    if (st && st.waLayer) {
      const rest: Record<string, unknown> = { ...st };
      delete rest.waLayer;
      delete rest.n;
      window.history.replaceState(rest, "");
    }
  });
}

/**
 * 將一個 React 圖層 state 掛入返回堆疊。
 *
 * @param open  圖層有冇開住
 * @param close 收埋圖層（清 state）— 只會喺系統返回（popstate）時被調用
 * @param key   圖層唯一 key（例：conv / detail / patient / modal:confirm / pop:settings）
 * @param url   開圖層時 push 嘅 URL（例：/inbox?conv=<id>）；null = 只 push state 唔改 URL
 */
export function useBackLayer(open: boolean, close: () => void, key: string, url?: string | null): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  const urlRef = useRef(url);
  urlRef.current = url;
  const wasOpen = useRef(open);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    ensurePopstate();
    if (!isMobileViewport()) {
      // 桌面：唔寫歷史。desktop ↔ mobile resize 期間若 stack 有殘留同 key entry（極少），
      // 清理掉避免之後誤觸 history.back()。
      const idx = stack.findIndex((e) => e.key === key);
      if (idx !== -1) stack.splice(idx, 1);
      wasOpen.current = open;
      return;
    }
    if (open && !wasOpen.current) {
      pushBackLayer(key, () => closeRef.current(), urlRef.current);
    } else if (!open && wasOpen.current) {
      const idx = stack.findIndex((e) => e.key === key);
      if (idx !== -1) {
        // app 掣閂：直接 close 呢層 + 上面所有層（各自清自己嘅 state），移走 stack entry，
        // 然後 back() 咁多次對齊歷史。popstate 用 pendingBacks 認得「呢啲 back 已處理」，
        // 唔會再误收下面嘅圖層（修：舊版先 splice 後 back → popstate 误 pop 下面層）。
        const removed = stack.splice(idx);
        for (const e of removed) {
          if (!e.dead && !closing.has(e.key)) {
            closing.add(e.key);
            try {
              e.close();
            } finally {
              queueMicrotask(() => closing.delete(e.key));
            }
          }
        }
        pendingBacks += removed.length;
        for (let i = 0; i < removed.length; i++) window.history.back();
      }
      // idx === -1：已被系統返回 pop 咗（popstate handler 已 close）— no-op
    }
    wasOpen.current = open;
  }, [open, key]);

  // component 卸载：圖層 entry 標 dead（close no-op）— 對應 history entry 之後照被 pop 消費
  useEffect(() => {
    return () => {
      const e = stack.find((x) => x.key === key);
      if (e) e.dead = true;
    };
  }, [key]);
}

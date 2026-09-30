"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, Share, X } from "lucide-react";

/**
 * ★ cwi-ux UX-03：PWA 安裝提示 — 手機冇提示安裝 PWA。
 *
 * 根因（code 實查）：
 * - iPhone/iPad：Safari 根本冇自動安裝提示（Apple 限制）→ 只能人手「分享 → 加入主畫面」
 * - Android Chrome：自動 mini-infobar 由 Chrome 自己決定（互動次數 / 之前拒過）→ 唔可控；
 *   而舊 code 冇處理 beforeinstallprompt（全 repo 搵唔到）→ 冇自己嘅「安裝」掣
 * - /login 冇 manifest（UX-02 已修）→ 第一次打開瀏覽器未知呢個係 app
 *
 * 行為：
 * - 已安裝（display-mode: standalone 或 iOS navigator.standalone）→ 乜都唔顯示
 * - Android／桌面 Chrome：攞 beforeinstallprompt → preventDefault 存低 → 橫條「安裝」
 *   掳 → prompt()（系統安裝框）；accepted → 清 flag；dismissed/cancelled → 7 日唔再出
 * - iPhone Safari：教學橫條「撳底部 分享 ⬆️ → 加入主畫面」（附 icon）
 * - 「稍後」→ localStorage 記 7 日唔再出（per-device 便利功能）
 *
 * 模組級 API（通知設定面板「安裝為 App」永久入口共用 — 唔怕橫條被關咗）：
 * - requestInstall()：觸發系統安裝框；unavailable = 冇 pending prompt（iOS / 未 fire）
 * - isIOSLike() / isStandalone()
 */

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "cwi.install.dismissedUntil";
const DISMISS_MS = 7 * 24 * 3600 * 1000; // 7 日

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
function emitChanged(): void {
  for (const fn of listeners) fn();
}

function readDismissUntil(): number {
  if (typeof window === "undefined") return 0;
  const v = Number(window.localStorage.getItem(DISMISS_KEY) ?? 0);
  return Number.isFinite(v) ? v : 0;
}
function writeDismiss(until: number): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, String(until));
  } catch {
    /* private mode — 靜默 */
  }
}

export function isIOSLike(): boolean {
  if (typeof navigator === "undefined") return false;
  // iPadOS 13+ 報作 Mac — 用 platform + touch 兜（UA 已 deprecated 但仲係最可靠信號）
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** 觸發系統安裝框（橫條 / 設定面板共用）。unavailable = 冇 pending prompt。 */
export async function requestInstall(): Promise<"accepted" | "dismissed" | "cancelled" | "unavailable"> {
  if (!deferredPrompt) return "unavailable";
  const p = deferredPrompt;
  deferredPrompt = null;
  emitChanged();
  try {
    await p.prompt();
    const { outcome } = await p.userChoice;
    if (outcome === "accepted") {
      writeDismiss(0); // 安裝成功 → 清 7 日 flag（appinstalled 事件再兜底）
      emitChanged();
    } else {
      writeDismiss(Date.now() + DISMISS_MS);
      emitChanged();
    }
    return outcome === "accepted" ? "accepted" : outcome === "dismissed" ? "dismissed" : "cancelled";
  } catch {
    writeDismiss(Date.now() + DISMISS_MS);
    emitChanged();
    return "cancelled";
  }
}

/**
 * 橫條（掛 (inbox)/layout — 所有登入頁頂部）。
 * SSR 安全：初始全 false（不顯示）；mount 後先讀 state → 唔會 hydration mismatch。
 */
export function InstallPrompt() {
  const [standalone, setStandalone] = useState(false);
  const [hasPrompt, setHasPrompt] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [ios, setIos] = useState(false);

  const refresh = useCallback(() => {
    setStandalone(isStandalone());
    setIos(isIOSLike());
    setHasPrompt(deferredPrompt !== null);
    setDismissed(readDismissUntil() > Date.now());
  }, []);

  useEffect(() => {
    refresh();
    const onBefore = (e: Event) => {
      e.preventDefault();
      deferredPrompt = e as BeforeInstallPromptEvent;
      emitChanged();
    };
    const onInstalled = () => {
      deferredPrompt = null;
      writeDismiss(0);
      emitChanged();
    };
    // Chrome 只 fire 一次 beforeinstallprompt（每次新 document）— 攞到先顯示
    window.addEventListener("beforeinstallprompt", onBefore);
    window.addEventListener("appinstalled", onInstalled);
    const onChange = () => refresh();
    listeners.add(onChange);
    // standalone 狀態可能變（同機由瀏覽器裝完 App 再開）— 每次 visibility 返前台重查
    const onVis = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBefore);
      window.removeEventListener("appinstalled", onInstalled);
      listeners.delete(onChange);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refresh]);

  // 已安裝 → 乜都唔顯示
  if (standalone) return null;
  if (dismissed) return null;

  const install = () => {
    void requestInstall();
  };
  const later = () => {
    writeDismiss(Date.now() + DISMISS_MS);
    refresh();
  };

  const androidReady = hasPrompt && !ios;

  return (
    <div className="absolute top-0 inset-x-0 z-40 px-3 pt-[calc(env(safe-area-inset-top)+10px)] pointer-events-none">
      <div className="pointer-events-auto mx-auto max-w-2xl flex items-center gap-2.5 rounded-xl border border-line bg-panel shadow-lg px-3 py-2">
        {androidReady ? (
          <>
            <Download size={16} strokeWidth={2.75} className="text-brand shrink-0" />
            <span className="text-xs text-t1 flex-1 min-w-0 leading-snug">
              安裝 WA Inbox 到手機（收通知更穩定）
            </span>
            <button
              onClick={install}
              className="shrink-0 text-xs font-semibold px-3 py-1.5 rounded-full bg-brand text-panel hover:bg-brand-hover"
            >
              安裝
            </button>
            <button
              onClick={later}
              aria-label="稍後"
              className="shrink-0 p-1.5 rounded-full text-t3 hover:bg-black/[.04]"
            >
              <X size={14} />
            </button>
          </>
        ) : ios ? (
          <>
            <Share size={16} strokeWidth={2.75} className="text-brand shrink-0" />
            <span className="text-xs text-t1 flex-1 min-w-0 leading-snug">
              撳底部 分享 <span aria-hidden>⬆️</span> → 「加入主畫面」（iOS 冇自動安裝提示）
            </span>
            <button
              onClick={later}
              aria-label="稍後"
              className="shrink-0 p-1.5 rounded-full text-t3 hover:bg-black/[.04]"
            >
              <X size={14} />
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

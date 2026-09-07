"use client";

import { useEffect, useState } from "react";

/**
 * v2 PWA（cwi-notify-v2-20260903 MD §2）：Service Worker 註冊。
 * - navigator.serviceWorker.register("/sw.js")（sw.js 喺 public/ root → scope /）
 * - try/catch：唔支援（非 secure context / 舊瀏覽器）→ 靜靜跳過
 *   （通知照走 socket + 常規路徑，Web Push 係增量唔係硬依賴）
 *
 * ★ cwi-realtime-fix §8（T279/T280）：SW 更新策略
 * - register({ updateViaCache: "none" }) — 註冊/更新一律打網絡攞 /sw.js
 *   （配合 next.config /sw.js no-cache headers — 舊 SW 卡舊版嘅問題根治）
 * - 主動更新：tab 重返前台 / window focus 各 check 一次 + 每 30 分鐘兜底
 *   （reg.update() — 只有 byte 變先會 updatefound → install → activate）
 * - controllerchange → 「已更新新版本」提示 + [重載]（skipWaiting + clients.claim 令新 SW
 *   即刻接管，但頁面 JS 要 reload 先換 — 唔好靜靜切換 version）
 *
 * ★ 實測陷阱（2026-09-07，Chromium 1228 headless + 真機通用語義）：
 *   controllerchange 喺 `navigator.serviceWorker`（container）火，但**唔會**喺 registration 火
 *   （同一 reg object 上 updatefound 有火、controllerchange 冇火 — probe 實測）。
 *   另外**首次安裝嘅初始 claim 都會火 controllerchange** — 純聽事件會令新用戶
 *   首次打開就見「已更新新版本」假提示 → 用 SW 版本比較 gating：
 *   只有「現行 controller 版本 ≠ 已知版本」先提示（sw.js sw-version postMessage 協議）。
 */
export function SwRegistrar() {
  const [reloadNeeded, setReloadNeeded] = useState(false);

  useEffect(() => {
    let reg: ServiceWorkerRegistration | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let knownVersion: string | null = null;
    let booted = false;
    const check = () => {
      void reg?.update().catch(() => {
        /* 靜默跳過 */
      });
    };
    const onVis = () => {
      if (document.visibilityState === "visible") check();
    };
    const ping = () => window.dispatchEvent(new Event("sw:activated"));
    /** 查現行 controller 嘅 SW_VERSION（postMessage round-trip，5s timeout → null） */
    const queryVersion = (): Promise<string | null> =>
      new Promise((resolve) => {
        const reqId = `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        let done = false;
        const onMsg = (e: MessageEvent) => {
          const d = e.data as { type?: string; version?: string; reqId?: string } | null;
          if (d && d.type === "sw-version-ack" && d.reqId === reqId) {
            done = true;
            cleanup();
            resolve(typeof d.version === "string" ? d.version : null);
          }
        };
        const to = setTimeout(() => {
          if (!done) {
            cleanup();
            resolve(null);
          }
        }, 5000);
        const cleanup = () => {
          navigator.serviceWorker.removeEventListener("message", onMsg);
          clearTimeout(to);
        };
        try {
          navigator.serviceWorker.addEventListener("message", onMsg);
          navigator.serviceWorker.controller?.postMessage({ type: "sw-version", reqId });
        } catch {
          cleanup();
          resolve(null);
        }
      });
    // ★ controllerchange 監聽喺 container（見上方實測註）；版本比較先提示（防首次安裝假提示）
    const onControllerChange = () => {
      void queryVersion().then((v) => {
        if (!booted) {
          booted = true;
          knownVersion = v;
          return;
        }
        if (knownVersion !== null && v !== null && v !== knownVersion) setReloadNeeded(true);
        if (v !== null) knownVersion = v;
      });
      ping();
    };
    try {
      if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
        void navigator.serviceWorker
          .register("/sw.js", { updateViaCache: "none" })
          .then((r) => {
            reg = r;
            // §8：SW active（首次安裝 / 更新接管）→ ping app 冪等重確保 push subscription
            // （修 mount 先於 SW 註冊完成時 ensurePushSubscription 直接 false 且唔重試嘅 race）
            const inst = r.installing || r.waiting;
            if (r.active) ping();
            else if (inst)
              inst.addEventListener("statechange", () => {
                if (r.active) ping();
              });
          })
          .catch(() => {
            /* 靜默跳過 — 唔擋主流程 */
          });
        // attach 時已有 controller（常見：SW 快過 hydration）→ 直接記已知版本（唔提示）
        if (navigator.serviceWorker.controller) {
          booted = true;
          void queryVersion().then((v) => {
            knownVersion = v;
          });
        }
        navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
        document.addEventListener("visibilitychange", onVis);
        window.addEventListener("focus", check);
        timer = setInterval(check, 30 * 60 * 1000);
      }
    } catch {
      /* 靜默跳過 */
    }
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", check);
      if ("serviceWorker" in navigator) navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      if (timer) clearInterval(timer);
    };
  }, []);

  // ★ §8：新 SW 接管後（controllerchange）— 提示重載（舊 JS 繼續跑到手動 reload）
  if (!reloadNeeded) return null;
  return (
    <div className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg bg-neutral-900 px-4 py-2 text-xs text-white shadow-lg">
      <span>已更新新版本</span>
      <button
        className="rounded bg-white/20 px-2 py-0.5 font-semibold hover:bg-white/30"
        onClick={() => window.location.reload()}
      >
        重載
      </button>
    </div>
  );
}

"use client";

import { useEffect } from "react";

/**
 * v2 PWA（cwi-notify-v2-20260903 MD §2）：Service Worker 註冊。
 * - navigator.serviceWorker.register("/sw.js")（sw.js 喺 public/ root → scope /）
 * - try/catch：唔支援（非 secure context / 舊瀏覽器）→ 靜靜跳過
 *   （通知照走 socket + 常規路徑，Web Push 係增量唔係硬依賴）
 */
export function SwRegistrar() {
  useEffect(() => {
    try {
      if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
        void navigator.serviceWorker.register("/sw.js").catch(() => {
          /* 靜默跳過 — 唔擋主流程 */
        });
      }
    } catch {
      /* 靜默跳過 */
    }
  }, []);
  return null;
}

/**
 * sw.js — Part B v2（cwi-notify-v2-20260903 MD §2）：Service Worker。
 *
 * Android Chrome 唔支援 `new Notification()` — 手機通知嘅硬前提。
 * - push：server Web Push（VAPID）入口 — tab 閂咗／鎖屏都收到
 * - notificationclick：撳通知 → focus 現有 /inbox tab + postMessage 選中對話；
 *   冇 window → 開新窗 /inbox?c=<id>
 *
 * ★ PII 鐵律：push payload 只有 kind / clinicShort / conversationId，冇病人資料
 * （push 內容會經 Google/Apple 伺服器 — 見 src/lib/push.ts）。
 */
self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Web Push 入口（server 推 — src/lib/push.ts）
self.addEventListener("push", (event) => {
  const d = (() => {
    try {
      return event.data.json();
    } catch {
      return {};
    }
  })();
  // ★ PII 鐵律：payload 只有 kind / clinicShort / conversationId，冇病人資料
  const title = d.kind === "urgent" ? `⚠ 緊急 · ${d.clinicShort}` : `新訊息 · ${d.clinicShort}`;
  event.waitUntil(
    self.registration.showNotification(title, {
      tag: d.conversationId,
      renotify: true,
      requireInteraction: d.kind === "urgent",
      vibrate: d.kind === "urgent" ? [200, 100, 200] : [120],
      data: { conversationId: d.conversationId },
      badge: "/icon-badge.png",
      icon: "/icon-192.png",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const id = event.notification.data?.conversationId;
  const url = id ? `/inbox?c=${id}` : "/inbox";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const hit = all.find((c) => c.url.includes("/inbox"));
      if (hit) {
        await hit.focus();
        hit.postMessage({ type: "open-conversation", conversationId: id });
        return;
      }
      await self.clients.openWindow(url);
    })()
  );
});

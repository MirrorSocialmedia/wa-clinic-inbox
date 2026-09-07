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
 *
 * ★ cwi-realtime-fix §8.2 鐵律：本 SW 無 fetch handler / 無 caches（純 notification + push）—
 *   加咗都會破壞 Next dev 嘅 lazy-compile 流程，唔准加。
 */

// ★ cwi-realtime-fix §8.3 (T279)：版本標記 — activate 時 console.info（console 可追溯 SW 更新）。
//   SW 邏輯任何改動都要 bump 呢個值（byte 變 → 瀏覽器自動偵測新 version）。
const SW_VERSION = "2026-09-07-a2";

self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => {
  console.info("[sw]", SW_VERSION);
  e.waitUntil(self.clients.claim());
});

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
  const title =
    d.kind === "urgent"
      ? `⚠ 緊急 · ${d.clinicShort}`
      : d.kind === "routing-escalation"
        ? `⚠ 升級 · ${d.clinicShort}`
        : d.kind === "routing"
          ? `新個案 · ${d.clinicShort}`
          : `新訊息 · ${d.clinicShort}`;
  // F-7（cwi-notify-fix）：通知來源留痕 — SW push 係唯一准觸發通知嘅非 socket 來源
  console.debug("notify:", "sw:push");
  event.waitUntil(
    self.registration.showNotification(title, {
      silent: false, // cwi-realtime-fix §7.1：部分平台預設靜音 → 明確 false 先至用系統通知音
      tag: d.conversationId,
      renotify: true,
      requireInteraction: d.kind === "urgent" || d.kind === "routing-escalation",
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

// ★ cwi-realtime-fix §8.3 (T279)：頁面側版本查詢（postMessage round-trip）— e2e 斷言
//   「SW 更新後 version 真係變咗」用（無 fetch handler — 只係 message，唔碰 §8.2 鐵律）。
//   reqId 回顯：sw-registrar 同時 multiple 查詢時唔會撞 ack。
self.addEventListener("message", (event) => {
  const d = event.data;
  if (!d) return;
  if (d.type === "sw-version" && event.source) {
    event.source.postMessage({ type: "sw-version-ack", version: SW_VERSION, reqId: d.reqId ?? null });
  }
});

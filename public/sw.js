/**
 * sw.js — Part B v2（cwi-notify-v2-20260903 MD §2）：Service Worker。
 *
 * Android Chrome 唔支援 `new Notification()` — 手機通知嘅硬前提。
 * - push：server Web Push（VAPID）入口 — tab 閂咗／鎖屏都收到
 * - notificationclick：撳通知 → focus 現有 /inbox tab + postMessage 選中對話；
 *   冇 window → 開新窗 /inbox?conv=<id>
 *
 * ★ PII 鐵律：push payload 只有 kind / clinicShort / conversationId，冇病人資料
 * （push 內容會經 Google/Apple 伺服器 — 見 src/lib/push.ts）。
 *
 * ★ cwi-realtime-fix §8.2 鐵律：本 SW 無 fetch handler / 無 caches（純 notification + push）—
 *   加咗都會破壞 Next dev 嘅 lazy-compile 流程，唔准加。
 */

// ★ cwi-realtime-fix §8.3 (T279)：版本標記 — activate 時 console.info（console 可追溯 SW 更新）。
//   SW 邏輯任何改動都要 bump 呢個值（byte 變 → 瀏覽器自動偵測新 version）。
const SW_VERSION = "2026-10-02-notify-a"; // ★ cwi-notify-a4/a5：push 收件回報 + 前台唔雙聲 + 測試通知標題

self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => {
  console.info("[sw]", SW_VERSION);
  e.waitUntil(self.clients.claim());
});

// ★ cwi-notify-a5：頁面「我會自己出聲」狀態（inbox-client 15s 心跳 postMessage）— clientId → { ready, at }。
//   SW 隨時可能被瀏覽器停（狀態清空）→ 清空 = 當冇頁面出聲 → 照出系統聲（寧可雙聲都唔可以冇聲）。
const pageAudio = new Map();
const PAGE_AUDIO_FRESH_MS = 45_000;

async function pageWillSound() {
  try {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const now = Date.now();
    return all.some((c) => {
      const st = pageAudio.get(c.id);
      return c.visibilityState === "visible" && st && st.ready === true && now - st.at < PAGE_AUDIO_FRESH_MS;
    });
  } catch {
    return false;
  }
}

// ★ cwi-notify-a4：收件回報（診斷「推送服務收咗，部機有冇真係收到」）— 失敗靜默，唔影響通知
async function ackPush() {
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (!sub) return;
    await fetch("/api/push/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
  } catch {
    /* ignore */
  }
}

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
  const title = d.test
    ? `測試通知 · ${d.clinicShort}`
    : d.kind === "urgent"
      ? `⚠ 緊急 · ${d.clinicShort}`
      : d.kind === "routing-escalation"
        ? `⚠ 升級 · ${d.clinicShort}`
        : d.kind === "routing"
          ? `新個案 · ${d.clinicShort}`
          : `新訊息 · ${d.clinicShort}`;
  // F-7（cwi-notify-fix）：通知來源留痕 — SW push 係唯一准觸發通知嘅非 socket 來源
  console.debug("notify:", "sw:push");
  event.waitUntil(
    (async () => {
      // ★ cwi-notify-a5：前台頁面會自己 chime → 系統通知改 silent（仍然出通知 — iOS 要求每個 push 都要顯示，
      //   否則會撤銷訂閱）；急症同測試通知永遠出系統聲。
      const quiet = !d.test && d.kind !== "urgent" && (await pageWillSound());
      await self.registration.showNotification(title, {
        silent: quiet, // 背景／鎖屏 = false（cwi-realtime-fix §7.1：明確 false 先至用系統通知音）
        tag: d.test ? "push-test" : d.conversationId,
        renotify: true,
        requireInteraction: d.kind === "urgent" || d.kind === "routing-escalation",
        vibrate: d.kind === "urgent" ? [200, 100, 200] : [120],
        data: { conversationId: d.conversationId },
        badge: "/icon-badge.png",
        icon: "/icon-192.png",
      });
      await ackPush();
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const id = event.notification.data?.conversationId;
  const url = id ? `/inbox?conv=${id}` : "/inbox"; // ★ cwi-final S0-2：page 讀 ?conv=（舊 ?c= 係死參數）
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
  if (d.type === "page-audio" && event.source && event.source.id) {
    pageAudio.set(event.source.id, { ready: d.ready === true, at: Date.now() });
    if (pageAudio.size > 50) pageAudio.clear(); // cap（clientId 會隨 tab 開關變）
    return;
  }
  if (d.type === "sw-version" && event.source) {
    event.source.postMessage({ type: "sw-version-ack", version: SW_VERSION, reqId: d.reqId ?? null });
  }
});

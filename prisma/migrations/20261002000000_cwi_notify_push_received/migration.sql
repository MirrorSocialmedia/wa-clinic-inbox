-- ★ cwi-notify-a4（2026-10-02）：推送診斷 — 手機 service worker 真正收到推送嘅時間（additive、nullable、零回填）。
ALTER TABLE "PushSubscription" ADD COLUMN "lastReceivedAt" TIMESTAMPTZ;

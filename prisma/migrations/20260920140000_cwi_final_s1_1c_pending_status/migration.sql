-- ★ cwi-final S1-1c（C-1③ / audit3 P1-06）：status 早過訊息 → PendingStatus 暫存表。
--
-- 背景：outbound worker Graph 已回 wamid 但 message.update({ waMessageId }) 未寫入前，
--   sent/delivered webhook 可到 → handleStatuses 搵唔到 Message 但 claim 已 commit
--   → Meta 唔會重送 → status 永久丟。而家同 tx 落 PendingStatus（零 PII：只有
--   wamid/status/errorCode/clinicId），三個排水點（outbound 寫入後 / APP_ECHO 後 /
--   pending-status-sweep */2）配對到 Message 時 monotonic apply + 刪行。
--
-- 冪等：handleStatuses parked 用 createMany(skipDuplicates) + @@unique([wamid, status])
--   → webhook 重發唔會重複行。

CREATE TABLE "PendingStatus" (
    "id" TEXT NOT NULL,
    "wamid" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "clinicId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PendingStatus_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PendingStatus_wamid_status_key" ON "PendingStatus"("wamid", "status");

CREATE INDEX "PendingStatus_receivedAt_idx" ON "PendingStatus"("receivedAt");

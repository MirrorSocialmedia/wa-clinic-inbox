/**
 * BookingRequest 過期邏輯（MD §8.3：48h 冇處理 → EXPIRED + admin 提醒）
 *
 * cron `bookings-expire` 每 5 分鐘行一次（輕量 DB-only）：
 * - PENDING 且 createdAt < now - 48h → EXPIRED + AuditLog(BOOKING_EXPIRED)
 * - FlowSession SENT 且 createdAt < now - 48h → ABANDONED（flow 中途棄 = 零 BookingRequest，
 *   無殭屍 — ABANDONED 只係清理 token 狀態）
 *   ★ cwi-final S5-11（F4）：abandon 前若該 flowToken 有本地 HELD hold → call workforce release
 *   （DELETE claim/{holdId}；S0-12 閘唔擋；fail-soft — 放唔到下次 sweep 對返發現消失 → EXPIRED）
 * - ★ Phase C：BookingSession ACTIVE/CONFIRMING 且 expiresAt < now（24h TTL）→ ABANDONED
 *
 * 冪等：重複執行只處理 still-PENDING/ACTIVE 嘅 row（UPDATE WHERE status=...）。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { releaseHold, WorkforceOutcomeUnknown } from "@/lib/workforce/client";

export const EXPIRY_HOURS = 48;

export interface ExpiryResult {
  expiredBookings: number;
  abandonedFlows: number;
  /** ★ Phase C：過期 slot-filling session（24h TTL） */
  abandonedSessions: number;
  /** ★ cwi-final S5-11（F4）：abandoned flow 對應嘅本地 HELD hold 放開數 */
  releasedHolds: number;
}

export async function runExpiry(now: Date = new Date()): Promise<ExpiryResult> {
  const cutoff = new Date(now.getTime() - EXPIRY_HOURS * 3600 * 1000);

  // 1) PENDING bookings → EXPIRED
  const stale = await prisma.bookingRequest.findMany({
    where: { status: "PENDING", createdAt: { lt: cutoff } },
    select: { id: true, clinicId: true, conversationId: true },
  });
  let expiredBookings = 0;
  for (const b of stale) {
    const updated = await prisma.bookingRequest.updateMany({
      where: { id: b.id, status: "PENDING" }, // 冪等：贏咗 race 嘅唔會重覆
      data: { status: "EXPIRED", handledAt: now },
    });
    if (updated.count > 0) {
      expiredBookings += 1;
      await prisma.auditLog.create({
        data: {
          action: "BOOKING_EXPIRED",
          staffId: null,
          meta: { bookingId: b.id, conversationId: b.conversationId, clinicId: b.clinicId, reason: `${EXPIRY_HOURS}h 未處理` },
        },
      });
      log.warn({ bookingId: b.id, clinicId: b.clinicId }, "booking: EXPIRED（48h 未處理）— admin 提醒");
    }
  }

  // 2) SENT flows → ABANDONED（棄單清理）
  // ★ cwi-final S5-11（F4）：先撳 abandoned flow 嘅 flowToken（= FlowHoldEvent.flowToken）→
  //   有本地 HELD hold → release（病人棄單 = 位數應該放開；fail-soft 唔阻 abandon）
  const staleFlows = await prisma.flowSession.findMany({
    where: { status: "SENT", createdAt: { lt: cutoff } },
    select: { flowToken: true },
    take: 200,
  });
  const abandoned = await prisma.flowSession.updateMany({
    where: { status: "SENT", createdAt: { lt: cutoff } },
    data: { status: "ABANDONED" },
  });
  let releasedHolds = 0;
  for (const f of staleFlows) {
    const hold = await prisma.flowHoldEvent.findFirst({
      where: { flowToken: f.flowToken, status: "HELD" },
      select: { id: true, workforceHoldId: true, flowToken: true },
    });
    if (!hold?.workforceHoldId) continue; // 無 hold / 無 workforce 連結（舊 row）→ 無乜可放
    try {
      await releaseHold(hold.workforceHoldId);
      // 本地同步 RELEASED（冪等：status HELD 條件擋重複）
      const upd = await prisma.flowHoldEvent.updateMany({
        where: { id: hold.id, status: "HELD" },
        data: { status: "RELEASED" },
      });
      if (upd.count > 0) {
        releasedHolds += 1;
        log.info({ holdId: hold.id, flowToken8: f.flowToken.slice(0, 8) }, "expiry: flow ABANDONED → hold released");
      }
    } catch (err) {
      // fail-soft：workforce 離線/404（已放）→ 下次 hold-sweep 對返發現消失 → EXPIRED
      if (!(err instanceof WorkforceOutcomeUnknown)) {
        log.warn(
          { holdId: hold.id, err: err instanceof Error ? err.name : "?" },
          "expiry: hold release fail（fail-soft — sweep 兜底）"
        );
      }
    }
  }

  // 3) ★ Phase C（cwi-sess-20260824-c1）：slot-filling session 24h TTL → ABANDONED
  //    （唔通知 — 病人 24h 冇理 = 自然冷卻；再講預約會重新開 session）
  const abandonedSessions = await prisma.bookingSession.updateMany({
    where: { status: { in: ["ACTIVE", "CONFIRMING"] }, expiresAt: { lt: now } },
    data: { status: "ABANDONED" },
  });

  if (expiredBookings > 0 || abandoned.count > 0 || abandonedSessions.count > 0 || releasedHolds > 0) {
    log.info(
      { expiredBookings, abandonedFlows: abandoned.count, abandonedSessions: abandonedSessions.count, releasedHolds },
      "cron: bookings-expire ok"
    );
  }
  return { expiredBookings, abandonedFlows: abandoned.count, abandonedSessions: abandonedSessions.count, releasedHolds };
}

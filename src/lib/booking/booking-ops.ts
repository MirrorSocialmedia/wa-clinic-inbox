import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { publishNotify } from "@/lib/notify";

/**
 * booking 寫入後嘅即時刷新三步（booking-ui MD §2）：
 *   1. L2 invalidate — del AvailabilitySlot where clinicId+date（該日空檔下次 getSlots 會重新 sync）
 *   2. BookingRequest 落庫（由 route 做）
 *   3. socket 廣播 booking:changed（room clinic:{id}）→ 前端三位（對話卡/側欄預約卡//bookings 隊列）訂閱重拉
 *
 * 15 分鐘 cron 唔郁（MD §2 — L2 自然過期仍係兜底）。
 *
 * PII 鐵律：payload 只含 conversationId / clinicId / date / kind — 零病人欄位、零 phoneHash。
 */

/** booking:changed 事件 kind（MD §2 原文） */
export type BookingChangedKind = "CREATED" | "ROLLED_BACK" | "RESCHEDULED" | "CANCELLED";

export interface BookingChangedPayload {
  conversationId: string;
  clinicId: string;
  /** 受影響日期（L2 invalidate 範圍；RESCHEDULED = 新日期 — 舊日期由 caller 另行 invalidate） */
  date: string;
  kind: BookingChangedKind;
}

/**
 * L2 invalidate：刪走指定店 + 日期嘅 AvailabilitySlot 行。
 * @returns 刪咗幾多行（log metadata 用 — 0 都正常（嗰日無 cache 行））
 */
export async function invalidateDayCache(clinicId: string, date: string): Promise<number> {
  const { count } = await prisma.availabilitySlot.deleteMany({
    where: dayInvalidateWhere(clinicId, date),
  });
  log.info({ clinicId, date, deleted: count }, "booking: L2 day cache invalidated");
  return count;
}

/** pure：invalidate where 條件（unit test 用 — 零 DB） */
/** 撤銷窗口（MD §3：5 分鐘）— 喺度定義（route file 只准 Route exports） */
export const ROLLBACK_WINDOW_MS = 5 * 60 * 1000;

/** pure：倒數邊界判斷（unit test 用 — 零 DB）：true = 可以撤銷 */
export function rollbackWindowOpen(handledAt: Date | null, now: Date): boolean {
  if (!handledAt) return false;
  const elapsed = now.getTime() - handledAt.getTime();
  return elapsed >= 0 && elapsed <= ROLLBACK_WINDOW_MS;
}

export function dayInvalidateWhere(clinicId: string, date: string): { clinicId: string; date: string } {
  return { clinicId, date };
}

/** socket 廣播（fire-and-forget — Redis 故障唔阻斷寫入路徑；UI 經 reconnect backlog 補漏） */
export function publishBookingChanged(payload: BookingChangedPayload): void {
  publishNotify(payload.clinicId, "booking:changed", payload);
}

/**
 * 寫入後三步嘅標準包裝：L2 invalidate（可多日）→ broadcast。
 * BookingRequest 落庫由 caller 喺前面做（200 語義：workforce 已成功）。
 */
export async function afterBookingWrite(
  clinicId: string,
  dates: string[],
  conversationId: string,
  kind: BookingChangedKind,
  broadcastDate: string
): Promise<void> {
  // 多日 invalidate（RESCHEDULED = 舊日 + 新日）— 逐日刪（量細，唔使 batch）
  for (const date of [...new Set(dates)]) {
    await invalidateDayCache(clinicId, date);
  }
  publishBookingChanged({ conversationId, clinicId, date: broadcastDate, kind });
}

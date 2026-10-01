/**
 * ★ cwi-ux UX-07（2026-10-01）：跨分店預約 — 目標店單一來源 helper。
 *
 * BookingRequest.bookingClinicId = 預約喺邊間店做（目標店）；null = 同 clinicId（舊資料零改動）。
 * 鐵律（spec §7.3）：**所有「時段／Apricot／確認訊息／改期／取消／提醒」相關嘅地方一律用呢個** —
 * 唔准散落自己寫 `bookingClinicId ?? clinicId`。
 *
 * clinicId 意思**唔變** = 對話所屬店（權限範圍、/bookings 隊列、對話通知）— 呢度唔涉及。
 */

/** 目標店 id（時段／Apricot／確認訊息等「預約喺邊間店做」嘅唯一解法）。 */
export function effectiveBookingClinicId(b: { bookingClinicId: string | null | undefined; clinicId: string }): string {
  return b.bookingClinicId ?? b.clinicId;
}

/** 係咪跨店預約（目標店 ≠ 對話所屬店）— UI 膠囊 / 審計 meta 用。 */
export function isCrossClinicBooking(b: { bookingClinicId: string | null | undefined; clinicId: string }): boolean {
  return b.bookingClinicId != null && b.bookingClinicId !== b.clinicId;
}

/**
 * 時段佔用重複防護嘅 where 片段（spec §7.3：existingPending 用目標店）—
 * 佔住目標店該 slot 嘅 PENDING row = `clinicId = 目標店`（同店舊行）**或** `bookingClinicId = 目標店`（跨店行）。
 * pure（unit test 用）。
 */
export function targetClinicSlotWhere(targetClinicId: string): {
  OR: [{ clinicId: string }, { bookingClinicId: string }];
} {
  return { OR: [{ clinicId: targetClinicId }, { bookingClinicId: targetClinicId }] };
}

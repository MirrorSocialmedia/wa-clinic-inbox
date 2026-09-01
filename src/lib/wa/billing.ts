/**
 * cwi-window-20260901（P1）— WhatsApp 計費類別。
 *
 * 背景：2026-10-01 WhatsApp 新 API 起每條 OUT 訊息個別計費。
 * billingCategory（Message.billingCategory）係 /admin/usage 用量統計嘅基礎。
 *
 * 類別（寫入規則 = backfill 規則，見 migration 20260901172013 + scripts/backfill-billing-category.sql）：
 * - SERVICE   — 窗口內人手/AI 自由回覆（text / interactive flow message）
 * - UTILITY   — template（WA category = UTILITY，或舊 row 無類別資料時嘅 fallback）
 * - MARKETING — template（WA category = MARKETING）
 * - AUTH      — template（WA category = AUTHENTICATION）
 * - NONE      — APP_ECHO（手機 App 回音）/ INTERNAL（內部備註）— 唔經 WhatsApp API，唔計費
 * - NULL      — IN / HISTORY（入站同舊匯入）— 唔計費
 *
 * ★ template 類別映射：WA Graph API 嘅 template category 只有 UTILITY / MARKETING /
 *   AUTHENTICATION 三值。未知/缺失 → UTILITY（declared fallback — 已聲明偏差）。
 */

export type BillingCategory = "SERVICE" | "UTILITY" | "MARKETING" | "AUTH" | "NONE";

/**
 * template 嘅 WA category → billingCategory。
 * null/undefined/未知值 → "UTILITY"（fallback，見檔案頭註）。
 */
export function billingCategoryForTemplate(
  waCategory: string | null | undefined
): BillingCategory {
  switch (waCategory) {
    case "MARKETING":
      return "MARKETING";
    case "AUTHENTICATION":
      return "AUTH";
    case "UTILITY":
    default:
      return "UTILITY";
  }
}

/** 窗口內人手/AI 自由回覆（text）— 一律 SERVICE。 */
export const BILLING_SERVICE: BillingCategory = "SERVICE";

/** APP_ECHO / INTERNAL — 唔計費。 */
export const BILLING_NONE: BillingCategory = "NONE";

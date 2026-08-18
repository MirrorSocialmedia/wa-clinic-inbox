/**
 * 24h 客服窗口計算（框架 MD §6.3）。
 *
 * WhatsApp 規則：病人最後一條 inbound 之後 24h 內，商家可以自由格式回覆
 * （free-form，$0）；過咗窗只可以發已審批嘅 utility template（按條收費）。
 *
 * 窗口起點 = Conversation.lastInboundAt（最後病人訊息時間）。
 */

export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface WindowState {
  /** 窗口開緊（can send free-form） */
  open: boolean;
  /** 剩餘毫秒（過窗 = 0） */
  remainingMs: number;
  /** 剩餘小時（倒數 chip 顯示用，可為負 = 過窗咗幾多） */
  remainingHours: number;
}

/**
 * 計算 24h 窗口狀態。
 * @param lastInboundAt 病人最後 inbound 時間（null = 從未有病人訊息 → fail-closed：視作過窗）
 * @param now 現在時間（注入方便測試）
 */
export function getWindowState(
  lastInboundAt: Date | string | null | undefined,
  now: Date = new Date()
): WindowState {
  if (!lastInboundAt) {
    return { open: false, remainingMs: 0, remainingHours: 0 };
  }
  const last = typeof lastInboundAt === "string" ? new Date(lastInboundAt).getTime() : lastInboundAt.getTime();
  if (Number.isNaN(last)) {
    return { open: false, remainingMs: 0, remainingHours: 0 };
  }
  const remaining = last + SERVICE_WINDOW_MS - now.getTime();
  return {
    open: remaining > 0,
    remainingMs: Math.max(0, remaining),
    remainingHours: remaining / 3_600_000,
  };
}

/**
 * 窗口顏色（UI chip）：綠 <6h、黃 6-24h、紅 過窗。
 */
export function windowTone(w: WindowState): "green" | "yellow" | "red" {
  if (!w.open) return "red";
  if (w.remainingMs < 6 * 60 * 60 * 1000) return "yellow";
  return "green";
}

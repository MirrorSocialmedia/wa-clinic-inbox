/**
 * WhatsApp Embedded Signup postMessage 解析（純 function — client 用，unit test 覆蓋）。
 *
 * Meta 有兩種形狀，兩種都要收：
 *   - sessionInfoVersion "3"（我哋 FB.login extras 設嘅版本）：
 *       { type:"WA_EMBEDDED_SIGNUP", event:"FINISH" | "FINISH_ONLY_WABA" |
 *         "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" | "CANCEL", data:{ phone_number_id?, waba_id?, business_id?,
 *         current_step?, error_message? }, version:3 }
 *   - 舊版（v2）：{ type, current_step, phone_number_id?, waba_id?, error_message? }（全部喺頂層）
 *
 * ★ FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING = 共存（Coexistence）：商戶揀「連接現有 WhatsApp Business App」
 *   → 手機掃 QR code。號碼繼續喺 App 用，唔使驗證碼、唔使 register（register 會令號碼離開 App）；
 *   phone_number_id 可能唔喺 payload（server 用 waba_id 查返）。
 */
export const SIGNUP_MESSAGE_TYPE = "WA_EMBEDDED_SIGNUP";
export const COEXISTENCE_FINISH_EVENT = "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING";

export type SignupMode = "cloud" | "coexistence";

export type SignupMessage =
  | { kind: "finish"; mode: SignupMode; phoneNumberId?: string; wabaId?: string }
  | { kind: "cancel"; step?: string }
  | { kind: "error"; message: string }
  | { kind: "ignore" };

const ID = /^\d{1,32}$/; // Meta id = 純數字；其他一律唔信（防 postMessage 塞怪值落 exchange）

function pickId(v: unknown): string | undefined {
  return typeof v === "string" && ID.test(v) ? v : undefined;
}

export function parseSignupMessage(raw: unknown): SignupMessage {
  let d = raw;
  // FB SDK 有時用 JSON 字串 postMessage
  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      return { kind: "ignore" };
    }
  }
  if (!d || typeof d !== "object") return { kind: "ignore" };
  const o = d as Record<string, unknown>;
  if (o.type !== SIGNUP_MESSAGE_TYPE) return { kind: "ignore" };

  const data = (o.data && typeof o.data === "object" ? o.data : o) as Record<string, unknown>;
  const event = typeof o.event === "string" ? o.event : typeof o.current_step === "string" ? o.current_step : "";
  const phoneNumberId = pickId(data.phone_number_id);
  const wabaId = pickId(data.waba_id);

  if (event === "FINISH" || event === "FINISH_ONLY_WABA") return { kind: "finish", mode: "cloud", phoneNumberId, wabaId };
  if (event === COEXISTENCE_FINISH_EVENT) return { kind: "finish", mode: "coexistence", phoneNumberId, wabaId };
  if (event === "CANCEL" || event === "ERROR") {
    const msg = typeof data.error_message === "string" ? data.error_message : "";
    if (msg || event === "ERROR") return { kind: "error", message: msg || "unknown" };
    return { kind: "cancel", step: typeof data.current_step === "string" ? data.current_step : undefined };
  }
  return { kind: "ignore" };
}

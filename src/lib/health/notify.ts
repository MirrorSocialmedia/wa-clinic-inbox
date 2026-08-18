/**
 * Alert 通知層（MD §9.3：異常經 WhatsApp（你自己個號）/Telegram 通知你）。
 *
 * env `ALERT_CHANNEL`：
 * - `log`（預設；sandbox 安全）：log.warn metadata only
 * - `telegram`：POST webhook（兩者擇一）：
 *     • TELEGRAM_ALERT_WEBHOOK_URL — 完整 URL（e.g. 內部 relay），POST { text }
 *     • TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID — 標準 Bot API sendMessage
 * - `whatsapp`：真 mode 用 Graph API 發去你自己個號（env WA_ALERT_TO = 852...）
 *   （WA_MOCK=1 時只 log 模擬，唔打真 API）
 *
 * ★ iron rule 1：通知內容 = metadata only（type/severity/detail）—
 *   警報永遠唔可以包含訊息原文 / 病人資料。detail 入面只係
 *   queue 計數 / 分鐘數 / rating / disk % 呢類數字。
 *
 * ★ 通知失敗唔準炸 cron worker（monitoring 係旁路）— 全部 try/catch + log。
 */
import log from "@/lib/log";
import { sendTextMessage, waMock } from "@/lib/wa/graph";

export type AlertChannel = "log" | "telegram" | "whatsapp";

export interface AlertForNotify {
  type: string;
  severity: string;
  clinicCode?: string | null;
  detail?: unknown;
  createdAt?: Date;
}

/** 組通知文字（metadata only — 冇任何訊息內容欄位）。 */
export function formatAlertText(a: AlertForNotify): string {
  const ts = (a.createdAt ?? new Date()).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const who = a.clinicCode ? ` clinic=${a.clinicCode}` : "";
  let detail = "";
  if (a.detail !== undefined && a.detail !== null) {
    // 特例：weekly_report 嘅 detail.text 本身就係人話報表（metadata only）— 直接附原文，
    // 其餘 detail 用 JSON（數字 metadata）。
    const d = a.detail as Record<string, unknown>;
    if (typeof d?.text === "string") {
      detail = `\n${d.text}`;
    } else {
      detail = ` detail=${JSON.stringify(a.detail)}`;
    }
  }
  return `🚨 WA-ALERT [${a.severity}] ${a.type}${who} @ ${ts}${detail}`;
}

export function alertChannel(): AlertChannel {
  const c = (process.env.ALERT_CHANNEL ?? "log").toLowerCase();
  return c === "telegram" || c === "whatsapp" ? c : "log";
}

/**
 * 發出一條警報通知（fire-and-forget 語義：永不 throw）。
 * @returns 實際用咗嘅 channel（log 失敗降級時反映 fallback）
 */
export async function notifyAlert(a: AlertForNotify): Promise<AlertChannel> {
  const text = formatAlertText(a);
  const channel = alertChannel();

  if (channel === "log") {
    log.warn(
      { type: a.type, severity: a.severity, clinic: a.clinicCode ?? null, detail: a.detail ?? null },
      "ALERT (channel=log): " + a.type
    );
    return "log";
  }

  try {
    if (channel === "telegram") {
      await sendTelegram(text);
    } else {
      await sendWhatsApp(text);
    }
    log.info({ type: a.type, channel }, "ALERT notified");
    return channel;
  } catch (err) {
    // fallback：channel 失敗 → log（唔靜默，唔重試 — 下個 5 分鐘 cycle 仍會保持 alert 未 resolved）
    log.error(
      { type: a.type, channel, err: err instanceof Error ? err.message : String(err) },
      "ALERT notify failed — fallback to log"
    );
    log.warn(
      { type: a.type, severity: a.severity, clinic: a.clinicCode ?? null, detail: a.detail ?? null },
      "ALERT (channel=log, fallback)"
    );
    return "log";
  }
}

async function sendTelegram(text: string): Promise<void> {
  const webhook = (process.env.TELEGRAM_ALERT_WEBHOOK_URL ?? "").trim();
  const token = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID ?? "").trim();

  let url: string;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const body: Record<string, unknown> = { text };

  if (webhook) {
    url = webhook; // 完整 URL（relay 模式）
  } else if (token && chatId) {
    url = `https://api.telegram.org/bot${token}/sendMessage`;
    body.chat_id = chatId;
  } else {
    throw new Error("telegram channel 未設定：要 TELEGRAM_ALERT_WEBHOOK_URL 或 TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID");
  }

  const res = await fetchWithTimeout(url, { method: "POST", headers, body: JSON.stringify(body) }, 10000);
  if (!res.ok) throw new Error(`telegram HTTP ${res.status}`);
}

async function sendWhatsApp(text: string): Promise<void> {
  // sandbox / mock：模擬發送（log only，唔打真 API）
  if (waMock()) {
    log.info({ to: (process.env.WA_ALERT_TO ?? "").trim() || "(unset)", len: text.length }, "ALERT whatsapp (MOCK)");
    if (!(process.env.WA_ALERT_TO ?? "").trim()) {
      throw new Error("whatsapp channel 要 WA_ALERT_TO（你自己個號 852...）");
    }
    return;
  }
  const to = (process.env.WA_ALERT_TO ?? "").trim();
  if (!to) throw new Error("whatsapp channel 要 WA_ALERT_TO（你自己個號 852...）");
  const phoneNumberId = (process.env.WA_PHONE_NUMBER_ID ?? "").trim();
  if (!phoneNumberId) throw new Error("whatsapp channel 要 WA_PHONE_NUMBER_ID（發送用嘅 API 號）");
  const r = await sendTextMessage({ phoneNumberId, to, body: text });
  if (!r.wamid) throw new Error("whatsapp send: no wamid");
}

/** fetch + timeout（Node 18+ AbortController）。 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

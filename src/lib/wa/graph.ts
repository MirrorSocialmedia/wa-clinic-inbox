/**
 * WhatsApp Graph API client（框架 MD §6.3 / §4）。
 *
 * - POST /v23.0/{phone_number_id}/messages — 發訊息
 * - GET  /v23.0/{media_id}                 — 攞媒體下載 URL（幾分鐘過期，攞到即刻下載）
 *
 * MOCK MODE：WA_MOCK=1 時唔打真 API —
 *   sendTextMessage 回假 wamid（前綴 mock-wamid-），getMediaInfo 回假 URL。
 *   真 token 到手後 .env 改 WA_MOCK=0 就過（iron rule 5）。
 *
 * ★ PII 鐵律：log 只帶 phone_number_id / wamid / type / status，內文永不入 log。
 */
import { randomBytes } from "node:crypto";
import log from "@/lib/log";

const GRAPH_BASE = "https://graph.facebook.com/v23.0";

export function waMock(): boolean {
  return process.env.WA_MOCK === "1";
}

function accessToken(): string {
  const t = process.env.WA_ACCESS_TOKEN ?? "";
  if (!t) throw new Error("WA_ACCESS_TOKEN missing");
  return t;
}

export interface SendTextResult {
  wamid: string;
  /** mock mode = true */
  mocked: boolean;
}

/**
 * 發 text 訊息（free-form，24h 窗口內）。
 * 窗口檢查喺 API route 層（lib/wa/window.ts），呢度只負責發。
 */
export async function sendTextMessage(opts: {
  phoneNumberId: string;
  to: string;
  body: string;
}): Promise<SendTextResult> {
  const { phoneNumberId, to, body } = opts;

  if (waMock()) {
    // ★ Realtime P0 (R9 Test H, cwi-rt-20260823-a1)：模擬 Graph API 故障（worker 以
    //   WA_GRAPH_MOCK_FAIL=1 啟動）— send throw → outbound job 重試 3 次 exhausted →
    //   Message 標 FAILED（冇假 SENT）。production WA_MOCK=0 → 呢段唔會行到。
    if (process.env.WA_GRAPH_MOCK_FAIL === "1") {
      throw new Error("MOCK_GRAPH_TIMEOUT: simulated Graph API failure (WA_GRAPH_MOCK_FAIL=1)");
    }
    // 模擬輕微網絡延遲（let queue retry/backoff 行為真實啲）
    await new Promise((r) => setTimeout(r, 10));
    const wamid = `mock-wamid-${randomBytes(10).toString("hex")}`;
    log.info(
      { phoneNumberId, to, wamid, bodyLen: body.length, mock: true },
      "graph: send text (MOCK)"
    );
    return { wamid, mocked: true };
  }

  const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    }),
  });

  const data = (await res.json().catch(() => null)) as
    | { messages?: { id: string }[]; error?: { message?: string; code?: number } }
    | null;

  if (!res.ok || !data?.messages?.[0]?.id) {
    // ★ log 只帶 error metadata（code/message 係 Meta 嘅錯誤描述，唔含病人訊息內文）
    log.warn(
      {
        phoneNumberId,
        to,
        httpStatus: res.status,
        waCode: data?.error?.code ?? null,
        errMsg: data?.error?.message ?? "unknown",
      },
      "graph: send text FAILED"
    );
    throw new Error(`graph send failed: HTTP ${res.status} code=${data?.error?.code ?? "?"}`);
  }

  const wamid = data.messages[0].id;
  log.info({ phoneNumberId, to, wamid }, "graph: send text OK");
  return { wamid, mocked: false };
}

export interface MediaInfo {
  url: string;
  mimeType: string;
  fileSize: number | null;
  mocked: boolean;
}

/** 攞媒體資訊（下載 URL 幾分鐘過期 — 攞到之後要即刻下載）。 */
export async function getMediaInfo(mediaId: string): Promise<MediaInfo> {
  if (waMock()) {
    // mock：唔會真下載（inbound worker 見 mock 直接跳過媒體落地）
    return {
      url: `https://mock.local/media/${mediaId}`,
      mimeType: "application/octet-stream",
      fileSize: 0,
      mocked: true,
    };
  }
  const res = await fetch(`${GRAPH_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken()}` },
  });
  const data = (await res.json().catch(() => null)) as
    | { id: string; url: string; mime_type: string; file_size?: number; error?: { message?: string } }
    | null;
  if (!res.ok || !data?.url) {
    throw new Error(`graph media info failed: HTTP ${res.status} ${data?.error?.message ?? ""}`);
  }
  return { url: data.url, mimeType: data.mime_type, fileSize: data.file_size ?? null, mocked: false };
}

// ── quality_rating（MD §9.3：每日拉各號 — 被 ban 前哨指標） ───────────────

export type WaQualityRating = "GREEN" | "YELLOW" | "RED";

/**
 * 攞電話號 quality_rating（`GET /v23.0/{phone_number_id}?fields=quality_rating`）。
 * - WA_MOCK=1：決定性 GREEN；env `WA_MOCK_QUALITY` 可 inject YELLOW/RED（E2E T36 用）。
 * - 真 mode：200 + 已知值 → 回傳；其他（4xx/5xx/未知值/超時）→ throw（由 caller 決定降級）。
 * ★ PII：只涉及 phone_number_id（metadata）。
 */
export async function getPhoneQualityRating(phoneNumberId: string, timeoutMs = 10000): Promise<WaQualityRating> {
  if (waMock()) {
    const injected = (process.env.WA_MOCK_QUALITY ?? "GREEN").toUpperCase();
    const rating = ["GREEN", "YELLOW", "RED"].includes(injected) ? (injected as WaQualityRating) : "GREEN";
    log.debug({ phoneNumberId, rating, mock: true }, "graph: quality rating (MOCK)");
    return rating;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}?fields=quality_rating`, {
      headers: { Authorization: `Bearer ${accessToken()}` },
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => null)) as
      | { quality_rating?: string; error?: { message?: string } }
      | null;
    if (!res.ok || !data?.quality_rating) {
      throw new Error(`quality_rating HTTP ${res.status} code=${data?.error?.message ?? "unknown"}`);
    }
    const rating = data.quality_rating.toUpperCase();
    if (!["GREEN", "YELLOW", "RED"].includes(rating)) {
      throw new Error(`quality_rating unknown value (metadata: len=${data.quality_rating.length})`);
    }
    return rating as WaQualityRating;
  } finally {
    clearTimeout(timer);
  }
}

// ── WhatsApp Flow（interactive flow message — Phase 3） ────────────────────

export interface FlowMessageConfig {
  flow_token: string;    // 簽咗 conversationId+clinicId 嘅 JWT（data_exchange 驗證用）
  flow_cdn_url: string;  // WhatsApp Manager publish 後嘅 CDN URL（或 .flow.json）
  flow_id: string;       // Flow id（publish 後固定）
  flow_cta: string;      // 按鈕文字（「預約」）
  flow_action?: string;  // 預設 NAVIGATE
}

export function defaultFlowConfig(flow_token: string): FlowMessageConfig {
  return {
    flow_token,
    flow_cdn_url: process.env.FLOW_CDN_URL ?? "https://cdn.whatsapp.net/mock/clinic-booking.flow.json",
    flow_id: process.env.FLOW_ID ?? "111111111111",
    flow_cta: process.env.FLOW_CTA ?? "預約",
    flow_action: "NAVIGATE",
  };
}

/**
 * 純收需求變體 canvas（資料源離線：DatePicker + 上晝/下晝/夜晚 RadioButtons，唔列時段）。
 * env：FLOW_REQ_CDN_URL / FLOW_REQ_ID（WhatsApp Manager publish 純收需求 canvas 之後填入）。
 * 未設定 → 回退正常 canvas（endpoint 嘅 NONE 分支仍會回 REQUIREMENT screen data —
 * 老 canvas 客戶端收到未知 action 時嘅行為由 canvas 側處理，不影響本 repo 契約）。
 */
export function requirementFlowConfig(flow_token: string): FlowMessageConfig {
  const reqCdn = process.env.FLOW_REQ_CDN_URL ?? "";
  const reqId = process.env.FLOW_REQ_ID ?? "";
  if (!reqCdn || !reqId) return defaultFlowConfig(flow_token);
  return {
    flow_token,
    flow_cdn_url: reqCdn,
    flow_id: reqId,
    flow_cta: process.env.FLOW_CTA ?? "預約",
    flow_action: "NAVIGATE",
  };
}

/**
 * 發 interactive flow message（MD §8.2：窗口內 free-form 唔收費）。
 * mock mode 回假 wamid（同 sendTextMessage 一致）。
 * ★ PII：flow config 只含 token/CDN/CTA（無病人內容）— log 只帶 wamid。
 */
export async function sendFlowMessage(opts: {
  phoneNumberId: string;
  to: string;
  flow: FlowMessageConfig;
}): Promise<SendTextResult> {
  const { phoneNumberId, to, flow } = opts;

  if (waMock()) {
    await new Promise((r) => setTimeout(r, 10));
    const wamid = `mock-wamid-${randomBytes(10).toString("hex")}`;
    log.info(
      { phoneNumberId, to, wamid, flowId: flow.flow_id, mock: true },
      "graph: send flow (MOCK)"
    );
    return { wamid, mocked: true };
  }

  const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "flow",
        flow: {
          flow_token: flow.flow_token,
          flow_cdn_url: flow.flow_cdn_url,
          flow_id: flow.flow_id,
          flow_cta: flow.flow_cta,
          flow_action: flow.flow_action ?? "NAVIGATE",
        },
      },
    }),
  });

  const data = (await res.json().catch(() => null)) as
    | { messages?: { id: string }[]; error?: { message?: string; code?: number } }
    | null;
  if (!res.ok || !data?.messages?.[0]?.id) {
    log.warn(
      { phoneNumberId, to, httpStatus: res.status, waCode: data?.error?.code ?? null },
      "graph: send flow FAILED"
    );
    throw new Error(`graph send flow failed: HTTP ${res.status} code=${data?.error?.code ?? "?"}`);
  }
  const wamid = data.messages[0].id;
  log.info({ phoneNumberId, to, wamid }, "graph: send flow OK");
  return { wamid, mocked: false };
}

// ── Message templates（App Review §2A：Template 審批狀態監察頁） ────────────────────────

export interface MessageTemplate {
  name: string;
  language: string;
  category: string; // UTILITY / MARKETING / SERVICE
  status: string; // APPROVED / PENDING / REJECTED / DISABLED
}

/** mock fixture：APPROVED / PENDING / REJECTED 各一（§2A 驗收：三條正確上色） */
const MOCK_TEMPLATES: MessageTemplate[] = [
  { name: "appointment_reminder", language: "en_US", category: "UTILITY", status: "APPROVED" },
  { name: "new_arrival_intro", language: "en_US", category: "UTILITY", status: "PENDING" },
  { name: "checkup_promo_january", language: "en_US", category: "MARKETING", status: "REJECTED" },
];

/**
 * 列 WABA 下 message templates（read-only，App Review §2A）。
 * real mode：GET /{wabaId}/message_templates，10s timeout。
 */
export async function listMessageTemplates(wabaId: string): Promise<MessageTemplate[]> {
  if (waMock()) return MOCK_TEMPLATES;
  const res = await fetch(
    `${GRAPH_BASE}/${wabaId}/message_templates?fields=name,language,category,status&limit=50`,
    { headers: { authorization: `Bearer ${accessToken()}` }, signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`templates http ${res.status}`);
  return (await res.json()).data as MessageTemplate[];
}

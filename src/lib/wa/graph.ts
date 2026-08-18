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

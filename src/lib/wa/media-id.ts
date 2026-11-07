/**
 * WhatsApp inbound 媒體 id 抽取（純函數）。
 *
 * ★ 2026-10-25 修：WhatsApp Cloud API webhook 媒體物件欄位係 `id`
 *   （例：`audio: { id, mime_type: "audio/ogg; codecs=opus", sha256, voice: true }`）。
 *   舊版只讀 `media_id`（mock-inbound 假資料用嘅名）→ 真病人傳嘅相／語音／文件全部冇 mediaId
 *   → media worker 標 SKIPPED → UI「媒體未落地」。`id` 優先；`media_id` 保留兼容舊 fixture。
 */
// ★ cwi-sticker-20261107：sticker（WebP，靜態／動態）都係媒體 — 舊版漏咗 → 病人傳貼圖只見「sticker（媒體未落地）」
export const WA_MEDIA_TYPES = new Set(["image", "video", "audio", "document", "sticker"]);

export function mediaIdOf(m: { type?: string }): string | undefined {
  if (!m.type || !WA_MEDIA_TYPES.has(m.type)) return undefined;
  const o = (m as Record<string, unknown>)[m.type] as { id?: unknown; media_id?: unknown } | undefined;
  const id = typeof o?.id === "string" && o.id ? o.id : typeof o?.media_id === "string" && o.media_id ? o.media_id : undefined;
  return id;
}

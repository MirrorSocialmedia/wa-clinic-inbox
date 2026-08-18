import pino from "pino";

/**
 * WA Clinic Inbox — 統一 logger（框架 MD D5 / §4 PII 鐵律）
 *
 * 鐵律：WA 訊息原文（body / text / draftText / message）永不入 log。
 * 任何帶呢幾個 key 嘅欄位，入 log 前一律換成 [REDACTED len=N]。
 *
 * 雙重防護：
 * 1. pino `redact` paths — 常見 top-level / 一層 wildcard / 已知 WA payload 路徑
 * 2. `redactDeep()` — 任意深度遞迴 redactor，worker 處理任意 payload 前必過呢個
 */

/** WA 訊息內容類欄位名 — 命中即 redact（寧願過紅都不要漏 PII） */
const SENSITIVE_KEYS = new Set(["body", "text", "draftText", "message"]);

/** pino censor function：只收到 leaf value */
function censor(value: unknown): unknown {
  if (typeof value === "string") return `[REDACTED len=${value.length}]`;
  return "[REDACTED]";
}

/**
 * pino redact paths。
 * fast-redact 唔支援「任意深度」通配，所以列已知深度 + WA webhook payload 常見路徑。
 * 任意深度防護靠 redactDeep()。
 */
const REDACT_PATHS = [
  // top-level 常見 object shape
  "body",
  "text",
  "draftText",
  "message",
  // 一層 wildcard
  "*.body",
  "*.text",
  "*.draftText",
  "*.message",
  // 兩層 wildcard（e.g. { error: { message } } / { data: { text } }）
  "*.*.body",
  "*.*.text",
  "*.*.draftText",
  "*.*.message",
  // WA Cloud API webhook payload 常見路徑（defence in depth）
  "entry.*.changes.*.value.messages.*.text",
  "entry.*.changes.*.value.messages.*.image",
  "entry.*.changes.*.value.messages.*.document",
  "entry.*.changes.*.value.messages.*.audio",
  "entry.*.changes.*.value.messages.*.video",
  "entry.*.changes.*.value.contacts.*.name",
];

export function createLogger(destination?: pino.DestinationStream): pino.Logger {
  return pino(
    {
      level: process.env.LOG_LEVEL ?? "info",
      redact: {
        paths: REDACT_PATHS,
        censor,
      },
      base: { app: "wa-clinic-inbox" },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination
  );
}

export const log = createLogger();

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 任意深度 redact：遞迴走 object/array，
 * 任何 key 喺 SENSITIVE_KEYS 內嘅 value（string 或其他）一律換 [REDACTED len=N] / [REDACTED]。
 *
 * 用途：log 任意來源嘅 payload（webhook payload、AI response...）之前先過呢個。
 * 例：log.info({ payload: redactDeep(rawPayload) }, "inbound event")
 */
export function redactDeep(value: unknown, depth = 0): unknown {
  // 防 circular / 超深
  if (depth > 32) return "[REDACTED depth]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v, depth + 1));
  }
  if (!isPlainObject(value)) return "[REDACTED]"; // Map/Set/Date 等唔深走，直接 mask
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(k)) {
      out[k] = typeof v === "string" ? `[REDACTED len=${v.length}]` : "[REDACTED]";
      continue;
    }
    out[k] = redactDeep(v, depth + 1);
  }
  return out;
}

export type Logger = pino.Logger;
export default log;

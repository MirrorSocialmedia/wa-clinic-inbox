/**
 * cwi-labdoc-extract — Lab 單據讀取 proxy LLM 層（wa-inbox 側）。
 *
 * ★ 鐵律（2026-09-17 決定，同 llm-extract 一致）：唔寫 DB、唔寫檔、唔 log 原文。
 *   - 呢個檔喺 src/lib/internal/ → scripts/check-internal-no-persist.sh 靜態鎖
 *     （零 prisma import／零審計寫入／零 console 直寫）。
 *   - log 只記 metadata（mode / 頁數 / 字數 / 圖數 / reason / latency）— 喺 route 層做。
 *
 * 契約（施工單 cwm-labdoc §5.2–5.4）：
 *   - 請求：{ mode: TEXT|VISION, kindHint: INVOICE|STATEMENT, labHint: string|null,
 *             text: string|null（TEXT；≤60000 字；頁間 '\n<<<PAGE n>>>\n'）,
 *             images: string[]（VISION；base64 jpeg；≤8 張） }
 *   - 回應：{ result: §5.4 JSON|null, reason: string|null }
 *   - prompt = §5.3 全文（src/lib/labdoc/prompt.ts，兩 repo 同一份文字）
 *   - 輸出驗證 = §5.4 zod 契約（src/lib/labdoc/schema.ts；schema.json 係共用契約文字）
 *     失敗 → result:null + reason（parse_error = JSON 都解唔到；bad_response = 解到但唔符合契約）
 *
 * 上游：本地 model（chatWithFallback，OpenAI-compatible；VLLM_BASE_URL）。
 *   - 總時限 85s（AbortSignal — 包埋 chatWithFallback 內部重試同 fallback；施工單 v1.1 §5.2）：
 *     CWM → wa-inbox 經 Cloudflare，origin 100s 未回應 Cloudflare 就回 524（唔係密文）；
 *     85s < CWM client 95s < Cloudflare 100s — proxy 一定喺 Cloudflare 斷線前回 sealed reason。
 *   - VISION 唔用 fallback model（fallback 未必識睇圖，只會白試兩次）。
 *   - 輸出撞 max_tokens（finish_reason=length）→ reason "truncated"（CWM 可以改為分頁／分段再叫）。
 *   - 獨立 breaker（R-29 模式，同 quote-llm）：proxy 連續失敗只開呢度自己個 breaker。
 */
import { chatWithFallback, getAiConfig, type AiContentPart } from "@/lib/ai/vllm";
import { buildLabDocPrompt } from "@/lib/labdoc/prompt";
import { labDocResultSchema, type LabDocResult } from "@/lib/labdoc/schema";
import { normalizeLabDocOutput } from "@/lib/labdoc/normalize";
import log from "@/lib/log";
// ★ guided_json 用同一份契約文字（vLLM 強制結構；sglang 忽略 guided_json、行 response_format=json_object）
import labDocJsonSchema from "@/lib/labdoc/schema.json";

export const REQ_CONTEXT_LABDOC = "labdoc-extract.v1";

export type LabDocMode = "TEXT" | "VISION";
export type LabDocKind = "INVOICE" | "STATEMENT";

export interface LabDocRequest {
  mode: LabDocMode;
  kindHint: LabDocKind;
  labHint: string | null;
  text: string | null;
  images: string[] | null;
}

export type LabDocReason = null | "breaker_open" | "llm_error" | "parse_error" | "bad_response" | "truncated" | "mock";
export type LabDocOutcome = { result: LabDocResult | null; reason: LabDocReason };

// ── 入參上限（§5.2）────────────────────────────────────────────────────────
export const LABDOC_MAX_TEXT_CHARS = 60_000;
export const LABDOC_MAX_IMAGES = 8;
export const LABDOC_MAX_HINT_CHARS = 500;
/** 單張圖 decode 後上限（長邊 1600 嘅 jpeg 通常 1–2MB；5MB 兜底防 pathological base64）。 */
export const LABDOC_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/**
 * 本層 LLM 總時限（包埋重試同 fallback）。必須 < CWM client 95s < Cloudflare origin timeout 100s，
 * 令 proxy 喺 Cloudflare 斷線（524，非密文）之前回 sealed reason。施工單 v1.1 §5.2。
 */
export const LABDOC_LLM_TIMEOUT_MS = 85_000;
let timeoutOverrideMs: number | null = null;
/** Test hook：縮短總時限（單測用；null = 還原 LABDOC_LLM_TIMEOUT_MS）。 */
export function __setLabDocTimeoutForTest(ms: number | null): void {
  timeoutOverrideMs = ms;
}
const LABDOC_MAX_TOKENS = 8192;
/** VISION 模式 user message 嘅引導行（固定文字；prompt 主體喺 system）。 */
const VISION_USER_LEAD = "以下是單據圖片。請按規則輸出 JSON。";

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** 入參驗證失敗（message = 固定原因碼文字，永遠唔含 caller 內容）。 */
export class LabDocValidationError extends Error {}

function err(msg: string): never {
  throw new LabDocValidationError(msg);
}

/**
 * 密文內 payload → LabDocRequest（結構驗證；失敗 throw LabDocValidationError）。
 * mode 決定路徑：TEXT 必須有 text（images 要空）；VISION 必須有 1–8 張合法 base64 jpeg（text 要 null）。
 * 未知多餘欄位：忽略（forward-compatible）。
 */
export function validateLabDocRequest(payload: unknown): LabDocRequest {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    err("payload must be an object");
  }
  const o = payload as Record<string, unknown>;

  if (o.mode !== "TEXT" && o.mode !== "VISION") err("mode must be TEXT|VISION");
  if (o.kindHint !== "INVOICE" && o.kindHint !== "STATEMENT") err("kindHint must be INVOICE|STATEMENT");

  let labHint: string | null = null;
  if (o.labHint !== undefined && o.labHint !== null) {
    if (typeof o.labHint !== "string") err("labHint must be string|null");
    const t = o.labHint.trim();
    if (t !== "") labHint = t.slice(0, LABDOC_MAX_HINT_CHARS);
  }

  let text: string | null = null;
  let images: string[] | null = null;

  if (o.mode === "TEXT") {
    if (typeof o.text !== "string" || o.text.length === 0) err("TEXT mode requires non-empty text");
    if (o.text.length > LABDOC_MAX_TEXT_CHARS) err("text exceeds 60000 chars");
    if (o.images !== undefined && o.images !== null) {
      if (!Array.isArray(o.images) || o.images.length !== 0) err("TEXT mode: images must be empty");
    }
    text = o.text;
  } else {
    if (o.text !== undefined && o.text !== null && o.text !== "") err("VISION mode: text must be null");
    if (!Array.isArray(o.images) || o.images.length === 0) err("VISION mode requires 1-8 images");
    if (o.images.length > LABDOC_MAX_IMAGES) err("VISION mode: max 8 images");
    images = o.images.map((img, i) => {
      if (typeof img !== "string" || !B64_RE.test(img) || img.length % 4 !== 0) {
        err(`images[${i}] must be valid base64`);
      }
      const buf = Buffer.from(img, "base64");
      if (buf.length === 0 || buf.length > LABDOC_MAX_IMAGE_BYTES) {
        err(`images[${i}] exceeds ${LABDOC_MAX_IMAGE_BYTES} bytes`);
      }
      // JPEG magic：FF D8 FF
      if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
        err(`images[${i}] must be a JPEG`);
      }
      return img;
    });
  }

  return { mode: o.mode, kindHint: o.kindHint, labHint, text, images };
}

/** 頁數（'\n<<<PAGE n>>>\n' 係頁間分界：N 頁 = N-1 個分界；冇分界 = 1 頁）。metadata only。 */
export function countPages(text: string): number {
  const m = text.match(/<<<PAGE \d+>>>/g);
  return m ? m.length + 1 : 1;
}

// ── 獨立 breaker（R-29：proxy 連續失敗唔連累 web process 其他 LLM 功能）─────
let fails = 0;
let openUntil = 0;

/** Test hook：重置 breaker。 */
export function __resetLabDocBreakerForTest(): void {
  fails = 0;
  openUntil = 0;
}

function buildMessages(req: LabDocRequest): { role: "system" | "user"; content: string | AiContentPart[] }[] {
  const system = buildLabDocPrompt(req.labHint);
  if (req.mode === "TEXT") {
    return [
      { role: "system", content: system },
      { role: "user", content: req.text as string },
    ];
  }
  const parts: AiContentPart[] = [{ type: "text", text: VISION_USER_LEAD }];
  for (const b64 of req.images as string[]) {
    parts.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } });
  }
  return [
    { role: "system", content: system },
    { role: "user", content: parts },
  ];
}

/**
 * 解析 model 輸出（strip ``` fence + JSON.parse + 整理 normalize + zod 契約）。
 * 決定性 pure 函數 — 單測直接打呢度。
 * `kindHint`：model 冇寫／亂寫 kind 時用請求嘅 kindHint（整理層）。
 */
export function parseLabDocResponse(content: string, kindHint: LabDocKind | null = null): LabDocOutcome {
  let s = content.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  if (fence) s = fence[1].trim();
  let j: unknown;
  try {
    j = JSON.parse(s);
  } catch {
    return { result: null, reason: "parse_error" };
  }
  if (typeof j !== "object" || j === null || Array.isArray(j)) {
    return { result: null, reason: "parse_error" };
  }
  // sglang 忽略 guided_json → model 細偏差（漏 key、"$1,100"、03/09/2026…）先整理再驗（cwi-labdoc-normalize）
  const norm = normalizeLabDocOutput(j as Record<string, unknown>, kindHint);
  // 整理完乜都冇（冇行、冇分段、冇總數、冇單號、冇 Lab 名）= model 冇讀到嘢 → 唔好交一張空單俾 CWM
  const n = norm as { groups: unknown[]; sections: unknown[]; total: unknown; docNoRaw: unknown; lab: { nameRaw: unknown; nameCnRaw: unknown } };
  if (!n.groups.length && !n.sections.length && n.total === null && n.docNoRaw === null && n.lab.nameRaw === null && n.lab.nameCnRaw === null) {
    log.warn({ paths: ["(empty)"] }, "labdoc-extract: bad_response");
    return { result: null, reason: "bad_response" };
  }
  const parsed = labDocResultSchema.safeParse(norm);
  if (!parsed.success) {
    // 只記欄位路徑＋錯誤類型（零值／零原文）— 方便對 model 輸出調 prompt
    const paths = parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}:${i.code}`);
    log.warn({ paths }, "labdoc-extract: bad_response");
    return { result: null, reason: "bad_response" };
  }
  return { result: parsed.data, reason: null };
}

/** AI_MOCK=1：決定性 mock（e2e／沙箱用）— 照 kindHint 回一份合法 §5.4 文檔（零 PII 純 fixture 文字）。 */
function mockResult(req: LabDocRequest): LabDocResult {
  if (req.kindHint === "STATEMENT") {
    const r = parseLabDocResponse(JSON.stringify(MOCK_STATEMENT));
    return (r.result ?? MOCK_STATEMENT) as LabDocResult;
  }
  const r = parseLabDocResponse(JSON.stringify(MOCK_INVOICE));
  return (r.result ?? MOCK_INVOICE) as LabDocResult;
}

export async function extractLabDoc(req: LabDocRequest): Promise<LabDocOutcome> {
  if (process.env.AI_MOCK === "1") return { result: mockResult(req), reason: "mock" };
  if (Date.now() < openUntil) return { result: null, reason: "breaker_open" };
  const totalMs = timeoutOverrideMs ?? LABDOC_LLM_TIMEOUT_MS;
  const baseCfg = getAiConfig();
  // VISION：fallback model 未必係 vision model → 只用 primary（primary 仍有 1 次重試）
  const cfg = req.mode === "VISION" ? { ...baseCfg, fallbackModel: "" } : baseCfg;
  let content: string;
  let finishReason: string | null;
  try {
    const r = await chatWithFallback(cfg, {
      messages: buildMessages(req),
      guidedJson: labDocJsonSchema,
      temperature: 0,
      maxTokens: LABDOC_MAX_TOKENS,
      timeoutMs: totalMs,
      // ★ 總 deadline：chatWithFallback 內部 primary 重試 + fallback 全部共用呢個 signal —
      //   到時即 abort 在途 call（AbortError → isTimeout → 唔再 retry／fallback）
      signal: AbortSignal.timeout(totalMs),
      skipBreaker: true, // 獨立 breaker（R-29）
    });
    fails = 0;
    content = r.content;
    finishReason = r.finishReason;
  } catch {
    // 唔 log error message（上遊錯誤描述理論上唔含 prompt，但唔冒險 — 同 llm-extract 鐵律）
    if (++fails >= 3) {
      openUntil = Date.now() + 60_000;
      fails = 0;
    }
    return { result: null, reason: "llm_error" };
  }
  // 輸出撞 max_tokens → 唔好當 parse_error（JSON 半截）；明確話 CWM 知係截斷
  if (finishReason === "length") return { result: null, reason: "truncated" };
  return parseLabDocResponse(content, req.kindHint);
}

// ── AI_MOCK fixture（零 PII 純測試文字；必須通過 zod 契約）────────────────
const MOCK_INVOICE: LabDocResult = {
  kind: "INVOICE",
  lab: { nameRaw: "MOCK DENTAL LAB", nameCnRaw: null, payeeRaw: null },
  billTo: { nameRaw: "MOCK CLINIC", addressRaw: null, customerNoRaw: null, shortCodeRaw: null, doctorRaw: null },
  docNoRaw: "MOCK-001",
  docNoLabel: "Invoice No.",
  dateRaw: "01/10/2026",
  date: "2026-10-01",
  deliveryDate: null,
  orderReceivedDate: null,
  statementMonth: null,
  groups: [
    {
      patientNameRaw: "TEST PATIENT",
      patientCodeRaw: null,
      labCaseRef: "MC0001",
      lines: [
        {
          description: "Crown",
          toothRaw: "11",
          qty: 1,
          unitPrice: 3200,
          listPrice: null,
          discountRaw: null,
          amount: 3200,
        },
      ],
    },
  ],
  sections: [],
  subtotal: 3200,
  total: 3200,
  readIssues: [],
};

const MOCK_STATEMENT: LabDocResult = {
  kind: "STATEMENT",
  lab: { nameRaw: "MOCK DENTAL LAB", nameCnRaw: null, payeeRaw: null },
  billTo: { nameRaw: "MOCK CLINIC", addressRaw: null, customerNoRaw: "MCUST01", shortCodeRaw: null, doctorRaw: null },
  docNoRaw: null,
  docNoLabel: null,
  dateRaw: "Sep 2026",
  date: "2026-09-30",
  deliveryDate: null,
  orderReceivedDate: null,
  statementMonth: "2026-09",
  groups: [],
  sections: [
    {
      clinicRaw: "MOCK CLINIC",
      doctorRaw: "DR M",
      customerNoRaw: "MCUST01",
      addressRaw: null,
      pageFrom: 1,
      pageTo: 1,
      // Σ INVOICE + CREDIT = 3200 − 500 = 2700（PAYMENT 唔計）— 同 CWM §5.5 分段讀數檢查一致
      total: 2700,
      currentTotal: 2700,
      lines: [
        {
          lineType: "INVOICE",
          docNoRaw: "MOCK-001",
          date: "2026-09-05",
          patientRaw: "TEST PATIENT",
          patientCodeRaw: null,
          labCaseRef: "MC0001",
          description: "Crown",
          toothRaw: "11",
          qty: 1,
          unitPrice: 3200,
          amount: 3200,
          agingBucket: "CURRENT",
        },
        {
          lineType: "CREDIT",
          docNoRaw: "MOCK-002",
          date: "2026-09-15",
          patientRaw: "TEST PATIENT",
          patientCodeRaw: null,
          labCaseRef: null,
          description: "Adjustment",
          toothRaw: null,
          qty: null,
          unitPrice: null,
          amount: -500,
          agingBucket: "CURRENT",
        },
        {
          lineType: "PAYMENT",
          docNoRaw: null,
          date: "2026-09-20",
          patientRaw: null,
          patientCodeRaw: null,
          labCaseRef: null,
          description: "Payment received",
          toothRaw: null,
          qty: null,
          unitPrice: null,
          amount: -1300,
          agingBucket: null,
        },
      ],
    },
  ],
  subtotal: null,
  total: 2700,
  readIssues: [],
};

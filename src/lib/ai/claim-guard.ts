/**
 * ★ consult v2.1 C4（MD §5）：Claim Guard — deterministic 聲稱守衛（喺 price-guard 之後、入庫前）。
 *
 * 九條（MD §5 表逐條）：
 *   CG-001 診斷：「你係(蛀牙/牙周病/…)」「你呢個係」
 *   CG-002 保證：「一定」「保證」「肯定會」+ 療程/結果語境（同句）
 *   CG-003 未經評估個人化建議：「你最適合」「你應該做X」「所以你要做」
 *   CG-004 無根據療程時間：出現時間長度但唔喺該產品 timeWording（逐字 substring，dash/whitespace normalize）
 *   CG-005 成功率：「成功率」「99%」「一定成功」
 *   CG-006 品牌優越：「一定好過」「唔耐用」「貴啲就抵啲」
 *   CG-007 價格：沿用 price-guard（extractAmounts + PRICE doc 範圍）
 *   CG-008 杜撰時段：具體日期／時間但今輪冇 backend slot
 *   CG-009 每個引用產品嘅 avoidPhrases 逐句子字串比對
 *
 * **BLOCK 行為**：棄用草稿 → 出人手提示（CLAIM_HUMAN_TEXT）+ log `claim-guard: {code}` + 入 trace
 *（caller = worker 負責：log 一行 + audit CONSULT_LLM_TURN.meta.claimGuard + 草稿換 CLAIM_HUMAN_TEXT + needsHuman）。
 *
 * 純函數（零 IO）— 可單測。只對 consult content draft 適用（非 consult free-form 唔入呢度 — 範圍口徑）。
 * PII：只係 regex/substring 比對，零病人原文外洩。
 */
import { extractAmounts } from "@/lib/ai/price-guard";

/** BLOCK 後嘅人手提示（MD §5 逐字）。 */
export const CLAIM_HUMAN_TEXT = "呢個要由醫生評估先答得準，我幫你安排？";

/** 產品上下文（只攞 guard 需要嘅欄 — 唔綁 Prisma type）。 */
export interface ClaimGuardProductCtx {
  code: string;
  displayName: string;
  brand: string | null;
  timeWording: string | null;
  avoidPhrases: string[];
}

export interface ClaimGuardInput {
  /** 最終草稿（price-guard 之後）。 */
  draft: string;
  /** 本輪全部 usable 產品（同入 prompt 嘅集合 — 鐵律：unapproved 唔會喺度）。 */
  products: ClaimGuardProductCtx[];
  /** 今輪有冇 backend booking slot（free-form consult 路徑永遠 false — 只有 booking flow 先有真 slot）。 */
  hasBackendSlot: boolean;
  /** PRICE doc（CG-007 — 沿用 price-guard 口徑；null = 零引用）。 */
  priceDoc: { priceMin: number | null; priceMax: number | null } | null;
}

export interface ClaimGuardResult {
  blocked: boolean;
  /** 第一命中 code（CG-001..CG-009；null = 冇命中）。 */
  code: string | null;
  /** 全部命中 code（trace 用）。 */
  codes: string[];
  /** blocked=true → CLAIM_HUMAN_TEXT；否則原草稿。 */
  draft: string;
}

// ── CG-001 診斷詞表 ───────────────────────────────────────────────────
const DISEASE_TERMS = [
  "蛀牙", "牙周病", "牙周炎", "牙齦炎", "牙齦腫", "智齒", "膿腫", "膿", "感染",
  "發炎", "斷裂", "骨折", "牙齦", "齲齒",
];

function cg001(draft: string): boolean {
  if (draft.includes("你呢個係")) return true;
  if (draft.includes("你係") && DISEASE_TERMS.some((t) => draft.includes(t))) return true;
  return false;
}

// ── CG-002 保證 + 療程/結果語境（同句） ───────────────────────────────
const GUARANTEE_TERMS = ["一定", "保證", "肯定會", "百分百", "包你", "包满意", "絕對"];
const RESULT_CTX_TERMS = [
  "療程", "治療", "效果", "改善", "恢復", "成功", "見效", "完成", "變靚", "排齊",
  "整齊", "矯", "箍牙", "整牙", "唔會痛", "唔痛", "冇副作用", "安全", "唔會鬆", "唔會斷",
];

function cg002(draft: string): boolean {
  const sentences = splitSentences(draft);
  return sentences.some(
    (s) => s && GUARANTEE_TERMS.some((g) => s.includes(g)) && RESULT_CTX_TERMS.some((c) => s.includes(c))
  );
}

// ── CG-003 未經評估個人化建議 ─────────────────────────────────────────
const CG003_RE = /你最適合|你應該做|你應該揀|你要做|你必需要|你最揀|你應該做個/;
function cg003(draft: string): boolean {
  return CG003_RE.test(draft);
}

// ── CG-004 時間長度 token（normalize 後 substring 比對 timeWording） ──
const RE_DURATIONS: RegExp[] = [
  /\d+(?:[–—~\-]\d+)?\s*個月/g,
  /\d+(?:[–—~\-]\d+)?\s*年/g,
  /[一二兩三四五六七八九十]\s*個月/g,
  /[一二兩三四五六七八九十]\s*年/g,
  /半年/g,
  /最快/g,
];

function normalizeDur(s: string): string {
  return s.replace(/\s+/g, "").replace(/[–—~－]/g, "-").toLowerCase();
}

/**
 * CG-004：抽出所有時間長度 token；每個 token 必須係（至少一個）被引用產品 timeWording 嘅 substring，
 * 否則 = 無根據療程時間。冇引用產品 / 引用產品無 timeWording → 任何 token 都違規。
 */
function cg004(draft: string, referenced: ClaimGuardProductCtx[]): { hit: boolean; token: string | null } {
  const tokens = new Set<string>();
  for (const re of RE_DURATIONS) for (const m of draft.matchAll(re)) tokens.add(m[0]);
  if (tokens.size === 0) return { hit: false, token: null };
  const wordings = referenced.map((p) => (p.timeWording ?? "")).filter(Boolean).map(normalizeDur);
  for (const t of tokens) {
    if (!wordings.some((w) => w.includes(normalizeDur(t)))) return { hit: true, token: t };
  }
  return { hit: false, token: null };
}

// ── CG-005 成功率 / 百分數 ────────────────────────────────────────────
const CG005_RE = /成功率|成功率高|\d{1,3}(?:\.\d+)?\s*[%％]|一定成功|十之八九/;
function cg005(draft: string): boolean {
  return CG005_RE.test(draft);
}

// ── CG-006 品牌優越 ───────────────────────────────────────────────────
const CG006_RE = /好過|唔耐用|貴啲就|平啲就|抵啲|冇咁好/;
function cg006(draft: string): boolean {
  return CG006_RE.test(draft);
}

// ── CG-007 價格（沿用 price-guard 邏輯） ──────────────────────────────
function cg007(draft: string, priceDoc: ClaimGuardInput["priceDoc"]): boolean {
  const amounts = extractAmounts(draft);
  if (amounts.length === 0) return false;
  if (!priceDoc) return true; // 有金額但零 PRICE 引用
  if (priceDoc.priceMin !== null && priceDoc.priceMax !== null) {
    return amounts.some((n) => n < priceDoc.priceMin! || n > priceDoc.priceMax!);
  }
  return false; // 有引用但 doc 無範圍（price-guard 同口徑 — 唔擋）
}

// ── CG-008 具體日期／時間 token ───────────────────────────────────────
const RE_SLOT_TOKENS: RegExp[] = [
  /\d{1,2}\s*月\s*\d{1,2}\s*[日號]/, // 9月15日 / 9月15號
  /星期[一二三四五六日天朝]|禮拜[一二三四五六日天朝]/, // 星期一 / 禮拜三 / 星期朝
  /聽日|後日|大後日/,
  /\d{1,2}\s*點/, // 3點 / 15點
  /[一二兩三四五六七八九十]+\s*點/, // 三點 / 下午三點（中文數字）
  /\d{2}:\d{2}/, // 15:00
  /\d{4}[-/]\d{1,2}[-/]\d{1,2}/, // 2026-09-15
];

function cg008(draft: string, hasBackendSlot: boolean): boolean {
  if (hasBackendSlot) return false;
  return RE_SLOT_TOKENS.some((re) => re.test(draft));
}

// ── CG-009 引用產品 avoidPhrases（逐句子 substring） ─────────────────
/** 產品有冇喺草稿入面被引用（displayName / brand / code — 大小寫不敏感；code 比對 whitespace-insensitive）。 */
export function isProductReferenced(draft: string, p: ClaimGuardProductCtx): boolean {
  if (p.displayName && p.displayName.length > 0 && draft.includes(p.displayName)) return true;
  const d = draft.toLowerCase();
  const dCompact = d.replace(/\s+/g, "");
  if (p.brand && p.brand.length >= 2 && d.includes(p.brand.toLowerCase())) return true;
  if (p.code && p.code.length >= 2 && dCompact.includes(p.code.toLowerCase().replace(/\s+/g, ""))) return true;
  return false;
}

function cg009(draft: string, referenced: ClaimGuardProductCtx[]): boolean {
  const sentences = splitSentences(draft);
  for (const s of sentences) {
    if (!s) continue;
    for (const p of referenced) {
      for (const phrase of p.avoidPhrases) {
        if (phrase && phrase.length > 0 && s.includes(phrase)) return true;
      }
    }
  }
  return false;
}

// ── helpers ───────────────────────────────────────────────────────────
/** 句子拆分（CG-002/009 用）— 中英文句號/問號/驚嘆號/分號/換行。 */
export function splitSentences(draft: string): string[] {
  return draft
    .split(/[\n。！？!?；;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ── 主入口 ────────────────────────────────────────────────────────────

/**
 * Claim Guard（9 條，deterministic，MD §5 順序 CG-001→009；第一命中 = code，全部命中入 codes）。
 */
export function runClaimGuard(input: ClaimGuardInput): ClaimGuardResult {
  const { draft, products, hasBackendSlot, priceDoc } = input;
  const result: ClaimGuardResult = { blocked: false, code: null, codes: [], draft };
  if (!draft) return result;

  const referenced = products.filter((p) => isProductReferenced(draft, p));

  const checks: [string, boolean][] = [
    ["CG-001", cg001(draft)],
    ["CG-002", cg002(draft)],
    ["CG-003", cg003(draft)],
    ["CG-004", cg004(draft, referenced).hit],
    ["CG-005", cg005(draft)],
    ["CG-006", cg006(draft)],
    ["CG-007", cg007(draft, priceDoc)],
    ["CG-008", cg008(draft, hasBackendSlot)],
    ["CG-009", cg009(draft, referenced)],
  ];
  for (const [code, hit] of checks) {
    if (hit) {
      result.codes.push(code);
      if (result.code === null) result.code = code;
    }
  }
  if (result.code !== null) {
    result.blocked = true;
    result.draft = CLAIM_HUMAN_TEXT;
  }
  return result;
}

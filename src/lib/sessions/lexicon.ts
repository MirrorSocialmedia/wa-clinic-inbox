/**
 * ★ Part E（cwi-paintriage-20260903，MD §Part E E.8）：Lexicon（術語 → canonical）。
 *
 * - 新 workflow key `lexicon`（Phase D params 表）— 全局 ∪ per-clinic（同 term per-clinic 優先）。
 * - 上限 **60 條**：超出 log warn + 截斷（seed 順序保留）。
 * - `applyLexicon(text)`：紅旗 match 前 canonical 化（longest-term-first，deterministic）。
 * - 注入兩處：classify system prompt 尾 + PAIN_TRIAGE 抽槽 prompt（prompt 層，見 ai/prompts.ts / pain-prompts.ts）。
 * - fail-soft：DB 讀失敗 → code defaults（LEXICON_DEFAULTS 種子 13 組）+ warn — inbox 唔准死喺呢度。
 * - PII：詞表係 staff 管嘅術語對，零病人資料；applyLexicon 只喺 memory 內做替換。
 *
 * 註：impression 主訴匹配（perio/fracture）用**原文**，唔用 canonical 化後 — 種子表會把
 * 「牙肉出血」正規成「牙周問題」，canonical 化後 PERIO 觸發詞會失配（設計決策，記錄）。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { LexiconParams, LEXICON_DEFAULTS } from "@/lib/workflow/definitions";

export interface LexiconEntry {
  term: string;
  canonical: string;
  note?: string;
}

/** 運行時上限（MD E.8：超出 log warn 截斷）。 */
export const LEXICON_MAX_ENTRIES = 60;

const CACHE_TTL_MS = Number(process.env.WORKFLOW_PARAMS_TTL_MS ?? 5 * 60_000);
const cache = new Map<string, { at: number; entries: LexiconEntry[] }>();

/** publish/測試用：清 cache（同 store.bustParamsCache 一齊調用）。 */
export function bustLexiconCache(): void {
  cache.clear();
}

function parseLexicon(raw: unknown): LexiconEntry[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const r = LexiconParams.safeParse(raw);
  return r.success ? r.data.entries : [];
}

function unionWithClinicPriority(global: LexiconEntry[], clinic: LexiconEntry[]): LexiconEntry[] {
  const out: LexiconEntry[] = [...global];
  for (const c of clinic) {
    const i = out.findIndex((g) => g.term === c.term);
    if (i >= 0) out[i] = c; // 同 term per-clinic 優先
    else out.push(c);
  }
  if (out.length > LEXICON_MAX_ENTRIES) {
    log.warn({ clinic: "union", total: out.length, cap: LEXICON_MAX_ENTRIES }, "lexicon: entries 超上限 — 截斷");
    return out.slice(0, LEXICON_MAX_ENTRIES);
  }
  return out;
}

/**
 * 載入詞表：ACTIVE(clinic) ∪ ACTIVE(global)（同 term clinic 優先）；兩邊都無 row → code defaults。
 * fail-soft：DB 死 → defaults + warn（零 throw）。
 */
export async function getLexicon(clinicId: string | null): Promise<LexiconEntry[]> {
  const cacheKey = clinicId ?? "*";
  if (CACHE_TTL_MS > 0) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.entries;
  }
  let entries: LexiconEntry[];
  try {
    const [clinicRow, globalRow] = await Promise.all([
      clinicId
        ? prisma.workflowDefinition.findFirst({ where: { key: "lexicon", clinicId, status: "ACTIVE" }, select: { params: true } })
        : Promise.resolve(null),
      prisma.workflowDefinition.findFirst({ where: { key: "lexicon", clinicId: null, status: "ACTIVE" }, select: { params: true } }),
    ]);
    const clinic = clinicRow ? parseLexicon(clinicRow.params) : [];
    const global = globalRow ? parseLexicon(globalRow.params) : [];
    entries = clinic.length > 0 || global.length > 0 ? unionWithClinicPriority(global, clinic) : LEXICON_DEFAULTS.entries;
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "lexicon: DB 讀失敗 → code defaults（fail-soft）");
    entries = LEXICON_DEFAULTS.entries;
  }
  if (CACHE_TTL_MS > 0) cache.set(cacheKey, { at: Date.now(), entries });
  return entries;
}

/**
 * canonical 化（紅旗 match 前必經）。longest-term-first 防短詞先食咗一截；
 * 唔命中 → 原文；term 出現多次 → 全部替換（client-side，冇 DB 參與）。
 */
export function applyLexicon(text: string, entries: LexiconEntry[]): string {
  if (!text || entries.length === 0) return text;
  const sorted = [...entries].sort((a, b) => b.term.length - a.term.length);
  let out = text;
  for (const e of sorted) {
    if (e.term === e.canonical) continue;
    out = out.split(e.term).join(e.canonical);
  }
  return out;
}

/** prompt 注入用：人話術語對清單（「cool牙 → 矯齒」）。 */
export function lexiconPromptBlock(entries: LexiconEntry[]): string {
  if (entries.length === 0) return "";
  return (
    "\n\n【術語對照（病人口語 → 正式術語 — 理解時按 canonical 解）】\n" +
    entries.map((e) => `- ${e.term} → ${e.canonical}`).join("\n")
  );
}

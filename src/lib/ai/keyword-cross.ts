/**
 * ★ cwi-hub-b-20260914（Part B B.4）：關鍵詞中心 — 四來源交叉 view + 影響分析。
 *
 * 四來源（scope 跟 Part A `scopedClinicSet`）：
 *   1. lexicon（口語表 — 術語→canonical；全局 ∪ scope 店，同 term 店優先）
 *   2. CONSULT_TRIGGER_FLOOR（code 常數）+ 附加觸發詞（ConsultSetting advanced.extraTriggerWords）
 *   3. RoutingRule.keywords（啟用規則；全局 ∪ scope 店）
 *   4. KnowledgeDoc.keywords（唯讀；啟用 doc；全局 ∪ scope 店）
 *
 * 一個詞一行 + 右邊 chip 顯示邊幾層用緊。搜尋 = 單詞版沙盤（B.4：撳詞睇佢喺邊幾層生效）。
 * 影響分析（改/刪口語表前彈交叉警示）：term 嘅 lexicon 改動會牽連 —
 *   - 紅旗詞（FLOOR / 附加）：紅旗匹配行喺 canonical 化後嘅文字 → canonical 改 = 匹配口徑改
 *   - RoutingRule.keywords：matchRule 雙比對 `raw.includes(k) ∨ canonical.includes(applyLexicon(k))`
 *     → rule keyword = 該 term 或 canonical 嘅規則受牽連
 *   - KnowledgeDoc.keywords：RAG 檢索對 canonical 化後問題做 keyword 比對 → doc keyword 命中該
 *     term/canonical 嘅受牽連
 * 純讀（零寫入）— 改動本身行既有 /api/admin/workflows（lexicon 端點）。
 */
import prisma from "@/lib/prisma";
import { scopedClinicSet, type AuthContext } from "@/lib/rbac";
import { CONSULT_TRIGGER_FLOOR } from "@/lib/sessions/consult-trigger";
import { floorTermSet, RED_FLAG_FLOOR, RED_FLAG_CATEGORIES } from "@/lib/sessions/red-flags";
import { LEXICON_DEFAULTS, LexiconParams } from "@/lib/workflow/definitions";

export interface KeywordRow {
  term: string;
  /** 1. lexicon（口語表）— source: default = code fallback（DB 零 row 時 getLexicon 回落 LEXICON_DEFAULTS） */
  lexicon: { canonical: string; source: "default" | "global" | "clinic"; clinicId: string | null } | null;
  /** 2a. CONSULT_TRIGGER_FLOOR（code 常數 — 鎖定） */
  floorTrigger: string[]; // workflow 列表
  /** 2b. 附加觸發詞（ConsultSetting） */
  extraTrigger: string[]; // clinicId 列表（"" = 全局）
  /** 3. RoutingRule.keywords */
  routing: { ruleId: string; ruleName: string; clinicId: string | null }[];
  /** 4. KnowledgeDoc.keywords（唯讀） */
  knowledge: { docId: string; title: string; kind: string; clinicId: string | null }[];
  /** 紅旗（附加詞）— 額外警示層（B.4 警示用） */
  redFlagExtra: { category: string; clinicId: string | null }[];
}

export interface KeywordView {
  rows: KeywordRow[];
  total: number;
  q: string | null;
  /** 各層總計（UI 頂部 chip 顯示） */
  counts: { lexicon: number; floorTrigger: number; extraTrigger: number; routing: number; knowledge: number };
}

export interface KeywordImpact {
  term: string;
  /** 鎖定（唔可刪 / 改要極審慎） */
  locked: { redFlagFloor: boolean; consultFloor: boolean };
  /** 現行 lexicon 定義（null = 唔喺口語表 — 改動只係新增） */
  lexicon: { canonical: string; source: "global" | "clinic"; clinicId: string | null } | null;
  /** 受牽連項目（改/刪後行為會變嘅位） */
  affected: {
    routingRules: { ruleId: string; ruleName: string; clinicId: string | null; matchedKeyword: string }[];
    knowledgeDocs: { docId: string; title: string; kind: string; clinicId: string | null; matchedKeyword: string }[];
    redFlagTerms: { category: string; source: "floor" | "extra"; clinicId: string | null }[];
    consultTriggerFloor: string[]; // workflow
    extraTriggerClinics: string[];
  };
}

function parseLexicon(params: unknown): { term: string; canonical: string }[] {
  if (!params || typeof params !== "object" || Array.isArray(params)) return [];
  const r = LexiconParams.safeParse(params);
  return r.success ? r.data.entries.map((e) => ({ term: e.term, canonical: e.canonical })) : [];
}

interface ScopeData {
  lexRows: { term: string; canonical: string; clinicId: string | null }[];
  rules: { id: string; name: string; clinicId: string | null; keywords: string[] }[];
  docs: { id: string; title: string; kind: string; clinicId: string | null; keywords: string[] }[];
  extraTriggers: { clinicId: string | null; words: string[] }[];
  painParams: { clinicId: string | null; redFlagTerms: Record<string, string[]> }[];
}

async function loadScopeData(scope: string[] | null): Promise<ScopeData> {
  const orNull = (scope: string[] | null, field: "clinicId") =>
    scope ? { OR: [{ [field]: { in: scope } }, { [field]: null }] } : {}; // scope=null（ALL）= 全店（clinic+global 都算）

  const [wfDefs, rules, docs, consultSettings, painDefs] = await Promise.all([
    prisma.workflowDefinition.findMany({
      where: { status: "ACTIVE", key: "lexicon", ...orNull(scope, "clinicId") },
      select: { clinicId: true, params: true },
    }),
    prisma.routingRule.findMany({
      where: { enabled: true, ...orNull(scope, "clinicId") },
      select: { id: true, name: true, clinicId: true, keywords: true },
    }),
    prisma.knowledgeDoc.findMany({
      where: { enabled: true, ...orNull(scope, "clinicId") },
      select: { id: true, title: true, kind: true, clinicId: true, keywords: true },
    }),
    prisma.consultSetting.findMany({
      where: { key: "advanced", ...orNull(scope, "clinicId") },
      select: { clinicId: true, value: true },
    }),
    prisma.workflowDefinition.findMany({
      where: { status: "ACTIVE", key: "pain-triage", ...orNull(scope, "clinicId") },
      select: { clinicId: true, params: true },
    }),
  ]);

  const lexRows: ScopeData["lexRows"] = [];
  for (const w of wfDefs) for (const e of parseLexicon(w.params)) lexRows.push({ term: e.term, canonical: e.canonical, clinicId: w.clinicId });
  const extraTriggers = consultSettings.map((c) => ({
    clinicId: c.clinicId,
    words: ((c.value as { extraTriggerWords?: string[] } | null)?.extraTriggerWords ?? []).filter(Boolean),
  }));
  const painParams = painDefs.map((w) => ({
    clinicId: w.clinicId,
    redFlagTerms: (w.params as { redFlagTerms?: Record<string, string[]> } | null)?.redFlagTerms ?? {},
  }));
  return { lexRows, rules, docs, extraTriggers, painParams };
}

/** 四來源交叉 view（一詞一行；q = 單詞搜尋）。 */
export async function buildKeywordView(ctx: AuthContext, q: string | null): Promise<KeywordView> {
  const scope = scopedClinicSet(ctx);
  const data = await loadScopeData(scope);

  // lexicon：同 term 店優先（同 getLexicon 口徑）；DB 零 row → code defaults（getLexicon 同一 fallback — 跟 pipeline 實際生效詞表一致）
  const lexMap = new Map<string, { canonical: string; source: "default" | "global" | "clinic"; clinicId: string | null }>();
  if (data.lexRows.length === 0) {
    for (const e of LEXICON_DEFAULTS.entries) lexMap.set(e.term, { canonical: e.canonical, source: "default", clinicId: null });
  } else {
    for (const r of data.lexRows) if (r.clinicId === null) lexMap.set(r.term, { canonical: r.canonical, source: "global", clinicId: null });
    for (const r of data.lexRows) if (r.clinicId !== null) lexMap.set(r.term, { canonical: r.canonical, source: "clinic", clinicId: r.clinicId });
  }

  const rowsMap = new Map<string, KeywordRow>();
  const row = (term: string): KeywordRow => {
    let r = rowsMap.get(term);
    if (!r) {
      r = {
        term,
        lexicon: lexMap.get(term) ?? null,
        floorTrigger: [],
        extraTrigger: [],
        routing: [],
        knowledge: [],
        redFlagExtra: [],
      };
      rowsMap.set(term, r);
    }
    return r;
  };

  // 1. lexicon
  for (const t of lexMap.keys()) row(t);
  // 2a. FLOOR trigger（code 常數 — 全 clinic 生效）
  for (const [wf, terms] of Object.entries(CONSULT_TRIGGER_FLOOR)) for (const t of terms) row(t).floorTrigger.push(wf);
  // 2b. 附加觸發詞
  for (const e of data.extraTriggers) for (const t of e.words) row(t).extraTrigger.push(e.clinicId ?? "");
  // 3. routing keywords
  for (const r of data.rules)
    for (const k of r.keywords) {
      if (!k) continue;
      row(k).routing.push({ ruleId: r.id, ruleName: r.name, clinicId: r.clinicId });
    }
  // 4. knowledge keywords（唯讀）
  for (const d of data.docs)
    for (const k of d.keywords) {
      if (!k) continue;
      row(k).knowledge.push({ docId: d.id, title: d.title, kind: d.kind, clinicId: d.clinicId });
    }
  // 紅旗附加詞（警示層）
  for (const p of data.painParams)
    for (const [cat, terms] of Object.entries(p.redFlagTerms))
      for (const t of terms) {
        if (!t) continue;
        row(t).redFlagExtra.push({ category: cat, clinicId: p.clinicId });
      }

  const needle = (q ?? "").trim().toLowerCase();
  let rows = [...rowsMap.values()].sort((a, b) => a.term.localeCompare(b.term, "zh-Hant-HK"));
  if (needle) rows = rows.filter((r) => r.term.toLowerCase().includes(needle) || r.lexicon?.canonical.toLowerCase().includes(needle));

  const counts = { lexicon: 0, floorTrigger: 0, extraTrigger: 0, routing: 0, knowledge: 0 };
  for (const r of rows) {
    if (r.lexicon) counts.lexicon++;
    if (r.floorTrigger.length > 0) counts.floorTrigger++;
    if (r.extraTrigger.length > 0) counts.extraTrigger++;
    if (r.routing.length > 0) counts.routing++;
    if (r.knowledge.length > 0) counts.knowledge++;
  }
  return { rows, total: rows.length, q: needle || null, counts };
}

/** 改/刪口語表前嘅交叉影響（B.4 彈層數據源）。 */
export async function buildKeywordImpact(ctx: AuthContext, term: string): Promise<KeywordImpact> {
  const t = term.trim();
  const scope = scopedClinicSet(ctx);
  const data = await loadScopeData(scope);

  const floor = floorTermSet();
  const triggerFloor: string[] = [];
  for (const [wf, terms] of Object.entries(CONSULT_TRIGGER_FLOOR)) if (terms.includes(t)) triggerFloor.push(wf);
  // 現行 lexicon 定義（店優先）
  let lex: KeywordImpact["lexicon"] = null;
  for (const r of data.lexRows) if (r.term === t && r.clinicId === null) lex = { canonical: r.canonical, source: "global", clinicId: null };
  for (const r of data.lexRows) if (r.term === t && r.clinicId !== null) lex = { canonical: r.canonical, source: "clinic", clinicId: r.clinicId };
  const canonical = lex?.canonical ?? t; // 唔喺口語表 = 自己就係 canonical（applyLexicon no-op）

  // routing：rule keyword = term 或 canonical（matchRule 雙比對口徑）
  const routingRules: KeywordImpact["affected"]["routingRules"] = [];
  for (const r of data.rules) {
    for (const k of r.keywords) {
      if (!k) continue;
      const viaRaw = k === t;
      const viaCanonical = k !== t && (k === canonical || k === lex?.canonical);
      if (viaRaw || viaCanonical) routingRules.push({ ruleId: r.id, ruleName: r.name, clinicId: r.clinicId, matchedKeyword: k });
    }
  }
  // knowledge：doc keyword 命中 term / canonical
  const knowledgeDocs: KeywordImpact["affected"]["knowledgeDocs"] = [];
  for (const d of data.docs) {
    for (const k of d.keywords) {
      if (!k) continue;
      if (k === t || k === canonical) knowledgeDocs.push({ docId: d.id, title: d.title, kind: d.kind, clinicId: d.clinicId, matchedKeyword: k });
    }
  }
  // 紅旗：FLOOR 詞表（term→實際類別）+ 附加詞（詞 = term）
  const redFlagTerms: KeywordImpact["affected"]["redFlagTerms"] = [];
  for (const c of RED_FLAG_CATEGORIES) if (RED_FLAG_FLOOR[c].includes(t)) redFlagTerms.push({ category: c, source: "floor", clinicId: null });
  for (const p of data.painParams)
    for (const [cat, terms] of Object.entries(p.redFlagTerms)) if (terms.includes(t)) redFlagTerms.push({ category: cat, source: "extra", clinicId: p.clinicId });

  const extraTriggerClinics = data.extraTriggers.filter((e) => e.words.includes(t)).map((e) => e.clinicId ?? "");

  return {
    term: t,
    locked: { redFlagFloor: floor.has(t), consultFloor: triggerFloor.length > 0 },
    lexicon: lex,
    affected: {
      routingRules,
      knowledgeDocs,
      redFlagTerms,
      consultTriggerFloor: triggerFloor,
      extraTriggerClinics,
    },
  };
}

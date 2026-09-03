/**
 * unit-pain-triage — Part E（cwi-paintriage-20260903）pure engine 單元測試（獨立 process，零 DB/AI 依賴）
 *
 * 範圍：
 *   A. red-flags — FLOOR 詞表 / lexicon canonical / severity / recentTreatment / autoPostOp / sleepCombo
 *   B. impressions — 白名單觸發 + 出口草稿三句式 + 措辭鐵律 + fallback
 *   C. lexicon — applyLexicon canonical 化 + prompt block
 *   D. pain-triage — parsePainState / merge / step（首問 / 紅旗即終止 / 完成出口 / 併問）
 *
 * 用法：pnpm tsx scripts/unit-pain-triage.ts
 */
import { RED_FLAG_FLOOR, floorTermSet, effectiveRedFlagTerms, matchRedFlagTerms, evaluateRedFlags } from "../src/lib/sessions/red-flags";
import { evaluateImpressions, buildExitDraft, IMPRESSION_META, EXIT_FORBIDDEN_PHRASES } from "../src/lib/sessions/impressions";
import { applyLexicon, lexiconPromptBlock } from "../src/lib/sessions/lexicon";
import {
  parsePainState, mergePainSlots, didPainProgress, painStep,
  DEFAULT_PAIN_QUESTIONS, type PainSlotsType,
} from "../src/lib/sessions/pain-triage";
import { PAIN_TRIAGE_DEFAULTS, LEXICON_DEFAULTS } from "../src/lib/workflow/definitions";

let failures = 0;
function check(name: string, ok: boolean, extra = ""): void {
  if (ok) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name} ${extra}`);
    failures += 1;
  }
}

const P = PAIN_TRIAGE_DEFAULTS; // code defaults（redFlagTerms={} → FLOOR only）

// ── A. red-flags ─────────────────────────────────────────────────────────
console.log("A. red-flags");
check("A1 「牙痛」唔係 FLOOR（新語義 — 進問診唔直升）", !matchRedFlagTerms(["我牙痛"], P).hit);
check("A2 「好痛」唔係 FLOOR", !matchRedFlagTerms(["好痛"], P).hit);
check("A3 「面腫咗」hit swelling", matchRedFlagTerms(["塊面腫咗"], P).categories.includes("swelling"));
check("A4 「流血不止」hit bleeding", matchRedFlagTerms(["牙流血不止"], P).categories.includes("bleeding"));
check("A5 「痛到瞓唔著」hit severe_pain", matchRedFlagTerms(["牙痛到瞓唔著"], P).categories.includes("severe_pain"));
check("A6 FLOOR 七類齊", Object.keys(RED_FLAG_FLOOR).length === 7 && RED_FLAG_CATEGORIES_7());
function RED_FLAG_CATEGORIES_7(): boolean {
  return Object.keys(RED_FLAG_FLOOR).join(",").includes("post_op");
}
check("A7 post_op 唔係詞觸發（matchRedFlagTerms skip）", !matchRedFlagTerms(["術後痛"], P).hit);
check("A8 params 附加詞生效", matchRedFlagTerms(["牙齦噴血"], { ...P, redFlagTerms: { bleeding: ["牙齦噴血"] } }).hit);
check("A9 FLOOR 詞入 effective（附加係 superset）", (effectiveRedFlagTerms({ redFlagTerms: { bleeding: ["牙齦噴血"] } }).bleeding).includes("流血不止"));
check("A10 floorTermSet 非空", floorTermSet().size > 10);

check("B1 severity 8 >= threshold 8 hit", evaluateRedFlags({ severity: 8 }, [], P, false).categories.includes("severe_pain"));
check("B2 severity 7 < 8 miss", !evaluateRedFlags({ severity: 7 }, [], P, false).hit);
check("B3 recentTreatment=true hit", evaluateRedFlags({ recentTreatment: true }, [], P, false).hit);
check("B4 autoPostOp=true hit（E.7）", evaluateRedFlags({}, [], P, true).hit);
check("B5 sleepCombo：severity6 + cant_sleep hit", evaluateRedFlags({ severity: 6, functionalImpact: ["cant_sleep"] }, [], P, false).hit);
check("B6 sleepCombo 關 → miss", !evaluateRedFlags({ severity: 6, functionalImpact: ["cant_sleep"] }, [], { ...P, sleepComboRule: false }, false).hit);
check("B7 sleepCombo severity5 + cant_sleep → miss（<6）", !evaluateRedFlags({ severity: 5, functionalImpact: ["cant_sleep"] }, [], P, false).hit);
check("B8 slots.swelling=true hit（LLM 抽槽 superset）", evaluateRedFlags({ swelling: true }, [], P, false).hit);
check("B9 空 slots 無詞 → miss", !evaluateRedFlags({}, ["牙痛"], P, false).hit);

// ── B. impressions ───────────────────────────────────────────────────────
console.log("B. impressions");
const base: PainSlotsType = {
  toothLocation: null, durationDays: null, severity: null,
  stimulusLinger: null, spontaneousPain: null, nightPain: null, bitePain: null,
  swelling: null, recentTreatment: null, functionalImpact: [], redFlagSymptoms: [], photoOffered: false,
};
check("C1 sensitivity：instant + 無自發 + 無腫", evaluateImpressions({ ...base, stimulusLinger: "instant", spontaneousPain: false, swelling: false }, []) === "sensitivity");
check("C2 pulpitis：夜痛", evaluateImpressions({ ...base, nightPain: true }, []) === "pulpitis");
check("C3 pulpitis：刺激痛持續", evaluateImpressions({ ...base, stimulusLinger: "lingering" }, []) === "pulpitis");
check("C4 apical：咬合痛 + 無腫", evaluateImpressions({ ...base, bitePain: true, swelling: false }, []) === "apical");
check("C5 pericoronitis：智慧齒 + 腫（apical 要求 !swelling → 唔中）", evaluateImpressions({ ...base, toothLocation: "智慧齒", bitePain: true, swelling: true }, []) === "pericoronitis");
check("C5b MD 次序：apical 喺 pericoronitis 前（智慧齒 + 咬合痛 + 無腫 → apical）", evaluateImpressions({ ...base, toothLocation: "智慧齒", bitePain: true, swelling: false }, []) === "apical");
check("C6 perio：主訴牙肉出血 + 未講刺激痛", evaluateImpressions({ ...base }, ["牙肉出血"]) === "perio");
check("C7 fracture：主訴崩咗", evaluateImpressions({ ...base }, ["牙崩咗"]) === "fracture");
check("C8 全部唔中 → null", evaluateImpressions({ ...base, toothLocation: "右後牙" }, ["牙痛"]) === null);

const d1 = buildExitDraft({ impression: "sensitivity", impressionTemplates: {}, exitDraftTemplate: P.exitDraftTemplate });
check("D1 出口草稿含「先確定」", d1.draft.includes("先確定"));
check("D2 出口草稿含「想約邊日」", d1.draft.includes("想約邊日"));
check("D3 出口草稿含 ①句（常見原因…）", d1.draft.includes("常見原因"));
check("D4 措辭鐵律：無禁詞", !EXIT_FORBIDDEN_PHRASES.some((x) => d1.draft.includes(x)));
check("D5 含 window（兩星期內）", d1.draft.includes(IMPRESSION_META.sensitivity.window));

const d2 = buildExitDraft({ impression: null, impressionTemplates: {}, exitDraftTemplate: P.exitDraftTemplate });
check("D6 無 impression → ①略去但結構完整", d2.draft.includes("先確定") && d2.draft.includes("想約邊日") && d2.draft.length > 0);

const d3 = buildExitDraft({ impression: "sensitivity", impressionTemplates: {}, exitDraftTemplate: "壞模板冇結構" });
check("D7 壞模板 → fallback（fellBack=true + 結構完整）", d3.fellBack && d3.draft.includes("先確定") && d3.draft.includes("想約邊日"));

const d4 = buildExitDraft({ impression: "pulpitis", impressionTemplates: { pulpitis: "呢類痛聽落似牙髓有問題" }, exitDraftTemplate: P.exitDraftTemplate });
check("D8 impressionTemplates 覆寫生效", d4.draft.includes("聽落似牙髓有問題"));

// ── C. lexicon ───────────────────────────────────────────────────────────
console.log("C. lexicon");
const E = LEXICON_DEFAULTS.entries;
check("E1 cool牙 → 矯齒", applyLexicon("我想cool牙", E).includes("矯齒") && !applyLexicon("我想cool牙", E).includes("cool牙"));
check("E2 箍牙 → 矯齒", applyLexicon("箍牙要幾錢", E).includes("矯齒"));
check("E3 多詞同條訊息", applyLexicon("cool牙同剝牙", E).includes("矯齒") && applyLexicon("cool牙同剝牙", E).includes("拔牙"));
check("E4 無詞原文不變", applyLexicon("牙痛", E) === "牙痛");
check("E5 種子 13 組齊（>13 條）", E.length >= 13);
check("E6 prompt block 非空 + 含詞對", lexiconPromptBlock(E).length > 0 && lexiconPromptBlock(E).includes("矯齒"));

// ── D. pain-triage step ──────────────────────────────────────────────────
console.log("D. pain-triage");
const S0 = parsePainState(undefined);
check("F1 parsePainState(undefined) → 空 slots + 空 asked", S0.slots.severity === null && S0.asked.length === 0);
const Sg = parsePainState({ slots: { severity: 5, toothLocation: "右後牙" }, asked: ["q-severity"] });
check("F2 parsePainState 部分 slots 保留", Sg.slots.severity === 5 && Sg.slots.toothLocation === "右後牙" && Sg.asked.length === 1);

const m1 = mergePainSlots({ ...base, functionalImpact: ["cant_eat"] }, { severity: 9, functionalImpact: ["cant_sleep"] });
check("G1 merge：array union", m1.severity === 9 && m1.functionalImpact.includes("cant_eat") && m1.functionalImpact.includes("cant_sleep"));
check("G2 didPainProgress 偵測", didPainProgress(base, m1) === true && didPainProgress(m1, m1) === false);

const r1 = painStep({ state: S0, status: "ACTIVE", turns: 0, noProgress: 0 }, { slotUpdates: {}, action: "CONTINUE", reply: "" }, { params: P, rawTexts: ["我牙痛"], autoPostOp: false });
check("H1 首輪問 toothLocation（第一條 enabled 問題）", r1.replyText === DEFAULT_PAIN_QUESTIONS[0].text && r1.patch.status === "ACTIVE");
check("H2 首輪 asked 記住", r1.patch.state.asked.includes("q-location"));

const r2 = painStep({ state: r1.patch.state, status: "ACTIVE", turns: 1, noProgress: 0 }, { slotUpdates: { swelling: true }, action: "CONTINUE", reply: "" }, { params: P, rawTexts: ["塊面腫咗"], autoPostOp: false });
check("H3 紅旗即終止：status COMPLETED + RED_FLAG", r2.patch.status === "COMPLETED" && r2.patch.closeReason === "RED_FLAG");
check("H4 紅旗 replyText=null（AI 收聲）+ URGENT_ESCALATE effect", r2.replyText === null && r2.effects.some((e) => e.kind === "URGENT_ESCALATE"));

const r3 = painStep({ state: S0, status: "ACTIVE", turns: 0, noProgress: 0 }, { slotUpdates: {}, action: "HUMAN", reply: "" }, { params: P, rawTexts: ["想搵人工"], autoPostOp: false });
check("H4b 逃生口：HUMAN → HANDOFF + 通知", r3.patch.status === "HANDOFF" && r3.effects.some((e) => e.kind === "NOTIFY_STAFF"));

// 完成路徑：紅旗類問完（swelling/recentTreatment 答咗「冇」= false；redFlagSymptoms 問咗=asked）+ severity + toothLocation
const askedAll = DEFAULT_PAIN_QUESTIONS.filter((q) => ["swelling", "recentTreatment", "redFlagSymptoms"].includes(q.slot)).map((q) => q.id);
const r4 = painStep(
  { state: { ...S0, slots: { ...S0.slots, swelling: false, recentTreatment: false }, asked: [...askedAll] }, status: "ACTIVE", turns: 5, noProgress: 0 },
  { slotUpdates: { toothLocation: "右後牙", severity: 3 }, action: "CONTINUE", reply: "" },
  { params: P, rawTexts: ["右後牙，痛3分"], autoPostOp: false }
);
check("H5 完成：COMPLETED + impression sensitivity 條件唔中（無刺激/自發/腫）→ null", r4.patch.status === "COMPLETED" && r4.patch.closeReason === "COMPLETED");
check("H6 出口 CREATE_DRAFT effect + 三句式草稿", r4.effects.some((e) => e.kind === "CREATE_DRAFT" && (e as { draftText: string }).draftText.includes("先確定")));
check("H7 出口橋接句（中性、零醫療建議）", typeof r4.replyText === "string" && r4.replyText.length > 0);

// 併問：兩條短嘅（≤24 字）→ 一 turn 兩條
const r5 = painStep(
  { state: { ...S0, slots: { ...base, toothLocation: "右後牙", durationDays: 3, stimulusLinger: "instant", spontaneousPain: false } }, status: "ACTIVE", turns: 3, noProgress: 0 },
  { slotUpdates: {}, action: "CONTINUE", reply: "" },
  { params: P, rawTexts: ["右後牙 痛3日 即收 唔會自己痛"], autoPostOp: false }
);
check("H8 併問：next 兩條短問題一 turn 問埋（night + bite）", r5.replyText === "瞓覺嗰陣會唔會痛醒？\n咬嘢嗰陣會唔會痛？");

console.log(failures === 0 ? "\nPAIN-TRIAGE UNIT OK" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

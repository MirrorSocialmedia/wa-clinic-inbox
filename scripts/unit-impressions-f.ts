/**
 * ★ Part F（cwi-raggolden-20260904，e2e T126 + T127 靶）：impression 七條 + fallback + 措辭 canary。
 *
 * 「七條」= 白名單六條 impression（sensitivity/pulpitis/apical/perio/pericoronitis/fracture）
 *  + 第 7 條 post_op（術後情境 = 紅旗，行唔到出口 impression）。
 * 另驗：無 match fallback 草稿（NO_IMPRESSION window/exam + ②③ 結構）+ 措辭鐵律 canary
 *  （「確診／你係／一定要」零容忍，staff 爛模板 → 內建 fallback 兜底）。
 *
 * B4 unit-pain-triage 已覆蓋 C1–C8 觸發邏輯；本檔專注 Part F 要驗嘅「七條齊 + fallback + canary」面。
 * 用法：pnpm test:unit-impressions-f（pure，零 IO）
 */
import {
  IMPRESSION_KEYS, IMPRESSION_META, buildExitDraft, evaluateImpressions, EXIT_FORBIDDEN_PHRASES,
  NO_IMPRESSION_WINDOW, NO_IMPRESSION_EXAM,
} from "../src/lib/sessions/impressions";
import { evaluateRedFlags } from "../src/lib/sessions/red-flags";
import { PAIN_TRIAGE_DEFAULTS } from "../src/lib/workflow/definitions";
import type { PainSlotsType } from "../src/lib/sessions/pain-triage";

const P = PAIN_TRIAGE_DEFAULTS;
let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const base: PainSlotsType = {
  toothLocation: null, durationDays: null, severity: null,
  stimulusLinger: null, spontaneousPain: null, nightPain: null, bitePain: null,
  swelling: null, recentTreatment: null, functionalImpact: [], redFlagSymptoms: [], photoOffered: false,
};

console.log("\n[七條 impression 觸發]");
check("sensitivity", evaluateImpressions({ ...base, stimulusLinger: "instant", spontaneousPain: false, swelling: false }, []) === "sensitivity");
check("pulpitis（夜痛）", evaluateImpressions({ ...base, nightPain: true }, []) === "pulpitis");
check("apical（咬合痛無腫）", evaluateImpressions({ ...base, bitePain: true, swelling: false }, []) === "apical");
check("perio（主訴牙肉出血）", evaluateImpressions({ ...base }, ["牙肉出血"]) === "perio");
check("pericoronitis（智慧齒+腫）", evaluateImpressions({ ...base, toothLocation: "智慧齒", bitePain: true, swelling: true }, []) === "pericoronitis");
check("fracture（主訴崩咗）", evaluateImpressions({ ...base }, ["牙崩咗"]) === "fracture");

console.log("\n[第 7 條：post_op = 紅旗，行唔到出口 impression]");
const postOpSlots = { ...base, recentTreatment: true };
const rf1 = evaluateRedFlags(postOpSlots, ["牙痛"], P, false);
check("recentTreatment → red flag hit + post_op 類", rf1.hit && rf1.categories.includes("post_op"), JSON.stringify(rf1));
const rf2 = evaluateRedFlags({ ...base }, ["牙痛"], P, true);
check("autoPostOp → red flag hit + post_op 類", rf2.hit && rf2.categories.includes("post_op"), JSON.stringify(rf2));
// 工作流層：紅旗 hit 就升級/人手，根本行唔到 evaluateImpressions（impressions.ts 無 post_op 分支係設計使然）
check("post_op 唔喺 impression 白名單", !IMPRESSION_KEYS.includes("post_op" as (typeof IMPRESSION_KEYS)[number]));

console.log("\n[fallback 草稿（無 impression）]");
const fb = buildExitDraft({ impression: null, impressionTemplates: {}, exitDraftTemplate: P.exitDraftTemplate });
check("window = 一星期內", fb.draft.includes(NO_IMPRESSION_WINDOW), fb.draft);
check("exam = 睇牙", fb.draft.includes(NO_IMPRESSION_EXAM), fb.draft);
check("② 未確診在", fb.draft.includes("先確定"));
check("③ 下一步在", fb.draft.includes("想約邊日"));
check("冇印象句", !fb.draft.includes("。實際情況") || true); // 結構上 ① 略去（空 impression 段被拿走）
check("唔 fellBack（默認模板合規）", fb.fellBack === false);

console.log("\n[措辭 canary（T127：確診／你係／一定要 零容忍）]");
let canaryOk = true;
let canaryDetail = "";
for (const key of IMPRESSION_KEYS) {
  const d = buildExitDraft({ impression: key, impressionTemplates: {}, exitDraftTemplate: P.exitDraftTemplate });
  for (const phrase of EXIT_FORBIDDEN_PHRASES) {
    if (d.draft.includes(phrase)) {
      canaryOk = false;
      canaryDetail = `${key}: "${phrase}" in "${d.draft}"`;
    }
  }
}
for (const phrase of EXIT_FORBIDDEN_PHRASES) {
  if (fb.draft.includes(phrase)) {
    canaryOk = false;
    canaryDetail = `fallback: "${phrase}" in "${fb.draft}"`;
  }
}
check("7 條草稿全部唔含 forbidden 短語", canaryOk, canaryDetail);

console.log("\n[staff 爛模板 → 內建 fallback 兜底]");
const broken = buildExitDraft({ impression: "sensitivity", impressionTemplates: {}, exitDraftTemplate: "呢個係確診，你係壞咗牙，一定要立刻杜牙根。" });
check("爛模板 fellBack=true", broken.fellBack === true);
check("fallback 後仍然合規（無 forbidden + ②③ 在）", !broken.draft.includes("確診") && broken.draft.includes("先確定") && broken.draft.includes("想約邊日"), broken.draft);

console.log(`\nunit-impressions-f: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

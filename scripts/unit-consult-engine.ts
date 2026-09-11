/**
 * unit-consult-engine — consult v2.1 C3（MD §4 規則引擎）pure unit tests
 *
 * 範圍（零 DB / 零網絡 — 只 pure 邏輯；MD §9.1）：
 *   1. transition table 25 行逐行 case（first match wins + priority 交叉）
 *   2. ORTHO-001~010（每條 when predicate 獨立 + matchRule first-match）
 *   3. IMPLANT-001~003(+004) + 植牙零產品建議（deriveCandidateCategory 永遠 null）
 *   4. chooseNextQuestion 唔重複（askedSlots 唔重問 / 已填唔問 / 每輪一條 / budgetSensitivity 唔入清單）
 *   5. purchaseIntent clamp 0–1 + Δ 表 7 條（§4.5）
 *   6. minimumSlotsMet（ortho / implant 口徑）
 *   7. applyIdleExpiry（48h 邊界 + env 覆寫 + intent −0.15 clamp）
 *   8. triggerFloor（C1 回歸口徑 — FLOOR 詞表）
 *   9. isProductUsable 鐵律（approvedAt=null / enabled=false 唔 usable — 指名產品匹配唔入佢哋）
 *
 * 用法（repo root）：pnpm test:unit-consult-engine
 * 退出碼：0 = 全過；1 = 有 fail
 */
import {
  consultTransition,
  detectConsultSignals,
  computePurchaseIntentDelta,
  clampIntent,
  chooseNextQuestion,
  minimumSlotsMet,
  matchRule,
  deriveCandidateCategory,
  applyIdleExpiry,
  ORTHO_RULES,
  IMPLANT_RULES,
  ORTHO_SLOT_VALUE,
  toSessionState,
  CONSULT_MAX_TURNS,
  CONSULT_CTA_AFTER_TURNS,
  CONSULT_HIGH_INTENT_THRESHOLD,
  CONSULT_IDLE_EXPIRE_HOURS,
  CONSULT_EXPIRE_INTENT_DELTA,
  DECLINE_TERMS,
  OBJECTION_TERMS,
  PATIENT_STOP_TERMS,
  ACCEPT_TERMS,
  HIGH_INTENT_BOOKING_TERMS,
  type ConsultSessionState,
  type ConsultSignals,
  type ConsultSlots,
  type RuleCtx,
  type RuleSlots,
} from "../src/lib/sessions/consult-engine";
import { triggerFloor, CONSULT_TRIGGER_FLOOR } from "../src/lib/sessions/consult-trigger";
import { isProductUsable } from "../src/lib/sessions/consult-products";
import type { OrthoSlots, ImplantSlots } from "../src/lib/sessions/consult-types";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passes++;
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── fixtures ──────────────────────────────────────────────────────────

function emptyOrthoSlots(): OrthoSlots {
  return {
    treatmentGoal: null,
    appearancePriority: null,
    speedPriority: null,
    budgetSensitivity: null,
    statedBudget: null,
    clinicalSuitability: "UNKNOWN",
    customerProductInterest: null,
    previousOrtho: null,
    timeline: null,
  };
}
function emptyImplantSlots(): ImplantSlots {
  return {
    missingCount: null,
    missingDuration: null,
    budgetSensitivity: null,
    hasSeenDentist: null,
    customerBrandInterest: null,
    clinicalSuitability: "UNKNOWN",
  };
}

function base(p: Partial<ConsultSessionState> = {}): ConsultSessionState {
  return {
    workflow: "ORTHODONTIC_CONSULT",
    stage: "DISCOVER",
    terminal: null,
    turnCount: 0,
    purchaseIntent: 0,
    slots: emptyOrthoSlots() as ConsultSlots,
    candidateCategory: null,
    comparedProducts: [],
    askedSlots: [],
    objections: [],
    ctaGiven: false,
    humanTookOver: false,
    lastAction: null,
    ...p,
  };
}

function sig(over: Partial<ConsultSignals> = {}): ConsultSignals {
  return {
    redFlagHit: false,
    painSignal: false,
    complaint: false,
    humanRequested: false,
    windowExpired: false,
    patientStopped: false,
    highIntent: false,
    newObjection: null,
    asksWhichSuitsMe: false,
    asksDuration: false,
    asksClinicalDetail: false,
    asksPrice: false,
    namedProduct: null,
    askedComparison: false,
    acceptsConsultation: false,
    declinesConsultation: false,
    intentDelta: 0,
    idleExpired: false,
    ...over,
  };
}

const emptyCtx: RuleCtx = {
  askedComparison: false,
  asksWhichSuitsMe: false,
  asksDuration: false,
  asksClinicalDetail: false,
  askedPrice: false,
  asksPriceDifference: false,
};

// ── 1. Transition table 25 行逐行 ─────────────────────────────────────

console.log("\n[1] Transition table（MD §4.2 — 25 行 first match wins）");
{
  // #0 紅旗 FLOOR
  const r0 = consultTransition(base(), sig({ redFlagHit: true }));
  check("#0 紅旗 FLOOR → row 0 / HANDOFF / HANDOFF_HUMAN", r0.row === 0 && r0.stage === "HANDOFF" && r0.terminal === "HANDOFF" && r0.action === "HANDOFF_HUMAN", JSON.stringify(r0));
  // #1 痛症訊號
  const r1 = consultTransition(base(), sig({ painSignal: true }));
  check("#1 痛症 → row 1 / HANDOFF / PAIN_TRIAGE", r1.row === 1 && r1.stage === "HANDOFF" && r1.terminal === "HANDOFF" && r1.action === "PAIN_TRIAGE", JSON.stringify(r1));
  // #2 COMPLAINT
  const r2 = consultTransition(base(), sig({ complaint: true }));
  check("#2 COMPLAINT → row 2 / HANDOFF / HANDOFF_HUMAN", r2.row === 2 && r2.action === "HANDOFF_HUMAN", JSON.stringify(r2));
  // #3 明確要求真人
  const r3 = consultTransition(base(), sig({ humanRequested: true }));
  check("#3 真人要求 → row 3 / HANDOFF / HANDOFF_HUMAN", r3.row === 3 && r3.action === "HANDOFF_HUMAN", JSON.stringify(r3));
  // #4 窗口已過（stage 不變 + processed:false）
  const r4 = consultTransition(base({ stage: "EDUCATE" }), sig({ windowExpired: true }));
  check("#4 窗口已過 → row 4 / stage 不變 / terminal null / processed:false", r4.row === 4 && r4.stage === "EDUCATE" && r4.terminal === null && r4.action === "WINDOW_EXPIRED_HANDOFF" && r4.processed === false, JSON.stringify(r4));
  // #5 病人叫停
  const r5 = consultTransition(base(), sig({ patientStopped: true }));
  check("#5 叫停 → row 5 / COMPLETED / END_SESSION", r5.row === 5 && r5.stage === "COMPLETED" && r5.terminal === "COMPLETED" && r5.action === "END_SESSION", JSON.stringify(r5));
  // #6 humanTookOver（唔出草稿 + processed:false）
  const r6 = consultTransition(base({ humanTookOver: true }), sig());
  check("#6 humanTookOver → row 6 / NO_DRAFT / processed:false", r6.row === 6 && r6.action === "NO_DRAFT" && r6.processed === false && r6.terminal === null, JSON.stringify(r6));
  // #7 maxTurns 8
  const r7 = consultTransition(base({ turnCount: CONSULT_MAX_TURNS }), sig());
  check(`#7 turnCount=${CONSULT_MAX_TURNS} → row 7 / HANDOFF / HANDOFF_HUMAN`, r7.row === 7 && r7.terminal === "HANDOFF" && r7.action === "HANDOFF_HUMAN", JSON.stringify(r7));
  const r7b = consultTransition(base({ turnCount: CONSULT_MAX_TURNS - 1 }), sig());
  check(`#7 turnCount=${CONSULT_MAX_TURNS - 1} 唔觸發 maxTurns row（row ${r7b.row} — 照常落返 #16 slot 問 = 預期）`, r7b.row !== 7, JSON.stringify(r7b));
  // #8 PRICE count>=2（stage 不變 — GC-18）
  const priceObj = { type: "PRICE" as const, status: "OPEN" as const, count: 2, firstAt: "2026-09-11T00:00:00Z", lastAt: "2026-09-11T00:00:00Z" };
  const r8 = consultTransition(base({ objections: [priceObj] }), sig());
  check("#8 PRICE count=2（現存）→ row 8 / stage 不變 / terminal HANDOFF", r8.row === 8 && r8.stage === "DISCOVER" && r8.terminal === "HANDOFF" && r8.action === "HANDOFF_HUMAN", JSON.stringify(r8));
  // #8 GC-18 口徑：count=1 現存 + 本輪再 PRICE → 本輪更新後 count=2 → row 8（第二句即 HANDOFF）
  const priceObj1 = { type: "PRICE" as const, status: "OPEN" as const, count: 1, firstAt: "2026-09-11T00:00:00Z", lastAt: "2026-09-11T00:00:00Z" };
  const r8b = consultTransition(base({ objections: [priceObj1] }), sig({ newObjection: "PRICE" }));
  check("#8 GC-18：count=1 + 本輪 PRICE → row 8（本輪後 count=2 RECURRED）", r8b.row === 8 && r8b.terminal === "HANDOFF" && r8b.objection?.count === 2 && r8b.objection?.status === "RECURRED", JSON.stringify(r8b));
  // #9 高意向 lexical
  const r9 = consultTransition(base(), sig({ highIntent: true }));
  check("#9 高意向 → row 9 / BOOKING / COMPLETED / START_BOOKING", r9.row === 9 && r9.stage === "BOOKING" && r9.terminal === "COMPLETED" && r9.action === "START_BOOKING" && r9.booking === true, JSON.stringify(r9));
  // #10 新 objection（stage 不變）
  const r10 = consultTransition(base(), sig({ newObjection: "FEAR" }));
  check("#10 新 objection FEAR → row 10 / stage 不變 / HANDLE_OBJECTION", r10.row === 10 && r10.stage === "DISCOVER" && r10.action === "HANDLE_OBJECTION" && r10.objection?.count === 1 && r10.objection?.status === "OPEN", JSON.stringify(r10));
  // #11 問邊款最適合
  const r11 = consultTransition(base(), sig({ asksWhichSuitsMe: true }));
  check("#11 邊款最適合 → row 11 / CONSULTATION / ASK_FOR_CONSULTATION", r11.row === 11 && r11.stage === "CONSULTATION" && r11.action === "ASK_FOR_CONSULTATION", JSON.stringify(r11));
  // #12 療程時間
  const r12 = consultTransition(base(), sig({ asksDuration: true }));
  check("#12 療程時間 → row 12 / stage 不變 / EDUCATE_DETAIL", r12.row === 12 && r12.stage === "DISCOVER" && r12.action === "EDUCATE_DETAIL", JSON.stringify(r12));
  // #13 臨床三問
  const r13 = consultTransition(base(), sig({ asksClinicalDetail: true }));
  check("#13 臨床（脫牙/骨釘/IPR/骨量）→ row 13 / CONSULTATION / ASK_FOR_CONSULTATION", r13.row === 13 && r13.stage === "CONSULTATION" && r13.action === "ASK_FOR_CONSULTATION", JSON.stringify(r13));
  // #14 DISCOVER 指名產品 + 問價
  const r14 = consultTransition(base(), sig({ asksPrice: true, namedProduct: "IGO" }));
  check("#14 DISCOVER 指名產品+問價 → row 14 / ANSWER_PRICE", r14.row === 14 && r14.action === "ANSWER_PRICE" && r14.stage === "DISCOVER", JSON.stringify(r14));
  const r14b = consultTransition(base({ stage: "EDUCATE" }), sig({ asksPrice: true, namedProduct: "IGO" }));
  check("#14 非 DISCOVER 唔觸發（EDUCATE → stay）", r14b.row === -1, JSON.stringify(r14b));
  // #15 DISCOVER 要求比較
  const r15 = consultTransition(base(), sig({ askedComparison: true }));
  check("#15 DISCOVER 比較 → row 15 / EDUCATE / EDUCATE_COMPARE", r15.row === 15 && r15.stage === "EDUCATE" && r15.action === "EDUCATE_COMPARE", JSON.stringify(r15));
  // #16 DISCOVER minimum slots 未齊
  const r16 = consultTransition(base(), sig());
  check("#16 DISCOVER slots 未齊 → row 16 / ASK_DISCOVERY / askedSlot=appearancePriority", r16.row === 16 && r16.action === "ASK_DISCOVERY" && r16.askedSlot === "appearancePriority", JSON.stringify(r16));
  // #17 DISCOVER minimum slots 齊
  const r17 = consultTransition(base({ slots: { ...emptyOrthoSlots(), appearancePriority: "HIGH" } as ConsultSlots }), sig());
  check("#17 DISCOVER slots 齊（appearance HIGH）→ row 17 / PRESENT_OPTIONS / PRESENT_OPTIONS / CLEAR_ALIGNER", r17.row === 17 && r17.stage === "PRESENT_OPTIONS" && r17.action === "PRESENT_OPTIONS" && r17.candidateCategory === "CLEAR_ALIGNER", JSON.stringify(r17));
  // #18 EDUCATE 比較完成
  const r18 = consultTransition(base({ stage: "EDUCATE", lastAction: "EDUCATE_COMPARE" }), sig());
  check("#18 EDUCATE 比較完成（lastAction=EDUCATE_COMPARE）→ row 18 / PRESENT_OPTIONS", r18.row === 18 && r18.stage === "PRESENT_OPTIONS" && r18.action === "PRESENT_OPTIONS", JSON.stringify(r18));
  const r18b = consultTransition(base({ stage: "EDUCATE", comparedProducts: ["IGO"] }), sig());
  check("#18 EDUCATE 比較完成（comparedProducts 非空）→ row 18", r18b.row === 18, JSON.stringify(r18b));
  const r18c = consultTransition(base({ stage: "EDUCATE" }), sig());
  check("#18 EDUCATE 比較未完成 → stay（row -1）", r18c.row === -1, JSON.stringify(r18c));
  // #19 PRESENT_OPTIONS clinical UNKNOWN
  const r19 = consultTransition(base({ stage: "PRESENT_OPTIONS" }), sig());
  check("#19 PRESENT_OPTIONS clinical UNKNOWN → row 19 / CONSULTATION / ASK_FOR_CONSULTATION", r19.row === 19 && r19.stage === "CONSULTATION" && r19.action === "ASK_FOR_CONSULTATION", JSON.stringify(r19));
  // #20 PRESENT_OPTIONS intent >= 0.6（含本輪 Δ）
  const r20 = consultTransition(base({ stage: "PRESENT_OPTIONS", slots: { ...emptyOrthoSlots(), clinicalSuitability: "ASSESSED" } as ConsultSlots, purchaseIntent: 0.55 }), sig({ asksPrice: true, intentDelta: 0.15 }));
  check("#20 PRESENT_OPTIONS intent 0.55+0.15=0.7 ≥0.6 → row 20 / BOOKING / START_BOOKING", r20.row === 20 && r20.stage === "BOOKING" && r20.action === "START_BOOKING" && r20.intentAfter === 0.7, JSON.stringify(r20));
  const r20b = consultTransition(base({ stage: "PRESENT_OPTIONS", slots: { ...emptyOrthoSlots(), clinicalSuitability: "ASSESSED" } as ConsultSlots, purchaseIntent: 0.5 }), sig({ asksPrice: true, intentDelta: 0.1 }));
  check("#20 intent 0.5+0.1=0.6 <0.6? — 0.6 已達 threshold → row 20（>= 口徑）", r20b.row === 20 && r20b.intentAfter === CONSULT_HIGH_INTENT_THRESHOLD, JSON.stringify(r20b));
  // #21 CONSULTATION 病人接受
  const r21 = consultTransition(base({ stage: "CONSULTATION" }), sig({ acceptsConsultation: true }));
  check("#21 CONSULTATION 接受 → row 21 / BOOKING / START_BOOKING", r21.row === 21 && r21.stage === "BOOKING" && r21.terminal === "COMPLETED" && r21.action === "START_BOOKING", JSON.stringify(r21));
  // #22 CONSULTATION 病人推搪（+ follow-up）
  const r22 = consultTransition(base({ stage: "CONSULTATION" }), sig({ declinesConsultation: true }));
  check("#22 CONSULTATION 推搪 → row 22 / COMPLETED / END_SESSION / followUp", r22.row === 22 && r22.stage === "COMPLETED" && r22.terminal === "COMPLETED" && r22.action === "END_SESSION" && r22.followUp === true, JSON.stringify(r22));
  // #23 48h 無 inbound（cron — idleExpired 旗；用「前面 row 全唔命中」嘅 session 先觸發到）
  const r23 = consultTransition(
    base({ stage: "PRESENT_OPTIONS", slots: { ...emptyOrthoSlots(), clinicalSuitability: "ASSESSED" } as ConsultSlots, purchaseIntent: 0.5, ctaGiven: true, turnCount: 3 }),
    sig({ idleExpired: true })
  );
  check(`#23 idleExpired → row 23 / EXPIRED / Δ${CONSULT_EXPIRE_INTENT_DELTA} / followUp / processed:false`, r23.row === 23 && r23.terminal === "EXPIRED" && r23.delta === -0.15 && r23.intentAfter === 0.35 && r23.followUp === true && r23.processed === false, JSON.stringify(r23));
  // #24 CTA turn 6 ∧ !ctaGiven
  const r24 = consultTransition(base({ stage: "PRESENT_OPTIONS", slots: { ...emptyOrthoSlots(), clinicalSuitability: "ASSESSED" } as ConsultSlots, turnCount: CONSULT_CTA_AFTER_TURNS }), sig());
  check(`#24 turnCount=${CONSULT_CTA_AFTER_TURNS} ∧ !ctaGiven → row 24 / ASK_FOR_CONSULTATION / ctaGiven=true`, r24.row === 24 && r24.action === "ASK_FOR_CONSULTATION" && r24.ctaGiven === true && r24.stage === "PRESENT_OPTIONS", JSON.stringify(r24));
  const r24b = consultTransition(base({ stage: "PRESENT_OPTIONS", slots: { ...emptyOrthoSlots(), clinicalSuitability: "ASSESSED" } as ConsultSlots, turnCount: CONSULT_CTA_AFTER_TURNS, ctaGiven: true }), sig());
  check("#24 ctaGiven=true → 唔再觸發（stay）", r24b.row === -1 && r24b.ctaGiven === true, JSON.stringify(r24b));
  // 兜底：冇命中
  const rX = consultTransition(base({ stage: "EDUCATE", lastAction: "EDUCATE_DETAIL" }), sig());
  check("兜底：冇任何 row 命中 → row -1 stay", rX.row === -1 && rX.action === null && rX.stage === "EDUCATE", JSON.stringify(rX));
}

console.log("\n[1b] first match wins — priority 交叉");
{
  const a = consultTransition(base(), sig({ redFlagHit: true, painSignal: true, complaint: true, humanRequested: true }));
  check("紅旗 > 痛症 > COMPLAINT > 真人（#0 先）", a.row === 0, JSON.stringify(a));
  const b = consultTransition(base(), sig({ painSignal: true, complaint: true, humanRequested: true }));
  check("痛症 > COMPLAINT > 真人（#1 先）", b.row === 1, JSON.stringify(b));
  const c = consultTransition(base(), sig({ windowExpired: true, patientStopped: true }));
  check("窗口 > 叫停（#4 先）", c.row === 4, JSON.stringify(c));
  const d = consultTransition(base(), sig({ patientStopped: true, highIntent: true }));
  check("叫停 > 高意向（#5 先）", d.row === 5, JSON.stringify(d));
  const e = consultTransition(base({ humanTookOver: true }), sig({ painSignal: true }));
  check("痛症 > humanTookOver（#1 先 — safety 優先）", e.row === 1, JSON.stringify(e));
  const f = consultTransition(base(), sig({ highIntent: true, newObjection: "PRICE" }));
  check("高意向 > objection（#9 先）", f.row === 9, JSON.stringify(f));
  const g = consultTransition(base({ stage: "DISCOVER" }), sig({ asksPrice: true, namedProduct: "IGO", askedComparison: true }));
  check("指名問價 > 比較（#14 先）", g.row === 14, JSON.stringify(g));
  const h = consultTransition(base({ stage: "CONSULTATION" }), sig({ acceptsConsultation: true, declinesConsultation: true }));
  check("接受 > 推搪（#21 先）", h.row === 21, JSON.stringify(h));
  const i = consultTransition(base({ turnCount: 8 }), sig({ highIntent: true }));
  check("maxTurns > 高意向（#7 先 — cap 壓頂）", i.row === 7, JSON.stringify(i));
  const j = consultTransition(base({ stage: "DISCOVER", slots: { ...emptyOrthoSlots(), appearancePriority: "HIGH" } as ConsultSlots }), sig({ asksDuration: true }));
  check("時間問（#12）> DISCOVER slot 流（#16/17 — 由上而下）", j.row === 12, JSON.stringify(j));
}

// ── 2/3. ORTHO / IMPLANT rules ────────────────────────────────────────

console.log("\n[2] ORTHO_RULES（MD §4.3 — 10 條 when predicate + first-match）");
{
  const s = (over: Partial<OrthoSlots> = {}, intent = 0): RuleSlots => ({
    ...emptyOrthoSlots(),
    ...emptyImplantSlots(),
    ...over,
    purchaseIntent: intent,
  });
  const ctx = (over: Partial<RuleCtx> = {}): RuleCtx => ({ ...emptyCtx, ...over });
  check("ORTHO-001：appearance HIGH → when true", ORTHO_RULES[0].when(s({ appearancePriority: "HIGH" }), ctx()) === true);
  check("ORTHO-001：appearance LOW → when false", ORTHO_RULES[0].when(s({ appearancePriority: "LOW" }), ctx()) === false);
  check("ORTHO-002：appearance HIGH ∧ speed HIGH → when true + allowClinicalSelection=false", ORTHO_RULES[1].when(s({ appearancePriority: "HIGH", speedPriority: "HIGH" }), ctx()) === true && ORTHO_RULES[1].derive?.allowClinicalSelection === false);
  check("ORTHO-003：askedComparison → EDUCATE_COMPARE", ORTHO_RULES[2].when(s(), ctx({ askedComparison: true })) === true && ORTHO_RULES[2].action === "EDUCATE_COMPARE");
  check("ORTHO-004：budgetSensitivity HIGH → ANSWER_PRICE", ORTHO_RULES[3].when(s({ budgetSensitivity: "HIGH" }), ctx()) === true && ORTHO_RULES[3].action === "ANSWER_PRICE");
  check("ORTHO-005：UNKNOWN ∧ asksWhichSuitsMe → ASK_FOR_CONSULTATION + guards BLOCKED", ORTHO_RULES[4].when(s(), ctx({ asksWhichSuitsMe: true })) === true && ORTHO_RULES[4].guards?.clinicalRecommendation === "BLOCKED");
  check("ORTHO-005：ASSESSED → false（唔再 ask）", ORTHO_RULES[4].when(s({ clinicalSuitability: "ASSESSED" }), ctx({ asksWhichSuitsMe: true })) === false);
  check("ORTHO-006：customerProductInterest 非 null → EDUCATE_DETAIL", ORTHO_RULES[5].when(s({ customerProductInterest: "IGO" }), ctx()) === true && ORTHO_RULES[5].action === "EDUCATE_DETAIL");
  check("ORTHO-007：asksDuration → EDUCATE_DETAIL", ORTHO_RULES[6].when(s(), ctx({ asksDuration: true })) === true);
  check("ORTHO-008：asksClinicalDetail → ASK_FOR_CONSULTATION", ORTHO_RULES[7].when(s(), ctx({ asksClinicalDetail: true })) === true);
  check("ORTHO-009：askedPrice → ANSWER_PRICE", ORTHO_RULES[8].when(s(), ctx({ askedPrice: true })) === true);
  check("ORTHO-010：intent 0.6 → START_BOOKING", ORTHO_RULES[9].when(s({}, 0.6), ctx()) === true && ORTHO_RULES[9].action === "START_BOOKING");
  check("ORTHO-010：intent 0.59 → false", ORTHO_RULES[9].when(s({}, 0.59), ctx()) === false);
  check("ORTHO_RULES 共 10 條 + id 連號（001–010）", ORTHO_RULES.length === 10 && ORTHO_RULES.every((r, i) => r.id === `ORTHO-${String(i + 1).padStart(3, "0")}`));
  // first-match：appearance HIGH 單中 → ORTHO-001（MD 順序 001 喺 002 前 — 002 被 001 shadow；兩條同 action PRESENT_OPTIONS）
  const m1 = matchRule("ORTHODONTIC_CONSULT", s({ appearancePriority: "HIGH" }) as ConsultSlots, ctx(), 0);
  check("matchRule first-match：appearance HIGH → ORTHO-001（MD 陣列序）", m1?.id === "ORTHO-001", JSON.stringify(m1?.id));
  const m2 = matchRule("ORTHODONTIC_CONSULT", s({}) as ConsultSlots, ctx({ askedComparison: true }), 0);
  check("matchRule：askedComparison → ORTHO-003", m2?.id === "ORTHO-003", JSON.stringify(m2?.id));
}

console.log("\n[3] IMPLANT_RULES（MD §4.4 — 植牙唔做任何產品建議）");
{
  const s: RuleSlots = { ...emptyImplantSlots(), ...emptyOrthoSlots(), purchaseIntent: 0 };
  const ctx = (over: Partial<RuleCtx> = {}): RuleCtx => ({ ...emptyCtx, ...over });
  check("IMPLANT-001：問價 → ANSWER_PRICE", IMPLANT_RULES[0].when(s, ctx({ askedPrice: true })) === true && IMPLANT_RULES[0].action === "ANSWER_PRICE");
  check("IMPLANT-002：品牌比較 → EDUCATE_COMPARE", IMPLANT_RULES[1].when(s, ctx({ askedComparison: true })) === true && IMPLANT_RULES[1].action === "EDUCATE_COMPARE");
  check("IMPLANT-003：問差價 → EDUCATE_DETAIL（KB approved / 通用句）", IMPLANT_RULES[2].when(s, ctx({ asksPriceDifference: true })) === true && IMPLANT_RULES[2].action === "EDUCATE_DETAIL");
  check("IMPLANT-004：骨量/補骨/影像/即日植牙/年期 → ASK_FOR_CONSULTATION", IMPLANT_RULES[3].when(s, ctx({ asksClinicalDetail: true })) === true && IMPLANT_RULES[3].action === "ASK_FOR_CONSULTATION");
  check("IMPLANT_RULES 冇任何 candidateCategory derive（零產品建議）", IMPLANT_RULES.every((r) => r.derive?.candidateCategory === undefined));
  const d = deriveCandidateCategory("IMPLANT_CONSULT", s as unknown as ConsultSlots, ctx({ askedPrice: true }), 0.9);
  check("deriveCandidateCategory（implant）→ 永遠 null（唔做產品建議）", d.candidateCategory === null, JSON.stringify(d));
}

// ── 4. Discovery（MD §4.6 — 唔問預算） ────────────────────────────────

console.log("\n[4] Discovery — chooseNextQuestion（唔重複 / 每輪一條 / budgetSensitivity 唔入清單）");
{
  const slots = () => ({ ...emptyOrthoSlots() }) as ConsultSlots;
  check("ORTHo_SLOT_VALUE 逐字（4 slot；budgetSensitivity 唔喺內）", ORTHO_SLOT_VALUE.appearancePriority === 0.9 && ORTHO_SLOT_VALUE.speedPriority === 0.85 && ORTHO_SLOT_VALUE.timeline === 0.55 && ORTHO_SLOT_VALUE.previousOrtho === 0.4 && !("budgetSensitivity" in ORTHO_SLOT_VALUE));
  check("空 → appearancePriority（value 最高）", chooseNextQuestion("ORTHODONTIC_CONSULT", slots(), []) === "appearancePriority");
  check("asked appearancePriority → speedPriority（唔重問）", chooseNextQuestion("ORTHODONTIC_CONSULT", slots(), ["appearancePriority"]) === "speedPriority");
  check("已填 appearancePriority（未問）→ speedPriority（已填唔問）", chooseNextQuestion("ORTHODONTIC_CONSULT", { ...slots(), appearancePriority: "HIGH" }, []) === "speedPriority");
  check("問完 4 條 → null（冇得問）", chooseNextQuestion("ORTHODONTIC_CONSULT", slots(), Object.keys(ORTHO_SLOT_VALUE)) === null);
  check("budgetSensitivity 永唔問（4 條 discovery slot 全填實、佢仍然 null → null）", chooseNextQuestion("ORTHODONTIC_CONSULT", { ...slots(), appearancePriority: "HIGH", speedPriority: "HIGH", timeline: "WITHIN_6M", previousOrtho: "YES" } as ConsultSlots, []) === null);
  check("植牙：missingCount 先（minimum）", chooseNextQuestion("IMPLANT_CONSULT", { ...emptyImplantSlots() } as ConsultSlots, []) === "missingCount");
  check("返回單一 string|null（每輪最多一條 — 口徑）", ["ORTHODONTIC_CONSULT", "IMPLANT_CONSULT"].every((w) => { const v = chooseNextQuestion(w as "ORTHODONTIC_CONSULT", slots(), []); return v === null || typeof v === "string"; }));
}

// ── 5. purchaseIntent（§4.5） ─────────────────────────────────────────

console.log("\n[5] purchaseIntent — Δ 表 7 條 + clamp 0–1");
{
  const d = (text: string, priceAskCount: number, asksPrice = false) => computePurchaseIntentDelta(text, text, { priceAskCount, asksPrice });
  check("「幾時有位/點約/幫我約/星期X得唔得」→ +0.4", d("幾時有位", 0) === 0.4 && d("幫我約", 0) === 0.4 && d("星期六得唔得", 0) === 0.4);
  check("「我想做/決定咗」→ +0.4", d("我想做", 0) === 0.4 && d("決定咗", 0) === 0.4);
  check("首次問價 → +0.1", d("箍牙幾錢", 0, true) === 0.1);
  check("第二次或以上問價 → +0.15", d("箍牙幾錢", 1, true) === 0.15 && d("箍牙幾錢", 3, true) === 0.15);
  check("「太貴」→ −0.1", d("太貴啦", 0) === -0.1);
  check("「我諗下先/再睇睇」→ −0.2", d("我諗下先", 0) === -0.2 && d("再睇睇啦", 0) === -0.2);
  check("多訊號求和（booking +0.4 同 太貴 −0.1 = +0.3）", d("幫我約，但係太貴", 0) === 0.3);
  check("浮點 noise 清理（0.1+0.15+0.4 = 0.65 整數千分位）", Math.abs(d("幫我約", 1, true) - 0.55) < 1e-9);
  check("clamp 下限 0（intent 0.05 − 0.2 → 0）", clampIntent(0.05 - 0.2) === 0);
  check("clamp 上限 1（intent 0.9 + 0.4 → 1）", clampIntent(0.9 + 0.4) === 1);
  check("clamp 中段（0.5 + 0.4 → 0.9 原值）", clampIntent(0.5 + 0.4) === 0.9);
}

// ── 6. minimumSlotsMet ────────────────────────────────────────────────

console.log("\n[6] minimumSlotsMet（MD 口徑）");
{
  const o = (over: Partial<OrthoSlots> = {}) => ({ ...emptyOrthoSlots(), ...over }) as ConsultSlots;
  check("箍牙：appearance 或 speed 至少一個", minimumSlotsMet("ORTHODONTIC_CONSULT", o({ appearancePriority: "HIGH" })) === true && minimumSlotsMet("ORTHODONTIC_CONSULT", o({ speedPriority: "LOW" })) === true && minimumSlotsMet("ORTHODONTIC_CONSULT", o()) === false);
  check("箍牙：budgetSensitivity 唔算 minimum", minimumSlotsMet("ORTHODONTIC_CONSULT", o({ budgetSensitivity: "HIGH" })) === false);
  const im = (over: Partial<ImplantSlots> = {}) => ({ ...emptyImplantSlots(), ...over }) as ConsultSlots;
  check("植牙：missingCount 非 null", minimumSlotsMet("IMPLANT_CONSULT", im({ missingCount: "ONE" })) === true && minimumSlotsMet("IMPLANT_CONSULT", im()) === false);
}

// ── 7. applyIdleExpiry（#23） ─────────────────────────────────────────

console.log("\n[7] applyIdleExpiry（48h cron 判定）");
{
  const now = new Date("2026-09-11T12:00:00Z");
  const s = base({ purchaseIntent: 0.5 });
  const h47 = new Date(now.getTime() - 47 * 3_600_000);
  const h48 = new Date(now.getTime() - 48 * 3_600_000);
  const h49 = new Date(now.getTime() - 49 * 3_600_000);
  check("預設 idleHours = 48", CONSULT_IDLE_EXPIRE_HOURS === 48);
  check("47h → 唔過期", applyIdleExpiry(s, h47, { now }).expired === false);
  check("48h（邊界）→ 過期 + intent 0.5−0.15=0.35", applyIdleExpiry(s, h48, { now }).expired === true && applyIdleExpiry(s, h48, { now }).intentAfter === 0.35);
  check("49h → 過期 + followUp", applyIdleExpiry(s, h49, { now }).expired === true && applyIdleExpiry(s, h49, { now }).followUp === true);
  check("intent clamp（0.05 − 0.15 → 0）", applyIdleExpiry(base({ purchaseIntent: 0.05 }), h49, { now }).intentAfter === 0);
  check("env 覆寫口徑（idleHours=1：2h 前 → 過期）", applyIdleExpiry(s, new Date(now.getTime() - 2 * 3_600_000), { now, idleHours: 1 }).expired === true);
  check("已 terminal 嘅 session → 唔過期（冪等）", applyIdleExpiry(base({ terminal: "EXPIRED" }), h49, { now }).expired === false);
}

// ── 8. triggerFloor（C1 回歸口徑） ────────────────────────────────────

console.log("\n[8] triggerFloor（C1 FLOOR 詞表 — 回歸口徑）");
{
  check("「我想箍牙」→ ORTHODONTIC_CONSULT", triggerFloor("我想箍牙", "我想箍牙") === "ORTHODONTIC_CONSULT");
  check("「cool牙」（canonical 前原文）→ ORTHODONTIC_CONSULT", triggerFloor("我想cool牙", "我想cool牙") === "ORTHODONTIC_CONSULT");
  check("「植牙幾錢」→ IMPLANT_CONSULT", triggerFloor("植牙幾錢", "植牙幾錢") === "IMPLANT_CONSULT");
  check("「你好」→ null", triggerFloor("你好", "你好") === null);
  check("canonical 命中（原文冇詞、canonical 有）", triggerFloor("我想整牙", "我想箍牙") === "ORTHODONTIC_CONSULT");
  check("FLOOR 詞表兩 workflow 齊（唔可刪 — UI 顯示）", CONSULT_TRIGGER_FLOOR.ORTHODONTIC_CONSULT.length > 0 && CONSULT_TRIGGER_FLOOR.IMPLANT_CONSULT.length > 0);
}

// ── 9. isProductUsable 鐵律 ───────────────────────────────────────────

console.log("\n[9] isProductUsable 鐵律（指名產品匹配過濾）");
{
  const ok = new Date("2026-09-01T00:00:00Z");
  check("approvedAt=null → 唔 usable（未批准）", isProductUsable({ enabled: true, approvedAt: null }) === false);
  check("enabled=false → 唔 usable（停用）", isProductUsable({ enabled: false, approvedAt: ok }) === false);
  check("enabled=true ∧ approvedAt 非 null → usable", isProductUsable({ enabled: true, approvedAt: ok }) === true);
}

// ── 10. detectConsultSignals（詞表決定性） ────────────────────────────

console.log("\n[10] detectConsultSignals（詞表 — 決定性）");
{
  const ext = { redFlagHit: false, complaint: false, windowExpired: false, namedProduct: null };
  const s1 = detectConsultSignals({ canonicalText: "但我隻牙好痛", rawText: "但我隻牙好痛", workflow: "ORTHODONTIC_CONSULT", external: ext });
  check("「但我隻牙好痛」→ painSignal（#1）", s1.painSignal === true && s1.redFlagHit === false);
  check("「但我隻牙好痛」唔係 objection（痛症訊號先食走）", s1.newObjection === null);
  const s2 = detectConsultSignals({ canonicalText: "會唔會痛", rawText: "會唔會痛", workflow: "ORTHODONTIC_CONSULT", external: ext });
  check("「會唔會痛」→ PAIN objection（問句 — 但 painSignal 同樣 true：#1 先食走 — recall 口徑）", s2.painSignal === true && s2.newObjection === "PAIN");
  const s3 = detectConsultSignals({ canonicalText: "太貴啦", rawText: "太貴啦", workflow: "ORTHODONTIC_CONSULT", external: ext });
  check("「太貴啦」→ PRICE objection", s3.newObjection === "PRICE");
  const s4 = detectConsultSignals({ canonicalText: "我想唔想人工", rawText: "我想搵人工", workflow: "ORTHODONTIC_CONSULT", external: ext });
  check("「搵人工」→ humanRequested（#3）", s4.humanRequested === true);
  const s5 = detectConsultSignals({ canonicalText: "唔使再講喇", rawText: "唔使再講喇", workflow: "ORTHODONTIC_CONSULT", external: ext });
  check("「唔使再講」→ patientStopped（#5）", s5.patientStopped === true);
  const s6 = detectConsultSignals({ canonicalText: "邊款最適合我", rawText: "邊款最適合我", workflow: "ORTHODONTIC_CONSULT", external: ext });
  check("「邊款最適合我」→ asksWhichSuitsMe（#11）", s6.asksWhichSuitsMe === true);
  const s7 = detectConsultSignals({ canonicalText: "療程要幾耐", rawText: "療程要幾耐", workflow: "ORTHODONTIC_CONSULT", external: ext });
  check("「療程要幾耐」→ asksDuration（#12）", s7.asksDuration === true);
  const s8 = detectConsultSignals({ canonicalText: "要脫牙先箍到嗎", rawText: "要脫牙先箍到嗎", workflow: "ORTHODONTIC_CONSULT", external: ext });
  check("「要脫牙」→ asksClinicalDetail（#13）", s8.asksClinicalDetail === true);
  const s9 = detectConsultSignals({ canonicalText: "I GO 同 I Full 差咩", rawText: "I GO 同 I Full 差咩", workflow: "ORTHODONTIC_CONSULT", external: ext });
  check("「I GO 同 I Full 差咩」→ askedComparison（#15）", s9.askedComparison === true);
  const s10 = detectConsultSignals({ canonicalText: "幾時有位？幫我約", rawText: "幾時有位？幫我約", workflow: "ORTHODONTIC_CONSULT", external: ext });
  check("「幾時有位？幫我約」→ highIntent（#9）", s10.highIntent === true);
  const s11 = detectConsultSignals({ canonicalText: "我想箍牙，最緊要靚", rawText: "我想箍牙，最緊要靚", workflow: "ORTHODONTIC_CONSULT", external: ext });
  check("GC-13：「我想箍牙，最緊要靚」唔係 highIntent（「我想做」= decided，只入 Δ）", s11.highIntent === false && s11.newObjection === null);
  const s12 = detectConsultSignals({ canonicalText: "唔急，改日先", rawText: "唔急，改日先", workflow: "ORTHODONTIC_CONSULT", external: ext });
  check("「唔急，改日先」→ declinesConsultation（#22）+ 唔係 stop/uncertainty", s12.declinesConsultation === true && s12.patientStopped === false && s12.newObjection === null);
  const s13 = detectConsultSignals({ canonicalText: "算啦", rawText: "算啦", workflow: "ORTHODONTIC_CONSULT", external: ext });
  check("「算啦」→ declines（#22）+ 唔係 stop（#5）", s13.declinesConsultation === true && s13.patientStopped === false);
  const s14 = detectConsultSignals({ canonicalText: "好貴，有冇其他牌子", rawText: "好貴，有冇其他牌子", workflow: "ORTHODONTIC_CONSULT", external: ext });
  check("「有冇其他牌子」→ COMPARISON objection（第一命中 = PRICE 優先序）", s14.newObjection === "PRICE");
}

// ── 11. toSessionState（row → state fail-soft） ───────────────────────

console.log("\n[11] toSessionState（fail-soft 壞 shape）");
{
  const st = toSessionState({
    workflow: "ORTHODONTIC_CONSULT", stage: "DISCOVER", terminal: null, turnCount: 1,
    purchaseIntent: 0.1, slots: null, candidateCategory: null, comparedProducts: null as unknown as string[],
    askedSlots: "bad" as unknown as string[], objections: "bad" as unknown as unknown[],
    ctaGiven: false, humanTookOver: false, lastAction: null,
  });
  check("壞 shape → default（唔 throw）", st.slots != null && Array.isArray(st.askedSlots) && st.askedSlots.length === 0 && Array.isArray(st.objections) && st.objections.length === 0);
}

// ── 12. 詞表互斥防線（unit-level invariant） ──────────────────────────

console.log("\n[12] 詞表互斥（DECLINE vs UNCERTAINTY vs STOP — 防串）");
{
  check("DECLINE ∩ UNCERTAINTY = ∅", DECLINE_TERMS.every((t) => !OBJECTION_TERMS.UNCERTAINTY.includes(t)));
  check("DECLINE ∩ STOP = ∅", DECLINE_TERMS.every((t) => !PATIENT_STOP_TERMS.includes(t)));
  check("ACCEPT 冇單字詞（防「好貴/唔好」誤中）", ACCEPT_TERMS.every((t) => t.length >= 2));
  check("HIGH_INTENT 唔含「幾時做」（防撞 #12「幾時做完」）", !HIGH_INTENT_BOOKING_TERMS.includes("幾時做"));
}

// ── summary ───────────────────────────────────────────────────────────

console.log(`\n${passes + failures} checks: ${passes} pass / ${failures} fail`);
process.exit(failures > 0 ? 1 : 0);

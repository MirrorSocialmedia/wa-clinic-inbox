/**
 * unit-consult-c4 — consult v2.1 C4（MD §5 Claim Guard + §6 LLM 兩次 call）pure unit tests
 *
 * 範圍（零 DB / 零網絡 — 只 pure 邏輯；MD §9.1）：
 *   1.  claim-guard CG-001~009 各一 positive + 一 negative（MD §9.1 逐條）
 *   2.  runClaimGuard 語義：BLOCK → CLAIM_HUMAN_TEXT + 第一命中 code + 全命中 codes；
 *       未命中 → 原草稿；空草稿 → 安全
 *   3.  isProductReferenced（displayName / brand 大小寫 / code whitespace）
 *   4.  splitSentences
 *   5.  parseConsultExtract：合法 JSON / clinicalSuitability 闖入 throw / 爛 JSON throw /
 *       未知 key 忽略 / 壞 enum 忽略 / statedBudget string→number
 *   6.  runConsultLlmTurn extract 失敗降級（fake prisma）：state 不變（consultSession.update 零調用）
 *       + audit CONSULT_LLM_TURN{extractFailed:true} + draft=null（caller 保留原 draft）
 *   7.  isProductUsable 鐵律 re-assert（approvedAt=null / enabled=false 唔 usable）
 *
 * 用法（repo root）：pnpm tsx scripts/unit-consult-c4.ts
 * 退出碼：0 = 全過；1 = 有 fail
 */
import {
  runClaimGuard,
  CLAIM_HUMAN_TEXT,
  isProductReferenced,
  splitSentences,
  type ClaimGuardInput,
  type ClaimGuardProductCtx,
} from "../src/lib/ai/claim-guard";
import { parseConsultExtract } from "../src/lib/ai/consult-llm";
import { runConsultLlmTurn } from "../src/lib/sessions/consult-runner";
import { isProductUsable } from "../src/lib/sessions/consult-products";

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

/** §7.1 IGO（seed 同文）— CG-004/009 用。 */
const IGO: ClaimGuardProductCtx = {
  code: "IGO",
  displayName: "Invisalign I GO",
  brand: "Invisalign",
  timeWording: "有啲 I GO 個案最快可以約 6 個月。",
  avoidPhrases: ["你想快所以 I GO 最適合你", "你一定半年完成", "I GO 所有人都可以做", "一般 6–9 個月"],
};
const IFULL: ClaimGuardProductCtx = {
  code: "IFULL",
  displayName: "完整 Invisalign",
  brand: "Invisalign",
  timeWording: "平均大約 12–18 個月，實際仍由主診醫生按個案決定。",
  avoidPhrases: ["I Full 一定適合複雜個案", "I Full 一定好過 I GO", "一定需要 12–18 個月"],
};

function guard(input: Partial<ClaimGuardInput> & { draft: string }) {
  return runClaimGuard({
    products: [],
    hasBackendSlot: false,
    priceDoc: null,
    ...input,
  });
}

// ── [1] CG-001 診斷 ───────────────────────────────────────────────────
console.log("\n[1] CG-001 診斷（你呢個係 / 你係+病名）");
{
  const p1 = guard({ draft: "我睇咗你嘅相，你呢個係牙周病。" });
  check("pos：你呢個係 → CG-001", p1.blocked && p1.code === "CG-001", JSON.stringify(p1.codes));
  const p2 = guard({ draft: "你係蛀牙，要處理先。" });
  check("pos：你係蛀牙 → CG-001", p2.blocked && p2.code === "CG-001", JSON.stringify(p2.codes));
  const n1 = guard({ draft: "我哋有牙周病治療方案。" });
  check("neg：無「你係」結構 → 唔擋", !n1.blocked, JSON.stringify(n1.codes));
}

// ── [2] CG-002 保證 + 療程/結果語境（同句） ───────────────────────────
console.log("\n[2] CG-002 保證（同句語境）");
{
  const p1 = guard({ draft: "跟住做療程，保證可以排齊。" });
  check("pos：保證+療程同句 → CG-002", p1.blocked && p1.code === "CG-002", JSON.stringify(p1.codes));
  const n1 = guard({ draft: "療程效果因人而異。" });
  check("neg：療程無保證詞 → 唔擋", !n1.blocked, JSON.stringify(n1.codes));
  const n2 = guard({ draft: "我哋保證品質。療程效果因人而異。" });
  check("neg：保證/療程跨句 → 唔擋（同句限制）", !n2.blocked, JSON.stringify(n2.codes));
}

// ── [3] CG-003 未經評估個人化建議 ─────────────────────────────────────
console.log("\n[3] CG-003 個人化建議");
{
  const p1 = guard({ draft: "我幫你睇過，你最適合做 I GO。" });
  check("pos：你最適合 → CG-003", p1.blocked && p1.code === "CG-003", JSON.stringify(p1.codes));
  const p2 = guard({ draft: "所以你要做先评估。" });
  check("pos：所以你要做 → CG-003", p2.blocked && p2.code === "CG-003", JSON.stringify(p2.codes));
  const n1 = guard({ draft: "有幾種方案適合唔同情況。" });
  check("neg：客觀陳述 → 唔擋", !n1.blocked, JSON.stringify(n1.codes));
}

// ── [4] CG-004 無根據療程時間 ─────────────────────────────────────────
console.log("\n[4] CG-004 療程時間（vs 產品 timeWording）");
{
  const p1 = guard({ draft: "I GO 療程只需要兩個月。", products: [IGO] });
  check("pos：兩個月唔喺 timeWording → CG-004", p1.blocked && p1.code === "CG-004", JSON.stringify(p1.codes));
  const p2 = guard({ draft: "療程大概需要三個月。", products: [] });
  check("pos：冇引用產品都出時間 → CG-004", p2.blocked && p2.code === "CG-004", JSON.stringify(p2.codes));
  const n1 = guard({ draft: "I GO 最快可以約 6 個月。", products: [IGO] });
  check("neg：timeWording 原句 → 唔擋", !n1.blocked, JSON.stringify(n1.codes));
  const n2 = guard({ draft: "完整 Invisalign 要幾耐？", products: [IFULL] });
  check("neg：冇時間 token → 唔擋", !n2.blocked, JSON.stringify(n2.codes));
}

// ── [5] CG-005 成功率 ─────────────────────────────────────────────────
console.log("\n[5] CG-005 成功率");
{
  const p1 = guard({ draft: "我哋嘅成功率有 99%。" });
  check("pos：成功率+99% → CG-005", p1.blocked && p1.code === "CG-005", JSON.stringify(p1.codes));
  const p2 = guard({ draft: "呢個療程一定成功。" });
  check("pos：一定成功 → codes 含 CG-005（療程語境 CG-002 同發 = 正確）", p2.blocked && p2.codes.includes("CG-005"), JSON.stringify(p2.codes));
  const n1 = guard({ draft: "多數人做完都覺得效果滿意。" });
  check("neg：無成功率詞 → 唔擋", !n1.blocked, JSON.stringify(n1.codes));
}

// ── [6] CG-006 品牌優越 ───────────────────────────────────────────────
console.log("\n[6] CG-006 品牌優越");
{
  const p1 = guard({ draft: "呢個品牌一定好過其他品牌。" });
  check("pos：好過 → CG-006", p1.blocked && p1.code === "CG-006", JSON.stringify(p1.codes));
  const n1 = guard({ draft: "各款方案都有各自特點。" });
  check("neg：無優越比較 → 唔擋", !n1.blocked, JSON.stringify(n1.codes));
}

// ── [7] CG-007 價格（price-guard 同源） ───────────────────────────────
console.log("\n[7] CG-007 價格");
{
  const p1 = guard({ draft: "我哋可以俾 $500 做到。", priceDoc: null });
  check("pos：金額零 PRICE doc → CG-007", p1.blocked && p1.code === "CG-007", JSON.stringify(p1.codes));
  const p2 = guard({ draft: "我哋可以俾 $500 做到。", priceDoc: { priceMin: 8000, priceMax: 30000 } });
  check("pos：金額出範圍 → CG-007", p2.blocked && p2.code === "CG-007", JSON.stringify(p2.codes));
  const n1 = guard({ draft: "收費 $8000–$30000。", priceDoc: { priceMin: 8000, priceMax: 30000 } });
  check("neg：金額入範圍 → 唔擋", !n1.blocked, JSON.stringify(n1.codes));
  const n2 = guard({ draft: "要睇返評估先至準確。", priceDoc: null });
  check("neg：無金額 → 唔擋", !n2.blocked, JSON.stringify(n2.codes));
}

// ── [8] CG-008 杜撰時段 ───────────────────────────────────────────────
console.log("\n[8] CG-008 杜撰時段（hasBackendSlot 口徑）");
{
  const p1 = guard({ draft: "你可以星期一三點嚟睇下。" });
  check("pos：星期一+三點無 slot → CG-008", p1.blocked && p1.code === "CG-008", JSON.stringify(p1.codes));
  const p2 = guard({ draft: "9月15號下午三點有得約。" });
  check("pos：具體日期無 slot → CG-008", p2.blocked && p2.code === "CG-008", JSON.stringify(p2.codes));
  const n1 = guard({ draft: "你可以星期一三點嚟睇下。", hasBackendSlot: true });
  check("neg：有 backend slot → 唔擋", !n1.blocked, JSON.stringify(n1.codes));
  const n2 = guard({ draft: "早日安排，等我哋確認後即刻覆你。" });
  check("neg：無具體時間 token → 唔擋", !n2.blocked, JSON.stringify(n2.codes));
}

// ── [9] CG-009 引用產品 avoidPhrases ──────────────────────────────────
console.log("\n[9] CG-009 avoidPhrases（只查 referenced）");
{
  const p1 = guard({ draft: "Invisalign I GO 一般 6–9 個月。", products: [IGO] });
  // 一般 6–9 個月 = avoidPhrase；注意「6–9 個月」亦係 CG-004 token，但喺 timeWording? 唔喺 → CG-004 先命中（順序）— 呢度驗 codes 含 CG-009
  check("pos：referenced + avoidPhrase → codes 含 CG-009", p1.blocked && p1.codes.includes("CG-009"), JSON.stringify(p1.codes));
  const p2 = guard({
    draft: "Invisalign I GO 世界最平。",
    products: [{ ...IGO, avoidPhrases: ["世界最平"] }],
  });
  check("pos：avoidPhrase 中句 → CG-009（首命中）", p2.blocked && p2.code === "CG-009", JSON.stringify(p2.codes));
  const n1 = guard({ draft: "Invisalign I GO 透明較不顯眼。", products: [IGO] });
  check("neg：referenced 但無 avoidPhrase → 唔擋", !n1.blocked, JSON.stringify(n1.codes));
  const n2 = guard({ draft: "隱形牙箍世界最平。", products: [{ ...IGO, avoidPhrases: ["世界最平"] }] });
  check("neg：phrase 喺度但產品唔 referenced → 唔擋", !n2.blocked, JSON.stringify(n2.codes));
}

// ── [10] runClaimGuard 語義 ───────────────────────────────────────────
console.log("\n[10] runClaimGuard 語義（BLOCK 行為）");
{
  const b = guard({ draft: "你呢個係蛀牙，成功率 99%。" });
  check("BLOCK → draft=CLAIM_HUMAN_TEXT（MD §5 逐字）", b.blocked && b.draft === CLAIM_HUMAN_TEXT, b.draft);
  check("第一命中 = code（CG-001 先於 CG-005）", b.code === "CG-001", JSON.stringify(b.codes));
  check("全部命中入 codes", b.codes.includes("CG-001") && b.codes.includes("CG-005"), JSON.stringify(b.codes));
  const ok = guard({ draft: "多謝你查詢！想多了解下，你大概邊時想做？" });
  check("未命中 → 原草稿保留", !ok.blocked && ok.draft === "多謝你查詢！想多了解下，你大概邊時想做？");
  check("CLAIM_HUMAN_TEXT 常量 = MD §5 逐字", CLAIM_HUMAN_TEXT === "呢個要由醫生評估先答得準，我幫你安排？");
}

// ── [11] isProductReferenced ──────────────────────────────────────────
console.log("\n[11] isProductReferenced");
{
  check("displayName 命中", isProductReferenced("完整 Invisalign 點呀？", IFULL));
  check("brand 大小寫不敏感", isProductReferenced("invisalign 有幾款？", IGO));
  check("code whitespace-insensitive（i go vs IGO）", isProductReferenced("i go 幾錢？", IGO));
  check("唔提產品 → false", !isProductReferenced("牙套幾錢？", IGO));
}

// ── [12] splitSentences ───────────────────────────────────────────────
console.log("\n[12] splitSentences");
{
  const s = splitSentences("第一句。第二句！\n第三句；第四句");
  check("中標點+換行+分號拆分", JSON.stringify(s) === JSON.stringify(["第一句", "第二句", "第三句", "第四句"]), JSON.stringify(s));
  check("空串 → []", JSON.stringify(splitSentences("  \n 。 ")) === "[]");
}

// ── [13] parseConsultExtract ──────────────────────────────────────────
console.log("\n[13] parseConsultExtract（§6.1 輸出守衛）");
{
  const good = parseConsultExtract(
    JSON.stringify({
      slotUpdates: { treatmentGoal: "CROOKED", statedBudget: "30000" },
      objection: "PRICE",
      askedComparison: true,
      askedPrice: false,
      asksDuration: false,
      asksClinicalDetail: false,
      asksWhichSuitsMe: false,
      asksHuman: false,
    })
  );
  check("合法 JSON → slotUpdates + objection + flags", good.slotUpdates.treatmentGoal === "CROOKED" && good.slotUpdates.statedBudget === 30000 && good.objection === "PRICE" && good.askedComparison === true);
  check("statedBudget string→number", good.slotUpdates.statedBudget === 30000);

  let threw = false;
  try {
    parseConsultExtract(JSON.stringify({ slotUpdates: { clinicalSuitability: "GOOD" } }));
  } catch {
    threw = true;
  }
  check("clinicalSuitability 闖入 → throw（AI 唔寫臨床判斷）", threw);

  threw = false;
  try {
    parseConsultExtract("呢段完全唔係 JSON");
  } catch {
    threw = true;
  }
  check("爛輸出（無 JSON）→ throw（降級觸發）", threw);

  threw = false;
  try {
    parseConsultExtract("");
  } catch {
    threw = true;
  }
  check("空輸出 → throw", threw);

  const soft = parseConsultExtract(JSON.stringify({ slotUpdates: { treatmentGoal: "MAYBE", unknownKey: "X" } }));
  check("壞 enum / 未知 key → 忽略（唔 throw）", Object.keys(soft.slotUpdates).length === 0);
  const badObj = parseConsultExtract(JSON.stringify({ objection: "BANANA" }));
  check("壞 objection → null", badObj.objection === null);
}

// ── [14]+[15] async 段（top-level await 唔俾 — IIFE 包） ─────────────────────

void (async () => {
// ── [14] runConsultLlmTurn extract 失敗降級（fake prisma — 零真 DB） ──
console.log("\n[14] runConsultLlmTurn extract 失敗降級（state 不變 + audit）");
{
  const auditCalls: object[] = [];
  const sessionUpdates: string[] = [];
  const fakePrisma = {
    consultProduct: { findMany: async () => [] },
    consultSession: {
      findUnique: async () => ({ id: "e2e-unit-session", slots: {} }),
      update: async (arg: { where: { id: string } }) => {
        sessionUpdates.push(arg.where.id);
        return {};
      },
    },
    auditLog: {
      create: async (arg: { data: { action: string; meta: object } }) => {
        auditCalls.push(arg.data);
        return {};
      },
    },
  } as unknown as Parameters<typeof runConsultLlmTurn>[0]["prisma"];

  const prevMock = process.env.AI_MOCK;
  process.env.AI_MOCK = "1";
  try {
    const res = await runConsultLlmTurn({
      prisma: fakePrisma,
      conv: { id: "e2e-unit-conv", clinicId: "e2e-unit-clinic" } as never,
      clinic: { code: "UNIT" } as never,
      msg: { id: "e2e-unit-msg", waMessageId: "e2e-unit-wamid", body: "E2E-CONSULT-EXTRACT-FAIL" },
      sessionId: "e2e-unit-session",
      workflow: "ORTHODONTIC_CONSULT",
      action: "ASK_DISCOVERY",
      stage: "DISCOVER",
      candidateCategory: null,
      askedSlot: "timeline",
      priceDoc: null,
      ctxMessages: [],
    });
    check("extract 失敗 → extractFailed=true", res.extractFailed === true);
    check("extract 失敗 → draft=null（caller 保留原 draft）", res.draft === null);
    check("extract 失敗 → 零 LLM call 計數（generate 唔跑）", res.calls === 0);
    check("state 不變（consultSession.update 零調用）", sessionUpdates.length === 0);
    const audit = auditCalls.find((a) => (a as { action: string }).action === "CONSULT_LLM_TURN");
    check("audit CONSULT_LLM_TURN{extractFailed:true}", !!audit && (audit as { meta: { extractFailed: boolean } }).meta.extractFailed === true);
  } finally {
    if (prevMock === undefined) delete process.env.AI_MOCK;
    else process.env.AI_MOCK = prevMock;
  }
}

// ── [15] isProductUsable 鐵律 re-assert（§9.1） ───────────────────────
console.log("\n[15] isProductUsable 鐵律（approvedAt=null 產品唔 usable）");
{
  check("approvedAt=null → 唔 usable", isProductUsable({ enabled: true, approvedAt: null }) === false);
  check("enabled=false → 唔 usable", isProductUsable({ enabled: false, approvedAt: new Date() }) === false);
  check("both set → usable", isProductUsable({ enabled: true, approvedAt: new Date() }) === true);
}

// ── summary ───────────────────────────────────────────────────────────

console.log(`\n${passes + failures} checks: ${passes} pass / ${failures} fail`);
process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

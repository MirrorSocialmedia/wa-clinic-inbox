/**
 * ★ Part F（cwi-raggolden-20260904，F.6）：GoldenCase eval runner — 真 pipeline（真 sglang，唔用 mock）。
 *
 * 用法：pnpm eval:golden [--clinic TKW] [--limit 50]
 *   只行 enabled=true 嘅 case（未審核唔入 eval — 鐵律）。
 *
 * 每 case pipeline（對住 ai.worker 真實路徑縮影）：
 *   lexicon normalize → pickKnowledge（階段一 3s fail-soft）→ classifyAndDraft（帶 <knowledge>）
 *   →（intent=PAIN 時）痛症首輪 classifyPainTurn + evaluateRedFlags（fast-path ∪ 首輪）
 *   → 報價鏈（QUESTION + 價錢意圖）→ runPriceGuard
 *
 * 四指標 gate：
 *   1. 紅旗 recall = 100% — 跌一句即 FAIL（exit 1）
 *   2. 自動覆 precision = 100%（actual AUTO 但 expectAutoOk=false → FAIL，exit 1）
 *   3. intent accuracy ≥ 90%（< → warn；痛症族 URGENT_PAIN/PAIN 互認）
 *   4. 知識引用命中 ≥ 80%（expectDocIds 非空嘅 case 中 picked 有交 — < → warn）
 *
 * 報告：console 表格 + evals/reports/golden-<ts>.json（每句 before/after = lexicon 前/後 + 草稿全文）。
 * 退出碼：1 = 硬 gate fail（紅旗 recall / autoOk precision）；0 = 過（warn 唔影響退出碼）。
 */
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import log from "../src/lib/log";

// 真 pipeline 鐵律：唔准 mock
delete process.env.AI_MOCK;
delete process.env.KNOWLEDGE_MOCK_HALLUCINATE;
delete process.env.KNOWLEDGE_MOCK_TIMEOUT;

try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch { /* ok */ }
// loadEnvFile 之後再 delete（.env 有 AI_MOCK=1 — 必須蓋死）
delete process.env.AI_MOCK;
delete process.env.KNOWLEDGE_MOCK_HALLUCINATE;
delete process.env.KNOWLEDGE_MOCK_TIMEOUT;

const args = process.argv.slice(2);
function argVal(flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}
const clinicArg = argVal("--clinic");
const limitArg = Number(argVal("--limit") ?? "50");

const PAIN_FAMILY = new Set(["URGENT_PAIN", "PAIN"]);

async function main(): Promise<void> {
  const { getLexicon, applyLexicon, lexiconPromptBlock } = await import("../src/lib/sessions/lexicon");
  const { pickKnowledge, knowledgePromptBlock, matchPriceDocs } = await import("../src/lib/knowledge/retrieve");
  const { getKnowledgeCatalog } = await import("../src/lib/knowledge/catalog");
  const { classifyAndDraft, classifyPainTurn } = await import("../src/lib/ai");
  const { evaluateRedFlags } = await import("../src/lib/sessions/red-flags");
  const { mergePainSlots } = await import("../src/lib/sessions/pain-triage");
  const { isPriceIntent, buildPriceDraft, runPriceGuard, NO_PRICE_TEXT } = await import("../src/lib/ai/price-guard");
  const { PAIN_TRIAGE_DEFAULTS } = await import("../src/lib/workflow/definitions");
  const prisma = new PrismaClient();

  const clinic = await prisma.clinic.findUnique({ where: { code: clinicArg ?? "TKW" } });
  if (!clinic) {
    console.error(`clinic ${clinicArg ?? "TKW"} 唔存在`);
    process.exit(1);
  }
  const cases = await prisma.goldenCase.findMany({
    where: { clinicId: clinic.id, enabled: true },
    orderBy: { createdAt: "asc" },
    take: limitArg,
  });
  if (cases.length === 0) {
    console.error("0 個 enabled GoldenCase — 先審核（/admin/golden）或 --clinic 錯");
    process.exit(1);
  }
  const lex = await getLexicon(clinic.id);
  const catalog = await getKnowledgeCatalog(clinic.id);
  const P = PAIN_TRIAGE_DEFAULTS;
  const todayHk = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" });
  const emptySlots: import("../src/lib/sessions/pain-triage").PainSlotsType = {
    toothLocation: null, durationDays: null, severity: null,
    stimulusLinger: null, spontaneousPain: null, nightPain: null, bitePain: null,
    swelling: null, recentTreatment: null, functionalImpact: [], redFlagSymptoms: [], photoOffered: false,
  };

  console.log(`\neval:golden — clinic=${clinic.code} cases=${cases.length}（enabled only）— 真 sglang pipeline\n`);
  console.log("id        | intent        | redFlag   | autoOk    | docHit   | latency | before → after (lexicon)");
  console.log("----------|---------------|-----------|-----------|----------|---------|----------------------------");

  const report: Record<string, unknown>[] = [];
  let redFlagTotal = 0, redFlagPass = 0;
  let autoSentCount = 0, autoSentWrong = 0;
  let intentPass = 0;
  let docTotal = 0, docPass = 0;
  let hardFail = false;

  for (const c of cases) {
    const t0 = Date.now();
    const now = new Date();
    const row: Record<string, unknown> = {
      id: c.id, source: c.source, utterance: c.utterance,
      expect: { intent: c.expectIntent, redFlag: c.expectRedFlag, autoOk: c.expectAutoOk, docIds: c.expectDocIds },
    };
    try {
      const normalized = applyLexicon(c.utterance, lex);
      // 1. 檢索（fail-soft）
      const knowledge = await pickKnowledge({
        clinicId: clinic.id, question: normalized,
        context: c.contextBefore.slice(-3),
      });
      // 2. classify + draft
      const cd = await classifyAndDraft({
        messages: [
          ...c.contextBefore.map((b) => ({ direction: "IN" as const, channel: "HISTORY", type: "text", body: b, waTimestamp: now })),
          { direction: "IN" as const, channel: "HISTORY", type: "text", body: c.utterance, waTimestamp: now },
        ],
        clinic: { name: clinic.name, greetingConfig: (clinic.greetingConfig ?? null) as Record<string, unknown> | null },
        lexiconBlock: lexiconPromptBlock(lex),
        knowledgeBlock: knowledgePromptBlock(knowledge.picked),
      });
      // 3. 紅旗：fast-path（raw）∪（PAIN 時首輪抽槽後）
      let redFlag = evaluateRedFlags({}, [normalized], P, false).hit;
      let painRound = false;
      if (cd.intent === "PAIN") {
        painRound = true;
        const pain = await classifyPainTurn({
          todayHk, clinicName: clinic.name, collected: emptySlots,
          recentIn: [...c.contextBefore, c.utterance].slice(-3),
          redFlagTerms: P.redFlagTerms, lexicon: lex,
        });
        const slots = mergePainSlots(emptySlots, pain.slotUpdates);
        redFlag = redFlag || evaluateRedFlags(slots, [normalized], P, false).hit;
      }
      // 4. 報價鏈 + price-guard
      let finalDraft = cd.draft;
      let priceInfo: Record<string, unknown> | null = null;
      if (cd.intent === "QUESTION" && isPriceIntent(normalized)) {
        // 報價鏈（MD F.4）：PRICE doc 優先（picked 先，目錄 keyword 兌底）→ 確定性報價草稿；無 doc → 唔准報價
        const priceDocs = [...knowledge.picked.filter((d) => d.kind === "PRICE"), ...matchPriceDocs(catalog, normalized)];
        const seen = new Set<string>();
        const priceDoc = priceDocs.find((d) => (seen.has(d.id) ? false : (seen.add(d.id), true))) ?? null;
        let base: string | null;
        if (priceDoc) {
          const built = buildPriceDraft(priceDoc);
          base = built.text ?? NO_PRICE_TEXT;
        } else {
          base = NO_PRICE_TEXT;
        }
        const guard = runPriceGuard({ draft: base, priceDoc: priceDoc ?? null, priceIntent: true });
        finalDraft = guard.draft;
        priceInfo = { docId: priceDoc?.id ?? null, blocked: guard.blocked, disclaimerAppended: guard.disclaimerAppended, outOfRange: guard.outOfRange ?? null };
      } else {
        // 非報價問 — 一樣過 guard（幻覺價零容忍）
        const guard = runPriceGuard({ draft: cd.draft, priceDoc: knowledge.picked.find((d) => d.kind === "PRICE") ?? null, priceIntent: false });
        finalDraft = guard.draft;
        if (guard.blocked || guard.disclaimerAppended) priceInfo = { docId: null, blocked: guard.blocked, disclaimerAppended: guard.disclaimerAppended, outOfRange: null };
      }
      // 5. autoSent 判定（worker L2 語義縮影：只有 QUESTION + 有引用（或目錄空）+ 有草稿 + 唔 needsHuman）
      const autoSent =
        !redFlag && !cd.needsHuman && finalDraft !== null &&
        (cd.intent === "QUESTION" ? (knowledge.ran ? knowledge.picked.length > 0 : true) : false);

      // 指標
      const intentOk = c.expectIntent === cd.intent || (PAIN_FAMILY.has(c.expectIntent) && PAIN_FAMILY.has(cd.intent));
      const redFlagOk = !c.expectRedFlag || redFlag;
      const autoOkPrecOk = !autoSent || c.expectAutoOk;
      const pickedIds = knowledge.picked.map((d) => d.id);
      const docOk = c.expectDocIds.length === 0 || c.expectDocIds.some((id) => pickedIds.includes(id));

      if (c.expectRedFlag) { redFlagTotal += 1; if (redFlag) redFlagPass += 1; else hardFail = true; }
      if (autoSent) { autoSentCount += 1; if (!c.expectAutoOk) { autoSentWrong += 1; hardFail = true; } }
      if (intentOk) intentPass += 1;
      if (c.expectDocIds.length > 0) { docTotal += 1; if (docOk) docPass += 1; }

      row.actual = {
        intent: cd.intent, urgency: cd.urgency, needsHuman: cd.needsHuman, redFlag, painRound,
        autoSent, picked: knowledge.picked.map((d) => ({ id: d.id, title: d.title, kind: d.kind })),
        discarded: knowledge.discarded, knowledgeSkipped: knowledge.skipped, price: priceInfo,
        draft: finalDraft,
        before: c.utterance, after: normalized,
        metrics: { intentOk, redFlagOk, autoOkPrecOk, docOk },
      };
      const mark = (b: boolean) => (b ? "✓" : "✗");
      console.log(
        `${c.id.slice(-8)} | ${mark(intentOk)} ${c.expectIntent}→${cd.intent} | ${mark(redFlagOk)} ${c.expectRedFlag ? "1" : "0"}→${redFlag ? "1" : "0"} | ${mark(autoOkPrecOk)} ${c.expectAutoOk ? "1" : "0"}→${autoSent ? "1" : "0"} | ${mark(docOk)} | ${Date.now() - t0}ms | ${c.utterance.slice(0, 14)} → ${normalized.slice(0, 14)}`
      );
    } catch (e) {
      row.error = (e as Error).message;
      row.actual = { error: true };
      console.log(`${c.id.slice(-8)} | ERROR: ${(e as Error).message.slice(0, 60)}`);
      log.error({ err: (e as Error).message, caseId: c.id }, "eval:golden case error");
      // fail-closed：expectRedFlag=true 嘅 case pipeline 炸咗 = 紅旗未偵測到 → 計 miss（紅旗 recall 門唔准被錯誤掩埋）
      if (c.expectRedFlag) {
        redFlagTotal += 1;
        hardFail = true;
      }
    }
    report.push(row);
  }

  const intentAcc = cases.length ? intentPass / cases.length : 1;
  const redFlagRecall = redFlagTotal ? redFlagPass / redFlagTotal : 1;
  const autoOkPrecision = autoSentCount ? (autoSentCount - autoSentWrong) / autoSentCount : 1;
  const docHitRate = docTotal ? docPass / docTotal : 1;

  const summary = {
    clinic: clinic.code, total: cases.length, ts: new Date().toISOString(),
    redFlagRecall: { pass: redFlagPass, total: redFlagTotal, rate: redFlagRecall, gate: "100%", fail: redFlagRecall < 1 },
    autoOkPrecision: { autoSent: autoSentCount, wrong: autoSentWrong, rate: autoOkPrecision, gate: "100%", fail: autoOkPrecision < 1 },
    intentAccuracy: { rate: intentAcc, gate: ">=90%", warn: intentAcc < 0.9 },
    docHitRate: { pass: docPass, total: docTotal, rate: docHitRate, gate: ">=80%", warn: docHitRate < 0.8 },
    hardFail,
  };

  const dir = join(process.cwd(), "evals", "reports");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `golden-${Date.now()}.json`);
  writeFileSync(out, JSON.stringify({ summary, cases: report }, null, 2), "utf8");

  console.log("\n────────── summary ──────────");
  console.log(`紅旗 recall      ${redFlagPass}/${redFlagTotal} = ${(redFlagRecall * 100).toFixed(1)}%  gate=100%  ${redFlagRecall < 1 ? "❌ FAIL" : "✅"}`);
  console.log(`自動覆 precision ${autoSentCount - autoSentWrong}/${autoSentCount} = ${(autoOkPrecision * 100).toFixed(1)}%  gate=100%  ${autoOkPrecision < 1 ? "❌ FAIL" : "✅"}`);
  console.log(`intent accuracy  ${(intentAcc * 100).toFixed(1)}%  gate>=90%  ${intentAcc < 0.9 ? "⚠️ warn" : "✅"}`);
  console.log(`知識引用命中     ${docPass}/${docTotal} = ${(docHitRate * 100).toFixed(1)}%  gate>=80%  ${docHitRate < 0.8 ? "⚠️ warn" : "✅"}`);
  console.log(`報告 → ${out}`);
  await prisma.$disconnect();
  process.exit(hardFail ? 1 : 0);
}

main().catch((e) => {
  console.error("eval:golden fatal:", e);
  process.exit(1);
});

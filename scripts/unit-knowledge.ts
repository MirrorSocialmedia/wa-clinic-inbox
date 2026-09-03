/**
 * ★ Part F（cwi-raggolden-20260904）：unit-knowledge — 決定性單測（e2e T121 + T122–124 靶 + T129 deid）。
 *
 * 覆蓋：
 * - deid：電話（8 位/+852 形態）→ <phone>；姓名（contactName+profileName 集）→ <name>；日期/金額保留
 * - price-guard：① 零引用幻覺價 ② 漏 disclaimer 自動 append ③ 金額出範圍；無金額 = 原樣通過
 * - extractAmounts：幣符綁定（日期/時間/數量唔誤判）
 * - pickKnowledge mock：keyword 選 id（PRICE 優先）／E2E-KNOWLEDGE-NONE → 空／
 *   KNOWLEDGE_MOCK_HALLUCINATE → 幻覺丟棄 + 真 id 保留／KNOWLEDGE_MOCK_TIMEOUT → fail-soft
 * - buildPriceDraft：範圍 + body + disclaimer
 *
 * 用法：pnpm test:unit-knowledge（TKW 需已 seed — scripts/seed-knowledge.ts）
 */
import { PrismaClient } from "@prisma/client";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch { /* ok */ }
process.env.AI_MOCK = "1"; // 確保 pickKnowledge 走 mock 決定性路徑

const prisma = new PrismaClient();
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

async function main(): Promise<void> {
  // ── deid ──────────────────────────────────────────────────────────────
  console.log("\n[deid]");
  const { deid, deidList } = await import("../src/lib/golden/deid");
  check("8 位電話 → <phone>", deid("我電話 91234567 嗰個") === "我電話 <phone> 嗰個");
  check("+852 形態 → <phone>", deid("call +852 9123 4567") === "call <phone>");
  check("852 無加號 → <phone>", deid("85291234567 打嚟") === "<phone> 打嚟");
  check("9 位數字保留（唔係電話）", deid("123456789").includes("123456789"));
  check("金額保留", deid("$600–1200 蚊").includes("$600–1200 蚊".replace("蚊", "")) || deid("$600蚊").includes("$600"));
  check("日期保留", deid("2026-09-04 返嚟").includes("2026-09-04"));
  check("姓名 → <name>（長名優先）", deid("李小明今日得閒", ["李小明", "李"]) === "<name>今日得閒");
  check("多姓名（只完整字串替換）", deid("李同王都到", ["李小明", "王"]) === "李同<name>都到");
  check("deidList 過濾空", deidList(["", null, "ok"], []).length === 1);

  // ── extractAmounts ────────────────────────────────────────────────────
  console.log("\n[extractAmounts]");
  const { extractAmounts, isPriceIntent, buildPriceDraft, runPriceGuard, NO_PRICE_TEXT } =
    await import("../src/lib/ai/price-guard");
  check("$ 前缀", JSON.stringify(extractAmounts("$999")) === "[999]");
  check("範圍兩邊", JSON.stringify(extractAmounts("$600–1200").sort((a, b) => a - b)) === "[600,1200]");
  check("HK$ 形態", JSON.stringify(extractAmounts("HK$ 1500")) === "[1500]");
  check("蚊 後缀", JSON.stringify(extractAmounts("大約 5000 蚊")) === "[5000]");
  check("日期唔誤判", extractAmounts("2026年9月4日").length === 0);
  check("純數字無幣符唔算金額", extractAmounts("第3號牙").length === 0);

  // ── isPriceIntent ─────────────────────────────────────────────────────
  console.log("\n[isPriceIntent]");
  check("幾錢", isPriceIntent("洗牙幾錢？"));
  check("收費", isPriceIntent("收費點樣"));
  check("貴唔貴", isPriceIntent("杜牙根貴唔貴"));
  check("幾耐唔係", !isPriceIntent("洗完牙幾耐好"));
  check("空唔係", !isPriceIntent(""));

  // ── buildPriceDraft ───────────────────────────────────────────────────
  console.log("\n[buildPriceDraft]");
  const fakePriceDoc = {
    id: "kd-price-x", kind: "PRICE" as const, title: "洗牙收費", keywords: ["洗牙"],
    body: "影響因素：牙石多寡。", disclaimer: "DISC-TEST-1234", priceMin: 600, priceMax: 1200,
  };
  const built = buildPriceDraft(fakePriceDoc);
  check("範圍文字", built.text?.includes("600–1200") === true, built.text ?? "null");
  check("body 影響因素", built.text?.includes("影響因素") === true);
  check("disclaimer code 強制", built.text?.includes("DISC-TEST-1234") === true);
  const noRange = buildPriceDraft({ ...fakePriceDoc, priceMin: null, priceMax: null });
  check("冇 min/max → null（唔准報價）", noRange.text === null);

  // ── runPriceGuard 3 條 ────────────────────────────────────────────────
  console.log("\n[runPriceGuard]");
  const g1 = runPriceGuard({ draft: "大概 $999 左右", priceDoc: null, priceIntent: false });
  check("① 零引用幻覺價 → 擋", g1.blocked === true && g1.draft === NO_PRICE_TEXT && g1.forceNeedsHuman === true);
  const g2 = runPriceGuard({ draft: "洗牙大約 $800", priceDoc: fakePriceDoc, priceIntent: false });
  check("② in-range 漏 disclaimer → 自動 append", g2.blocked === false && g2.disclaimerAppended === true && g2.draft.includes("DISC-TEST-1234"));
  const g3 = runPriceGuard({ draft: "洗牙大約 $5000", priceDoc: fakePriceDoc, priceIntent: false });
  check("③ out-of-range → 擋", g3.blocked === true && g3.outOfRange === true && g3.draft === NO_PRICE_TEXT);
  const g4 = runPriceGuard({ draft: "多謝查詢，請到店", priceDoc: null, priceIntent: false });
  check("無金額 → 原樣通過", g4.blocked === false && g4.draft === "多謝查詢，請到店");
  const g5 = runPriceGuard({ draft: null, priceDoc: null, priceIntent: false });
  check("null draft → no-op", g5.blocked === false);

  // ── pickKnowledge（mock 決定性）───────────────────────────────────────
  console.log("\n[pickKnowledge mock]");
  const clinic = await prisma.clinic.findFirst({ where: { code: "TKW" } });
  if (!clinic) {
    console.error("  ✗ TKW clinic 唔存在 — 先跑 scripts/seed-knowledge.ts");
    process.exit(1);
  }
  const { pickKnowledge } = await import("../src/lib/knowledge/retrieve");
  const r1 = await pickKnowledge({ clinicId: clinic.id, question: "洗牙幾錢" });
  check("價錢問 keyword 選中 PRICE 洗牙（優先）", r1.picked.length > 0 && r1.picked[0].kind === "PRICE", JSON.stringify(r1.picked.map((d) => d.title)));
  check("ran=true", r1.ran === true);
  const r2 = await pickKnowledge({ clinicId: clinic.id, question: "E2E-KNOWLEDGE-NONE 完全無關問題" });
  check("NONE → 空（skip）", r2.picked.length === 0 && r2.ran === true);
  const r3 = await pickKnowledge({ clinicId: clinic.id, question: "冇任何 keyword 命中 E2E-KNOWLEDGE-NONE" });
  check("無命中 → 空", r3.picked.length === 0);

  // hallucinate（env 開關 — 重新 import 唔到，直接 set env 再 call）
  process.env.KNOWLEDGE_MOCK_HALLUCINATE = "1";
  const r4 = await pickKnowledge({ clinicId: clinic.id, question: "洗牙幾時先好" });
  check("幻覺 id 丟棄 + 真 id 保留", r4.discarded === 1 && r4.picked.length > 0, JSON.stringify({ d: r4.discarded, p: r4.picked.length }));
  delete process.env.KNOWLEDGE_MOCK_HALLUCINATE;
  // timeout fail-soft
  process.env.KNOWLEDGE_MOCK_TIMEOUT = "1";
  const r5 = await pickKnowledge({ clinicId: clinic.id, question: "洗牙幾時先好" });
  check("timeout → fail-soft 空 + skipped=timeout", r5.picked.length === 0 && r5.skipped === "timeout" && r5.ran === true);
  delete process.env.KNOWLEDGE_MOCK_TIMEOUT;
  // media（無問題文本）
  const r6 = await pickKnowledge({ clinicId: clinic.id, question: null });
  check("無 question → skipped=no-question", r6.skipped === "no-question" && r6.ran === false);

  console.log(`\nunit-knowledge: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().finally(() => prisma.$disconnect());

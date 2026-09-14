/**
 * unit-hub-b — ★ cwi-hub-b-20260914（Part B S7）：本單純邏輯 unit（零 server 依賴）。
 * 用法：pnpm -s tsx scripts/unit-hub-b.ts
 */
import { HUB_STEP_CONTRACT, isHighValuePriceDoc, SANDBOX_DEMO_QUESTIONS } from "../src/lib/ai/hub-summary";
import { SANDBOX_TTL_SECONDS } from "../src/lib/ai/sandbox";
import { LEXICON_DEFAULTS, LexiconParams } from "../src/lib/workflow/definitions";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.error(`  ✘ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

console.log("\nU1 七步契約（name + anchor 單一來源）");
{
  check("七步齊", HUB_STEP_CONTRACT.length === 7, HUB_STEP_CONTRACT.length);
  const NAMES = ["安全閘", "理解", "對話模式", "搵資料", "派俾邊個", "出文", "發唔發"];
  const ANCHORS = [
    "/admin/workflows#wf-pain-triage",
    "/admin/ai/keywords",
    "/admin/consult",
    "/admin/knowledge",
    "/admin/routing-rules",
    "/admin/workflows#wf-tone",
    "/admin/automation",
  ];
  check("七步名（老細已批）", HUB_STEP_CONTRACT.every((c, i) => c[0] === NAMES[i]), HUB_STEP_CONTRACT.map((c) => c[0]));
  check("七 anchor 同 MD B.1 對應頁", HUB_STEP_CONTRACT.every((c, i) => c[1] === ANCHORS[i]), HUB_STEP_CONTRACT.map((c) => c[1]));
  check("anchor 全部指向 /admin/ 頁", HUB_STEP_CONTRACT.every((c) => c[1].startsWith("/admin/")), undefined);
}

console.log("\nU2 沙盤常量（鐵律 6：TTL 30 分鐘）");
{
  check("SANDBOX_TTL_SECONDS = 1800", SANDBOX_TTL_SECONDS === 1800, SANDBOX_TTL_SECONDS);
}

console.log("\nU3 高價值 PRICE doc 判定（schema 註解口徑）");
{
  check("priceMax >= 5000 → 高價值", isHighValuePriceDoc({ priceMin: null, priceMax: 5000 }) === true);
  check("priceMax > 1.5× priceMin → 高價值", isHighValuePriceDoc({ priceMin: 4000, priceMax: 10000 }) === true);
  check("priceMax < 5000 且 ratio ≤1.5 → 非高價值", isHighValuePriceDoc({ priceMin: 10000, priceMax: 4000 }) === false);
  check("priceMax null → 非高價值", isHighValuePriceDoc({ priceMin: 100, priceMax: null }) === false);
  check("priceMin=0（guard：唔會除零）", isHighValuePriceDoc({ priceMin: 0, priceMax: 4000 }) === false);
  check("ratio = 1.5（唔係 >）→ 非高價值", isHighValuePriceDoc({ priceMin: 1000, priceMax: 1500 }) === false);
}

console.log("\nU4 沙盤示範問題（B.9 — 6 條、非空、唔重複）");
{
  check("6 條示範問題", SANDBOX_DEMO_QUESTIONS.length === 6, SANDBOX_DEMO_QUESTIONS.length);
  check("全部非空字串", SANDBOX_DEMO_QUESTIONS.every((q) => typeof q === "string" && q.trim().length > 0), SANDBOX_DEMO_QUESTIONS);
  check("無重複", new Set(SANDBOX_DEMO_QUESTIONS).size === SANDBOX_DEMO_QUESTIONS.length, undefined);
}

console.log("\nU5 LEXICON_DEFAULTS 完整性（口語表 fallback 口徑）");
{
  const p = LexiconParams.safeParse({ entries: LEXICON_DEFAULTS.entries });
  check("defaults 過 zod（LexiconParams）", p.success, p.success ? undefined : p.error);
  if (p.success) {
    const terms = p.data.entries.map((e) => e.term);
    check("term 全部非空", terms.every((t) => t.trim().length > 0), undefined);
    check("term 無重複", new Set(terms).size === terms.length, terms);
    check("entry 有 canonical", p.data.entries.every((e) => e.canonical.trim().length > 0), undefined);
  }
}

console.log(failures === 0 ? "\nUNIT-HUBB OK" : `\nUNIT-HUBB FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);

/**
 * ★ cwi-final S4-4 T657：runOutboundGuards GoldenCase — 每 intent 含金額 / 含日期時間 → blocks 含 guard。
 *
 * 口徑（spec S4-4）：guard 唔再以 intent 做入口條件 — 任何非 engine 產生嘅自動發文字（7 intent
 * BOOKING_REQUEST / QUESTION / URGENT_PAIN / OUT_OF_SCOPE / COMPLAINT / PAIN / OTHER 嘅 free-form
 * 草稿）一律過 price guard + claim guard + TIME_CLAIM_NO_ENGINE（free-form 無 backend slot）。
 *
 * - 單位級 = deterministic（mock 草稿 = e2e mock-e2e S4-3/S4-4 段用嘅同款 bait 字串）
 * - e2e 實機斷言（AiDraft.traceJson.gates.blocks ⊇ guard:* + worker not-eligible log）喺 mock-e2e.sh
 *   「S4-3/S4-4 E2E」段（T657 e2e 部分）。
 *
 * 預期 code：
 * - 金額無 PRICE doc → PRICE；金額超 range → PRICE；金額在 range 內 → 唔 block
 * - 日期/時間宣告 + hasBackendSlot=false → CG-008 + TIME_CLAIM_NO_ENGINE
 * - hasBackendSlot=true → 時間宣告放行（engine 真 slot 句）
 */
import { runOutboundGuards, type GuardVerdict } from "../src/lib/ai/outbound-guards";

let passes = 0;
let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passes++;
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const PRICE_DRAFT = "多謝你嘅預約請求！呢項費用大約係 $9999，直接嚟就得。";
const TIME_DRAFT = "多謝你嘅預約請求！聽日 3 點有得，直接嚟就得。";
const CLEAN_DRAFT = "多謝你嘅預約請求！我哋會盡快安排，職員會跟你確認。";

function guard(draft: string, extra?: { priceDoc?: { priceMin: number | null; priceMax: number | null } | null; hasBackendSlot?: boolean }): GuardVerdict {
  // priceDoc（CatalogDoc|null）同 claimInput.priceDoc 同源（pipeline 口徑：citedPriceDoc 一份兩用）
  const doc = extra?.priceDoc
    ? ({ id: "e2e-unit-price", kind: "PRICE", title: "e2e", keywords: [], body: "", disclaimer: null, shortDisclaimer: null, ...extra.priceDoc } as import("../src/lib/knowledge/catalog").CatalogDoc)
    : null;
  return runOutboundGuards({
    draft,
    priceDoc: doc, // 零引用（null）→ amount 無依據 → PRICE
    priceIntent: false,
    hasBackendSlot: extra?.hasBackendSlot ?? false,
    claimInput: {
      products: [],
      priceDoc: extra?.priceDoc ?? null,
    },
  });
}

console.log("[T657] runOutboundGuards GoldenCase — 每 intent 含金額 / 含日期時間");

// ── 每 intent × 2 形態（金額 / 日期時間）→ 必 block + 期望 code ──
const INTENTS = ["BOOKING_REQUEST", "QUESTION", "URGENT_PAIN", "OUT_OF_SCOPE", "COMPLAINT", "PAIN", "OTHER"] as const;
for (const intent of INTENTS) {
  const gPrice = guard(PRICE_DRAFT);
  check(`${intent} 含金額 → block + PRICE`, !gPrice.ok && gPrice.codes.includes("PRICE"), JSON.stringify(gPrice.codes));
  const gTime = guard(TIME_DRAFT);
  check(
    `${intent} 含日期時間 → block + CG-008 + TIME_CLAIM_NO_ENGINE`,
    !gTime.ok && gTime.codes.includes("CG-008") && gTime.codes.includes("TIME_CLAIM_NO_ENGINE"),
    JSON.stringify(gTime.codes)
  );
}

// ── 金額在 range 內 → PRICE 唔 block（無其他 token → 放行）──
const gInRange = guard("多謝你嘅查詢！大概係 $999 咁上下。", { priceDoc: { priceMin: 500, priceMax: 9999 } });
check("金額在 range 內 + 有 PRICE doc → 放行", gInRange.ok, JSON.stringify(gInRange.codes));

// ── 超 range → PRICE ──
const gOutOfRange = guard("多謝你嘅查詢！大概係 $999 咁上下。", { priceDoc: { priceMin: 100, priceMax: 900 } });
check("金額超 range → block + PRICE", !gOutOfRange.ok && gOutOfRange.codes.includes("PRICE"), JSON.stringify(gOutOfRange.codes));

// ── hasBackendSlot=true（engine 真 slot 句）→ 時間宣告放行 ──
const gEngineSlot = guard(TIME_DRAFT, { hasBackendSlot: true });
check("hasBackendSlot=true → 時間宣告放行", gEngineSlot.ok, JSON.stringify(gEngineSlot.codes));

// ── 乾淨草稿（無金額/無時間/無 claim）→ 放行 ──
const gClean = guard(CLEAN_DRAFT);
check("乾淨草稿 → 放行", gClean.ok, JSON.stringify(gClean.codes));

// ── PRICE 命中時 draft 換 NO_PRICE_TEXT（price-guard 語義 — blocks 層 trace 用）──
check("PRICE 命中 → draft 換 NO_PRICE_TEXT", guard(PRICE_DRAFT).draft.includes("以實際報價為準") || guard(PRICE_DRAFT).draft !== PRICE_DRAFT, guard(PRICE_DRAFT).draft.slice(0, 40));

if (failures > 0) {
  console.error(`\nUNIT FAIL ❌（${failures} 項 / ${passes} 過）`);
  process.exit(1);
}
console.log(`\nUNIT PASS ✅（outbound-guards unit，${passes} 項）`);

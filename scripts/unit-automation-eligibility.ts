/**
 * unit-automation-eligibility — Phase E（cwi-ai-20260825-t5）isEligible 五 case（pure — 零 DB）
 *
 * 規格：連續 4 週 adoptRate≥0.9 且 complaints+rollbacks=0 且每週 draftCount≥20。
 *
 * 用法（repo root）：pnpm tsx scripts/unit-automation-eligibility.ts
 */
import { adoptRate, isEligible, ELIGIBLE_ADOPT_RATE, ELIGIBLE_MIN_DRAFTS, type StatLike } from "../src/lib/ops/eligibility";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const WEEKS = ["2026-07-27", "2026-08-03", "2026-08-10", "2026-08-17"];
function week(i: number, over: Partial<StatLike> = {}): StatLike {
  return { weekStart: WEEKS[i], draftCount: 20, adoptedAsIs: 18, adoptedEdited: 2, complaints: 0, rollbacks: 0, ...over };
}

console.log("[0] adoptRate");
{
  check("18+2 / 20 = 1.0", adoptRate(week(0)) === 1.0);
  check("draftCount=0 → null", adoptRate(week(0, { draftCount: 0, adoptedAsIs: 0, adoptedEdited: 0 })) === null);
  check("17 / 20 = 0.85", adoptRate(week(0, { adoptedAsIs: 15, adoptedEdited: 2 })) === 0.85);
}

console.log("[1] 四週全過 → eligible");
{
  const r = isEligible([week(0), week(1), week(2), week(3)]);
  check("eligible=true", r.eligible, JSON.stringify(r.reasons));
  check("reasons 空", r.reasons.length === 0);
}

console.log("[2] 第 3 週 rate 0.89（< 0.9）→ 唔過");
{
  const rows = [week(0), week(1), week(2, { draftCount: 100, adoptedAsIs: 89, adoptedEdited: 0 }), week(3)];
  const r = isEligible(rows);
  check("eligible=false", !r.eligible);
  check("reasons 指向第 3 週", r.reasons.some((x) => x.startsWith("2026-08-10")), JSON.stringify(r.reasons));
  check("reasons 話明 adoptRate", r.reasons.some((x) => x.includes(`adoptRate ${ELIGIBLE_ADOPT_RATE}`) || x.includes("adoptRate 0.89")), JSON.stringify(r.reasons));
}

console.log("[3] 樣本 19（< 20）→ 唔過");
{
  const rows = [week(0), week(1), week(2, { draftCount: 19, adoptedAsIs: 19, adoptedEdited: 0 }), week(3)];
  const r = isEligible(rows);
  check("eligible=false", !r.eligible);
  check("reasons 話明樣本", r.reasons.some((x) => x.includes(`樣本 19 < ${ELIGIBLE_MIN_DRAFTS}`)), JSON.stringify(r.reasons));
}

console.log("[4] 有一單 rollback → 唔過");
{
  const rows = [week(0), week(1, { rollbacks: 1 }), week(2), week(3)];
  const r = isEligible(rows);
  check("eligible=false", !r.eligible);
  check("reasons 話明 complaints+rollbacks", r.reasons.some((x) => x.includes("complaints+rollbacks = 1")), JSON.stringify(r.reasons));
}

console.log("[5] 唔夠四週（3 rows）→ 直接唔過");
{
  const r = isEligible([week(0), week(1), week(2)]);
  check("eligible=false", !r.eligible);
  check("reasons = 未夠四週數據", r.reasons.length === 1 && r.reasons[0] === "未夠四週數據", JSON.stringify(r.reasons));
}

console.log("[6] 邊界：rate 恰好 0.9 過 / 18+1=19 過");
{
  const r = isEligible([week(0, { adoptedAsIs: 18, adoptedEdited: 0 }), week(1), week(2), week(3)]); // 18/20 = 0.9
  check("rate = 0.9 整數邊界 → 過", r.eligible, JSON.stringify(r.reasons));
  const r2 = isEligible([week(0, { adoptedAsIs: 17, adoptedEdited: 1 }), week(1), week(2), week(3)]); // 18/20 = 0.9 同 — 等等 17+1=18
  check("17+1 = 0.9 → 過", r2.eligible, JSON.stringify(r2.reasons));
  const r3 = isEligible([week(0, { adoptedAsIs: 16, adoptedEdited: 1 }), week(1), week(2), week(3)]); // 17/20 = 0.85
  check("16+1 = 0.85 → 唔過", !r3.eligible);
}

console.log(failures === 0 ? "\n✅ unit-automation-eligibility 全過" : `\n❌ ${failures} 個 fail`);
process.exit(failures === 0 ? 0 : 1);

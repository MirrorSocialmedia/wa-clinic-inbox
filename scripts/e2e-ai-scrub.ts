/**
 * e2e-ai-scrub — H-3 deterministic scrub 單元/E2E（獨立 process，零 AI 依賴驗證）
 *
 * 斷言（全部通過先出 AI-SCRUB OK）：
 *  A. 完整 profileName → 病人
 *  B. 部分名（≥2 字子串）→ 病人（AI 只抄咗部分名都捉到）
 *  C. waId 後 8 位 → ***
 *  D. bait token（e2e pipeline 用緊嘅 E2E-BAIT-SUM-7f3a）→ 0 hit
 *  E. 重疊替換收緊（病人病人 → 病人）
 *  F. 無身份資料嘅 summary 原樣返回（唔誤傷正常摘要）
 *
 * 用法：pnpm e2e:ai-scrub
 */
import { scrubAiSummary, nameSubstrings } from "../src/lib/ai/scrub";

let failures = 0;
function check(name: string, ok: boolean, extra = ""): void {
  if (ok) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name} ${extra}`);
    failures += 1;
  }
}

// A. 完整名
const a = scrubAiSummary("陳大文 稱左牙痛", { profileName: "陳大文", waId: null });
check("A 完整 profileName → 病人", a === "病人 稱左牙痛", `(got: ${a})`);

// B. 部分名（子串）
const b = scrubAiSummary("大文 說左肚痛", { profileName: "陳大文", waId: null });
check("B ≥2 字子串（部分名）→ 病人", b === "病人 說左肚痛", `(got: ${b})`);

// C. waId 後 8 位（完整 11 位數字 → 前 3 位 852 保留，後 8 位 → ***）
const c = scrubAiSummary("聯絡 85260012345 得", { profileName: null, waId: "85260012345" });
check("C waId 後 8 位 → ***", c === "聯絡 852*** 得", `(got: ${c})`);
const c2 = scrubAiSummary("打 60012345 俾佢", { profileName: null, waId: "85260012345" });
check("C2 純後 8 位數字 → ***", c2 === "打 *** 俾佢", `(got: ${c2})`);

// D. e2e bait token（同 mock.ts E2E_BAIT_SUM_TOKEN 一致）
const BAIT = "E2E-BAIT-SUM-7f3a";
const d = scrubAiSummary(`病人想預約/改期（mock） ${BAIT}`, { profileName: BAIT, waId: null });
check("D bait token 0 hit", !d.includes(BAIT), `(got: ${d})`);
check("D' bait 替換後 = 病人", d.includes("病人"), `(got: ${d})`);

// E. 收緊
const e = scrubAiSummary("病人病人", { profileName: "病人", waId: null });
check("E 連續重複收緊（病人病人→病人）", e === "病人", `(got: ${e})`);

// F. 唔誤傷
const f = scrubAiSummary("病人主訴劇痛/出血等急性不適（mock）", { profileName: "E2E-A-URGENT", waId: "8526003000001" });
check("F 無關身份嘅 summary 原樣返回", f === "病人主訴劇痛/出血等急性不適（mock）", `(got: ${f})`);

// nameSubstrings 順序（最長優先）
const subs = nameSubstrings("陳大文");
check("G nameSubstrings 最長優先", subs[0] === "陳大文" && subs.length === 3, `(got: ${subs.join(",")})`);

if (failures > 0) {
  console.log(`AI-SCRUB FAIL: ${failures} 項失敗`);
  process.exit(1);
}
console.log("AI-SCRUB OK");

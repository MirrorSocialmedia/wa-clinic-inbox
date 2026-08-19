/**
 * aiSummary 去識別化 scrub（安全審計 H-3 第二層 — deterministic，零 AI 依賴，一定生效）。
 *
 * 第一層 = prompts.ts 規則（叫 AI 唔好寫身份資料）— AI 可能唔聽；
 * 第二層 = 呢個：落庫/推送前 deterministic 替換：
 * - contact.profileName：完整字串 + 所有 ≥2 字連續子串 → 「病人」
 *   （子串覆蓋：AI 只抄咗部分名 — 例名「陳大文」只寫「大文」都捉到）
 * - waId 後 8 位 → 「***」（電話尾號 = 可直接聯絡嘅識別碼）
 * - 替換後收緊連續「病人病人…」→「病人」（重疊替換會產生連字）
 *
 * 已知限制（方法特性，唔係 bug）：若 profileName 本身含「病人」等常用字，
 * 替換係 no-op（常用字本身擦唔走）。真名（中文/英文名）唔會呢個情況；
 * E2E 病人名全部用 ASCII token（避免 mock 模板 CJK 撞车 false positive）。
 *
 * ★ draft 唔經呢層（草稿本嚟就對病人講，staff 審批用）— 見 ai.worker.ts。
 * ★ 純函數、無副作用、無 IO — 可以喺 unit/E2E 直接測。
 */

export interface ScrubIdentity {
  profileName?: string | null;
  waId?: string | null;
}

/** 所有 ≥2 字連續子串（去重，最長優先 — 先替長嘅防止短嘅先切咗）。 */
export function nameSubstrings(name: string): string[] {
  const subs = new Set<string>();
  for (let i = 0; i < name.length; i++) {
    for (let j = i + 2; j <= name.length; j++) {
      subs.add(name.slice(i, j));
    }
  }
  return [...subs].sort((a, b) => b.length - a.length);
}

/**
 * Scrub aiSummary（H-3 第二層）。
 * @returns 去識別化後嘅 summary（可安全落 DB / 推 staff socket）
 */
export function scrubAiSummary(summary: string, id: ScrubIdentity): string {
  let out = summary ?? "";

  // 1. waId 後 8 位（電話尾號）
  const wa = (id.waId ?? "").trim();
  if (wa.length >= 8) {
    out = out.split(wa.slice(-8)).join("***");
  }

  // 2. profileName 完整 + 所有 ≥2 字子串
  const name = (id.profileName ?? "").trim();
  if (name.length >= 2) {
    for (const sub of nameSubstrings(name)) {
      out = out.split(sub).join("病人");
    }
    // 重疊替換收緊：「病人病人」→「病人」
    out = out.replace(/(病人)+/g, "病人");
  }

  return out;
}

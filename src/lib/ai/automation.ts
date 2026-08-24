/**
 * 自動化級別解析（總綱 §3.3 — D-4/D-5）。
 * 優先序：policy(clinic, category) → policy(clinic, "*") → legacy clinic.aiMode（DRAFT→L1, AUTO→L2）
 * 天花板：env AI_GLOBAL_MAX_LEVEL（kill switch — 改 L1 重啟即全網降級）。
 * cache：5 分鐘 in-memory TTL（照 duty/client.ts pattern）。
 * 寫入只經 admin route（Phase E 先開 UI；C 期用 seed/SQL 手動設測試店）。
 *
 * 注意：getAutomationLevel 唔會 throw（fail-soft：DB 錯 → legacy L1/L2 兜底，
 * session 唔開 — 保守方向）。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";

export type AutomationLevel = "L1" | "L2" | "L3" | "L4";
const ORDER: AutomationLevel[] = ["L1", "L2", "L3", "L4"];

export function minLevel(a: AutomationLevel, b: AutomationLevel): AutomationLevel {
  return ORDER[Math.min(ORDER.indexOf(a), ORDER.indexOf(b))];
}

/** env 值 defense：壞值（例 "L9"）當冇設 — 唔可以打斷 minLevel 排序。 */
export function asLevel(v: unknown): AutomationLevel | null {
  return typeof v === "string" && ORDER.includes(v as AutomationLevel) ? (v as AutomationLevel) : null;
}

/** Kill switch 天花板：env AI_GLOBAL_MAX_LEVEL（預設 L4 = 唔壓頂）。 */
export function globalCap(): AutomationLevel {
  return asLevel(process.env.AI_GLOBAL_MAX_LEVEL) ?? "L4";
}

const CACHE_TTL_MS = 5 * 60 * 1000;
interface CacheRow {
  at: number;
  level: AutomationLevel;
}
const cache = new Map<string, CacheRow>();

function cacheGet(clinicId: string, category: string): AutomationLevel | null {
  const row = cache.get(`${clinicId}|${category}`);
  if (row && Date.now() - row.at < CACHE_TTL_MS) return row.level;
  return null;
}
function cacheSet(clinicId: string, category: string, level: AutomationLevel): void {
  if (cache.size > 500) cache.clear(); // 防 leak（店×類 組合唔多）
  cache.set(`${clinicId}|${category}`, { at: Date.now(), level });
}

/** test-only：清 TTL cache（e2e 改 level 唔使等 5 分鐘）。 */
export function clearAutomationLevelCache(): void {
  cache.clear();
}

/**
 * pure 解析（unit test 用 — 零 DB）：exact > star > legacy。
 * @param rows 該店嘅 AutomationPolicy row（category 可含 exact 與 "*"）
 * @param category 請求嘅類（intent 名）
 * @param legacyAiMode clinic.aiMode（DRAFT / AUTO / null = 店唔存在 → L1 保守）
 */
export function resolveLevel(
  rows: { category: string; level: string }[],
  category: string,
  legacyAiMode: string | null
): AutomationLevel {
  const exact = rows.find((r) => r.category === category);
  const star = rows.find((r) => r.category === "*");
  const level = asLevel(exact?.level) ?? asLevel(star?.level);
  if (level) return level;
  return legacyAiMode === "AUTO" ? "L2" : "L1";
}

export async function getAutomationLevel(clinicId: string, category: string): Promise<AutomationLevel> {
  const cached = cacheGet(clinicId, category);
  if (cached) return minLevel(cached, globalCap());
  try {
    const rows = await prisma.automationPolicy.findMany({
      where: { clinicId, category: { in: [category, "*"] } },
    });
    const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { aiMode: true } });
    const level = resolveLevel(
      rows.map((r) => ({ category: r.category, level: r.level })),
      category,
      clinic?.aiMode ?? null
    );
    cacheSet(clinicId, category, level);
    return minLevel(level, globalCap());
  } catch (err) {
    // fail-soft：DB 錯 → legacy 保守級（L1）— session 唔開，唔阻 AI 主流程
    log.warn(
      { clinicId, category, err: err instanceof Error ? err.message : String(err) },
      "automation: level resolve failed → L1（保守）"
    );
    return "L1";
  }
}

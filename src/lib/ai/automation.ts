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

/**
 * cache key（★ 含 aiMode — cwi-fix-20260825-f1 T83 事故）：fallback level 跟店模式走
 *（AUTO→L2 / DRAFT→L1）；key 唔含 mode 嘅話，模式切換（DRAFT→AUTO）後 stale fallback
 * 會住到 5 分鐘 TTL 到期，AUTO 店被 L1 誤壓（T22 DRAFT booking → T83 AUTO assigned 實測）。
 */
export function levelCacheKey(clinicId: string, aiMode: string | null, category: string): string {
  return `${clinicId}|${aiMode ?? "NONE"}|${category}`;
}

/** test-only：cache 讀寫（unit 驗證 key 隔離）。 */
export function cacheGet(clinicId: string, aiMode: string | null, category: string): AutomationLevel | null {
  const row = cache.get(levelCacheKey(clinicId, aiMode, category));
  if (row && Date.now() - row.at < CACHE_TTL_MS) return row.level;
  return null;
}
export function cacheSet(clinicId: string, aiMode: string | null, category: string, level: AutomationLevel): void {
  if (cache.size > 500) cache.clear(); // 防 leak（店×類 組合唔多）
  cache.set(levelCacheKey(clinicId, aiMode, category), { at: Date.now(), level });
}

/** test-only：清 TTL cache（e2e 改 level 唔使等 5 分鐘）。 */
export function clearAutomationLevelCache(): void {
  cache.clear();
}

// ── ★ A12（cwi-final S4-3）：痛症問診 kill switch（全店預設開 — 只受 global cap + 類別 row 控制）──
const PAIN_TRIAGE_CACHE_TTL_MS = 60_000;
interface PainTriageCacheRow {
  at: number;
  enabled: boolean;
}
const painTriageCache = new Map<string, PainTriageCacheRow>();

/** test-only / control bust：清 pain triage cache（e2e 改 PAIN_TRIAGE row 唔使等 60 秒）。 */
export function clearPainTriageCache(): void {
  painTriageCache.clear();
}

/**
 * ★ A12（2026-09-17 拍板）：痛症問診刻意對所有店開（包括 DRAFT／L1 店），唔跟逐店 intent 級別。
 * 只受兩樣控制：① env AI_GLOBAL_MAX_LEVEL=L1（全網 kill）② 類別 PAIN_TRIAGE 嘅 policy row（L1 = 關）。
 * 冇 row = 開。〔全店降 L1〕panic 同時寫 PAIN_TRIAGE→L1。
 * 60 秒 in-memory cache（key = clinicId — 無 aiMode 維度：語義唔跟店模式）。
 */
export async function painTriageEnabled(clinicId: string): Promise<boolean> {
  const hit = painTriageCache.get(clinicId);
  if (hit && Date.now() - hit.at < PAIN_TRIAGE_CACHE_TTL_MS) return hit.enabled;
  let enabled: boolean;
  if (globalCap() === "L1") {
    enabled = false;
  } else {
    const row = await prisma.automationPolicy.findUnique({
      where: { clinicId_category: { clinicId, category: "PAIN_TRIAGE" } },
      select: { level: true },
    });
    enabled = row ? row.level !== "L1" : true;
  }
  if (painTriageCache.size > 500) painTriageCache.clear(); // 防 leak（同 level cache 同式）
  painTriageCache.set(clinicId, { at: Date.now(), enabled });
  return enabled;
}

/**
 * pure 解析（unit test 用 — 零 DB）：exact > star > legacy。
 * @param rows 該店嘅 AutomationPolicy row（category 可含 exact 與 "*"）
 * @param category 請求嘅類（intent 名）
 * @param legacyAiMode clinic.aiMode（DRAFT / AUTO / null = 店唔存在 → L1 保守）
 */
/**
 * ★ cwi-final S4-4：legacy aiMode=AUTO fallback 收窄 — 只 QUESTION / OTHER 返 L2，其餘 intent 返 L1。
 * 舊語義（AUTO→全 intent L2）嘅假設係「AUTO 店 = 已審批全開」；audit3 拍板：冇明確 row 嘅 intent
 * 唔應該有自動覆資格（保守方向）。S0-10 predeploy 已擋 aiMode=AUTO（新店唔會再係 AUTO）— 呢個改動
 * 理論上零生產影響；mock/e2e 環境嘅 legacy AUTO case 已加顯式 AutomationPolicy row 覆蓋。
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
  return legacyAiMode === "AUTO" && (category === "QUESTION" || category === "OTHER") ? "L2" : "L1";
}

export async function getAutomationLevel(clinicId: string, category: string): Promise<AutomationLevel> {
  // 店模式（cache key 依賴佢）— PK select 輕；cache hit 路徑多呢一次輕查詢，換 aiMode 切換即時正確
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { aiMode: true } }).catch(() => null);
  const aiMode = clinic?.aiMode ?? null;
  const cached = cacheGet(clinicId, aiMode, category);
  if (cached) return minLevel(cached, globalCap());
  try {
    const rows = await prisma.automationPolicy.findMany({
      where: { clinicId, category: { in: [category, "*"] } },
    });
    const level = resolveLevel(
      rows.map((r) => ({ category: r.category, level: r.level })),
      category,
      aiMode
    );
    cacheSet(clinicId, aiMode, category, level);
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

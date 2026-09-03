/**
 * Phase D — WorkflowDefinition 讀寫（cwi-ai-20260825-t4）。
 *
 * 讀：getParams(key, clinicId) — ACTIVE(clinic) → ACTIVE(global) → code defaults；
 *     zod safeParse 唔過（schema 演進後舊 row 缺欄）→ merge defaults 補齊；
 *     TTL cache（env WORKFLOW_PARAMS_TTL_MS，底 5 分鐘；e2e 設 0 關 cache）。
 * 寫：saveDraft / publish / revert — **publish 係唯一令參數生效嘅動作**。
 * ★ fail-soft：DB 讀失敗 → code defaults + log warn（workflow 表死唔准拖冧 inbox）。
 * ★ env 變數保留做 code defaults 嘅底（部署層救急）：DB ACTIVE row 有值就贏。
 * ★ PII：audit meta 只 key/clinicId/version — 零 params 原文、零病人資料。
 */
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import log from "@/lib/log";
import { publishControl } from "@/lib/notify";
import {
  LEXICON_DEFAULTS,
  PAIN_TRIAGE_DEFAULTS,
  PARAMS_DEFAULTS,
  PARAMS_SCHEMAS,
  REMINDER_DEFAULTS,
  SESSION_DEFAULTS,
  TRIAGE_DEFAULTS,
  WORKFLOW_KEYS,
  buildGraph,
  type ParamsOf,
  type WorkflowKey,
} from "./definitions";

/** 讀 cache TTL（e2e 用 WORKFLOW_PARAMS_TTL_MS=0 關 cache 確保 publish 即刻生效）。 */
const CACHE_TTL_MS = Number(process.env.WORKFLOW_PARAMS_TTL_MS ?? 5 * 60_000);
const cache = new Map<string, { at: number; params: unknown }>();

/** publish/測試用：清晒 cache（下一 lần getParams 回 DB）。 */
export function bustParamsCache(): void {
  cache.clear();
}

/** store 級業務錯誤（route 層映到 4xx；唔經 api-error 嘅 Prisma 分支）。issues = field-level（表單 inline 顯示）。 */
export class WorkflowError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly issues?: { path: string; message: string }[]
  ) {
    super(message);
    this.name = "WorkflowError";
  }
}

// ── env 救急底（DB ACTIVE row 有值就贏；無 row 先落到呢度）───────────────
function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw?.trim() ? raw.trim() : fallback;
}

/** code defaults（= definitions.ts 原句）+ env 救急底。 */
function codeDefaults<K extends WorkflowKey>(key: K): ParamsOf<K> {
  if (key === "triage") {
    return {
      ...TRIAGE_DEFAULTS,
      humanCooldownMs: envNum("AI_HUMAN_COOLDOWN_MS", TRIAGE_DEFAULTS.humanCooldownMs),
      // cwi-h6-20260830：auto-release 超時（缺口 2 — env 救急底）
      autoReleaseMinutes: envNum("AI_AUTO_RELEASE_MINUTES", TRIAGE_DEFAULTS.autoReleaseMinutes),
    } as ParamsOf<K>;
  }
  if (key === "reminder") {
    return {
      ...REMINDER_DEFAULTS,
      minHours: envNum("REMINDER_MIN_HOURS", REMINDER_DEFAULTS.minHours),
      maxHours: envNum("REMINDER_MAX_HOURS", REMINDER_DEFAULTS.maxHours),
      templateName: envStr("TEMPLATE_REMINDER_NAME", REMINDER_DEFAULTS.templateName),
      templateLang: envStr("TEMPLATE_REMINDER_LANG", REMINDER_DEFAULTS.templateLang),
    } as ParamsOf<K>;
  }
  // ★ Part E（cwi-paintriage-20260903）：兩個新 key 各回自己 defaults（env 救急底 — v1 無）
  if (key === "pain-triage") return PAIN_TRIAGE_DEFAULTS as ParamsOf<K>;
  if (key === "lexicon") return LEXICON_DEFAULTS as ParamsOf<K>;
  return SESSION_DEFAULTS as ParamsOf<K>;
}

/** row params → zod safeParse；唔過 → merge defaults 補齊再試；再唔過 → defaults。 */
function parseRow<K extends WorkflowKey>(key: K, raw: Prisma.JsonValue | null | undefined): ParamsOf<K> {
  const schema = PARAMS_SCHEMAS[key];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const first = schema.safeParse(obj);
    if (first.success) return first.data as ParamsOf<K>;
    // schema 演進後舊 row 缺欄/改型 → merge defaults 補齊（defaults 底，row 值贏）
    const merged = schema.safeParse({ ...(PARAMS_DEFAULTS[key] as Record<string, unknown>), ...obj });
    if (merged.success) {
      log.warn({ key }, "workflow: legacy row 缺欄 → merged with defaults");
      return merged.data as ParamsOf<K>;
    }
    log.warn({ key }, "workflow: bad row → code defaults");
  }
  return codeDefaults(key);
}

function scope(key: WorkflowKey, clinicId: string | null): Prisma.WorkflowDefinitionWhereInput {
  return { key, ...(clinicId ? { clinicId } : { clinicId: null }) };
}

// ── 讀 ────────────────────────────────────────────────────────────────
/**
 * 三級 fallback：ACTIVE(clinic) → ACTIVE(global) → code defaults。
 * fail-soft：DB 死 → code defaults + warn（零 5xx）。
 */
export async function getParams<K extends WorkflowKey>(
  key: K,
  clinicId: string | null
): Promise<ParamsOf<K>> {
  const cacheKey = `${key}::${clinicId ?? "*"}`;
  if (CACHE_TTL_MS > 0) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.params as ParamsOf<K>;
  }
  let params: ParamsOf<K>;
  try {
    const clinicRow = clinicId
      ? await prisma.workflowDefinition.findFirst({
          where: { key, clinicId, status: "ACTIVE" },
          select: { params: true },
        })
      : null;
    const row =
      clinicRow ??
      (await prisma.workflowDefinition.findFirst({
        where: { key, clinicId: null, status: "ACTIVE" },
        select: { params: true },
      }));
    params = row ? parseRow(key, row.params) : codeDefaults(key);
  } catch (err) {
    // ★ fail-soft：workflow 表死（drop/rename/DB 斷線）→ defaults 頂上，inbox 照行
    log.warn(
      { key, err: err instanceof Error ? err.message : String(err) },
      "workflow: DB 讀失敗 → code defaults（fail-soft）"
    );
    params = codeDefaults(key);
  }
  if (CACHE_TTL_MS > 0) cache.set(cacheKey, { at: Date.now(), params });
  return params;
}

// ── 寫 ────────────────────────────────────────────────────────────────
/** 存草稿（zod 驗證；version = 同 scope max+1）。publish 前唔生效。 */
export async function saveDraft<K extends WorkflowKey>(
  key: K,
  clinicId: string | null,
  params: unknown,
  staffId: string | null
): Promise<{ id: string; version: number }> {
  const parsed = PARAMS_SCHEMAS[key].safeParse(params);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    const msg = issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    throw new WorkflowError(400, msg, issues);
  }
  const p = parsed.data as ParamsOf<K>;
  const row = await prisma.$transaction(async (tx) => {
    const max = await tx.workflowDefinition.aggregate({
      where: scope(key, clinicId),
      _max: { version: true },
    });
    return tx.workflowDefinition.create({
      data: {
        clinicId,
        key,
        version: (max._max.version ?? 0) + 1,
        status: "DRAFT",
        params: p as Prisma.InputJsonValue,
        graph: buildGraph(key, p) as unknown as Prisma.InputJsonValue,
        createdBy: staffId,
      },
    });
  });
  // audit（fail-soft：audit 寫失敗唔阻 draft — 但留 warn）
  await prisma.auditLog
    .create({
      data: {
        staffId,
        action: "WORKFLOW_DRAFT",
        entity: "WorkflowDefinition",
        entityId: row.id,
        meta: { key, clinicId, version: row.version } as Prisma.InputJsonValue,
      },
    })
    .catch((err) => log.warn({ err: err instanceof Error ? err.message : String(err) }, "workflow: WORKFLOW_DRAFT audit 寫失敗"));
  return { id: row.id, version: row.version };
}

/**
 * 發佈（唯一生效動作）：transaction 內舊 ACTIVE(同 scope) → ARCHIVED，本 row → ACTIVE。
 * 同 key+clinicId 永遠只一個 ACTIVE（clinic 與 global 各一個，fallback 層解）。
 */
export async function publish(defId: string, staffId: string | null): Promise<void> {
  const row = await prisma.workflowDefinition.findUnique({ where: { id: defId } });
  if (!row) throw new WorkflowError(404, "definition not found");
  if (row.status === "ACTIVE") throw new WorkflowError(409, "already active");
  if (row.status === "ARCHIVED") throw new WorkflowError(409, "cannot re-publish archived row");
  if (!WORKFLOW_KEYS.includes(row.key as WorkflowKey)) {
    throw new WorkflowError(400, `unknown workflow key: ${row.key}`);
  }
  const wfKey = row.key as WorkflowKey;
  await prisma.$transaction(async (tx) => {
    await tx.workflowDefinition.updateMany({
      where: { ...scope(wfKey, row.clinicId), status: "ACTIVE" },
      data: { status: "ARCHIVED" },
    });
    await tx.workflowDefinition.update({
      where: { id: defId },
      data: { status: "ACTIVE", publishedAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        staffId,
        action: "WORKFLOW_PUBLISH",
        entity: "WorkflowDefinition",
        entityId: defId,
        meta: { key: wfKey, clinicId: row.clinicId, version: row.version } as Prisma.InputJsonValue,
      },
    });
  });
  bustParamsCache();
  publishControl({ cmd: "cache:bust", scope: "workflow" }); // ★ Fix B（cwi-fix-20260825-f1）：web 其他 process 即時失效（revert 經 publish 亦覆蓋）
}

/**
 * 回退 = 讀 toVersion row params → saveDraft → publish（re-publish as v(n+1)；歷史唔改寫）。
 */
export async function revert<K extends WorkflowKey>(
  key: K,
  clinicId: string | null,
  toVersion: number,
  staffId: string | null
): Promise<{ id: string; newVersion: number }> {
  const target = await prisma.workflowDefinition.findFirst({ where: { ...scope(key, clinicId), version: toVersion } });
  if (!target) throw new WorkflowError(404, `version ${toVersion} not found`);
  const parsed = PARAMS_SCHEMAS[key].safeParse(target.params);
  if (!parsed.success) {
    throw new WorkflowError(400, `version ${toVersion} 內容已失效（schema 演進），唔可回退`);
  }
  const { id, version } = await saveDraft(key, clinicId, parsed.data, staffId);
  await publish(id, staffId);
  return { id, newVersion: version };
}

// ── admin 查詢 ─────────────────────────────────────────────────────────
export interface WorkflowVersionInfo {
  id: string;
  version: number;
  status: string;
  createdBy: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  params: Record<string, unknown>;
}

/** 版本列（DESC）— admin 版本 tab。 */
export async function listVersions(key: WorkflowKey, clinicId: string | null): Promise<WorkflowVersionInfo[]> {
  const rows = await prisma.workflowDefinition.findMany({
    where: scope(key, clinicId),
    orderBy: { version: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    status: r.status,
    createdBy: r.createdBy,
    publishedAt: r.publishedAt,
    createdAt: r.createdAt,
    params: (r.params ?? {}) as Record<string, unknown>,
  }));
}

export interface WorkflowActiveInfo<K extends WorkflowKey> {
  key: K;
  /** 生效來源：clinic row / global row / code defaults（含 env 底） */
  source: "clinic" | "global" | "defaults";
  version: number;
  params: ParamsOf<K>;
  publishedAt: Date | null;
  defaults: ParamsOf<K>;
}

/** admin GET /api/admin/workflows：每 key 生效參數 + 來源 + code defaults。fail-soft（DB 死 → defaults）。 */
export async function getActiveInfo<K extends WorkflowKey>(key: K, clinicId: string | null): Promise<WorkflowActiveInfo<K>> {
  const defaults = codeDefaults(key);
  let clinicRow: { version: number; params: Prisma.JsonValue; publishedAt: Date | null } | null = null;
  let globalRow: { version: number; params: Prisma.JsonValue; publishedAt: Date | null } | null = null;
  try {
    [clinicRow, globalRow] = await Promise.all([
      clinicId
        ? prisma.workflowDefinition.findFirst({
            where: { key, clinicId, status: "ACTIVE" },
            select: { version: true, params: true, publishedAt: true },
          })
        : Promise.resolve(null),
      prisma.workflowDefinition.findFirst({
        where: { key, clinicId: null, status: "ACTIVE" },
        select: { version: true, params: true, publishedAt: true },
      }),
    ]);
  } catch (err) {
    log.warn({ key, err: err instanceof Error ? err.message : String(err) }, "workflow: getActiveInfo DB 讀失敗 → defaults（fail-soft）");
  }
  const row = clinicRow ?? globalRow;
  if (!row) {
    return { key, source: "defaults", version: 0, params: defaults, publishedAt: null, defaults };
  }
  return {
    key,
    source: clinicRow ? "clinic" : "global",
    version: row.version,
    params: parseRow(key, row.params),
    publishedAt: row.publishedAt,
    defaults,
  };
}

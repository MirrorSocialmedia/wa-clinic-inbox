/**
 * ★ cwi-final S1-1a：Alert 開/冪等層（由 health/check.ts 抽出 — S1-15、S0-11、S1-14 都會用）。
 *
 * 語義（冪等）：
 * - 同 (type, clinicId) 未解決（resolvedAt=null）只可有一條 — 新開先 notifyAlert。
 * - 回 true = 呢一輪新開咗 alert（已通知）；false = 已有未解決 / 開 alert 失敗。
 *
 * ★ R-28（同批修）：自動 resolve 只准 health-check 自己擁有嘅 type（HEALTH_OWNED_TYPES）—
 *   `inbound_failed`（DLQ）/ `outbound_unknown` / `hold_expired_unhandled` 等「需要人跟」嘅
 *   alert 唔准被 runHealthCheck 自動 resolve（見 check.ts openAlerts query 嘅 type filter）。
 *
 * ★ D-2：detail 只准 metadata（number / boolean / ≤200 字串）— notifyAlert 入面嘅
 *   sanitizeAlertDetail 會 drop array/object（第二層白名單 hard-gate）。
 */
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import log from "@/lib/log";
import { notifyAlert } from "./notify";

/** ★ cwi-final S1-1a：health-check 自己擁有（會自動 resolve）嘅 type。其他 type 只可以人手 resolve。
 *  ⚠️ check.ts 每加一個 breach type 都要加入呢個 set — unit test（scripts/unit-health-owned-types.ts）
 *  grep check.ts 所有 `type: "..."` ⊆ 呢個 set 防漏。 */
export const HEALTH_OWNED_TYPES = new Set<string>([
  // = health/check.ts 現有 breach type（:92 webhook_stale, :120 queue_depth, :136 ai_breaker_open,
  //   :153/:167 workforce_api_degraded, :193 disk_low, :225 backup_failed）+ S0-11 新增
  "webhook_stale",
  "queue_depth",
  "ai_breaker_open",
  "workforce_api_degraded",
  "disk_low",
  "backup_failed",
  "retention_env_mismatch",
]);

export interface UpsertAlertInput {
  type: string;
  severity: "MEDIUM" | "HIGH";
  clinicId?: string | null;
  clinicCode?: string | null;
  detail: Record<string, unknown>;
}

/** 同 (type, clinicId) 未解決只一條；新開先通知。回 true = 新開。 */
export async function upsertAlert(a: UpsertAlertInput): Promise<boolean> {
  const clinicId = a.clinicId ?? null;
  let existing: { id: string } | null = null;
  try {
    existing = await prisma.alert.findFirst({
      where: { type: a.type, clinicId, resolvedAt: null },
      select: { id: true },
    });
  } catch (err) {
    // DB 瞬時不可用：視作「開唔到」— 唔 throw（caller 可能係 failed handler，唔准炸 worker 事件）。
    log.error({ type: a.type, err: err instanceof Error ? err.message : String(err) }, "upsertAlert: findFirst failed");
    return false;
  }
  if (existing) return false;
  try {
    await prisma.alert.create({
      data: {
        type: a.type,
        severity: a.severity,
        clinicId,
        clinicCode: a.clinicCode ?? null,
        detail: a.detail as object,
      },
    });
    await notifyAlert({ type: a.type, severity: a.severity, clinicCode: a.clinicCode ?? null, detail: a.detail });
    return true;
  } catch (err) {
    // ★ B3 fix（T610 實錘 alertOpen=3）：check-then-insert 非原子 — 並行 caller 都睇到 0 條未解決 →
    //   雙 create。migration 20260920070000 加 partial unique index（type, coalesce(clinicId,'') WHERE
    //   resolvedAt IS NULL）→ 輸家撞 P2002：視為「已有人新開」，返 false（唔重複 notifyAlert）。
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return false;
    }
    log.error({ type: a.type, err: err instanceof Error ? err.message : String(err) }, "upsertAlert failed");
    return false;
  }
}

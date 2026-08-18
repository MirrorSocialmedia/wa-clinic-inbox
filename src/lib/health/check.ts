/**
 * 5 分鐘健康自檢（MD §9.3）— cron `health-check`（每 5 分鐘一次）+ scripts/e2e-health.ts 共用。
 *
 * 五項檢查：
 *  1. webhook stale      — 有 traffic（lastWebhookEventAt != null）但 > 30 分鐘無事件 → MEDIUM
 *                          （店員 uninstall App / 13 日冇開 嘅前哨 — MD §11 風險登記冊）
 *  2. queue depth        — ai / outbound / apricot 任一 queue waiting+failed > 100 → MEDIUM
 *  3. AI breaker OPEN    — HIGH（GPU 死 / sglang 重連中）
 *  4. Apricot heartbeat  — 上次成功 sync > 90 分鐘（或從未 sync）→ MEDIUM
 *  5. disk 餘量          — < 10% → HIGH
 *
 * 警報生命周期（冪等）：
 * - breach 中：同 (type, clinicId) 已有未解決 alert → 唔重覆開（每 5 分鐘 cycle 只彈一次）
 * - breach 中：無未解決 alert → 開新 Alert + notifyAlert
 * - 已恢復：    未解決 alert 對應嘅 (type, clinicId) 唔再 breach → set resolvedAt（自動恢復）
 *
 * ★ iron rule 1：Alert.detail 只准 metadata（數字/計數/short code）— 零訊息原文。
 *
 * overrides：E2E 注入用（queueDepth / breakerState）— production scheduler 唔會傳。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { getBreakerState } from "@/lib/ai/vllm";
import { notifyAlert, type AlertForNotify } from "./notify";

const pExecFile = promisify(execFile);

// ── 閾值（MD §9.3） ──────────────────────────────────────────────────────
export const WEBHOOK_STALE_MIN = 30;      // 有 traffic 但 > 30 分鐘無事件
export const QUEUE_DEPTH_LIMIT = 100;     // waiting + failed
export const APRICOT_SYNC_STALE_MIN = 90; // 上次成功 sync > 90 分鐘
export const DISK_FREE_PCT_LIMIT = 10;    // 剩餘 < 10%

const CHECKED_QUEUES = ["ai", "outbound", "apricot"] as const;
type CheckedQueue = (typeof CHECKED_QUEUES)[number];

export interface HealthOverrides {
  /** E2E 注入：覆蓋 queue 實測 depth（queue → waiting/failed） */
  queueDepth?: Partial<Record<CheckedQueue, { waiting: number; failed: number }>>;
  /** E2E 注入：覆蓋 breaker 狀態（breaker 係 per-process in-memory — 另開 process 睇唔到） */
  breakerState?: "closed" | "open";
}

export interface HealthCheckResult {
  created: AlertForNotify[];
  resolved: number;
  checks: Record<string, unknown>;
}

interface Breach {
  type: string;
  severity: string;
  clinicId: string | null;
  clinicCode: string | null;
  detail: Record<string, unknown>;
}

/**
 * 跑一轮健康自檢。
 * @returns 新開嘅 alert（已通知）+ 自動解決數量 + 每項 check 嘅 metadata 快照
 */
export async function runHealthCheck(
  overrides?: HealthOverrides
): Promise<HealthCheckResult> {
  const now = new Date();
  const breaches: Breach[] = [];

  // ── 1. webhook stale（per clinic，有 traffic 先計） ────────────────────
  const clinics = await prisma.clinic.findMany({
    select: { id: true, code: true, lastWebhookEventAt: true },
    orderBy: { code: "asc" },
  });
  const webhookInfo: Record<string, number | null> = {};
  for (const c of clinics) {
    if (c.lastWebhookEventAt === null) {
      webhookInfo[c.code] = null; // 從來無 traffic — 唔算 stale（MD：無 traffic 唔算）
      continue;
    }
    const minSince = (now.getTime() - c.lastWebhookEventAt.getTime()) / 60000;
    webhookInfo[c.code] = Math.round(minSince);
    if (minSince > WEBHOOK_STALE_MIN) {
      breaches.push({
        type: "webhook_stale",
        severity: "MEDIUM",
        clinicId: c.id,
        clinicCode: c.code,
        detail: { minutesSince: Math.round(minSince), thresholdMin: WEBHOOK_STALE_MIN },
      });
    }
  }

  // ── 2. queue depth（ai / outbound / apricot） ─────────────────────────
  const queueInfo: Record<string, { waiting: number; failed: number }> = {};
  for (const q of CHECKED_QUEUES) {
    if (overrides?.queueDepth?.[q]) {
      queueInfo[q] = overrides.queueDepth[q]!;
    } else {
      // 延後 import 防 circular：queue lib 唔依賴 health
      const mod = await import("@/lib/queue");
      const queueObj = (mod as Record<string, unknown>)[`${q}Queue`];
      const counts = (await (queueObj as { getJobCounts: (...s: string[]) => Promise<Record<string, number>> }).getJobCounts(
        "waiting",
        "active",
        "failed"
      )) as Record<string, number>;
      queueInfo[q] = { waiting: counts.waiting ?? 0, failed: counts.failed ?? 0 };
    }
    const total = queueInfo[q].waiting + queueInfo[q].failed;
    if (total > QUEUE_DEPTH_LIMIT) {
      breaches.push({
        type: "queue_depth",
        severity: "MEDIUM",
        clinicId: null,
        clinicCode: null,
        detail: { queue: q, waiting: queueInfo[q].waiting, failed: queueInfo[q].failed, limit: QUEUE_DEPTH_LIMIT },
      });
    }
  }

  // ── 3. AI breaker OPEN ────────────────────────────────────────────────
  const breaker = overrides?.breakerState
    ? { state: overrides.breakerState, openUntilMs: null }
    : getBreakerState();
  if (breaker.state === "open") {
    const remainSec = breaker.openUntilMs ? Math.max(0, Math.round((breaker.openUntilMs - now.getTime()) / 1000)) : null;
    breaches.push({
      type: "ai_breaker_open",
      severity: "HIGH",
      clinicId: null,
      clinicCode: null,
      detail: { openUntilSec: remainSec },
    });
  }

  // ── 4. Apricot heartbeat（上次成功 sync） ─────────────────────────────
  const apricot = await prisma.apricotSession.findUnique({ where: { id: 1 } });
  let apricotMin: number | null = null;
  if (apricot?.lastSyncAt) {
    apricotMin = Math.round((now.getTime() - apricot.lastSyncAt.getTime()) / 60000);
  }
  if (apricotMin === null || apricotMin > APRICOT_SYNC_STALE_MIN) {
    breaches.push({
      type: "apricot_sync_stale",
      severity: "MEDIUM",
      clinicId: null,
      clinicCode: null,
      detail: apricotMin === null
        ? { reason: "never-synced", thresholdMin: APRICOT_SYNC_STALE_MIN }
        : { minutesSince: apricotMin, thresholdMin: APRICOT_SYNC_STALE_MIN },
    });
  }

  // ── 5. disk 餘量（root + WA_MEDIA_DIR mount，按 device 去重） ──────────
  const diskInfo: Record<string, number | null> = {};
  const paths = ["/", (process.env.WA_MEDIA_DIR ?? "").trim()].filter(Boolean);
  const seenDevices = new Set<string>();
  for (const p of paths) {
    try {
      const { stdout } = await pExecFile("df", ["-P", p], { timeout: 5000 });
      const lines = stdout.trim().split("\n");
      if (lines.length < 2) continue;
      const cols = lines[1].split(/\s+/);
      const device = cols[0];
      const freePct = parseInt(cols[4]?.replace("%", "") ?? "", 10);
      diskInfo[p] = Number.isFinite(freePct) ? freePct : null;
      if (seenDevices.has(device)) continue;
      seenDevices.add(device);
      if (Number.isFinite(freePct) && freePct < DISK_FREE_PCT_LIMIT) {
        breaches.push({
          type: "disk_low",
          severity: "HIGH",
          clinicId: null,
          clinicCode: null,
          detail: { path: p, device, freePct, limitPct: DISK_FREE_PCT_LIMIT },
        });
      }
    } catch (err) {
      diskInfo[p] = null; // df 唔可用（非 Linux？）→ skip 唔崩
      log.debug({ path: p, err: err instanceof Error ? err.message : String(err) }, "health: df unavailable — skip disk check");
    }
  }

  // ── 冪等開 alert + 自動 resolve ────────────────────────────────────────
  const created: AlertForNotify[] = [];
  let resolved = 0;

  for (const b of breaches) {
    const existing = await prisma.alert.findFirst({
      where: { type: b.type, clinicId: b.clinicId, resolvedAt: null },
      select: { id: true },
    });
    if (!existing) {
      await prisma.alert.create({
        data: {
          type: b.type,
          severity: b.severity,
          clinicId: b.clinicId,
          clinicCode: b.clinicCode,
          detail: b.detail as unknown as object,
        },
      });
      created.push({ type: b.type, severity: b.severity, clinicCode: b.clinicCode, detail: b.detail });
      await notifyAlert({ type: b.type, severity: b.severity, clinicCode: b.clinicCode, detail: b.detail });
    }
  }

  // 恢復中：未解決 alert 但 (type, clinicId) 唔再 breach → resolve
  // （queue_depth 嘅 detail.queue 唔入 key — 恢復判定用「呢個 type+clinic 冇任何 breach」，
  //   同一 type 多個 breach 全部清先 resolve，保守冪等）
  const breachKeys = new Set(breaches.map((b) => `${b.type}|${b.clinicId ?? ""}`));
  const openAlerts = await prisma.alert.findMany({ where: { resolvedAt: null }, select: { id: true, type: true, clinicId: true } });
  for (const a of openAlerts) {
    if (!breachKeys.has(`${a.type}|${a.clinicId ?? ""}`)) {
      const r = await prisma.alert.updateMany({
        where: { id: a.id, resolvedAt: null },
        data: { resolvedAt: now },
      });
      if (r.count > 0) {
        resolved += 1;
        log.info({ type: a.type, clinic: a.clinicId }, "health: alert auto-resolved");
      }
    }
  }

  log.info(
    {
      webhook: webhookInfo,
      queues: queueInfo,
      breaker: breaker.state,
      apricotSyncMin: apricotMin,
      disk: diskInfo,
      created: created.map((c) => c.type),
      resolved,
    },
    "health-check done"
  );

  return {
    created,
    resolved,
    checks: { webhook: webhookInfo, queues: queueInfo, breaker: breaker.state, apricotSyncMin: apricotMin, disk: diskInfo },
  };
}

/**
 * GET /api/admin/apricot-status — Apricot session + 空檔 sync 新鮮度（MD 任務 D）
 *
 * 用途（14 日 token 唔死驗收 + 排障）：
 * - session：上次 sync / 上次 keepalive / 上次錯誤 / rotation 次數 / token 有效期估算
 * - 各店 slot 新鮮度：min/max syncedAt + slot 數（15 分鐘內 = 新鮮）
 *
 * ★ 只回 metadata — 零 token 原文、零病人資料。
 */
import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { apricotMock } from "@/lib/apricot/session";
import { syncWindow } from "@/lib/apricot/slots";

export const dynamic = "force-dynamic";

const ACCESS_TOKEN_TTL_HOURS = 10; // access_token JWT ~10h（provider-roster 實測）
const REFRESH_SLIDING_DAYS = 7; // refresh_token 7 日 sliding window

export const GET = handle(async (_req: NextRequest) => {
  const _ctx = await requireAdmin(_req);

  const session = await prisma.apricotSession.findUnique({ where: { id: 1 } });
  const clinics = await prisma.clinic.findMany({
    select: { id: true, code: true, apricotClinicId: true },
  });

  const freshness = [];
  for (const c of clinics) {
    const agg = await prisma.availabilitySlot.aggregate({
      where: { clinicId: c.id },
      _min: { syncedAt: true },
      _max: { syncedAt: true },
      _count: { _all: true },
    });
    freshness.push({
      clinicId: c.id,
      code: c.code,
      apricotClinicId: c.apricotClinicId,
      slotCount: agg._count._all,
      oldestSyncAt: agg._min.syncedAt,
      newestSyncAt: agg._max.syncedAt,
      fresh: Boolean(agg._max.syncedAt && Date.now() - agg._max.syncedAt.getTime() < 20 * 60 * 1000),
    });
  }

  // token 有效期估算（metadata — 由 rotation 紀錄推；唔讀 token 本身）
  const lastActivity =
    session?.lastSyncAt && session?.lastKeepaliveAt
      ? new Date(Math.max(session.lastSyncAt.getTime(), session.lastKeepaliveAt.getTime()))
      : session?.lastSyncAt ?? session?.lastKeepaliveAt ?? null;
  const hoursSinceActivity = lastActivity ? (Date.now() - lastActivity.getTime()) / 3600000 : null;

  return NextResponse.json({
    mock: apricotMock(),
    baseUrl: (process.env.APRICOT_BASE_URL ?? "https://apricotvita.com").replace(/\/+$/, ""),
    session: session
      ? {
          configured: true,
          lastSyncAt: session.lastSyncAt,
          lastKeepaliveAt: session.lastKeepaliveAt,
          lastError: session.lastError,
          rotationCount: session.rotationCount,
          updatedAt: session.updatedAt,
          estimated: {
            accessTtlHours: ACCESS_TOKEN_TTL_HOURS,
            refreshSlidingDays: REFRESH_SLIDING_DAYS,
            hoursSinceLastActivity: hoursSinceActivity === null ? null : Math.round(hoursSinceActivity * 10) / 10,
            // 14 日驗收：只要 keepalive(3日) + sync(15分鐘) 有心行，sliding window 永遠唔會斷
            healthy: Boolean(lastActivity && hoursSinceActivity !== null && hoursSinceActivity < 48),
          },
        }
      : { configured: false },
    syncWindow: syncWindow(),
    clinics: freshness,
  });
});

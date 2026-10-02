import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireGlobalAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { syncProvidersFromWorkforce } from "@/lib/provider-sync";

/**
 * ★ cwi-roster-20261001：醫生名錄同步管理（ADMIN-only — 同 /api/admin/company-sync 同口徑）。
 *
 * GET  /api/admin/provider-sync
 *   → { lastRun }（ProviderSyncRun 最新一行 — hub 卡片 mount 時 call）
 *
 * POST /api/admin/provider-sync
 *   手動「立即同步醫生名錄」— 行 syncProvidersFromWorkforce() + 落 ProviderSyncRun 行（同每鐘 :20 cron 同源）。
 *   200: { ok: true, ...summary }（加咗幾多 linksAdded / 刪咗幾多 linksPruned / 對唔上 unmatchedClinics / stale staleClinics）
 *   502: { ok: false, error }（fetch 失敗 / clinics 空 — 零改動）
 */

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  await requireGlobalAdmin(req);
  const lastRun = await prisma.providerSyncRun.findFirst({ orderBy: { runAt: "desc" } });
  return NextResponse.json({
    lastRun: lastRun
      ? {
          id: lastRun.id,
          runAt: lastRun.runAt,
          status: lastRun.status,
          summary: lastRun.summary ? JSON.parse(lastRun.summary) : null,
          error: lastRun.error,
        }
      : null,
  });
});

export const POST = handle(async (req: NextRequest) => {
  await requireGlobalAdmin(req);
  const result = await syncProvidersFromWorkforce();
  await prisma.providerSyncRun.create({
    data: result.ok
      ? { status: "ok", summary: JSON.stringify(result.summary) }
      : { status: "failed", summary: JSON.stringify({}), error: result.error },
  });
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 502 });
  return NextResponse.json({ ok: true, ...result.summary });
});

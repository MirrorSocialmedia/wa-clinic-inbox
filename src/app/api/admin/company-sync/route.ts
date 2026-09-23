import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireGlobalAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { syncCompaniesFromWorkforce } from "@/lib/company-sync";
import { fetchCompanies } from "@/lib/workforce/client";

/**
 * ★ cwi-followup-p0-20260915（MD §1.1）：公司同步管理（ADMIN-only）。
 *
 * GET  /api/admin/company-sync
 *   → { lastRun, companies: [本地快取 + sourceId], remote: { companies: [{id,name}] } | null }
 *   remote = 即時打 workforce（hub 卡片 mount 時 call；workforce 落 → null，唔 block 本地數據）。
 *
 * POST /api/admin/company-sync
 *   手動「立即同步」— 行 syncCompaniesFromWorkforce() + 落 CompanySyncRun 行（同 03:00 cron 同源）。
 *
 * POST /api/admin/company-sync/pair
 *   人手配對（MD §1.1 — name 對唔上 sourceId=null 公司嘅出口）：
 *   body { companyId, sourceId: string | null }（null = 取消配對）。
 */

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  await requireGlobalAdmin(req);
  const [lastRun, companies] = await Promise.all([
    prisma.companySyncRun.findFirst({ orderBy: { runAt: "desc" } }),
    prisma.company.findMany({
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true, enabled: true, sourceId: true },
    }),
  ]);

  let remote: { companies: { id: string; name: string }[] } | null = null;
  try {
    const r = await fetchCompanies();
    remote = { companies: r.companies.map((c) => ({ id: c.id, name: c.name })) };
  } catch {
    /* workforce 落 — remote null（hub 卡片顯示「workforce 唔通」） */
  }

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
    companies,
    remote,
  });
});

export const POST = handle(async (req: NextRequest) => {
  await requireGlobalAdmin(req);
  const result = await syncCompaniesFromWorkforce();
  await prisma.companySyncRun.create({
    data: result.ok
      ? { status: "ok", summary: JSON.stringify(result.summary) }
      : { status: "failed", summary: JSON.stringify({}), error: result.error },
  });
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 502 });
  return NextResponse.json({ ok: true, ...result.summary });
});

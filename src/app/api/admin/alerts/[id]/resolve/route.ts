import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import log from "@/lib/log";

/**
 * POST /api/admin/alerts/[id]/resolve — 手動標記警報 resolved（ADMIN-only）。
 *
 * 冪等：已 resolved 嘅 alert 再 resolve → 200（唔改動）。
 * （自動恢復由下一次 health/quality check 做 — 呢度係人手覆核「睇完，唔使跟」。）
 */
export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => {
  const auth = await requireAdmin(req);
  const { id } = await ctx.params;

  const alert = await prisma.alert.findUnique({ where: { id } });
  if (!alert) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (!alert.resolvedAt) {
    await prisma.alert.update({ where: { id: alert.id }, data: { resolvedAt: new Date() } });
    log.info(
      { alertId: alert.id, type: alert.type, clinic: alert.clinicCode ?? null, byStaff: auth.staff.id },
      "alert: manually resolved"
    );
  }

  const fresh = await prisma.alert.findUnique({ where: { id: alert.id } });
  return NextResponse.json({
    id: fresh!.id,
    type: fresh!.type,
    severity: fresh!.severity,
    resolvedAt: fresh!.resolvedAt,
  });
});

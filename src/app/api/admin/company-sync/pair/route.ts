import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { z } from "zod";

/**
 * ★ cwi-followup-p0-20260915（MD §1.1）：公司人手配對（ADMIN-only）。
 *
 * POST /api/admin/company-sync/pair
 *   body { companyId: string, sourceId: string | null }
 *   sourceId = workforce Company.id（GET /api/admin/company-sync 嘅 remote 列表）；
 *   null = 取消配對。
 *
 * 守門：sourceId 唔准被其他本地公司占用（@unique 兜底 + 明確 409 訊息）。
 */

export const dynamic = "force-dynamic";

const Body = z.object({
  companyId: z.string().min(1),
  sourceId: z.string().min(1).nullable(),
});

export const POST = handle(async (req: NextRequest) => {
  await requireAdmin(req);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body: companyId + sourceId required" }, { status: 400 });
  }
  const { companyId, sourceId } = parsed.data;

  const local = await prisma.company.findUnique({ where: { id: companyId } });
  if (!local) return NextResponse.json({ error: "company not found" }, { status: 404 });

  if (sourceId) {
    const taken = await prisma.company.findUnique({ where: { sourceId } });
    if (taken && taken.id !== companyId) {
      return NextResponse.json({ error: `sourceId 已被公司 ${taken.code} 占用` }, { status: 409 });
    }
  }

  await prisma.company.update({ where: { id: companyId }, data: { sourceId } });
  return NextResponse.json({ ok: true, companyId, sourceId });
});

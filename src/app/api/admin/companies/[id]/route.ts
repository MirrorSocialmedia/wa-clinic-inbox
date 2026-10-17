import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireGlobalAdmin } from "@/lib/rbac";
import { handle, toResponse } from "@/lib/api-error";

/**
 * PATCH /api/admin/companies/[id] — 公司轉地點白名單（★ cwi-inbox-r4，擁有人拍板 2026-10-17）
 *
 * body: { transferToCompanyIds: string[] } — 呢間公司嘅對話可以轉去邊幾間其他公司嘅分店（單向）。
 * 權限：全公司權限 ADMIN（requireGlobalAdmin）— 公司範圍 ADMIN 改唔到（跨租戶決定）。
 * 驗證：id 要存在、唔可以包自己；去重。AuditLog COMPANY_TRANSFER_POLICY（before / after）。
 */
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

const schema = z.object({ transferToCompanyIds: z.array(z.string().min(1).max(64)).max(50) });

export const PATCH = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireGlobalAdmin(req);
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);

  const company = await prisma.company.findUnique({ where: { id }, select: { id: true, transferToCompanyIds: true } });
  if (!company) return NextResponse.json({ error: "company not found" }, { status: 404 });

  const ids = [...new Set(parsed.data.transferToCompanyIds)];
  if (ids.includes(id)) return NextResponse.json({ error: "唔使揀自己公司（同公司本身已經可以轉）", code: "SELF" }, { status: 400 });
  const found = await prisma.company.count({ where: { id: { in: ids } } });
  if (found !== ids.length) return NextResponse.json({ error: "有公司唔存在", code: "UNKNOWN_COMPANY" }, { status: 400 });

  const updated = await prisma.company.update({ where: { id }, data: { transferToCompanyIds: ids }, select: { id: true, transferToCompanyIds: true } });
  await prisma.auditLog.create({
    data: {
      staffId: auth.staff.id,
      action: "COMPANY_TRANSFER_POLICY",
      entity: "Company",
      entityId: id,
      meta: { before: company.transferToCompanyIds, after: ids } as object,
    },
  });
  return NextResponse.json(updated);
});

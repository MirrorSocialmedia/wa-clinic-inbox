/**
 * ★ consult v2.1 C5（MD §8.1 Tab 1 簽署列）：產品醫生確認。
 *
 * POST /api/admin/consult-products/:id/approve
 *      — body { approvedBy: string }（醫生名，畫面「你嘅名____」撳確認填入）。
 *      寫 approvedBy + approvedAt=now → 產品轉 usable（enabled=true 時）→ AI 下次回覆即刻可用。
 *      audit `CONSULT_PRODUCT_APPROVED`（MD §8.1 逐字 action 名）。
 *      冪等：重複確認 = 刷新 approvedAt + 再記一條 audit（醫生重新確認係有意義事件）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import prisma from "@/lib/prisma";
import { isProductUsable } from "@/lib/sessions/consult-products";
import log from "@/lib/log";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

export const POST = handle(async (req: NextRequest, { params }: Params) => {
  const ctx = await requireAdmin(req);
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = z.object({ approvedBy: z.string().min(1).max(60) }).safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation failed", issues: parsed.error.issues }, { status: 400 });
  }
  const existing = await prisma.consultProduct.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  const updated = await prisma.consultProduct.update({
    where: { id },
    data: { approvedBy: parsed.data.approvedBy, approvedAt: new Date() },
  });
  await prisma.auditLog.create({
    data: {
      staffId: ctx.staff.id,
      action: "CONSULT_PRODUCT_APPROVED",
      entity: "ConsultProduct",
      entityId: id,
      meta: { clinicId: updated.clinicId, workflow: updated.workflow, code: updated.code, approvedBy: updated.approvedBy, usable: isProductUsable(updated) } as object,
    },
  });
  log.info({ staffId: ctx.staff.id, productId: id, approvedBy: parsed.data.approvedBy }, "consult-products: approved");
  return NextResponse.json({
    id,
    approvedBy: updated.approvedBy,
    approvedAt: updated.approvedAt,
    usable: isProductUsable(updated),
  });
});

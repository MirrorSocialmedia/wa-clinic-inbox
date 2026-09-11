/**
 * ★ consult v2.1 C2（MD §3）：ConsultProduct 條目 PUT/PATCH（ADMIN-only）。
 *
 * PUT    — 增量更新（zod consultProductUpdateSchema；未提供欄位保持原值）+ AuditLog。
 * PATCH  — 啟用/停用（{ enabled: boolean }）— 停用後 isProductUsable=false →
 *          立即離開一切 AI 草稿/檢索（C3 檢索每次 query 都經 helper，唔需要 cache bust）。
 *
 * 鐵律提醒：改 approvedAt/approvedBy 唔會自動「批准」以外嘅效果 — usable 純由
 *   enabled && approvedAt!=null 決定（isProductUsable 單一來源）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { consultProductUpdateSchema, isProductUsable } from "@/lib/sessions/consult-products";
import log from "@/lib/log";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

export const PUT = handle(async (req: NextRequest, { params }: Params) => {
  const ctx = await requireAdmin(req);
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = consultProductUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation failed", issues: parsed.error.issues }, { status: 400 });
  }
  const d = parsed.data;
  const existing = await prisma.consultProduct.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  // 增量：未提供 = 保持原值（undefined 唔入 data）
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (v !== undefined) data[k] = v;
  }
  try {
    const updated = await prisma.consultProduct.update({ where: { id }, data });
    await prisma.auditLog.create({
      data: {
        staffId: ctx.staff.id,
        action: "CONSULT_PRODUCT_UPDATE",
        entity: "ConsultProduct",
        entityId: id,
        // 零 PII（產品 = staff 管嘅參數）— 只記被改咗嘅欄名
        meta: { clinicId: updated.clinicId, workflow: updated.workflow, code: updated.code, fields: Object.keys(data), usable: isProductUsable(updated) } as object,
      },
    });
    log.info({ staffId: ctx.staff.id, productId: id, fields: Object.keys(data) }, "consult-products: updated");
    return NextResponse.json({
      id,
      enabled: updated.enabled,
      approvedAt: updated.approvedAt,
      usable: isProductUsable(updated),
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      return NextResponse.json({ error: "conflict", message: "同店同 workflow 已有同 code 產品" }, { status: 409 });
    }
    throw err;
  }
});

/** 啟用/停用（iron rule 生效點：停用 → 即刻離開 AI 草稿/檢索）。 */
export const PATCH = handle(async (req: NextRequest, { params }: Params) => {
  const ctx = await requireAdmin(req);
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = z.object({ enabled: z.boolean() }).safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation failed", issues: parsed.error.issues }, { status: 400 });
  }
  const existing = await prisma.consultProduct.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (existing.enabled === parsed.data.enabled) {
    // 冪等：狀態未變 → 唔寫 audit
    return NextResponse.json({ id, enabled: existing.enabled, usable: isProductUsable(existing), changed: false });
  }
  const updated = await prisma.consultProduct.update({ where: { id }, data: { enabled: parsed.data.enabled } });
  await prisma.auditLog.create({
    data: {
      staffId: ctx.staff.id,
      action: "CONSULT_PRODUCT_TOGGLE",
      entity: "ConsultProduct",
      entityId: id,
      meta: { clinicId: updated.clinicId, code: updated.code, enabled: updated.enabled, usable: isProductUsable(updated) } as object,
    },
  });
  log.info({ staffId: ctx.staff.id, productId: id, enabled: updated.enabled }, "consult-products: toggled");
  return NextResponse.json({ id, enabled: updated.enabled, usable: isProductUsable(updated), changed: true });
});

/**
 * ★ consult v2.1 C2（MD §3 鐵律）：ConsultProduct 詞表 Admin API（ADMIN-only，同 knowledge 同級）。
 *
 * GET  /api/admin/consult-products?clinicId=<id>[&workflow=<w>][&usable=1]
 *      — 該店 + 全局（clinicId=null）產品；每行帶 `usable`（isProductUsable 計算）；
 *        usable=1 → 只回 usable 行（C3 檢索口徑同 API 層一致 — 鐵律單一來源）。
 * POST /api/admin/consult-products — 新增（zod；unique([clinicId, workflow, code]) 重複 → 409）。
 *
 * 鐵律：approvedAt==null 或 enabled==false 嘅產品唔准進入任何 AI 草稿或檢索 —
 *   isProductUsable（src/lib/sessions/consult-products.ts）係 C3/C4 嘅唯一守衛口徑，
 *   API 只負責管理詞表 + 幫 UI 顯示 usable 狀態。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import prisma from "@/lib/prisma";
import { consultProductCreateSchema, isProductUsable } from "@/lib/sessions/consult-products";
import log from "@/lib/log";

export const dynamic = "force-dynamic";

function toRow(p: {
  id: string; clinicId: string | null; workflow: string; code: string; displayName: string;
  category: string | null; brand: string | null; productFamily: string | null; model: string | null;
  material: string | null; surface: string | null; positioning: string; approvedWording: string;
  avoidPhrases: string[]; timeWording: string | null; packageNote: string | null; warrantyNote: string | null;
  priceDocTitle: string | null; sortOrder: number; enabled: boolean; approvedBy: string | null;
  approvedAt: Date | null;
}) {
  return {
    id: p.id,
    clinicId: p.clinicId,
    workflow: p.workflow,
    code: p.code,
    displayName: p.displayName,
    category: p.category,
    brand: p.brand,
    productFamily: p.productFamily,
    model: p.model,
    material: p.material,
    surface: p.surface,
    positioning: p.positioning,
    approvedWording: p.approvedWording,
    avoidPhrases: p.avoidPhrases,
    timeWording: p.timeWording,
    packageNote: p.packageNote,
    warrantyNote: p.warrantyNote,
    priceDocTitle: p.priceDocTitle,
    sortOrder: p.sortOrder,
    enabled: p.enabled,
    approvedBy: p.approvedBy,
    approvedAt: p.approvedAt,
    // ★ 鐵律 computed 欄（UI 顯示 + e2e 斷言口徑）
    usable: isProductUsable(p),
  };
}

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAdmin(req);
  const clinicId = req.nextUrl.searchParams.get("clinicId") ?? null;
  const workflow = req.nextUrl.searchParams.get("workflow") ?? null;
  const usableOnly = req.nextUrl.searchParams.get("usable") === "1";
  const where: Record<string, unknown> = {
    ...(clinicId ? { OR: [{ clinicId }, { clinicId: null }] } : {}),
    ...(workflow ? { workflow } : {}),
  };
  const rows = await prisma.consultProduct.findMany({
    where,
    orderBy: [{ clinicId: "asc" }, { sortOrder: "asc" }, { code: "asc" }],
  });
  // 鐵律：usable 過濾喺 application 層（同 C3 檢索同一 helper）
  const docs = rows.filter((r) => !usableOnly || isProductUsable(r)).map(toRow);
  return NextResponse.json({ clinicId, workflow, products: docs, role: ctx.staff.role });
});

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAdmin(req);
  const body = await req.json().catch(() => null);
  const parsed = consultProductCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation failed", issues: parsed.error.issues }, { status: 400 });
  }
  const d = parsed.data;
  // STAFF 唔會到呢度（requireAdmin）；ADMIN 全店 — clinicId null = 全局由 body 決定。
  try {
    const product = await prisma.consultProduct.create({
      data: {
        clinicId: d.clinicId,
        workflow: d.workflow,
        code: d.code,
        displayName: d.displayName,
        category: d.category ?? null,
        brand: d.brand ?? null,
        productFamily: d.productFamily ?? null,
        model: d.model ?? null,
        material: d.material ?? null,
        surface: d.surface ?? null,
        positioning: d.positioning,
        approvedWording: d.approvedWording,
        avoidPhrases: d.avoidPhrases,
        timeWording: d.timeWording ?? null,
        packageNote: d.packageNote ?? null,
        warrantyNote: d.warrantyNote ?? null,
        priceDocTitle: d.priceDocTitle ?? null,
        sortOrder: d.sortOrder,
        enabled: d.enabled,
        approvedBy: d.approvedBy ?? null,
        approvedAt: d.approvedAt ?? null,
      },
    });
    await prisma.auditLog.create({
      data: {
        staffId: ctx.staff.id,
        action: "CONSULT_PRODUCT_CREATE",
        entity: "ConsultProduct",
        entityId: product.id,
        // 零 PII（產品 = staff 管嘅參數）
        meta: { clinicId: product.clinicId, workflow: product.workflow, code: product.code, usable: isProductUsable(product) } as object,
      },
    });
    log.info({ staffId: ctx.staff.id, productId: product.id, code: d.code }, "consult-products: created");
    return NextResponse.json(toRow(product), { status: 201 });
  } catch (err) {
    // unique([clinicId, workflow, code]) 重複
    if ((err as { code?: string })?.code === "P2002") {
      return NextResponse.json({ error: "conflict", message: "同店同 workflow 已有同 code 產品" }, { status: 409 });
    }
    throw err;
  }
});

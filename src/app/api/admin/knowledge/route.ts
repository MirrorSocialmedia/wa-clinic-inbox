/**
 * ★ Part F（cwi-raggolden-20260904，F.2）：知識庫 Admin API（ADMIN-only）。
 *
 * GET  /api/admin/knowledge?clinicId=<id> — 該店 + 全局 enabled 條目（分組 by kind）+ 目錄預覽
 *      （預覽 = worker stage 1 prompt 入嘅同一字串 — 同源 getKnowledgeCatalog）。
 * POST /api/admin/knowledge — 新增條目（zod 驗證；PRICE: disclaimer 必填 ≥8 + priceMin<=priceMax — R-2）。
 *
 * 知識庫 = staff 管嘅參數（同 params 同級）：改即刻生效（local cache bust + CONTROL_CHANNEL
 * cache:bust scope=knowledge → worker process）+ AuditLog 可審計。
 *
 * ★ PII：知識庫 = 診所 staff 管嘅參數（服務/收費/政策）— R-8 鐵律：時段/醫生/病人記錄唔准入
 *   （skeleton 只通用描述；審核靠 staff 人手 — API 零 AI 審批）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { getKnowledgeCatalog, previewCatalog } from "@/lib/knowledge/catalog";
import { KNOWLEDGE_KINDS, knowledgeDocSchema, bustKnowledgeAfterChange } from "@/lib/knowledge/schema";
import log from "@/lib/log";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAdmin(req);
  const clinicId = req.nextUrl.searchParams.get("clinicId") ?? null;
  const scope = clinicId
    ? { OR: [{ clinicId }, { clinicId: null }] }
    : { clinicId: null };
  const rows = await prisma.knowledgeDoc.findMany({
    where: scope,
    orderBy: [{ kind: "asc" }, { title: "asc" }],
  });
  const docs = rows.map((r) => ({
    id: r.id,
    clinicId: r.clinicId,
    kind: r.kind,
    title: r.title,
    keywords: r.keywords,
    body: r.body,
    disclaimer: r.disclaimer,
    priceMin: r.priceMin,
    priceMax: r.priceMax,
    enabled: r.enabled,
    version: r.version,
    updatedBy: r.updatedBy,
    updatedAt: r.updatedAt,
  }));
  // 預覽目錄 = worker stage 1 prompt 入嘅同一字串（同源 getKnowledgeCatalog — 有 5min cache）
  const catalog = await getKnowledgeCatalog(clinicId ?? null);
  const grouped: Record<string, typeof docs> = {};
  for (const d of docs) (grouped[d.kind] ??= []).push(d);
  return NextResponse.json({
    clinicId,
    docs,
    grouped,
    preview: clinicId ? previewCatalog(catalog) : null,
    // 角色（UI 顯示權限提示；API 權限以 requireAdmin 為準）
    role: ctx.staff.role,
  });
});

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAdmin(req);
  const body = await req.json().catch(() => null);
  const parsed = knowledgeDocSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation failed", issues: parsed.error.issues }, { status: 400 });
  }
  const d = parsed.data;
  // 權限：clinicId 必喺 staff scope 內（ADMIN 全店；STAFF 唔會到呢度 — requireAdmin）
  const doc = await prisma.knowledgeDoc.create({
    data: {
      clinicId: d.clinicId,
      kind: d.kind,
      title: d.title,
      keywords: d.keywords,
      body: d.body,
      disclaimer: d.disclaimer,
      priceMin: d.priceMin,
      priceMax: d.priceMax,
      enabled: d.enabled ?? true,
      version: 1,
      updatedBy: ctx.staff.id,
    },
  });
  await prisma.auditLog.create({
    data: {
      staffId: ctx.staff.id,
      action: "KNOWLEDGE_CREATE",
      entity: "KnowledgeDoc",
      entityId: doc.id,
      meta: { kind: d.kind, title: d.title, clinicId: d.clinicId } as object,
    },
  });
  bustKnowledgeAfterChange();
  log.info({ staffId: ctx.staff.id, docId: doc.id, kind: d.kind }, "knowledge: created");
  return NextResponse.json({ id: doc.id });
});

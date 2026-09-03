/**
 * ★ Part F（cwi-raggolden-20260904，F.2）：知識庫條目 PUT/DELETE（ADMIN-only）。
 * PUT：整條更新（zod 同 POST；version+1 — 可審計/rollback 軌跡）+ AuditLog + cache bust。
 * DELETE：硬刪（rollback 靠 AuditLog meta 留痕 + 版本號；MD：可審計、可 rollback）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import prisma from "@/lib/prisma";
import { knowledgeDocSchema, bustKnowledgeAfterChange } from "@/lib/knowledge/schema";
import log from "@/lib/log";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

export const PUT = handle(async (req: NextRequest, { params }: Params) => {
  const ctx = await requireAdmin(req);
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = knowledgeDocSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation failed", issues: parsed.error.issues }, { status: 400 });
  }
  const d = parsed.data;
  const existing = await prisma.knowledgeDoc.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  const updated = await prisma.knowledgeDoc.update({
    where: { id },
    data: {
      clinicId: d.clinicId,
      kind: d.kind,
      title: d.title,
      keywords: d.keywords,
      body: d.body,
      disclaimer: d.disclaimer,
      priceMin: d.priceMin,
      priceMax: d.priceMax,
      enabled: d.enabled ?? existing.enabled,
      version: { increment: 1 },
      updatedBy: ctx.staff.id,
    },
  });
  await prisma.auditLog.create({
    data: {
      staffId: ctx.staff.id,
      action: "KNOWLEDGE_UPDATE",
      entity: "KnowledgeDoc",
      entityId: id,
      meta: { kind: d.kind, title: d.title, version: updated.version, prevVersion: existing.version } as object,
    },
  });
  bustKnowledgeAfterChange();
  log.info({ staffId: ctx.staff.id, docId: id, version: updated.version }, "knowledge: updated");
  return NextResponse.json({ id, version: updated.version });
});

export const DELETE = handle(async (_req: NextRequest, { params }: Params) => {
  const ctx = await requireAdmin(_req);
  const { id } = await params;
  const existing = await prisma.knowledgeDoc.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  await prisma.knowledgeDoc.delete({ where: { id } });
  await prisma.auditLog.create({
    data: {
      staffId: ctx.staff.id,
      action: "KNOWLEDGE_DELETE",
      entity: "KnowledgeDoc",
      entityId: id,
      // meta 留痕（rollback 用）— 零 PII（知識庫 = staff 管嘅參數）
      meta: {
        kind: existing.kind,
        title: existing.title,
        clinicId: existing.clinicId,
        keywords: existing.keywords,
        body: existing.body,
        disclaimer: existing.disclaimer,
        priceMin: existing.priceMin,
        priceMax: existing.priceMax,
        version: existing.version,
      } as object,
    },
  });
  bustKnowledgeAfterChange();
  log.info({ staffId: ctx.staff.id, docId: id }, "knowledge: deleted");
  return NextResponse.json({ ok: true });
});

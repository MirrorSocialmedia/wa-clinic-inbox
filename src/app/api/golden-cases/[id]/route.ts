/**
 * ★ Part F（cwi-raggolden-20260904，F.5）：GoldenCase 單條更新/刪除（**ADMIN-only**）。
 * PUT：審核頁「✎ 改」+「✓ 收貨/停用」（enabled 翻轉）— HISTORY_SAMPLE 收貨先 enabled=true。
 * DELETE：審核頁「✗ 丟」。
 * 零 PII：PUT 嘅 utterance/contextBefore 再過一次 deid（防人手編輯貼返 PII 入庫）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import prisma from "@/lib/prisma";
import { deid, deidList } from "@/lib/golden/deid";
import { updateGoldenSchema } from "@/lib/golden/schemas";
import log from "@/lib/log";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

export const PUT = handle(async (req: NextRequest, { params }: Params) => {
  const ctx = await requireAdmin(req);
  const { id } = await params;
  const existing = await prisma.goldenCase.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = await req.json().catch(() => null);
  const parsed = updateGoldenSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation failed", issues: parsed.error.issues }, { status: 400 });
  }
  const d = parsed.data;
  const data: Record<string, unknown> = {};
  if (d.utterance !== undefined) data.utterance = deid(d.utterance);
  if (d.contextBefore !== undefined) data.contextBefore = deidList(d.contextBefore).slice(0, 2);
  if (d.expectIntent !== undefined) data.expectIntent = d.expectIntent;
  if (d.expectRedFlag !== undefined) data.expectRedFlag = d.expectRedFlag;
  if (d.expectAutoOk !== undefined) data.expectAutoOk = d.expectAutoOk;
  if (d.expectDocIds !== undefined) data.expectDocIds = d.expectDocIds;
  if (d.note !== undefined) data.note = d.note ?? null;
  if (d.enabled !== undefined) data.enabled = d.enabled;
  const updated = await prisma.goldenCase.update({ where: { id }, data });
  await prisma.auditLog.create({
    data: {
      staffId: ctx.staff.id,
      action: "GOLDEN_UPDATE",
      entity: "GoldenCase",
      entityId: id,
      meta: { enabled: updated.enabled, expectIntent: updated.expectIntent } as object,
    },
  });
  return NextResponse.json({ id, enabled: updated.enabled });
});

export const DELETE = handle(async (_req: NextRequest, { params }: Params) => {
  const ctx = await requireAdmin(_req);
  const { id } = await params;
  const existing = await prisma.goldenCase.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  await prisma.goldenCase.delete({ where: { id } });
  log.info({ staffId: ctx.staff.id, goldenCaseId: id }, "golden: deleted (審核丟)");
  return NextResponse.json({ ok: true });
});

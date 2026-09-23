import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAdmin, requireGlobalAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";

/**
 * ★ cwi-followup-p3-20260916（老細 07:31 拍板 #4）：template registry（ADMIN-only）。
 *
 * GET  /api/admin/followups/templates
 *   → { templates: [{ key, name, text, language, waTemplateName, approved, approvedAt, approvedBy, updatedAt }] }
 *   seed 出廠全部 approved=false（draft — 老細審批中）；審批前 + 窗口過咗 → SKIPPED(NO_TEMPLATE) 唔真發。
 *
 * POST /api/admin/followups/templates
 *   body { key }（或 { key, text } 一併改字再審批）→ 標 approved=true + audit。
 *   審批後：24h NO_TEMPLATE 抑製自然解除，下輪掃描可再建/發。
 */
export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  await requireAdmin(req);
  const templates = await prisma.followupTemplate.findMany({ orderBy: { key: "asc" } });
  return NextResponse.json({ templates });
});

export const POST = handle(async (req: NextRequest) => {
  // ★ cwi-final S3-1：template registry 係全局資源 → global admin only
  const ctx = await requireGlobalAdmin(req);
  const body = (await req.json().catch(() => null)) as { key?: string; text?: string } | null;
  if (!body?.key) return NextResponse.json({ error: "key required" }, { status: 400 });
  const t = await prisma.followupTemplate.findUnique({ where: { key: body.key } });
  if (!t) return NextResponse.json({ error: "template not found" }, { status: 404 });
  const updated = await prisma.followupTemplate.update({
    where: { key: body.key },
    data: {
      ...(typeof body.text === "string" && body.text.trim() ? { text: body.text.trim() } : {}),
      approved: true,
      approvedAt: new Date(),
      approvedBy: ctx.staff.id,
      updatedAt: new Date(),
    },
  });
  await prisma.auditLog.create({
    data: {
      staffId: ctx.staff.id,
      action: "FOLLOWUP_TEMPLATE_APPROVED",
      entity: "FollowupTemplate",
      entityId: body.key,
      meta: { textChanged: typeof body.text === "string" && body.text !== t.text } as object,
    },
  });
  return NextResponse.json({ template: updated });
});

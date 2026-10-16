/**
 * POST /api/admin/contacts/[id]/delete — 病人資料刪除（wa-meta-compliance-20261016 Part D）
 *
 * ADMIN-only + clinic scope 內。病人「刪除我的資料」請求的後端執行入口
 * （政策口徑：email/WhatsApp 提出 → staff 核實身份 → 經呢個 endpoint 執行）。
 *
 * 返回：刪除計數明細（metadata-only）+ 備份保留說明（≤30 日備份過期後彻底消失）。
 * 冪等：已刪 → 404 CONTACT_NOT_FOUND。
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { deletePatientData } from "@/lib/ops/data-deletion";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ reason: z.string().min(1).max(300).optional() });
type Ctx = { params: Promise<{ id: string }> };

export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireAdmin(req);
  const { id } = await ctx.params;
  const { reason } = bodySchema.parse(await req.json().catch(() => ({})));

  const contact = await prisma.contact.findUnique({ where: { id }, select: { id: true, clinicId: true } });
  if (!contact) return NextResponse.json({ error: "contact_not_found" }, { status: 404 });

  // scope：ALL（含 SUPERVISOR fallback）或 scope 內 clinic
  const inScope = admin.scopeType === "ALL" || admin.scopedClinicIds.includes(contact.clinicId);
  if (!inScope) return NextResponse.json({ error: "clinic out of scope" }, { status: 403 });

  const result = await deletePatientData({ contactId: contact.id, staffId: admin.staff.id, reason });
  return NextResponse.json({
    ok: true,
    ...result,
    backupNote: "資料庫備份（pg_dump，≤30 日保留 + 離線副本）可能仍含已刪資料，至備份過期後徹底消失；本系統唔做備份內 selective scrub。",
  });
});

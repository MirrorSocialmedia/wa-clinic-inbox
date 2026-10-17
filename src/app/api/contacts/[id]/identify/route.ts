import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, assertContactAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { identifyContact } from "@/lib/patient-identify";

/**
 * POST /api/contacts/[id]/identify — 「重新判定」新客／舊客（★ cwi-patient-identify-20261017）
 *
 * 即刻再搜晒全部 Apricot 帳號（force — 唔理 24h 冷卻）。唯讀動作（只寫 Contact 判定欄）→ 有權睇個病人就得（包 SUPERVISOR）。
 * 回：{ status, count, patientApricotId }；同一個病人判定緊 → 202 { inProgress: true }。
 */
export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;
  const contact = await prisma.contact.findUnique({ where: { id }, select: { id: true, clinicId: true } });
  if (!contact) return NextResponse.json({ error: "contact not found" }, { status: 404 });
  try {
    await assertContactAccess(ctx, contact);
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const r = await identifyContact(id, { force: true });
  if (!r) return NextResponse.json({ inProgress: true }, { status: 202 });
  return NextResponse.json(r);
});

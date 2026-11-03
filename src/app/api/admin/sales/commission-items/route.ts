/**
 * ★ cwi-sales-20261028：/api/admin/sales/commission-items?clinicId= — 傭金項目表（GET = ADMIN；PUT = 集團管理員）。
 * PUT body { clinicId, items:[{ feeItemExtId, ratePct, category?, highValue?, active? }] } → workforce（審計喺 workforce）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireAdmin, isGlobalAdmin } from "@/lib/rbac";
import { handle, toResponse } from "@/lib/api-error";
import { fetchCommissionItems, putCommissionItems, WorkforceApiError } from "@/lib/workforce/client";

export const dynamic = "force-dynamic";

const putSchema = z.object({
  clinicId: z.string().min(1),
  items: z
    .array(
      z.object({
        feeItemExtId: z.string().min(1).max(64),
        ratePct: z.number().min(0).max(100),
        category: z.string().max(40).nullish(),
        highValue: z.boolean().optional(),
        active: z.boolean().optional(),
      })
    )
    .max(500),
});

async function clinicCode(id: string): Promise<string | null> {
  return (await prisma.clinic.findUnique({ where: { id }, select: { code: true } }))?.code ?? null;
}

export const GET = handle(async (req: NextRequest) => {
  await requireAdmin(req);
  const code = await clinicCode(req.nextUrl.searchParams.get("clinicId") ?? "");
  if (!code) return NextResponse.json({ error: "clinic not found" }, { status: 404 });
  try {
    return NextResponse.json({ items: (await fetchCommissionItems(code)).items });
  } catch {
    return NextResponse.json({ error: "WORKFORCE_UNAVAILABLE", message: "workforce 連唔到 — 請稍後再試" }, { status: 502 });
  }
});

export const PUT = handle(async (req: NextRequest) => {
  const admin = await requireAdmin(req);
  if (!isGlobalAdmin(admin)) return NextResponse.json({ error: "FORBIDDEN", message: "只有集團管理員可以改傭金項目" }, { status: 403 });
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);
  const code = await clinicCode(parsed.data.clinicId);
  if (!code) return NextResponse.json({ error: "clinic not found" }, { status: 404 });
  try {
    await putCommissionItems(code, parsed.data.items, admin.staff.id);
  } catch (err) {
    if (err instanceof WorkforceApiError && err.status === 400) {
      return NextResponse.json({ error: "BAD_ITEMS", message: "有項目喺呢間店嘅收費項目名單搵唔到 — 請先「立即更新名單」" }, { status: 400 });
    }
    return NextResponse.json({ error: "WORKFORCE_UNAVAILABLE", message: "workforce 連唔到 — 請稍後再試" }, { status: 502 });
  }
  return NextResponse.json({ ok: true, items: (await fetchCommissionItems(code).catch(() => ({ items: [] }))).items });
});

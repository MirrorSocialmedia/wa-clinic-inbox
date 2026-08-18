import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireAdmin } from "@/lib/rbac";
import { handle, toResponse } from "@/lib/api-error";

/**
 * /api/admin/clinics/[id] — ADMIN-only。
 *
 * GET   : 單店詳情
 * PUT   : 更新（code/name/waPhoneNumberId/waDisplayNumber/greetingConfig）
 * DELETE: 刪除 — 有對話/聯絡人/員工掛住 → 409（fail-closed，唔做 cascade 刪病人資料）
 */
export const dynamic = "force-dynamic";

const greetingConfigSchema = z
  .union([z.record(z.string(), z.unknown()), z.null()])
  .optional()
  .default(null);

const updateSchema = z.object({
  code: z.string().min(1).max(16).optional(),
  name: z.string().min(1).max(100).optional(),
  waPhoneNumberId: z.string().min(1).max(64).optional(),
  waDisplayNumber: z.string().min(1).max(32).optional(),
  greetingConfig: greetingConfigSchema,
});

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  await requireAdmin(req);
  const { id } = await ctx.params;
  const clinic = await prisma.clinic.findUnique({ where: { id } });
  if (!clinic) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(clinic);
});

export const PUT = handle(async (req: NextRequest, ctx: Ctx) => {
  await requireAdmin(req);
  const { id } = await ctx.params;
  const parsed = updateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data)) {
    if (k === "greetingConfig") {
      data[k] = v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue);
    } else if (v !== undefined) {
      data[k] = v;
    }
  }
  const clinic = await prisma.clinic.update({ where: { id }, data });
  return NextResponse.json(clinic);
});

export const DELETE = handle(async (req: NextRequest, ctx: Ctx) => {
  await requireAdmin(req);
  const { id } = await ctx.params;

  const [conversations, contacts, staff] = await Promise.all([
    prisma.conversation.count({ where: { clinicId: id } }),
    prisma.contact.count({ where: { clinicId: id } }),
    prisma.staffUser.count({ where: { clinicId: id } }),
  ]);
  if (conversations > 0 || contacts > 0 || staff > 0) {
    return NextResponse.json(
      {
        error: "clinic has dependent data",
        detail: { conversations, contacts, staff },
        hint: "先搬走/停用該店嘅對話、聯絡人同員工，先可以刪除",
      },
      { status: 409 }
    );
  }
  await prisma.clinic.delete({ where: { id } });
  return NextResponse.json({ ok: true });
});

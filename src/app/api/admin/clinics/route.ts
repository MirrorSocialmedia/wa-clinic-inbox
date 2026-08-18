import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireAdmin } from "@/lib/rbac";
import { handle, toResponse } from "@/lib/api-error";

/**
 * /api/admin/clinics — ADMIN-only（店 CRUD，Phase 1 目標 2）。
 *
 * GET  : 列表（帶對話/聯絡人統計）
 * POST : 建立（code / waPhoneNumberId unique → 重複 409）
 *
 * greetingConfig：JSON（object|null）— 診所資料（地址/營業時間/FAQ），餵 AI 草稿用。
 */
export const dynamic = "force-dynamic";

const greetingConfigSchema = z
  .union([z.record(z.string(), z.unknown()), z.null()])
  .optional()
  .default(null);

const createSchema = z.object({
  code: z.string().min(1).max(16),
  name: z.string().min(1).max(100),
  waPhoneNumberId: z.string().min(1).max(64),
  waDisplayNumber: z.string().min(1).max(32),
  greetingConfig: greetingConfigSchema,
});

export const GET = handle(async (req: NextRequest) => {
  await requireAdmin(req);

  const [clinics, convCounts, contactCounts] = await Promise.all([
    prisma.clinic.findMany({ orderBy: { code: "asc" } }),
    prisma.conversation.groupBy({ by: ["clinicId"], _count: { _all: true } }),
    prisma.contact.groupBy({ by: ["clinicId"], _count: { _all: true } }),
  ]);
  const convMap = new Map(convCounts.map((r) => [r.clinicId, r._count._all]));
  const contactMap = new Map(contactCounts.map((r) => [r.clinicId, r._count._all]));

  return NextResponse.json(
    clinics.map((c) => ({
      ...c,
      conversationCount: convMap.get(c.id) ?? 0,
      contactCount: contactMap.get(c.id) ?? 0,
    }))
  );
});

export const POST = handle(async (req: NextRequest) => {
  await requireAdmin(req);
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);
  const clinic = await prisma.clinic.create({
    data: {
      ...parsed.data,
      greetingConfig: parsed.data.greetingConfig
        ? (parsed.data.greetingConfig as Prisma.InputJsonValue)
        : Prisma.DbNull,
    },
  });
  return NextResponse.json(clinic, { status: 201 });
});

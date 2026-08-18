import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import argon2 from "argon2";
import prisma from "@/lib/prisma";
import { requireAdmin } from "@/lib/rbac";
import { handle, toResponse } from "@/lib/api-error";

/**
 * /api/admin/staff — ADMIN-only（員工 CRUD，Phase 1 目標 2）。
 *
 * GET  : 列表（email/name/role/clinic/active）
 * POST : 建立（STAFF 必給 clinicId 同 password；ADMIN clinicId = null）
 */
export const dynamic = "force-dynamic";

const createSchema = z
  .object({
    email: z.string().email().max(200),
    name: z.string().min(1).max(100),
    role: z.enum(["ADMIN", "STAFF"]),
    clinicId: z.string().min(1).max(64).nullable(),
    password: z.string().min(8).max(128),
    active: z.boolean().optional().default(true),
  })
  .refine((d) => d.role !== "STAFF" || (d.clinicId !== null && d.clinicId !== ""), {
    message: "STAFF 必須綁定 clinicId",
    path: ["clinicId"],
  })
  .refine((d) => d.role !== "ADMIN" || d.clinicId === null, {
    message: "ADMIN clinicId 必須為 null（跨店）",
    path: ["clinicId"],
  });

export const GET = handle(async (req: NextRequest) => {
  await requireAdmin(req);
  const [users, clinics] = await Promise.all([
    prisma.staffUser.findMany({
      orderBy: [{ role: "asc" }, { email: "asc" }],
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        clinicId: true,
        active: true,
      },
    }),
    prisma.clinic.findMany({ select: { id: true, code: true } }),
  ]);
  const codeMap = new Map(clinics.map((c) => [c.id, c.code]));
  return NextResponse.json(
    users.map((u) => ({ ...u, clinicCode: u.clinicId ? codeMap.get(u.clinicId) ?? null : null }))
  );
});

export const POST = handle(async (req: NextRequest) => {
  await requireAdmin(req);
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);

  // clinicId 存在性驗證（STAFF）
  if (parsed.data.clinicId) {
    const clinic = await prisma.clinic.findUnique({ where: { id: parsed.data.clinicId } });
    if (!clinic) return NextResponse.json({ error: "clinic not found" }, { status: 400 });
  }

  const passwordHash = await argon2.hash(parsed.data.password);
  const user = await prisma.staffUser.create({
    data: {
      email: parsed.data.email,
      name: parsed.data.name,
      role: parsed.data.role,
      clinicId: parsed.data.clinicId,
      active: parsed.data.active,
      passwordHash,
    },
  });
  const { passwordHash: _ph, ...safe } = user;
  return NextResponse.json(safe, { status: 201 });
});

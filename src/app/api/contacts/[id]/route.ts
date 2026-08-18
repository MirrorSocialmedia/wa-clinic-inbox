import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireAuth, assertClinicAccess } from "@/lib/rbac";
import { handle, toResponse } from "@/lib/api-error";

/**
 * PATCH /api/contacts/[id] — 編輯 Contact（MD §6.4 側欄：profileName / labels）。
 * 別店 → 403。
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  profileName: z.string().min(0).max(200).nullable().optional(),
  labels: z.array(z.string().min(1).max(50)).max(20).optional(),
});

export const PATCH = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  const contact = await prisma.contact.findUnique({ where: { id } });
  if (!contact) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertClinicAccess(auth, contact.clinicId);

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);

  const updated = await prisma.contact.update({
    where: { id },
    data: {
      ...(parsed.data.profileName !== undefined ? { profileName: parsed.data.profileName } : {}),
      ...(parsed.data.labels !== undefined ? { labels: parsed.data.labels } : {}),
    },
  });
  return NextResponse.json(updated);
});

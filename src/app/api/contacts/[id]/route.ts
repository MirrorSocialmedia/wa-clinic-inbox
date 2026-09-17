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
  // ★ cwi-followup-v3 B-9：稱呼人手可改（系統唔自動估 — template {{salutation}} 顯示用；null = 回退「您」）
  salutation: z.string().min(0).max(50).nullable().optional(),
  // ★ cwi-followup-v3 B-9：locale — zh（default）| en（決定 *_en template）
  locale: z.enum(["zh", "en"]).nullable().optional(),
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
      ...(parsed.data.salutation !== undefined ? { salutation: parsed.data.salutation } : {}),
      ...(parsed.data.locale !== undefined ? { locale: parsed.data.locale } : {}),
    },
  });
  return NextResponse.json(updated);
});

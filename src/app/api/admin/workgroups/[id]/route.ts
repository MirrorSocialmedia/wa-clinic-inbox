/**
 * ★ cwi-workgroup-20261104：PATCH /api/admin/workgroups/[id] — 改名／封存／加人／刪人（集團管理員）。
 * body { name?, archived?, addIds?, removeIds? }；被加／被刪嘅人即時收 socket `workgroup:changed`（重拉列表）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireGlobalAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { publishStaffNotify } from "@/lib/notify";
import prisma from "@/lib/prisma";
import { adminUpdateGroup } from "@/lib/workgroups";
import { wgError } from "@/lib/workgroups-http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z
  .object({
    name: z.string().max(200).optional(),
    archived: z.boolean().optional(),
    addIds: z.array(z.string().max(64)).max(1000).optional(),
    removeIds: z.array(z.string().max(64)).max(1000).optional(),
  })
  .strict();

export const PATCH = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireGlobalAdmin(req);
  const { id } = await ctx.params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request", message: "資料唔啱" }, { status: 400 });
  try {
    const r = await adminUpdateGroup(auth.staff.id, id, parsed.data);
    const members = (await prisma.workGroupMember.findMany({ where: { groupId: id }, select: { staffId: true } })).map((m) => m.staffId);
    for (const sid of new Set([...members, ...r.removed])) publishStaffNotify(sid, "", "workgroup:changed", { groupId: id });
    return NextResponse.json({ ok: true, added: r.added.length, removed: r.removed.length });
  } catch (e) {
    return wgError(e);
  }
});

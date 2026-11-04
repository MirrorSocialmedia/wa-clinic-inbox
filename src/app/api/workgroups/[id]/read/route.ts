/**
 * ★ cwi-workgroup-20261104：POST /api/workgroups/[id]/read — 標記已讀（只向前推）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { markGroupRead } from "@/lib/workgroups";
import { wgError } from "@/lib/workgroups-http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  try {
    await markGroupRead(id, auth.staff.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return wgError(e);
  }
});

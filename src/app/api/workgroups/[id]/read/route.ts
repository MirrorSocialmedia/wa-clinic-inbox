/**
 * ★ cwi-workgroup-20261104：POST /api/workgroups/[id]/read — 標記已讀（只向前推）。
 * ★ p2：讀到新訊息 → 通知其他成員（`workgroup:read`，零內文）更新「已讀人數」。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { publishStaffNotify } from "@/lib/notify";
import { groupMemberIds, markGroupRead } from "@/lib/workgroups";
import { wgError } from "@/lib/workgroups-http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  try {
    const advanced = await markGroupRead(id, auth.staff.id);
    if (advanced) {
      for (const sid of await groupMemberIds(id)) if (sid !== auth.staff.id) publishStaffNotify(sid, "", "workgroup:read", { groupId: id });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return wgError(e);
  }
});

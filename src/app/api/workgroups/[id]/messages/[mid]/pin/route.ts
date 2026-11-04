/**
 * ★ cwi-workgroup-p2-20261105：POST /api/workgroups/[id]/messages/[mid]/pin { pin: boolean } — 置頂／取消置頂。
 * 成員都得；封存 409；每群最多 3 條（409 PIN_LIMIT）。成功 → 成員收 `workgroup:changed`。
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { publishStaffNotify } from "@/lib/notify";
import { groupMemberIds, pinGroupMessage } from "@/lib/workgroups";
import { wgError } from "@/lib/workgroups-http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; mid: string }> };
const schema = z.object({ pin: z.boolean() }).strict();

export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id, mid } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request", message: "格式唔啱" }, { status: 400 });
  try {
    await pinGroupMessage(id, mid, auth.staff.id, parsed.data.pin);
    for (const sid of await groupMemberIds(id)) publishStaffNotify(sid, "", "workgroup:changed", { groupId: id });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return wgError(e);
  }
});

/**
 * ★ cwi-workgroup-p2-20261105：POST /api/workgroups/[id]/messages/[mid]/claim — 對話卡「我接」。
 * 成員 + 睇得到呢個對話 + 卡已放手 + 未有人接 + 對話仲係未指派 → 接手（第一個撳嘅贏；其他人 409）。
 * 銷售保護病人：只有負責銷售／被轉交同事接到（423）。成功 → 成員收 `workgroup:changed` 更新張卡。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { hit } from "@/lib/rate-limit";
import { publishStaffNotify } from "@/lib/notify";
import { claimSharedConversation, groupMemberIds } from "@/lib/workgroups";
import { wgError } from "@/lib/workgroups-http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; mid: string }> };

export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id, mid } = await ctx.params;
  if (!(await hit(`wg:claim:${auth.staff.id}`, 30, 60))) return NextResponse.json({ error: "rate_limited", message: "撳得太快，等一陣再試" }, { status: 429 });
  try {
    const r = await claimSharedConversation(id, mid, auth);
    for (const sid of await groupMemberIds(id)) publishStaffNotify(sid, "", "workgroup:changed", { groupId: id });
    return NextResponse.json({ ok: true, conversationId: r.conversationId });
  } catch (e) {
    return wgError(e);
  }
});

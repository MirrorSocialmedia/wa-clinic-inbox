/**
 * ★ cwi-workgroup-20261104：工作群訊息。
 * GET  ?before=<messageId>&limit= → { group, messages, hasMore }（只限成員；對話卡按睇嘅人權限即時查）
 * POST { body, mentions?, conversationId?, clientKey? } → 201 { messageId, duplicate }
 *   成員先發到；封存 409；分享對話要自己睇得到；@ 只限成員；clientKey 防重複；每人每分鐘 30 條。
 *   commit 後：成員收 socket `workgroup:message`（零內文）；被 @ 嘅人另外收 push（只帶群名）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { hit } from "@/lib/rate-limit";
import { publishStaffNotify } from "@/lib/notify";
import { pushToStaff } from "@/lib/push";
import { groupMessages, sendGroupMessage, WG_BODY_MAX } from "@/lib/workgroups";
import { wgError } from "@/lib/workgroups-http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const postSchema = z
  .object({
    body: z.string().max(WG_BODY_MAX + 200).default(""),
    mentions: z.array(z.string().max(64)).max(50).optional(),
    conversationId: z.string().min(1).max(64).nullish(),
    clientKey: z.string().max(64).nullish(),
  })
  .strict();

export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  const before = req.nextUrl.searchParams.get("before");
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? "") || undefined;
  try {
    return NextResponse.json(await groupMessages(id, auth, { before, limit }));
  } catch (e) {
    return wgError(e);
  }
});

export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request", message: "訊息格式唔啱" }, { status: 400 });
  if (!(await hit(`wg:send:${auth.staff.id}`, 30, 60))) return NextResponse.json({ error: "rate_limited", message: "發得太快，等一陣再試" }, { status: 429 });
  try {
    const r = await sendGroupMessage(id, auth, parsed.data);
    // ★ commit-then-emit：sendGroupMessage 已 commit
    for (const sid of r.notify) {
      publishStaffNotify(sid, "", "workgroup:message", { groupId: id, messageId: r.messageId, mention: r.mentioned.includes(sid) });
    }
    publishStaffNotify(auth.staff.id, "", "workgroup:message", { groupId: id, messageId: r.messageId, mention: false });
    for (const sid of r.mentioned) {
      void pushToStaff(sid, { kind: "workgroup", clinicShort: r.groupName.slice(0, 20), conversationId: "", groupId: id });
    }
    return NextResponse.json({ messageId: r.messageId, duplicate: r.duplicate }, { status: r.duplicate ? 200 : 201 });
  } catch (e) {
    return wgError(e);
  }
});

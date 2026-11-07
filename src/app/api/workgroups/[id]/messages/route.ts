/**
 * ★ cwi-workgroup-20261104：工作群訊息。
 * GET  ?before=<messageId>&limit= → { group, messages, hasMore }（只限成員；對話卡按睇嘅人權限即時查）
 * POST { body, mentions?, conversationId?, clientKey?, release? } → 201 { messageId, duplicate, released, releaseFailed }
 *   ★ p2 release=true（分享並放手）：只限負責人／管理員；對話放返未指派 + 卡出「我接」
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
import { randomUUID } from "node:crypto";
import { assertCanPost, findByClientKey, groupMessages, sendGroupMessage, WG_BODY_MAX } from "@/lib/workgroups";
import { copyStickerFile, StickerError, touchSticker, usableSticker } from "@/lib/stickers";
import { stickerError } from "@/lib/stickers-http";
import { wgError } from "@/lib/workgroups-http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const postSchema = z
  .object({
    body: z.string().max(WG_BODY_MAX + 200).default(""),
    mentions: z.array(z.string().max(64)).max(50).optional(),
    conversationId: z.string().min(1).max(64).nullish(),
    clientKey: z.string().max(64).nullish(),
    release: z.boolean().optional(),
    /** ★ cwi-sticker：發貼圖（自己嘅 + 診所嘅） */
    stickerId: z.string().min(1).max(64).nullish(),
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
  // ★ cwi-sticker：貼圖 → 複製一份做群附件（wg-<uuid>.webp；刪貼圖唔影響已發）— 先驗成員／封存先落碟
  let attachment: { key: string; name: string; mime: string; size: number } | null = null;
  const { stickerId, ...input } = parsed.data;
  if (stickerId) {
    try {
      await assertCanPost(id, auth.staff.id);
      const prevId = await findByClientKey(id, auth.staff.id, input.clientKey ?? null);
      if (prevId) return NextResponse.json({ messageId: prevId, duplicate: true }, { status: 200 });
      const st = await usableSticker(stickerId, auth.staff.id);
      const key = `wg-${randomUUID()}.webp`;
      const c = await copyStickerFile(st.fileKey, key);
      attachment = { key, name: "貼圖.webp", mime: "image/webp", size: c.bytes };
      void touchSticker(st.id);
    } catch (e) {
      if (e instanceof StickerError) return stickerError(e);
      return wgError(e);
    }
  }
  try {
    const r = await sendGroupMessage(id, auth, { ...input, attachment });
    // ★ commit-then-emit：sendGroupMessage 已 commit
    for (const sid of r.notify) {
      publishStaffNotify(sid, "", "workgroup:message", { groupId: id, messageId: r.messageId, mention: r.mentioned.includes(sid) });
    }
    publishStaffNotify(auth.staff.id, "", "workgroup:message", { groupId: id, messageId: r.messageId, mention: false });
    for (const sid of r.mentioned) {
      void pushToStaff(sid, { kind: "workgroup", clinicShort: r.groupName.slice(0, 20), conversationId: "", groupId: id });
    }
    return NextResponse.json(
      { messageId: r.messageId, duplicate: r.duplicate, released: r.released, releaseFailed: r.releaseFailed },
      { status: r.duplicate ? 200 : 201 },
    );
  } catch (e) {
    return wgError(e);
  }
});

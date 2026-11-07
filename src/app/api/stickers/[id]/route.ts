/**
 * ★ cwi-sticker-20261107：PATCH { name } 改名／DELETE 刪貼圖。
 * 我的貼圖：只有自己；診所貼圖：只限集團管理員。其他一律 404（唔洩露存在性）。已發出嘅訊息唔受影響（另有副本）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { deleteSticker, renameSticker } from "@/lib/stickers";
import { stickerError } from "@/lib/stickers-http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const schema = z.object({ name: z.string().max(60).nullable() }).strict();

export const PATCH = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request", message: "格式唔啱" }, { status: 400 });
  try {
    await renameSticker(auth, id, parsed.data.name);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return stickerError(e);
  }
});

export const DELETE = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  try {
    await deleteSticker(auth, id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return stickerError(e);
  }
});

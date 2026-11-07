/**
 * ★ cwi-sticker-20261107：POST /api/stickers/from-message { messageId, scope?, name? } — 收藏收到嘅貼圖（⭐）。
 * 要睇得到嗰個對話（冇權 / 唔存在一律 404）；只限 type=sticker 兼已落地；診所範圍只限集團管理員。
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { hit } from "@/lib/rate-limit";
import { addStickerFromMessage } from "@/lib/stickers";
import { stickerError } from "@/lib/stickers-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({ messageId: z.string().min(1).max(64), scope: z.enum(["mine", "clinic"]).default("mine"), name: z.string().max(60).nullish() }).strict();

export const POST = handle(async (req: NextRequest) => {
  const auth = await requireAuth(req);
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request", message: "格式唔啱" }, { status: 400 });
  if (!(await hit(`stk:add:${auth.staff.id}`, 20, 60))) return NextResponse.json({ error: "rate_limited", message: "加得太快，等一陣再試" }, { status: 429 });
  try {
    const r = await addStickerFromMessage(auth, parsed.data);
    return NextResponse.json(r, { status: r.duplicate ? 200 : 201 });
  } catch (e) {
    return stickerError(e);
  }
});

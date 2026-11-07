/**
 * ★ cwi-sticker-20261107：GET /api/stickers/file/[file] — 貼圖檔（自己嘅 + 診所嘅；其他 404）。
 * basename + 格式白名單防 traversal；透明解密；nosniff；private 短 cache（貼圖唔係病人資料，但只限登入員工）。
 */
import { type NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { openMediaStream } from "@/lib/wa/media";
import { stickerFileForViewer } from "@/lib/stickers";
import log from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = handle(async (req: NextRequest, ctx: { params: Promise<{ file: string }> }) => {
  const auth = await requireAuth(req);
  const { file } = await ctx.params;
  if (file !== path.basename(file) || !/^stk-[0-9a-f-]{36}\.webp$/.test(file)) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!(await stickerFileForViewer(file, auth.staff.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  let h: Awaited<ReturnType<typeof openMediaStream>>;
  try {
    h = await openMediaStream(file);
  } catch (err) {
    if (err instanceof Error && err.message.includes("read failed")) return NextResponse.json({ error: "not found" }, { status: 404 });
    log.error({ err: err instanceof Error ? err.message : String(err) }, "sticker: stream open failed");
    return NextResponse.json({ error: "media unreadable" }, { status: 500 });
  }
  const res = new NextResponse(h.stream, {
    headers: { "Content-Type": "image/webp", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=300" },
  });
  req.signal.addEventListener("abort", () => h.cleanup?.(), { once: true });
  return res;
});

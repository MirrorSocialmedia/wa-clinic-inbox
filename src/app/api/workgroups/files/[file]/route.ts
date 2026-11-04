/**
 * ★ cwi-workgroup-p2-20261105：GET /api/workgroups/files/[file] — 工作群附件（只限該群成員；其他一律 404 唔洩露存在性）。
 * 同 /api/media 一樣：basename 防 traversal、透明解密 streaming、nosniff、no-store。
 */
import { type NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { openMediaStream } from "@/lib/wa/media";
import { attachmentForViewer } from "@/lib/workgroups";
import log from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = handle(async (req: NextRequest, ctx: { params: Promise<{ file: string }> }) => {
  const auth = await requireAuth(req);
  const { file } = await ctx.params;
  if (file !== path.basename(file) || file.includes("..") || !/^wg-[0-9a-f-]{36}\.(jpg|png|pdf)$/.test(file)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const meta = await attachmentForViewer(file, auth.staff.id);
  if (!meta) return NextResponse.json({ error: "not found" }, { status: 404 });
  let h: Awaited<ReturnType<typeof openMediaStream>>;
  try {
    h = await openMediaStream(file);
  } catch (err) {
    if (err instanceof Error && err.message.includes("read failed")) return NextResponse.json({ error: "not found" }, { status: 404 });
    log.error({ err: err instanceof Error ? err.message : String(err) }, "workgroup: attachment stream open failed");
    return NextResponse.json({ error: "media unreadable" }, { status: 500 });
  }
  const asciiFallback = /^[\x21-\x7e]*$/.test(meta.name) ? meta.name : file;
  const res = new NextResponse(h.stream, {
    headers: {
      "Content-Type": meta.mime,
      "Content-Disposition": `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
  req.signal.addEventListener("abort", () => h.cleanup?.(), { once: true });
  return res;
});

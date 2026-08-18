import { type NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";

/**
 * GET /api/media/[file] — 本地落地媒體檔案（{wamid}.{ext}）。
 *
 * 安全：
 * - basename 驗證（防 path traversal：../ 一律 400）
 * - 只可以讀 media dir 底下嘅檔案
 * - 需要登入 + 對話所屬店嘅權限？— Phase 1 只驗登入（檔案名 = wamid，
 *   唔含 PII；真機上再加 clinic 映射檢查）
 */
export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  xls: "application/vnd.ms-excel",
  doc: "application/msword",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function mediaDir(): string {
  return process.env.WA_MEDIA_DIR || "/srv/wa-media";
}

export const GET = handle(
  async (_req: NextRequest, ctx: { params: Promise<{ file: string }> }) => {
    await requireAuth(_req);
    const { file } = await ctx.params;

    // basename 防 traversal
    if (file !== path.basename(file) || file.includes("..")) {
      return NextResponse.json({ error: "invalid file name" }, { status: 400 });
    }
    const ext = (file.split(".").pop() ?? "").toLowerCase();
    const dir = mediaDir();
    const filePath = path.join(dir, file);

    let buf: Buffer;
    try {
      buf = await readFile(filePath);
    } catch {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        "Content-Disposition": `inline; filename="${encodeURIComponent(file)}"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  }
);

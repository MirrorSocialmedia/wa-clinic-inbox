import { type NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import prisma from "@/lib/prisma";
import { requireAuth, assertClinicAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";

/**
 * GET /api/media/[file] — 本地落地媒體檔案（{wamid}.{ext}）。
 *
 * 安全：
 * - basename 驗證（防 path traversal：../ 一律 400）
 * - 只可以讀 media dir 底下嘅檔案
 * - ★ P1-1 clinic scope：由 mediaPath 反查 Message → Conversation.clinicId →
 *   assertClinicAccess（店 A staff 唔可以攞店 B 嘅媒體 — wamid 唔係秘密）；
 *   查唔到任何 Message 持有呢個檔 → 404（唔洩露檔案存在性）
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
  async (req: NextRequest, ctx: { params: Promise<{ file: string }> }) => {
    const auth = await requireAuth(req);
    const { file } = await ctx.params;

    // basename 防 traversal
    if (file !== path.basename(file) || file.includes("..")) {
      return NextResponse.json({ error: "invalid file name" }, { status: 400 });
    }

    // ★ P1-1：clinic scope — 由 mediaPath 反查 Message → Conversation.clinicId。
    //   STAFF 攞別店媒體 → 403；查唔到持有呢個檔嘅 Message → 404（唔洩露檔案存在性）。
    //   mediaPath = {mediaDir}/{wamid}.{ext} — wamid 全球唯一 → 一個檔 = 一條 Message。
    const msg = await prisma.message.findFirst({
      where: {
        OR: [{ mediaPath: file }, { mediaPath: { endsWith: `/${file}` } }],
      },
      select: { conversationId: true },
      take: 1,
    });
    if (!msg) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const conv = await prisma.conversation.findUnique({
      where: { id: msg.conversationId },
      select: { clinicId: true },
    });
    if (!conv) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    assertClinicAccess(auth, conv.clinicId); // STAFF 跨店 → RbacError(403)

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

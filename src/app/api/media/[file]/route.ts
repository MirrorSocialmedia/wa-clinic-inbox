import { type NextRequest, NextResponse } from "next/server";
import path from "node:path";
import prisma from "@/lib/prisma";
import { requireAuth, assertConversationAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { readMediaFile } from "@/lib/wa/media";
import log from "@/lib/log";

/**
 * GET /api/media/[file] — 本地落地媒體檔案（{wamid}.{ext}）。
 *
 * 安全：
 * - basename 驗證（防 path traversal：../ 一律 400）
 * - 只可以讀 media dir 底下嘅檔案
 * - ★ P1-1 clinic scope：由 mediaPath 反查 Message → Conversation.clinicId →
 *   assertConversationAccess（店 A staff 唔可以攞店 B 嘅媒體 — wamid 唔係秘密）；
 *   查唔到任何 Message 持有呢個檔 → 404（唔洩露檔案存在性）
 * - ★ C-1b per-file 加密：readMediaFile 透明解密（碟上密文 / 冇 key 時 legacy 明文）
 * - ★ AS-4 下載安全：X-Content-Type-Options: nosniff（防 MIME sniffing）；
 *   Content-Disposition — image/* + application/pdf → inline（對話內預覽）；
 *   其餘（doc/xls/bin 等二進制）→ attachment（唔畀瀏覽器直接渲染/執行）
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
      select: { clinicId: true, assigneeId: true },
    });
    if (!conv) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    assertConversationAccess(auth, conv); // STAFF 跨店 → RbacError(403)

    const ext = (file.split(".").pop() ?? "").toLowerCase();
    const mime = MIME[ext] ?? "application/octet-stream";

    // ★ C-1b：透明解密（碟上 WA1| 密文 → 明文；dev 冇 key 時 legacy 明文照讀）
    let buf: Buffer;
    try {
      buf = await readMediaFile(file);
    } catch (err) {
      // 讀唔到（檔案消失）→ 404 唔洩露存在性；密文但解唔到（鍵錯/檔損）→ 500 + ERROR log
      if (err instanceof Error && err.message.includes("read failed")) {
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
      log.error(
        { file, err: err instanceof Error ? err.message : String(err) },
        "media: decrypt/read failed（key 錯或檔案損 — 唔洩漏細節）"
      );
      return NextResponse.json({ error: "media unreadable" }, { status: 500 });
    }

    // ★ AS-4：image/* + pdf → inline（預覽）；其餘 → attachment（防瀏覽器執行/渲染二進制）
    const isInline = mime.startsWith("image/") || mime === "application/pdf";
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": mime,
        "Content-Disposition": `${isInline ? "inline" : "attachment"}; filename="${encodeURIComponent(file)}"`,
        // ★ AS-4：nosniff — Content-Type 由我哋決定，唔畀瀏覽器 sniff
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600",
      },
    });
  }
);

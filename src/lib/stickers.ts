/**
 * ★ cwi-sticker-20261107：貼圖庫（同 WhatsApp 一樣：自己加、收藏收到嘅貼圖）。
 *
 * - 我的貼圖（ownerKey = 員工 id）：每人最多 100 張，只有自己見到／刪到
 * - 診所貼圖（ownerKey = "clinic"）：全部同事用；只有集團管理員（ADMIN + 全店）加／刪；最多 200 張
 * - 加貼圖：JPG／PNG／WebP／GIF → 512×512 WebP（透明底置中，唔裁走）；靜態 ≤100KB、動態 ≤500KB（Meta 規定）
 *   太大 → 自動降畫質；降到底都超 → 400（話用戶揀細啲／短啲）
 * - 收藏收到嘅貼圖：要睇得到嗰個對話；只限 type=sticker 兼已落地
 * - 同一範圍同一張（sha256）唔重複加 → 回舊嗰張
 * - 檔案碟上加密（stk-<uuid>.webp）；發出去時另複製（out-／wg-）— 刪貼圖唔影響已發訊息
 * - PII：貼圖名唔入 log；AuditLog 只記 id
 */
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { unlink } from "node:fs/promises";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { assertConversationAccess, scopedClinicSet, type AuthContext } from "@/lib/rbac";
import { saveMediaFile, readMediaFile, mediaDirPreferred } from "@/lib/wa/media";

export const CLINIC_KEY = "clinic";
export const STICKER_MINE_MAX = 100;
export const STICKER_CLINIC_MAX = 200;
export const STICKER_UPLOAD_MAX = 8 * 1024 * 1024; // 原檔上限（轉換前）
export const STATIC_MAX = 100 * 1024;
export const ANIMATED_MAX = 500 * 1024;
const NAME_MAX = 30;

type Ctx = Pick<AuthContext, "staff" | "scopeType" | "scopedClinicIds">;

export class StickerError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function isClinicAdmin(ctx: Ctx): boolean {
  return ctx.staff.role === "ADMIN" && scopedClinicSet(ctx) === null;
}

// ── 轉換 ───────────────────────────────────────────────────────────────────

/** 任何支援圖片 → WhatsApp 貼圖（512×512 WebP）。純函數（除 sharp）— 可 unit test。 */
export async function toWhatsAppSticker(input: Buffer): Promise<{ buf: Buffer; animated: boolean }> {
  if (input.length === 0) throw new StickerError(400, "EMPTY", "檔案係空嘅");
  if (input.length > STICKER_UPLOAD_MAX) throw new StickerError(413, "TOO_LARGE", "檔案太大（最多 8MB）");
  // 檔頭白名單（magic bytes）先過，先交俾 sharp — SVG／HEIF／TIFF 等格式根本唔入 libvips（防 librsvg／libheif 類漏洞）
  if (!sniffStickerInput(input)) throw new StickerError(415, "UNSUPPORTED", "唔係支援嘅圖片（請用 JPG／PNG／GIF／WebP）");
  const { default: sharp } = await import("sharp");
  let meta: import("sharp").Metadata;
  try {
    meta = await sharp(input, { animated: true, limitInputPixels: 40_000_000 }).metadata();
  } catch {
    throw new StickerError(415, "UNSUPPORTED", "唔係支援嘅圖片（請用 JPG／PNG／GIF／WebP）");
  }
  if (!meta.format || !["jpeg", "png", "webp", "gif"].includes(meta.format)) throw new StickerError(415, "UNSUPPORTED", "唔係支援嘅圖片（請用 JPG／PNG／GIF／WebP）");
  const pages = meta.pages ?? 1;
  const animated = pages > 1;
  if (animated && pages > 300) throw new StickerError(400, "TOO_MANY_FRAMES", "動態圖太長（最多 300 格）— 請剪短啲");
  // 解壓炸彈防護：所有格加埋嘅像素上限（單格上限由 limitInputPixels 管）
  const frameH = meta.pageHeight ?? meta.height ?? 0;
  if ((meta.width ?? 0) * frameH * pages > 120_000_000) throw new StickerError(400, "TOO_BIG", "張圖太大（尺寸 × 格數太多）— 請揀細啲／短啲");
  const max = animated ? ANIMATED_MAX : STATIC_MAX;
  const qualities = animated ? [75, 60, 45, 30, 20] : [90, 80, 70, 60, 50, 40, 30];
  for (const quality of qualities) {
    const out = await sharp(input, { animated, limitInputPixels: 40_000_000 })
      .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality, effort: 4, ...(animated ? { loop: 0 } : {}) })
      .toBuffer();
    if (out.length <= max) return { buf: out, animated };
  }
  throw new StickerError(400, "CANNOT_SHRINK", animated ? "動態貼圖壓唔到 500KB 以下 — 請揀短啲或者細啲嘅 GIF" : "貼圖壓唔到 100KB 以下 — 請揀簡單啲嘅圖");
}

/** 只收 JPEG／PNG／GIF／WebP（睇檔頭，唔信副檔名／MIME） */
export function sniffStickerInput(b: Buffer): "jpeg" | "png" | "gif" | "webp" | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.length >= 6 && (b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a")) return "gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

function cleanName(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().replace(/\s+/g, " ").slice(0, NAME_MAX) : "";
  return s || null;
}

// ── 讀 ─────────────────────────────────────────────────────────────────────

export interface StickerView {
  id: string;
  name: string | null;
  animated: boolean;
  url: string;
  scope: "mine" | "clinic";
}

function view(r: { id: string; name: string | null; animated: boolean; fileKey: string; ownerKey: string }): StickerView {
  return { id: r.id, name: r.name, animated: r.animated, url: `/api/stickers/file/${r.fileKey}`, scope: r.ownerKey === CLINIC_KEY ? "clinic" : "mine" };
}

export async function listStickers(staffId: string): Promise<{ mine: StickerView[]; clinic: StickerView[] }> {
  const rows = await prisma.sticker.findMany({
    where: { ownerKey: { in: [staffId, CLINIC_KEY] } },
    orderBy: [{ lastUsedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    take: STICKER_MINE_MAX + STICKER_CLINIC_MAX,
  });
  return { mine: rows.filter((r) => r.ownerKey === staffId).map(view), clinic: rows.filter((r) => r.ownerKey === CLINIC_KEY).map(view) };
}

/** 貼圖檔：自己嘅 + 診所嘅先攞到；其他 → null（route 404，唔洩露存在性） */
export async function stickerFileForViewer(fileKey: string, staffId: string): Promise<boolean> {
  const r = await prisma.sticker.findUnique({ where: { fileKey }, select: { ownerKey: true } });
  return !!r && (r.ownerKey === CLINIC_KEY || r.ownerKey === staffId);
}

/** 用貼圖（發送前）：自己嘅或者診所嘅；回貼圖 row（唔得 → 404） */
export async function usableSticker(stickerId: string, staffId: string) {
  const r = await prisma.sticker.findUnique({ where: { id: stickerId } });
  if (!r || (r.ownerKey !== CLINIC_KEY && r.ownerKey !== staffId)) throw new StickerError(404, "NOT_FOUND", "搵唔到呢張貼圖");
  return r;
}

/** 複製一份貼圖檔（發出去用；新 key 唔同貼圖檔 — 刪貼圖唔影響已發訊息） */
export async function copyStickerFile(fileKey: string, newKey: string): Promise<{ path: string; bytes: number }> {
  const buf = await readMediaFile(fileKey);
  const p = await saveMediaFile(newKey, buf);
  return { path: p, bytes: buf.length };
}

export async function touchSticker(stickerId: string): Promise<void> {
  await prisma.sticker.updateMany({ where: { id: stickerId }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
}

// ── 寫 ─────────────────────────────────────────────────────────────────────

async function storeSticker(ctx: Ctx, scope: "mine" | "clinic", input: Buffer, name: unknown): Promise<{ sticker: StickerView; duplicate: boolean }> {
  if (scope === "clinic" && !isClinicAdmin(ctx)) throw new StickerError(403, "CLINIC_ADMIN_ONLY", "診所貼圖只有老闆（集團管理員）先加得");
  const ownerKey = scope === "clinic" ? CLINIC_KEY : ctx.staff.id;
  const { buf, animated } = await toWhatsAppSticker(input);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const dup = await prisma.sticker.findUnique({ where: { ownerKey_sha256: { ownerKey, sha256 } } });
  if (dup) return { sticker: view(dup), duplicate: true };
  const count = await prisma.sticker.count({ where: { ownerKey } });
  const cap = scope === "clinic" ? STICKER_CLINIC_MAX : STICKER_MINE_MAX;
  if (count >= cap) throw new StickerError(409, "LIMIT", `${scope === "clinic" ? "診所貼圖" : "我的貼圖"}最多 ${cap} 張 — 請先刪走唔用嘅`);
  const fileKey = `stk-${randomUUID()}.webp`;
  await saveMediaFile(fileKey, buf);
  try {
    const row = await prisma.sticker.create({ data: { ownerKey, name: cleanName(name), fileKey, animated, bytes: buf.length, sha256, createdById: ctx.staff.id } });
    await prisma.auditLog.create({ data: { staffId: ctx.staff.id, action: "STICKER_ADD", entity: "Sticker", entityId: row.id, meta: { scope, animated, bytes: buf.length } } });
    log.info({ stickerId: row.id, scope, animated, bytes: buf.length }, "sticker: added");
    return { sticker: view(row), duplicate: false };
  } catch (e) {
    await unlink(path.join(mediaDirPreferred(), fileKey)).catch(() => undefined);
    // 並發加同一張 → unique 撞 → 回已存在嗰張
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const again = await prisma.sticker.findUnique({ where: { ownerKey_sha256: { ownerKey, sha256 } } });
      if (again) return { sticker: view(again), duplicate: true };
    }
    throw e;
  }
}

export async function addSticker(ctx: Ctx, input: { buf: Buffer; name?: unknown; scope: "mine" | "clinic" }) {
  return storeSticker(ctx, input.scope, input.buf, input.name);
}

/** 收藏收到嘅貼圖（⭐）：要睇得到嗰個對話；只限已落地嘅 sticker 訊息 */
export async function addStickerFromMessage(ctx: Ctx, input: { messageId: string; scope: "mine" | "clinic"; name?: unknown }) {
  const msg = await prisma.message.findUnique({ where: { id: input.messageId }, select: { id: true, type: true, mediaKey: true, mediaStatus: true, conversationId: true } });
  if (!msg) throw new StickerError(404, "MSG_NOT_FOUND", "搵唔到呢條訊息");
  const conv = await prisma.conversation.findUnique({ where: { id: msg.conversationId } });
  if (!conv) throw new StickerError(404, "MSG_NOT_FOUND", "搵唔到呢條訊息");
  try {
    await assertConversationAccess(ctx, conv);
  } catch {
    throw new StickerError(404, "MSG_NOT_FOUND", "搵唔到呢條訊息");
  }
  if (msg.type !== "sticker") throw new StickerError(400, "NOT_STICKER", "呢條唔係貼圖");
  if (!msg.mediaKey || msg.mediaStatus !== "READY") throw new StickerError(409, "NOT_READY", "貼圖未下載完，等一陣再試");
  let buf: Buffer;
  try {
    buf = await readMediaFile(msg.mediaKey);
  } catch {
    throw new StickerError(409, "NOT_READY", "讀唔到呢張貼圖");
  }
  return storeSticker(ctx, input.scope, buf, input.name);
}

export async function deleteSticker(ctx: Ctx, stickerId: string): Promise<void> {
  const r = await prisma.sticker.findUnique({ where: { id: stickerId } });
  if (!r) throw new StickerError(404, "NOT_FOUND", "搵唔到呢張貼圖");
  if (r.ownerKey === CLINIC_KEY ? !isClinicAdmin(ctx) : r.ownerKey !== ctx.staff.id) throw new StickerError(404, "NOT_FOUND", "搵唔到呢張貼圖");
  const del = await prisma.sticker.deleteMany({ where: { id: stickerId } });
  if (del.count === 0) return; // 並發刪 = 冪等
  await unlink(path.join(mediaDirPreferred(), r.fileKey)).catch(() => undefined);
  await prisma.auditLog.create({ data: { staffId: ctx.staff.id, action: "STICKER_DELETE", entity: "Sticker", entityId: stickerId, meta: { scope: r.ownerKey === CLINIC_KEY ? "clinic" : "mine" } } });
}

export async function renameSticker(ctx: Ctx, stickerId: string, name: unknown): Promise<void> {
  const r = await prisma.sticker.findUnique({ where: { id: stickerId } });
  if (!r || (r.ownerKey === CLINIC_KEY ? !isClinicAdmin(ctx) : r.ownerKey !== ctx.staff.id)) throw new StickerError(404, "NOT_FOUND", "搵唔到呢張貼圖");
  await prisma.sticker.update({ where: { id: stickerId }, data: { name: cleanName(name) } });
}

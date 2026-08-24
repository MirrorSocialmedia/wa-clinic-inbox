/**
 * retention-purge — P0 自動刪除（AI Workflow T1, cwi-ai-20260824-t1；總綱 §6.0）。
 *
 * privacy 頁已承諾「對話 24 月 / 媒體 12 月 / AiDraft 90 日」自動刪除 — 呢個 cron 先係真正落實。
 * 每日 04:00 HK 一次（cron.worker `retention-purge`；scheduler 註冊喺 workers/index.ts）。
 *
 * 規則（每批 500，loop 到清）：
 *   1. media 檔（RETENTION_MEDIA_MONTHS，預設 12 月）：刪 disk 加密檔 + Message.mediaPath 清 null
 *      （訊息殼保留到對話期 — 即 UI 仍見占位，附件已無）
 *   2. Message（RETENTION_CONV_MONTHS，預設 24 月）：連同 NoteReadReceipt、
 *      PatientFact（sourceMessageId 對應）一齊刪
 *   3. AiDraft（RETENTION_DRAFT_DAYS，預設 90 日）：status ≠ PROPOSED 先刪
 *      （PROPOSED = staff 未審批 — 留低俾人處理，唔會自動刪）
 *   4. StaffNotice 已讀 > 90 日（§6.0；與 RETENTION_DRAFT_DAYS 同水位，未設獨立 env）
 *
 * 冪等 / 安全：
 * - 純 delete + update null — 重跑安全（冇副作用；已刪嘅行唔會再出現）
 * - 檔刪除：ENOENT 容許（之前 run 已刪）；路徑 = mediaDirPreferred() + basename（同 serve 路徑一致，
 *   basename 校驗防 traversal — mediaPath 欄只由 saveMediaFile 寫入）
 * - log metadata only（counts）— 永不 log 訊息內容 / 病人資料
 * - 跑完寫 OpsReport（periodStart = 當日 00:00 本地；upsert 冪等 — 同日重跑覆蓋）
 *
 * ⚠️ 保留期數字老細未最終簽（App Review pack 已 flag）— env 化（RETENTION_CONV_MONTHS 等三個變數），
 * 簽完改 env 唔使改 code。
 */
import path from "node:path";
import { unlink } from "node:fs/promises";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { mediaDirPreferred } from "@/lib/wa/media";

const BATCH = 500;
/** §6.0：StaffNotice 已讀保留 90 日（spec 固定值；三個 env 保留期之外）。 */
const STAFF_NOTICE_READ_DAYS = 90;

function monthsAgo(months: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d;
}
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}
/** env 正整數解析（壞值 → fallback 預設；唔好因為 env 手誤令 purge 死咗）。 */
function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/** 刪媒體檔（ENOENT 容許）— 回 true = 有刪（或已無）。 */
async function purgeMediaFile(mediaPath: string): Promise<boolean> {
  const base = path.basename(mediaPath);
  if (!base || base === "." || base === "..") {
    log.warn({ path: mediaPath }, "retention-purge: 壞 mediaPath — skip（唔刪）");
    return false;
  }
  const target = path.join(mediaDirPreferred(), base);
  try {
    await unlink(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true; // 已無 = 目標狀態
    log.warn({ file: base, err: err instanceof Error ? err.message : String(err) }, "retention-purge: 刪檔失敗（留底，下次再試）");
    return false;
  }
}

export interface RetentionPurgeResult {
  mediaFilesDeleted: number;
  mediaPathsCleared: number;
  messagesDeleted: number;
  noteReceiptsDeleted: number;
  patientFactsDeleted: number;
  aiDraftsDeleted: number;
  staffNoticesDeleted: number;
  batches: number;
  reportId: string;
}

export async function runRetentionPurge(): Promise<RetentionPurgeResult> {
  const convCutoff = monthsAgo(envInt("RETENTION_CONV_MONTHS", 24));
  const mediaCutoff = monthsAgo(envInt("RETENTION_MEDIA_MONTHS", 12));
  const draftCutoff = daysAgo(envInt("RETENTION_DRAFT_DAYS", 90));
  const noticeCutoff = daysAgo(STAFF_NOTICE_READ_DAYS);

  let mediaFilesDeleted = 0;
  let mediaPathsCleared = 0;
  let messagesDeleted = 0;
  let noteReceiptsDeleted = 0;
  let patientFactsDeleted = 0;
  let aiDraftsDeleted = 0;
  let staffNoticesDeleted = 0;
  let batches = 0;

  // ── 1. media 檔（12 月）：刪檔 + mediaPath=null（訊息殼留到 24 月） ─────
  // 先於 Message 刪除跑：任何過 24 月嘅訊息都一定先喺呢步清咗附件（重跑安全）。
  for (;;) {
    const rows = await prisma.message.findMany({
      where: { mediaPath: { not: null }, waTimestamp: { lt: mediaCutoff } },
      select: { id: true, mediaPath: true },
      take: BATCH,
    });
    if (rows.length === 0) break;
    batches += 1;
    let deletedFiles = 0;
    const clearIds: string[] = [];
    for (const r of rows) {
      const p = r.mediaPath as string;
      if (await purgeMediaFile(p)) {
        deletedFiles += 1;
        clearIds.push(r.id);
      }
    }
    if (clearIds.length > 0) {
      await prisma.message.updateMany({ where: { id: { in: clearIds } }, data: { mediaPath: null } });
    }
    mediaFilesDeleted += deletedFiles;
    mediaPathsCleared += clearIds.length;
    if (clearIds.length === 0) {
      // ★ 零進度防無限循環：呢批全部 purgeMediaFile fail（EACCES 等）→ mediaPath 冇變 →
      //   下次 findMany 取返同一批 → 無限 busy loop 打 DB。break 出 media step（Message 刪除 step 照行）。
      log.warn({ batch: rows.length }, "retention-purge: media step 零進度（purgeMediaFile 全 fail）— abort media step");
      break;
    }
    if (rows.length < BATCH) break;
  }

  // ── 2. Message（24 月）：連 NoteReadReceipt + PatientFact 一齊刪 ────────
  for (;;) {
    const rows = await prisma.message.findMany({
      where: { waTimestamp: { lt: convCutoff } },
      select: { id: true, mediaPath: true },
      take: BATCH,
    });
    if (rows.length === 0) break;
    batches += 1;
    const ids = rows.map((r) => r.id);
    // 防禦：步 1 應該已清晒附件；若仍有殘留（例：步 1 刪檔失敗）— 照試刪檔，訊息照刪（附件孤兒檔由運維處理）
    for (const r of rows) {
      if (r.mediaPath) {
        await purgeMediaFile(r.mediaPath as string).catch(() => undefined);
      }
    }
    const [nrr, pf, msg] = await Promise.all([
      prisma.noteReadReceipt.deleteMany({ where: { messageId: { in: ids } } }),
      prisma.patientFact.deleteMany({ where: { sourceMessageId: { in: ids } } }),
      prisma.message.deleteMany({ where: { id: { in: ids } } }),
    ]);
    noteReceiptsDeleted += nrr.count;
    patientFactsDeleted += pf.count;
    messagesDeleted += msg.count;
    if (rows.length < BATCH) break;
  }

  // ── 3. AiDraft（90 日 且 status ≠ PROPOSED — PROPOSED 留俾 staff 審批） ──
  for (;;) {
    const rows = await prisma.aiDraft.findMany({
      where: { createdAt: { lt: draftCutoff }, status: { not: "PROPOSED" } },
      select: { id: true },
      take: BATCH,
    });
    if (rows.length === 0) break;
    batches += 1;
    const res = await prisma.aiDraft.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    aiDraftsDeleted += res.count;
    if (rows.length < BATCH) break;
  }

  // ── 4. StaffNotice 已讀 > 90 日 ─────────────────────────────────────────
  for (;;) {
    const rows = await prisma.staffNotice.findMany({
      where: { readAt: { not: null, lt: noticeCutoff } },
      select: { id: true },
      take: BATCH,
    });
    if (rows.length === 0) break;
    batches += 1;
    const res = await prisma.staffNotice.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    staffNoticesDeleted += res.count;
    if (rows.length < BATCH) break;
  }

  // ── OpsReport（upsert 冪等：同日重跑覆蓋） ──────────────────────────────
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const metrics = {
    mediaFilesDeleted,
    mediaPathsCleared,
    messagesDeleted,
    noteReceiptsDeleted,
    patientFactsDeleted,
    aiDraftsDeleted,
    staffNoticesDeleted,
    batches,
    cutoffs: { conv: convCutoff.toISOString(), media: mediaCutoff.toISOString(), draft: draftCutoff.toISOString() },
  };
  const text =
    `retention-purge ${now.toISOString().slice(0, 10)}：` +
    `media 檔 ${mediaFilesDeleted} / mediaPath 清 ${mediaPathsCleared} / ` +
    `Message ${messagesDeleted}（連 NoteReadReceipt ${noteReceiptsDeleted} + PatientFact ${patientFactsDeleted}）/ ` +
    `AiDraft ${aiDraftsDeleted} / StaffNotice(已讀) ${staffNoticesDeleted}`;
  const report = await prisma.opsReport.upsert({
    where: { periodStart_clinicId: { periodStart: dayStart, clinicId: "" } },
    update: { periodEnd: now, metrics: metrics as unknown as object, text },
    create: { periodStart: dayStart, periodEnd: now, clinicId: "", metrics: metrics as unknown as object, text },
  });

  // ★ metadata only — 只 counts，唔含任何訊息/病人資料
  log.info(
    { ...metrics, reportId: report.id },
    "retention-purge: done"
  );

  return { ...metrics, reportId: report.id };
}

/**
 * T-24h 預約提醒掃描（Phase B — 總綱 §6.2 B2，cwi-tmpl-20260824-b1）。
 *
 * 揀單：BookingRequest CONFIRMED + apricotApptId≠null + remindedAt=null
 *       + requestedTime≠null + HK 開診時刻 ∈ [now+minH, now+maxH]（預設 23–25h）
 * 冪等：remindedAt 同 Message 同一 transaction 寫 — 掃兩次唔會重發。
 * 降級：enqueue 失敗 → Message FAILED（inbox 見紅）；remindedAt 已寫 = 唔會重發
 *       （寧漏勿重 — 漏咗員工喺 FAILED 訊息見到可人手補）。
 * 範圍（v1）：只提醒經 wa-inbox 落嘅單。電話落嘅 Apricot 單 = Phase B+
 *       （等 workforce per-clinic 全日 appointments feed 契約）。
 * ★ PII：log 只 bookingId/clinicId/date — 零病人資料。
 */
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import log from "@/lib/log";
import {
  buildTemplateComponents,
  reminderPreviewText,
  reminderTemplateName,
  reminderTemplateLang,
} from "@/lib/wa/templates";

// ★ 延遲 import：outboundQueue/publishNotify 會拉起 Redis 連接（BullMQ module-level
// instance）— unit test（零 Redis）import 呢個 module 時唔想連坐。生產路徑行為不變。
async function lazyEnqueue(messageId: string) {
  const { outboundQueue } = await import("@/lib/queue");
  await Promise.race([
    outboundQueue.add("send", { messageId }),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("enqueue timeout")), ENQUEUE_TIMEOUT_MS)),
  ]);
}

async function lazyNotify(clinicId: string, conversationId: string) {
  const { publishNotify } = await import("@/lib/notify");
  publishNotify(clinicId, "message:new", { conversationId, clinicId }); // 輕量提示；完整 payload 由 outbound sent 事件補
}

const ENQUEUE_TIMEOUT_MS = 1500;

function windowHours(): { minH: number; maxH: number } {
  const minH = Number(process.env.REMINDER_MIN_HOURS ?? 23);
  const maxH = Number(process.env.REMINDER_MAX_HOURS ?? 25);
  return {
    minH: Number.isFinite(minH) && minH >= 0 ? minH : 23,
    maxH: Number.isFinite(maxH) && maxH > 0 ? maxH : 25,
  };
}

/** HK（UTC+8 固定無 DST）開診時刻 → epoch ms。 */
export function hkApptEpochMs(dateStr: string, timeStr: string): number {
  return new Date(`${dateStr}T${timeStr}:00+08:00`).getTime();
}

/** 純窗口判斷（unit 可測）：開診時刻喺 [now+minH, now+maxH] 內先提醒。 */
export function inReminderWindow(tMs: number, nowMs: number, minH: number, maxH: number): boolean {
  return tMs >= nowMs + minH * 3_600_000 && tMs <= nowMs + maxH * 3_600_000;
}

export interface ReminderScanResult {
  scanned: number;
  sent: number;
  failed: number;
}

export async function runReminderScan(now: Date = new Date()): Promise<ReminderScanResult> {
  const { minH, maxH } = windowHours();

  // 候選集細（CONFIRMED + 未提醒），日期粗篩今日/聽日/後日三個 HK 日字串（25h 窗口必喺其中一日），時刻精篩喺 JS 做
  const dayStrs = [0, 1, 2].map((d) => {
    const hk = new Date(now.getTime() + 8 * 3_600_000 + d * 86_400_000);
    return hk.toISOString().slice(0, 10);
  });
  const candidates = await prisma.bookingRequest.findMany({
    where: {
      status: "CONFIRMED",
      apricotApptId: { not: null },
      remindedAt: null,
      requestedTime: { not: null },
      requestedDate: { in: dayStrs },
    },
  });

  let sent = 0;
  let failed = 0;
  for (const b of candidates) {
    if (!b.requestedTime) continue; // findMany where 已擋；TS 收窄用
    const t = hkApptEpochMs(b.requestedDate, b.requestedTime);
    if (!inReminderWindow(t, now.getTime(), minH, maxH)) continue;

    const conv = await prisma.conversation.findUnique({ where: { id: b.conversationId } });
    const clinic = await prisma.clinic.findUnique({ where: { id: b.clinicId } });
    if (!conv || !clinic) continue;

    const input = {
      requestedDate: b.requestedDate,
      requestedTime: b.requestedTime,
      providerName: b.providerName,
      clinicName: clinic.name,
    };
    // ── 冪等核心：Message + remindedAt 同一 transaction ──
    // re-check 防競態：掃描取候選之後 單被取消/rollback → skip（唔會提醒已取消單）。
    const msg = await prisma.$transaction(async (tx) => {
      const fresh = await tx.bookingRequest.findUnique({
        where: { id: b.id },
        select: { remindedAt: true, status: true },
      });
      if (!fresh || fresh.remindedAt !== null || fresh.status !== "CONFIRMED") return null;
      const m = await tx.message.create({
        data: {
          conversationId: b.conversationId,
          direction: "OUT",
          channel: "API",
          type: "template",
          body: reminderPreviewText(input),
          templateMeta: {
            name: reminderTemplateName(),
            language: reminderTemplateLang(),
            components: buildTemplateComponents(input),
          } as unknown as Prisma.InputJsonValue,
          status: "QUEUED",
          sentByStaffId: null,
          waTimestamp: new Date(),
        },
      });
      await tx.bookingRequest.update({ where: { id: b.id }, data: { remindedAt: new Date() } });
      return m;
    });
    if (!msg) continue;

    try {
      await lazyEnqueue(msg.id);
      await prisma.$executeRaw`
        UPDATE "Conversation" SET "lastMessageAt" = GREATEST("lastMessageAt", ${msg.waTimestamp}) WHERE "id" = ${conv.id}`;
      await lazyNotify(b.clinicId, conv.id);
      sent++;
      log.info(
        { bookingId: b.id, clinicId: b.clinicId, date: b.requestedDate },
        "reminder: template queued"
      );
    } catch (err) {
      // 寧漏勿重：remindedAt 已寫 — 唔會重發；員工人手補（FAILED 訊息 inbox 見紅）
      await prisma.message
        .update({ where: { id: msg.id }, data: { status: "FAILED", errorCode: "ENQUEUE_FAILED" } })
        .catch(() => undefined);
      failed++;
      log.error(
        { bookingId: b.id, err: err instanceof Error ? err.message : String(err) },
        "reminder: enqueue failed（remindedAt 已寫，唔重發 — 員工人手補）"
      );
    }
  }
  return { scanned: candidates.length, sent, failed };
}

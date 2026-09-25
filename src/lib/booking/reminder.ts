/**
 * T-24h 預約提醒掃描（Phase B — 總綱 §6.2 B2，cwi-tmpl-20260824-b1）。
 *
 * 揀單：BookingRequest CONFIRMED + apricotApptId≠null + remindedAt=null
 *       + requestedTime≠null + HK 開診時刻 ∈ [now+minH, now+maxH]（預設 23–25h）
 * 冪等：remindedAt 同 Message 同一 transaction 寫 — 掃兩次唔會重發。
 * 降級（★ cwi-final S1-15）：enqueue uncertain（timeout/Redis）→ Message **唔標 FAILED**（job 可能已落隊列 —
 *       jobId 冪等）— 留 QUEUED，outbound-sweep 120s 後重加兜底；remindedAt 已寫 = 呢單唔會再提醒。
 *       （`failed` 計數保留喺 return 形但不再遞增 — S1-15 後 enqueue uncertain ≠ 失敗）。
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
} from "@/lib/wa/templates";
// ★ Phase D（cwi-ai-20260825-t4）：reminder 窗口 + template 名/語言 由 WorkflowDefinition
// 「reminder」params 讀（全局一份；env REMINDER_MIN/MAX_HOURS、TEMPLATE_REMINDER_NAME/LANG 保留做 defaults 底）
import { getParams } from "@/lib/workflow/store";

// ★ cwi-final S5-7（F2）：發前核對 Apricot 預約狀態（fail-closed）
import { fetchAppointments } from "@/lib/workforce/client";
import { phoneHash } from "@/lib/phone-hash";
import { hkDateOffset } from "@/lib/availability";

// ★ 延遲 import：outboundQueue/publishNotify 會拉起 Redis 連接（BullMQ module-level
// instance）— unit test（零 Redis）import 呢個 module 時唔想連坐。生產路徑行為不變。
async function lazyEnqueue(messageId: string) {
  const { enqueueOutboundSend } = await import("@/lib/queue");
  await Promise.race([
    enqueueOutboundSend(messageId),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("enqueue timeout")), ENQUEUE_TIMEOUT_MS)),
  ]);
}

// ★ cwi-final S1-4/S1-7：完整 payload（buildMessageNewPayload 單一來源）+ publishConvEvent（跨店 targeting + eventId 去重）
async function lazyNotifyMessageNew(
  messageId: string,
  conv: { id: string; clinicId: string; assigneeId: string | null; routedStaffId: string | null; routedGroupId: string | null }
): Promise<void> {
  const { publishConvEvent, convRef } = await import("@/lib/notify");
  const { buildMessageNewPayload } = await import("@/lib/realtime-payload");
  const payload = await buildMessageNewPayload(messageId);
  await publishConvEvent(convRef(conv), "message:new", payload);
}

const ENQUEUE_TIMEOUT_MS = 1500;

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
  // ★ Phase D：窗口 + template 參數由 workflow params 讀（fail-soft → env 底 defaults）
  const reminderParams = await getParams("reminder", null);
  const minH = reminderParams.minHours;
  const maxH = reminderParams.maxHours;

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
  // ★ cwi-final S1-15：enqueue uncertain 唔再算「失敗」（row 留 QUEUED，sweep 兜底）— 恒 0；
  // return 形保留（caller / cron log 兼容）。
  const failed = 0;
  for (const b of candidates) {
    if (!b.requestedTime) continue; // findMany where 已擋；TS 收窄用
    const t = hkApptEpochMs(b.requestedDate, b.requestedTime);
    if (!inReminderWindow(t, now.getTime(), minH, maxH)) continue;

    const conv = await prisma.conversation.findUnique({ where: { id: b.conversationId } });
    const clinic = await prisma.clinic.findUnique({ where: { id: b.clinicId } });
    if (!conv || !clinic) continue;

    // ★ cwi-final S5-7（F2）：發前 fetchAppointments 核對 — 預約狀態必須 = 0（booked）。
    //   102 = 舊單已改期 / -7 = 已取消 / 搵唔到（單已消失）/ workforce 離線 → fail-closed skip：
    //   remindedAt 留 null（下輪 scan 重試）— 寧可遲提醒，唔提醒已取消嘅單。
    const contact = await prisma.contact.findUnique({ where: { id: conv.contactId } });
    if (!contact?.waId) continue;
    try {
      const appts = await fetchAppointments(phoneHash(contact.waId), hkDateOffset(-7), hkDateOffset(30));
      const found = appts.appointments.find((a) => a.apricotApptId === b.apricotApptId);
      if (found?.bookingStatus !== 0) {
        log.info(
          { bookingId: b.id, apptStatus: found?.bookingStatus ?? null },
          "reminder: appt status != 0（或已消失）→ skip（fail-closed，唔提醒）"
        );
        continue;
      }
    } catch (err) {
      log.warn(
        { bookingId: b.id, err: err instanceof Error ? err.name : "?" },
        "reminder: fetchAppointments failed → skip（fail-closed，下輪重試）"
      );
      continue;
    }

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
            name: reminderParams.templateName,
            language: reminderParams.templateLang,
            // cwi-window-20260901（P1）：類別快照（同 send route 一致）— 預約提醒範本係 UTILITY 類
            category: "UTILITY",
            components: buildTemplateComponents(input),
          } as unknown as Prisma.InputJsonValue,
          status: "QUEUED",
          sentByStaffId: null,
          // cwi-window-20260901（P1）：預約提醒 template — 類別 UTILITY（declared：cron 寫入點無辦法讀
          // WA Manager 即時類別；該範本在 WA Manager 登記為 UTILITY）
          billingCategory: "UTILITY",
          waTimestamp: new Date(),
        },
      });
      await tx.bookingRequest.update({ where: { id: b.id }, data: { remindedAt: new Date() } });
      return m;
    });
    if (!msg) continue;

    try {
      await lazyEnqueue(msg.id);
    } catch (err) {
      // ★ cwi-final S1-15 (P0-07)：enqueue uncertain — **唔標 FAILED**（job 可能已落隊列 — jobId 冪等）。
      // 留 QUEUED → outbound-sweep 120s 後重加兜底（唔雙發）。remindedAt 已寫 = 呢單唔會再提醒。
      log.warn(
        { bookingId: b.id, err: err instanceof Error ? err.message : String(err) },
        "reminder: enqueue uncertain — message stays QUEUED (sweep will requeue; remindedAt already written)"
      );
    }
    try {
      await prisma.$executeRaw`
        UPDATE "Conversation" SET "lastMessageAt" = GREATEST("lastMessageAt", ${msg.waTimestamp}) WHERE "id" = ${conv.id}`;
      await lazyNotifyMessageNew(msg.id, conv);
    } catch (err) {
      // lastMessageAt / notify 係 fail-soft — 訊息已入隊（或會由 sweep 重加）；唔再標 FAILED（S1-15）
      log.warn(
        { bookingId: b.id, err: err instanceof Error ? err.message : String(err) },
        "reminder: post-queue notify failed (fail-soft — message QUEUED)"
      );
    }
    sent++;
    log.info(
      { bookingId: b.id, clinicId: b.clinicId, date: b.requestedDate },
      "reminder: template queued"
    );
  }
  return { scanned: candidates.length, sent, failed };
}

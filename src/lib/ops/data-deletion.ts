/**
 * data-deletion — 病人資料刪除（wa-meta-compliance-20261016 Part D）
 *
 * 病人「刪除我的資料」請求的後端執行：staff（ADMIN，scope 內）觸發，
 * 一個 transaction 清晒該 Contact 名下所有 PII + 媒體檔，留最小 metadata-only 刪除憑證。
 *
 * 刪除範圍（PII 全位置 — 與報告 D.1 清單對齊）：
 *   DB（contact 直屬）：Contact / ContactConsent / PatientFact / StaffNotice
 *   DB（conversation 關聯）：Conversation / Message / AiDraft / FollowupTask / FlowSession /
 *                            BookingSession / PainTriageSession / BookingRequest / ConsultSession /
 *                            ConversationRead / NoteReadReceipt
 *   DB（wamid 關聯）：PendingStatus / WebhookEvent（id=wamid）
 *   DB（PII scrub，唔刪）：FlowHoldEvent（patientName/patientPhone/contactPhone → null —
 *                            workforce 對賬 record 保留，PII 即刻清，唔等 90 日 retention）
 *   檔案：媒體檔（mediaDirPreferred()/basename — 同 retention-purge 同路徑口徑）
 *   Queue：outbound 殘留 job（按 messageId remove — best effort）
 *   留低（metadata-only，design invariant：AuditLog 永不存訊息原文 PII）：
 *         AuditLog 歷史行（id 指涉已刪 row = 可接受；append-only 審計語義）
 *         + 一條新 PATIENT_DATA_DELETED 憑證（staffId + counts + clinicId，零 PII）
 *
 * 備份說明（政策文案對齊）：pg_dump 全庫備份（≤30 日保留）+ 離線副本可能含已刪 PII —
 * 備份過期後彻底消失；唔做備份內 selective scrub（成本高 + 備份 immutable 口徑）。
 */
import { unlink } from "node:fs/promises";
import path from "node:path";
import prisma from "@/lib/prisma";
import { ensureMediaDir } from "@/lib/wa/media";
import { outboundQueue } from "@/lib/queue";
import log from "@/lib/log";

export interface DeletePatientDataResult {
  contactId: string;
  clinicId: string;
  conversationsDeleted: number;
  messagesDeleted: number;
  mediaFilesDeleted: number;
  mediaFilesMissing: number;
  mediaDeleteFailed: string[]; // 刪唔到嘅檔（留底 — retention sweep 下次再試）
  aiDraftsDeleted: number;
  patientFactsDeleted: number;
  consentsDeleted: number;
  noticesDeleted: number;
  flowSessionsDeleted: number;
  followupTasksDeleted: number;
  holdEventsScrubbed: number;
  queueJobsRemoved: number;
}

/**
 * 刪除一位病人（Contact）名下全部 PII。
 * 冪等：contact 已無 → throw NotFound（caller 轉 404）。
 * @throws Error("CONTACT_NOT_FOUND")
 */
export async function deletePatientData(input: {
  contactId: string;
  staffId: string;
  reason?: string;
}): Promise<DeletePatientDataResult> {
  const { contactId, staffId, reason } = input;
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { id: true, clinicId: true, waId: true },
  });
  if (!contact) throw new Error("CONTACT_NOT_FOUND");
  const { clinicId, waId } = contact;

  // 1) 收集關聯 id 集合（刪前 snapshot）
  const convs = await prisma.conversation.findMany({ where: { contactId }, select: { id: true } });
  const convIds = convs.map((c) => c.id);
  const msgs = convIds.length
    ? await prisma.message.findMany({
        where: { conversationId: { in: convIds } },
        select: { id: true, waMessageId: true, mediaPath: true },
      })
    : [];
  const messageIds = msgs.map((m) => m.id);
  const wamids = msgs.map((m) => m.waMessageId).filter((w): w is string => !!w);

  // 2) Queue 殘留 job（best effort — 刪唔到唔阻；row 刪咗 job 運行時會自然 skip / fail-soft）
  let queueJobsRemoved = 0;
  for (const id of messageIds) {
    try {
      await outboundQueue.remove(id); // jobId = messageId（enqueueOutboundSend 預設）
      queueJobsRemoved++;
    } catch {
      /* 唔喺 queue（已完成 / 未 enqueue）— 正常 */
    }
  }

  // 3) 媒體檔（transaction 前 — ENOENT 容許；失敗留底入 result，retention sweep 兜底）
  //    目錄解析跟寫入側同一口徑（ensureMediaDir — dev fallback /tmp/wa-media、prod = WA_MEDIA_DIR）：
  //    只睇 mediaDirPreferred() 會喺 dev 搵錯目錄（寫入 fallback 過，刪除側未 fallback）。
  const mediaDir = await ensureMediaDir();
  const mediaDeleteFailed: string[] = [];
  let mediaFilesDeleted = 0;
  let mediaFilesMissing = 0;
  const seen = new Set<string>();
  for (const m of msgs) {
    if (!m.mediaPath || seen.has(m.mediaPath)) continue;
    seen.add(m.mediaPath);
    const base = path.basename(m.mediaPath);
    if (!base || base === "." || base === "..") continue;
    const target = path.join(mediaDir, base);
    try {
      await unlink(target);
      mediaFilesDeleted++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") mediaFilesMissing++;
      else {
        mediaDeleteFailed.push(base);
        log.warn({ file: base, err: err instanceof Error ? err.message : String(err) }, "data-deletion: 刪媒體檔失敗（留底）");
      }
    }
  }

  // 4) DB cascade（一個 transaction — 順序跟 FK 依賴；deleteMany 冪等）
  const del = async <T extends { count: number }>(r: T): Promise<number> => r.count;

  const result = await prisma.$transaction(async (tx) => {
    // wamid 層
    const pending = await tx.pendingStatus.deleteMany({ where: { wamid: { in: wamids } } });
    const webhook = await tx.webhookEvent.deleteMany({ where: { id: { in: wamids } } });
    // message 層
    const notes = await tx.noteReadReceipt.deleteMany({ where: { messageId: { in: messageIds } } });
    const messages = await tx.message.deleteMany({ where: { id: { in: messageIds } } });
    // conversation 關聯（AI / session / task）
    const aiDrafts = await tx.aiDraft.deleteMany({ where: { conversationId: { in: convIds } } });
    const followups = await tx.followupTask.deleteMany({ where: { conversationId: { in: convIds } } });
    const flowSessions = await tx.flowSession.deleteMany({ where: { conversationId: { in: convIds } } });
    const bookingSessions = await tx.bookingSession.deleteMany({ where: { conversationId: { in: convIds } } });
    const painSessions = await tx.painTriageSession.deleteMany({ where: { conversationId: { in: convIds } } });
    const bookingRequests = await tx.bookingRequest.deleteMany({ where: { conversationId: { in: convIds } } });
    const consultSessions = await tx.consultSession.deleteMany({ where: { conversationId: { in: convIds } } });
    const reads = await tx.conversationRead.deleteMany({ where: { conversationId: { in: convIds } } });
    const conversations = await tx.conversation.deleteMany({ where: { id: { in: convIds } } });
    // contact 直屬
    const facts = await tx.patientFact.deleteMany({ where: { contactId } });
    const consents = await tx.contactConsent.deleteMany({ where: { contactId } });
    // StaffNotice：contactId 藏喺 meta Json（無 FK）— 雙路：conversation 關聯 + meta.contactId 精確匹配
    const notices = await tx.staffNotice.deleteMany({
      where: { OR: [{ conversationId: { in: convIds } }, { clinicId, meta: { path: ["contactId"], equals: contactId } }] },
    });
    const contactRow = await tx.contact.delete({ where: { id: contactId } });
    // FlowHoldEvent：PII scrub（row 保留 — workforce 對賬）
    const holds = await tx.flowHoldEvent.updateMany({
      where: { patientPhone: waId },
      data: { patientName: null, patientPhone: null, contactPhone: null },
    });
    // 刪除憑證（metadata-only：零 PII — 唔存 waId 全文）
    const out: DeletePatientDataResult = {
      contactId,
      clinicId,
      conversationsDeleted: await del(conversations),
      messagesDeleted: await del(messages),
      mediaFilesDeleted,
      mediaFilesMissing,
      mediaDeleteFailed,
      aiDraftsDeleted: await del(aiDrafts),
      patientFactsDeleted: await del(facts),
      consentsDeleted: await del(consents),
      noticesDeleted: await del(notices),
      flowSessionsDeleted: await del(flowSessions),
      followupTasksDeleted: await del(followups),
      holdEventsScrubbed: holds.count,
      queueJobsRemoved,
    };
    await tx.auditLog.create({
      data: {
        staffId,
        action: "PATIENT_DATA_DELETED",
        entity: "Contact",
        entityId: contactId,
        meta: {
          clinicId,
          waIdPrefix: waId.slice(0, 3), // 僅前 3 位（地區碼 852）— 唔係完整 PII
          reason: reason ?? null,
          counts: {
            conversations: out.conversationsDeleted,
            messages: out.messagesDeleted,
            mediaFiles: out.mediaFilesDeleted,
            aiDrafts: out.aiDraftsDeleted,
            patientFacts: out.patientFactsDeleted,
            consents: out.consentsDeleted,
            flowSessions: out.flowSessionsDeleted,
            holdEventsScrubbed: out.holdEventsScrubbed,
            pendingStatus: pending.count,
            webhookEvents: webhook.count,
            noteReceipts: notes.count,
            bookingSessions: bookingSessions.count,
            painSessions: painSessions.count,
            bookingRequests: bookingRequests.count,
            consultSessions: consultSessions.count,
            conversationReads: reads.count,
          },
        },
      },
    });
    log.info(
      { contactId, clinicId, messages: out.messagesDeleted, media: out.mediaFilesDeleted, by: staffId },
      "data-deletion: patient PII purged"
    );
    void contactRow;
    return out;
  });

  return result;
}

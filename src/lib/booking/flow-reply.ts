/**
 * nfm_reply 處理（病人撳 Flow Complete → MD §8.3 D9 flow）
 *
 * webhook `messages[].interactive.nfm_reply.response_json`（加密 envelope）→
 * 解密 → { flow_token, providerId, providerName, date, time } →
 * **再對一次 AvailabilitySlot（防 cache 期間被人 book）**：
 * - 過：BookingRequest(PENDING) + FlowSession COMPLETED + socket booking:new（綠色卡）
 * - 唔過（中途被 book / 已有 PENDING 撞同一 slot）：自動覆「該時段啱啱滿咗」+ 重出 Flow
 *
 * 冪等（MD 驗收）：
 * - 同一 flow_token 重複 Complete → 第一次已 COMPLETED → skip（唔重複建卡）
 * - flow 中途棄（冇 Complete）→ 零 BookingRequest（FlowSession 由 48h cron 清 ABANDONED）
 *
 * ★ PII：解密後只係病人選嘅「醫生/日期/時間」（business metadata，非病人個人資料）—
 *   log 只帶 clinic/doctor id/date/time。response_json 原文（加密 blob）永不入 log。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import {
  ensureKeypair,
  unwrapAesKey,
  decryptGcm,
  verifyFlowToken,
  flowJwtSecret,
} from "@/lib/flows/crypto";
import { sendBookingFlow } from "@/lib/flows/send";
import { publishNotify } from "@/lib/notify";
import { outboundQueue } from "@/lib/queue";
import { syncWindow } from "@/lib/apricot/slots";

export interface NfmReplyEnvelope {
  payload: string;
  iv: string;
  key_id?: string;
  wrapped_key: string;
}

export interface NfmReplyInput {
  clinicId: string;
  conversationId: string;
  waId: string;
  responseJson: NfmReplyEnvelope;
}

export type FlowReplyOutcome =
  | { status: "booked"; bookingId: string }
  | { status: "duplicate"; reason: string }
  | { status: "rejected"; reason: string }
  | { status: "send_failed"; reason: string };

interface DecryptedReply {
  flow_token?: string;
  providerId?: string;
  providerName?: string;
  date?: string;
  time?: string;
}

/** 自動覆病人（precheck 失敗）— 簡短、唔含 PII */
export const SLOT_TAKEN_REPLY = "唔好意思，呢個時段啱啱有人預約咗，而家滿咗。請重新揀一個時間 🙏";

/**
 * 主入口（inbound worker 喺 store message 之後 call；errors 唔會 throw 出嚟 —
 * message 已經安全落地，flow 處理係 best-effort + log）。
 */
export async function handleFlowReply(input: NfmReplyInput): Promise<FlowReplyOutcome> {
  const { clinicId, conversationId, waId, responseJson } = input;

  // 1) 解密（RSA-OAEP unwrap → AES-128-GCM）
  let reply: DecryptedReply;
  try {
    const kp = ensureKeypair();
    if (responseJson.key_id && responseJson.key_id !== kp.kid) {
      return { status: "rejected", reason: "unknown_key_id" };
    }
    const key16 = unwrapAesKey(kp.privatePem, responseJson.wrapped_key);
    const plainStr = decryptGcm(key16, responseJson.iv, responseJson.payload);
    reply = JSON.parse(plainStr) as DecryptedReply;
  } catch (e) {
    log.warn({ conversationId, err: e instanceof Error ? e.message : String(e) }, "flow-reply: decrypt failed");
    return { status: "rejected", reason: "decrypt_failed" };
  }

  const { flow_token, providerId, providerName, date, time } = reply;
  if (!flow_token || !providerId || !date || !time) {
    log.warn({ conversationId }, "flow-reply: incomplete payload");
    return { status: "rejected", reason: "incomplete_payload" };
  }

  // 2) token 驗證 + session 狀態
  let secret: string;
  try {
    secret = flowJwtSecret();
  } catch {
    return { status: "rejected", reason: "misconfigured" };
  }
  const tokenPayload = verifyFlowToken(flow_token, secret);
  if (!tokenPayload || tokenPayload.convId !== conversationId || tokenPayload.clinicId !== clinicId) {
    log.warn({ conversationId, clinicId }, "flow-reply: flow_token mismatch（別店/別對話）");
    return { status: "rejected", reason: "token_mismatch" };
  }

  const session = await prisma.flowSession.findUnique({ where: { flowToken: flow_token } });
  if (!session || session.conversationId !== conversationId || session.clinicId !== clinicId) {
    return { status: "rejected", reason: "unknown_session" };
  }
  if (session.status === "COMPLETED") {
    // ★ 冪等：重複 Complete → 第一次已經建咗卡 — 唔重複
    log.info({ conversationId, flowToken: flow_token.slice(0, 12) }, "flow-reply: duplicate complete (idempotent skip)");
    return { status: "duplicate", reason: "already_completed" };
  }
  if (session.status !== "SENT") {
    log.info({ conversationId, sessionStatus: session.status }, "flow-reply: session not SENT — ignore");
    return { status: "rejected", reason: `session_${session.status.toLowerCase()}` };
  }

  // 3) 對話 wa_id 對照（防別號用呢個 conv 嘅 token）
  const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
  const contact = conv ? await prisma.contact.findUnique({ where: { id: conv.contactId } }) : null;
  if (!conv || contact?.waId !== waId) {
    log.warn({ conversationId }, "flow-reply: wa_id mismatch");
    return { status: "rejected", reason: "wa_id_mismatch" };
  }

  // 4) 醫生 belonging + 日期/時間格式
  const provider = await prisma.provider.findFirst({
    where: { apricotId: String(providerId), active: true, clinics: { some: { clinicId } } },
  });
  if (!provider) {
    log.warn({ conversationId, providerId }, "flow-reply: unknown provider for clinic");
    return { status: "rejected", reason: "unknown_provider" };
  }
  const { start, end } = syncWindow();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < start || date > end) {
    return { status: "rejected", reason: "date_out_of_range" };
  }
  if (!/^\d{2}:\d{2}$/.test(time)) {
    return { status: "rejected", reason: "bad_time_format" };
  }

  // 5) ★ precheck transaction（防中途被 book）
  //    FOR UPDATE 鎖 slot row → 兩個病人同時 Complete 同一 slot 會序列化：
  //    第二個 tx 等第一個 commit 之後先醒，再見到 PENDING row → 擋。
  const clinicCode = (await prisma.clinic.findUnique({ where: { id: clinicId } }))?.code ?? "?";
  const now = new Date();
  const txResult: { bookingId?: string; reason?: string } = {};

  try {
    await prisma.$transaction(
      async (tx) => {
        const lock = await tx.$queryRaw`
          SELECT "id" FROM "AvailabilitySlot"
          WHERE "clinicId" = ${clinicId}
            AND "providerApricotId" = ${provider.apricotId}
            AND "date" = ${date}
            AND "startTime" = ${time}
          FOR UPDATE`;
        const slot = (lock as { id: string }[])[0];
        if (!slot) {
          txResult.reason = "slot_missing";
          return;
        }
        const slotRow = await tx.availabilitySlot.findUnique({
          where: { clinicId_providerApricotId_date_startTime: { clinicId, providerApricotId: provider.apricotId!, date, startTime: time } },
        });
        if (!slotRow || !slotRow.isOpen || slotRow.bookedCount > 0) {
          txResult.reason = "slot_taken";
          return;
        }
        const existingPending = await tx.bookingRequest.findFirst({
          where: { clinicId, providerApricotId: provider.apricotId!, requestedDate: date, requestedTime: time, status: "PENDING" },
        });
        if (existingPending) {
          txResult.reason = "pending_exists";
          return;
        }
        const booking = await tx.bookingRequest.create({
          data: {
            conversationId,
            clinicId,
            flowToken: flow_token,
            providerApricotId: provider.apricotId!,
            providerName: String(providerName ?? provider.name),
            requestedDate: date,
            requestedTime: time,
            precheckPassed: true,
            status: "PENDING",
          },
        });
        await tx.flowSession.update({
          where: { id: session.id },
          data: { status: "COMPLETED", completedAt: now },
        });
        txResult.bookingId = booking.id;
      },
      { timeout: 20_000 }
    );
  } catch (e) {
    log.error({ conversationId, clinic: clinicCode, err: e instanceof Error ? e.message : String(e) }, "flow-reply: precheck tx failed");
    return { status: "rejected", reason: "tx_error" };
  }

  if (txResult.reason) {
    // 唔過 → session FAILED + 自動覆 + 重出 Flow
    await prisma.flowSession.update({ where: { id: session.id }, data: { status: "FAILED", completedAt: now } }).catch(() => undefined);
    log.warn(
      { clinic: clinicCode, providerApricotId: provider.apricotId, date, time, reason: txResult.reason },
      "flow-reply: precheck FAILED（slot 中途被 book）→ 自動覆 + 重出 Flow"
    );
    await autoReplyAndResend(conv, txResult.reason);
    return { status: "send_failed", reason: txResult.reason };
  }

  // 6) 過 → 綠色卡 + /bookings 隊列
  const bookingId = txResult.bookingId!;
  publishNotify(clinicId, "booking:new", {
    conversationId,
    clinicId,
    booking: {
      id: bookingId,
      providerName: String(providerName ?? provider.name),
      requestedDate: date,
      requestedTime: time,
      status: "PENDING",
      createdAt: now,
    },
  });
  log.info(
    { clinic: clinicCode, bookingId, providerApricotId: provider.apricotId, date, time },
    "flow-reply: BookingRequest PENDING created（綠色卡）"
  );
  return { status: "booked", bookingId };
}

/** precheck 失敗：覆病人「滿咗」+ 重出 Flow（窗口內 — nfm_reply 剛剛 inbound，窗口必開）
 *  順序：先 text（病人睇到解釋）後 Flow 卡片（撳落去重新揀）。 */
async function autoReplyAndResend(conv: { id: string; clinicId: string }, reason: string): Promise<void> {
  // 1) 自動覆（純 text；系統發出 = sentByStaffId null + aiAutoSent true 慣例）
  try {
    const now = new Date();
    const msg = await prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: "OUT",
        channel: "API",
        type: "text",
        body: SLOT_TAKEN_REPLY,
        status: "QUEUED",
        sentByStaffId: null,
        aiAutoSent: true,
        waTimestamp: now,
      },
    });
    await outboundQueue.add("send", { messageId: msg.id });
    log.info({ conversationId: conv.id, messageId: msg.id }, "flow-reply: auto-reply「滿咗」queued");
  } catch (e) {
    log.error(
      { conversationId: conv.id, err: e instanceof Error ? e.message : String(e) },
      "flow-reply: auto-reply 失敗（log 留底）"
    );
  }
  // 2) 重出 Flow（新 token / 新 FlowSession — 病人重新揀；staffId=null = 系統）
  try {
    await sendBookingFlow({ conversationId: conv.id, staffId: null });
  } catch (e) {
    log.error(
      { conversationId: conv.id, reason, err: e instanceof Error ? e.message : String(e) },
      "flow-reply: 重出 Flow 失敗（staff 可撳 📅 掣手動補）"
    );
  }
}

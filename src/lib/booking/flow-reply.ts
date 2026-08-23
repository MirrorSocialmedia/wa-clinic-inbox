/**
 * nfm_reply 處理（病人撳 Flow Complete → MD §8.3 D9 flow）
 *
 * webhook `messages[].interactive.nfm_reply.response_json`（加密 envelope）→
 * 解密 → 兩種 payload（self-describing，由 payload shape 分變體）：
 * - 正常：{ flow_token, providerId, providerName, date, time }
 *   → **先經 getSlots()（四層降級鏈，唯一空檔路徑）再對一次 AvailabilitySlot（防 cache 期間被人 book）**：
 *   - 過：BookingRequest(PENDING, precheckPassed=true) + FlowSession COMPLETED + socket booking:new（綠色卡）
 *   - 唔過（中途被 book / 已有 PENDING 撞同一 slot）：自動覆「該時段啱啱滿咗」+ 重出 Flow
 * - 純收需求（資料源離線時 Flow 變體）：{ flow_token, providerId, providerName, date, timeOfDay }
 *   → 無 slot 可 precheck → BookingRequest(PENDING, precheckPassed=null, requestedTime=null, timeOfDay)
 *   （卡灰字「未經空檔核對（資料源離線）」— 員工照人手對醫生系統，工作流唔斷）
 * - 正常變體但 getSlots = NONE（源中途離線）：reject source_offline → 自動覆 + 重出 Flow（重出時轉純收需求 canvas）
 *
 * 冪等（MD 驗收）：
 * - 同一 flow_token 重複 Complete → 第一次已 COMPLETED → skip（唔重複建卡）
 * - flow 中途棄（冇 Complete）→ 零 BookingRequest（FlowSession 由 48h cron 清 ABANDONED）
 *
 * ★ PII：解密後只係病人選嘅「醫生/日期/時間/時段偏好」（business metadata，非病人個人資料）—
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
import { syncWindow, getSlots } from "@/lib/availability";

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
  /** 純收需求變體（資料源離線）：MORNING / AFTERNOON / EVENING */
  timeOfDay?: string;
}

const TIME_OF_DAY_VALUES = ["MORNING", "AFTERNOON", "EVENING"] as const;

/** 自動覆病人（precheck 失敗 / 源離線）— 簡短、唔含 PII */
export const SLOT_TAKEN_REPLY = "唔好意思，呢個時段啱啱有人預約咗，而家滿咗。請重新揀一個時間 🙏";
export const SOURCE_OFFLINE_REPLY = "對唔住，預約時段服務暫時離線，暫時只可以收日期同時段偏好。請重新開始預約 🙏";
export const REQUIREMENT_DUP_REPLY = "呢個日期同時段偏好已經收到咗，請職員跟你跟進。多謝你 🙏";

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

  const { flow_token, providerId, providerName, date, time, timeOfDay } = reply;
  // 變體判定（self-describing）：timeOfDay 在 + time 唔喺 = 純收需求變體（資料源離線 Flow）
  const isRequirementVariant = timeOfDay !== undefined && time === undefined;
  if (!flow_token || !providerId || !date || (!isRequirementVariant && !time)) {
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
  if (isRequirementVariant) {
    if (!TIME_OF_DAY_VALUES.includes(timeOfDay as (typeof TIME_OF_DAY_VALUES)[number])) {
      return { status: "rejected", reason: "bad_time_of_day" };
    }
  } else if (!/^\d{2}:\d{2}$/.test(time ?? "")) {
    return { status: "rejected", reason: "bad_time_format" };
  }
  const clinicCode = (await prisma.clinic.findUnique({ where: { id: clinicId } }))?.code ?? "?";

  // 4b) ★ 同一條空檔路徑：getSlots()（四層降級鏈 — 同 flow endpoint / ai.worker 共用，冇第二條路）
  //     正常變體 + NONE（源離線 + 無 L2）→ 冇得 precheck → reject + 重出 Flow（重出時會轉純收需求變體）
  let slotRes;
  try {
    slotRes = await getSlots(clinicId);
  } catch (e) {
    log.error(
      { conversationId, err: e instanceof Error ? e.message : String(e) },
      "flow-reply: getSlots failed"
    );
    return { status: "rejected", reason: "slots_unavailable" };
  }
  if (!isRequirementVariant && slotRes.degraded === "NONE") {
    await failSessionAndResend(
      session.id,
      conv,
      SOURCE_OFFLINE_REPLY,
      { clinic: clinicCode, providerApricotId: provider.apricotId, date, reason: "source_offline" },
      "source_offline"
    );
    return { status: "send_failed", reason: "source_offline" };
  }

  // 5) ★ precheck transaction（防中途被 book）
  //    正常變體：FOR UPDATE 鎖 slot row → 兩個病人同時 Complete 同一 slot 會序列化：
  //    第二個 tx 等第一個 commit 之後先醒，再見到 PENDING row → 擋。
  //    純收需求變體：無 slot 可鎖（冇 time）— 只擋同 (醫生,日期,時段偏好) 嘅 PENDING 重複提交。
  const now = new Date();
  const txResult: { bookingId?: string; reason?: string } = {};

  try {
    await prisma.$transaction(
      async (tx) => {
        if (!isRequirementVariant) {
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
            where: { clinicId_providerApricotId_date_startTime: { clinicId, providerApricotId: provider.apricotId!, date, startTime: time! } },
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
        } else {
          const existingPending = await tx.bookingRequest.findFirst({
            where: { clinicId, providerApricotId: provider.apricotId!, requestedDate: date, timeOfDay: String(timeOfDay), status: "PENDING" },
          });
          if (existingPending) {
            txResult.reason = "pending_exists";
            return;
          }
        }

        const booking = await tx.bookingRequest.create({
          data: {
            conversationId,
            clinicId,
            flowToken: flow_token,
            providerApricotId: provider.apricotId!,
            providerName: String(providerName ?? provider.name),
            requestedDate: date,
            requestedTime: isRequirementVariant ? null : time,
            timeOfDay: isRequirementVariant ? String(timeOfDay) : null,
            // 純收需求變體 = null（未經空檔核對 — 資料源離線；員工照人手對醫生系統）
            precheckPassed: isRequirementVariant ? null : true,
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
    const failReply = txResult.reason === "pending_exists" && isRequirementVariant ? REQUIREMENT_DUP_REPLY : SLOT_TAKEN_REPLY;
    await failSessionAndResend(
      session.id,
      conv,
      failReply,
      { clinic: clinicCode, providerApricotId: provider.apricotId, date, time: isRequirementVariant ? null : time, timeOfDay: isRequirementVariant ? String(timeOfDay) : null, reason: txResult.reason },
      txResult.reason
    );
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
      requestedTime: isRequirementVariant ? null : time,
      timeOfDay: isRequirementVariant ? String(timeOfDay) : null,
      precheckPassed: isRequirementVariant ? null : true,
      status: "PENDING",
      createdAt: now,
    },
  });
  log.info(
    { clinic: clinicCode, bookingId, providerApricotId: provider.apricotId, date, time: isRequirementVariant ? null : time, timeOfDay: isRequirementVariant ? String(timeOfDay) : null },
    isRequirementVariant
      ? "flow-reply: BookingRequest PENDING created（純收需求變體 — 未經空檔核對）"
      : "flow-reply: BookingRequest PENDING created（綠色卡）"
  );
  return { status: "booked", bookingId };
}

/** precheck 失敗：覆病人「滿咗」+ 重出 Flow（窗口內 — nfm_reply 剛剛 inbound，窗口必開）
 *  順序：先 text（病人睇到解釋）後 Flow 卡片（撳落去重新揀）。 */
async function autoReplyAndResend(conv: { id: string; clinicId: string }, reason: string, replyText: string = SLOT_TAKEN_REPLY): Promise<void> {
  // 1) 自動覆（純 text；系統發出 = sentByStaffId null + aiAutoSent true 慣例）
  try {
    const now = new Date();
    const msg = await prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: "OUT",
        channel: "API",
        type: "text",
        body: replyText,
        status: "QUEUED",
        sentByStaffId: null,
        aiAutoSent: true,
        waTimestamp: now,
      },
    });
    await outboundQueue.add("send", { messageId: msg.id });
    log.info({ conversationId: conv.id, messageId: msg.id, reason }, "flow-reply: auto-reply queued");
  } catch (e) {
    log.error(
      { conversationId: conv.id, err: e instanceof Error ? e.message : String(e) },
      "flow-reply: auto-reply 失敗（log 留底）"
    );
  }
  // 2) 重出 Flow（新 token / 新 FlowSession — 病人重新揀；staffId=null = 系統；
  //    重出時 flow endpoint 會照時下 degraded 狀態決定再出正常 canvas 定純收需求變體）
  try {
    await sendBookingFlow({ conversationId: conv.id, staffId: null });
  } catch (e) {
    log.error(
      { conversationId: conv.id, reason, err: e instanceof Error ? e.message : String(e) },
      "flow-reply: 重出 Flow 失敗（staff 可撳 📅 掣手動補）"
    );
  }
}

/** precheck 失敗統一出口：session FAILED + 自動覆 + 重出 Flow（meta 只准 metadata — 零病人選擇原文） */
async function failSessionAndResend(
  sessionId: string,
  conv: { id: string; clinicId: string },
  replyText: string,
  meta: Record<string, unknown>,
  reason: string,
): Promise<void> {
  await prisma.flowSession.update({ where: { id: sessionId }, data: { status: "FAILED", completedAt: new Date() } }).catch(() => undefined);
  log.warn({ ...meta }, `flow-reply: ${reason} → 自動覆 + 重出 Flow`);
  await autoReplyAndResend(conv, reason, replyText);
}

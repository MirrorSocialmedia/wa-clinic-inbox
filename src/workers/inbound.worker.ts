import { Worker, type Job } from "bullmq";
import { inboundQueue, aiQueue, getRedis, QUEUE_PREFIX } from "@/lib/queue";
import { publishNotify } from "@/lib/notify";
import { downloadWaMedia } from "@/lib/wa/media";
import prisma from "@/lib/prisma";
import log, { redactDeep } from "@/lib/log";
import type {
  Clinic,
  Contact,
  Conversation,
  Message,
} from "@prisma/client";

/**
 * inbound worker — webhook event 解析（框架 MD §6.2 逐條填實）
 *
 * - 分流：entry[].changes[].value.metadata.phone_number_id → Clinic.waPhoneNumberId
 *   找不到店 → log warn + skip（fail-closed：唔會創 orphan 資料）
 * - 冪等：WebhookEvent upsert（id = field 前綴 + wamid），處理過 skip
 *   （Meta 會重發；history 例外 — 量大，靠 Message.waMessageId unique +
 *    createMany skipDuplicates 去重，唔逐條寫 WebhookEvent）
 * - messages[]      病人 inbound → Contact/Conversation upsert → Message(IN,API)
 *                   → unreadCount++ + lastInboundAt → Socket 推 message:new
 * - smb_message_echoes 店員手機 App 回音 → Message(OUT,APP_ECHO) → Socket 推
 * - history         舊 chat 匯入 → Message(HISTORY)，歷史 waTimestamp，
 *                   唔觸發 unread / 唔觸發 AI，batch insert + 容忍亂序
 * - statuses[]      → Message.status（SENT/DELIVERED/READ/FAILED + errorCode）→ Socket 推
 * - 媒體            → getMediaInfo + 下載（mock 跳過）
 * - 未知 field      → 記 log（metadata only）+ 唔崩
 *
 * ★ PII 鐵律：log 只准 metadata（wamid/type/clinic/status/bytes），
 *   訊息原文永不入 log。任何要 log payload 嘅位置一律先過 redactDeep。
 */

// ── 型別（webhook payload，只定義要讀嘅路徑） ─────────────────────────────

interface WaTimestampedMessage {
  from?: string;
  to?: string;
  id?: string;
  timestamp?: string; // unix seconds
  type?: string;
  text?: { body?: string };
  image?: { id?: string; media_id?: string; caption?: string };
  video?: { id?: string; media_id?: string; caption?: string };
  audio?: { id?: string; media_id?: string };
  document?: { id?: string; media_id?: string; caption?: string };
  sticker?: { id?: string; media_id?: string };
  interactive?: {
    type?: string;
    nfm_reply?: { response_json?: string | { payload?: string; iv?: string; key_id?: string; wrapped_key?: string } };
  };
  location?: { latitude?: string; longitude?: string };
  contact?: { vcard?: string };
}

interface WaChange {
  field?: string;
  value?: {
    messaging_product?: string;
    metadata?: { phone_number_id?: string; display_phone_number?: string };
    messages?: WaTimestampedMessage[];
    smb_message_echoes?: { conversation?: { id?: string }; message?: WaTimestampedMessage }[];
    history?: {
      spans?: { span?: string; is_end_of_history?: boolean; messages?: WaTimestampedMessage[] }[];
      is_end_of_history?: boolean;
    };
    statuses?: {
      id?: string;
      destination_jid?: string;
      status?: string;
      timestamp?: string;
      error_code?: number;
      errors?: { code?: number; message?: string }[];
    }[];
    contacts?: { wa_id?: string; profile?: { name?: string } }[];
  };
}

interface WaPayload {
  object?: string;
  entry?: { id?: string; changes?: WaChange[] }[];
}

const MEDIA_TYPES = new Set(["image", "video", "audio", "document"]);

const STATUS_MAP: Record<string, Message["status"]> = {
  sent: "SENT",
  delivered: "DELIVERED",
  read: "READ",
  failed: "FAILED",
};

// ── helpers ──────────────────────────────────────────────────────────────

function tsToDate(ts?: string): Date {
  const n = Number(ts);
  if (!ts || !Number.isFinite(n)) return new Date();
  return new Date(n * 1000);
}

/**
 * 冪等 claim：create WebhookEvent，unique violation = 已處理過 → false。
 * 冪等窗口內（兩個相同 event 同時到）最壞情況 = 兩邊都 create 成功 →
 * 第二個撞 P2002 → skip。
 */
async function claimEvent(id: string, field: string): Promise<boolean> {
  try {
    await prisma.webhookEvent.create({ data: { id, field } });
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return false;
    throw err;
  }
}

function profileNameOf(value: WaChange["value"], waId: string): string | null {
  const c = value?.contacts?.find((x) => x.wa_id === waId);
  return c?.profile?.name?.trim() || null;
}

async function upsertContact(
  clinicId: string,
  waId: string,
  profileName: string | null
): Promise<Contact> {
  return prisma.contact.upsert({
    where: { clinicId_waId: { clinicId, waId } },
    update: profileName ? { profileName } : {},
    create: { clinicId, waId, profileName: profileName ?? null, labels: [] },
  });
}

async function findOrCreateConversation(
  clinicId: string,
  contactId: string,
  fallbackLastMessageAt: Date
): Promise<Conversation> {
  return prisma.conversation.upsert({
    where: { clinicId_contactId: { clinicId, contactId } },
    update: {},
    create: { clinicId, contactId, lastMessageAt: fallbackLastMessageAt },
  });
}

function messageBody(m: WaTimestampedMessage): string | null {
  if (m.text?.body) return m.text.body;
  if (m.image?.caption) return m.image.caption;
  if (m.video?.caption) return m.video.caption;
  if (m.document?.caption) return m.document.caption;
  if (m.location) return `[Location] ${m.location.latitude},${m.location.longitude}`;
  if (m.contact?.vcard) return null; // vcard = PII，唔存 body（mediaPath 亦唔存）
  return null;
}

function mediaIdOf(m: WaTimestampedMessage): string | undefined {
  if (m.type && MEDIA_TYPES.has(m.type)) {
    return (m as unknown as Record<string, { media_id?: string } | undefined>)[m.type]?.media_id;
  }
  return undefined;
}

function msgTypeOf(m: WaTimestampedMessage): string {
  return m.type ?? "unknown";
}

/** 公共 message payload（socket 推 + API 回傳共用 shape；body 係 chat 內容，屬正常業務數據） */
function publicMessage(msg: Message) {
  return {
    id: msg.id,
    conversationId: msg.conversationId,
    waMessageId: msg.waMessageId,
    direction: msg.direction,
    channel: msg.channel,
    type: msg.type,
    body: msg.body,
    mediaPath: msg.mediaPath,
    status: msg.status,
    errorCode: msg.errorCode,
    sentByStaffId: msg.sentByStaffId,
    waTimestamp: msg.waTimestamp,
    createdAt: msg.createdAt,
  };
}

/** 原子更新對話時間戳 + unread（raw SQL：GREATEST 容忍亂序 + increment 原子） */
async function touchConversation(
  convId: string,
  ts: Date,
  opts: { incrementUnread: boolean; touchInbound: boolean }
): Promise<Conversation | null> {
  const inc = opts.incrementUnread ? 1 : 0;
  const rows = opts.touchInbound
    ? await prisma.$queryRaw<Conversation[]>`
        UPDATE "Conversation"
        SET "lastMessageAt" = GREATEST("lastMessageAt", ${ts}),
            "lastInboundAt" = GREATEST(COALESCE("lastInboundAt", ${ts}), ${ts}),
            "unreadCount" = "unreadCount" + ${inc}
        WHERE "id" = ${convId}
        RETURNING *`
    : await prisma.$queryRaw<Conversation[]>`
        UPDATE "Conversation"
        SET "lastMessageAt" = GREATEST("lastMessageAt", ${ts}),
            "unreadCount" = "unreadCount" + ${inc}
        WHERE "id" = ${convId}
        RETURNING *`;
  return (rows[0] as unknown as Conversation) ?? null;
}

async function notifyNewMessage(clinicId: string, conv: Conversation, msg: Message) {
  const contact = await prisma.contact.findUnique({ where: { id: conv.contactId } });
  publishNotify(clinicId, "message:new", {
    conversationId: conv.id,
    clinicId,
    contact: contact
      ? { id: contact.id, waId: contact.waId, profileName: contact.profileName, labels: contact.labels }
      : null,
    message: publicMessage(msg),
    conversation: {
      status: conv.status,
      unreadCount: conv.unreadCount,
      lastMessageAt: conv.lastMessageAt,
      lastInboundAt: conv.lastInboundAt,
    },
  });
}

// ── 各 field 處理 ────────────────────────────────────────────────────────

async function handleMessages(clinic: Clinic, value: NonNullable<WaChange["value"]>): Promise<void> {
  for (const m of value.messages ?? []) {
    if (!m?.id) continue;
    const wamid = m.id;
    const claimed = await claimEvent(`messages:${wamid}`, "messages");
    if (!claimed) {
      log.debug({ wamid }, "inbound: message already processed (idempotent skip)");
      continue;
    }

    const waId = m.from;
    if (!waId) {
      log.warn({ wamid }, "inbound: message missing from, skipped");
      continue;
    }
    const waTs = tsToDate(m.timestamp);

    const contact = await upsertContact(clinic.id, waId, profileNameOf(value, waId));
    const conv = await findOrCreateConversation(clinic.id, contact.id, waTs);

    let mediaPath: string | null = null;
    const mid = mediaIdOf(m);
    if (mid) {
      mediaPath = (await downloadWaMedia({ mediaId: mid, wamid })).mediaPath;
    }

    const msg = await prisma.message.create({
      data: {
        conversationId: conv.id,
        waMessageId: wamid,
        direction: "IN",
        channel: "API",
        type: msgTypeOf(m),
        body: messageBody(m),
        mediaPath,
        status: "RECEIVED",
        waTimestamp: waTs,
      },
    });

    const updated = await touchConversation(conv.id, waTs, {
      incrementUnread: true,
      touchInbound: true,
    });
    if (updated) {
      await notifyNewMessage(clinic.id, updated, msg);
    }

    log.info(
      { clinic: clinic.code, wamid, type: msgTypeOf(m), hasMedia: Boolean(mid), unread: updated?.unreadCount },
      "inbound: message processed"
    );

    // Phase 3：nfm_reply（病人撳 Flow Complete）→ 預約 precheck + BookingRequest。
    // ★ 不觸發 AI triage（flow 回覆唔係自然語言；避免誤分類）。
    const nfmReply = m.interactive?.type === "nfm_reply" ? m.interactive.nfm_reply : undefined;
    if (nfmReply?.response_json) {
      try {
        const raw = nfmReply.response_json;
        const envelope =
          typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : (raw as Record<string, unknown>);
        const { handleFlowReply } = await import("@/lib/booking/flow-reply");
        const outcome = await handleFlowReply({
          clinicId: clinic.id,
          conversationId: conv.id,
          waId,
          responseJson: {
            payload: String(envelope.payload ?? ""),
            iv: String(envelope.iv ?? ""),
            key_id: envelope.key_id ? String(envelope.key_id) : undefined,
            wrapped_key: String(envelope.wrapped_key ?? ""),
          },
        });
        log.info(
          { clinic: clinic.code, wamid, outcome: outcome.status, reason: (outcome as { reason?: string }).reason },
          "inbound: nfm_reply handled"
        );
      } catch (err) {
        // message 已安全落地；flow 處理失敗只係 log（staff 可手動跟進）
        log.error(
          { clinic: clinic.code, wamid, err: err instanceof Error ? err.message : String(err) },
          "inbound: nfm_reply handle failed（訊息已入庫）"
        );
      }
      continue; // nfm_reply 唔入 AI triage
    }

    // Phase 2：觸發 AI triage（只 IN+API；HISTORY/APP_ECHO 唔觸發 — 見 handleHistory/handleEchoes）。
    // jobId = ai-<messageId>：inbound job retry 重跑同一條 message 唔會重複 enqueue（BullMQ 冪等）。
    // ★ BullMQ 唔准 jobId 含 ":"（Redis key namespace）— 用 "-" 做前綴分隔。
    // enqueue 失敗唔準影響 inbound pipeline（訊息已入 DB + UI 已收到；AI 只係降級）。
    try {
      await aiQueue.add(
        "classify",
        { conversationId: conv.id, messageId: msg.id, clinicId: clinic.id },
        { jobId: `ai-${msg.id}` }
      );
    } catch (err) {
      log.warn(
        { clinic: clinic.code, wamid, err: err instanceof Error ? err.message : String(err) },
        "inbound: ai enqueue failed (message 已入庫，AI 降級)"
      );
    }
  }
}

async function handleEchoes(clinic: Clinic, value: NonNullable<WaChange["value"]>): Promise<void> {
  const bizNumber = (clinic.waDisplayNumber ?? "").replace(/\D/g, "");
  for (const e of value.smb_message_echoes ?? []) {
    const m = e?.message;
    if (!m?.id) continue;
    const wamid = m.id;
    const claimed = await claimEvent(`echo:${wamid}`, "smb_message_echoes");
    if (!claimed) continue;

    // 收件人 = message 入面唔係自己店號碼嘅邊個（echo 係店員手機 App 發出去嘅）
    const recipient =
      (m.to && m.to !== bizNumber ? m.to : undefined) ??
      (m.from && m.from !== bizNumber ? m.from : undefined);
    if (!recipient) {
      log.warn({ wamid, clinic: clinic.code }, "echo: cannot resolve recipient, skipped");
      continue;
    }
    const waTs = tsToDate(m.timestamp);
    const contact = await upsertContact(clinic.id, recipient, null);
    const conv = await findOrCreateConversation(clinic.id, contact.id, waTs);

    let mediaPath: string | null = null;
    const mid = mediaIdOf(m);
    if (mid) mediaPath = (await downloadWaMedia({ mediaId: mid, wamid })).mediaPath;

    const msg = await prisma.message.create({
      data: {
        conversationId: conv.id,
        waMessageId: wamid,
        direction: "OUT",
        channel: "APP_ECHO",
        type: msgTypeOf(m),
        body: messageBody(m),
        mediaPath,
        status: "SENT",
        waTimestamp: waTs,
      },
    });

    const updated = await touchConversation(conv.id, waTs, {
      incrementUnread: false,
      touchInbound: false,
    });
    if (updated) await notifyNewMessage(clinic.id, updated, msg);

    log.info({ clinic: clinic.code, wamid, type: msgTypeOf(m) }, "inbound: echo processed");
  }
}

async function handleHistory(clinic: Clinic, value: NonNullable<WaChange["value"]>): Promise<void> {
  const spans = value.history?.spans ?? [];
  const messages = spans.flatMap((s) => s.messages ?? []);
  const endOfHistory = value.history?.is_end_of_history ?? false;
  if (messages.length === 0) {
    if (endOfHistory) log.info({ clinic: clinic.code }, "history: import complete (empty tail)");
    return;
  }

  const bizNumber = (clinic.waDisplayNumber ?? "").replace(/\D/g, "");

  // ★ 歷史匯入 = 一個病人嘅舊 chat：所有訊息（兩個方向）都歸入同一病人嘅 conversation。
  //   病人身份由 value.contacts[] 認定（Meta history payload 嘅 contacts = 病人）；
  //   fallback：messages 入面唯一非商家號嘅 waId。唔可以按 m.from 拆 conversation
  //   （咁會將店員回覆拆去「商家號 contact」嘅對話，唔係產品行為）。
  const profileNames = new Map<string, string>();
  for (const c of value.contacts ?? []) {
    if (c.wa_id && c.profile?.name) profileNames.set(c.wa_id, c.profile.name);
  }
  const fromContacts = (value.contacts ?? []).map((c) => c.wa_id).find(Boolean);
  const allFroms = [...new Set(messages.map((m) => m.from).filter((x): x is string => Boolean(x)))];
  const nonBiz = allFroms.filter((w) => w !== bizNumber);
  const patientWaId =
    fromContacts && allFroms.includes(fromContacts)
      ? fromContacts
      : nonBiz.length === 1
        ? nonBiz[0]
        : undefined;
  if (!patientWaId) {
    log.warn(
      { clinic: clinic.code, fromCount: allFroms.length, endOfHistory },
      "history: cannot determine patient waId, import skipped"
    );
    return;
  }

  // 1) 病人 contact + conversation（唔會為商家號建 Contact）
  const contact = await upsertContact(clinic.id, patientWaId, profileNames.get(patientWaId) ?? null);
  const conv = await findOrCreateConversation(clinic.id, contact.id, new Date(0));

  // 2) messages：全部歸病人 conversation；wamid unique = 冪等；容忍亂序
  const rows = messages
    .filter((m) => m.id)
    .map((m) => {
      const isOut = (m.from ?? "") === bizNumber;
      const waTs = tsToDate(m.timestamp);
      return {
        conversationId: conv.id,
        waMessageId: m.id!,
        direction: (isOut ? "OUT" : "IN") as "IN" | "OUT",
        channel: "HISTORY" as const,
        type: msgTypeOf(m),
        body: messageBody(m),
        mediaPath: null, // 歷史媒體唔下載（一次性匯入；MD 只要求記錄搵得返）
        status: isOut ? ("SENT" as const) : ("RECEIVED" as const),
        waTimestamp: waTs,
      };
    });

  // 分批 500 條（幾萬條級別）
  for (let i = 0; i < rows.length; i += 500) {
    await prisma.message.createMany({
      skipDuplicates: true,
      data: rows.slice(i, i + 500),
    });
  }

  // 3) 對話時間戳修正：GREATEST（容忍亂序；唔會蓋過之後新到嘅實時數據）
  const maxTs = rows.reduce((a, r) => (r.waTimestamp > a ? r.waTimestamp : a), new Date(0));
  const maxInboundTs = rows
    .filter((r) => r.direction === "IN")
    .reduce<Date | null>((a, r) => (a === null || r.waTimestamp > a ? r.waTimestamp : a), null);
  if (!maxInboundTs) {
    // 全部係 OUT（店員發嘅）— 只更新 lastMessageAt
    await prisma.$executeRaw`
      UPDATE "Conversation" SET "lastMessageAt" = GREATEST("lastMessageAt", ${maxTs}) WHERE "id" = ${conv.id}`;
  } else {
    await prisma.$executeRaw`
      UPDATE "Conversation"
      SET "lastMessageAt" = GREATEST("lastMessageAt", ${maxTs}),
          "lastInboundAt" = GREATEST(COALESCE("lastInboundAt", ${maxInboundTs}))
      WHERE "id" = ${conv.id}`;
  }

  // ★ 唔觸發 unread（完全唔郁 unreadCount）
  // ★ 唔觸發 AI（history 唔入 aiQueue）
  const masked = patientWaId.length > 3 ? `${patientWaId.slice(0, 3)}***` : "***";
  log.info(
    { clinic: clinic.code, patient: masked, count: rows.length, endOfHistory },
    "history: batch imported (no unread, no AI)"
  );
}

async function handleStatuses(clinic: Clinic, value: NonNullable<WaChange["value"]>): Promise<void> {
  for (const s of value.statuses ?? []) {
    if (!s?.id || !s.status) continue;
    const target = STATUS_MAP[s.status];
    if (!target) {
      log.info({ wamid: s.id, status: s.status }, "inbound: unknown status ignored");
      continue;
    }
    const wamid = s.id;
    const claimed = await claimEvent(`status:${wamid}:${s.status}`, "statuses");
    if (!claimed) continue;

    const msg = await prisma.message.findUnique({ where: { waMessageId: wamid } });
    if (!msg) {
      log.warn({ wamid, status: s.status }, "inbound: status for unknown message, skipped");
      continue;
    }

    const errorCode =
      target === "FAILED"
        ? String(s.error_code ?? s.errors?.[0]?.code ?? "") || null
        : null;

    await prisma.message.update({
      where: { id: msg.id },
      data: { status: target, errorCode },
    });
    const conv = await prisma.conversation.findUnique({ where: { id: msg.conversationId } });
    if (conv) {
      publishNotify(clinic.id, "message:status", {
        conversationId: conv.id,
        clinicId: clinic.id,
        waMessageId: wamid,
        status: target,
        errorCode,
      });
    }
    log.info(
      { clinic: clinic.code, wamid, status: target, errorCode },
      "inbound: status updated"
    );
  }
}

// ── 主入口 ───────────────────────────────────────────────────────────────

async function processInboundEvent(payload: unknown): Promise<void> {
  const p = payload as WaPayload;
  if (!p || !Array.isArray(p.entry)) {
    log.warn({ payloadKeys: Object.keys((p as object) ?? {}) }, "inbound: unexpected payload shape, skipped");
    return;
  }

  for (const entry of p.entry) {
    for (const change of entry?.changes ?? []) {
      const field = change?.field ?? "unknown";
      const value = change?.value;
      const phoneNumberId = value?.metadata?.phone_number_id ?? entry?.id;

      // 分流：phone_number_id → clinic（fail-closed：唔識嘅號 = skip + log）
      const clinic = phoneNumberId
        ? await prisma.clinic.findUnique({ where: { waPhoneNumberId: String(phoneNumberId) } })
        : null;
      if (!clinic) {
        log.warn(
          { phoneNumberId: String(phoneNumberId ?? ""), field },
          "inbound: unknown phone_number_id, skipped (no clinic mapped)"
        );
        continue;
      }

      // Phase 4：webhook 最後事件時間（5 分鐘健康自檢 stale 判斷用）—
      // 任何 field 嘅事件都算 traffic。寫失敗唔阻主 pipeline（fire-and-forget）。
      prisma.clinic
        .update({ where: { id: clinic.id }, data: { lastWebhookEventAt: new Date() } })
        .catch((e) => log.warn({ clinic: clinic.code, err: e instanceof Error ? e.message : String(e) }, "inbound: lastWebhookEventAt update failed (ignored)"));

      try {
        if (value?.messages?.length) await handleMessages(clinic, value);
        else if (value?.smb_message_echoes?.length) await handleEchoes(clinic, value);
        else if (value?.history) await handleHistory(clinic, value);
        else if (value?.statuses?.length) await handleStatuses(clinic, value);
        else {
          // 未知/未處理 field（e.g. account_update / smb_app_state_sync /
          // message_template_status_update）→ 記 log（metadata only）+ 唔崩
          log.info(
            { clinic: clinic.code, field, hasValue: Boolean(value), redacted: redactDeep(value) },
            "inbound: unhandled field (logged metadata only)"
          );
        }
      } catch (err) {
        // 單個 change 失敗唔應該崩掉成個 event（其他 change 照處理）；
        // throw 上嚟會令 job retry（BullMQ attempts 3）— 冪等層保證重試唔會重複。
        log.error(
          { clinic: clinic.code, field, err: err instanceof Error ? err.message : String(err) },
          "inbound: change processing failed"
        );
        throw err;
      }
    }
  }
}

export function startInboundWorker(): Worker {
  const worker = new Worker(
    inboundQueue.name,
    async (job: Job) => {
      const data = (job.data ?? {}) as Record<string, unknown>;
      await processInboundEvent(data);
      return { ok: true, jobId: job.id };
    },
    { connection: getRedis(), prefix: QUEUE_PREFIX, concurrency: 5 }
  );

  worker.on("completed", (job) => {
    log.info({ jobId: job.id }, "inbound job completed");
  });
  worker.on("failed", (job, err) => {
    log.error({ jobId: job?.id, err: err.message }, "inbound job failed");
  });
  worker.on("error", (err) => {
    log.error(
      { queue: inboundQueue.name, err: err.message },
      "inbound worker error — exiting for PM2 restart"
    );
    process.exit(1);
  });

  return worker;
}

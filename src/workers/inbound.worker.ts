import { Worker, type Job } from "bullmq";
import { inboundQueue, aiQueue, getRedis, QUEUE_PREFIX } from "@/lib/queue";
import { publishNotify } from "@/lib/notify";
import { downloadWaMedia } from "@/lib/wa/media";
import prisma from "@/lib/prisma";
import log, { redactDeep } from "@/lib/log";
import { notifyAlert } from "@/lib/health/notify";
import { Prisma, type Clinic, type Contact, type Conversation, type Message } from "@prisma/client";

/** 冪等寫入用嘅 DB client（top-level prisma 或 $transaction 嘅 tx — 同一套 model API）。 */
type Db = Prisma.TransactionClient;

/**
 * inbound worker — webhook event 解析（框架 MD §6.2 逐條填實）
 *
 * - 分流：entry[].changes[].value.metadata.phone_number_id → Clinic.waPhoneNumberId
 *   找不到店 → log warn + skip（fail-closed：唔會創 orphan 資料）
 * - 冪等：WebhookEvent create（id = field 前綴 + wamid）+ 業務寫入同一個 $transaction
 *   （★ P0-1 修復：舊 code claim 同 message.create 分離 — claim 成功但 create 前 crash，
 *    retry 時 claim P2002 → skip → 病人訊息永久消失。而家原子：要嘛全有要嘛全冇；
 *    P2002 時再核 Message 存在先算「真處理過」— 冇 Message = claim 孤兒（舊 code crash /
 *    升級前殘留）→ 重跑補回，唔丟。media 下載係外部 HTTP 永遠唔入 transaction —
 *    先落 Message(mediaPath=null)，下載完先 UPDATE；下載失敗只係冇附件，唔係訊息消失。
 *    history 例外 — 量大，靠 Message.waMessageId unique +
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
 * 冪等 claim（★ 只准喺 $transaction 內用 — 要同業務寫入原子）：
 * create WebhookEvent（連 processedAt — 舊 code 從未寫過呢欄，而家 claim=完成同落）。true = 新攞到；
 * false = 已存在（P2002，可能真處理過，亦可能係 claim 孤兒 — 由 caller 核 Message 決定）。
 * 非 P2002 錯誤 throw 上嚟（令 transaction 回滾 + job retry）。
 *
 * ★ Postgres 語義：任何一條失敗嘅 statement 會毒斃成個 transaction（25P02 —
 *   "current transaction is aborted, commands ignored until end of transaction block"）。
 *   所以 claim create 要包喺 SAVEPOINT 入面：P2002 → ROLLBACK TO SAVEPOINT 解毒，
 *   caller 先可以喺同一 transaction 內安全核 Message。（冇 savepoint 嘅話 P2002 之後
 *   所有 follow-up query 都 25P02 → 成個 tx 回滾 → job retry 永遠失敗 → 訊息永久丟 —
 *   即係 P0-1 原本嘅 bug 換咗件衣服返嚟。T40 e2e 就係照住呢個坑。）
 */
async function claimInTx(db: Db, id: string, field: string): Promise<boolean> {
  await db.$executeRawUnsafe("SAVEPOINT wa_claim");
  try {
    await db.webhookEvent.create({ data: { id, field, processedAt: new Date() } });
    await db.$executeRawUnsafe("RELEASE SAVEPOINT wa_claim");
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) {
      await db.$executeRawUnsafe("ROLLBACK TO SAVEPOINT wa_claim");
      await db.$executeRawUnsafe("RELEASE SAVEPOINT wa_claim");
      return false;
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2002";
}

function profileNameOf(value: WaChange["value"], waId: string): string | null {
  const c = value?.contacts?.find((x) => x.wa_id === waId);
  return c?.profile?.name?.trim() || null;
}

async function upsertContact(
  db: Db,
  clinicId: string,
  waId: string,
  profileName: string | null
): Promise<Contact> {
  return db.contact.upsert({
    where: { clinicId_waId: { clinicId, waId } },
    update: profileName ? { profileName } : {},
    create: { clinicId, waId, profileName: profileName ?? null, labels: [] },
  });
}

async function findOrCreateConversation(
  db: Db,
  clinicId: string,
  contactId: string,
  fallbackLastMessageAt: Date
): Promise<Conversation> {
  return db.conversation.upsert({
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
  db: Db,
  convId: string,
  ts: Date,
  opts: { incrementUnread: boolean; touchInbound: boolean }
): Promise<Conversation | null> {
  const inc = opts.incrementUnread ? 1 : 0;
  const rows = opts.touchInbound
    ? await db.$queryRaw<Conversation[]>`
        UPDATE "Conversation"
        SET "lastMessageAt" = GREATEST("lastMessageAt", ${ts}),
            "lastInboundAt" = GREATEST(COALESCE("lastInboundAt", ${ts}), ${ts}),
            "unreadCount" = "unreadCount" + ${inc}
        WHERE "id" = ${convId}
        RETURNING *`
    : await db.$queryRaw<Conversation[]>`
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

    const waId = m.from;
    if (!waId) {
      // 無 from 嘅 malformed event：唔 claim（claim 咗都冇法處理，只係多一條無用 WebhookEvent），
      // 每次重發都會喺呢度 warn（metadata only）— 唔影響冪等。
      log.warn({ wamid }, "inbound: message missing from, skipped");
      continue;
    }
    const waTs = tsToDate(m.timestamp);
    const profileName = profileNameOf(value, waId);

    // ★ P0-1：claim + 業務寫入同一個 $transaction（原子：要嘛全有要嘛全冇）。
    //   舊 code claim 成功但 message.create 前 crash → retry claim P2002 → 靜默 skip → 訊息永久丟。
    //   而家 P2002 時核 Message：
    //     • Message 存在 → 真處理過 → skip（冪等，同舊行為）
    //     • 無 Message → claim 孤兒（舊 code crash / 升級前殘留）→ 重跑補回，唔丟
    //   media 下載（外部 HTTP）永遠唔入 transaction — 見下方。
    const result = await prisma.$transaction(async (tx) => {
      const claimed = await claimInTx(tx, `messages:${wamid}`, "messages");
      if (!claimed) {
        const existing = await tx.message.findUnique({ where: { waMessageId: wamid } });
        if (existing) return { skipped: true as const };
        log.info({ wamid }, "inbound: claim orphan detected (claim 存在但無 Message) — 重跑補回");
        // fall through → 照處理落去（孤兒恢復）
      }

      const contact = await upsertContact(tx, clinic.id, waId, profileName);
      const conv = await findOrCreateConversation(tx, clinic.id, contact.id, waTs);
      let msg: Message;
      try {
        msg = await tx.message.create({
          data: {
            conversationId: conv.id,
            waMessageId: wamid,
            direction: "IN",
            channel: "API",
            type: msgTypeOf(m),
            body: messageBody(m),
            mediaPath: null, // ★ 媒體下載喺 transaction 外 — 下載完先 UPDATE
            status: "RECEIVED",
            waTimestamp: waTs,
          },
        });
      } catch (err) {
        // 併發 race：另一個相同 event 嘅 transaction 先 commit 咗 → 當真處理過 skip（本 tx 全部回滾）
        if (isUniqueViolation(err)) return { skipped: true as const };
        throw err;
      }
      const convUpdated = await touchConversation(tx, conv.id, waTs, {
        incrementUnread: true,
        touchInbound: true,
      });
      return { skipped: false as const, msg, conv, convUpdated };
    });

    if (result.skipped) {
      log.debug({ wamid }, "inbound: message already processed (idempotent skip)");
      continue;
    }

    // ★ media 下載（外部 HTTP）喺 transaction 外 — 失敗/超時只係冇附件，唔應該令訊息消失或阻塞。
    const mid = mediaIdOf(m);
    if (mid) {
      const dl = await downloadWaMedia({ mediaId: mid, wamid });
      if (dl.mediaPath) {
        await prisma.message
          .update({ where: { id: result.msg.id }, data: { mediaPath: dl.mediaPath } })
          .catch((err) =>
            log.warn(
              { clinic: clinic.code, wamid, err: err instanceof Error ? err.message : String(err) },
              "inbound: mediaPath update failed（訊息已入庫，只係冇附件）"
            )
          );
      }
    }

    if (result.convUpdated) {
      await notifyNewMessage(clinic.id, result.convUpdated, result.msg);
    }

    log.info(
      { clinic: clinic.code, wamid, type: msgTypeOf(m), hasMedia: Boolean(mid), unread: result.convUpdated?.unreadCount },
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
          conversationId: result.conv.id,
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
        { conversationId: result.conv.id, messageId: result.msg.id, clinicId: clinic.id },
        { jobId: `ai-${result.msg.id}` }
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

    // 收件人 = message 入面唔係自己店號碼嘅邊個（echo 係店員手機 App 發出去嘅）
    const recipient =
      (m.to && m.to !== bizNumber ? m.to : undefined) ??
      (m.from && m.from !== bizNumber ? m.from : undefined);
    if (!recipient) {
      log.warn({ wamid, clinic: clinic.code }, "echo: cannot resolve recipient, skipped");
      continue;
    }
    const waTs = tsToDate(m.timestamp);

    // ★ P0-1 同 handleMessages：claim + 業務寫入同一個 $transaction；
    //   P2002 + 無 Message = claim 孤兒 → 重跑補回。
    const result = await prisma.$transaction(async (tx) => {
      const claimed = await claimInTx(tx, `echo:${wamid}`, "smb_message_echoes");
      if (!claimed) {
        const existing = await tx.message.findUnique({ where: { waMessageId: wamid } });
        if (existing) return { skipped: true as const };
        log.info({ wamid }, "inbound: claim orphan detected (echo) — 重跑補回");
      }

      const contact = await upsertContact(tx, clinic.id, recipient, null);
      const conv = await findOrCreateConversation(tx, clinic.id, contact.id, waTs);
      let msg: Message;
      try {
        msg = await tx.message.create({
          data: {
            conversationId: conv.id,
            waMessageId: wamid,
            direction: "OUT",
            channel: "APP_ECHO",
            type: msgTypeOf(m),
            body: messageBody(m),
            mediaPath: null, // ★ 媒體下載喺 transaction 外
            status: "SENT",
            waTimestamp: waTs,
          },
        });
      } catch (err) {
        if (isUniqueViolation(err)) return { skipped: true as const }; // 併發 race
        throw err;
      }
      const convUpdated = await touchConversation(tx, conv.id, waTs, {
        incrementUnread: false,
        touchInbound: false,
      });
      return { skipped: false as const, msg, conv, convUpdated };
    });

    if (result.skipped) continue;

    // ★ media 下載喺 transaction 外（失敗只係冇附件）
    const mid = mediaIdOf(m);
    if (mid) {
      const dl = await downloadWaMedia({ mediaId: mid, wamid });
      if (dl.mediaPath) {
        await prisma.message
          .update({ where: { id: result.msg.id }, data: { mediaPath: dl.mediaPath } })
          .catch((err) =>
            log.warn(
              { clinic: clinic.code, wamid, err: err instanceof Error ? err.message : String(err) },
              "inbound: echo mediaPath update failed（訊息已入庫，只係冇附件）"
            )
          );
      }
    }

    if (result.convUpdated) await notifyNewMessage(clinic.id, result.convUpdated, result.msg);

    log.info({ clinic: clinic.code, wamid, type: msgTypeOf(m) }, "inbound: echo processed");
  }
}

/**
 * P0-2 逐條歸戶：IN → m.from；OUT（from=商家號）→ m.to。
 * ★ Fallback（真 payload 形狀保險）：部分 history payload 嘅 OUT 訊息冇 `to`
 *   （舊形狀只記 from）— 當全批次只有一個非商家號候選（candidates 計入 contacts[]）
 *   就歸佢（等價舊 single-patient 行為，唔丟店員回覆咗一半 history）；
 *   多候選又冇 to → null（真無法歸戶 → skip + Alert(history_skip)）。
 */
function historyPatientOf(
  m: WaTimestampedMessage,
  bizNumber: string,
  candidateFallback: string | null
): string | null {
  const sender = m.from ?? "";
  const recipient = m.to ?? "";
  if (sender && sender !== bizNumber) return sender; // IN：歸發送人
  if (sender === bizNumber) {
    // OUT 訊息：歸收件人（排除商家號自己）；冇 to → 單候選 fallback
    if (recipient && recipient !== bizNumber) return recipient;
    return candidateFallback;
  }
  // 連 from 都冇：to 係非商家號 → 歸 to；否則單候選 fallback
  if (recipient && recipient !== bizNumber) return recipient;
  return candidateFallback;
}

interface HistoryRow {
  waMessageId: string;
  direction: "IN" | "OUT";
  channel: "HISTORY";
  type: string;
  body: string | null;
  mediaPath: null;
  status: "SENT" | "RECEIVED";
  waTimestamp: Date;
}

/**
 * P0-2：無法歸戶訊息 skip → Alert（唔淨係 warn log — 靜默丟舊 chat 唔可以無訊號）。
 * 冪等：同店已有未解決 history_skip → 唔重複開（新計數只 log）。
 */
async function recordHistorySkipAlert(clinic: Clinic, detail: Record<string, unknown>): Promise<void> {
  try {
    const existing = await prisma.alert.findFirst({
      where: { type: "history_skip", clinicId: clinic.id, resolvedAt: null },
      select: { id: true },
    });
    if (existing) {
      log.warn({ clinic: clinic.code, ...detail, existingAlert: existing.id }, "history_skip: alert already open (唔重開)");
      return;
    }
    await prisma.alert.create({
      data: { type: "history_skip", severity: "HIGH", clinicId: clinic.id, clinicCode: clinic.code, detail: detail as unknown as object },
    });
    await notifyAlert({ type: "history_skip", severity: "HIGH", clinicCode: clinic.code, detail });
  } catch (err) {
    // 警報失敗唔準阻匯入 pipeline（log 係兜底）
    log.error(
      { clinic: clinic.code, err: err instanceof Error ? err.message : String(err) },
      "history_skip: alert creation failed"
    );
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

  // ★ P0-2：一個 history 批次可以含多個病人（Meta 官方文檔冇寫死分幾多 phase / 一個 value 混唔混多 chat）。
  //   舊 code 假設「一批 = 一個病人」— 多病人批次整批放棄 → 靜默丟舊 chat。
  //   新邏輯：按 m.from（IN）/ m.to（OUT）逐條歸戶；只有連 to 都冇、真係無法歸戶先 skip，
  //   而且 skip 數計入 Alert type=history_skip（唔淨係 warn log）。
  //
  // ★ 試點店 onboarding 當日形狀驗證（rollout-checklist §A）：開 LOG_LEVEL=debug 對真 payload 嘅
  //   keys/計數驗證呢套假設。★ PII：只 log 結構（keys/計數）— 訊息內文/電話號碼絕不入 log。
  log.debug(
    {
      clinic: clinic.code,
      spans: spans.length,
      messages: messages.length,
      messagesWithFrom: messages.filter((m) => m.from).length,
      messagesWithTo: messages.filter((m) => m.to).length,
      distinctFroms: new Set(messages.map((m) => m.from).filter(Boolean)).size,
      distinctTos: new Set(messages.map((m) => m.to).filter(Boolean)).size,
      contacts: (value.contacts ?? []).length,
      endOfHistory,
    },
    "history: payload structure (keys/counts only — no content)"
  );

  const profileNames = new Map<string, string>();
  for (const c of value.contacts ?? []) {
    if (c.wa_id && c.profile?.name) profileNames.set(c.wa_id, c.profile.name);
  }

  // 單批次歸戶候選：所有非商家號發送人 + contacts[]（只有一個先可用做 fallback）
  const candidates = new Set<string>();
  for (const m of messages) {
    const f = m.from ?? "";
    if (f && f !== bizNumber) candidates.add(f);
  }
  for (const c of value.contacts ?? []) {
    if (c.wa_id && c.wa_id !== bizNumber) candidates.add(c.wa_id);
  }
  const candidateFallback = candidates.size === 1 ? [...candidates][0] : null;

  // 1) 逐條歸戶 + 按病人分組
  const perPatient = new Map<string, HistoryRow[]>();
  let skipped = 0;
  for (const m of messages) {
    if (!m.id) continue;
    const patientWaId = historyPatientOf(m, bizNumber, candidateFallback);
    if (!patientWaId) {
      skipped++;
      continue;
    }
    const isOut = (m.from ?? "") === bizNumber;
    const row: HistoryRow = {
      waMessageId: m.id!,
      direction: isOut ? "OUT" : "IN",
      channel: "HISTORY",
      type: msgTypeOf(m),
      body: messageBody(m),
      mediaPath: null, // 歷史媒體唔下載（一次性匯入；MD 只要求記錄搵得返）
      status: isOut ? "SENT" : "RECEIVED",
      waTimestamp: tsToDate(m.timestamp),
    };
    const bucket = perPatient.get(patientWaId);
    if (bucket) bucket.push(row);
    else perPatient.set(patientWaId, [row]);
  }

  if (perPatient.size === 0) {
    log.warn(
      { clinic: clinic.code, skipped, total: messages.length, endOfHistory },
      "history: no attributable messages, import skipped"
    );
    if (skipped > 0) await recordHistorySkipAlert(clinic, { skipped, total: messages.length, endOfHistory });
    return;
  }

  // 2) 逐病人：contact + conversation + batch insert（wamid unique = 冪等；容忍亂序）
  //   （唔會為商家號建 Contact — 商家號唔會成為 patient）
  const imported: { patientMasked: string; count: number }[] = [];
  for (const [patientWaId, rows0] of perPatient) {
    const contact = await upsertContact(prisma, clinic.id, patientWaId, profileNames.get(patientWaId) ?? null);
    const conv = await findOrCreateConversation(prisma, clinic.id, contact.id, new Date(0));
    const rows = rows0.map((r) => ({ ...r, conversationId: conv.id }));
    // 分批 500 條（幾萬條級別）
    for (let i = 0; i < rows.length; i += 500) {
      await prisma.message.createMany({ skipDuplicates: true, data: rows.slice(i, i + 500) });
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
    imported.push({ patientMasked: patientWaId.length > 3 ? `${patientWaId.slice(0, 3)}***` : "***", count: rows.length });
  }

  // ★ 唔觸發 unread（完全唔郁 unreadCount）
  // ★ 唔觸發 AI（history 唔入 aiQueue）
  log.info(
    { clinic: clinic.code, patients: imported.length, imported, skipped, endOfHistory },
    "history: batch imported per-patient (no unread, no AI)"
  );

  // 4) 有無法歸戶嘅 → 警報（唔淨係 warn log）
  if (skipped > 0) {
    log.warn({ clinic: clinic.code, skipped, total: messages.length }, "history: unattributable messages skipped");
    await recordHistorySkipAlert(clinic, { skipped, total: messages.length, importedPatients: imported.length, endOfHistory });
  }
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
    const errorCode =
      target === "FAILED"
        ? String(s.error_code ?? s.errors?.[0]?.code ?? "") || null
        : null;

    // ★ P0-1 同一 pattern：claim + update 同一個 $transaction。
    //   P2002 時分三況：
    //     • 無 Message → skip（同舊行為）
    //     • status 已 = target → 真處理過 → 靜默 skip（唔重複 notify，同舊行為）
    //     • claim 存在但 status 未更新（claim 孤兒）→ 補 apply + notify
    const result = await prisma.$transaction(async (tx) => {
      const claimed = await claimInTx(tx, `status:${wamid}:${s.status}`, "statuses");
      const msg = await tx.message.findUnique({ where: { waMessageId: wamid } });
      if (!msg) return { missing: true as const, changed: false, convId: null as string | null };
      const alreadyApplied = !claimed && msg.status === target;
      if (!alreadyApplied) {
        await tx.message.update({ where: { id: msg.id }, data: { status: target, errorCode } });
      }
      const conv = await tx.conversation.findUnique({ where: { id: msg.conversationId }, select: { id: true } });
      return { missing: false as const, changed: !alreadyApplied, convId: conv?.id ?? null };
    });

    if (result.missing) {
      log.warn({ wamid, status: s.status }, "inbound: status for unknown message, skipped");
      continue;
    }
    if (result.changed && result.convId) {
      publishNotify(clinic.id, "message:status", {
        conversationId: result.convId,
        clinicId: clinic.id,
        waMessageId: wamid,
        status: target,
        errorCode,
      });
    }
    log.info(
      { clinic: clinic.code, wamid, status: target, errorCode, applied: result.changed },
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

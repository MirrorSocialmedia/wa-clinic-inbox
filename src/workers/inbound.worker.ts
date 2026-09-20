import { Worker, type Job } from "bullmq";
import { unlink } from "node:fs/promises";
import { inboundQueue, aiQueue, mediaQueue, getRedis, QUEUE_PREFIX, INBOUND_ATTEMPTS } from "@/lib/queue";
import { publishConvEvent, convRef } from "@/lib/notify";
import { buildMessageNewPayload } from "@/lib/realtime-payload";
import { pushEvent } from "@/lib/push";
import prisma from "@/lib/prisma";
import log, { redactDeep } from "@/lib/log";
import { notifyAlert } from "@/lib/health/notify";
import { upsertAlert } from "@/lib/health/alerts";
import { writeDeadLetter } from "@/lib/ops/dead-letter";
import { encryptMedia, getMediaKey } from "@/lib/wa/media";
// ★ cwi-final S1-1c：status monotonic apply + PendingStatus 排水
import { applyStatusInTx, drainPendingStatuses } from "@/lib/wa/status-apply";
import { Prisma, type Clinic, type Contact, type Conversation, type Message } from "@prisma/client";
import { INBOUND_CONCURRENCY } from "./concurrency";
// ★ cwi-followup-p3-20260916：follow-up inbound hook（opt-out 偵測 + 回覆標記）
import { detectOptOutIntent, applyFollowupOptOut } from "@/lib/followup/opt-out";
import { markFollowupReplied } from "@/lib/followup/engine";

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
 * - 媒體            → ★ Realtime P0 (R4)：inbound job 只落 Message(mediaStatus=PENDING)
 *                   + enqueue media job 即完（唔喺入面做 HTTP 下載）；
 *                   實際下載由獨立 media worker（concurrency 3）做，完成 → READY + emit media:ready
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

// ★ cwi-followup-v3 B-9：gender default（M→先生，F→小姐）— 只 create 時填；之後員工可隨時手改（病人記錄面板）。
//   目前 Apricot contract 無 sex 欄（參數預留）— 有數據來源時 caller 傳入即自動填；唔會由 AI/名猜。
function salutationFromGender(gender: string | null): string | null {
  const g = (gender ?? "").toLowerCase();
  if (g === "m" || g === "male") return "先生";
  if (g === "f" || g === "female") return "小姐";
  return null;
}

async function upsertContact(
  db: Db,
  clinicId: string,
  waId: string,
  profileName: string | null,
  /** ★ cwi-followup-v3 B-9：gender（M/F）— 目前 Apricot 無此欄；有來源時傳入 → create 時填 salutation default */
  gender?: string | null
): Promise<Contact> {
  return db.contact.upsert({
    where: { clinicId_waId: { clinicId, waId } },
    update: profileName ? { profileName } : {},
    create: {
      clinicId,
      waId,
      profileName: profileName ?? null,
      labels: [],
      // ★ B-9：gender default（update 唔覆蓋 — 人手改過嘅 salutation 永遠保留）
      salutation: salutationFromGender(gender ?? null),
    },
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

/** 原子更新對話時間戳 + unread（raw SQL：GREATEST 容忍亂序 + increment 原子） */
async function touchConversation(
  db: Db,
  convId: string,
  ts: Date,
  opts: { incrementUnread: boolean; touchInbound: boolean; touchOutbound?: boolean; reopen?: { dropAssignee: boolean } }
): Promise<Conversation | null> {
  const inc = opts.incrementUnread ? 1 : 0;
  // ★ cwi-statusrole2-20260910（MD §3 已解決翻開四聯動）：病人訊息落 RESOLVED 對話 → 原子翻開。
  //   CASE 以 row 現值 status 為準 → 冪等（併發重跑：第二次見 OPEN 就唔會重開）：
  //   - status→OPEN + reopenedAt=now（badge「↻ 重新開啟」24h 窗口由 UI derive）
  //   - Routing 保留：routedGroupId/routedStaffId/routedRuleId/routedAt 一概唔清（原本派俾邊組就仲係嗰組）
  //   - escalatedAt 清 null（容許重新計時升級）；resolvedBy/resolvedAt 清 null（翻開 = 未再解決）
  //   - 負責人：active → 保留（CASE 唔動 assigneeId）；停用 → dropAssignee → 跌公海（null）
  //   - CONSULT 復活：C2 已接活（T245）— 由 handleMessages 嘅 reopen 分支喺 touchConversation 後執行
  //     （同一 tx：最新 EXPIRED session < 7 日 → terminal=null；audit consultRevived 真值）。
  //   - Followup COMPLETED：本 repo 無 FollowupTask model（未實施）— 掛鉤點：followup 功能落 DB 後喺 reopen 分支補（followup MD §4 自帶呢條）。
  // 動態 SQL 片段全部係內部常數（零外部輸入）；值全部走 $queryRawUnsafe 參數綁定（防注入）。
  const params: unknown[] = [];
  const p = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  let sql = `UPDATE "Conversation" SET "lastMessageAt" = GREATEST("lastMessageAt", ${p(ts)})`;
  if (opts.touchInbound) {
    sql += `,
            "lastInboundAt" = GREATEST(COALESCE("lastInboundAt", ${p(ts)}), ${p(ts)})`;
  }
  sql += `,
            "unreadCount" = "unreadCount" + ${p(inc)}`;
  if (opts.touchOutbound) {
    // ★ MD §4：touchOutbound = 呢條訊息係 OUT 且已 SENT（staff 手機 App 回音）— lastOutboundAt 維護點之一
    sql += `,
            "lastOutboundAt" = GREATEST(COALESCE("lastOutboundAt", ${p(ts)}), ${p(ts)})`;
  }
  if (opts.reopen) {
    sql += `
      , "status" = CASE WHEN "status" = 'RESOLVED' THEN 'OPEN' ELSE "status" END
      , "reopenedAt" = CASE WHEN "status" = 'RESOLVED' THEN now() ELSE "reopenedAt" END
      , "escalatedAt" = CASE WHEN "status" = 'RESOLVED' THEN NULL ELSE "escalatedAt" END
      , "resolvedBy" = CASE WHEN "status" = 'RESOLVED' THEN NULL ELSE "resolvedBy" END
      , "resolvedAt" = CASE WHEN "status" = 'RESOLVED' THEN NULL ELSE "resolvedAt" END
      , "assigneeId" = CASE WHEN "status" = 'RESOLVED' AND ${p(opts.reopen.dropAssignee ? 1 : 0)} = 1 THEN NULL ELSE "assigneeId" END`;
  }
  sql += `
        WHERE "id" = ${p(convId)}
        RETURNING *`;
  const rows = await db.$queryRawUnsafe<Conversation[]>(sql, ...params);
  return (rows[0] as unknown as Conversation) ?? null;
}

async function notifyNewMessage(clinicId: string, conv: Conversation, msg: Message) {
  // ★ cwi-final S1-1b（T713 dev test hook）：模擬 notify 鏈路瞬時失敗（一次）— 驗證 try/catch
  //   containment（job 唔 fail）+ skipped 分支補做。dev-only（NODE_ENV 雙保險，同 media chaos hook 同風格）；
  //   觸發 = touch .dev/notify-chaos-fail（或 env NOTIFY_CHAOS_FAIL_FILE 指定路徑）→ 首次調用刪檔 + throw。
  const chaosFile = (process.env.NOTIFY_CHAOS_FAIL_FILE ?? (process.env.NODE_ENV !== "production" ? ".dev/notify-chaos-fail" : "")).trim();
  if (chaosFile) {
    try {
      await unlink(chaosFile);
      throw new Error("chaos: notifyNewMessage fail-once（T713 dev test hook）");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  // ★ cwi-final S1-4/S1-7：完整 payload 單一來源（realtime-payload）+ publishConvEvent
  //   （跨店 targeting：assignee/路由單人/路由組 active 成員 + eventId 去重 — 取代舊 assignee 補推）
  const payload = await buildMessageNewPayload(msg.id);
  await publishConvEvent(convRef(conv), "message:new", payload);
  // v2 Web Push（cwi-notify-v2）：tab 閂咗/鎖屏都收到 — payload 零 PII（kind/clinicShort/conversationId）
  pushEvent({ kind: "message", clinicId, conversationId: conv.id });
}

// ── 各 field 處理 ────────────────────────────────────────────────────────

/**
 * ★ cwi-final S1-1b（C-1②）：skipped 分支（claim 已存在 / 併發 race）補做 commit 後副作用。
 *
 * 語義：crash 喺「tx commit」同「media/AI enqueue」之間 → 重試時 claim 已存在 → 呢度補回。
 * 冪等：BullMQ 同 jobId 仲喺 queue → 自動忽略；已完成被清走 → 會重跑，但 AI 側有
 * AiDraft unique（inReplyToMessageId）+ hasDraft 前置檢查 + S4-2 發送閘保護。
 *
 * 偏離記錄（CTO 判斷）：spec 字面 media job data 只帶 `{ messageId }` — 但 DB 唔存 WA mediaId
 *（本單 zero schema change），media worker 真 download 要 mediaId+wamid。skipped 分支有當前 payload，
 * 所以補齊傳 `media`；stuck-sweep 兜底（無 payload）只帶 `{ messageId, clinicId }` → media worker
 * 見唔到 mediaId → 標 SKIPPED（誠實終態，訊息正文保留；原 job 仲喺 queue 時重入係 no-op）。
 * 正常路徑（非 skipped）維持原樣（S0-11 零回退）。
 *
 * TODO(cwi-final S1-14)：urgentIntake 上線後，呢度亦要 call（重試時補做急症判斷）。
 */
async function ensureSideEffects(
  msg: Message,
  conv: Conversation,
  clinic: Clinic,
  media?: { mediaId: string; wamid: string }
): Promise<void> {
  if (msg.mediaStatus === "PENDING") {
    try {
      await mediaQueue.add(
        "download",
        media
          ? { messageId: msg.id, mediaId: media.mediaId, wamid: media.wamid, clinicId: clinic.id }
          : { messageId: msg.id, clinicId: clinic.id },
        { jobId: `media-${msg.id}` }
      );
    } catch (err) {
      // enqueue 失敗（Redis 瞬時）→ best-effort log；stuck-sweep 每 5 分鐘兜底
      log.warn(
        { messageId: msg.id, err: err instanceof Error ? err.message : String(err) },
        "inbound: skipped-branch media re-enqueue failed（stuck-sweep 兜底）"
      );
    }
  }
  if (msg.direction === "IN" && msg.channel === "API" && msg.type === "text") {
    const hasDraft = await prisma.aiDraft.findFirst({ where: { inReplyToMessageId: msg.id }, select: { id: true } });
    if (!hasDraft) {
      try {
        await aiQueue.add("classify", { conversationId: conv.id, messageId: msg.id, clinicId: clinic.id }, { jobId: `ai-${msg.id}` });
      } catch (err) {
        log.warn(
          { messageId: msg.id, err: err instanceof Error ? err.message : String(err) },
          "inbound: skipped-branch ai re-enqueue failed（stuck-sweep 兜底）"
        );
      }
    }
  }
}

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
    const mid = mediaIdOf(m);

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
        if (existing) return { skipped: true as const, msg: existing };
        log.info({ wamid }, "inbound: claim orphan detected (claim 存在但無 Message) — 重跑補回");
        // fall through → 照處理落去（孤兒恢復）
      }

      const contact = await upsertContact(tx, clinic.id, waId, profileName);
      const conv = await findOrCreateConversation(tx, clinic.id, contact.id, waTs);
      // ★ cwi-statusrole2-20260910（MD §3）：RESOLVED + 病人 inbound → 翻開前置檢查 —
      //   原負責人停用 → 跌公海（dropAssignee）；active → 保留（tx 內直查保證同 message commit 一致）。
      const wasResolved = conv.status === "RESOLVED";
      let dropAssignee = false;
      if (wasResolved && conv.assigneeId) {
        const assignee = await tx.staffUser.findUnique({
          where: { id: conv.assigneeId },
          select: { active: true },
        });
        dropAssignee = !assignee?.active;
      }
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
            mediaPath: null, // ★ media 下載喺獨立 media queue（R4）— 先落 PENDING row
            // ★ Realtime P0 (R4)：有 media → PENDING（media worker 下載完 → READY + emit media:ready）
            mediaStatus: mid ? "PENDING" : "READY",
            status: "RECEIVED",
            waTimestamp: waTs,
          },
        });
      } catch (err) {
        // 併發 race：另一個相同 event 嘅 transaction 先 commit 咗 → 當真處理過 skip（本 tx 全部回滾）。
        // ★ cwi-final S1-1b：unique violation 後 tx 已 aborted，唔可以喺同一 tx 再 query —
        //   msg 傳 null，skipped 分支喺 tx 外再 fetch（競爭者已 commit）。
        if (isUniqueViolation(err)) return { skipped: true as const, msg: null };
        throw err;
      }
      const convUpdated = await touchConversation(tx, conv.id, new Date(), {
        incrementUnread: true,
        touchInbound: true,
        reopen: wasResolved ? { dropAssignee } : undefined,
      }); // ★ cwi-final S1-1d（=S1-11）：非 HISTORY IN 用 server now()（唔再用病人手機時鐘 waTs）— 延遲送達都會浮頂 + 入 delta
      // ★ 翻開聯動（cwi-statusrole2-20260910 MD §3 + consult v2.1 C2 / T245）：CONSULT 復活 + audit。
      //   最新 session terminal="EXPIRED" 且距今 < 7 日 → 復活（terminal=null；turnCount/stage 保留）；
      //   ≥ 7 日 → 唔復活（新 session 由 C3 觸發時先開）。EXPIRED 距今基準 = session.updatedAt
      //   （EXPIRED 只由 C3 48h cron 寫，terminal 行之後無其他寫入點）。
      //   冪等：updateMany where terminal='EXPIRED' 搶佔（併發重跑第二次命中 0）。
      //   零 PII：audit 只記 conversationId / 原 assigneeId / consultRevived 旗。
      let consultRevived = false;
      if (wasResolved && convUpdated && convUpdated.status === "OPEN") {
        const expiredSession = await tx.consultSession.findFirst({
          where: { conversationId: conv.id, terminal: "EXPIRED" },
          orderBy: { updatedAt: "desc" },
          select: { id: true, updatedAt: true },
        });
        if (expiredSession) {
          const reviveCutoff = new Date(Date.now() - 7 * 86_400_000);
          if (expiredSession.updatedAt >= reviveCutoff) {
            const r = await tx.consultSession.updateMany({
              where: { id: expiredSession.id, terminal: "EXPIRED" },
              data: { terminal: null },
            });
            consultRevived = r.count === 1;
            if (consultRevived) {
              log.info(
                { conversationId: conv.id, sessionId: expiredSession.id },
                "inbound: reopen — EXPIRED consult session <7 日 → 復活（T245）"
              );
            }
          }
        }
        // ★ 翻開 audit（零 PII：只記 conversationId / 原 assigneeId / 聯動結果）
        await tx.auditLog.create({
          data: {
            staffId: null, // 系統動作（病人 inbound 觸發，無 staff 參與）
            action: "CONVERSATION_REOPENED",
            entity: "Conversation",
            entityId: conv.id,
            meta: {
              prevAssigneeId: conv.assigneeId,
              assigneeKept: !dropAssignee,
              consultRevived,
            } as object,
          },
        });
      }
      return { skipped: false as const, msg, conv, convUpdated };
    });

    if (result.skipped) {
      log.debug({ wamid }, "inbound: message already processed (idempotent skip) — ensure side effects");
      // ★ cwi-final S1-1b（C-1②）：skipped 唔再直接 return — 補做 commit 後副作用
      //   （crash 喺 commit 同 enqueue 之間 = media/AI 永無；重試時補回，冪等 jobId）。
      let skipMsg = result.msg;
      if (!skipMsg) skipMsg = await prisma.message.findUnique({ where: { waMessageId: wamid } });
      if (skipMsg) {
        const skipConv = await prisma.conversation.findUnique({ where: { id: skipMsg.conversationId } });
        if (skipConv) await ensureSideEffects(skipMsg, skipConv, clinic, mid ? { mediaId: mid, wamid } : undefined);
      }
      continue;
    }

    // ★ Realtime P0 (R4)：media 下載搬去獨立 media queue（concurrency 3）— 呢度只 enqueue，
    //   大 media 唔會阻住同對話後面的訊息（per-conversation 順序由 inbound concurrency=1 保證）。
    //   jobId = media-<messageId>（BullMQ 冪等 — retry 唔會重複 enqueue）。
    if (mid) {
      try {
        await mediaQueue.add(
          "download",
          { messageId: result.msg.id, mediaId: mid, wamid, clinicId: clinic.id },
          { jobId: `media-${result.msg.id}` }
        );
      } catch (err) {
        // enqueue 失敗（Redis 瞬時不可用等）→ 標 SKIPPED（訊息安全，只係冇附件；唔好留 PENDING 吊咗）
        await prisma.message
          .update({ where: { id: result.msg.id }, data: { mediaStatus: "SKIPPED" } })
          .catch(() => undefined);
        log.warn(
          { clinic: clinic.code, wamid, err: err instanceof Error ? err.message : String(err) },
          "inbound: media enqueue failed — marked SKIPPED（訊息已入庫，只係冇附件）"
        );
      }
    }

    // ★ cwi-final S1-1b：notify 係 best-effort bypass — 失敗唔准 job fail（訊息已安全落 DB；
    //   舊 code 呢度 throw = 整 job fail → 重試 → 冪等 skip，但 DB 短暫不可用時會耗盡 attempts 進 DLQ）
    if (result.convUpdated) {
      try {
        await notifyNewMessage(clinic.id, result.convUpdated, result.msg);
      } catch (err) {
        log.warn({ wamid, err: err instanceof Error ? err.message : String(err) }, "inbound: notifyNewMessage failed（best-effort — 唔 fail job）");
      }
    }

    // ★ cwi-followup-p3-20260916（followup-v2 MD §4.6 + 鐵律 5）：follow-up inbound hook（best-effort —
    //   失敗只 log warn，唔影響訊息主流程）：
    //   ① 病人回覆咗 SENT follow-up → task COMPLETED + 「跟進回覆」badge（唔 claim、唔改 assignee）
    //   ② opt-out 短句自動偵測 → 標記 + StaffNotice（誤傷防護：≤40 字先偵測）
    try {
      await markFollowupReplied(result.msg.conversationId, waTs);
      if (result.msg.body) {
        if (detectOptOutIntent(result.msg.body)) {
          const convRow = result.convUpdated ?? (await prisma.conversation.findUnique({ where: { id: result.msg.conversationId }, select: { contactId: true } }));
          if (convRow?.contactId) {
            await applyFollowupOptOut({ contactId: convRow.contactId, source: "auto", now: waTs });
          }
        }
      }
    } catch (err) {
      log.warn({ wamid, err: err instanceof Error ? err.message : String(err) }, "inbound: follow-up hook failed（best-effort — 唔阻主流程）");
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
    const mid = mediaIdOf(m);

    // ★ P0-1 同 handleMessages：claim + 業務寫入同一個 $transaction；
    //   P2002 + 無 Message = claim 孤兒 → 重跑補回。
    const result = await prisma.$transaction(async (tx) => {
      const claimed = await claimInTx(tx, `echo:${wamid}`, "smb_message_echoes");
      if (!claimed) {
        const existing = await tx.message.findUnique({ where: { waMessageId: wamid } });
        if (existing) return { skipped: true as const, msg: existing };
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
            mediaPath: null, // ★ media 下載喺獨立 media queue（R4）
            mediaStatus: mid ? "PENDING" : "READY",
            status: "SENT",
            // cwi-window-20260901（P1）：手機 App 回音唔經系統計費 → NONE
            billingCategory: "NONE",
            waTimestamp: waTs,
          },
        });
      } catch (err) {
        // ★ cwi-final S1-1b：unique violation 後 tx aborted — msg 傳 null，skipped 分支 tx 外再 fetch
        if (isUniqueViolation(err)) return { skipped: true as const, msg: null }; // 併發 race
        throw err;
      }
      const convUpdated = await touchConversation(tx, conv.id, waTs, {
        incrementUnread: false,
        touchInbound: false,
        touchOutbound: true, // ★ MD §4：APP_ECHO = 病人已收到 → lastOutboundAt 維護
      });
      return { skipped: false as const, msg, conv, convUpdated };
    });

    if (result.skipped) {
      // ★ cwi-final S1-1b：skipped 分支補做副作用（同 handleMessages — echo 無 AI，media 分支適用）
      let skipMsg = result.msg;
      if (!skipMsg) skipMsg = await prisma.message.findUnique({ where: { waMessageId: wamid } });
      if (skipMsg) {
        const skipConv = await prisma.conversation.findUnique({ where: { id: skipMsg.conversationId } });
        if (skipConv) await ensureSideEffects(skipMsg, skipConv, clinic, mid ? { mediaId: mid, wamid } : undefined);
      }
      continue;
    }

    // ★ cwi-final S1-1c：APP_ECHO Message 落庫（wamid 寫入）後 → drain 早到嘅 status
    //   （例如病人手機 App 發咗訊息但系統未見 wamid 時嘅 sent/delivered webhook）。
    //   drain 失敗唔 throw（內部 catch）；sweep */2 兜底。
    await drainPendingStatuses(wamid);

    // ★ Realtime P0 (R4)：echo media 一樣走獨立 media queue（見 handleMessages 註釋）
    if (mid) {
      try {
        await mediaQueue.add(
          "download",
          { messageId: result.msg.id, mediaId: mid, wamid, clinicId: clinic.id },
          { jobId: `media-${result.msg.id}` }
        );
      } catch (err) {
        await prisma.message
          .update({ where: { id: result.msg.id }, data: { mediaStatus: "SKIPPED" } })
          .catch(() => undefined);
        log.warn(
          { clinic: clinic.code, wamid, err: err instanceof Error ? err.message : String(err) },
          "inbound: echo media enqueue failed — marked SKIPPED（訊息已入庫，只係冇附件）"
        );
      }
    }

    // ★ cwi-final S1-1b：notify 係 best-effort bypass — 失敗唔准 job fail（訊息已安全落 DB）
    if (result.convUpdated) {
      try {
        await notifyNewMessage(clinic.id, result.convUpdated, result.msg);
      } catch (err) {
        log.warn({ wamid, err: err instanceof Error ? err.message : String(err) }, "inbound: notifyNewMessage failed（best-effort — 唔 fail job）");
      }
    }

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
    const maxOutboundTs = rows
      .filter((r) => r.direction === "OUT")
      .reduce<Date | null>((a, r) => (a === null || r.waTimestamp > a ? r.waTimestamp : a), null);
    if (!maxInboundTs) {
      // 全部係 OUT（店員發嘅）— 只更新 lastMessageAt + lastOutboundAt
      await prisma.$executeRaw`
        UPDATE "Conversation" SET "lastMessageAt" = GREATEST("lastMessageAt", ${maxTs}),
            "lastOutboundAt" = GREATEST(COALESCE("lastOutboundAt", ${maxTs})) WHERE "id" = ${conv.id}`;
    } else if (maxOutboundTs) {
      await prisma.$executeRaw`
        UPDATE "Conversation"
        SET "lastMessageAt" = GREATEST("lastMessageAt", ${maxTs}),
            "lastInboundAt" = GREATEST(COALESCE("lastInboundAt", ${maxInboundTs})),
            "lastOutboundAt" = GREATEST(COALESCE("lastOutboundAt", ${maxOutboundTs}))
        WHERE "id" = ${conv.id}`;
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
    //   P2002 時分四況：
    //     • 無 Message + claimed（新）→ ★ cwi-final S1-1c：status 早過訊息 → 同 tx parked 入 PendingStatus
    //     • 無 Message + 舊 claim（重發）→ createMany skipDuplicates no-op → 一樣 parked（冪等）
    //     • status 已 = target → 真處理過 → 靜默 skip（唔重複 notify，同舊行為）
    //     • claim 存在但 status 未更新（claim 孤兒）→ 補 apply + notify（同現行 P0-1 口徑）
    const result = await prisma.$transaction(async (tx) => {
      const claimed = await claimInTx(tx, `status:${wamid}:${s.status}`, "statuses");
      const msg = await tx.message.findUnique({ where: { waMessageId: wamid } });
      if (!msg) {
        // ★ cwi-final S1-1c（C-1③）：舊 code 呢度直接 return → claim 留低 + Meta 唔重送 → status 永久丟。
        //   而家 parked 入 PendingStatus（同 tx commit — 要嘛全有要嘛全冇，唔會兩頭唔到岸）。
        //   零 PII：只有 wamid/status/errorCode/clinicId。排水：outbound 寫入後 / APP_ECHO 後 / sweep */2。
        await tx.pendingStatus.createMany({
          data: [{ wamid, status: target, errorCode, clinicId: clinic.id }],
          skipDuplicates: true,
        });
        return { parked: true as const, changed: false, convId: null as string | null };
      }
      const alreadyApplied = !claimed && msg.status === target;
      let changed = false;
      if (!alreadyApplied) {
        // ★ cwi-final S1-1c：monotonic apply（取代舊直接 update — read 之後到 delivered 唔再倒退）。
        //   claimed===false 而 status≠target（claim 孤兒）都照 apply（同現行 P0-1 口徑）。
        const applied = await applyStatusInTx(tx, msg, target, errorCode);
        changed = applied !== null;
      }
      const conv = await tx.conversation.findUnique({ where: { id: msg.conversationId }, select: { id: true } });
      return { parked: false as const, changed, convId: conv?.id ?? null };
    });

    if (result.parked) {
      log.info({ wamid, status: target }, "inbound: status 早過訊息 — 已暫存 PendingStatus");
      continue;
    }
    if (result.changed && result.convId) {
      // ★ cwi-final S1-4：conv room 事件轉 publishConvEvent（clinic room + 跨店目標）— tx 內只有 convId，此處補五欄
      const conv = await prisma.conversation.findUnique({
        where: { id: result.convId },
        select: { id: true, clinicId: true, assigneeId: true, routedStaffId: true, routedGroupId: true },
      });
      if (conv) {
        await publishConvEvent(convRef(conv), "message:status", {
          conversationId: result.convId,
          clinicId: clinic.id,
          waMessageId: wamid,
          status: target,
          errorCode,
        });
      }
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
    {
      connection: getRedis(),
      prefix: QUEUE_PREFIX,
      // ★ Realtime P0 (R4)：唔准調大 — per-conversation ordering 靠佢（見 src/workers/concurrency.ts）；
      //   要 scale 先實施 group-by-conversationId（R8 觸發條件）。drift guard：pnpm test:ordering
      concurrency: INBOUND_CONCURRENCY,
    }
  );

  worker.on("completed", (job) => {
    log.info({ jobId: job.id }, "inbound job completed");
  });
  worker.on("failed", (job, err) => {
    log.error({ jobId: job?.id, attemptsMade: job?.attemptsMade, err: err.message }, "inbound job failed");
    // ★ cwi-final S1-1a（spec line 657–663）：只係最終失敗（attemptsMade 達上限）先寫 DLQ —
    //   WebhookEvent payload 24h 後清走，唔入 DLQ = 永久丟。重放 = replay-dead-letters.ts / admin 掣
    //   （WebhookEvent claim 冪等 → 重放安全）。
    //   ★ D-2：payloadEnc AES-256-GCM 加密落庫；log 只 jobId/error 碼 — 零病人原文。
    if (!job || job.attemptsMade < (job.opts.attempts ?? INBOUND_ATTEMPTS)) return;
    void (async () => {
      try {
        const key = getMediaKey();
        if (!key) {
          // dev 無 MEDIA_ENC_KEY：加密唔到 → 唔可以明文落庫（D-2）→ 只 log（WebhookEvent metadata 仍存）
          log.error({ jobId: job.id }, "inbound DLQ: MEDIA_ENC_KEY 未設 — 無法加密 payload，DLQ 寫入跳過（dev only 情境）");
          return;
        }
        const payloadEnc = encryptMedia(Buffer.from(JSON.stringify(job.data)), key).toString("base64");
        const ok = await writeDeadLetter({ queue: "inbound", jobId: String(job.id), payloadEnc, error: err.message.slice(0, 500) });
        // inbound_failed alert（HIGH）— 只准人手 resolve（R-28：唔喺 HEALTH_OWNED_TYPES）。
        // DLQ write 失敗（DB 死）唔阻 alert（兩者同命運，唔重複 retry）。
        if (ok) await upsertAlert({ type: "inbound_failed", severity: "HIGH", detail: { jobId: String(job.id) } });
      } catch (e) {
        // DLQ 路徑任何錯誤都唔准炸 worker（BullMQ 事件 handler reject = unhandled rejection）
        log.error({ jobId: job?.id, e: String(e) }, "inbound DLQ handler failed");
      }
    })();
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

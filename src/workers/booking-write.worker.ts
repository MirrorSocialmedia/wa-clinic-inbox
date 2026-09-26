/**
 * ★ cwi-final S5-1（F1）— booking-write worker：createBooking 異步寫 Apricot（concurrency 1）。
 *
 * 設計（S5-1）：
 * - confirm-core 只做前置校驗 + 條件 claim（PENDING + writeState null/FAILED/UNKNOWN → WRITING）
 *   + enqueue；呢度做實際寫 Apricot + 後處理（審計 / 即時刷新 / 通知 / 確認訊息）。
 * - 結果分類：
 *   成功 → 條件 CONFIRMED（PENDING + WRITING — S5-6：與〔已人手落單〕並發 count=0 → 唔雙發訊息）
 *     + AuditLog + afterBookingWrite + booking:updated + actor 後處理
 *     （STAFF：窗口內確認訊息（clientMessageId = uuidv5 雙擊擋）/ 過窗 = SYSTEM notice；
 *      AI：BOOKING_AUTO notice + L4_CONFIRM gate 確認訊息）
 *   WorkforceOutcomeUnknown → writeState UNKNOWN + writeError "timeout"
 *     + StaffNotice「未確定 Apricot 有冇落到單 — 唔好人手落單，請撳〔重試〕」
 *     （重試 = 同一 idempotencyKey — workforce 冪等重放安全）
 *   確定性失敗（SLOT_TAKEN / WRITE_DISABLED / …）→ writeState FAILED + writeError = code
 *     （AI 加 HANDOFF_REQUEST notice + 病人中性感）
 * - 冪等 / stale guard：status CONFIRMED → skip；writeState ≠ WRITING → skip（stale job）；
 *   jobId = bw-${bookingId}-${idemAttempt}（enqueue 層冪等）。
 * - 重試（queue attempts 3）：DB 短暂故障重投安全 — workforce idempotencyKey 冪等 + 條件 update 防雙確認。
 *
 * ★ R2 鐵律：publish 永遠喺 commit 之後。
 * ★ PII 鐵律：log 只 metadata（booking/clinic id、workforce code、actor id）— 零訊息原文。
 */
import { Worker, type Job } from "bullmq";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { getRedis, enqueueOutboundSend, QUEUE_PREFIX, type BookingWriteJobData } from "@/lib/queue";
import { publishConvEvent, convRef } from "@/lib/notify";
import { getWindowState } from "@/lib/wa/window";
import { afterBookingWrite } from "@/lib/booking/booking-ops";
import { buildRemarks, confirmMessageText, clinicAddressFromGreetingConfig } from "@/lib/booking/booking-text";
import { bookingConfirmClientMessageId } from "@/lib/booking/booking-id";
import { sendAutoIfStillEligible } from "@/lib/ai/auto-send-gate";
import { createBooking, WorkforceApiError, WorkforceOutcomeUnknown } from "@/lib/workforce/client";
import { resolveDurationMin } from "@/lib/booking/durations";
import { BOOKING_WRITE_CONCURRENCY } from "./concurrency";

const ENQUEUE_TIMEOUT_MS = 1500;
// ★ cwi-final S5-14（P2「時長」）：舊 DEFAULT_DURATION_MIN=15 廢掉 — 統一 durations.ts（原單時長 > 預設 30）。
//   呢條路徑（新卡）無原單 → 30；改期時長喺 flow-reply handleReschedule（原單 end-start）。
//   slotHash 用同一個解出值 → 重試冪等 key 穩定（同 booking 行輸入固定 → 解出值固定）。
/** lockDuration：job 最長 ≈ 3 次重試 ×（90s write timeout + 5s 間隔）+ DB 裕度 → 10 分鐘 */
const BOOKING_WRITE_LOCK_MS = 600_000;

/** ★ cwi-final S1-15 (P0-07)：enqueue 結果未知 → 留 QUEUED 俾 outbound-sweep 補發（jobId 冪等）。 */
async function enqueueUncertainOk(messageId: string): Promise<void> {
  try {
    await Promise.race([
      enqueueOutboundSend(messageId),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("enqueue timeout")), ENQUEUE_TIMEOUT_MS)),
    ]);
  } catch (err) {
    log.warn({ messageId, err: err instanceof Error ? err.message : String(err) }, "booking-write: enqueue uncertain — left QUEUED for outbound-sweep");
  }
}

type BookRow = {
  id: string;
  conversationId: string;
  clinicId: string;
  providerApricotId: string;
  providerName: string;
  requestedDate: string;
  requestedTime: string | null;
  timeOfDay: string | null;
  precheckPassed: boolean | null;
  status: string;
  writeState: string | null;
  idemAttempt: number;
  chiefComplaint: string | null;
  createdAt: Date;
};

export function startBookingWriteWorker(): Worker {
  const worker = new Worker<BookingWriteJobData>(
    "booking-write",
    async (job) => {
      await processBookingWriteJob(job);
    },
    // ★ S5-1：concurrency 1（單一寫入點 — outcome 明確；調大要連 F 側冪等 SLA 一併評審）
    { connection: getRedis(), prefix: QUEUE_PREFIX, concurrency: BOOKING_WRITE_CONCURRENCY, lockDuration: BOOKING_WRITE_LOCK_MS },
  );

  worker.on("completed", (job) => {
    log.info({ jobId: job.id, bookingId: job.data.bookingId }, "booking-write job completed");
  });
  worker.on("failed", async (job, err) => {
    // 重試 exhausted（DB 層異常等）→ 唔好卡死 WRITING：標 FAILED（staff 可撳〔重試〕重入）
    const d = job?.data;
    if (d?.bookingId) {
      await prisma.bookingRequest
        .updateMany({
          where: { id: d.bookingId, status: "PENDING", writeState: "WRITING" },
          data: { writeState: "FAILED", writeError: "job_failed" },
        })
        .catch(() => undefined);
    }
    log.error(
      { jobId: job?.id, bookingId: d?.bookingId, attempts: job?.attemptsMade, err: err?.message },
      "booking-write job failed (final) — writeState=FAILED（staff 可重試）"
    );
  });
  worker.on("error", (err) => {
    log.error({ queue: "booking-write", err: err.message }, "booking-write worker error — exiting for PM2 restart");
    process.exit(1);
  });

  return worker;
}

async function publishUpdated(b: Pick<BookRow, "id" | "conversationId" | "clinicId" | "providerName" | "requestedDate" | "requestedTime" | "timeOfDay" | "precheckPassed" | "createdAt">, extra: Record<string, unknown>): Promise<void> {
  const convRow = await prisma.conversation.findUnique({
    where: { id: b.conversationId },
    select: { id: true, clinicId: true, assigneeId: true, routedStaffId: true, routedGroupId: true },
  });
  if (!convRow) return;
  await publishConvEvent(convRef(convRow), "booking:updated", {
    conversationId: b.conversationId,
    clinicId: b.clinicId,
    booking: {
      id: b.id,
      providerName: b.providerName,
      requestedDate: b.requestedDate,
      requestedTime: b.requestedTime,
      timeOfDay: b.timeOfDay,
      precheckPassed: b.precheckPassed,
      createdAt: b.createdAt,
      ...extra,
    },
  }).catch((e) => log.warn({ bookingId: b.id, err: e instanceof Error ? e.message : String(e) }, "booking-write: publish booking:updated failed"));
}

async function createNotice(
  clinicId: string,
  conversationId: string,
  kind: "HANDOFF_REQUEST" | "BOOKING_AUTO" | "SYSTEM",
  title: string,
  meta: Record<string, string | number | null | undefined>
): Promise<void> {
  await prisma.staffNotice
    .create({ data: { clinicId, conversationId, kind, title, meta } })
    .then(async (_n) => {
      const convRow = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { id: true, clinicId: true, assigneeId: true, routedStaffId: true, routedGroupId: true },
      });
      if (convRow) {
        await publishConvEvent(convRef(convRow), "notice:new", { conversationId, kind }).catch(() => undefined);
      }
    })
    .catch((e) => log.warn({ clinicId, err: e instanceof Error ? e.message : String(e) }, "booking-write: StaffNotice create failed"));
}

async function processBookingWriteJob(job: Job<BookingWriteJobData>): Promise<void> {
  const { bookingId, actor, visitReasonId, visitReasonCode, triggerMsgId } = job.data;
  const isStaff = actor.type === "STAFF";
  const actorMeta = isStaff ? { staffId: actor.staffId } : { sessionId: actor.sessionId };

  const booking = (await prisma.bookingRequest.findUnique({ where: { id: bookingId } })) as BookRow | null;
  if (!booking) {
    log.warn({ bookingId, jobId: job.id }, "booking-write: booking not found（deleted?）— skip");
    return;
  }
  // 冪等 / stale guard：已 CONFIRMED（重投）→ skip；非 PENDING 或 writeState 唔係 WRITING（rollback/改期/並發）→ skip
  if (booking.status === "CONFIRMED") {
    log.info({ bookingId, jobId: job.id, ...actorMeta }, "booking-write: already CONFIRMED — skip（idempotent replay）");
    return;
  }
  if (booking.status !== "PENDING" || booking.writeState !== "WRITING") {
    log.info({ bookingId, jobId: job.id, status: booking.status, writeState: booking.writeState, ...actorMeta }, "booking-write: stale job（status/writeState 已變）— skip");
    return;
  }

  const conv = await prisma.conversation.findUnique({ where: { id: booking.conversationId } });
  const clinic = await prisma.clinic.findUnique({ where: { id: booking.clinicId } });
  // ★ S5-14⑦：確認文字加診所名 + 地址（greetingConfig.address — 冇就舊文字）
  const clinicText = { clinicName: clinic?.name ?? null, clinicAddress: clinicAddressFromGreetingConfig((clinic?.greetingConfig ?? null) as Record<string, unknown> | null) };
  if (!conv || !clinic || !conv.pinnedPatientApricotId || !booking.requestedTime) {
    // fail-closed：前置已唔成立（pinned 移除 / conv 刪除 / 時段缺）→ FAILED（唔重試 — 重試都係一樣）
    await prisma.bookingRequest
      .update({ where: { id: bookingId }, data: { writeState: "FAILED", writeError: "precondition" } })
      .catch(() => undefined);
    log.error({ bookingId, ...actorMeta }, "booking-write: precondition lost — writeState=FAILED");
    await publishUpdated(booking, { status: booking.status, writeState: "FAILED", writeError: "precondition" });
    return;
  }

  // ── ★ 冪等 key（S5-1）：wa-inbox-${id}-${idemAttempt}-${slotHash} — 重試同 key → 同 apricotApptId ──
  const durationMin = resolveDurationMin({});
  const slotHash = createHash("sha256")
    .update(`${booking.providerApricotId}|${booking.requestedDate}|${booking.requestedTime}|${durationMin}`)
    .digest("hex")
    .slice(0, 8);
  const idempotencyKey = `wa-inbox-${booking.id}-${booking.idemAttempt}-${slotHash}`;

  let created: Awaited<ReturnType<typeof createBooking>>;
  try {
    created = await createBooking({
      idempotencyKey,
      clinicCode: clinic.code,
      providerApricotId: booking.providerApricotId,
      date: booking.requestedDate,
      start: booking.requestedTime,
      durationMin,
      visitReasonId,
      remarks: buildRemarks(booking.chiefComplaint, visitReasonCode),
      patient: { patientApricotId: conv.pinnedPatientApricotId },
    });
  } catch (err) {
    if (err instanceof WorkforceOutcomeUnknown) {
      // ★ S5-1：timeout / 結果未知 — 唔好人手落單（可能已寫到）；重試 = 同一 idempotencyKey（冪等安全）
      await prisma.bookingRequest
        .update({ where: { id: bookingId }, data: { writeState: "UNKNOWN", writeError: "timeout" } })
        .catch(() => undefined);
      log.warn({ bookingId, ...actorMeta }, "booking-write: outcome unknown（timeout）— writeState=UNKNOWN");
      await createNotice(
        conv.clinicId,
        conv.id,
        "HANDOFF_REQUEST",
        `未確定 Apricot 有冇落到單（${booking.requestedDate} ${booking.requestedTime} ${booking.providerName}）— 唔好人手落單，請撳〔重試〕（同一單號）`,
        { bookingId, ...(!isStaff ? { sessionId: actor.sessionId } : {}) },
      );
      if (!isStaff && triggerMsgId) {
        await aiPatientReply(conv, clinic.id, triggerMsgId, actor.sessionId, "收到！職員會好快幫你確認 🙂");
      }
      await publishUpdated(booking, { status: booking.status, writeState: "UNKNOWN", writeError: "timeout" });
      return;
    }
    // 確定性失敗（SLOT_TAKEN / WRITE_DISABLED / NEW_PATIENT_DISABLED / 400 / …）
    const code = err instanceof WorkforceApiError ? (err.code ?? `HTTP_${err.status}`) : "UNKNOWN_ERROR";
    await prisma.bookingRequest
      .update({ where: { id: bookingId }, data: { writeState: "FAILED", writeError: code.slice(0, 64) } })
      .catch(() => undefined);
    log.warn({ bookingId, code, ...actorMeta }, "booking-write: deterministic failure — writeState=FAILED");
    if (!isStaff) {
      await createNotice(
        conv.clinicId,
        conv.id,
        "HANDOFF_REQUEST",
        `AI 自動落單失敗（${code}）— 請人手處理`,
        { bookingId, sessionId: actor.sessionId },
      );
      if (triggerMsgId) {
        await aiPatientReply(conv, clinic.id, triggerMsgId, actor.sessionId, "收到！職員會好快幫你確認 🙂");
      }
    }
    await publishUpdated(booking, { status: booking.status, writeState: "FAILED", writeError: code.slice(0, 64) });
    return;
  }

  // ── ★ S5-6：條件 CONFIRMED（PENDING + WRITING）— 與〔已人手落單〕並發時 count=0 → 唔雙發訊息 ──
  const now = new Date();
  const upd = await prisma.bookingRequest.updateMany({
    where: { id: bookingId, status: "PENDING", writeState: "WRITING" },
    data: {
      status: "CONFIRMED",
      apricotApptId: created.apricotApptId,
      visitReasonCode,
      handledByStaffId: isStaff ? actor.staffId : null,
      handledAt: now,
      // ★ Phase C：L4 AI 自動落單標記（staff 三掣 = false）
      autoBooked: !isStaff,
      writeState: null,
      writeError: null,
    },
  });
  if (upd.count !== 1) {
    log.info({ bookingId, apricotApptId: created.apricotApptId, ...actorMeta }, "booking-write: conditional CONFIRMED count=0（並發已 CONFIRMED）— skip post-processing");
    return;
  }

  // ── 審計（零 PII：id + Apricot 單號 + visit reason code）──
  await prisma.auditLog
    .create({
      data: {
        staffId: isStaff ? actor.staffId : null, // AI 自動 = null（無 staff 參與）
        action: isStaff ? "BOOKING_CREATE" : "AI_AUTO_BOOKING",
        entity: "BookingRequest",
        entityId: booking.id,
        meta: {
          conversationId: booking.conversationId,
          clinicId: booking.clinicId,
          apricotApptId: created.apricotApptId,
          visitReasonCode,
          date: booking.requestedDate,
          ...(!isStaff ? { sessionId: actor.sessionId } : {}),
        },
      },
    })
    .catch(() => undefined);

  await afterBookingWrite(booking.clinicId, [booking.requestedDate], booking.conversationId, "CREATED", booking.requestedDate);

  const staffName = isStaff
    ? ((await prisma.staffUser.findUnique({ where: { id: actor.staffId }, select: { name: true } }))?.name ?? null)
    : null;

  // R2：publish 喺 commit 之後（CONFIRMED 態）
  await publishUpdated(booking, {
    status: "CONFIRMED",
    apricotApptId: created.apricotApptId,
    visitReasonCode,
    handledByStaffName: staffName,
    handledAt: now.toISOString(),
  });

  // ── actor 後處理 ────────────────────────────────────────────────
  if (!isStaff) {
    // AI：BOOKING_AUTO notice（同舊 runner 行為）+ L4_CONFIRM gate 確認訊息
    const m = booking.requestedDate.split("-");
    const title = `AI 已自動落單 ${Number(m[1])}月${Number(m[2])}日 ${booking.requestedTime ?? ""} ${booking.providerName ?? ""}`
      .replace(/\s+/g, " ")
      .trim();
    await createNotice(conv.clinicId, conv.id, "BOOKING_AUTO", title, { bookingId, sessionId: actor.sessionId });
    if (!triggerMsgId) {
      // fail-closed：冇觸發訊息 → 唔自動發（staff 見 BOOKING_AUTO notice 手覆）
      log.error({ bookingId, sessionId: actor.sessionId }, "booking-write: AI CONFIRMED missing triggerMsgId（fail-closed：無 auto message）");
      return;
    }
    // ★ S4-2：L4 自動確認必經原子閘（source=L4_CONFIRM / minLevel=L4）。
    //   偏離記錄（S5-1 async）：gate 喺 worker 跑（非同 turn）— 若同 turn 已有 OUT 覆病人，
    //   already-answered 擋住 = 病人已被覆過（唔雙發確認）；staff 有 BOOKING_AUTO notice。
    const r = await sendAutoIfStillEligible({
      convId: conv.id,
      clinicId: clinic.id,
      triggerMsgId,
      levelCategory: "BOOKING_REQUEST",
      minLevel: "L4",
      text: confirmMessageText({ ...booking, ...clinicText }),
      source: "L4_CONFIRM",
      bookingSessionId: actor.sessionId,
    }).catch((e) => ({ sent: false as const, reason: `gate-error:${e instanceof Error ? e.message : String(e)}` }));
    if (r.sent) {
      await enqueueUncertainOk(r.messageId);
      log.info({ bookingId, messageId: r.messageId, sessionId: actor.sessionId }, "booking-write: AI confirmation message queued (send-time gate)");
    } else {
      log.info({ bookingId, reason: r.reason, sessionId: actor.sessionId }, "booking-write: AI confirmation skipped at send-time gate（booking CONFIRMED，staff 手覆）");
    }
    return;
  }

  // STAFF：24h 窗口內 → 自動確認訊息（clientMessageId = uuidv5 — S5-6 雙擊物理擋）
  const win = getWindowState(conv.lastInboundAt);
  if (!win.open) {
    // 過窗：booking CONFIRMED 但唔自動發 → SYSTEM notice 提示 staff 用 utility template 覆
    await createNotice(
      conv.clinicId,
      conv.id,
      "SYSTEM",
      `預約已 CONFIRMED（${booking.requestedDate} ${booking.requestedTime} ${booking.providerName}）— 24 小時客服窗口已過，請用確認 utility template 覆病人`,
      { bookingId, apricotApptId: created.apricotApptId },
    );
    log.info({ bookingId, ...actorMeta }, "booking-write: window closed — 無 auto message（SYSTEM notice）");
    return;
  }
  const clientMessageId = bookingConfirmClientMessageId(booking.id, booking.idemAttempt);
  let msg: { id: string } | null = null;
  try {
    msg = await prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: "OUT",
        channel: "API",
        type: "text",
        body: confirmMessageText({ ...booking, ...clinicText }),
        status: "QUEUED",
        sentByStaffId: actor.staffId,
        aiAutoSent: false,
        billingCategory: "SERVICE",
        waTimestamp: now,
        // ★ S5-6：uuidv5 冪等 — 同 booking + 同 idemAttempt 重複 INSERT → P2002 物理擋（雙擊/重投零雙發）
        clientMessageId,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      log.warn({ bookingId, clientMessageId, ...actorMeta }, "booking-write: 確認訊息 P2002（clientMessageId 重複）— 已發過，skip");
      return;
    }
    log.error({ bookingId, err: err instanceof Error ? err.message : String(err), ...actorMeta }, "booking-write: 確認訊息寫入失敗（CONFIRMED，staff 手動覆）");
    return;
  }
  await enqueueUncertainOk(msg!.id);
  await prisma.$executeRaw`
    UPDATE "Conversation" SET "lastMessageAt" = GREATEST("lastMessageAt", ${now}) WHERE "id" = ${conv.id}`;
  log.info({ bookingId, messageId: msg!.id, clientMessageId, ...actorMeta }, "booking-write: STAFF confirmation message queued");
}

/** AI 路徑病人中性感（失敗/未知）— 同 sendSessionReply 口徑（gate BOOKING_SESSION / L3）。 */
async function aiPatientReply(
  conv: { id: string; clinicId: string },
  clinicId: string,
  triggerMsgId: string,
  sessionId: string,
  text: string,
): Promise<void> {
  try {
    const r = await sendAutoIfStillEligible({
      convId: conv.id,
      clinicId,
      triggerMsgId,
      levelCategory: "BOOKING_REQUEST",
      minLevel: "L3",
      source: "BOOKING_SESSION",
      bookingSessionId: sessionId,
      text,
    });
    if (r.sent) await enqueueUncertainOk(r.messageId);
  } catch (e) {
    log.warn({ convId: conv.id, err: e instanceof Error ? e.message : String(e) }, "booking-write: AI patient reply failed（best-effort）");
  }
}

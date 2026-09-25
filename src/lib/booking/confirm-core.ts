/**
 * ★ AI Workflow Phase C（cwi-sess-20260824-c1）：落單共用 core（C5 — L4 AI 同 staff 三掣共用同一份）。
 *
 * ★ cwi-final S5-1（F1）：async 化 — createBooking 搬去 booking-write worker（concurrency 1）：
 * - core 只做前置校驗 + visit reason 解析 + **條件 claim**（PENDING + writeState null/FAILED/UNKNOWN
 *   → WRITING，count≠1 = write_in_progress）+ enqueue booking-write job（jobId 冪等）；
 * - API 回 202 {state:"WRITING"}；CONFIRMED / UNKNOWN / FAILED + 審計 + StaffNotice + 確認訊息
 *   全部由 worker 做（src/workers/booking-write.worker.ts）— worker 失敗 = 落 writeState，唔 throw。
 * - 冪等：idemAttempt 唔會自動加一（重試 = 同一試次）→ idempotencyKey = wa-inbox-${id}-${idemAttempt}-${slotHash}
 *   重試唔變 → workforce 冪等重放 → 同 apricotApptId（mock 同）；clientMessageId = uuidv5 同值。
 *
 * actor 差異（job data 帶住，worker 內 switch）：
 * | | STAFF | AI |
 * |---|---|---|
 * | AuditLog action | BOOKING_CREATE | AI_AUTO_BOOKING（staffId=null，meta 加 sessionId） |
 * | handledByStaffId | staffId | null |
 * | autoBooked | false | true（Phase E rollback 統計鈎） |
 * | 確認訊息 sentByStaffId | staffId | null + aiAutoSent=true + bookingSessionId（sendAutoIfStillEligible gate） |
 *
 * 簽名偏離（記錄）：
 * - 成功回 { ok: true, state: "WRITING" }（同步成功分支已搬去 worker — MD 簽名嘅 autoMessage 改由
 *   route 層映射 202 / worker 側 StaffNotice 覆蓋）
 * - 失敗：QUEUE_UNAVAILABLE（route 映射：create 503 / manual 200 ok:true）/ PRECONDITION（code 供路由分支）
 *
 * ★ 失敗時 AI 路徑由 runner 降級（StaffNotice + 中性覆）— core 永不自動重試（鐵律沿用）。
 * ★ PII：log metadata only（booking/clinic id、workforce status/code、actor id）— 零訊息原文。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { enqueueBookingWriteJob, QueueUnavailableError } from "@/lib/queue";
import { defaultVisitReasonCode, fetchDictionaries } from "@/lib/workforce/client";

export type ConfirmActor = { type: "STAFF"; staffId: string } | { type: "AI"; sessionId: string };

export type ConfirmResult =
  | { ok: true; state: "WRITING" }
  | { ok: false; kind: "QUEUE_UNAVAILABLE"; message: string }
  | { ok: false; kind: "PRECONDITION"; message: string; code: string };

/** env default code（如 0010）→ dictionaries apricotId（createBooking 要 apricotId） */
async function resolveDefaultVisitReasonId(): Promise<{ apricotId: string; code: string } | null> {
  const code = defaultVisitReasonCode();
  if (!code) return null;
  const dict = await fetchDictionaries("VISIT_REASON");
  const item = dict.items.find((i) => i.code === code);
  return item ? { apricotId: item.apricotId, code: item.code } : null;
}

/**
 * ★ cwi-final S5-1（F1）：claim 前置校驗 + 條件 WRITING + enqueue booking-write。
 * 冪等：claim 係條件 updateMany（雙擊/並發第二枝 count=0 → write_in_progress）；
 * enqueue jobId = bw-${bookingId}-${idemAttempt}-${claimNonce} — BullMQ 預設 keepJobs={count:-1} 會保留
 * 已完成 job 嘅 hash → 穩定 jobId 令 retry enqueue 被當重複 no-op（booking 卡死 WRITING，T670 實測）；
 * 真正去重 = 條件 claim（雙擊第二次 claim 失敗 → write_in_progress，唔會雙 enqueue）。
 */
export async function confirmBookingCore(
  bookingId: string,
  actor: ConfirmActor,
  opts?: { visitReasonId?: string; /** AI actor 必帶 — 觸發呢輪確認嘅病人訊息（worker gate 用） */ triggerMsgId?: string }
): Promise<ConfirmResult> {
  const booking = await prisma.bookingRequest.findUnique({ where: { id: bookingId } });
  if (!booking) return { ok: false, kind: "PRECONDITION", message: "not found", code: "not_found" };
  if (booking.status !== "PENDING")
    return { ok: false, kind: "PRECONDITION", message: `booking already ${booking.status}`, code: "booking_not_pending" };

  const conv = await prisma.conversation.findUnique({ where: { id: booking.conversationId } });
  const clinic = await prisma.clinic.findUnique({ where: { id: booking.clinicId } });
  if (!conv || !clinic)
    return { ok: false, kind: "PRECONDITION", message: "conversation missing", code: "conversation_missing" };

  // 鐵律 A：只對已釘住舊客（pinnedPatientApricotId）先可以落單（STAFF 路徑 route 已擋；呢度 defense）
  if (!conv.pinnedPatientApricotId)
    return {
      ok: false,
      kind: "PRECONDITION",
      message: "要喺側欄先釘住舊客先可以代落單",
      code: "no_pinned_patient",
    };

  // ── visit reason 解析（STAFF：body 揀咗嘅；AI：env default code）— 快照落 job data（worker 唔再查 dictionaries）──
  let visitReasonId = typeof opts?.visitReasonId === "string" ? opts.visitReasonId.trim() : "";
  let visitReasonCode: string | null = null;
  if (visitReasonId) {
    // 回查 dictionaries 攞 code（審計 + remarks 用）
    const dict = await fetchDictionaries("VISIT_REASON");
    const item = dict.items.find((i) => i.apricotId === visitReasonId);
    if (!item)
      return { ok: false, kind: "PRECONDITION", message: "visit reason 唔喺 dictionaries 入面", code: "unknown_visit_reason" };
    visitReasonCode = item.code;
  } else {
    const def = await resolveDefaultVisitReasonId();
    if (!def)
      return {
        ok: false,
        kind: "PRECONDITION",
        message: "未設 BOOKING_DEFAULT_VISIT_REASON_CODE — 請喺卡上揀 visit reason",
        code: "visit_reason_required",
      };
    visitReasonId = def.apricotId;
    visitReasonCode = def.code;
  }

  // 純收需求變體（requestedTime = null）：workforce create 需要具體 start
  if (!booking.requestedTime)
    return {
      ok: false,
      kind: "PRECONDITION",
      message: "純收需求變體（無具體時段）— 請用〔改期 · 重發 Flow〕收齊時段先落單",
      code: "time_unresolved",
    };

  const isStaff = actor.type === "STAFF";
  const actorMeta = isStaff ? { staffId: actor.staffId } : { sessionId: actor.sessionId };

  // ── ★ 條件 claim：PENDING + writeState ∈ {null, FAILED, UNKNOWN} → WRITING（雙擊/並發第二枝 count=0）──
  const claim = await prisma.bookingRequest.updateMany({
    where: {
      id: booking.id,
      status: "PENDING",
      OR: [{ writeState: null }, { writeState: { in: ["FAILED", "UNKNOWN"] } }],
    },
    data: { writeState: "WRITING", writeAttemptAt: new Date(), writeError: null },
  });
  if (claim.count !== 1) {
    log.info({ bookingId: booking.id, clinicId: booking.clinicId, ...actorMeta }, "bookings: create — write_in_progress（claim 唔到）");
    return { ok: false, kind: "PRECONDITION", message: "落單處理緊 — 請等結果", code: "write_in_progress" };
  }

  // ── enqueue booking-write job ──
  // ★ jobId 帶 claim nonce（原因見文件頭：穩定 jobId + keepJobs=-1 → retry enqueue no-op）
  const claimNonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  try {
    await enqueueBookingWriteJob(
      {
        bookingId: booking.id,
        actor: isStaff ? { type: "STAFF", staffId: actor.staffId } : { type: "AI", sessionId: actor.sessionId },
        visitReasonId,
        visitReasonCode,
        triggerMsgId: opts?.triggerMsgId ?? null,
      },
      `bw-${booking.id}-${booking.idemAttempt}-${claimNonce}`,
    );
  } catch (err) {
    // queue 唔可用（Redis 斷 / flag hook）→ rollback writeState（card 可以正常重試）
    await prisma.bookingRequest
      .updateMany({
        where: { id: booking.id, status: "PENDING", writeState: "WRITING" },
        data: { writeState: null, writeAttemptAt: null },
      })
      .catch(() => undefined);
    const queueDown = err instanceof QueueUnavailableError;
    log.error(
      { bookingId: booking.id, clinicId: booking.clinicId, queueDown, err: err instanceof Error ? err.message : String(err), ...actorMeta },
      "bookings: create — enqueue booking-write failed（rollback WRITING）"
    );
    return { ok: false, kind: "QUEUE_UNAVAILABLE", message: "booking queue 暫時唔可用 — 請重試" };
  }

  log.info({ bookingId: booking.id, clinicId: booking.clinicId, ...actorMeta }, "bookings: create — WRITING（booking-write job enqueued）");
  return { ok: true, state: "WRITING" };
}

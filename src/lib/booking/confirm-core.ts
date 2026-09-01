/**
 * ★ AI Workflow Phase C（cwi-sess-20260824-c1）：落單共用 core（C5 — L4 AI 同 staff 三掣共用同一份）。
 *
 * 由 POST /api/bookings/[id]/create route 原封搬以下段落（route 剩返 auth/RBAC/423 Send Lock/HTTP 映射）：
 * visit reason 解析（連 dictionaries 回查）+ createBooking call + WorkforceApiError 分類
 * + 成功後 bookingRequest.update（CONFIRMED + apricotApptId + visitReasonCode + handledBy/At + autoBooked）
 * → AuditLog → afterBookingWrite → publishNotify("booking:updated") → 窗口內自動確認訊息（outbound enqueue）。
 *
 * actor 差異（core 內 switch）：
 * | | STAFF | AI |
 * |---|---|---|
 * | AuditLog action | BOOKING_CREATE（照舊） | AI_AUTO_BOOKING（staffId=null，meta 加 sessionId） |
 * | handledByStaffId | staffId | null |
 * | autoBooked | false | true（Phase E rollback 統計鈎） |
 * | 確認訊息 sentByStaffId | staffId | null + aiAutoSent=true + bookingSessionId |
 *
 * 簽名偏離（記錄）：
 * - 成功回 autoMessage: { sent: true, messageId } | { sent: false, reason: "window_closed" | "queue_unavailable" }
 *   （MD 簽名只 autoMessageSent: boolean — 不足以映射 route 三枝 200/422/503 response）
 * - 失敗加 code?: string（route 422/503/400 response 需要 workforce 錯誤碼 / 400 error key）
 *
 * ★ 失敗時 AI 路徑由 runner 降級（CREATE_CARD + StaffNotice）— core 永不自動重試（鐵律沿用）。
 * ★ PII：log metadata only（booking/clinic id、workforce status/code、actor id）— 零訊息原文。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { getWindowState } from "@/lib/wa/window";
import { outboundQueue } from "@/lib/queue";
import { publishNotify } from "@/lib/notify";
import { afterBookingWrite } from "./booking-ops";
import { buildRemarks, confirmMessageText } from "./booking-text";
import { WorkforceApiError, createBooking, defaultVisitReasonCode, fetchDictionaries } from "@/lib/workforce/client";

const ENQUEUE_TIMEOUT_MS = 1500;
/** 預約時長（分鐘）— Flow 唔收時長；固定 15 分鐘（TODO：上線前同老細確認逐舖時長） */
const DEFAULT_DURATION_MIN = 15;

export type ConfirmActor = { type: "STAFF"; staffId: string } | { type: "AI"; sessionId: string };

export type ConfirmResult =
  | {
      ok: true;
      apricotApptId: string;
      autoMessage: { sent: true; messageId: string } | { sent: false; reason: "window_closed" | "queue_unavailable" };
    }
  | {
      ok: false;
      kind: "SLOT_TAKEN" | "MANUAL_REQUIRED" | "WRITE_DISABLED" | "WORKFORCE_DOWN" | "PRECONDITION";
      message: string;
      code?: string;
    };

/** env default code（如 0010）→ dictionaries apricotId（createBooking 要 apricotId） */
async function resolveDefaultVisitReasonId(): Promise<{ apricotId: string; code: string } | null> {
  const code = defaultVisitReasonCode();
  if (!code) return null;
  const dict = await fetchDictionaries("VISIT_REASON");
  const item = dict.items.find((i) => i.code === code);
  return item ? { apricotId: item.apricotId, code: item.code } : null;
}

export async function confirmBookingCore(
  bookingId: string,
  actor: ConfirmActor,
  opts?: { visitReasonId?: string }
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

  // ── visit reason 解析（STAFF：body 揀咗嘅；AI：env default code）──
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

  // ★ 代落單（workforce 冪等 key = 本 BookingRequest 行 — retry 唔會雙單）
  const now = new Date();
  const isStaff = actor.type === "STAFF";
  const actorMeta = isStaff ? { staffId: actor.staffId } : { sessionId: actor.sessionId };
  let apricotApptId: string;
  try {
    const created = await createBooking({
      idempotencyKey: `wa-inbox-${booking.id}`,
      clinicCode: clinic.code,
      providerApricotId: booking.providerApricotId,
      date: booking.requestedDate,
      start: booking.requestedTime,
      durationMin: DEFAULT_DURATION_MIN,
      visitReasonId,
      remarks: buildRemarks(booking.chiefComplaint, visitReasonCode),
      patient: { patientApricotId: conv.pinnedPatientApricotId },
    });
    apricotApptId = created.apricotApptId;
  } catch (err) {
    // log 只 path + status（鐵律）— 錯誤碼只入 result 供 caller 分支
    const status = err instanceof WorkforceApiError ? err.status : 502;
    const code = err instanceof WorkforceApiError ? err.code : undefined;
    log.warn(
      { bookingId: booking.id, clinicId: booking.clinicId, workforceStatus: status, code, ...actorMeta },
      "bookings: create — workforce write failed"
    );
    if (status === 409) return { ok: false, kind: "SLOT_TAKEN", message: "時段啱啱滿咗" };
    if (status === 422)
      return {
        ok: false,
        kind: "MANUAL_REQUIRED",
        code: code ?? "NEW_PATIENT_DISABLED",
        message:
          code === "NEW_PATIENT_WRITE_DISABLED" || code === "NEW_PATIENT_DISABLED"
            ? "Apricot 未開新客代落單 — 請人手喺 Apricot 落單，然後撳〔已人手落單〕"
            : "Workforce 拒絕 — 請人手喺 Apricot 落單",
      };
    if (status === 503)
      return { ok: false, kind: "WRITE_DISABLED", code, message: "Workforce 寫入暫時停用 — 請人手喺 Apricot 落單" };
    return { ok: false, kind: "WORKFORCE_DOWN", message: "Workforce 落單失敗 — 請人手喺 Apricot 落單" };
  }

  // ── 成功：CONFIRMED + 審計 + 即時刷新三步 ─────────────────────────
  await prisma.bookingRequest.update({
    where: { id: booking.id },
    data: {
      status: "CONFIRMED",
      apricotApptId,
      visitReasonCode,
      handledByStaffId: isStaff ? actor.staffId : null,
      handledAt: now,
      // ★ Phase C：L4 AI 自動落單標記（staff 三掣 / 普通 Flow 路徑 = false）
      autoBooked: !isStaff,
    },
  });
  await prisma.auditLog
    .create({
      data: {
        staffId: isStaff ? actor.staffId : null, // AI 自動 = null（無 staff 參與）
        action: isStaff ? "BOOKING_CREATE" : "AI_AUTO_BOOKING",
        entity: "BookingRequest",
        entityId: booking.id,
        // 零 PII：只 booking/clinic/conversation id + Apricot 單號 + visit reason code（AI 加 sessionId）
        meta: {
          conversationId: booking.conversationId,
          clinicId: booking.clinicId,
          apricotApptId,
          visitReasonCode,
          date: booking.requestedDate,
          ...(isStaff ? {} : { sessionId: actor.sessionId }),
        },
      },
    })
    .catch(() => undefined);

  await afterBookingWrite(booking.clinicId, [booking.requestedDate], booking.conversationId, "CREATED", booking.requestedDate);

  const staffName = isStaff
    ? ((await prisma.staffUser.findUnique({ where: { id: actor.staffId }, select: { name: true } }))?.name ?? null)
    : null;

  publishNotify(booking.clinicId, "booking:updated", {
    conversationId: booking.conversationId,
    clinicId: booking.clinicId,
    booking: {
      id: booking.id,
      providerName: booking.providerName,
      requestedDate: booking.requestedDate,
      requestedTime: booking.requestedTime,
      timeOfDay: booking.timeOfDay,
      precheckPassed: booking.precheckPassed,
      status: "CONFIRMED",
      createdAt: booking.createdAt,
      apricotApptId,
      visitReasonCode,
      handledByStaffName: staffName,
      handledAt: now.toISOString(),
    },
  });

  // ── 自動確認訊息（同 confirm route 語義）──────────────────────────
  const win = getWindowState(conv.lastInboundAt);
  if (!win.open) {
    log.info(
      { bookingId: booking.id, clinicId: booking.clinicId, ...actorMeta },
      "bookings: create — window closed, template required（booking 已 CONFIRMED）"
    );
    return { ok: true, apricotApptId, autoMessage: { sent: false, reason: "window_closed" } };
  }

  try {
    const msg = await prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: "OUT",
        channel: "API",
        type: "text",
        body: confirmMessageText(booking),
        status: "QUEUED",
        sentByStaffId: isStaff ? actor.staffId : null,
        aiAutoSent: !isStaff, // ★ Phase C：AI 自動確認 = true
        bookingSessionId: isStaff ? null : actor.sessionId, // ★ Phase C：追溯 session 回覆
        // cwi-window-20260901（P1）：確認預約覆（窗口內）= SERVICE
        billingCategory: "SERVICE",
        waTimestamp: now,
      },
    });
    await Promise.race([
      outboundQueue.add("send", { messageId: msg.id }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("enqueue timeout")), ENQUEUE_TIMEOUT_MS)),
    ]);
    await prisma.$executeRaw`
      UPDATE "Conversation" SET "lastMessageAt" = GREATEST("lastMessageAt", ${now}) WHERE "id" = ${conv.id}`;
    log.info(
      { bookingId: booking.id, messageId: msg.id, clinicId: booking.clinicId, ...actorMeta },
      "bookings: create — auto confirmation message queued"
    );
    return { ok: true, apricotApptId, autoMessage: { sent: true, messageId: msg.id } };
  } catch (err) {
    log.error(
      { bookingId: booking.id, err: err instanceof Error ? err.message : String(err), ...actorMeta },
      "bookings: create — auto message enqueue failed（狀態已 CONFIRMED，staff 手動覆）"
    );
    return { ok: true, apricotApptId, autoMessage: { sent: false, reason: "queue_unavailable" } };
  }
}

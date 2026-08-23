/**
 * POST /api/bookings/[id]/create — 代落單（booking-ui D：卡上〔幫我喺 Apricot 落單〕）
 *
 * 狀態機：只 PENDING（其餘 409）。必要條件：
 * - 對話已釘住舊客（pinnedPatientApricotId — 藍掣只喺已釘住時出現；API 層再擋一道）
 * - visitReasonId（body 揀咗嘅 dictionaries apricotId；冇 body → env default code 解析）
 *
 * 成功（workforce 200）：
 * - BookingRequest → CONFIRMED + apricotApptId + visitReasonCode + handledBy/At
 * - AuditLog BOOKING_CREATE（meta 零 PII：只 id/date/code）
 * - 即時刷新三步（booking-ops：L2 invalidate → booking:updated + booking:changed CREATED）
 * - 自動確認訊息（同 confirm route 語義：窗口內 free-form；過窗 → 422 hint 用 template，
 *   booking 照樣 CONFIRMED — 人已喺 Apricot 落咗單）
 *
 * workforce 錯誤分支（MD §3 + 鐵律 6）：
 * - 409 SLOT_TAKEN → 409（卡紅字「時段啱啱滿咗」+ 〔重發 Flow〕）
 * - 422 NEW_PATIENT_DISABLED 等 → 422 人手指示 variant
 * - 503 WRITE_DISABLED / APRICOT_BUSY → 503 人手指示
 * - 502 APRICOT_ERROR / 其他 → 502 人手指示
 *
 * 權限：assertClinicAccess（同 confirm route — MD §7 嘅 Send Lock 只限撤銷/改期/取消三動作）。
 * 24h 窗口邏輯：窗口只影響「自動確認訊息」，唔影響落單本身（同 confirm 一致）。
 */
import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertClinicAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { getWindowState } from "@/lib/wa/window";
import { outboundQueue } from "@/lib/queue";
import { publishNotify } from "@/lib/notify";
import { afterBookingWrite } from "@/lib/booking/booking-ops";
import { buildRemarks, confirmMessageText } from "@/lib/booking/booking-text";
import {
  WorkforceApiError,
  createBooking,
  defaultVisitReasonCode,
  fetchDictionaries,
} from "@/lib/workforce/client";

export const dynamic = "force-dynamic";

const ENQUEUE_TIMEOUT_MS = 1500;
/** 預約時長（分鐘）— Flow 唔收時長；固定 15 分鐘（TODO：上線前同老細確認逐舖時長） */
const DEFAULT_DURATION_MIN = 15;

/** env default code（如 0010）→ dictionaries apricotId（createBooking 要 apricotId） */
async function resolveDefaultVisitReasonId(): Promise<{ apricotId: string; code: string } | null> {
  const code = defaultVisitReasonCode();
  if (!code) return null;
  const dict = await fetchDictionaries("VISIT_REASON");
  const item = dict.items.find((i) => i.code === code);
  return item ? { apricotId: item.apricotId, code: item.code } : null;
}

export const POST = handle(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;

  const booking = await prisma.bookingRequest.findUnique({ where: { id } });
  if (!booking) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertClinicAccess(ctx, booking.clinicId); // STAFF 別店 → 403

  if (booking.status !== "PENDING") {
    return NextResponse.json({ error: `booking already ${booking.status}` }, { status: 409 });
  }

  const conv = await prisma.conversation.findUnique({ where: { id: booking.conversationId } });
  const clinic = await prisma.clinic.findUnique({ where: { id: booking.clinicId } });
  if (!conv || !clinic) {
    return NextResponse.json({ error: "conversation missing" }, { status: 500 });
  }

  // 鐵律 A：只對已釘住舊客（pinnedPatientApricotId）先可以代落單
  if (!conv.pinnedPatientApricotId) {
    return NextResponse.json(
      { error: "no_pinned_patient", message: "要喺側欄先釘住舊客先可以代落單" },
      { status: 400 }
    );
  }

  // body：{ visitReasonId?: string }（dictionaries item 嘅 apricotId）
  const body = (await req.json().catch(() => ({}))) as { visitReasonId?: string };
  let visitReasonId = typeof body.visitReasonId === "string" ? body.visitReasonId.trim() : "";
  let visitReasonCode: string | null = null;
  if (visitReasonId) {
    // 回查 dictionaries 攞 code（審計 + remarks 用）— 找不到 → 400
    const dict = await fetchDictionaries("VISIT_REASON");
    const item = dict.items.find((i) => i.apricotId === visitReasonId);
    if (!item) {
      return NextResponse.json(
        { error: "unknown_visit_reason", message: "visit reason 唔喺 dictionaries 入面" },
        { status: 400 }
      );
    }
    visitReasonCode = item.code;
  } else {
    const def = await resolveDefaultVisitReasonId();
    if (!def) {
      return NextResponse.json(
        {
          error: "visit_reason_required",
          message: "未設 BOOKING_DEFAULT_VISIT_REASON_CODE — 請喺卡上揀 visit reason",
        },
        { status: 400 }
      );
    }
    visitReasonId = def.apricotId;
    visitReasonCode = def.code;
  }

  // 純收需求變體（requestedTime = null）：workforce create 需要具體 start — 擋返
  if (!booking.requestedTime) {
    return NextResponse.json(
      {
        error: "time_unresolved",
        message: "純收需求變體（無具體時段）— 請用〔改期 · 重發 Flow〕收齊時段先落單",
      },
      { status: 400 }
    );
  }

  // ★ 代落單（workforce 冪等 key = 本 BookingRequest 行 — retry 唔會雙單）
  const now = new Date();
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
    // log 只 path + status（鐵律 8）— 錯誤碼只入 response 供 UI 分支
    const status = err instanceof WorkforceApiError ? err.status : 502;
    const code = err instanceof WorkforceApiError ? err.code : undefined;
    log.warn(
      { bookingId: booking.id, clinicId: booking.clinicId, workforceStatus: status, code, staffId: ctx.staff.id },
      "bookings: create — workforce write failed"
    );
    if (status === 409) {
      return NextResponse.json(
        { error: "SLOT_TAKEN", message: "時段啱啱滿咗", retryable: true },
        { status: 409 }
      );
    }
    if (status === 422) {
      return NextResponse.json(
        {
          error: code ?? "NEW_PATIENT_DISABLED",
          manual: true,
          message:
            code === "NEW_PATIENT_WRITE_DISABLED" || code === "NEW_PATIENT_DISABLED"
              ? "Apricot 未開新客代落單 — 請人手喺 Apricot 落單，然後撳〔已人手落單〕"
              : "Workforce 拒絕 — 請人手喺 Apricot 落單",
        },
        { status: 422 }
      );
    }
    if (status === 503) {
      return NextResponse.json(
        { error: code ?? "WRITE_DISABLED", manual: true, message: "Workforce 寫入暫時停用 — 請人手喺 Apricot 落單" },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: "WORKFORCE_UNAVAILABLE", manual: true, message: "Workforce 落單失敗 — 請人手喺 Apricot 落單" },
      { status: 502 }
    );
  }

  // ── 成功：CONFIRMED + 審計 + 即時刷新三步 ─────────────────────────
  await prisma.bookingRequest.update({
    where: { id: booking.id },
    data: {
      status: "CONFIRMED",
      apricotApptId,
      visitReasonCode,
      handledByStaffId: ctx.staff.id,
      handledAt: now,
    },
  });
  await prisma.auditLog
    .create({
      data: {
        staffId: ctx.staff.id,
        action: "BOOKING_CREATE",
        entity: "BookingRequest",
        entityId: booking.id,
        // 零 PII：只 booking/clinic/conversation id + Apricot 單號 + visit reason code
        meta: {
          conversationId: booking.conversationId,
          clinicId: booking.clinicId,
          apricotApptId,
          visitReasonCode,
          date: booking.requestedDate,
        },
      },
    })
    .catch(() => undefined);

  await afterBookingWrite(booking.clinicId, [booking.requestedDate], booking.conversationId, "CREATED", booking.requestedDate);

  const staffName = (
    await prisma.staffUser.findUnique({ where: { id: ctx.staff.id }, select: { name: true } })
  )?.name ?? null;

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
      { bookingId: booking.id, clinicId: booking.clinicId, staffId: ctx.staff.id },
      "bookings: create — window closed, template required（booking 已 CONFIRMED）"
    );
    return NextResponse.json(
      {
        ok: true,
        confirmed: true,
        apricotApptId,
        autoMessage: {
          sent: false,
          reason: "window_closed",
          hint: "24 小時客服窗口已過 — 請用帶確認內容嘅 utility template 覆病人",
          suggestedText: confirmMessageText(booking),
        },
      },
      { status: 422 }
    );
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
        sentByStaffId: ctx.staff.id,
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
      { bookingId: booking.id, messageId: msg.id, clinicId: booking.clinicId, staffId: ctx.staff.id },
      "bookings: create — auto confirmation message queued"
    );
    return NextResponse.json({ ok: true, confirmed: true, apricotApptId, autoMessage: { sent: true, messageId: msg.id } });
  } catch (err) {
    log.error(
      { bookingId: booking.id, err: err instanceof Error ? err.message : String(err) },
      "bookings: create — auto message enqueue failed（狀態已 CONFIRMED，staff 手動覆）"
    );
    return NextResponse.json(
      {
        ok: true,
        confirmed: true,
        apricotApptId,
        autoMessage: { sent: false, reason: "queue_unavailable", hint: "請手動覆病人" },
      },
      { status: 503 }
    );
  }
});

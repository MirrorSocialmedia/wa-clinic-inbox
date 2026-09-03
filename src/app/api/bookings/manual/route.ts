/**
 * POST /api/bookings/manual — G-3（cwi-writeword-20260904）：D.3 人手落單（schedule-board 直接入 Apricot）
 *
 * 同代落單（/api/bookings/[id]/create）共用同一條寫入鏈：
 *   建 PENDING BookingRequest → confirmBookingCore（workforce create / CONFIRMED /
 *   AuditLog BOOKING_CREATE / L2 invalidate / booking:updated / 窗口內自動確認訊息）。
 *   卡／審計／刷新與代落單完全一致 — 唔另起爐灶（MD G-3.4）。
 *
 * 同 create route 嘅分別（入口差異）：
 * - 病人 = 既有對話嘅**已釘住舊客**（pinnedPatientApricotId — PHONE_HASH 路徑）；
 *   未釘住 → **422 NEW_PATIENT_DISABLED**（鐵律：ALLOW_NEW_PATIENT_WRITE off，新客寫入路徑唔存在）。
 *   （create route 對未釘住回 400 no_pinned_patient — 嗰邊係卡上代落單嘅前置提示；
 *    呢邊係主動落單入口，照鐵律語義回 422 + 指引側欄釘舊客。）
 * - 時段 = schedule-board 撳落嘅 ONLINE 格（date + start + provider）；
 *   必係未來時段（今日已過 / 過期日 → 400 slot_in_past）。
 * - visit reason = body 可選；唔帶 → BOOKING_DEFAULT_VISIT_REASON_CODE env 模式
 *   （跟 cwi-bkui 現狀 — board popover 唔設 picker）。
 *
 * 權限（跟代落單現狀 — MD §7）：assertConversationAccess（403）+ Send Lock
 *   （assignee 係其他人 → 423 SEND_LOCKED；rollback/cancel/reschedule 一致）。
 *
 * workforce 錯誤分支（同 create route）：
 *   409 SLOT_TAKEN（含 L2 預檢 / mock flag / F checkClash）｜422 MANUAL_REQUIRED（NEW_PATIENT_DISABLED 等）
 *   ｜503 WRITE_DISABLED｜502/其他 WORKFORCE_DOWN。
 *   失敗時 PENDING 行保留（同 Flow 路徑 — 側欄卡可重試；48h expiry 掃）。
 *
 * 15 分鐘時長 = confirmBookingCore 現狀偏離項 D-1（唔改）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertConversationAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { confirmBookingCore } from "@/lib/booking/confirm-core";
import { confirmMessageText } from "@/lib/booking/booking-text";

export const dynamic = "force-dynamic";

const ManualBody = z.object({
  conversationId: z.string().min(1),
  providerApricotId: z.string().min(1).max(200),
  providerName: z.string().min(1).max(200),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  visitReasonId: z.string().min(1).max(64).optional(),
});

/** HK 今日（YYYY-MM-DD）+ 而家 HH:mm — 未來時段檢查用（HK 日界） */
function hkTodayNow(): { date: string; hhmm: string } {
  const now = new Date();
  const hk = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => hk.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hhmm: `${get("hour")}:${get("minute")}` };
}

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const parsed = ManualBody.safeParse((await req.json().catch(() => null)) as unknown);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", details: parsed.error.flatten() }, { status: 400 });
  }
  const { conversationId, providerApricotId, providerName, date, start, visitReasonId } = parsed.data;

  const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertConversationAccess(ctx, conv); // 別店 / 非授權對話 → 403

  // Send Lock（MD §7 — 同 create/rollback/cancel）
  if (conv.assigneeId && conv.assigneeId !== ctx.staff.id) {
    log.info(
      { clinicId: conv.clinicId, conversationId, staffId: ctx.staff.id, assigneeId: conv.assigneeId },
      "bookings: manual — 423 SEND_LOCKED"
    );
    return NextResponse.json(
      { error: "SEND_LOCKED", message: "只有負責人可以代落單", assigneeId: conv.assigneeId },
      { status: 423 }
    );
  }

  // 鐵律：只可對已釘住舊客（PHONE_HASH 路徑）— 新客寫入路徑唔存在
  if (!conv.pinnedPatientApricotId) {
    return NextResponse.json(
      {
        error: "NEW_PATIENT_DISABLED",
        manual: true,
        message: "呢個對話未釘住舊客 — 請先喺側欄釘住現有病人先可以人手落單（新客代落單唔開放）",
      },
      { status: 422 }
    );
  }

  // 未來時段（SOP：落單揀未來非繁忙時段 — 過去時段唔准落）
  const { date: today, hhmm: nowHhmm } = hkTodayNow();
  if (date < today || (date === today && start <= nowHhmm)) {
    return NextResponse.json(
      { error: "slot_in_past", message: "呢個時段已經過去 — 請揀未來時段" },
      { status: 400 }
    );
  }

  // 建 PENDING 卡（同 Flow 路徑同形）→ 立即行代落單 core
  // - flowToken = manual-<uuid>（唔會同 Flow JWT 撞；nfm_reply 只匹配 Flow session）
  // - L2 預檢：slot 行存在且已佔 → 即刻 409（慳一次 workforce call；行唔喺 = 照行，
  //   最終防線 = F 側 checkClash / mock SLOT_TAKEN flag）
  // - 同 slot 已有 PENDING（Flow 路徑建）→ 409 pending_exists（防雙單 — 兩單同 slot 都喺 Apricot 會撞）
  const clinicId = conv.clinicId;
  // object holder（closure 入面 assign — TS 對 let 變量收窄會誤判 never）
  const txOut: {
    err: { status: number; body: Record<string, unknown> } | null;
    bookingId: string | null;
  } = { err: null, bookingId: null };
  try {
    await prisma.$transaction(
      async (tx) => {
        const slotRow = await tx.availabilitySlot.findUnique({
          where: {
            clinicId_providerApricotId_date_startTime: { clinicId, providerApricotId, date, startTime: start },
          },
        });
        if (slotRow && (!slotRow.isOpen || slotRow.bookedCount > 0)) {
          txOut.err = {
            status: 409,
            body: { error: "SLOT_TAKEN", message: "時段啱啱滿咗", retryable: true },
          };
          return;
        }
        const existingPending = await tx.bookingRequest.findFirst({
          where: { clinicId, providerApricotId, requestedDate: date, requestedTime: start, status: "PENDING" },
          select: { id: true },
        });
        if (existingPending) {
          txOut.err = {
            status: 409,
            body: { error: "pending_exists", message: "呢個時段已有待處理預約", bookingId: existingPending.id },
          };
          return;
        }
        const b = await tx.bookingRequest.create({
          data: {
            conversationId: conv.id,
            clinicId,
            flowToken: `manual-${randomUUID()}`,
            providerApricotId,
            providerName,
            requestedDate: date,
            requestedTime: start,
            precheckPassed: slotRow ? true : null,
            status: "PENDING",
            // 主訴快照（同 L4 AI 路徑 — aiSummary ≤50 字；無 = null → remarks 唔帶）
            chiefComplaint: conv.aiSummary?.slice(0, 50) ?? null,
          },
        });
        txOut.bookingId = b.id;
      },
      { timeout: 20_000 }
    );
  } catch (e) {
    log.error(
      { conversationId, clinicId, err: e instanceof Error ? e.message : String(e) },
      "bookings: manual — precheck tx failed"
    );
    return NextResponse.json({ error: "tx_error", message: "系統錯誤 — 請重試" }, { status: 500 });
  }
  if (txOut.err) {
    log.info(
      { clinicId, conversationId, staffId: ctx.staff.id, code: txOut.err.body.error as string },
      "bookings: manual — precheck blocked"
    );
    return NextResponse.json(txOut.err.body, { status: txOut.err.status });
  }

  // ★ 共用代落單 core（workforce 冪等 key = wa-inbox-<bookingId> — retry 唔會雙單）
  const result = await confirmBookingCore(txOut.bookingId!, { type: "STAFF", staffId: ctx.staff.id }, { visitReasonId });

  if (!result.ok) {
    if (result.kind === "PRECONDITION") {
      return NextResponse.json({ error: result.code, message: result.message }, { status: 400 });
    }
    if (result.kind === "SLOT_TAKEN") {
      return NextResponse.json({ error: "SLOT_TAKEN", message: "時段啱啱滿咗", retryable: true }, { status: 409 });
    }
    if (result.kind === "MANUAL_REQUIRED") {
      return NextResponse.json(
        { error: result.code ?? "NEW_PATIENT_DISABLED", manual: true, message: result.message },
        { status: 422 }
      );
    }
    if (result.kind === "WRITE_DISABLED") {
      return NextResponse.json(
        { error: result.code ?? "WRITE_DISABLED", manual: true, message: "Workforce 寫入暫時停用 — 請人手喺 Apricot 落單" },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: "WORKFORCE_UNAVAILABLE", manual: true, message: "Workforce 落單失敗 — 請人手喺 Apricot 落單" },
      { status: 502 }
    );
  }

  // ── 成功分支（映射同 create route；多帶 bookingId 畀 UI 追卡）─────────────
  const booking = await prisma.bookingRequest.findUnique({ where: { id: txOut.bookingId! } });
  if (result.autoMessage.sent) {
    return NextResponse.json({
      ok: true,
      confirmed: true,
      bookingId: txOut.bookingId,
      apricotApptId: result.apricotApptId,
      autoMessage: { sent: true, messageId: result.autoMessage.messageId },
    });
  }
  if (result.autoMessage.reason === "window_closed") {
    return NextResponse.json(
      {
        ok: true,
        confirmed: true,
        bookingId: txOut.bookingId,
        apricotApptId: result.apricotApptId,
        autoMessage: {
          sent: false,
          reason: "window_closed",
          hint: "24 小時客服窗口已過 — 請用帶確認內容嘅 utility template 覆病人",
          suggestedText: booking ? confirmMessageText(booking) : null,
        },
      },
      { status: 422 }
    );
  }
  return NextResponse.json(
    {
      ok: true,
      confirmed: true,
      bookingId: txOut.bookingId,
      apricotApptId: result.apricotApptId,
      autoMessage: { sent: false, reason: "queue_unavailable", hint: "請手動覆病人" },
    },
    { status: 503 }
  );
});

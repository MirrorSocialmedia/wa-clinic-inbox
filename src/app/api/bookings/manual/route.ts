/**
 * POST /api/bookings/manual — G-3（cwi-writeword-20260904）：D.3 人手落單（schedule-board 直接入 Apricot）
 *
 * ★ cwi-final S5-8①（F1）：排班表落單重複防護 —
 * - body `requestId: uuid`（UI 每次打開視窗生成；重試 = 同一 requestId）；
 * - `flowToken = manual-${requestId}`（FlowSession.flowToken @unique 慣例 — BookingRequest.flowToken @unique）
 *   → 同 requestId 重複 call 幂等：
 *     CONFIRMED → 200 返原單（零 workforce call）｜WRITING → 202｜FAILED/UNKNOWN/PENDING-null → 重試（同一單）；
 * - 同 pinned 病人（同對話）+ 同醫生 + 同日 + 同開始時間 已有 CONFIRMED / WRITING → 409 DUPLICATE_BOOKING；
 * - queue 不可用 → **200**（ok:true + autoMessage.queue_unavailable — 唔再 503）；
 * - 成功 = 202 { state: "WRITING" }（S5-1 async — 寫入喺 booking-write worker）。
 *
 * 同代落單（/api/bookings/[id]/create）共用同一條寫入鏈（confirmBookingCore 條件 claim + enqueue）：
 * 卡／審計／刷新與代落單完全一致 — 唔另起爐灶（MD G-3.4）。
 *
 * 入口差異（同 G-3 現狀）：
 * - 病人 = 既有對話嘅**已釘住舊客**（pinnedPatientApricotId）；未釘住 → 422 NEW_PATIENT_DISABLED
 * - 時段 = schedule-board 撳落嘅 ONLINE 格；必係未來時段（slot_in_past → 400）
 * - S3-9：providerApricotId 必須經 ProviderClinic 屬該對話嘅店（唔屬 → 400）
 * - 權限：assertConversationAccess（403）+ Send Lock（423）
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertConversationAccess, assertCanWriteConversation } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { confirmBookingCore } from "@/lib/booking/confirm-core";
import { slotAvailable } from "@/lib/availability";

export const dynamic = "force-dynamic";

const ManualBody = z.object({
  // ★ S5-8①：UI 視窗級冪等 id（重試 = 同一 requestId → 同一 flowToken → 零雙單）
  requestId: z.string().uuid(),
  conversationId: z.string().min(1),
  providerApricotId: z.string().min(1).max(200),
  // S3-9：名由 DB 讀（Provider.name）— body.providerName 只係 UI 兼容，唔再信任
  providerName: z.string().min(1).max(200).optional(),
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
  const { requestId, conversationId, providerApricotId, date, start, visitReasonId } = parsed.data;

  const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  await assertConversationAccess(ctx, conv); // 別店 / 非授權對話 → 403
  assertCanWriteConversation(ctx); // ★ cwi-routing-20260906 §8：SUPERVISOR 覆客 403

  // S3-9：provider 必須經 ProviderClinic 屬該對話嘅店（fail-closed）；名由 DB 讀
  const provider = await prisma.provider.findFirst({
    where: {
      apricotId: providerApricotId,
      active: true,
      clinics: { some: { clinicId: conv.clinicId } },
    },
  });
  if (!provider) {
    return NextResponse.json(
      { error: "provider_not_at_clinic", message: "呢位醫生未綁定呢間店 — 唔可以喺呢度落單" },
      { status: 400 }
    );
  }
  const resolvedProviderName = provider.name;

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

  // ── ★ S5-8①：requestId 冪等 — flowToken = manual-${requestId}（unique）→ 同 requestId 唔會建第二張卡 ──
  const flowToken = `manual-${requestId}`;
  const existing = await prisma.bookingRequest.findUnique({ where: { flowToken } });
  if (existing) {
    if (existing.conversationId !== conv.id || existing.clinicId !== conv.clinicId) {
      // 防禦：requestId 衝撞咗其他對話（理論上唔會 — uuid）→ 唔重入
      return NextResponse.json(
        { error: "DUPLICATE_BOOKING", message: "呢個請求ID已對應其他預約 — 請重開落單視窗再試" },
        { status: 409 }
      );
    }
    if (existing.status === "CONFIRMED") {
      // 冪等 replay：返原單（零 workforce call / 零重複訊息）
      return NextResponse.json({
        ok: true,
        confirmed: true,
        replayed: true,
        bookingId: existing.id,
        apricotApptId: existing.apricotApptId,
        autoMessage: { sent: false, reason: "already_confirmed" },
        message: "已確認過 — 原單號如常",
      });
    }
    if (existing.status !== "PENDING") {
      // REJECTED / EXPIRED — requestId 已消耗（防 48h 後重放舊視窗）
      return NextResponse.json(
        { error: "DUPLICATE_BOOKING", message: "呢個請求ID已使用過（預約已失效）— 請重開落單視窗再試" },
        { status: 409 }
      );
    }
    if (existing.writeState === "WRITING") {
      // 寫緊 — 返 202（UI 輪詢 / 卡上 spinner）
      return NextResponse.json(
        { ok: true, state: "WRITING", bookingId: existing.id, hint: "落單處理緊 — 結果會即時顯示喺預約卡" },
        { status: 202 }
      );
    }
    // PENDING + writeState ∈ {null, FAILED, UNKNOWN} — 重試（queue 死 / 寫失敗 / 結果未知）
    if (existing.requestedDate !== date || existing.requestedTime !== start) {
      return NextResponse.json(
        { error: "DUPLICATE_BOOKING", message: "呢個請求ID已對應其他時段 — 請重開落單視窗再試" },
        { status: 409 }
      );
    }
    // 重試同一張卡（同一 idempotency key — workforce 冪等重放安全）
    log.info({ bookingId: existing.id, requestId, writeState: existing.writeState ?? null }, "bookings: manual — requestId retry（同單）");
    return runCore(existing.id);
  }

  // ── 新卡：建 PENDING（同 Flow 路徑同形）+ 重複防護 ──
  const clinicId = conv.clinicId;
  const txOut: {
    err: { status: number; body: Record<string, unknown> } | null;
    bookingId: string | null;
  } = { err: null, bookingId: null };
  try {
    await prisma.$transaction(
      async (tx) => {
        // ★ S5-8①：同 pinned 病人（同對話）+ 同醫生 + 同日 + 同開始時間 已有 CONFIRMED / WRITING → 409
        //   （先於 SLOT_TAKEN：病人級重複判斷決定性 — 容量同步快慢唔影響結果）
        const dupConfirmed = await tx.bookingRequest.findFirst({
          where: {
            conversationId: conv.id,
            providerApricotId,
            requestedDate: date,
            requestedTime: start,
            OR: [{ status: "CONFIRMED" }, { writeState: "WRITING" }],
          },
          select: { id: true },
        });
        if (dupConfirmed) {
          txOut.err = {
            status: 409,
            body: {
              error: "DUPLICATE_BOOKING",
              message: "呢位病人呢個時段已有預約（已確認或處理緊）— 請喺對話預約卡核對",
              bookingId: dupConfirmed.id,
            },
          };
          return;
        }
        const slotRow = await tx.availabilitySlot.findUnique({
          where: {
            clinicId_providerApricotId_date_startTime: { clinicId, providerApricotId, date, startTime: start },
          },
        });
        if (slotRow && !slotAvailable(slotRow)) {
          txOut.err = { status: 409, body: { error: "SLOT_TAKEN", message: "時段啱啱滿咗", retryable: true } };
          return;
        }
        const existingPending = await tx.bookingRequest.findFirst({
          where: { clinicId, providerApricotId, requestedDate: date, requestedTime: start, status: "PENDING" },
          select: { id: true },
        });
        if (existingPending) {
          txOut.err = { status: 409, body: { error: "pending_exists", message: "呢個時段已有待處理預約", bookingId: existingPending.id } };
          return;
        }
        const b = await tx.bookingRequest.create({
          data: {
            conversationId: conv.id,
            clinicId,
            flowToken, // ★ S5-8①：manual-${requestId}（冪等）
            providerApricotId,
            providerName: resolvedProviderName,
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

  return runCore(txOut.bookingId!);

  // ── 共用代落單 core（條件 claim WRITING + enqueue booking-write）→ HTTP 映射 ──
  async function runCore(bookingId: string) {
    const result = await confirmBookingCore(bookingId, { type: "STAFF", staffId: ctx.staff.id }, { visitReasonId });
    if (!result.ok) {
      if (result.kind === "QUEUE_UNAVAILABLE") {
        // ★ S5-8①：queue 死 → 200（ok:true + 提示人手覆）— 唔再 503（booking 保持 PENDING，可重試）
        return NextResponse.json({
          ok: true,
          confirmed: false,
          state: "PENDING",
          bookingId,
          autoMessage: { sent: false, reason: "queue_unavailable", hint: "落單隊列暫時唔可用 — 請人手覆病人，稍後重試落單" },
        });
      }
      if (result.kind === "PRECONDITION") {
        if (result.code === "write_in_progress") {
          return NextResponse.json(
            { ok: true, state: "WRITING", bookingId, hint: "落單處理緊 — 結果會即時顯示喺預約卡" },
            { status: 202 }
          );
        }
        return NextResponse.json({ error: result.code, message: result.message }, { status: 400 });
      }
    }
    // ★ S5-1：受理成功 — 寫入處理緊（結果經 booking:updated / 卡上 writeState 更新）
    return NextResponse.json(
      { ok: true, state: "WRITING", bookingId, hint: "落單處理緊 — 結果會即時顯示喺預約卡" },
      { status: 202 }
    );
  }
});

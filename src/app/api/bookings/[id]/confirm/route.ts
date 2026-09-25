/**
 * POST /api/bookings/[id]/confirm — 員工撳〔已喺醫生系統落單〕（MD §8.3）
 *
 * ★ cwi-final S5-6（F1）：雙擊/並發防護 —
 * - 條件 updateMany（status PENDING + writeState ∈ {null, FAILED, UNKNOWN} → CONFIRMED）
 *   count≠1 → ALREADY（200 冪等：返原單號、零重複訊息）；WRITING 中 → 409 write_in_progress。
 * - 確認訊息 clientMessageId = uuidv5(booking-confirm:${id}:${idemAttempt}) —
 *   Message.clientMessageId @unique 物理擋第二條（就算 updateMany 都漏咗都唔會雙發）。
 * - Send Lock（S3-3）照舊（confirm 會覆病人 → 非負責人 423）。
 *
 * 1. RBAC：assertClinicAccess（STAFF 撳別店 booking → 403 實測）
 * 2. 狀態機：條件 updateMany（上面）— EXPIRED/REJECTED → 409
 * 3. BookingRequest → CONFIRMED + AuditLog(CONFIRM_BOOKING)
 * 4. 自動發確認訊息：
 *    - 24h 窗口內 → free-form「已為你預約 X 月 X 日 HH:mm 陳醫生，到時見 🙂」
 *    - 過窗 → 422 提示 staff 用 utility template（MD：過窗用 template；
 *      booking 照樣 CONFIRMED — 狀態要反映「人已喺醫生系統落咗單」）
 */
import { type NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertClinicAccess, assertCanWriteConversation } from "@/lib/rbac";
import { sendLockResponse } from "@/lib/send-lock";
import { handle } from "@/lib/api-error";
import { getWindowState } from "@/lib/wa/window";
import { enqueueOutboundSend } from "@/lib/queue";
import { publishConvEvent, convRef } from "@/lib/notify";
import { bookingConfirmClientMessageId } from "@/lib/booking/booking-id";

export const dynamic = "force-dynamic";

/** 確認訊息文字（MD §8.3 格式：「已為你預約 X 月 X 日 HH:mm 陳醫生，到時見 🙂」）
 *  純收需求變體（requestedTime = null + timeOfDay）：「…上晝…，具體時段職員會再同你確認 🙂」 */
const TIME_OF_DAY_LABEL: Record<string, string> = { MORNING: "上晝", AFTERNOON: "下晝", EVENING: "夜晚" };
function confirmMessageText(b: { requestedDate: string; requestedTime: string | null; providerName: string; timeOfDay?: string | null }): string {
  const [, mo, d] = b.requestedDate.split("-");
  if (b.requestedTime) {
    return `已為你預約 ${Number(mo)}月${Number(d)}日 ${b.requestedTime} ${b.providerName}，到時見 🙂`;
  }
  const tod = TIME_OF_DAY_LABEL[b.timeOfDay ?? ""] ?? "";
  return `已為你預約 ${Number(mo)}月${Number(d)}日 ${tod} ${b.providerName}，具體時段職員會再同你確認 🙂`;
}

const ENQUEUE_TIMEOUT_MS = 1500;

export const POST = handle(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;

  const booking = await prisma.bookingRequest.findUnique({ where: { id } });
  if (!booking) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertClinicAccess(ctx, booking.clinicId); // STAFF 別店 → 403
  assertCanWriteConversation(ctx); // ★ cwi-routing-20260906 §8：SUPERVISOR 覆客 403

  const conv = await prisma.conversation.findUnique({ where: { id: booking.conversationId } });
  if (!conv) return NextResponse.json({ error: "conversation missing" }, { status: 500 });

  // ★ cwi-final S3-3（D-11）：Send Lock 單一來源 — confirm 會發確認訊息（覆病人）→ 非負責人（包 ADMIN）→ 423
  const locked = sendLockResponse(ctx, conv);
  if (locked) return locked;

  const clinic = await prisma.clinic.findUnique({ where: { id: booking.clinicId } });
  if (!clinic) {
    return NextResponse.json({ error: "conversation missing" }, { status: 500 });
  }

  // ── ★ S5-6：條件 CONFIRMED（PENDING + writeState 唔係 WRITING）— 雙擊/並發第二枝 count=0 → ALREADY ──
  const now = new Date();
  const upd = await prisma.bookingRequest.updateMany({
    where: {
      id: booking.id,
      status: "PENDING",
      OR: [{ writeState: null }, { writeState: { in: ["FAILED", "UNKNOWN"] } }],
    },
    data: { status: "CONFIRMED", handledByStaffId: ctx.staff.id, handledAt: now, writeState: null, writeError: null },
  });
  if (upd.count !== 1) {
    const cur = await prisma.bookingRequest.findUnique({ where: { id: booking.id } });
    if (cur?.status === "PENDING" && cur.writeState === "WRITING") {
      return NextResponse.json({ error: "write_in_progress", message: "落單處理緊 — 請等結果" }, { status: 409 });
    }
    if (cur && cur.status !== "CONFIRMED") {
      return NextResponse.json({ error: `booking already ${cur.status}` }, { status: 409 });
    }
    // ALREADY：雙擊 / 並發重入 — 已 CONFIRMED（冪等：返原單號、零重複訊息）
    log.info({ bookingId: booking.id, staffId: ctx.staff.id }, "bookings: confirm — ALREADY（雙擊/並發）");
    return NextResponse.json({
      ok: true,
      confirmed: true,
      already: true,
      apricotApptId: cur?.apricotApptId ?? null,
      autoMessage: { sent: false, reason: "already_confirmed" },
      message: "已確認過 — 未重複發確認訊息",
    });
  }

  // 1) AuditLog（先落定狀態，自動訊息係附送）
  await prisma.auditLog
    .create({
      data: {
        staffId: ctx.staff.id,
        action: "CONFIRM_BOOKING",
        entity: "BookingRequest",
        entityId: booking.id,
        meta: { conversationId: booking.conversationId, clinicId: booking.clinicId },
      },
    })
    .catch(() => undefined);

  // ★ cwi-final S1-4：booking 無 assignee/routed 欄 → 補五欄
  const convRow = await prisma.conversation.findUnique({
    where: { id: booking.conversationId },
    select: { id: true, clinicId: true, assigneeId: true, routedStaffId: true, routedGroupId: true },
  });
  if (convRow) {
    await publishConvEvent(convRef(convRow), "booking:updated", {
      conversationId: booking.conversationId,
      clinicId: booking.clinicId,
      booking: {
        id: booking.id,
        providerName: booking.providerName,
        requestedDate: booking.requestedDate,
        requestedTime: booking.requestedTime,
        status: "CONFIRMED",
        createdAt: booking.createdAt,
      },
    });
  }

  // 2) 自動確認訊息（窗口內 free-form）
  const win = getWindowState(conv.lastInboundAt);
  if (!win.open) {
    log.info(
      { bookingId: booking.id, clinicId: booking.clinicId, staffId: ctx.staff.id },
      "bookings: confirm — window closed, template required"
    );
    return NextResponse.json(
      {
        ok: true,
        confirmed: true,
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
        // cwi-window-20260901（P1）：staff 確認預約覆（窗口內）= SERVICE
        billingCategory: "SERVICE",
        waTimestamp: now,
        // ★ S5-6：uuidv5 冪等 — 同 booking + 同 idemAttempt 重複 INSERT → P2002 物理擋（雙擊零雙發）
        clientMessageId: bookingConfirmClientMessageId(booking.id, booking.idemAttempt),
      },
    });
    await Promise.race([
      enqueueOutboundSend(msg.id),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("enqueue timeout")), ENQUEUE_TIMEOUT_MS)),
    ]);
    await prisma.$executeRaw`
      UPDATE "Conversation" SET "lastMessageAt" = GREATEST("lastMessageAt", ${now}) WHERE "id" = ${conv.id}`;
    log.info(
      { bookingId: booking.id, messageId: msg.id, clinicId: booking.clinicId, staffId: ctx.staff.id },
      "bookings: confirm — auto confirmation message queued"
    );
    return NextResponse.json({
      ok: true,
      confirmed: true,
      autoMessage: { sent: true, messageId: msg.id },
    });
  } catch (err) {
    // ★ S5-6：clientMessageId unique 撞（並發第二枝都搶到 CONFIRMED 嘅極端 case）→ 當已發
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      log.warn({ bookingId: booking.id, staffId: ctx.staff.id }, "bookings: confirm — 確認訊息 P2002（clientMessageId 重複）— 已發過");
      return NextResponse.json({
        ok: true,
        confirmed: true,
        already: true,
        autoMessage: { sent: false, reason: "already_confirmed" },
        message: "已確認過 — 未重複發確認訊息",
      });
    }
    // 狀態已 CONFIRMED；訊息 enqueue 失敗 → 503（staff 手動覆）
    log.error(
      { bookingId: booking.id, err: err instanceof Error ? err.message : String(err) },
      "bookings: confirm — auto message enqueue failed（狀態已 CONFIRMED，staff 手動覆）"
    );
    return NextResponse.json(
      {
        ok: true,
        confirmed: true,
        autoMessage: { sent: false, reason: "queue_unavailable", hint: "請手動覆病人" },
      },
      { status: 503 }
    );
  }
});

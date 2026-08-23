import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, clinicScope } from "@/lib/rbac";
import { handle } from "@/lib/api-error";

/**
 * GET /api/conversations?clinicId=&status= — 隊列列表（MD §6.4 隊列欄）。
 * - clinicId：ADMIN 可以指定（tab 切換）；STAFF 忽略（硬性綁自己店，砌別店 → 403 實測）
 * - status：OPEN / PENDING / RESOLVED（filter）
 * - 排序：urgent 優先（Phase 2 鐵律：急症排頂），其餘 lastMessageAt desc
 * - 回傳 contact 資料 + 24h 窗口狀態（UI chip 用）+ AI triage 欄位（intent/urgency/urgent/aiSummary）
 */
export const dynamic = "force-dynamic";

const WINDOW_MS = 24 * 3600 * 1000;

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const scope = clinicScope(ctx);
  const url = new URL(req.url);
  const clinicParam = url.searchParams.get("clinicId");
  const statusParam = url.searchParams.get("status");

  const where: Record<string, unknown> = { ...scope };
  if (clinicParam) {
    // STAFF 砌別店 clinicId → 403（RBAC 鐵律，E2E 要實測呢條）
    if (ctx.staff.role === "STAFF" && clinicParam !== ctx.clinicId) {
      return NextResponse.json({ error: "cross-clinic access denied" }, { status: 403 });
    }
    where.clinicId = clinicParam;
  }
  if (statusParam) {
    if (!["OPEN", "PENDING", "RESOLVED"].includes(statusParam)) {
      return NextResponse.json({ error: "invalid status" }, { status: 400 });
    }
    where.status = statusParam;
  }

  const convs = await prisma.conversation.findMany({
    where,
    orderBy: [{ urgent: "desc" }, { lastMessageAt: "desc" }],
    take: 200,
  });
  const [contacts, staff, pendingBookings] = await Promise.all([
    prisma.contact.findMany({ select: { id: true, waId: true, profileName: true, labels: true } }),
    prisma.staffUser.findMany({ select: { id: true, name: true } }),
    // Phase 3：綠色卡 — 每對話最新 PENDING 預約（staff 一眼見到「有預約等處理」）
    prisma.bookingRequest.findMany({
      where: { conversationId: { in: convs.map((c) => c.id) }, status: "PENDING" },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const contactMap = new Map(contacts.map((c) => [c.id, c]));
  const staffMap = new Map(staff.map((s) => [s.id, s.name]));
  const pendingBookingMap = new Map(pendingBookings.map((b) => [b.conversationId, b]));
  const now = Date.now();

  return NextResponse.json(
    convs.map((cv) => {
      const lastIn = cv.lastInboundAt?.getTime() ?? null;
      const remainingMs = lastIn === null ? 0 : Math.max(0, lastIn + WINDOW_MS - now);
      const open = remainingMs > 0;
      return {
        id: cv.id,
        clinicId: cv.clinicId,
        contactId: cv.contactId,
        status: cv.status,
        assigneeId: cv.assigneeId,
        assigneeName: cv.assigneeId ? staffMap.get(cv.assigneeId) ?? null : null,
        unreadCount: cv.unreadCount,
        lastInboundAt: cv.lastInboundAt,
        lastMessageAt: cv.lastMessageAt,
        intent: cv.intent,
        intentConfidence: cv.intentConfidence,
        urgency: cv.urgency,
        urgent: cv.urgent,
        aiSummary: cv.aiSummary,
        contact: contactMap.get(cv.contactId) ?? null,
        // Phase 3：PENDING 預約卡（綠色卡）— null = 冇待處理預約
        pendingBooking: (() => {
          const b = pendingBookingMap.get(cv.id);
          if (!b) return null;
          return {
            id: b.id,
            providerName: b.providerName,
            requestedDate: b.requestedDate,
            requestedTime: b.requestedTime,
            // 純收需求變體（workforce 切換 MD §3）：timeOfDay + precheckPassed=null —
            // REST refresh（fetchConversations 全量 replace）必須帶埋，否則 chip 空白。
            timeOfDay: b.timeOfDay,
            precheckPassed: b.precheckPassed,
            status: b.status,
            createdAt: b.createdAt,
          };
        })(),
        window: {
          open,
          remainingMs,
          remainingHours: remainingMs / 3600000,
          tone: !open ? "red" : remainingMs < 6 * 3600 * 1000 ? "yellow" : "green",
        },
      };
    })
  );
});

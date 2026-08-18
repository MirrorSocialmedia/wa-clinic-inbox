import { redirect } from "next/navigation";
import prisma from "@/lib/prisma";
import { getServerSession } from "@/lib/session-server";
import { InboxClient } from "@/components/inbox/inbox-client";

/**
 * /inbox — 共用收件箱（MD §6.4 三欄）。
 *
 * Server 端做首屏資料（SSR 一次過：clinics / conversations / staff），
 * client 之後用 Socket.IO 實時更新 + REST 補漏。
 * STAFF 硬性只回自己店（clinicScope fail-closed）。
 */
export const dynamic = "force-dynamic";

const WINDOW_MS = 24 * 3600 * 1000;

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getServerSession();
  if (!session) redirect("/login");

  // Phase 3：/bookings 卡「開對話」深連結 → ?conv=<id>
  const sp = await searchParams;
  const convParam = typeof sp.conv === "string" ? sp.conv : "";

  const scope = session.role === "STAFF" ? { clinicId: session.clinicId! } : {};

  const [clinics, convs, contacts, staff, pendingBookings] = await Promise.all([
    session.role === "STAFF"
      ? prisma.clinic.findUnique({ where: { id: session.clinicId! } }).then((c) => (c ? [c] : []))
      : prisma.clinic.findMany({ orderBy: { code: "asc" } }),
    prisma.conversation.findMany({ where: scope, orderBy: [{ urgent: "desc" }, { lastMessageAt: "desc" }], take: 200 }),
    prisma.contact.findMany({ where: scope, select: { id: true, waId: true, profileName: true, labels: true } }),
    prisma.staffUser.findMany({ where: { active: true, ...scope }, select: { id: true, name: true, role: true, clinicId: true } }),
    // Phase 3：PENDING 預約（綠色卡）— 同 conversations API 一致
    prisma.bookingRequest.findMany({
      where: { ...scope, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
  ]);

  const contactMap = new Map(contacts.map((c) => [c.id, c]));
  const staffMap = new Map(staff.map((s) => [s.id, s.name]));
  const pendingBookingMap = new Map(pendingBookings.map((b) => [b.conversationId, b]));
  const now = Date.now();

  const conversations = convs.map((cv) => {
    const lastIn = cv.lastInboundAt?.getTime() ?? null;
    const remainingMs = lastIn === null ? 0 : Math.max(0, lastIn + WINDOW_MS - now);
    return {
      id: cv.id,
      clinicId: cv.clinicId,
      contactId: cv.contactId,
      status: cv.status,
      assigneeId: cv.assigneeId,
      assigneeName: cv.assigneeId ? staffMap.get(cv.assigneeId) ?? null : null,
      unreadCount: cv.unreadCount,
      lastInboundAt: cv.lastInboundAt ? cv.lastInboundAt.toISOString() : null,
      lastMessageAt: cv.lastMessageAt.toISOString(),
      intent: cv.intent,
      intentConfidence: cv.intentConfidence,
      urgency: cv.urgency,
      urgent: cv.urgent,
      aiSummary: cv.aiSummary,
      contact: contactMap.get(cv.contactId) ?? null,
      // Phase 3：綠色卡（PENDING 預約）
      pendingBooking: (() => {
        const b = pendingBookingMap.get(cv.id);
        if (!b) return null;
        return {
          id: b.id,
          providerName: b.providerName,
          requestedDate: b.requestedDate,
          requestedTime: b.requestedTime,
          status: b.status as "PENDING",
          createdAt: b.createdAt.toISOString(),
        };
      })(),
      window: {
        open: remainingMs > 0,
        remainingMs,
        remainingHours: remainingMs / 3600000,
        tone: (!remainingMs ? "red" : remainingMs < 6 * 3600 * 1000 ? "yellow" : "green") as "red" | "yellow" | "green",
      },
    };
  });

  return (
    <InboxClient
      user={{
        staffId: session.staffId,
        name: session.name,
        email: session.email,
        role: session.role,
        clinicId: session.clinicId,
      }}
      initialClinics={clinics}
      initialConversations={conversations}
      initialStaff={staff}
      initialSelectedConvId={convParam || null}
    />
  );
}

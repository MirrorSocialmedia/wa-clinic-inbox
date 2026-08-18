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

export default async function InboxPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");

  const scope = session.role === "STAFF" ? { clinicId: session.clinicId! } : {};

  const [clinics, convs, contacts, staff] = await Promise.all([
    session.role === "STAFF"
      ? prisma.clinic.findUnique({ where: { id: session.clinicId! } }).then((c) => (c ? [c] : []))
      : prisma.clinic.findMany({ orderBy: { code: "asc" } }),
    prisma.conversation.findMany({ where: scope, orderBy: [{ urgent: "desc" }, { lastMessageAt: "desc" }], take: 200 }),
    prisma.contact.findMany({ where: scope, select: { id: true, waId: true, profileName: true, labels: true } }),
    prisma.staffUser.findMany({ where: { active: true, ...scope }, select: { id: true, name: true, role: true, clinicId: true } }),
  ]);

  const contactMap = new Map(contacts.map((c) => [c.id, c]));
  const staffMap = new Map(staff.map((s) => [s.id, s.name]));
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
    />
  );
}

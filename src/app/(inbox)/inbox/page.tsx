import { redirect } from "next/navigation";
import prisma from "@/lib/prisma";
import { getServerSession } from "@/lib/session-server";
import { fetchDutyRoster, hkToday } from "@/lib/duty/client";
import { InboxClient } from "@/components/inbox/inbox-client";
import type { DutyInfo } from "@/components/inbox/types";

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
    // Phase 3：PENDING 預約（綠色卡）/ ★ booking-ui（D）：CONFIRMED 亦顯示 — 同 conversations API 一致
    prisma.bookingRequest.findMany({
      where: { ...scope, status: { in: ["PENDING", "CONFIRMED"] } },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
  ]);

  const contactMap = new Map(contacts.map((c) => [c.id, c]));
  const staffMap = new Map(staff.map((s) => [s.id, s.name]));
  // ★ booking-ui（D）：PENDING 優先；冇 PENDING 先顯示最新 CONFIRMED（同 API 一致）
  const pendingBookingMap = new Map<string, (typeof pendingBookings)[number]>();
  for (const b of pendingBookings) {
    const existing = pendingBookingMap.get(b.conversationId);
    if (!existing || (existing.status !== "PENDING" && b.status === "PENDING")) {
      pendingBookingMap.set(b.conversationId, b);
    }
  }
  const now = Date.now();

  // Phase 4：今日當值（側欄卡 — staff 名+職位+更時；null → 隱藏）。
  // fail-soft：fetchDutyRoster 永遠唔 throw（3s timeout / 404 / 壞 shape → null）；5 分鐘 TTL cache。
  const dutyToday = hkToday();
  const initialDuty: Record<string, DutyInfo | null> = {};
  for (const c of clinics) {
    const entries = await fetchDutyRoster(c.code, dutyToday).catch(() => null);
    initialDuty[c.id] = entries && entries.length > 0 ? { date: dutyToday, entries } : null;
  }

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
      // ★ booking-ui（A）：已釘住舊客（藍掣可見性）
      pinnedPatient: cv.pinnedPatientApricotId ? { patientApricotId: cv.pinnedPatientApricotId } : null,
      // Phase 3：綠色卡（PENDING 預約）/ ★ booking-ui（D）：CONFIRMED 卡
      pendingBooking: (() => {
        const b = pendingBookingMap.get(cv.id);
        if (!b) return null;
        return {
          id: b.id,
          providerName: b.providerName,
          requestedDate: b.requestedDate,
          requestedTime: b.requestedTime,
          timeOfDay: b.timeOfDay,
          precheckPassed: b.precheckPassed,
          status: b.status as "PENDING" | "CONFIRMED",
          createdAt: b.createdAt.toISOString(),
          // ★ booking-ui（D）：CONFIRMED 態 + 主訴
          apricotApptId: b.apricotApptId,
          visitReasonCode: b.visitReasonCode,
          handledByStaffName: b.handledByStaffId ? (staffMap.get(b.handledByStaffId) ?? null) : null,
          handledAt: b.handledAt ? b.handledAt.toISOString() : null,
          chiefComplaint: b.chiefComplaint,
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
      initialDuty={initialDuty}
      initialSelectedConvId={convParam || null}
    />
  );
}

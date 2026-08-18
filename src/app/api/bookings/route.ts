/**
 * GET /api/bookings — 預約隊列（MD §8.3：staff 本店 scope）
 *
 * - clinicId：ADMIN 可以指定；STAFF 硬性綁自己店（clinicScope fail-closed）
 * - status：PENDING / CONFIRMED / REJECTED / EXPIRED（filter，預設全部）
 * - 回傳：病人（contact 名 + waId + 對話連結資料）/ 醫生 / 日期時間 / 狀態 /
 *   對話 24h 窗口狀態（confirm 掣提示用）
 *
 * ★ 無 PII：病人資料只係 waId + profileName（WhatsApp 對內显示名，同隊列欄一致）。
 */
import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, clinicScope } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { getWindowState } from "@/lib/wa/window";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const scope = clinicScope(ctx);
  const url = new URL(req.url);
  const clinicParam = url.searchParams.get("clinicId");
  const statusParam = url.searchParams.get("status");

  const where: Record<string, unknown> = { ...scope };
  if (clinicParam) {
    if (ctx.staff.role === "STAFF" && clinicParam !== ctx.clinicId) {
      return NextResponse.json({ error: "cross-clinic access denied" }, { status: 403 });
    }
    where.clinicId = clinicParam;
  }
  if (statusParam) {
    if (!["PENDING", "CONFIRMED", "REJECTED", "EXPIRED"].includes(statusParam)) {
      return NextResponse.json({ error: "invalid status" }, { status: 400 });
    }
    where.status = statusParam;
  }

  const bookings = await prisma.bookingRequest.findMany({
    where,
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 200,
  });

  const convIds = [...new Set(bookings.map((b) => b.conversationId))];
  const convs = await prisma.conversation.findMany({ where: { id: { in: convIds } } });
  const [contacts, staffRows] = await Promise.all([
    prisma.contact.findMany({
      where: { id: { in: convs.map((c) => c.contactId) } },
      select: { id: true, waId: true, profileName: true },
    }),
    prisma.staffUser.findMany({ select: { id: true, name: true } }),
  ]);
  const convMap = new Map(convs.map((c) => [c.id, c]));
  const contactMap = new Map(contacts.map((c) => [c.id, c]));
  const staffMap = new Map(staffRows.map((s) => [s.id, s.name]));

  return NextResponse.json(
    bookings.map((b) => {
      const conv = convMap.get(b.conversationId);
      const win = getWindowState(conv?.lastInboundAt ?? null);
      return {
        id: b.id,
        clinicId: b.clinicId,
        conversationId: b.conversationId,
        providerApricotId: b.providerApricotId,
        providerName: b.providerName,
        requestedDate: b.requestedDate,
        requestedTime: b.requestedTime,
        precheckPassed: b.precheckPassed,
        status: b.status,
        handledByStaffId: b.handledByStaffId,
        handledByStaffName: b.handledByStaffId ? staffMap.get(b.handledByStaffId) ?? null : null,
        handledAt: b.handledAt,
        createdAt: b.createdAt,
        // 對話連結（UI 跳轉用）
        conversation: conv
          ? {
              id: conv.id,
              contact: {
                id: conv.contactId,
                waId: contactMap.get(conv.contactId)?.waId ?? null,
                profileName: contactMap.get(conv.contactId)?.profileName ?? null,
              },
              window: { open: win.open, remainingHours: Math.round(win.remainingHours * 10) / 10 },
            }
          : null,
      };
    })
  );
});

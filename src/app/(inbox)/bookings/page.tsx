import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import { BookingsClient } from "@/components/inbox/bookings-client";

/**
 * /bookings — 預約隊列（MD §8.3 D9 flow）。
 *
 * PENDING 卡（病人/醫生/日期/時間/對話連結）+ 掣：
 * - 〔已喺醫生系統落單〕→ CONFIRMED + AuditLog + 自動確認訊息
 * - 〔改期〕→ 重出 Flow
 * STAFF 只見到自己店（API 端 clinicScope fail-closed）。
 */
export const dynamic = "force-dynamic";

export default async function BookingsPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");

  return (
    <BookingsClient
      user={{
        staffId: session.staffId,
        name: session.name,
        role: session.role,
        clinicId: session.clinicId,
      }}
    />
  );
}

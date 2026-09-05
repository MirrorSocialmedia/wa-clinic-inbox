import prisma from "@/lib/prisma";
import { getServerSession } from "@/lib/session-server";
import { redirect } from "next/navigation";
import { AccountCard } from "@/components/inbox/account-card";

/**
 * /account — 帳戶頁（cwi-notify-v2-20260903 MD §5）。
 * 手機 STAFF「我的」tab 入嚟（BottomTabBar 第四格）；ADMIN 手機行「管理」tab（/admin 頁頂同卡）。
 * 內容：帳戶卡（頭像/姓名/角色/所屬診所多店列晒/登出 — §3.6 清理）。
 * 權限：(inbox) layout 已把關（未登入 → /login）；STAFF/ADMIN 都行得。
 */
export const metadata = { title: "帳戶 — WA Clinic Inbox" };

export default async function AccountPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");

  // 所屬診所：STAFF = StaffClinic 綁定（多店列晒 — T194）；ADMIN = 全部店
  const boundClinicIds =
    session.role === "ADMIN"
      ? (await prisma.clinic.findMany({ select: { id: true } })).map((c) => c.id)
      : (await prisma.staffClinic.findMany({ where: { staffId: session.staffId }, select: { clinicId: true } })).map(
          (b) => b.clinicId
        );
  const clinics = await prisma.clinic.findMany({
    where: { id: { in: boundClinicIds } },
    select: { code: true, name: true },
    orderBy: { code: "asc" },
  });

  return (
    <div className="flex-1 min-w-0 h-full overflow-y-auto">
      <div className="max-w-md mx-auto px-4 py-6 space-y-4">
        <h1 className="text-lg font-semibold text-t1">帳戶</h1>
        <AccountCard name={session.name} email={session.email} role={session.role} clinics={clinics} />
      </div>
    </div>
  );
}

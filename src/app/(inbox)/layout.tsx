import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import prisma from "@/lib/prisma";
import { NavRail } from "@/components/inbox/nav-rail";
import { BottomTabBar } from "@/components/inbox/bottom-tab-bar";

/**
 * (inbox) layout — 所有需要登入嘅頁。
 * Server 端 fail-closed：冇 session → redirect /login。
 * v3：≥md 左 NavRail；<md 底部 BottomTabBar（單欄 stack navigation）。
 * unread badge = server 一次過 count（換頁先更新；實時版留 Phase 2）。
 */
export default async function InboxLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession();
  if (!session) redirect("/login");

  // STAFF 只計自己店；ADMIN 計全部（同 inbox 列表 scope 一致）
  const unreadCount = await prisma.conversation.count({
    where: {
      unreadCount: { gt: 0 },
      status: { not: "RESOLVED" },
      ...(session.role === "STAFF" && session.clinicId
        ? { clinicId: session.clinicId }
        : {}),
    },
  });

  return (
    <div className="h-dvh bg-canvas flex overflow-hidden theme-transition">
      <NavRail name={session.name} email={session.email} role={session.role} />
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        <main className="flex-1 min-w-0 min-h-0">{children}</main>
        <BottomTabBar role={session.role} unreadCount={unreadCount} />
      </div>
    </div>
  );
}

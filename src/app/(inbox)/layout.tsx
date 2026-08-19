import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import { NavRail } from "@/components/inbox/nav-rail";

/**
 * (inbox) layout — 所有需要登入嘅頁。
 * Server 端 fail-closed：冇 session → redirect /login（唔靠前端）。
 * v2：TopBar → 左邊 NavRail；main 佔滿餘下闊度。
 */
export default async function InboxLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession();
  if (!session) redirect("/login");

  return (
    <div className="h-screen bg-canvas flex overflow-hidden theme-transition">
      <NavRail name={session.name} email={session.email} role={session.role} />
      <main className="flex-1 min-w-0 min-h-0">{children}</main>
    </div>
  );
}

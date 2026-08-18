import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import { TopBar } from "@/components/inbox/top-bar";

/**
 * (inbox) layout — 所有需要登入嘅頁。
 * Server 端 fail-closed：冇 session → redirect /login（唔靠前端）。
 */
export default async function InboxLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession();
  if (!session) redirect("/login");

  return (
    <div className="min-h-screen bg-neutral-100 flex flex-col">
      <TopBar
        name={session.name}
        email={session.email}
        role={session.role}
      />
      <main className="flex-1 min-h-0">{children}</main>
    </div>
  );
}

import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session-server";

/**
 * /admin — ADMIN-only 管理區（店/員工）。
 * - 未登入 → /login
 * - STAFF → /inbox（fail-closed：管理 API 本身就 403，呢度只係 UX 層）
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession();
  if (!session) redirect("/login");
  if (session.role !== "ADMIN") redirect("/inbox");

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="bg-white border-b border-neutral-200">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <span className="font-semibold text-neutral-900">WA Clinic Inbox</span>
            <nav className="flex gap-4 text-sm">
              <a href="/inbox" className="text-neutral-600 hover:text-neutral-900">
                Inbox
              </a>
              <a href="/admin" className="text-blue-600 font-medium">
                總覽
              </a>
              <a href="/admin/clinics" className="text-neutral-600 hover:text-neutral-900">
                診所
              </a>
              <a href="/admin/staff" className="text-neutral-600 hover:text-neutral-900">
                員工
              </a>
            </nav>
          </div>
          <span className="text-xs text-neutral-500">
            {session.name}（ADMIN）
          </span>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-6 py-8">{children}</main>
    </div>
  );
}

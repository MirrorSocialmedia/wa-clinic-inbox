import { redirect, forbidden } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import { ThemeToggle } from "@/components/theme-toggle";

/**
 * /admin — ADMIN-only 管理區（店/員工/onboarding/templates）。
 * - 未登入 → /login
 * - STAFF → 403（forbidden）
 *   ★ 2026-08-20 touch：原先 redirect("/inbox")；App Review §2/§2A 驗收要求
 *   「onboarding/templates 非 ADMIN 403」，而 layout 先於 page 執行 — redirect 會令
 *   403 永遠唔見到。對齊 admin API 層 fail-closed 403 語義（管理 API 本身就 403）。
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession();
  if (!session) redirect("/login");
  if (session.role !== "ADMIN") forbidden();

  return (
    <div className="min-h-screen bg-canvas">
      <header className="bg-panel border-b border-line">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <span className="font-semibold text-t1">WA Clinic Inbox</span>
            <nav className="flex gap-4 text-sm">
              <a href="/inbox" className="text-t2 hover:text-t1">
                Inbox
              </a>
              <a href="/admin" className="text-brand-text font-medium">
                總覽
              </a>
              <a href="/admin/clinics" className="text-t2 hover:text-t1">
                診所
              </a>
              <a href="/admin/staff" className="text-t2 hover:text-t1">
                員工
              </a>
              <a href="/admin/onboarding" className="text-t2 hover:text-t1">
                Onboarding
              </a>
              <a href="/admin/templates" className="text-t2 hover:text-t1">
                Templates
              </a>
            </nav>
          </div>
          <span className="flex items-center gap-3">
            <ThemeToggle />
            <span className="text-xs text-t3">{session.name}（ADMIN）</span>
          </span>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-6 py-8">{children}</main>
    </div>
  );
}

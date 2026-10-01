import { redirect, forbidden } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import prisma from "@/lib/prisma";
import { AdminShell } from "./admin-shell";
import { BottomTabBar } from "@/components/inbox/bottom-tab-bar";

/**
 * /admin — ADMIN-only 管理區（店/員工/onboarding/templates）。
 * - 未登入 → /login
 * - STAFF → 403（forbidden）
 *   ★ 2026-08-20 touch：原先 redirect("/inbox")；App Review §2/§2A 驗收要求
 *   「onboarding/templates 非 ADMIN 403」，而 layout 先於 page 執行 — redirect 會令
 *   403 永遠唔見到。對齊 admin API 層 fail-closed 403 語義（管理 API 本身就 403）。
 *
 * ★ 2026-08-29 Organic P2（cwi-uiredesign-20260829-P2）：
 *   header 一行平鋪連結 → 244px 分組側欄（AdminShell，README 第 3 步）。
 *   ThemeToggle 唔 render（Organic 決策 3：今輪唔做暗色；[data-theme=dark] block 保留）。
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession();
  if (!session) redirect("/login");
  // ★ cwi-routing-20260906 §8：SUPERVISOR 入管理殼（AI 級別/建議頁）；其餘設定頁各自 403/redirect。
  if (session.role !== "ADMIN" && session.role !== "SUPERVISOR") forbidden();

  // 側欄 badge（AI 建議待審數）+ 品牌副題（真店數）— 純讀，零副作用
  const [pendingSuggestions, clinicCount] = await Promise.all([
    prisma.suggestionCard.count({ where: { status: "PROPOSED" } }),
    prisma.clinic.count(),
  ]);
  // ★ cwi-ux UX-04：管理頁手機版加返 BottomTabBar（同 (inbox) 四格導航一致 — 唔會「入咗管理頁冇路返」）；
  //   unread badge 同 (inbox)/layout 同一口徑（未解決 + unreadCount>0）。
  //   呢度 session.role 已 narrow 到 ADMIN|SUPERVISOR（STAFF 上面 forbidden()）→ 全店口徑。
  const unreadCount = await prisma.conversation.count({
    where: {
      unreadCount: { gt: 0 },
      status: { not: "RESOLVED" },
    },
  });

  return (
    <div className="min-h-screen bg-canvas pt-[env(safe-area-inset-top)]">
      <div className="p-3 md:p-6 pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-6">
        <AdminShell
          userName={session.name}
          clinicCount={clinicCount}
          pendingSuggestions={pendingSuggestions}
          role={session.role}
        >
          {children}
        </AdminShell>
      </div>
      {/* ★ cwi-ux UX-04：手機固定底部 tab（管理頁長頁自然捲 → fixed；md 以上零影響） */}
      <div className="md:hidden fixed inset-x-0 bottom-0 z-40">
        <BottomTabBar role={session.role} unreadCount={unreadCount} />
      </div>
    </div>
  );
}

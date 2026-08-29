import { redirect, forbidden } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import prisma from "@/lib/prisma";
import { AdminShell } from "./admin-shell";

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
  if (session.role !== "ADMIN") forbidden();

  // 側欄 badge（AI 建議待審數）+ 品牌副題（真店數）— 純讀，零副作用
  const [pendingSuggestions, clinicCount] = await Promise.all([
    prisma.suggestionCard.count({ where: { status: "PROPOSED" } }),
    prisma.clinic.count(),
  ]);

  return (
    <div className="min-h-screen bg-canvas p-3 md:p-6">
      <AdminShell
        userName={session.name}
        clinicCount={clinicCount}
        pendingSuggestions={pendingSuggestions}
      >
        {children}
      </AdminShell>
    </div>
  );
}

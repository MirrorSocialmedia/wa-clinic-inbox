import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import prisma from "@/lib/prisma";
import { NavRail } from "@/components/inbox/nav-rail";
import { BottomTabBar } from "@/components/inbox/bottom-tab-bar";
import { SwRegistrar } from "@/components/inbox/sw-registrar";
import { InstallPrompt } from "@/components/inbox/install-prompt";

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
    <div className="fixed inset-0 bg-canvas flex overflow-hidden theme-transition pt-[env(safe-area-inset-top)]">
      {/* ★ cwi-ux UX-04：app-shell 防 body 捲（edge-to-edge 下外框比可視範圍高 → body 可捲 =
          「向下拉先見到」根因）。只套 (inbox) 群 — /login、(public) 法律頁、/ops、管理頁係長頁要捲。
          fixed inset-0 外框自身已 overflow-hidden；呢個 style 雙保險禁 html/body 級捲動 + 橡皮筋。 */}
      <style>{`html,body{height:100%;overflow:hidden;overscroll-behavior:none;}`}</style>
      {/* ★ cwi-ux UX-02：manifest link 已移去 root layout（metadata API）— 呢行刪（避免重複） */}
      <SwRegistrar />
      <NavRail name={session.name} email={session.email} role={session.role} />
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        {/* ★ cwi-ux UX-03：PWA 安裝提示橫條（Android beforeinstallprompt / iOS 加入主畫面教學；已安裝唔顯示）
            ★ cwi-notify-a9：喺主欄 flow 入面（推低內容）— 唔再疊喺 header 上面遮住掣 */}
        <InstallPrompt />
        <main className="flex-1 min-w-0 min-h-0">{children}</main>
        <BottomTabBar role={session.role} unreadCount={unreadCount} />
      </div>
    </div>
  );
}

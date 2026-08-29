"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { CalendarDays, MessageCircle, Settings, Stethoscope } from "lucide-react";

/**
 * 手機底部 tab bar（md 以下顯示；桌面用 NavRail）。
 * - 四格：收件箱（unread badge）/ 預約 / 時間表 / 管理（ADMIN only → STAFF 三格）
 * - pb-[env(safe-area-inset-bottom)]：iPhone home indicator 唔遮字
 * - Organic 1f：icon 23px / label 10.5px / 每格熱區 ≥48px / strokeWidth 2.75
 */
export function BottomTabBar({
  role,
  unreadCount,
}: {
  role: "ADMIN" | "STAFF";
  unreadCount: number;
}) {
  const pathname = usePathname();

  const items = [
    { href: "/inbox", label: "收件箱", icon: MessageCircle, badge: unreadCount },
    { href: "/bookings", label: "預約", icon: CalendarDays },
    { href: "/schedule", label: "時間表", icon: Stethoscope },
    { href: "/admin", label: "管理", icon: Settings, adminOnly: true },
  ] as const;

  return (
    <nav className="md:hidden shrink-0 border-t border-line bg-panel flex pb-[env(safe-area-inset-bottom)]">
      {items
        .filter((it) => !("adminOnly" in it && it.adminOnly) || role === "ADMIN")
        .map((it) => {
          const active = pathname === it.href || pathname.startsWith(it.href + "/");
          const Icon = it.icon;
          const badge = "badge" in it ? it.badge : 0;
          return (
            <Link
              key={it.href}
              href={it.href}
              aria-current={active ? "page" : undefined}
              className={`flex-1 flex flex-col items-center justify-center gap-[3px] py-2 min-h-[48px] ${
                active ? "text-brand-text" : "text-t3"
              }`}
            >
              <span className="relative">
                <Icon size={23} strokeWidth={2.75} />
                {badge > 0 && (
                  <span className="absolute -top-[3px] -right-[7px] min-w-[17px] h-[17px] px-1 rounded-full bg-danger text-panel text-[10px] font-bold flex items-center justify-center">
                    {badge > 99 ? "99+" : badge}
                  </span>
                )}
              </span>
              <span className={`text-[10.5px] ${active ? "font-bold" : "font-normal"}`}>{it.label}</span>
            </Link>
          );
        })}
    </nav>
  );
}

"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { CalendarDays, MessageCircle, Settings, Stethoscope, User } from "lucide-react";

/**
 * 手機底部 tab bar（md 以下顯示；桌面用 NavRail）。
 * - 四格：收件箱（unread badge）/ 預約 / 時間表 / 管理（ADMIN）或 我的（STAFF — MD §5 登出入口）
 * - pb-[env(safe-area-inset-bottom)]：iPhone home indicator 唔遮字
 * - Organic 1f：icon 23px / label 10.5px / 每格熱區 ≥48px / strokeWidth 2.75
 *
 * ★ cwi-setnav NAV-04（工單 §2.3）：tab 切換同系統返回鍵協作（WhatsApp 式）：
 * - 由收件箱去其他 tab → 正常 push（返回 = 返收件箱）
 * - 已經喺非收件箱 tab 再轉另一個非收件箱 tab → router.replace（唔疊）
 * - 撳「收件箱」tab 本身 → 上一層係收件箱就 history.back()，否則 replace
 *
 * 實作：push 後喺目標 entry 嘅 history.state 打 `waFrom="/inbox"` 標記
 * （pathname 變後 effect 寫入 — Next 先建好 entry 先有得改 state）。
 */
export function BottomTabBar({
  role,
  unreadCount,
}: {
  role: "ADMIN" | "STAFF" | "SUPERVISOR";
  unreadCount: number;
}) {
  const pathname = usePathname();
  const router = useRouter();
  // 下一次 pathname 變完（router push/replace 完成）後要喺新 entry 打嘅 waFrom 標記
  const pendingMarkRef = useRef<string | null>(null);

  useEffect(() => {
    const mark = pendingMarkRef.current;
    pendingMarkRef.current = null;
    if (!mark) return;
    const st = (window.history.state ?? {}) as Record<string, unknown>;
    if (st.waFrom === mark) return; // 已標過（冪等）
    window.history.replaceState({ ...st, waFrom: mark }, "");
  }, [pathname]);

  const inInbox = pathname === "/inbox" || pathname.startsWith("/inbox/");
  const inAdmin = pathname === "/admin" || pathname.startsWith("/admin/");

  const onTabTap = (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    const here = pathname === href || (href === "/admin" && inAdmin) || (href === "/inbox" && inInbox);
    if (here) return;
    e.preventDefault();
    if (href === "/inbox") {
      // 收件箱 tab：上一層係由收件箱 push 出嚟 → back 返去（唔建第二個 /inbox）
      const st = window.history.state as { waFrom?: string } | null;
      if (st?.waFrom === "/inbox") {
        window.history.back();
      } else {
        router.replace("/inbox");
      }
      return;
    }
    if (inInbox) {
      // 收件箱 → 其他 tab：push + 標記 waFrom（之後返收件箱用 back）
      pendingMarkRef.current = "/inbox";
      router.push(href);
      return;
    }
    // 非收件箱 → 其他非收件箱 tab：replace（唔疊 — 任何 tab 撳返回都係返收件箱）
    // 上一層嘅 waFrom 標記繼承（inbox → bookings → schedule 一路 back 得返 /inbox）
    const st = window.history.state as { waFrom?: string } | null;
    pendingMarkRef.current = st?.waFrom === "/inbox" ? "/inbox" : null;
    router.replace(href);
  };

  const items = [
    { href: "/inbox", label: "收件箱", icon: MessageCircle, badge: unreadCount },
    { href: "/bookings", label: "預約", icon: CalendarDays },
    { href: "/schedule", label: "時間表", icon: Stethoscope },
    // ADMIN / SUPERVISOR（★ cwi-routing-20260906 §8：主管入管理殼睇 AI 級別/建議）→ 管理；STAFF → 我的
    role === "ADMIN" || role === "SUPERVISOR"
      ? { href: "/admin", label: "管理", icon: Settings }
      : { href: "/account", label: "我的", icon: User },
  ] as const;

  return (
    <nav className="md:hidden shrink-0 border-t border-line bg-panel flex pb-[env(safe-area-inset-bottom)]">
      {items
        .map((it) => {
          const active = pathname === it.href || pathname.startsWith(it.href + "/");
          const Icon = it.icon;
          const badge = "badge" in it ? it.badge : 0;
          return (
            <a
              key={it.href}
              href={it.href}
              aria-current={active ? "page" : undefined}
              onClick={(e) => onTabTap(e, it.href)}
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
            </a>
          );
        })}
    </nav>
  );
}

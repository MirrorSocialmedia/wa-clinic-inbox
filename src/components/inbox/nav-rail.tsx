"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { CalendarDays, LogOut, MessageCircle, Settings, Stethoscope } from "lucide-react";

/**
 * 左邊 icon rail（SleekFlow 式），取代舊 TopBar。
 * - 導航：收件箱 / 預約 /（ADMIN）管理
 * - 底部：theme toggle + 用戶 initials（title 顯示全名/email/角色）+ 登出
 */
export function NavRail({
  name,
  email,
  role,
}: {
  name: string;
  email: string;
  role: "ADMIN" | "STAFF";
}) {
  const [busy, setBusy] = useState(false);
  const pathname = usePathname();

  async function logout() {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      window.location.href = "/login";
    } finally {
      setBusy(false);
    }
  }

  const items: { href: string; label: string; icon: React.ReactNode; adminOnly?: boolean }[] = [
    { href: "/inbox", label: "收件箱", icon: <MessageCircle size={18} strokeWidth={2.75} /> },
    { href: "/bookings", label: "預約", icon: <CalendarDays size={18} strokeWidth={2.75} /> },
    { href: "/schedule", label: "醫生時間表", icon: <Stethoscope size={18} strokeWidth={2.75} /> },
    { href: "/admin", label: "管理", icon: <Settings size={18} strokeWidth={2.75} />, adminOnly: true },
  ];

  const initials = (name || email || "?").trim().charAt(0).toUpperCase();

  return (
    <nav className="w-[58px] shrink-0 h-full bg-panel-2 hidden md:flex flex-col items-center py-3.5 gap-1.5">
      {/* logo（34px 圓形品牌記號 — Organic） */}
      <div className="w-[34px] h-[34px] rounded-full bg-brand text-panel flex items-center justify-center font-display text-[16px] mb-2.5 select-none">
        W
      </div>

      {items
        .filter((it) => !it.adminOnly || role === "ADMIN")
        .map((it) => {
          const active = pathname === it.href || pathname.startsWith(it.href + "/");
          return (
            <Link
              key={it.href}
              href={it.href}
              title={it.label}
              aria-label={it.label}
              aria-current={active ? "page" : undefined}
              className={`w-[38px] h-[38px] rounded-full flex items-center justify-center ${
                active
                  ? "bg-brand-soft text-brand-text"
                  : "text-t2 hover:bg-black/[.04] hover:text-t1"
              }`}
            >
              {it.icon}
            </Link>
          );
        })}

      <div className="mt-auto flex flex-col items-center gap-2">
        {/* ThemeToggle 唔 render（Organic 呢輪無暗色 — 老細指令；[data-theme=dark] block 保留） */}
        <div
          title={`${name}\n${email}\n${role === "ADMIN" ? "管理員" : "店員"}`}
          className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold select-none ${
            role === "ADMIN" ? "bg-warn-soft text-warn-text" : "bg-brand-soft text-brand-text"
          }`}
        >
          {initials}
        </div>
        <button
          onClick={logout}
          disabled={busy}
          title="登出"
          aria-label="登出"
          className="w-[38px] h-[38px] rounded-full flex items-center justify-center text-t3 hover:bg-danger-soft hover:text-danger-text disabled:opacity-50"
        >
          <LogOut size={16} strokeWidth={2.75} />
        </button>
      </div>
    </nav>
  );
}

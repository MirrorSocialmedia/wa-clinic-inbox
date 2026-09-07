"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { CalendarDays, LogOut, MessageCircle, Settings, Stethoscope } from "lucide-react";
import { logoutWithPushCleanup } from "@/lib/notify-client";

/**
 * 左邊 icon rail（SleekFlow 式），取代舊 TopBar。
 * - 導航：收件箱 / 預約 /（ADMIN）管理
 * - 底部：用戶 initials → avatar menu（姓名/email/角色 + 明確「登出」項 — cwi-notify-v2 MD §5）
 */
export function NavRail({
  name,
  email,
  role,
}: {
  name: string;
  email: string;
  role: "ADMIN" | "STAFF" | "SUPERVISOR";
}) {
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();

  async function logout() {
    setBusy(true);
    // MD §3.6：先清 push subscription（client）→ server 兜底 → 清 session → /login
    await logoutWithPushCleanup();
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
        {/* cwi-notify-v2（MD §5）：avatar menu — 明確登出入口（舊版只有 icon 唔夠明確） */}
        <div className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            title={`${name}\n${email}\n${role === "ADMIN" ? "管理員" : role === "SUPERVISOR" ? "主管" : "店員"}`}
            aria-label="帳戶選單"
            aria-expanded={menuOpen}
            className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold select-none hover:opacity-85 ${
              role === "ADMIN" ? "bg-warn-soft text-warn-text" : "bg-brand-soft text-brand-text"
            }`}
          >
            {initials}
          </button>
          {menuOpen && (
            <>
              {/* 背景 click 關閉 */}
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
              <div className="absolute bottom-0 left-full ml-2.5 z-50 w-56 rounded-xl border border-line bg-panel shadow-xl p-3">
                <div className="text-sm font-semibold text-t1 truncate">{name}</div>
                <div className="text-xs text-t3 truncate">{email}</div>
                <div className="text-xs text-t3">{role === "ADMIN" ? "管理員" : role === "SUPERVISOR" ? "主管" : "店員"}</div>
                <button
                  onClick={logout}
                  disabled={busy}
                  className="mt-2.5 w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-danger-soft text-danger-text hover:bg-danger hover:text-panel disabled:opacity-50"
                >
                  <LogOut size={15} strokeWidth={2.75} />
                  {busy ? "登出中…" : "登出"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}

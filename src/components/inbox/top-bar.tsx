"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";

/** 頂欄：導航 + 使用者 + 登出。 */
export function TopBar({
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

  const navCls = (active: boolean) =>
    `text-sm px-2.5 py-1 rounded ${active ? "bg-neutral-700 text-white" : "text-neutral-300 hover:text-white"}`;

  return (
    <header className="h-12 shrink-0 bg-neutral-900 text-white flex items-center justify-between px-4">
      <div className="flex items-center gap-4">
        <span className="font-semibold tracking-tight">WA Clinic Inbox</span>
        <nav className="flex items-center gap-1">
          <Link href="/inbox" className={navCls(pathname === "/inbox")}>
            💬 收件箱
          </Link>
          <Link href="/bookings" className={navCls(pathname === "/bookings")}>
            📅 預約
          </Link>
        </nav>
        <span
          className={`text-[11px] px-1.5 py-0.5 rounded ${
            role === "ADMIN" ? "bg-amber-500/20 text-amber-300" : "bg-sky-500/20 text-sky-300"
          }`}
        >
          {role === "ADMIN" ? "管理員" : "店員"}
        </span>
      </div>
      <div className="flex items-center gap-3 text-sm">
        <span className="text-neutral-300">{name}</span>
        <span className="text-neutral-500 text-xs hidden sm:inline">{email}</span>
        <button
          onClick={logout}
          disabled={busy}
          className="text-xs px-2.5 py-1 rounded bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50"
        >
          登出
        </button>
      </div>
    </header>
  );
}

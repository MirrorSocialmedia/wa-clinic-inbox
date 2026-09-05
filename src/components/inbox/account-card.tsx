"use client";

import { useState } from "react";
import { LogOut } from "lucide-react";
import { logoutWithPushCleanup } from "@/lib/notify-client";

/**
 * 帳戶卡（cwi-notify-v2-20260903 MD §5）：頭像 + 姓名 + 角色 + 所屬診所（多店列晒）+ 登出。
 * 用點：/account（手機 STAFF「我的」tab / 任何角色）+ /admin 頁頂（ADMIN 手機「管理」tab）。
 * 登出走 §3.6 清理：push unsubscribe（client）→ server DB 兜底 → POST /api/auth/logout → /login。
 */
export function AccountCard({
  name,
  email,
  role,
  clinics,
}: {
  name: string;
  email: string;
  role: "ADMIN" | "STAFF";
  clinics: { code: string; name: string }[];
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const initials = (name || email || "?").trim().charAt(0).toUpperCase();

  async function onLogout() {
    if (!confirming) {
      setConfirming(true);
      return; // 二次確認（共用前台機 — 防誤觸登出）
    }
    setBusy(true);
    await logoutWithPushCleanup();
  }

  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="flex items-center gap-3">
        <div
          className={`w-11 h-11 rounded-full flex items-center justify-center text-base font-semibold select-none shrink-0 ${
            role === "ADMIN" ? "bg-warn-soft text-warn-text" : "bg-brand-soft text-brand-text"
          }`}
        >
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-t1 truncate">{name}</span>
            <span
              className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded ${
                role === "ADMIN" ? "bg-warn-soft text-warn-text" : "bg-brand-soft text-brand-text"
              }`}
            >
              {role === "ADMIN" ? "管理員" : "店員"}
            </span>
          </div>
          <div className="text-xs text-t3 truncate">{email}</div>
        </div>
      </div>

      {/* 所屬診所（多店列晒 — T194；ADMIN = 全部店） */}
      <div className="mt-3 pt-3 border-t border-line">
        <div className="text-[11px] text-t3 mb-1.5">{role === "ADMIN" ? "管理診所" : "所屬診所"}</div>
        <div className="flex flex-wrap gap-1.5">
          {clinics.map((c) => (
            <span key={c.code} className="text-xs px-2 py-1 rounded-md bg-panel-2 text-t2">
              <span className="font-semibold text-t1">{c.code}</span> {c.name}
            </span>
          ))}
        </div>
      </div>

      {/* 登出（§3.6：先清 push subscription → server 兜底 → 清 session → /login） */}
      <button
        onClick={onLogout}
        disabled={busy}
        className={`mt-3 w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${
          confirming
            ? "bg-danger text-panel"
            : "bg-danger-soft text-danger-text hover:bg-danger hover:text-panel"
        }`}
      >
        <LogOut size={16} strokeWidth={2.75} />
        {busy ? "登出中…" : confirming ? "再撳一次確認登出" : "登出"}
      </button>
    </div>
  );
}

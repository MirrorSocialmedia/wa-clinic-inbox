"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Shield } from "lucide-react";

/**
 * /login — Organic 登入頁（設計稿 1h）：
 * 置中卡 460×600 bg-panel rounded-[32px] shadow-md + 兩個裝飾圓裁切 + 52px 品牌記號。
 * 邏輯照舊：POST /api/auth/login → 成功跳 /inbox。
 */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(res.status === 429 ? "嘗試次數太多，請稍候再試" : "帳號或密碼錯誤");
        return;
      }
      const data = (await res.json()) as { redirect?: string };
      router.push(data.redirect ?? "/inbox");
      router.refresh();
    } catch {
      setError("網絡錯誤，請重試");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-canvas p-4">
      <form
        onSubmit={submit}
        className="relative w-full max-w-[460px] min-h-[600px] bg-panel rounded-[32px] shadow-md overflow-hidden flex flex-col justify-center gap-6 px-11 py-10"
      >
        {/* 裝飾圓（溢出卡外被 overflow-hidden 裁） */}
        <div className="absolute -top-[110px] -right-[120px] w-[300px] h-[300px] rounded-full bg-brand-soft pointer-events-none" />
        <div className="absolute -bottom-[60px] -left-[70px] w-[170px] h-[170px] rounded-full bg-danger-soft pointer-events-none" />

        <div className="relative flex flex-col">
          <div className="w-[52px] h-[52px] rounded-full bg-brand text-panel flex items-center justify-center font-display text-[24px] mb-3.5">
            W
          </div>
          <h3 className="text-[22px] text-t1">WA Clinic Inbox</h3>
          <p className="text-[13px] text-t2 mt-0.5">診所團隊的 WhatsApp 覆客系統</p>
        </div>

        <div className="relative flex flex-col gap-3.5">
          <label className="block">
            <span className="text-[12.5px] font-semibold text-t2">電郵</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="username"
              className="mt-1.5 w-full rounded-full min-h-11 border border-line-strong bg-panel-2 px-4 text-sm text-t1 placeholder:text-t3"
              placeholder="name@wa-clinic.local"
            />
          </label>
          <label className="block">
            <span className="text-[12.5px] font-semibold text-t2">密碼</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="mt-1.5 w-full rounded-full min-h-11 border border-line-strong bg-panel-2 px-4 text-sm text-t1 placeholder:text-t3"
              placeholder="••••••••"
            />
          </label>

          {error && (
            <p role="alert" className="text-[13px] text-danger-text bg-danger-soft border border-danger/40 rounded-full px-4 py-2.5">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-full bg-brand hover:bg-brand-hover text-panel text-[15px] font-semibold min-h-12 disabled:opacity-50"
          >
            {busy ? "登入中…" : "登入"}
          </button>

          <div className="flex items-center gap-1.5 text-[11.5px] text-t2">
            <Shield size={14} strokeWidth={2.75} className="text-brand flex-none" />
            ADMIN 帳號登入後要輸入兩步驟驗證碼
          </div>
        </div>
      </form>
    </div>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * /login — 簡潔登入頁（繁體中文）。
 * POST /api/auth/login → 成功跳 /inbox。
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
    <div className="min-h-screen flex items-center justify-center bg-neutral-50">
      <form
        onSubmit={submit}
        className="w-full max-w-sm bg-white rounded-lg border border-neutral-200 p-8 shadow-sm space-y-5"
      >
        <div className="space-y-1">
          <h1 className="text-xl font-semibold text-neutral-900">WA Clinic Inbox</h1>
          <p className="text-sm text-neutral-500">請用員工帳號登入</p>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="text-sm text-neutral-700">Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="username"
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="name@wa-clinic.local"
            />
          </label>
          <label className="block">
            <span className="text-sm text-neutral-700">密碼</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="••••••••"
            />
          </label>
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-blue-600 text-white text-sm font-medium py-2 hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? "登入中…" : "登入"}
        </button>
      </form>
    </div>
  );
}

"use client";

import { useState } from "react";

/**
 * TOTP 兩步驟卡片（安全審計 H-2 最小 UI）— 跟 admin 頁現有設計語言
 * （bg-panel / border-line / p-5 / 現有 badge 與 button 樣式），唔搞新視覺。
 *
 * 流程：未啟用 →「啟用 TOTP」→ POST /api/admin/totp/enroll →
 * 顯示 secret（**只此一次** — 驗證器 app 手動輸入）→ 狀態轉「已啟用」。
 * 已啟用 → 狀態 +「輪換」（再 enroll = 新 secret，舊嘅作廢）。
 *（零新依賴：QR 要 qrcode package，已棄 — 手動輸入 secret 就夠，零邊角 case。）
 *
 * ★ secret 只呈咗畀 ADMIN 自己嘅 DOM；log/alert 永唔帶（API 邊已守住）。
 */
export function TotpCard({ enabled }: { enabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [enabledNow, setEnabledNow] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const enroll = async () => {
    setBusy(true);
    setError(null);
    setSecret(null);
    try {
      const res = await fetch("/api/admin/totp/enroll", { method: "POST" });
      const data = (await res.json()) as {
        ok?: boolean;
        secret?: string;
        uri?: string;
        error?: string;
      };
      if (!res.ok || !data.ok || !data.secret || !data.uri) {
        setError(data.error ?? `啟用失敗（HTTP ${res.status}）`);
        return;
      }
      setSecret(data.secret);
      setEnabledNow(true);
    } catch {
      setError("啟用失敗（網絡錯誤）");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bg-panel rounded-lg border border-line p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-medium text-t1">兩步驟驗證（TOTP）</h2>
        {enabledNow ? (
          <span className="text-xs px-2 py-1 rounded bg-ok-soft text-ok-text border border-ok/40">
            已啟用 — 下次登入起要驗證器 app 6 位碼
          </span>
        ) : (
          <span className="text-xs px-2 py-1 rounded bg-panel-2 text-t2 border border-line-strong">
            未啟用
          </span>
        )}
      </div>
      <p className="text-sm text-t2 mb-3">
        啟用後 ADMIN 登入要第二步驗證碼（30 秒一換）；STAFF 登入流程不受影響。
      </p>

      {secret && (
        <div className="mb-3 border border-warn/40 bg-warn-soft rounded p-3">
          <div className="text-xs font-semibold text-warn-text mb-2">
            ⚠ Secret 只顯示呢一次 — 用驗證器 app（手動輸入模式）保存
          </div>
          <div className="font-mono text-sm break-all bg-panel rounded p-2 select-all">
            {secret}
          </div>
        </div>
      )}

      {error && <p className="text-sm text-danger-text mb-3">{error}</p>}

      <button
        onClick={() => void enroll()}
        disabled={busy}
        className="rounded-md bg-brand text-white text-sm px-4 py-2 hover:bg-brand-hover disabled:opacity-50"
      >
        {busy ? "生成中…" : enabledNow ? "輪換（重新生成 secret）" : "啟用 TOTP"}
      </button>
    </section>
  );
}

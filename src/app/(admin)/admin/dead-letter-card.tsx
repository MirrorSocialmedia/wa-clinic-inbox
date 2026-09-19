"use client";

import { useState, useCallback } from "react";

/**
 * /admin DLQ 卡（★ cwi-final S1-1a）：未重放 dead-letter 計數 + 重放掣（global admin only —
 * /admin layout 已把關；重放 API 再 requireAdmin 一層）。
 *
 * 重放 = POST /api/admin/dead-letters/replay（decrypt → inboundQueue 重入；WebhookEvent
 * claim 冪等 → 訊息唔會重複入 DB）。成功行標 replayedAt；失敗行留底俾下次再試。
 */
export function DeadLetterCard({ pending: initialPending }: { pending: number }) {
  const [pending, setPending] = useState(initialPending);
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const replay = useCallback(async () => {
    setBusy(true);
    setLastResult(null);
    try {
      const res = await fetch("/api/admin/dead-letters/replay", { method: "POST" });
      if (res.ok) {
        const r = (await res.json()) as { replayed: number; failed: number; pending: number };
        setPending(r.pending);
        setLastResult(`已重放 ${r.replayed} 條（失敗 ${r.failed}）`);
      } else {
        setLastResult(`重放失敗（HTTP ${res.status}）`);
      }
    } catch {
      setLastResult("重放失敗（網絡錯誤）");
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <div className="text-sm text-t1">
          未重放 DLQ <span className="font-display text-[20px] text-t1">{pending}</span> 條
          {pending > 0 && <span className="text-danger-text ml-1.5 text-xs">（inbound 最終失敗 — 訊息未入 DB）</span>}
        </div>
        <p className="text-xs text-t2 mt-0.5">
          payload AES-256-GCM 加密 · 重放走 WebhookEvent 冪等（唔會重複入 DB）· retention 30 日清
        </p>
        {lastResult && <p className="text-xs text-t3 mt-0.5">{lastResult}</p>}
      </div>
      {pending > 0 && (
        <button
          onClick={replay}
          disabled={busy}
          className="shrink-0 rounded-lg bg-panel-2 border border-line px-3 py-1.5 text-sm text-t1 hover:bg-black/[.06] disabled:opacity-50"
        >
          {busy ? "重放中…" : "重放"}
        </button>
      )}
    </div>
  );
}

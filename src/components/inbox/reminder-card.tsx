"use client";

import { useState } from "react";
import { AlarmClock } from "lucide-react";
import type { FollowupSuggestion } from "./types";
import { fmtMonthDay } from "./reminder-control";

/**
 * ★ cwi-reminder-20261025：「⏰ 跟進提醒」卡（員工自設提醒到期 — 取代「等回覆」）。
 * 操作打 PATCH /api/conversations/:id/reminder；server emit followup:changed → 卡自動消失／更新。
 */
export function ReminderCard({
  conversationId,
  suggestion,
  readOnly,
}: {
  conversationId: string;
  suggestion: FollowupSuggestion;
  readOnly: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const c = (suggestion.contextJson ?? {}) as { reason?: string | null; remindStaffName?: string | null };

  async function act(action: "done" | "snooze" | "cancel") {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/reminder`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "snooze" ? { action, days: 3 } : { action }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setHidden(true);
    } catch {
      setErr("操作失敗 — 再試一次");
    } finally {
      setBusy(false);
    }
  }

  if (hidden) return null;
  return (
    <div className="mb-2 rounded-[26px] border-2 border-dashed border-brand/60 bg-panel p-3.5" data-e2e="reminder-card">
      <div className="flex items-center gap-1.5 flex-wrap">
        <AlarmClock size={15} strokeWidth={2.75} className="text-brand-text" />
        <span className="text-[12.5px] font-semibold text-brand-text">跟進提醒</span>
        <span className="text-[11px] text-t3">
          · {c.remindStaffName ?? "你"} {fmtMonthDay(suggestion.createdAt)} 設定 · {fmtMonthDay(suggestion.dueAt)} 到期
        </span>
      </div>
      {c.reason ? <div className="mt-1.5 text-[13px] text-t1 break-words">原因：{c.reason}</div> : null}
      <div className="mt-2 flex gap-1.5 flex-wrap">
        <button
          onClick={() => void act("done")}
          disabled={busy || readOnly}
          className="text-xs px-3 py-1 rounded-full bg-brand hover:bg-brand-hover text-panel font-medium disabled:opacity-40"
          data-e2e="reminder-done"
        >
          已跟進（完成）
        </button>
        <button
          onClick={() => void act("snooze")}
          disabled={busy || readOnly}
          className="text-xs px-3 py-1 rounded-full border border-line-strong text-t2 hover:bg-panel-2 disabled:opacity-40"
          data-e2e="reminder-snooze"
        >
          再延 3 日
        </button>
        <button
          onClick={() => void act("cancel")}
          disabled={busy || readOnly}
          className="text-xs px-3 py-1 rounded-full border border-line-strong text-t2 hover:bg-panel-2 disabled:opacity-40"
          data-e2e="reminder-cancel"
        >
          取消提醒
        </button>
      </div>
      {err ? <div className="mt-1 text-[11px] text-danger-text">{err}</div> : null}
    </div>
  );
}

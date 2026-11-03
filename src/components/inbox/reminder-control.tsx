"use client";

import { useState } from "react";
import type { ConversationItem, ConvStatus } from "./types";

/**
 * ★ cwi-reminder-20261025：右欄狀態「處理中｜⏰ 待跟進｜已解決」（取代「等回覆」）。
 * 「⏰ 待跟進」= 設提醒（唔係狀態）：揀日子 + 原因 + 提醒邊個（預設設提醒嗰個人）→ POST /api/conversations/:id/reminder。
 * 到期入「待跟進」分頁 + 🔔；設定後 server emit followup:changed → 列表行／呢度即時更新。
 */
/** 香港日期 → 「10/25」（同 app 其他地方一致：月/日） */
export function fmtMonthDay(iso: string): string {
  const [, m, d] = new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" }).split("-");
  return `${Number(m)}/${Number(d)}`;
}

const PRESETS: { label: string; days: number }[] = [
  { label: "聽日", days: 1 },
  { label: "3 日後", days: 3 },
  { label: "1 星期後", days: 7 },
  { label: "2 星期後", days: 14 },
];

export function StatusReminderControl({
  c,
  readOnly,
  onSetStatus,
}: {
  c: ConversationItem;
  readOnly: boolean;
  onSetStatus: (s: ConvStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<number | null>(3);
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [target, setTarget] = useState<"me" | "assignee">("me");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const r = c.reminder ?? null;
  const fmt = fmtMonthDay;

  function openPop() {
    setErr(null);
    setReason(r?.reason ?? "");
    setDays(r ? null : 3);
    setDate(r ? new Date(r.dueAt).toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" }) : "");
    setTarget("me");
    setOpen(true);
  }

  async function call(method: "POST" | "PATCH", body: unknown) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(c.id)}/reminder`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(j?.message ?? `設定失敗（${res.status}）`);
      }
      setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "設定失敗");
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    void call("POST", {
      ...(days !== null ? { days } : { date }),
      reason: reason.trim() || null,
      target,
    });
  const canSave = days !== null || /^\d{4}-\d{2}-\d{2}$/.test(date);
  const pill = (on: boolean) =>
    `text-xs px-2.5 py-1 rounded-full border ${on ? "bg-brand-soft border-brand text-brand-text font-semibold" : "border-line text-t2 hover:bg-panel-2"}`;

  return (
    <div className="relative">
      <div className="flex bg-panel-2 rounded-full p-[3px] text-xs text-center gap-[2px]" data-e2e="status-seg">
        <button
          onClick={() => onSetStatus("OPEN")}
          disabled={readOnly}
          className={`flex-1 py-1.5 rounded-full ${c.status !== "RESOLVED" ? "bg-brand text-panel font-semibold shadow-sm" : "text-t2 hover:bg-black/[.04]"}`}
        >
          處理中
        </button>
        <button
          onClick={openPop}
          disabled={readOnly}
          data-e2e="reminder-open"
          title={r ? `已設提醒：${fmt(r.dueAt)}${r.reason ? ` — ${r.reason}` : ""}` : "設定跟進提醒 — 到期入「待跟進」+ 🔔 通知"}
          className={`flex-1 py-1.5 rounded-full whitespace-nowrap ${r ? "bg-brand-soft text-brand-text font-semibold" : "text-t2 hover:bg-black/[.04]"}`}
        >
          ⏰ {r ? `${fmt(r.dueAt)} 跟進` : "待跟進"}
        </button>
        <button
          onClick={() => onSetStatus("RESOLVED")}
          disabled={readOnly}
          className={`flex-1 py-1.5 rounded-full ${c.status === "RESOLVED" ? "bg-brand text-panel font-semibold shadow-sm" : "text-t2 hover:bg-black/[.04]"}`}
        >
          已解決
        </button>
      </div>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute left-0 right-0 top-10 z-40 rounded-2xl border border-line bg-panel shadow-lg p-3.5 text-sm" data-e2e="reminder-pop">
            <div className="font-semibold text-[13px] mb-2">幾時提醒你跟進？</div>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {PRESETS.map((p) => (
                <button key={p.days} onClick={() => setDays(p.days)} className={pill(days === p.days)}>
                  {p.label}
                </button>
              ))}
              <label className={`${pill(days === null)} inline-flex items-center gap-1 cursor-pointer`}>
                📅
                <input
                  type="date"
                  value={date}
                  onChange={(e) => {
                    setDate(e.target.value);
                    setDays(null);
                  }}
                  className="bg-transparent text-xs outline-none w-[110px]"
                  data-e2e="reminder-date"
                />
              </label>
            </div>
            <div className="text-[11px] text-t3 mb-1">原因（選填 — 到時提醒會顯示）</div>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, 100))}
              placeholder="例：等佢睇完保險再覆"
              className="w-full rounded-xl border border-line bg-panel px-2.5 py-1.5 text-[12.5px] mb-2 focus:outline-none focus:border-brand"
              data-e2e="reminder-reason"
            />
            <div className="text-[11px] text-t3 mb-1">提醒邊個</div>
            <div className="flex gap-1.5 mb-3">
              <button onClick={() => setTarget("me")} className={pill(target === "me")}>我</button>
              <button onClick={() => setTarget("assignee")} disabled={!c.assigneeId} className={`${pill(target === "assignee")} disabled:opacity-40`}>
                對話負責人{c.assigneeName ? `（${c.assigneeName}）` : ""}
              </button>
            </div>
            {err ? <div className="text-[11px] text-danger-text mb-2">{err}</div> : null}
            <div className="flex items-center gap-1.5">
              {r ? (
                <button
                  onClick={() => void call("PATCH", { action: "cancel" })}
                  disabled={busy}
                  className="text-xs text-danger-text hover:underline disabled:opacity-40"
                  data-e2e="reminder-remove"
                >
                  取消提醒
                </button>
              ) : null}
              <span className="flex-1" />
              <button onClick={() => setOpen(false)} className="text-xs px-3 py-1 rounded-full border border-line text-t2 hover:bg-panel-2">
                取消
              </button>
              <button
                onClick={save}
                disabled={busy || !canSave}
                className="text-xs px-3 py-1 rounded-full bg-brand text-panel font-medium hover:bg-brand-hover disabled:opacity-40"
                data-e2e="reminder-save"
              >
                {r ? "更新提醒" : "設定提醒"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

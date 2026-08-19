"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

/**
 * /bookings 預約隊列 client（MD §8.3）。
 *
 * 卡 = PENDING 預約（病人/醫生/日期/時間/對話連結）：
 * - 〔已喺 Apricot 落單〕→ POST /api/bookings/[id]/confirm
 *   200 = 已確認 + 自動訊息已發；422 = 已確認但過窗（提示用 template）
 * - 〔改期〕→ POST /api/bookings/[id]/reschedule（重出 Flow）
 * - 48h 未處理 → EXPIRED（cron 自動，此處顯示狀態）
 */

type BookingStatus = "PENDING" | "CONFIRMED" | "REJECTED" | "EXPIRED";

interface Booking {
  id: string;
  clinicId: string;
  conversationId: string;
  providerApricotId: string;
  providerName: string;
  requestedDate: string;
  requestedTime: string;
  precheckPassed: boolean;
  status: BookingStatus;
  handledByStaffName: string | null;
  handledAt: string | null;
  createdAt: string;
  conversation: {
    id: string;
    contact: { id: string; waId: string | null; profileName: string | null };
    window: { open: boolean; remainingHours: number };
  } | null;
}

interface UserCtx {
  staffId: string;
  name: string;
  role: "ADMIN" | "STAFF";
  clinicId: string | null;
}

const STATUS_STYLE: Record<BookingStatus, string> = {
  PENDING: "bg-warn-soft text-warn-text border-warn/40",
  CONFIRMED: "bg-ok-soft text-ok-text border-ok/40",
  REJECTED: "bg-danger-soft text-danger-text border-danger/40",
  EXPIRED: "bg-line text-t3 border-line-strong",
};

const STATUS_LABEL: Record<BookingStatus, string> = {
  PENDING: "等處理",
  CONFIRMED: "已確認",
  REJECTED: "已拒絕",
  EXPIRED: "已過期",
};

export function BookingsClient({ user }: { user: UserCtx }) {
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [filter, setFilter] = useState<"PENDING" | "ALL">("PENDING");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const qs = filter === "PENDING" ? "?status=PENDING" : "";
      const res = await fetch(`/api/bookings${qs}`);
      if (!res.ok) return;
      setBookings((await res.json()) as Booking[]);
    } catch {
      /* ignore */
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 6000);
  };

  async function confirm(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/bookings/${id}/confirm`, { method: "POST" });
      const data = (await res.json().catch(() => null)) as {
        confirmed?: boolean;
        autoMessage?: { sent: boolean; reason?: string; hint?: string };
        error?: string;
      } | null;
      if (res.status === 409) {
        flash("呢張卡已經處理過（狀態已變）");
      } else if (res.status === 422) {
        flash(data?.autoMessage?.hint ?? "窗口已過 — 請用 utility template 覆病人");
      } else if (!res.ok) {
        flash(data?.error ?? `確認失敗（${res.status}）`);
      } else {
        flash(
          data?.autoMessage?.sent
            ? "已確認 + 確認訊息已發俾病人 ✅"
            : "已確認（訊息未自動發 — 見提示）"
        );
      }
      void load();
    } finally {
      setBusyId(null);
    }
  }

  async function reschedule(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/bookings/${id}/reschedule`, { method: "POST" });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; message?: string } | null;
      if (res.status === 409) {
        flash("呢張卡已經處理過（狀態已變）");
      } else if (res.status === 422) {
        flash(data?.message ?? "窗口已過 — 重出 Flow 要用 template");
      } else if (!res.ok) {
        flash(data?.error ?? `改期失敗（${res.status}）`);
      } else {
        flash("預約 Flow 已重新發咗俾病人 📅");
      }
      void load();
    } finally {
      setBusyId(null);
    }
  }

  if (bookings === null) {
    return <div className="p-8 text-sm text-t3">載入中…</div>;
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto p-4 space-y-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-t1">📅 預約隊列</h1>
          <div className="ml-auto flex gap-1 text-xs">
            {(["PENDING", "ALL"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-2.5 py-1 rounded ${
                  filter === f ? "bg-t1 text-canvas" : "bg-panel-2 text-t2 hover:bg-line"
                }`}
              >
                {f === "PENDING" ? `等處理 (${bookings?.length ?? 0})` : "全部"}
              </button>
            ))}
          </div>
        </div>

        <p className="text-xs text-t2">
          流程：病人 Flow 揀好 → 卡出現（precheck 已對過空檔）→ 你去 Apricot 人手落單 → 返嚟撳〔已喺 Apricot 落單〕→
          系統自動覆病人。48 小時冇人處理會自動過期。
        </p>

        {bookings.length === 0 && (
          <div className="text-center text-t3 text-sm py-16">
            <div className="text-4xl mb-2">📭</div>
            {filter === "PENDING" ? "冇等處理嘅預約" : "冇預約記錄"}
          </div>
        )}

        {bookings.map((b) => (
          <div
            key={b.id}
            className={`rounded-lg border bg-panel shadow-sm p-4 space-y-2 ${
              b.status === "PENDING" ? "border-warn/40 ring-1 ring-warn/30" : "border-line"
            }`}
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-[11px] px-2 py-0.5 rounded-full border font-medium ${STATUS_STYLE[b.status]}`}>
                {STATUS_LABEL[b.status]}
              </span>
              <span className="text-sm font-semibold text-t1">
                {b.providerName} · {b.requestedDate} {b.requestedTime}
              </span>
              {b.precheckPassed && <span className="text-[10px] text-ok-text">✓ precheck 過</span>}
              <span className="ml-auto text-[11px] text-t3">{new Date(b.createdAt).toLocaleString()}</span>
            </div>

            <div className="flex items-center gap-3 text-xs text-t2 flex-wrap">
              {b.conversation ? (
                <>
                  <span>
                    病人：{b.conversation.contact.profileName ?? "未命名"}（{b.conversation.contact.waId ?? "-"}）
                  </span>
                  <Link
                    href={`/inbox?conv=${b.conversation.id}`}
                    className="text-brand-text underline underline-offset-2"
                  >
                    開對話 →
                  </Link>
                  <span
                    className={`px-1.5 py-0.5 rounded-full border ${
                      b.conversation.window.open
                        ? "bg-ok-soft text-ok-text border-ok/40"
                        : "bg-danger-soft text-danger-text border-danger/40"
                    }`}
                  >
                    {b.conversation.window.open
                      ? `窗口 ${Math.floor(b.conversation.window.remainingHours)}h`
                      : "窗口已過"}
                  </span>
                </>
              ) : (
                <span className="text-t3">（對話已刪除）</span>
              )}
              {b.handledByStaffName && (
                <span className="text-t3">
                  處理：{b.handledByStaffName}
                  {b.handledAt ? ` · ${new Date(b.handledAt).toLocaleString()}` : ""}
                </span>
              )}
            </div>

            {b.status === "PENDING" && (
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => void confirm(b.id)}
                  disabled={busyId === b.id}
                  className="text-xs px-3 py-1.5 rounded bg-ok hover:opacity-90 text-white font-medium disabled:opacity-40"
                >
                  {busyId === b.id ? "處理中…" : "✓ 已喺 Apricot 落單"}
                </button>
                <button
                  onClick={() => void reschedule(b.id)}
                  disabled={busyId === b.id}
                  className="text-xs px-3 py-1.5 rounded border border-line-strong bg-panel text-t2 hover:bg-panel-2 disabled:opacity-40"
                >
                  改期（重出 Flow）
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {notice && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-t1 text-canvas text-sm px-4 py-2 rounded-xl shadow-lg z-50">
          {notice}
        </div>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { io } from "socket.io-client";
import Link from "next/link";
import { Clock } from "lucide-react";
import { relTime } from "./time";

/**
 * /bookings 預約隊列 client（MD §8.3）。
 *
 * 卡 = PENDING 預約（病人/醫生/日期/時間/對話連結）：
 * - 〔已喺醫生系統落單〕→ POST /api/bookings/[id]/confirm
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
  requestedTime: string | null;
  /** 純收需求變體（資料源離線）：MORNING / AFTERNOON / EVENING */
  timeOfDay: string | null;
  /** null = 未經空檔核對（資料源離線，純收需求變體） */
  precheckPassed: boolean | null;
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

const TIME_OF_DAY_LABEL: Record<string, string> = { MORNING: "上晝", AFTERNOON: "下晝", EVENING: "夜晚" };

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

  // ★ booking-ui（C）：代落單/rollback/改期/取消 寫入後 → 隊列重拉（room 由 hub 按 session 自動 join；payload 全列表重拉，唔 binding）
  useEffect(() => {
    const socket = io({ withCredentials: true, transports: ["websocket", "polling"] });
    socket.on("booking:changed", () => {
      void load();
    });
    return () => {
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // 「9/1」+ 星期（清單式日期欄）
  const fmtDay = (dateStr: string): { md: string; weekday: string } => {
    const d = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(d.getTime())) return { md: dateStr, weekday: "" };
    return {
      md: `${d.getMonth() + 1}/${d.getDate()}`,
      weekday: d.toLocaleDateString("zh-Hant-HK", { weekday: "short" }),
    };
  };
  // remainingHours（小數）→ "18h 42m"
  const fmtWindow = (h: number): string => {
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    return mm > 0 ? `${hh}h ${String(mm).padStart(2, "0")}m` : `${hh}h`;
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto p-5">
        {/* 頁頭（Organic 1e） */}
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-[22px] text-t1">預約請求</h1>
            <p className="mt-1 text-[12.5px] text-t2">
              病人在 WhatsApp Flow 揀好醫生日期時間後入這裡。你去醫生系統落單後返嚟按確認，系統自動覆病人。48 小時無人處理自動過期。
            </p>
          </div>
          <div className="flex gap-1.5 flex-none">
            <button
              onClick={() => setFilter("PENDING")}
              className={`rounded-full px-3.5 py-1.5 text-xs font-semibold ${
                filter === "PENDING" ? "bg-t1 text-canvas" : "border border-line text-t2 hover:bg-black/[.04]"
              }`}
            >
              待處理 {bookings.length}
            </button>
            <button
              onClick={() => setFilter("ALL")}
              className={`rounded-full px-3.5 py-1.5 text-xs font-semibold ${
                filter === "ALL" ? "bg-t1 text-canvas" : "border border-line text-t2 hover:bg-black/[.04]"
              }`}
            >
              全部
            </button>
          </div>
        </div>

        <div className="h-px bg-line my-5" />

        {bookings.length === 0 && (
          <div className="text-center text-t3 text-sm py-16">
            <div className="text-4xl mb-2">📭</div>
            {filter === "PENDING" ? "冇等處理嘅預約" : "冇預約記錄"}
          </div>
        )}

        {/* 清單式：一行一單（桌面掃得快） */}
        <div className="flex flex-col gap-2">
          {bookings.map((b) => {
            const pending = b.status === "PENDING";
            const day = fmtDay(b.requestedDate);
            const time = b.requestedTime ?? (b.timeOfDay ? TIME_OF_DAY_LABEL[b.timeOfDay] ?? b.timeOfDay : "");
            return (
              <div
                key={b.id}
                className={`flex items-center gap-4 px-5 py-4 rounded-[26px] ${pending ? "bg-ok-soft" : "bg-panel-2"}`}
              >
                {/* 日期欄（Caprasimo） */}
                <div className="flex-none text-center min-w-[58px]">
                  <div className={`font-display text-[24px] leading-none ${pending ? "text-brand-text" : "text-t2"}`}>
                    {day.md}
                  </div>
                  <div className={`text-[11px] font-semibold mt-1 ${pending ? "text-brand-text" : "text-t3"}`}>{day.weekday}</div>
                </div>
                <div className="w-px h-[38px] bg-line flex-none" />

                {/* 時間欄 */}
                <div className="flex-none min-w-[64px]">
                  <div className="font-display text-[18px] leading-none text-t1">{time || "—"}</div>
                  <div className="text-[10.5px] text-t3 mt-1">
                    {b.precheckPassed === true && "✓ 空檔初驗過"}
                    {b.precheckPassed === null && "空檔未核對"}
                    {b.precheckPassed === false && <span className="text-danger-text">✗ 空檔初驗未過</span>}
                  </div>
                </div>

                {/* 病人 + 醫生 + 開對話 */}
                <div className="flex-1 min-w-0">
                  <div className="text-[13.5px] font-semibold text-t1 truncate">
                    {b.conversation?.contact.profileName ?? "（對話已刪除）"}
                    {!pending && (
                      <span className={`ml-2 inline-flex items-center rounded-full border px-2 py-0.5 text-[10.5px] font-medium align-middle ${STATUS_STYLE[b.status]}`}>
                        {STATUS_LABEL[b.status]}
                      </span>
                    )}
                  </div>
                  <div className="text-[11.5px] text-t2 mt-1 truncate">
                    {b.providerName}
                    {b.conversation ? (
                      <>
                        {" · "}
                        <Link href={`/inbox?conv=${b.conversation.id}`} className="text-brand-text underline underline-offset-2">
                          開對話
                        </Link>
                      </>
                    ) : null}
                    {b.handledByStaffName && <span className="text-t3"> · 處理：{b.handledByStaffName}</span>}
                  </div>
                </div>

                {/* 窗口倒數 */}
                <div className="flex-none text-right">
                  {b.conversation ? (
                    b.conversation.window.open ? (
                      <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-brand-text justify-end">
                        <Clock size={12} strokeWidth={2.75} /> 窗口 {fmtWindow(b.conversation.window.remainingHours)}
                      </div>
                    ) : (
                      <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-danger-text justify-end">
                        <Clock size={12} strokeWidth={2.75} /> 窗口已過
                      </div>
                    )
                  ) : (
                    <div className="text-[11px] text-t3">—</div>
                  )}
                  <div className="text-[10.5px] text-t3 mt-1">請求於 {relTime(b.createdAt)}</div>
                </div>

                {/* 操作（只 PENDING） */}
                <div className="flex gap-2 flex-none">
                  {pending && (
                    <>
                      <button
                        onClick={() => void reschedule(b.id)}
                        disabled={busyId === b.id}
                        className="text-xs px-3.5 py-1.5 rounded-full border border-line bg-panel text-t2 hover:bg-panel-2 disabled:opacity-40"
                      >
                        改期
                      </button>
                      <button
                        onClick={() => void confirm(b.id)}
                        disabled={busyId === b.id}
                        className="text-xs px-3.5 py-1.5 rounded-full bg-brand hover:bg-brand-hover text-panel font-semibold disabled:opacity-40"
                      >
                        {busyId === b.id ? "處理中…" : "✓ 已喺醫生系統落單"}
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {notice && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-t1 text-canvas text-sm px-4 py-2 rounded-full shadow-lg z-50">
          {notice}
        </div>
      )}
    </div>
  );
}

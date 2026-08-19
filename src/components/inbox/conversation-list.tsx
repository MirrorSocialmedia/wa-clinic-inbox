"use client";

import { useMemo } from "react";
import { CalendarDays, MessageCircle, Search, X } from "lucide-react";
import type { ClinicInfo, ConversationItem, ConvStatus } from "./types";
import { relTime } from "./time";

interface Props {
  userRole: "ADMIN" | "STAFF";
  clinics: ClinicInfo[];
  activeClinicId: string | "all";
  onActiveClinic: (id: string | "all") => void;
  statusFilter: ConvStatus | "ALL";
  onStatusFilter: (s: ConvStatus | "ALL") => void;
  conversations: ConversationItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  search: string;
  onSearch: (q: string) => void;
  searchResults: ConversationItem[] | null;
  onClearSearch: () => void;
}

const STATUS_LABEL: Record<ConvStatus | "ALL", string> = {
  ALL: "全部",
  OPEN: "處理中",
  PENDING: "等回覆",
  RESOLVED: "已解決",
};

// Phase 2：intent 標籤（AI 分類；未分類 = 不顯示）
const INTENT_META: Record<string, { label: string; cls: string }> = {
  BOOKING_REQUEST: { label: "預約", cls: "bg-ok-soft text-ok-text" },
  URGENT_PAIN: { label: "急症", cls: "bg-danger text-white" },
  OUT_OF_SCOPE: { label: "離題", cls: "bg-panel-2 text-t3" },
  QUESTION: { label: "查詢", cls: "bg-brand-soft text-brand-text" },
  OTHER: { label: "其他", cls: "bg-panel-2 text-t3" },
};

// avatar 色：waId hash 揀一隻（穩定，唔會閃）
const AVATAR_CLS = [
  "bg-brand-soft text-brand-text",
  "bg-ok-soft text-ok-text",
  "bg-warn-soft text-warn-text",
  "bg-panel-2 text-t2",
];
function avatarCls(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_CLS[Math.abs(h) % AVATAR_CLS.length];
}
function avatarChar(c: ConversationItem): string {
  const n = c.contact?.profileName?.trim();
  return n ? n.charAt(0) : "?";
}

function previewOf(c: ConversationItem): string {
  return c.preview ?? c.contact?.profileName ?? c.contact?.waId ?? "（無訊息）";
}

/**
 * 隊列欄（MD §6.4）v2 — SleekFlow 風格：
 * - clinic dropdown（ADMIN；STAFF 只自己店，唔顯示）
 * - 搜尋 / 狀態 filter chips
 * - item：avatar + WA badge / unread / 窗口 tone（時間變色）/ intent / 急症紅邊 / 📅
 * - 排序邏輯不變：urgent 頂 → 一般 → RESOLVED 沉底；同級 lastMessageAt desc
 */
export function ConversationList(p: Props) {
  const items = useMemo(() => {
    if (p.searchResults) return p.searchResults;
    let list = p.conversations;
    if (p.statusFilter !== "ALL") list = list.filter((c) => c.status === p.statusFilter);
    return [...list].sort((a, b) => {
      const rank = (c: ConversationItem) =>
        c.urgent && c.status !== "RESOLVED" ? 0 : c.status === "RESOLVED" ? 2 : 1;
      const ar = rank(a);
      const br = rank(b);
      if (ar !== br) return ar - br;
      return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime();
    });
  }, [p.conversations, p.searchResults, p.statusFilter]);

  return (
    <aside className="w-80 shrink-0 border-r border-line bg-panel flex flex-col min-h-0">
      {/* header：標題 + clinic dropdown（ADMIN only） */}
      <div className="px-3 pt-3 pb-2 flex items-center justify-between gap-2">
        <span className="text-[15px] font-semibold text-t1">收件箱</span>
        {p.userRole === "ADMIN" && (
          <select
            value={p.activeClinicId}
            onChange={(e) => p.onActiveClinic(e.target.value as string | "all")}
            className="text-xs rounded-full bg-brand-soft text-brand-text border-0 pl-3 pr-7 py-1 focus:outline-none focus:ring-1 focus:ring-brand appearance-none bg-no-repeat bg-[right_0.5rem_center] bg-[length:0.7rem] bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%234338CA%22 stroke-width=%223%22><path d=%22m6 9 6 6 6-6%22/></svg>')]"
          >
            <option value="all">全部診所</option>
            {p.clinics.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* search */}
      <div className="px-3">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-t3" />
          <input
            value={p.search}
            onChange={(e) => p.onSearch(e.target.value)}
            placeholder="搜尋病人姓名或號碼"
            className="w-full text-sm rounded-lg bg-panel-2 border border-transparent pl-8 pr-8 py-1.5 text-t1 placeholder:text-t3 focus:outline-none focus:border-brand focus:bg-panel"
          />
          {p.search && (
            <button
              onClick={p.onClearSearch}
              aria-label="清除搜尋"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-t3 hover:text-t1"
            >
              <X size={14} />
            </button>
          )}
        </div>
        {p.searchResults && (
          <div className="text-[11px] text-t3 px-1 pt-1">
            搜尋結果（{p.searchResults.length}）— 點擊進入對話
          </div>
        )}
      </div>

      {/* status filter */}
      <div className="flex gap-1.5 px-3 py-2 overflow-x-auto">
        {(["ALL", "OPEN", "PENDING", "RESOLVED"] as const).map((s) => (
          <button
            key={s}
            onClick={() => p.onStatusFilter(s)}
            className={`px-2.5 py-0.5 rounded-full text-xs whitespace-nowrap ${
              p.statusFilter === s
                ? "bg-t1 text-canvas"
                : "bg-transparent text-t2 border border-line hover:bg-panel-2"
            }`}
          >
            {STATUS_LABEL[s]}
          </button>
        ))}
      </div>

      {/* list */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {items.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-10 text-t3">
            <MessageCircle size={28} strokeWidth={1.5} />
            <div className="text-sm">{p.search ? "冇搜到相關病人" : "冇對話"}</div>
          </div>
        )}
        {items.map((c) => {
          const intentMeta = c.intent ? INTENT_META[c.intent] : null;
          const urgentRow = c.urgent && c.status !== "RESOLVED";
          const selected = p.selectedId === c.id;
          const timeCls =
            c.window.tone === "red"
              ? "text-danger-text font-medium"
              : c.window.tone === "yellow"
                ? "text-warn-text font-medium"
                : "text-t3";
          return (
            <button
              key={c.id}
              onClick={() => p.onSelect(c.id)}
              className={`w-full text-left px-3 py-2.5 border-b border-line/60 flex gap-2.5 ${
                selected
                  ? "bg-brand-soft/60"
                  : urgentRow
                    ? "bg-danger-soft/50 hover:bg-danger-soft"
                    : "hover:bg-panel-2"
              } ${urgentRow ? "border-l-2 border-l-danger" : "border-l-2 border-l-transparent"} ${
                c.status === "RESOLVED" ? "opacity-60" : ""
              }`}
            >
              {/* avatar + WA channel badge */}
              <div className="relative shrink-0 self-start mt-0.5">
                <div
                  className={`w-9 h-9 rounded-full flex items-center justify-center text-[13px] font-medium ${avatarCls(
                    c.contact?.waId ?? c.id
                  )}`}
                >
                  {avatarChar(c)}
                </div>
                <span className="absolute -right-0.5 -bottom-0.5 w-3.5 h-3.5 rounded-full bg-panel flex items-center justify-center">
                  <span className="w-2.5 h-2.5 rounded-full bg-wa" title="WhatsApp" />
                </span>
              </div>

              <div className="min-w-0 flex-1">
                {/* row 1：名 + 時間（窗口 tone 變色） */}
                <div className="flex items-center gap-1.5">
                  <span
                    className={`text-sm truncate ${
                      c.unreadCount > 0 ? "font-semibold text-t1" : "text-t1"
                    }`}
                  >
                    {c.contact?.profileName || c.contact?.waId || "（未知聯絡人）"}
                  </span>
                  <span
                    className={`ml-auto text-[11px] shrink-0 ${timeCls}`}
                    title="24h 窗口狀態：黃 <6h / 紅 已過窗"
                  >
                    {relTime(c.lastMessageAt)}
                  </span>
                </div>
                {/* row 2：preview + unread */}
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span
                    className={`text-xs truncate flex-1 min-w-0 ${
                      c.unreadCount > 0 ? "text-t2" : "text-t3"
                    }`}
                  >
                    {previewOf(c)}
                  </span>
                  {c.unreadCount > 0 && (
                    <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-wa text-white text-[11px] font-semibold flex items-center justify-center">
                      {c.unreadCount > 99 ? "99+" : c.unreadCount}
                    </span>
                  )}
                </div>
                {/* row 3：badges */}
                {(urgentRow || c.pendingBooking || intentMeta || c.assigneeName || c.status === "PENDING") && (
                  <div className="flex items-center gap-1 mt-1 flex-wrap">
                    {urgentRow && (
                      <span className="text-[10px] px-1.5 py-px rounded bg-danger text-white font-semibold">
                        急症
                      </span>
                    )}
                    {c.pendingBooking && (
                      <span
                        className="text-[10px] px-1.5 py-px rounded bg-ok-soft text-ok-text font-medium inline-flex items-center gap-0.5"
                        title={`新預約請求：${c.pendingBooking.providerName} ${c.pendingBooking.requestedDate} ${c.pendingBooking.requestedTime}`}
                      >
                        <CalendarDays size={10} /> 預約請求
                      </span>
                    )}
                    {intentMeta && !urgentRow && (
                      <span
                        className={`text-[10px] px-1.5 py-px rounded ${intentMeta.cls}`}
                        title={`AI intent: ${c.intent}`}
                      >
                        {intentMeta.label}
                      </span>
                    )}
                    {c.status === "PENDING" && (
                      <span className="text-[10px] px-1.5 py-px rounded bg-warn-soft text-warn-text">
                        等回覆
                      </span>
                    )}
                    {c.assigneeName && (
                      <span className="text-[10px] text-brand-text ml-auto">@{c.assigneeName}</span>
                    )}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

"use client";

import { useMemo } from "react";
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

const STATUS_META: Record<ConvStatus, { label: string; dot: string }> = {
  OPEN: { label: "OPEN", dot: "bg-sky-500" },
  PENDING: { label: "PENDING", dot: "bg-amber-500" },
  RESOLVED: { label: "RESOLVED", dot: "bg-neutral-400" },
};

// Phase 2：intent 標籤（AI 分類；未分類 = 不顯示）
const INTENT_META: Record<string, { label: string; cls: string }> = {
  BOOKING_REQUEST: { label: "預約", cls: "bg-sky-100 text-sky-700" },
  URGENT_PAIN: { label: "急症", cls: "bg-red-100 text-red-700" },
  OUT_OF_SCOPE: { label: "離題", cls: "bg-neutral-100 text-neutral-500" },
  QUESTION: { label: "查詢", cls: "bg-emerald-100 text-emerald-700" },
  OTHER: { label: "其他", cls: "bg-neutral-100 text-neutral-500" },
};

const TONE_DOT: Record<string, string> = {
  green: "bg-emerald-500",
  yellow: "bg-amber-400",
  red: "bg-red-500",
};

function previewOf(c: ConversationItem): string {
  return (
    c.preview ??
    c.contact?.profileName ??
    c.contact?.waId ??
    "（無訊息）"
  );
}

/**
 * 隊列欄（MD §6.4）：
 * - clinic tab（ADMIN 見全部；STAFF 無 tab — 只自己店）
 * - 狀態 filter（ALL/OPEN/PENDING/RESOLVED）
 * - contact 搜尋（頂部）
 * - 列表：unread badge / 窗口色點 / AI intent 標籤 / urgent 紅標
 * - 排序（Phase 2）：urgent（非 RESOLVED）排頂 → 其餘 → RESOLVED 沉底；同级 lastMessageAt desc
 */
export function ConversationList(p: Props) {
  const items = useMemo(() => {
    if (p.searchResults) return p.searchResults;
    let list = p.conversations;
    if (p.statusFilter !== "ALL") list = list.filter((c) => c.status === p.statusFilter);
    // 預設：urgent（非 RESOLVED）排頂（Phase 2 鐵律：急症優先），RESOLVED 沉底，唔隱藏（診所要搵返舊 chat）
    return [...list].sort((a, b) => {
      const rank = (c: ConversationItem) => (c.urgent && c.status !== "RESOLVED" ? 0 : c.status === "RESOLVED" ? 2 : 1);
      const ar = rank(a);
      const br = rank(b);
      if (ar !== br) return ar - br;
      return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime();
    });
  }, [p.conversations, p.searchResults, p.statusFilter]);

  return (
    <aside className="w-80 shrink-0 border-r border-neutral-200 bg-white flex flex-col min-h-0">
      {/* clinic tabs — ADMIN only */}
      {p.userRole === "ADMIN" && (
        <div className="flex gap-1 px-2 pt-2 overflow-x-auto">
          <TabButton active={p.activeClinicId === "all"} onClick={() => p.onActiveClinic("all")}>
            全部
          </TabButton>
          {p.clinics.map((c) => (
            <TabButton key={c.id} active={p.activeClinicId === c.id} onClick={() => p.onActiveClinic(c.id)}>
              {c.code}
            </TabButton>
          ))}
        </div>
      )}

      {/* search */}
      <div className="px-2 pt-2">
        <div className="relative">
          <input
            value={p.search}
            onChange={(e) => p.onSearch(e.target.value)}
            placeholder="搜尋病人（姓名 / WhatsApp 號碼）"
            className="w-full text-sm rounded border border-neutral-200 px-3 py-1.5 pr-8 focus:outline-none focus:ring-1 focus:ring-sky-400"
          />
          {p.search && (
            <button
              onClick={p.onClearSearch}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600 text-sm"
            >
              ✕
            </button>
          )}
        </div>
        {p.searchResults && (
          <div className="text-[11px] text-neutral-500 px-1 pt-1">
            搜尋結果（{p.searchResults.length}）— 點擊進入對話
          </div>
        )}
      </div>

      {/* status filter */}
      <div className="flex gap-1 px-2 py-2 overflow-x-auto">
        <FilterChip active={p.statusFilter === "ALL"} onClick={() => p.onStatusFilter("ALL")}>
          全部
        </FilterChip>
        {(["OPEN", "PENDING", "RESOLVED"] as const).map((s) => (
          <FilterChip key={s} active={p.statusFilter === s} onClick={() => p.onStatusFilter(s)}>
            {STATUS_META[s].label}
          </FilterChip>
        ))}
      </div>

      {/* list */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {items.length === 0 && (
          <div className="text-sm text-neutral-400 text-center py-8">
            {p.search ? "冇搜到相關病人" : "冇對話"}
          </div>
        )}
        {items.map((c) => {
          const intentMeta = c.intent ? INTENT_META[c.intent] : null;
          return (
          <button
            key={c.id}
            onClick={() => p.onSelect(c.id)}
            className={`w-full text-left px-3 py-2.5 border-b border-neutral-100 hover:bg-neutral-50 ${
              p.selectedId === c.id ? "bg-sky-50 hover:bg-sky-50" : c.urgent ? "bg-red-50/60 hover:bg-red-50" : ""
            }`}
          >
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full shrink-0 ${TONE_DOT[c.window.tone]}`} title="24h 窗口狀態" />
              <span className={`text-sm truncate ${c.unreadCount > 0 ? "font-semibold text-neutral-900" : "text-neutral-700"}`}>
                {c.contact?.profileName || c.contact?.waId || "（未知聯絡人）"}
              </span>
              {c.urgent && (
                <span className="text-[10px] px-1 py-0.5 rounded shrink-0 bg-red-600 text-white font-semibold" title="AI 標記急症（urgency=HIGH 或 URGENT_PAIN）">
                  急
                </span>
              )}
              {c.pendingBooking && (
                <span
                  className="text-[10px] px-1 py-0.5 rounded shrink-0 bg-emerald-600 text-white font-semibold"
                  title={`新預約請求：${c.pendingBooking.providerName} ${c.pendingBooking.requestedDate} ${c.pendingBooking.requestedTime}`}
                >
                  📅
                </span>
              )}
              {intentMeta && (
                <span className={`text-[10px] px-1 py-0.5 rounded shrink-0 ${intentMeta.cls}`} title={`AI intent: ${c.intent}`}>
                  {intentMeta.label}
                </span>
              )}
              {c.status !== "OPEN" && (
                <span
                  className={`text-[10px] px-1 py-0.5 rounded shrink-0 ${
                    c.status === "PENDING" ? "bg-amber-100 text-amber-700" : "bg-neutral-100 text-neutral-500"
                  }`}
                >
                  {STATUS_META[c.status].label}
                </span>
              )}
              <span className="ml-auto text-[11px] text-neutral-400 shrink-0">{relTime(c.lastMessageAt)}</span>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              {c.contact?.waId && <span className="text-[11px] text-neutral-400 truncate">{c.contact.waId}</span>}
              {c.assigneeName && (
                <span className="text-[11px] text-sky-600 shrink-0">@{c.assigneeName}</span>
              )}
              <span className={`ml-auto text-xs truncate ${c.unreadCount > 0 ? "text-neutral-600" : "text-neutral-400"}`}>
                {previewOf(c)}
              </span>
              {c.unreadCount > 0 && (
                <span className="shrink-0 min-w-5 h-5 px-1 rounded-full bg-emerald-500 text-white text-[11px] font-semibold flex items-center justify-center">
                  {c.unreadCount > 99 ? "99+" : c.unreadCount}
                </span>
              )}
            </div>
          </button>
          );
        })}
      </div>
    </aside>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded-t text-sm whitespace-nowrap ${
        active ? "bg-sky-600 text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
      }`}
    >
      {children}
    </button>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-0.5 rounded-full text-xs whitespace-nowrap border ${
        active ? "bg-neutral-900 text-white border-neutral-900" : "bg-white text-neutral-500 border-neutral-200 hover:bg-neutral-50"
      }`}
    >
      {children}
    </button>
  );
}

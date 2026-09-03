"use client";

import { useMemo, useState } from "react";
import { Bell, BellRing, CalendarDays, MessageCircle, Search, Settings, X } from "lucide-react";
import type { ClinicInfo, ConversationItem, ConvStatus, StaffNoticeItem } from "./types";
import { relTime } from "./time";
import type { NotifyPrefs } from "@/lib/notify-client";

interface Props {
  /** 手機：入咗聊天就藏列表（桌面永遠顯示） */
  hidden?: boolean;
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
  /** ★ H1：自己 staffId — 負責人 chip 三狀態（自己=綠「你」/ 別人=琥珀名 / unassigned=無 chip） */
  myStaffId: string;
  /** cwi-multiclinic-20260903（MD A.6.4）：自己綁定店集合（STAFF；ADMIN = []）— 跨店線店名 badge 判定 */
  myClinicIds?: string[];
  /** cwi-multiclinic-20260903：clinic id → 基本資料（店名 badge 顯示 code） */
  clinicById?: Map<string, { code: string; name: string }>;
  /** ★ H2：conversationId → 未讀 @mention 數（黃點） */
  mentionUnread: Record<string, number>;
  /** ★ H2：bell badge 總數 */
  mentionTotal: number;
  /** ★ H2：撳 bell → 跳到最近一個 mention 嘅 note */
  onBellClick: () => void;
  /** ★ AI Workflow T1 (A2)：未讀內部通知（bell 2 — 同客戶 unread / H2 mention bell 分開） */
  notices: StaffNoticeItem[];
  /** ★ AI Workflow T1 (A2)：撳通知 → 標已讀 + 跳對話 */
  onNoticeClick: (n: StaffNoticeItem) => void;
  /** ★ Part B（N-7）：客戶未讀總數（badge — 同 OS 通知 permission 無關，一定要有） */
  unreadTotal: number;
  /** ★ Part B（N-8）：通知開關（localStorage per-device） */
  prefs: NotifyPrefs;
  /** ★ Part B：寫回通知開關 */
  onPrefsChange: (p: NotifyPrefs) => void;
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
  URGENT_PAIN: { label: "急症", cls: "bg-danger text-panel" },
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
  // ★ AI Workflow T1 (A2)：內部通知面板（bell 2 開/關）
  const [noticeOpen, setNoticeOpen] = useState(false);
  // ★ Part B：通知設定面板（bell 旁齒輪；開關存 localStorage per-device）
  const [settingsOpen, setSettingsOpen] = useState(false);
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
    <aside
      className={`relative w-full md:w-[324px] shrink-0 md:border-r border-line bg-panel flex-col min-h-0 ${
        p.hidden ? "hidden md:flex" : "flex"
      }`}
    >
      {/* header：標題 + clinic dropdown（ADMIN only）+ ★ H2 bell badge */}
      <div className="px-3 pt-3 pb-2 flex items-center justify-between gap-2">
        <span className="font-display text-[19px] text-t1">收件箱</span>
        <div className="flex items-center gap-1.5">
          {p.userRole === "ADMIN" && (
            <select
              value={p.activeClinicId}
              onChange={(e) => p.onActiveClinic(e.target.value as string | "all")}
              className="text-xs rounded-full bg-panel-2 text-t1 border-0 pl-3 pr-7 py-1 focus:outline-none appearance-none bg-no-repeat bg-[right_0.5rem_center] bg-[length:0.7rem] bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23645c50%22 stroke-width=%223%22><path d=%22m6 9 6 6 6-6%22/></svg>')]"
            >
              <option value="all">全部診所</option>
              {p.clinics.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code}
                </option>
              ))}
            </select>
          )}
          {/* ★ Part B（N-7）：訊息未讀 badge（state 驅動 — OS 通知 denied/唔支援都一樣見） */}
          <span
            aria-label={`訊息未讀（${p.unreadTotal} 則）`}
            title={p.unreadTotal > 0 ? `${p.unreadTotal} 則未讀訊息` : "訊息未讀"}
            className={`relative w-7 h-7 rounded-full flex items-center justify-center ${p.unreadTotal > 0 ? "text-t1" : "text-t3"}`}
          >
            <MessageCircle size={15} strokeWidth={2.75} />
            {p.unreadTotal > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[15px] h-[15px] px-0.5 rounded-full bg-brand text-white text-[9px] font-bold flex items-center justify-center">
                {p.unreadTotal > 99 ? "99+" : p.unreadTotal}
              </span>
            )}
          </span>
          {/* ★ H2：mention 鈴鐺 badge（數字 = 未讀 mention 總數；撳 → 跳到最近 mention） */}
          <button
            onClick={p.onBellClick}
            aria-label={`Mention 通知（${p.mentionTotal} 未讀）`}
            title={p.mentionTotal > 0 ? `${p.mentionTotal} 個未讀 @mention — 撳跳到最近一個` : "Mention 通知"}
            className="relative w-7 h-7 rounded-full flex items-center justify-center text-t2 hover:bg-black/[.04] hover:text-t1"
          >
            <Bell size={15} strokeWidth={2.75} />
            {p.mentionTotal > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[15px] h-[15px] px-0.5 rounded-full bg-warn text-warn-text text-[9px] font-bold flex items-center justify-center">
                {p.mentionTotal > 99 ? "99+" : p.mentionTotal}
              </span>
            )}
          </button>
          {/* ★ AI Workflow T1 (A2)：內部通知 bell（媒體/急症 — 同客戶 unread 分開） */}
          <button
            onClick={() => setNoticeOpen((v) => !v)}
            aria-label={`內部通知（${p.notices.length} 未讀）`}
            title={p.notices.length > 0 ? `${p.notices.length} 條未讀內部通知` : "內部通知"}
            className="relative w-7 h-7 rounded-full flex items-center justify-center text-t2 hover:bg-black/[.04] hover:text-t1"
          >
            <BellRing size={15} strokeWidth={2.75} />
            {p.notices.length > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[15px] h-[15px] px-0.5 rounded-full bg-brand text-white text-[9px] font-bold flex items-center justify-center">
                {p.notices.length > 99 ? "99+" : p.notices.length}
              </span>
            )}
          </button>
          {/* ★ Part B：通知設定（齒輪 → 面板：桌面通知/提示音/逐店靜音/ADMIN opt-in） */}
          <button
            onClick={() => setSettingsOpen((v) => !v)}
            aria-label="通知設定"
            title="通知設定"
            className={`relative w-7 h-7 rounded-full flex items-center justify-center hover:bg-black/[.04] ${
              settingsOpen ? "text-t1" : "text-t2 hover:text-t1"
            }`}
          >
            <Settings size={15} strokeWidth={2.75} />
          </button>
        </div>
      </div>

      {/* ★ Part B：通知設定面板（N-8 開關存 localStorage per-device；N-9 底部灰字） */}
      {settingsOpen && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setSettingsOpen(false)} aria-hidden />
          <div className="absolute right-2 top-12 z-40 w-64 rounded-xl border border-line bg-panel shadow-xl p-3 space-y-2.5">
            <div className="text-xs font-semibold text-t1">通知設定</div>
            <label className="flex items-center gap-2 text-xs text-t1 cursor-pointer">
              <input
                type="checkbox"
                checked={p.prefs.desktop}
                onChange={(e) => p.onPrefsChange({ ...p.prefs, desktop: e.target.checked })}
              />
              桌面通知
            </label>
            <label className="flex items-center gap-2 text-xs text-t1 cursor-pointer">
              <input
                type="checkbox"
                checked={p.prefs.sound}
                onChange={(e) => p.onPrefsChange({ ...p.prefs, sound: e.target.checked })}
              />
              提示音
            </label>
            {p.clinics.length > 1 && (
              <div className="space-y-1 pt-1.5 border-t border-line">
                <div className="text-[10px] font-semibold text-t3 uppercase tracking-wide">逐店靜音</div>
                {p.clinics.map((c) => {
                  const muted = p.prefs.mutedClinics.includes(c.id);
                  return (
                    <label key={c.id} className="flex items-center gap-2 text-xs text-t1 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!muted}
                        onChange={() =>
                          p.onPrefsChange({
                            ...p.prefs,
                            mutedClinics: muted
                              ? p.prefs.mutedClinics.filter((x) => x !== c.id)
                              : [...p.prefs.mutedClinics, c.id],
                          })
                        }
                      />
                      {c.code}
                    </label>
                  );
                })}
              </div>
            )}
            {p.userRole === "ADMIN" && (
              <div className="space-y-1 pt-1.5 border-t border-line">
                <div className="text-[10px] font-semibold text-t3 uppercase tracking-wide">
                  接收訊息通知（預設唔收 — 逐店開）
                </div>
                {p.clinics.map((c) => {
                  const on = p.prefs.adminMsgClinics.includes(c.id);
                  return (
                    <label key={c.id} className="flex items-center gap-2 text-xs text-t1 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          p.onPrefsChange({
                            ...p.prefs,
                            adminMsgClinics: on
                              ? p.prefs.adminMsgClinics.filter((x) => x !== c.id)
                              : [...p.prefs.adminMsgClinics, c.id],
                          })
                        }
                      />
                      {c.code}
                    </label>
                  );
                })}
              </div>
            )}
            <div className="text-[10px] text-t3 pt-1.5 border-t border-line">分頁閂咗就收唔到通知</div>
          </div>
        </>
      )}

      {/* ★ AI Workflow T1 (A2)：內部通知列（未讀；撳 = 標已讀 + 跳對話） */}
      {noticeOpen && (
        <div className="border-b border-line px-3 py-2 space-y-1 max-h-56 overflow-y-auto">
          <div className="text-[10px] font-semibold text-t3 uppercase tracking-wide">內部通知</div>
          {p.notices.length === 0 ? (
            <div className="text-xs text-t3 py-1">冇未讀通知</div>
          ) : (
            p.notices.map((n) => (
              <button
                key={n.id}
                onClick={() => p.onNoticeClick(n)}
                className="w-full text-left rounded-full px-2.5 py-1.5 hover:bg-black/[.04]"
              >
                <div className="text-xs text-t1 truncate">{n.title}</div>
                <div className="text-[10px] text-t3">{relTime(n.createdAt)}</div>
              </button>
            ))
          )}
        </div>
      )}

      {/* search */}
      <div className="px-3">
        <div className="relative">
          <Search size={14} strokeWidth={2.75} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-t3" />
          <input
            value={p.search}
            onChange={(e) => p.onSearch(e.target.value)}
            placeholder="搜尋病人姓名或號碼"
            className="w-full text-sm rounded-full bg-panel-2 border border-transparent pl-8 pr-8 py-1.5 text-t1 placeholder:text-t3 focus:outline-none focus:border-brand focus:bg-panel"
          />
          {p.search && (
            <button
              onClick={p.onClearSearch}
              aria-label="清除搜尋"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-t3 hover:text-t1"
            >
              <X size={14} strokeWidth={2.75} />
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

      {/* list — 卡片式行（66px 行高 / 38px 頭像 / gap 分隔，無 border-b） */}
      <div className="flex-1 overflow-y-auto min-h-0 px-2.5 pb-3 flex flex-col gap-[3px]">
        {items.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-10 text-t3">
            <MessageCircle size={28} strokeWidth={2.75} />
            <div className="text-sm">{p.search ? "冇搜到相關病人" : "冇對話"}</div>
          </div>
        )}
        {items.map((c) => {
          const intentMeta = c.intent ? INTENT_META[c.intent] : null;
          const urgentRow = c.urgent && c.status !== "RESOLVED";
          const selected = p.selectedId === c.id;
          // cwi-multiclinic-20260903（MD A.6.4）：badge 導出（零新欄）
          // 店名 badge：STAFF → 線唔喺自己綁定店；ADMIN → 只喺「全部診所」視圖
          const myClinicIds = p.myClinicIds ?? [];
          const showClinicBadge =
            p.userRole === "STAFF"
              ? myClinicIds.length > 0 && !myClinicIds.includes(c.clinicId)
              : p.activeClinicId === "all";
          const clinicBadgeText = showClinicBadge
            ? (p.clinicById?.get(c.clinicId)?.code ?? c.clinicCode ?? c.clinicName ?? null)
            : null;
          // 待跟進：未指派 + 最後一條訊息係客人來訊（lastInboundAt >= lastMessageAt）
          const needsFollow =
            !c.assigneeId &&
            !!c.lastInboundAt &&
            new Date(c.lastInboundAt).getTime() >= new Date(c.lastMessageAt).getTime();
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
              className={`w-full text-left flex gap-3 p-3.5 rounded-[20px] border-[1.5px] ${
                urgentRow
                  ? "bg-danger-soft border-warn"
                  : selected
                    ? "bg-brand-soft border-transparent"
                    : "border-transparent hover:bg-black/[.04]"
              } ${c.status === "RESOLVED" ? "opacity-50" : ""}`}
            >
              {/* avatar + WA channel badge（急症行 avatar 轉陶土橙；外圈跟行底色） */}
              <div className="relative shrink-0 self-start">
                <div
                  className={`w-[38px] h-[38px] rounded-full flex items-center justify-center text-[14px] font-medium ${
                    urgentRow
                      ? "bg-danger text-panel"
                      : selected
                        ? "bg-brand text-panel"
                        : avatarCls(c.contact?.waId ?? c.id)
                  }`}
                >
                  {avatarChar(c)}
                </div>
                <span
                  className={`absolute -right-0.5 -bottom-0.5 w-[13px] h-[13px] rounded-full flex items-center justify-center ${
                    urgentRow ? "bg-danger-soft" : selected ? "bg-brand-soft" : "bg-panel"
                  }`}
                >
                  <span className="w-[9px] h-[9px] rounded-full bg-wa" title="WhatsApp" />
                </span>
              </div>

              <div className="min-w-0 flex-1">
                {/* row 1：名 + 時間（窗口 tone 變色）+ ★ H2 黃點（未讀 mention） */}
                <div className="flex items-center gap-1.5">
                  <span
                    className={`text-[13.5px] truncate font-bold ${
                      urgentRow ? "text-danger-text" : selected ? "text-brand-text" : "text-t1"
                    }`}
                  >
                    {c.contact?.profileName || c.contact?.waId || "（未知聯絡人）"}
                  </span>
                  {(p.mentionUnread[c.id] ?? 0) > 0 && (
                    <span
                      className="w-2 h-2 rounded-full bg-warn shrink-0"
                      title={`${p.mentionUnread[c.id]} 個未讀 @mention`}
                    />
                  )}
                  <span
                    className={`ml-auto text-[11px] shrink-0 ${
                      urgentRow
                        ? "text-danger-text font-semibold"
                        : selected
                          ? "text-brand-text"
                          : timeCls
                    }`}
                    title="24h 窗口狀態：黃 <6h / 紅 已過窗"
                  >
                    {relTime(c.lastMessageAt)}
                  </span>
                </div>
                {/* row 2：preview + unread（WhatsApp 官方綠 badge） */}
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span
                    className={`text-xs truncate flex-1 min-w-0 ${
                      urgentRow
                        ? "text-danger-text"
                        : selected
                          ? "text-brand-text"
                          : c.unreadCount > 0
                            ? "text-t2"
                            : "text-t3"
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
                {/* row 3：badges（急症行加「AI 未出草稿」— 鐵律 3：URGENT_PAIN 永不生成 draft） */}
                {(urgentRow || c.pendingBooking || intentMeta || c.assigneeName || c.status === "PENDING" || clinicBadgeText !== null || needsFollow) && (
                  <div className="flex items-center gap-1 mt-1 flex-wrap">
                    {/* cwi-multiclinic-20260903（MD A.6.4）：跨店線店名 badge — STAFF：線唔喺自己綁定店；
                        ADMIN：只喺「全部診所」視圖顯（逐店視圖本身就單一店） */}
                    {clinicBadgeText && (
                      <span
                        className="text-[10px] px-2 py-0.5 rounded-full bg-panel-2 text-t2 font-semibold inline-flex items-center gap-0.5"
                        title={`跨店線：${c.clinicName ?? clinicBadgeText}`}
                      >
                        {clinicBadgeText}
                      </span>
                    )}
                    {/* cwi-multiclinic-20260903（MD A.6.4）：「待跟進」— 未指派 + 最後一條係客人來訊（前端導出，零新欄） */}
                    {needsFollow && (
                      <span
                        className="text-[10px] px-2 py-0.5 rounded-full bg-warn-soft text-warn-text font-medium"
                        title="客人有來訊但無人接手 — 撳〔接手〕或者指派"
                      >
                        待跟進
                      </span>
                    )}
                    {urgentRow && (
                      <>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-danger text-panel font-semibold">
                          急症
                        </span>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-panel text-t2">
                          AI 未出草稿
                        </span>
                      </>
                    )}
                    {c.pendingBooking && (
                      <span
                        className="text-[10px] px-2 py-0.5 rounded-full bg-ok-soft text-ok-text font-medium inline-flex items-center gap-0.5"
                        title={`新預約請求：${c.pendingBooking.providerName} ${c.pendingBooking.requestedDate} ${c.pendingBooking.requestedTime ?? (c.pendingBooking.timeOfDay ?? "")}`}
                      >
                        <CalendarDays size={10} strokeWidth={2.75} /> 預約請求
                      </span>
                    )}
                    {intentMeta && !urgentRow && (
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded-full ${intentMeta.cls}`}
                        title={`AI intent: ${c.intent}`}
                      >
                        {intentMeta.label}
                      </span>
                    )}
                    {c.status === "PENDING" && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-warn-soft text-warn-text">
                        等回覆
                      </span>
                    )}
                    {/* ★ H1 負責人 chip：自己=綠「你」/ 別人=琥珀（Send Lock 中）/ unassigned=無 */}
                    {c.assigneeName && (
                      <span
                        className={`ml-auto text-[10px] px-2 py-0.5 rounded-full font-medium inline-flex items-center gap-0.5 ${
                          c.assigneeId === p.myStaffId
                            ? "bg-ok-soft text-ok-text"
                            : "bg-warn-soft text-warn-text"
                        }`}
                        title={
                          c.assigneeId === p.myStaffId
                            ? "你係呢個對話嘅負責人"
                            : `負責人：${c.assigneeName}（你只可發內部備註）`
                        }
                      >
                        {c.assigneeId === p.myStaffId ? "你" : c.assigneeName}
                      </span>
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

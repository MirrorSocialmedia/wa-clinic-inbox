"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bell, BellRing, CalendarDays, MessageCircle, Search, Settings, X } from "lucide-react";
import type { ClinicInfo, ConversationItem, ConvStatus, StaffNoticeItem } from "./types";
import { relTime } from "./time";
// ★ cwi-final S1-2（L-3）：膠囊 predicate — client 同 server 共用單一來源（計數不變式）
import { matchCapsule, type CapsuleKey } from "@/lib/inbox/capsule";
import type { NotifyPrefs } from "@/lib/notify-client";

interface Props {
  /** 手機：入咗聊天就藏列表（桌面永遠顯示） */
  hidden?: boolean;
  userRole: "ADMIN" | "STAFF" | "SUPERVISOR"; // ★ cwi-routing-20260906 §8
  clinics: ClinicInfo[];
  activeClinicId: string | "all";
  onActiveClinic: (id: string | "all") => void;
  statusFilter: ConvStatus | "ALL";
  onStatusFilter: (s: ConvStatus | "ALL") => void;
  /** ★ cwi-inboxfix-20260905（MD I-1/I-2）：膠囊指派維度 — unassigned=公海 / mine=我負責 / followup=待跟進（server 端 filter） */
  assignedFilter: "all" | "unassigned" | "mine" | "routed" | "followup";
  onAssignedFilter: (f: "all" | "unassigned" | "mine" | "routed" | "followup") => void;
  /** ★ cwi-inboxfix-20260905（MD §1.1）：計數（?counts=1；列表 refetch 順帶更新）— null = 未攞到 */
  counts: { all: number; unassigned: number; mine: number; routed: number; pending: number; resolved: number; followup?: number } | null;
  /** ★ cwi-final S1-2（L-3）：scopeClinicIds live（full fetch 用 server scopedSet 覆蓋）— matchCapsule inClinic 雙保險 */
  scopeClinicIds?: string[] | null;
  /** ★ cwi-final S1-2（裁決 6）：active 對話超過 5000 — 頂部黃条 */
  listTruncated?: boolean;
  /** ★ cwi-final S1-2（裁決 5）：捲到底（近底 30px）— 目前只 resolved view 用（追下一頁） */
  onScrollBottom?: () => void;
  conversations: ConversationItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  search: string;
  onSearch: (q: string) => void;
  searchResults: ConversationItem[] | null;
  onClearSearch: () => void;
  /** ★ cwi-routing-20260906（MD §4.3）：我嘅技能組 id — 「派俾我」膠囊 client 端 filter */
  myGroupIds?: string[];
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
  /** ★ cwi-inboxfix-20260905（MD I-10）：socket 斷線中 — 列表頂 banner「⚠ 連線中斷 — 重連中…」 */
  connOffline?: boolean;
  /** ★ cwi-realtime-fix §3 (RT-6)：realtime 連線 debug 快照（唯讀 — 將來所有 realtime 問題第一站） */
  rtDebug?: {
    connected: boolean;
    events: Record<string, number>;
    cursors: Record<string, number>;
    lastCatchUpAt: number | null;
  };
  /** ★ cwi-realtime-v2 §5：音效實時狀態（ok = 已解鎖；standalone = 已安裝為 App — autoplay 明文例外） */
  audioStatus?: { ok: boolean; standalone: boolean };
  /** ★ cwi-realtime-v2 §5：撳「需互動一次」行 → 直接解鎖（免等下次 pointerdown） */
  onUnlockAudio?: () => void;
}

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

// ★ cwi-statusrole2-20260910 T1：計數顯示 cap 99+ — 膠囊行寬度有上界（唔准橫向捲）
function fmtCap(n: number | null | undefined): string {
  const v = n ?? 0;
  return v > 99 ? "99+" : String(v);
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
  // ★ F-6（cwi-notify-fix-20260907）：發測試通知（/api/push/test — 同真通知同一條路）
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ kind: "muted" | "other"; text: string; clinicId?: string } | null>(null);
  // ★ cwi-statusrole2-20260910 T1（MD §1.1）：mobile <400px — 兩行 fallback（短字；第二行最多兩粒）
  const [narrow, setNarrow] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // ★ cwi-final S1-8（L-5 修正版 / R-14）：overflow 偵測 — reset 版（el.scrollWidth > el.clientWidth + 1，
  //   放低返會回 false）。量測經隱藏 sizer（永遠佈局全量項 — 對 collapsed 狀態不變式）→ 冇 osc；
  //   爆咗先收**數字 0** 嘅膠囊入 ⋯（待跟進永遠可見，唔入 ⋯）；⋯ 隱藏膠囊數字 > 0 顯示紅點。
  const [overflowCollapsed, setOverflowCollapsed] = useState(false);
  const capsuleRowRef = useRef<HTMLDivElement>(null);
  const measureWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 399px)");
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  useEffect(() => {
    if (narrow) {
      // 窄屏用兩行 fallback — 唔做 overflow 收合
      setOverflowCollapsed(false);
      return;
    }
    const check = () => {
      const m = measureWrapRef.current;
      const r = capsuleRowRef.current;
      if (!m || !r) return;
      setOverflowCollapsed(m.scrollWidth > r.clientWidth + 1);
    };
    check();
    const ro = new ResizeObserver(check);
    if (capsuleRowRef.current) ro.observe(capsuleRowRef.current);
    return () => ro.disconnect();
  }, [narrow, p.counts]);

  // ★ cwi-final S1-8（L-5 修正版 / R-14）：膠囊定義 — 全部 toggle（再撳返「全部」）；
  //   「全部」膠囊已移除（冇 active = 全部）；窄屏短字（派我/跟進）。
  type CapKey4 = "unassigned" | "routed" | "mine" | "followup";
  const neutralCls = (active: boolean) =>
    active
      ? "bg-t1 text-canvas border border-t1"
      : "bg-transparent text-t2 border border-line hover:bg-panel-2";
  const capToggle = (key: CapKey4) => () => p.onAssignedFilter(p.assignedFilter === key ? "all" : key);
  const capsuleDefs: { key: CapKey4; label: string; count: number; active: boolean; cls: string; onClick: () => void; title?: string }[] = [
    {
      key: "unassigned",
      label: `公海 ${fmtCap(p.counts?.unassigned)}`,
      count: p.counts?.unassigned ?? 0,
      active: p.assignedFilter === "unassigned",
      // 唯一有色膠囊（橙）— 冇人跟＝會漏單
      cls:
        p.assignedFilter === "unassigned"
          ? "bg-warn text-white font-semibold shadow-sm"
          : "bg-warn/25 text-warn-text",
      onClick: capToggle("unassigned"),
    },
    {
      key: "routed",
      label: `${narrow ? "派我" : "派俾我"} ${fmtCap(p.counts?.routed)}`,
      count: p.counts?.routed ?? 0,
      active: p.assignedFilter === "routed",
      // 重點色邊框（brand）— 次強調
      cls:
        p.assignedFilter === "routed"
          ? "border border-brand bg-brand text-panel font-semibold"
          : "border border-brand bg-brand-soft/50 text-brand-text",
      onClick: capToggle("routed"),
    },
    {
      key: "mine",
      label: `我負責 ${fmtCap(p.counts?.mine)}`,
      count: p.counts?.mine ?? 0,
      active: p.assignedFilter === "mine",
      cls: neutralCls(p.assignedFilter === "mine"),
      onClick: capToggle("mine"),
    },
    {
      key: "followup",
      label: `${narrow ? "跟進" : "待跟進"} ${fmtCap(p.counts?.followup ?? 0)}`,
      count: p.counts?.followup ?? 0,
      active: p.assignedFilter === "followup",
      cls:
        p.assignedFilter === "followup"
          ? "bg-brand text-panel font-semibold border border-brand"
          : (p.counts?.followup ?? 0) > 0
            ? "bg-brand-soft/50 text-brand-text border border-brand/40"
            : "bg-transparent text-t3 border border-line",
      onClick: capToggle("followup"),
      title: "有跟進建議、未處理嘅對話",
    },
  ];
  // 溢出（reset 版）：只收數字 0 嘅膠囊入 ⋯（「待跟進」豁免 — MD S1-8 條 3：永遠喺可見列，唔入 ⋯）；
  //   ⋯ 紅點 = 隱藏膠囊有數字 > 0
  const collapsedKeys: string[] =
    !narrow && overflowCollapsed
      ? capsuleDefs.filter((d) => d.count === 0 && d.key !== "followup").map((d) => d.key)
      : [];
  const hiddenDefs = capsuleDefs.filter((d) => collapsedKeys.includes(d.key));
  const visibleDefs = capsuleDefs.filter((d) => !collapsedKeys.includes(d.key));
  const anyHiddenPositive = hiddenDefs.some((d) => d.count > 0);
  const renderCapBtn = (d: (typeof capsuleDefs)[number]) => (
    <button
      key={d.key}
      onClick={d.onClick}
      aria-pressed={d.active}
      title={d.title}
      data-e2e={`capsule-${d.key}`}
      className={`px-1.5 py-0.5 rounded-full text-xs whitespace-nowrap shrink-0 ${d.cls}`}
    >
      {d.label}
    </button>
  );

  const sendTestNotify = async () => {
    if (testBusy) return;
    setTestBusy(true);
    setTestResult(null);
    try {
      // 目標店：現行 active 店；「全部」→ 第一間（server：單店 STAFF 可省略）
      const target = p.activeClinicId !== "all" ? p.activeClinicId : (p.clinics[0]?.id ?? null);
      const res = await fetch("/api/push/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(target ? { clinicId: target } : {}),
      });
      const d = (await res.json().catch(() => null)) as {
        ok?: boolean;
        result?: string;
        count?: number;
        reason?: string;
        clinicId?: string;
        clinicShort?: string;
        error?: string;
      } | null;
      if (!res.ok || !d?.ok) {
        setTestResult({ kind: "other", text: d?.error ? `測試失敗：${d.error}` : `測試失敗（${res.status}）` });
        return;
      }
      switch (d.result) {
        case "pushed":
          setTestResult({ kind: "other", text: `已推送 ${d.count} 部裝置` });
          break;
        case "no-subscription":
          setTestResult({ kind: "other", text: "冇裝置訂閱 — 開咗桌面通知先重試" });
          break;
        case "muted":
          setTestResult({ kind: "muted", text: `呢間店（${d.clinicShort}）被你靜音咗`, clinicId: d.clinicId });
          break;
        case "vapid-off":
          setTestResult({ kind: "other", text: "Web Push 未喺 server 配置（socket 通知唔受影響）" });
          break;
        default:
          setTestResult({ kind: "other", text: `推送失敗：${d.reason ?? "unknown"}` });
      }
    } catch (e) {
      setTestResult({ kind: "other", text: `推送失敗：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setTestBusy(false);
    }
  };
  const items = useMemo(() => {
    if (p.searchResults) return p.searchResults;
    let list = p.conversations;
    // ★ cwi-final S1-2（L-3）：膠囊 filter 改用 matchCapsule（client / server / counts 三處同源）—
    //   unassigned 加 clinic 維度雙保險（I-2）；followup 唔 filter status（S2-3：包含 RESOLVED）。
    const isResolvedView = p.statusFilter === "RESOLVED";
    if (p.assignedFilter !== "all") {
      const cx = {
        meId: p.myStaffId,
        myGroupIds: p.myGroupIds ?? [],
        scopeClinicIds: p.scopeClinicIds ?? null,
        activeClinicId: p.activeClinicId,
      };
      list = list.filter((c) => matchCapsule(p.assignedFilter as CapsuleKey, c, cx));
    }
    // active view：膠囊計數（counts）皆 !RESOLVED 口徑 → all/unassigned/mine/routed 要排除 RESOLVED 行
    //   （首屏夾咗 RESOLVED 尾 100 + 待跟進 RESOLVED）；followup 保留 RESOLVED（S2-3）。
    //   resolved view：列表本身已全 RESOLVED — 唔再加 status filter（會清埋）。
    if (!isResolvedView) {
      if (p.assignedFilter !== "all" && p.assignedFilter !== "followup") {
        list = list.filter((c) => c.status !== "RESOLVED");
      }
      if (p.statusFilter !== "ALL") list = list.filter((c) => c.status === p.statusFilter);
    }
    return [...list].sort((a, b) => {
      // ★ cwi-followup-v3（MD §2.1）：待跟進列表 = 建議日期最舊先（唔係最新）— 久咗未跟先最緊要
      if (p.assignedFilter === "followup") {
        const at = a.followupDueAt ? new Date(a.followupDueAt).getTime() : Infinity;
        const bt = b.followupDueAt ? new Date(b.followupDueAt).getTime() : Infinity;
        if (at !== bt) return at - bt;
        if (Number(a.urgent) !== Number(b.urgent)) return Number(b.urgent) - Number(a.urgent);
      }
      const rank = (c: ConversationItem) =>
        c.urgent && c.status !== "RESOLVED" ? 0 : c.status === "RESOLVED" ? 2 : 1;
      const ar = rank(a);
      const br = rank(b);
      if (ar !== br) return ar - br;
      return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime();
    });
  }, [p.conversations, p.searchResults, p.statusFilter, p.assignedFilter, p.myStaffId, p.myGroupIds, p.scopeClinicIds, p.activeClinicId]);

  return (
    <aside
      className={`relative w-full md:w-[324px] shrink-0 md:border-r border-line bg-panel flex-col min-h-0 ${
        p.hidden ? "hidden md:flex" : "flex"
      }`}
    >
      {/* ★ cwi-inboxfix-20260905（MD I-10）：連線狀態 — 斷線時常駐提示，避免「靜靜哋唔更新」 */}
      {p.connOffline && (
        <div className="mx-2.5 mt-2 px-3 py-1 rounded-full bg-warn-soft text-warn-text text-[11px] font-medium" role="status">
          ⚠ 連線中斷 — 重連中…（恢復後自動補漏）
        </div>
      )}
      {/* ★ cwi-final S1-2（裁決 6）：active 超過 5000 — truncated 提示（縮窄用膠囊/店舖篩選） */}
      {p.listTruncated && (
        <div className="mx-2.5 mt-2 px-3 py-1 rounded-full bg-warn-soft text-warn-text text-[11px] font-medium" role="status">
          ⚠ 未解決超過 5000，只顯示最新 5000 — 請用膠囊/店舖篩選
        </div>
      )}
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
            {/* cwi-realtime-fix §7.3：autoplay 政策講清楚（未互動前頁面音被擋 — 主路係系統通知音） */}
            <div className="text-[10px] text-t3 leading-snug -mt-1">
              瀏覽器規定：網頁音效要先同頁面互動一次先播得。想一開機就有聲，建議「安裝為 App」（主畫面／桌面捷徑）。
            </div>
            {/* ★ cwi-realtime-v2 §5：音效實時狀態 — 用真實 audioUnlocked 狀態，唔使再估。
                Chrome autoplay 政策：PWA standalone = 明文例外（零互動，正式解法）；
                生產機可選 AutoplayAllowlist registry（見 notify-client unlockAudio 註釋）。 */}
            {p.audioStatus && (
              <div
                className={`text-[11px] rounded-lg px-2 py-1.5 leading-snug ${
                  p.audioStatus.ok || p.audioStatus.standalone ? "bg-ok-soft text-ok-text" : "bg-warn-soft text-warn-text"
                }`}
              >
                {p.audioStatus.standalone ? (
                  <span>音效：App 模式 ✅（安裝後自動解鎖）</span>
                ) : p.audioStatus.ok ? (
                  <span>音效：已解鎖 ✅</span>
                ) : (
                  <span>
                    音效：需互動一次 ⚠️
                    {p.onUnlockAudio && (
                      <button
                        type="button"
                        onClick={p.onUnlockAudio}
                        className="underline underline-offset-2 hover:opacity-80"
                      >
                        （撳呢度解鎖）
                      </button>
                    )}
                    · 建議安裝為 App
                  </span>
                )}
              </div>
            )}
            {/* cwi-realtime-fix §2.3：角色語義 — STAFF 見逐店靜音（黑名單）；ADMIN 只見下方 opt-in（白名單），
                兩個 list 唔好同時出（ADMIN 唔准再寫 mutedClinics） */}
            {p.userRole === "STAFF" && p.clinics.length > 1 && (
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
            <div className="pt-1.5 border-t border-line space-y-1.5">
              <button
                onClick={() => void sendTestNotify()}
                disabled={testBusy}
                className="w-full text-xs text-t1 hover:bg-black/[.04] rounded-lg px-2 py-1.5 disabled:opacity-50"
              >
                {testBusy ? "發送中…" : "發測試通知"}
              </button>
              {testResult && (
                <div className="text-[11px] text-t2 px-1 flex items-center justify-between gap-1.5">
                  <span className="min-w-0 break-words">{testResult.text}</span>
                  {testResult.kind === "muted" && testResult.clinicId && (
                    <button
                      onClick={() => {
                        const cid = testResult.clinicId as string;
                        p.onPrefsChange({ ...p.prefs, mutedClinics: p.prefs.mutedClinics.filter((x) => x !== cid) });
                        setTestResult(null);
                      }}
                      className="text-brand-text hover:underline shrink-0"
                    >
                      [解除]
                    </button>
                  )}
                </div>
              )}
            </div>
            {/* cwi-realtime-fix §3 (RT-6)：連線狀態 debug 區（唯讀 — 事件計數/游標/最後補漏） */}
            {p.rtDebug && (
              <div className="pt-1.5 border-t border-line space-y-0.5">
                <div className="text-[10px] font-semibold text-t3 uppercase tracking-wide">連線狀態（唯讀 debug）</div>
                <div className="text-[10px] text-t2 font-mono">
                  socket: {p.rtDebug.connected ? "✅ 已連接" : "❌ 斷線"}
                </div>
                {Object.entries(p.rtDebug.events)
                  .filter(([, n]) => n > 0)
                  .sort((a, b) => b[1] - a[1])
                  .map(([ev, n]) => (
                    <div key={ev} className="text-[10px] text-t3 font-mono truncate">
                      {ev} ×{n}
                    </div>
                  ))}
                {Object.entries(p.rtDebug.cursors).map(([cid, ts]) => (
                  <div key={cid} className="text-[10px] text-t3 font-mono truncate">
                    cursor {cid.slice(0, 8)}: {new Date(ts).toLocaleTimeString()}
                  </div>
                ))}
                <div className="text-[10px] text-t3 font-mono">
                  最後補漏: {p.rtDebug.lastCatchUpAt ? new Date(p.rtDebug.lastCatchUpAt).toLocaleTimeString() : "—"}
                </div>
              </div>
            )}
            <div className="text-[10px] text-t3 pt-1.5 border-t border-line">
              閂咗分頁都收到通知（Web Push）；逐店靜音 / 訊息通知選項已同步 server（push 都生效）
            </div>
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

      {/* ★ cwi-final S1-8（L-5 修正版 / R-14）：膠囊區 — 全 toggle。
          - 「全部」膠囊移除（冇 active 膠囊 = 全部）；原位置改「全部 N」細字狀態顯示（非按鈕）
          - 四粒膠囊全 toggle（再撳返「全部」）；公海 = 唯一有色（橙）；派俾我 = brand 邊框
          - ★ cwi-followup-v3（MD §2.1）：待跟進 = 有未處理 SUGGESTED 建議嘅對話；
            永遠喺可見行（唔入 ⋯）；窄屏短字（公海/派我/我負責/跟進）
          - 寬屏 overflow（reset 偵測：scrollWidth > clientWidth + 1，sizer 量全量 → 冇 osc）：
            只收數字 0 嘅膠囊入 ⋯；⋯ 隱藏膠囊數字 > 0 顯示紅點
          - 窄屏（<400px）：兩行 fallback（第一行 全部文字+公海+派我；第二行最多兩粒 = 我負責+跟進）
          第二行（已完成）= 右側狀態切換器，只兩選項：
            處理中(OPEN) / 睇已解決 →(RESOLVED) — PENDING 隱藏（MD §1.2；API 仍接受舊 link） */}
      <div className="px-3 py-2 flex flex-col gap-1.5">
        {narrow ? (
          // 窄屏：兩行 fallback（第二行最多兩粒）；唔做 overflow 收合
          <div data-e2e="capsule-row" className="flex flex-col gap-1">
            <div className="flex items-center gap-1 flex-wrap">
              <span
                data-e2e="capsule-all-count"
                className="text-[11px] text-t3 whitespace-nowrap shrink-0 pl-1"
                title="冇膠囊 active = 全部"
              >
                全部 {fmtCap(p.counts?.all ?? 0)}
              </span>
              {visibleDefs.slice(0, 2).map(renderCapBtn)}
            </div>
            <div className="flex items-center gap-1 flex-wrap">
              {visibleDefs.slice(2).map(renderCapBtn)}
            </div>
          </div>
        ) : (
          <div className="relative">
            {/* 隱藏 sizer — 永遠佈局全量項（全部文字 + 四膠囊 + ⋯ 位），對 collapsed 狀態不變式 → reset 偵測唔 osc */}
            <div
              ref={measureWrapRef}
              aria-hidden
              className="invisible absolute left-0 top-0 w-full overflow-hidden pointer-events-none"
            >
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-t3 whitespace-nowrap shrink-0 pl-1">全部 {fmtCap(p.counts?.all ?? 0)}</span>
                {capsuleDefs.map((d) => (
                  <span key={d.key} className={`px-1.5 py-0.5 rounded-full text-xs whitespace-nowrap shrink-0 ${d.cls}`}>
                    {d.label}
                  </span>
                ))}
                <span className="w-6 shrink-0" />
              </div>
            </div>
            <div ref={capsuleRowRef} data-e2e="capsule-row" className="flex items-center gap-1 flex-nowrap">
              <span
                data-e2e="capsule-all-count"
                className="text-[11px] text-t3 whitespace-nowrap shrink-0 pl-1"
                title="冇膠囊 active = 全部"
              >
                全部 {fmtCap(p.counts?.all ?? 0)}
              </span>
              {visibleDefs.map(renderCapBtn)}
              {hiddenDefs.length > 0 && (
                <div className="relative shrink-0">
                  <button
                    onClick={() => setMoreOpen((v) => !v)}
                    aria-label="更多膠囊"
                    aria-expanded={moreOpen}
                    data-e2e="capsule-more"
                    className="relative w-6 h-6 rounded-full border border-line text-t2 hover:bg-panel-2 text-sm leading-none flex items-center justify-center"
                  >
                    ⋯
                    {anyHiddenPositive && <span aria-hidden className="absolute -right-0.5 -top-0.5 w-2 h-2 rounded-full bg-danger" />}
                  </button>
                  {moreOpen && (
                    <>
                      <div className="fixed inset-0 z-30" onClick={() => setMoreOpen(false)} aria-hidden />
                      <div className="absolute right-0 top-7 z-40 rounded-lg border border-line bg-panel shadow-lg py-1 w-28">
                        {hiddenDefs.map((d) => (
                          <button
                            key={d.key}
                            onClick={() => {
                              setMoreOpen(false);
                              d.onClick();
                            }}
                            title={d.title}
                            className={`block w-full text-left px-2.5 py-1.5 text-xs whitespace-nowrap ${
                              d.active ? "text-brand font-semibold" : "text-t2 hover:bg-panel-2"
                            }`}
                          >
                            {d.label}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
        <div data-e2e="status-toggle" className="flex items-center justify-end gap-2.5">
          <button
            onClick={() => p.onStatusFilter(p.statusFilter === "OPEN" ? "ALL" : "OPEN")}
            aria-pressed={p.statusFilter === "OPEN"}
            title="只睇處理中（OPEN）對話；再撳一次返轉去"
            className={`px-1 text-xs ${
              p.statusFilter === "OPEN" ? "text-t1 font-semibold underline underline-offset-2" : "text-t3 hover:text-t1"
            }`}
          >
            處理中
          </button>
          <button
            onClick={() => p.onStatusFilter(p.statusFilter === "RESOLVED" ? "ALL" : "RESOLVED")}
            aria-pressed={p.statusFilter === "RESOLVED"}
            title="只睇已解決對話；再撳一次返轉去"
            className={`px-1 text-xs ${
              p.statusFilter === "RESOLVED" ? "text-brand font-semibold underline underline-offset-2" : "text-t3 hover:text-t1"
            }`}
          >
            睇已解決 →
          </button>
        </div>
      </div>

      {/* list — 卡片式行（66px 行高 / 38px 頭像 / gap 分隔，無 border-b） */}
      <div
        className="flex-1 overflow-y-auto min-h-0 px-2.5 pb-3 flex flex-col gap-[3px]"
        onScroll={(e) => {
          // ★ cwi-final S1-2（裁決 5）：近底 30px 觸發（caller 決定用途 — 目前只 resolved view 追頁）
          if (!p.onScrollBottom) return;
          const el = e.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight <= 30) p.onScrollBottom();
        }}
      >
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
          // cwi-inboxfix-20260905（MD I-4）：跨店指派俾我 — 整行左彩邊 + 「你（由 X 派嚟）」
          // ★ cwi-realtime-v2 §4：跨店語義（「線唔喺自己綁定店」）只對 STAFF 成立 —
          //   ADMIN/SUPERVISOR clinicIds=[]（全店視圖）→ 唔好標「跨店 / 由 X 派嚟」。
          const crossToMe =
            p.userRole === "STAFF" &&
            c.assigneeId === p.myStaffId &&
            myClinicIds.length > 0 &&
            !myClinicIds.includes(c.clinicId);
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
              } ${crossToMe ? "border-l-[3px] border-l-brand" : ""} ${c.status === "RESOLVED" ? "opacity-50" : ""}`}
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
                          // ★ cwi-final S1-12：粗體色用 per-staff myUnread（公海 SLA 仍用 unreadCount）
                          : c.myUnread > 0
                            ? "text-t2"
                            : "text-t3"
                    }`}
                  >
                    {previewOf(c)}
                  </span>
                  {/* ★ cwi-final S1-12：badge = per-staff 未讀（A 開過對話唔代表 B 讀咗） */}
                  {c.myUnread > 0 && (
                    <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-wa text-white text-[11px] font-semibold flex items-center justify-center">
                      {c.myUnread > 99 ? "99+" : c.myUnread}
                    </span>
                  )}
                </div>
                {/* row 3：badges + 負責人常駐 chip（cwi-inboxfix-20260905 I-3：永遠 render 三態） */}
                <div className="flex items-center gap-1 mt-1 flex-wrap">
                  {/* cwi-multiclinic-20260903（MD A.6.4）：跨店線店名 badge — STAFF：線唔喺自己綁定店；
                      ADMIN/SUPERVISOR：只喺「全部診所」視圖顯（逐店視圖本身就單一店）
                      cwi-inboxfix-20260905（I-4）：文案加「↔ 跨店 ·」前綴
                      ★ cwi-realtime-v2 §4：前綴只限 STAFF — ADMIN 只顯示店名 badge（TKW） */}
                  {clinicBadgeText && (
                    <span
                      className="text-[10px] px-2 py-0.5 rounded-full bg-panel-2 text-t2 font-semibold inline-flex items-center gap-0.5"
                      title={p.userRole === "STAFF" ? `跨店線：${c.clinicName ?? clinicBadgeText}` : `店：${c.clinicName ?? clinicBadgeText}`}
                    >
                      {p.userRole === "STAFF" ? `↔ 跨店 · ${clinicBadgeText}` : clinicBadgeText}
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
                    {/* ★ cwi-routing-20260906（MD §4.3）：路由 badge — ⚠ 已升級 / 🎯 組 / 🎯 單人當值（常駐；未路由 = 無） */}
                    {c.escalatedAt ? (
                      <span
                        className="text-[10px] px-2 py-0.5 rounded-full bg-danger-soft text-danger-text font-semibold inline-flex items-center gap-0.5 flex-none"
                        title={`投訴已升級（${new Date(c.escalatedAt).toLocaleString()}）— 待主管組接手`}
                      >
                        ⚠ 已升級{c.routedGroupName ? ` · ${c.routedGroupName}` : ""}
                      </span>
                    ) : c.routedStaffId ? (
                      <span
                        className="text-[10px] px-2 py-0.5 rounded-full bg-brand-soft text-brand-text font-medium inline-flex items-center gap-0.5 flex-none"
                        title={`路由指定：${c.routedStaffName ?? "當值同事"}（當值中 — 優先跟進）`}
                      >
                        🎯 {c.routedStaffName ?? "當值"}
                      </span>
                    ) : c.routedGroupId ? (
                      <span
                        className="text-[10px] px-2 py-0.5 rounded-full bg-brand-soft text-brand-text font-medium inline-flex items-center gap-0.5 flex-none"
                        title={`路由標記：${c.routedGroupName ?? "技能組"}（未指派 — 撳入去覆一句即接手）`}
                      >
                        🎯 {c.routedGroupName ?? "組"}
                      </span>
                    ) : null}
                    {/* ★ cwi-statusrole2-20260910（MD §3）：badge「↻ 重新開啟」— reopenedAt 24h 內顯示（client derive；
                        已解決對話病人再嚟訊 → 即時彈返出嚟 + 呢個 badge） */}
                    {c.reopenedAt && Date.now() - new Date(c.reopenedAt).getTime() < 24 * 3600_000 && (
                      <span
                        className="text-[10px] px-2 py-0.5 rounded-full bg-ok-soft text-ok-text font-semibold inline-flex items-center gap-0.5 flex-none"
                        title={`病人再嚟訊自動翻開（${new Date(c.reopenedAt).toLocaleString()}）`}
                      >
                        ↻ 重新開啟
                      </span>
                    )}
                    {/* ★ cwi-inboxfix-20260905（MD I-3）：負責人常駐三態 — 永遠 render：
                        ⚑ 未指派（橙）/ ● 你（重點色，跨店加「由 X 派嚟」）/ ● 某某（灰） */}
                    {c.assigneeId == null ? (
                      <span
                        className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-warn-soft text-warn-text font-semibold inline-flex items-center gap-0.5"
                        title="未有人負責 — 撳入去覆一句即自動接手"
                      >
                        ⚑ 未指派
                      </span>
                    ) : c.assigneeId === p.myStaffId ? (
                      <span
                        className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-ok-soft text-ok-text font-medium inline-flex items-center gap-0.5"
                        title={crossToMe ? `你係呢個對話嘅負責人（由 ${c.clinicCode ?? c.clinicName ?? "其他店"} 派嚟）` : "你係呢個對話嘅負責人"}
                      >
                        ● {crossToMe ? `你（由 ${c.clinicCode ?? c.clinicName ?? "其他店"} 派嚟）` : "你"}
                      </span>
                    ) : (
                      <span
                        className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-panel-2 text-t3 font-medium inline-flex items-center gap-0.5"
                        title={`負責人：${c.assigneeName}（你只可發內部備註）`}
                      >
                        ● {c.assigneeName} 處理緊
                      </span>
                    )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

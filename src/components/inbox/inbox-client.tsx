"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  AiClassifiedEvent,
  BookingEvent,
  ClinicInfo,
  ConversationAssignedEvent,
  ConversationItem,
  ConvStatus,
  ConvUpdatedEvent,
  DraftInfo,
  DraftReadyEvent,
  MessageItem,
  MessageStatusEvent,
  MentionNotifyEvent,
  NewMessageEvent,
  NoteNewEvent,
  NoteReadEvent,
  NoteReceipt,
  NoticeNewEvent,
  StaffInfo,
  StaffNoticeItem,
  UrgentEscalationEvent,
  UserCtx,
} from "./types";
import {
  DEFAULT_NOTIFY_PREFS,
  dismissNotifyBanner,
  ensurePermission,
  fireNotify,
  notifyBannerDismissed,
  notifyPrefs,
  setNotifyPrefs,
  shouldNotify,
  type NotifyPrefs,
} from "@/lib/notify-client";
import { ConversationList } from "./conversation-list";
import { ChatPane } from "./chat-pane";
import { DetailPane } from "./detail-pane";

const PAGE_SIZE = 50;
const WINDOW_MS = 24 * 3600 * 1000;

interface ContactSearchHit {
  id: string;
  waId: string;
  profileName: string | null;
  labels: string[];
  clinicId: string;
}

/**
 * Inbox 主 client（MD §6.4 三欄）。
 *
 * Socket.IO：
 * - login 後即連（iron-session cookie 自動帶，server hub 驗 session 先 join room）
 * - message:new / message:status / conv:updated 實時更新
 * - Phase 2：ai:classified（intent/urgency/urgent/summary）/ draft:ready（pending 草稿卡）
 *   / urgent:escalation（急症 toast + 隊列頂紅標）
 * - Phase 3：booking:new / booking:updated（綠色預約卡）
 * - ★ H1：conversation:assigned（負責人 chip 即時更新）/ note:new（內部備註 → 拉最新訊息）
 * - 斷線重連 → 用 lastMessageAt 拉 backlog 補漏（GET /api/conversations/[id]/messages?after=...）
 */
export function InboxClient({
  user,
  initialClinics,
  initialConversations,
  initialStaff,
  initialSelectedConvId,
}: {
  user: UserCtx;
  initialClinics: ClinicInfo[];
  initialConversations: ConversationItem[];
  initialStaff: StaffInfo[];
  /** Phase 3：?conv=<id> 深連結（/bookings 卡「開對話」） */
  initialSelectedConvId?: string | null;
}) {
  const clinics = initialClinics;
  const staff = initialStaff;
  // D.4（cwi-schedv2-20260903）：舊當值卡管線（dutyMap/refreshDuty/15min）移除 —
  //   側欄改「今日可約迷你表」（MiniSchedule 自拉 /api/flows/slots）。
  const [conversations, setConversations] = useState<ConversationItem[]>(initialConversations);
  const [activeClinicId, setActiveClinicId] = useState<string | "all">(
    user.role === "STAFF" ? (user.clinicId ?? "all") : "all"
  );
  const [statusFilter, setStatusFilter] = useState<ConvStatus | "ALL">("ALL");
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<ConversationItem[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Phase 2：pending AI 草稿（per conversationId）+ 急症 toast
  const [pendingDrafts, setPendingDrafts] = useState<Record<string, DraftInfo>>({});
  const [draftBusy, setDraftBusy] = useState(false);
  const [urgentToast, setUrgentToast] = useState<{ conversationId: string; contactName: string | null } | null>(null);

  const [selectedConvId, setSelectedConvId] = useState<string | null>(initialSelectedConvId ?? null);
  // ★ booking-ui（C）：側欄 patient-context 重載訊號（socket booking:changed / 側欄寫入後 bump）
  const [ctxRefreshKey, setCtxRefreshKey] = useState(0);
  // ★ cwi-h6 §4：內部備註卡重拉訊號（socket note:new → 選中對話）
  const [notesRefreshKey, setNotesRefreshKey] = useState(0);
  // 手機：detail bottom sheet（<lg 撳 chat header 先開；桌面側欄常駐）— 換對話即關
  const [detailOpen, setDetailOpen] = useState(false);
  useEffect(() => {
    setDetailOpen(false);
  }, [selectedConvId]);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  // ★ Realtime P0 (R5)：assign/接手要讀最新 assignVersion — ref 避免 callback stale closure
  const conversationsRef = useRef<ConversationItem[]>(conversations);
  conversationsRef.current = conversations;

  // ── ★ Part B（N-7）：未讀 → 分頁標題 (N) WA Inbox + favicon 紅點 ─────────────
  //   由現有 list state 導出（零新 API）；常駐驅動 — permission denied/唔支援都一樣見，
  //   唔使聲稱 PWA push（N-9：Tab 閂 = 收唔到）。
  const unreadTotal = conversations.reduce((sum, c) => sum + c.unreadCount, 0);
  useEffect(() => {
    document.title = unreadTotal > 0 ? `(${unreadTotal}) WA Inbox` : "WA Inbox";
  }, [unreadTotal]);
  useEffect(() => {
    let link = document.getElementById("wa-inbox-dyn-icon") as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement("link");
      link.id = "wa-inbox-dyn-icon";
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = unreadTotal > 0 ? unreadFaviconDataUrl(unreadTotal) : "/favicon.ico";
  }, [unreadTotal]);
  const lastMsgTsRef = useRef<number>(0); // 斷線前最後訊息時間（backlog cursor）
  // ★ Realtime P0 (R3, cwi-rt-20260823-a1)：focus/visibility/3 分鐘 idle refetch 游標
  const lastConvSeenRef = useRef<number>(Date.now()); // 對話列表 lastMessageAt 游標（ms epoch）
  const deltaInFlightRef = useRef<boolean>(false); // focus+visibility 同時觸發 → 唔重複 fetch
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesRef = useRef<MessageItem[]>([]);
  const activeClinicRef = useRef<string | "all">(activeClinicId);
  selectedIdRef.current = selectedConvId;
  messagesRef.current = messages;
  activeClinicRef.current = activeClinicId;

  // ── ★ H2：已讀回執（tick 語義）+ mention 通知（bell badge / 黃點 / Notification） ──
  const [receipts, setReceipts] = useState<NoteReceipt[]>([]); // 選中對話嘅回執（socket note:read 增量更新）
  const [mentionUnread, setMentionUnread] = useState<Record<string, number>>({}); // conversationId → 未讀 mention 數
  const lastMentionRef = useRef<{ conversationId: string; messageId: string } | null>(null);
  const mentionUnreadRef = useRef<Record<string, number>>({});
  mentionUnreadRef.current = mentionUnread;

  const mentionTotal = Object.values(mentionUnread).reduce((a, b) => a + b, 0);

  // ── ★ Part B 通知 v1（N-8）：開關 localStorage per-device + 首次登入 banner ──
  //   預設先渲染（SSR 安全），mount 後先讀真實 localStorage — 避 hydration mismatch。
  const [prefs, setPrefs] = useState<NotifyPrefs>(DEFAULT_NOTIFY_PREFS);
  const prefsRef = useRef<NotifyPrefs>(prefs);
  prefsRef.current = prefs;
  const [notifyBanner, setNotifyBanner] = useState(false);
  useEffect(() => {
    setPrefs(notifyPrefs());
    if (!notifyBannerDismissed()) setNotifyBanner(true);
  }, []);
  const updatePrefs = useCallback((next: NotifyPrefs) => {
    setPrefs(next);
    setNotifyPrefs(next);
  }, []);

  // ★ Part B（N-4）：clinic short name 查表 — STAFF SSR 只帶 primary 店（legacy 單店視角），
  //   多店 staff 收其他店事件時 clinics.find 會 miss → 由 /api/clinics?scope=schedule（零 PII，code/name）補 code 表。
  const clinicsRef = useRef(clinics);
  clinicsRef.current = clinics;
  const clinicCodeMapRef = useRef<Record<string, string>>({});
  useEffect(() => {
    fetch("/api/clinics?scope=schedule")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: unknown) => {
        const list = (d as { clinics?: { id: string; code: string }[] } | null)?.clinics;
        if (Array.isArray(list)) {
          for (const c of list) clinicCodeMapRef.current[c.id] = c.code;
        }
      })
      .catch(() => {});
  }, []);
  const clinicShortOf = (clinicId: string | null | undefined): string => {
    if (!clinicId) return "WA";
    return clinicsRef.current.find((x) => x.id === clinicId)?.code ?? clinicCodeMapRef.current[clinicId] ?? "WA";
  };

  // ★ AI Workflow T1 (A2)：內部通知（bell 2 — 媒體/急症；同客戶 unread 分開）
  const [notices, setNotices] = useState<StaffNoticeItem[]>([]);
  const fetchNotices = useCallback(async () => {
    try {
      const res = await fetch("/api/notices", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { notices?: StaffNoticeItem[] };
      setNotices(data.notices ?? []);
    } catch {
      /* 網絡抖動 — bell 唔更新得，唔阻主流程 */
    }
  }, []);
  const fetchNoticesRef = useRef<typeof fetchNotices>(fetchNotices);
  fetchNoticesRef.current = fetchNotices;
  useEffect(() => {
    void fetchNotices();
  }, [fetchNotices]);

  // ── socket ────────────────────────────────────────────────────────────
  useEffect(() => {
    const socket = io({ withCredentials: true, transports: ["websocket", "polling"] });
    socketRef.current = socket;

    socket.on("message:new", (e: NewMessageEvent) => {
      if (e.message.waTimestamp) {
        lastMsgTsRef.current = Math.max(lastMsgTsRef.current, new Date(e.message.waTimestamp).getTime());
      }
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.id === e.conversationId);
        const msg = e.message;
        const isOut = msg.direction === "OUT";
        const existing = idx >= 0 ? prev[idx] : null;
        const item: ConversationItem = {
          id: e.conversationId,
          clinicId: e.clinicId,
          contactId: e.contact?.id ?? existing?.contactId ?? "",
          status: e.conversation.status,
          assigneeId: existing?.assigneeId ?? null,
          assigneeName: existing?.assigneeName ?? null,
          assignVersion: existing?.assignVersion ?? 0,
          pinnedPatient: existing?.pinnedPatient ?? null,
          unreadCount: isOut ? (existing?.unreadCount ?? 0) : e.conversation.unreadCount,
          lastInboundAt: isOut
            ? existing?.lastInboundAt ?? null
            : (e.conversation.lastInboundAt ?? null),
          lastMessageAt: msg.waTimestamp,
          intent: existing?.intent ?? null,
          intentConfidence: existing?.intentConfidence ?? null,
          urgency: existing?.urgency ?? null,
          urgent: existing?.urgent ?? false,
          aiSummary: existing?.aiSummary ?? null,
          contact: e.contact ?? existing?.contact ?? null,
          pendingBooking: existing?.pendingBooking ?? null,
          holdEvent: existing?.holdEvent ?? null,
          window: windowFromLastInbound(
            isOut ? (existing?.lastInboundAt ?? null) : (e.conversation.lastInboundAt ?? null)
          ),
          preview: msg.body ?? `[${msg.type}]`,
        };
        if (idx === -1) {
          // 新對話：insert 排頭（按 lastMessageAt desc 大致排序）
          const next = [item, ...prev];
          next.sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());
          return next;
        }
        const next = [...prev];
        next[idx] = item;
        return next;
      });

      if (selectedIdRef.current === e.conversationId) {
        const msg = e.message;
        setMessages((prev) => {
          // ★ R1：對消 optimistic bubble — id / waMessageId / clientMessageId 任一命中即同一條訊息
          if (
            prev.some(
              (m) =>
                m.id === msg.id ||
                (msg.waMessageId && m.waMessageId === msg.waMessageId) ||
                (msg.clientMessageId != null && m.clientMessageId === msg.clientMessageId)
            )
          )
            return prev;
          return [...prev, msg].sort((a, b) => new Date(a.waTimestamp).getTime() - new Date(b.waTimestamp).getTime());
        });
      }

      // ★ Part B（N-1）：客人來訊 → 通知（只 IN；outbound/echo 唔算「客人來訊」）。
      // assigneeId 由 client state 補（payload 無呢欄 — PII 邊界）；新對話 state 未收 → null = 未指派。
      if (e.message.direction === "IN") {
        const conv = conversationsRef.current.find((c) => c.id === e.conversationId) ?? null;
        if (
          shouldNotify({
            kind: "message",
            clinicId: e.clinicId,
            conversationId: e.conversationId,
            assigneeId: conv?.assigneeId ?? null,
            myStaffId: user.staffId,
            myRole: user.role,
            activeConversationId: selectedIdRef.current,
            mutedClinics: prefsRef.current.mutedClinics,
            adminMsgClinics: prefsRef.current.adminMsgClinics,
          })
        ) {
          void fireNotify({
            kind: "message",
            clinicShort: clinicShortOf(e.clinicId),
            conversationId: e.conversationId,
            onClick: () => selectConvRef.current(e.conversationId),
            prefs: prefsRef.current,
          });
        }
      }
    });

    socket.on("message:status", (e: MessageStatusEvent) => {
      if (selectedIdRef.current !== e.conversationId) return;
      setMessages((prev) =>
        prev.map((m) => (m.waMessageId === e.waMessageId || m.id === e.waMessageId ? { ...m, status: e.status, errorCode: e.errorCode } : m))
      );
    });

    socket.on("conv:updated", (e: ConvUpdatedEvent) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === e.conversationId
            ? {
                ...c,
                status: e.status,
                assigneeId: e.assigneeId,
                assigneeName: e.assigneeId ? staffRef.current.find((s) => s.id === e.assigneeId)?.name ?? null : null,
                // ★ Realtime P0 (R5)：version 同步（PATCH assignee 變動 → server 已 +1）
                assignVersion: e.assignVersion,
                unreadCount: e.unreadCount,
                // RESOLVED 自動清急症紅標（同 API PATCH 語義一致）
                urgent: e.status === "RESOLVED" ? false : c.urgent,
              }
            : c
        )
      );
    });

    // ── Phase 2：AI triage 事件 ────────────────────────────────

    // 分類成功 → 更新 intent/urgency/urgent/summary（metadata + summary 係聊天內容）
    socket.on("ai:classified", (e: AiClassifiedEvent) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === e.conversationId
            ? { ...c, intent: e.intent, urgency: e.urgency, urgent: e.urgent, aiSummary: e.aiSummary }
            : c
        )
      );
    });

    // 新 pending draft → 入 card（對話欄上方）
    socket.on("draft:ready", (e: DraftReadyEvent) => {
      setPendingDrafts((prev) => ({
        ...prev,
        [e.conversationId]: {
          id: e.draftId,
          conversationId: e.conversationId,
          inReplyToMessageId: e.inReplyToMessageId,
          draftText: e.draftText,
          model: e.model,
          latencyMs: e.latencyMs,
          status: "PROPOSED",
          createdAt: new Date().toISOString(),
          // cwi-window-20260901（P2）：COPY_ONLY = 過窗草稿（UI 只准複製）
          mode: e.mode ?? "NORMAL",
        },
      }));
    });

    // 急症升級 → 隊列頂紅標 + toast（12s 自動消）
    // ★ AI Workflow T1 (A2)：內部通知即時 +1（ref — 避 stale closure / deps warning）
    socket.on("notice:new", (e: NoticeNewEvent) => {
      void fetchNoticesRef.current();
      // ★ Part B（N-1）：輕音（接手/放手/auto-release 等）— clinicId/assigneeId 由 state 補（payload 只 conversationId+kind）
      const convN = conversationsRef.current.find((c) => c.id === e.conversationId) ?? null;
      if (
        shouldNotify({
          kind: "notice",
          clinicId: convN?.clinicId ?? "",
          conversationId: e.conversationId,
          assigneeId: convN?.assigneeId ?? null,
          myStaffId: user.staffId,
          myRole: user.role,
          activeConversationId: selectedIdRef.current,
          mutedClinics: prefsRef.current.mutedClinics,
          adminMsgClinics: prefsRef.current.adminMsgClinics,
        })
      ) {
        void fireNotify({
          kind: "notice",
          clinicShort: clinicShortOf(convN?.clinicId),
          conversationId: e.conversationId,
          onClick: () => selectConvRef.current(e.conversationId),
          prefs: prefsRef.current,
        });
      }
    });
    socket.on("urgent:escalation", (e: UrgentEscalationEvent) => {
      setConversations((prev) =>
        prev.map((c) => (c.id === e.conversationId ? { ...c, urgent: true, intent: e.intent, urgency: e.urgency } : c))
      );
      setUrgentToast({ conversationId: e.conversationId, contactName: e.contactName });
      // ★ Part B（N-1）：急音（第二音 notify-urgent.mp3）。payload 有 contactName —
      //   只俾 in-app toast 用（staff 有權睇）；OS 通知零 PII（N-4），文案只 clinic code。
      const convU = conversationsRef.current.find((c) => c.id === e.conversationId) ?? null;
      if (
        shouldNotify({
          kind: "urgent",
          clinicId: convU?.clinicId ?? "",
          conversationId: e.conversationId,
          assigneeId: convU?.assigneeId ?? null,
          myStaffId: user.staffId,
          myRole: user.role,
          activeConversationId: selectedIdRef.current,
          mutedClinics: prefsRef.current.mutedClinics,
          adminMsgClinics: prefsRef.current.adminMsgClinics,
        })
      ) {
        void fireNotify({
          kind: "urgent",
          clinicShort: clinicShortOf(convU?.clinicId),
          conversationId: e.conversationId,
          onClick: () => selectConvRef.current(e.conversationId),
          prefs: prefsRef.current,
        });
      }
    });

    // ── Phase 3：預約卡事件（綠色卡） ─────────────────────
    // booking:new（病人 Complete 過 precheck）/ booking:updated（confirm/expire）
    socket.on("booking:new", (e: BookingEvent) => {
      setConversations((prev) =>
        prev.map((c) => (c.id === e.conversationId ? { ...c, pendingBooking: e.booking } : c))
      );
    });
    socket.on("booking:updated", (e: BookingEvent) => {
      setConversations((prev) =>
        prev.map((c) => (c.id === e.conversationId ? { ...c, pendingBooking: e.booking } : c))
      );
    });

    // ★ booking-ui（C）：代落單/rollback/改期/取消 寫入後 → 列表重拉（對話卡狀態）+ 側欄 patient-context 重拉
    // payload（conversationId/clinicId/date/kind）保留喺 contract（types.ts BookingChangedEvent）；重拉係全列表，故唔 binding
    socket.on("booking:changed", () => {
      void fetchConversations(activeClinicRef.current);
      setCtxRefreshKey((k) => k + 1);
    });

    // 斷線重連 → backlog 補漏
    let wasDisconnected = false;

    // ── ★ H1：Send Lock / 內部備註 事件 ────────────────────────

    // 轉交/接手/放返隊列/auto-claim → 負責人 chip 即時更新（payload 零內文）
    socket.on("conversation:assigned", (e: ConversationAssignedEvent) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === e.conversationId
            ? {
                ...c,
                assigneeId: e.assigneeId,
                assigneeName: e.assigneeId
                  ? staffRef.current.find((s) => s.id === e.assigneeId)?.name ?? null
                  : null,
                // ★ Realtime P0 (R5)：version 同步 — 其他 client 之後 assign 先唔會 409
                assignVersion: e.assignVersion,
              }
            : c
        )
      );
    });

    // 新內部備註（零內文）→ 選中對話拉最新訊息；列表 preview/lastMessageAt 先本地更新
    socket.on("note:new", (e: NoteNewEvent) => {
      const now = new Date().toISOString();
      setConversations((prev) =>
        prev.map((c) =>
          c.id === e.conversationId ? { ...c, lastMessageAt: now, preview: "🔒 內部備註" } : c
        )
      );
      if (selectedIdRef.current === e.conversationId) {
        void fetchMessagesLatest(e.conversationId);
        // cwi-h6 §4：側欄內部備註卡同步重拉（realtime）
        setNotesRefreshKey((k) => k + 1);
      }
    });

    // ★ H2：已讀回執（零內文）→ 選中對話 tick 即時重算（去重：同 messageId+staffId 只留首條）
    socket.on("note:read", (e: NoteReadEvent) => {
      if (selectedIdRef.current !== e.conversationId) return;
      setReceipts((prev) =>
        prev.some((r) => r.messageId === e.messageId && r.staffId === e.staffId)
          ? prev
          : [...prev, { messageId: e.messageId, staffId: e.staffId, readAt: e.readAt }]
      );
    });

    // ★ H2：@mention 定向通知（只我收）→ bell badge 數字 + 列表黃點 + 提示音 +
    // browser Notification（只喺 permission granted 時彈；撳通知跳到該 note）
    // ★ Part B：改用 fireNotify 統一節流（N-6）/開關（N-8）— bell/黃點邏輯照舊，
    //   行為不變（chime + 彈屏 + 撳跳；mention 係定向推送，唔走 N-2 assignee 邏輯）
    socket.on("notify:mention", (e: MentionNotifyEvent) => {
      setMentionUnread((prev) => ({ ...prev, [e.conversationId]: (prev[e.conversationId] ?? 0) + 1 }));
      lastMentionRef.current = { conversationId: e.conversationId, messageId: e.messageId };
      const fromName = staffRef.current.find((s) => s.id === e.fromStaffId)?.name ?? "同事";
      if (
        shouldNotify({
          kind: "mention",
          clinicId: e.clinicId,
          conversationId: e.conversationId,
          assigneeId: null,
          myStaffId: user.staffId,
          myRole: user.role,
          activeConversationId: selectedIdRef.current,
          mutedClinics: prefsRef.current.mutedClinics,
          adminMsgClinics: prefsRef.current.adminMsgClinics,
        })
      ) {
        void fireNotify({
          kind: "mention",
          clinicShort: clinicShortOf(e.clinicId),
          conversationId: e.conversationId,
          body: `${fromName} 喺內部備註 @ 咗你`,
          onClick: () => void jumpToMention(e.conversationId, e.messageId),
          prefs: prefsRef.current,
        });
      }
    });

    socket.on("disconnect", () => {
      wasDisconnected = true;
    });
    socket.on("connect", () => {
      if (wasDisconnected) {
        wasDisconnected = false;
        // 1) 刷新對話列表
        void fetchConversations(activeClinicRef.current);
        // 2) 選中對話用 after= 補漏
        if (selectedIdRef.current && lastMsgTsRef.current > 0) {
          void fetchMessagesAfter(selectedIdRef.current, lastMsgTsRef.current);
        }
      }
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // staffRef：socket handler 要最新 staff 名（assigneeName 顯示）
  const staffRef = useRef<StaffInfo[]>(initialStaff);
  staffRef.current = staff;

  // Phase 3：?conv= 深連結 — 首屏直接載入對話訊息
  useEffect(() => {
    if (initialSelectedConvId) {
      void fetchMessagesLatest(initialSelectedConvId);
      void fetchPendingDrafts(initialSelectedConvId);
      void fetchNoteReceipts(initialSelectedConvId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 急症 toast 12s 自動消
  useEffect(() => {
    if (!urgentToast) return;
    const t = setTimeout(() => setUrgentToast(null), 12000);
    return () => clearTimeout(t);
  }, [urgentToast]);

  // ── Phase 2：pending drafts ────────────────────────────────────────
  const fetchPendingDrafts = useCallback(async (convId: string) => {
    try {
      const res = await fetch(`/api/conversations/${convId}/drafts`);
      if (!res.ok) return;
      const data = (await res.json()) as { drafts: DraftInfo[] };
      setPendingDrafts((prev) => {
        const next = { ...prev };
        if (data.drafts.length > 0) next[convId] = data.drafts[0];
        else delete next[convId];
        return next;
      });
    } catch {
      /* ignore */
    }
  }, []);

  const adoptDraft = useCallback(async (draftId: string) => {
    const convId = selectedIdRef.current;
    if (!convId) return;
    setDraftBusy(true);
    try {
      // 採用 = audit + 前端填 composer（ChatPane 按鈕已 fill）；發送仍係人手
      await fetch(`/api/conversations/${convId}/drafts/${draftId}`, { method: "PATCH" });
    } finally {
      setDraftBusy(false);
    }
  }, []);

  const discardDraft = useCallback(async (draftId: string) => {
    const convId = selectedIdRef.current;
    if (!convId) return;
    setDraftBusy(true);
    try {
      await fetch(`/api/conversations/${convId}/drafts/${draftId}`, { method: "DELETE" });
      setPendingDrafts((prev) => {
        const next = { ...prev };
        delete next[convId];
        return next;
      });
    } finally {
      setDraftBusy(false);
    }
  }, []);

  // ── data fetchers ─────────────────────────────────────────────────────
  const fetchConversations = useCallback(async (clinicId: string | "all") => {
    try {
      const qs = clinicId !== "all" ? `?clinicId=${clinicId}` : "";
      const res = await fetch(`/api/conversations${qs}`);
      if (!res.ok) return;
      const data = (await res.json()) as ConversationItem[];
      setConversations(data);
      // ★ R3：全量 fetch 後游標 = 列表最尾 ts（「我見到咗全部」— 之後 delta 只補新嘅）
      let maxTs = 0;
      for (const c of data) maxTs = Math.max(maxTs, new Date(c.lastMessageAt).getTime());
      lastConvSeenRef.current = maxTs;
    } catch {
      /* UI 會喺下次 action 補齊 */
    }
  }, []);

  const fetchMessagesLatest = useCallback(async (convId: string) => {
    try {
      const res = await fetch(`/api/conversations/${convId}/messages?limit=${PAGE_SIZE}`);
      if (!res.ok) return;
      const data = (await res.json()) as { messages: MessageItem[]; hasMore: boolean };
      setMessages(data.messages);
      setHasMore(data.hasMore);
      if (data.messages.length > 0) {
        lastMsgTsRef.current = Math.max(lastMsgTsRef.current, new Date(data.messages[data.messages.length - 1].waTimestamp).getTime());
      }
    } catch {
      /* ignore */
    }
  }, []);

  const fetchMessagesAfter = useCallback(async (convId: string, afterMs: number) => {
    try {
      const res = await fetch(
        `/api/conversations/${convId}/messages?after=${new Date(afterMs).toISOString()}&limit=${PAGE_SIZE}`
      );
      if (!res.ok) return;
      const data = (await res.json()) as { messages: MessageItem[] };
      setMessages((prev) => {
        const ids = new Set(prev.map((m) => m.id));
        const added = data.messages.filter((m) => !ids.has(m.id));
        return [...prev, ...added].sort((a, b) => new Date(a.waTimestamp).getTime() - new Date(b.waTimestamp).getTime());
      });
    } catch {
      /* ignore */
    }
  }, []);

  // ── ★ Realtime P0 (R3, cwi-rt-20260823-a1)：focus-refetch ────────────────
  // visibilitychange(visible) / window focus / 3 分鐘 idle timer → 同一個 refetchDelta()。
  // 覆 live 期間漏收嘅 socket event（e.g. Redis 重啟窗口 / 斷線重連之間嘅空隙）：
  //  1) 對話列表：GET /api/conversations?after=<lastSeen>（server = 現有 list route 加 param）
  //     → lastMessageAt >= after 嘅對話用 id merge（重疊容許）+ 游標推進
  //  2) 開住嘅 thread：若選中對話喺 delta 內 → fetchMessagesAfter 補訊息
  const refetchDelta = useCallback(async () => {
    if (deltaInFlightRef.current) return;
    const cursor = lastConvSeenRef.current;
    if (cursor <= 0) return;
    deltaInFlightRef.current = true;
    try {
      const qs = new URLSearchParams({ after: new Date(cursor).toISOString() });
      if (activeClinicRef.current !== "all") qs.set("clinicId", activeClinicRef.current);
      const res = await fetch(`/api/conversations?${qs.toString()}`);
      if (!res.ok) return;
      const rows = (await res.json()) as ConversationItem[];
      if (rows.length === 0) return;
      let maxTs = cursor;
      for (const r of rows) maxTs = Math.max(maxTs, new Date(r.lastMessageAt).getTime());
      lastConvSeenRef.current = maxTs;
      setConversations((prev) => {
        const map = new Map(prev.map((c) => [c.id, c]));
        for (const r of rows) map.set(r.id, r); // server 行 = 更新
        const next = [...map.values()];
        next.sort(
          (a, b) =>
            (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0) ||
            new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
        );
        return next;
      });
      // 開住嘅 thread 補漏（選中對話有更新先 fetch — 唔空攪）
      const sel = selectedIdRef.current;
      if (sel && rows.some((r) => r.id === sel)) {
        if (lastMsgTsRef.current > 0) void fetchMessagesAfter(sel, lastMsgTsRef.current);
        else void fetchMessagesLatest(sel);
      }
    } catch {
      /* ignore — 下次 trigger 再試 */
    } finally {
      deltaInFlightRef.current = false;
    }
  }, [fetchMessagesAfter, fetchMessagesLatest]);

  // R3 triggers：tab focus 返 / window focus / 每 3 分鐘 idle 掃一次
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refetchDelta();
    };
    const onFocus = () => void refetchDelta();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    const timer = setInterval(() => void refetchDelta(), 3 * 60 * 1000);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      clearInterval(timer);
    };
  }, [refetchDelta]);

  const loadOlder = useCallback(async () => {
    const convId = selectedIdRef.current;
    if (!convId || loadingOlder) return;
    const oldest = messagesRef.current[0];
    if (!oldest) return;
    setLoadingOlder(true);
    try {
      const res = await fetch(
        `/api/conversations/${convId}/messages?before=${encodeURIComponent(oldest.waTimestamp)}&limit=${PAGE_SIZE}`
      );
      if (!res.ok) return;
      const data = (await res.json()) as { messages: MessageItem[]; hasMore: boolean };
      setMessages((prev) => {
        const ids = new Set(prev.map((m) => m.id));
        const added = data.messages.filter((m) => !ids.has(m.id));
        return [...added, ...prev];
      });
      setHasMore(data.hasMore);
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder]);

  // ── ★ H2：已讀回執 fetch（開對話一次拉齊；之後 socket note:read 增量） ──────────
  const fetchNoteReceipts = useCallback(async (convId: string) => {
    try {
      const res = await fetch(`/api/conversations/${convId}/note-read-receipts`);
      if (!res.ok) return;
      const data = (await res.json()) as { receipts: NoteReceipt[] };
      setReceipts(data.receipts);
    } catch {
      /* ignore */
    }
  }, []);

  // ── ★ H2：note 進入 viewport → 冪等 read POST（server 側 upsert；重複打唔多行） ──
  const markNoteRead = useCallback(async (messageId: string) => {
    try {
      await fetch(`/api/notes/${messageId}/read`, { method: "POST" });
    } catch {
      /* ignore */
    }
  }, []);

  // ── ★ H2：跳到被 mention 嘅 note 位置（bell / browser Notification 撳） ──────
  const jumpToMention = useCallback(
    async (convId: string, msgId: string) => {
      if (selectedIdRef.current !== convId) {
        setSelectedConvId(convId);
        setNotice(null);
        void fetchMessagesLatest(convId);
        void fetchNoteReceipts(convId);
      }
      window.setTimeout(() => {
        const el = document.getElementById(`msg-${msgId}`);
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("msg-flash");
        window.setTimeout(() => el.classList.remove("msg-flash"), 1600);
      }, 450);
    },
    [fetchMessagesLatest, fetchNoteReceipts]
  );

  const onBellClick = useCallback(() => {
    const lm = lastMentionRef.current;
    if (lm) void jumpToMention(lm.conversationId, lm.messageId);
  }, [jumpToMention]);

  // ★ AI Workflow T1 (A2)：撳通知 → 標已讀 + 跳對話
  const onNoticeClick = useCallback((n: StaffNoticeItem) => {
    void (async () => {
      try {
        await fetch("/api/notices", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: [n.id] }),
        });
      } catch {
        /* non-fatal — UI 先 optimistic 清 */
      }
      setNotices((prev) => prev.filter((x) => x.id !== n.id));
      if (n.conversationId) setSelectedConvId(n.conversationId);
    })();
  }, []);

  // ── select conversation（markRead + 載入最新訊息） ───────────────────
  const selectConversation = useCallback(
    async (id: string) => {
      if (id.startsWith("contact:")) {
        // search 結果 stub：呢個 contact 未確定有冇對話 → 查返
        const contactId = id.slice("contact:".length);
        try {
          const res = await fetch("/api/conversations");
          if (res.ok) {
            const all = (await res.json()) as ConversationItem[];
            const match = all.find((c) => c.contactId === contactId);
            if (match) {
              setSelectedConvId(match.id);
              void fetchMessagesLatest(match.id);
              void fetchPendingDrafts(match.id);
              void fetchNoteReceipts(match.id);
              void markRead(match.id);
              setSearchResults(null);
              setSearch("");
              return;
            }
          }
        } catch {
          /* fallthrough */
        }
        setNotice("呢個聯絡人仲未有任何對話記錄");
        return;
      }
      setSelectedConvId(id);
      setNotice(null);
      void fetchMessagesLatest(id);
      void fetchPendingDrafts(id);
      // ★ H2：開對話 → 拉已讀回執（tick）+ 清該對話未讀 mention（bell/黃點）
      void fetchNoteReceipts(id);
      setMentionUnread((prev) => {
        if (!prev[id]) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      void markRead(id);
    },
    [fetchMessagesLatest, fetchPendingDrafts, fetchNoteReceipts]
  );
  // ★ Part B：socket handler（[] deps）要最新 selectConversation — ref 避 stale closure
  const selectConvRef = useRef<(id: string) => void>(() => {});
  selectConvRef.current = (id: string) => {
    void selectConversation(id);
  };

  async function markRead(id: string) {
    try {
      await fetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markRead: true }),
      });
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, unreadCount: 0 } : c)));
    } catch {
      /* ignore */
    }
  }

  // ── composer ──────────────────────────────────────────────────────────
  const sendMessage = useCallback(
    async (body: string): Promise<{ ok: boolean; error?: string; templates?: { name: string; language: string }[] }> => {
      const convId = selectedIdRef.current;
      if (!convId) return { ok: false, error: "未選擇對話" };
      // ★ realtime-p0 R1：一次「邏輯發送」一個 UUID；網絡 retry 用同一 key（chat-pane 嘅
      // `sending` guard 已防雙擊二調）。server 用 clientMessageId 去重：首請已成功但
      // response 丟失 → retry 命中 replay 回同一 messageId（唔會重發）。
      const clientMessageId = crypto.randomUUID();
      const postWithRetry = async (): Promise<Response> => {
        let lastErr: unknown;
        for (let i = 0; i < 3; i++) {
          try {
            return await fetch("/api/messages/send", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ conversationId: convId, body, clientMessageId }),
            });
          } catch (err) {
            lastErr = err;
            if (i < 2) await new Promise((r) => setTimeout(r, 500 * 2 ** i)); // 0.5s → 1s backoff
          }
        }
        throw lastErr;
      };
      try {
        const res = await postWithRetry();
        const data = (await res.json().catch(() => null)) as {
          ok?: boolean;
          messageId?: string;
          error?: string;
          message?: string;
          status?: string;
          idempotentReplay?: boolean;
          // Phase B：422 過窗時 server 帶 APPROVED+UTILITY 名單（UI 轉 template 揀選）
          templates?: { name: string; language: string }[];
        } | null;
        if (res.status === 422) {
          return { ok: false, error: data?.message ?? "窗口已過，只可發 template", templates: data?.templates };
        }
        if (!res.ok) {
          return { ok: false, error: data?.error ?? `發送失敗（${res.status}）` };
        }
        // 樂觀更新：QUEUED 氣泡（worker 發完會 push message:new 帶真 wamid）。
        // ★ R1：idempotentReplay 時 server 回舊 Message（同一 id）— 若舊 row 已 FAILED
        //（enqueue 失敗），氣泡直接顯示 FAILED 態（optimistic 對消，唔會佯裝排隊中）。
        const serverStatus = data?.status ?? "QUEUED";
        const optimistic: MessageItem = {
          id: data?.messageId ?? `optimistic-${Date.now()}`,
          conversationId: convId,
          waMessageId: null,
          direction: "OUT",
          channel: "API",
          type: "text",
          body,
          mediaPath: null,
          // ★ R1：optimistic bubble 以 clientMessageId 做 key — worker 之後 push 嘅 message:new
          //   帶同一 key（或同一 server id）→ 對消，唔會多一泡
          clientMessageId,
          status: serverStatus === "FAILED" ? "FAILED" : "QUEUED",
          errorCode: serverStatus === "FAILED" ? "ENQUEUE_FAILED" : null,
          sentByStaffId: user.staffId,
          aiAutoSent: false,
          waTimestamp: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, optimistic]);
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId
              ? { ...c, lastMessageAt: optimistic.waTimestamp, preview: body, status: c.status === "RESOLVED" ? "OPEN" : c.status }
              : c
          )
        );
        // Phase 2：發送後重查 pending drafts（若 draft 被採用發出 → 狀態變 SENT_*，卡片應消失）
        void fetchPendingDrafts(convId);
        return { ok: true };
      } catch {
        return { ok: false, error: "網絡錯誤" };
      }
    },
    [user.staffId, fetchPendingDrafts]
  );

  // ── Phase B：過窗 template 發送（422 後 UI 揀 template → 同一 route 帶 templateName）──
  const sendTemplate = useCallback(
    async (templateName: string): Promise<{ ok: boolean; error?: string }> => {
      const convId = selectedIdRef.current;
      if (!convId) return { ok: false, error: "未選擇對話" };
      // 同一 R1 冪等語義：一次 template 發送意圖一個 UUID
      const clientMessageId = crypto.randomUUID();
      try {
        const res = await fetch("/api/messages/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId: convId, templateName, clientMessageId }),
        });
        const data = (await res.json().catch(() => null)) as {
          ok?: boolean;
          messageId?: string;
          error?: string;
          message?: string;
          status?: string;
        } | null;
        if (!res.ok) {
          return { ok: false, error: data?.message ?? data?.error ?? `發送失敗（${res.status}）` };
        }
        // 樂觀氣泡：預覽文字由 server 組（worker 發完 push message:new 帶真 wamid 對消）
        const serverStatus = data?.status ?? "QUEUED";
        const optimistic: MessageItem = {
          id: data?.messageId ?? `optimistic-${Date.now()}`,
          conversationId: convId,
          waMessageId: null,
          direction: "OUT",
          channel: "API",
          type: "template",
          body: `[template] ${templateName}`,
          mediaPath: null,
          clientMessageId,
          status: serverStatus === "FAILED" ? "FAILED" : "QUEUED",
          errorCode: null,
          sentByStaffId: user.staffId,
          aiAutoSent: false,
          waTimestamp: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, optimistic]);
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId
              ? { ...c, lastMessageAt: optimistic.waTimestamp, preview: `[template] ${templateName}`, status: c.status === "RESOLVED" ? "OPEN" : c.status }
              : c
          )
        );
        return { ok: true };
      } catch {
        return { ok: false, error: "網絡錯誤" };
      }
    },
    [user.staffId]
  );

  // ── Phase 3：發 Booking Flow（📅 掣） ─────────────────────
  const [flowBusy, setFlowBusy] = useState(false);

  // ── ★ H1：內部備註（lock 模式 composer）──────────────────────
  const sendNote = useCallback(
    async (body: string, mentions?: string[]): Promise<{ ok: boolean; error?: string }> => {
      const convId = selectedIdRef.current;
      if (!convId) return { ok: false, error: "未選擇對話" };
      try {
        const res = await fetch(`/api/conversations/${convId}/notes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body, mentions: mentions ?? [] }),
        });
        const data = (await res.json().catch(() => null)) as {
          ok?: boolean;
          messageId?: string;
          error?: string;
        } | null;
        if (!res.ok) {
          return { ok: false, error: data?.error ?? `內部備註發送失敗（${res.status}）` };
        }
        // 樂觀更新：INTERNAL 氣泡（黃底🔒；mentions 即刻入氣泡 — tick 由 receipts 重算）
        const optimistic: MessageItem = {
          id: data?.messageId ?? `optimistic-note-${Date.now()}`,
          conversationId: convId,
          waMessageId: null,
          direction: "OUT",
          channel: "INTERNAL",
          type: "note",
          body,
          mediaPath: null,
          status: "SENT",
          errorCode: null,
          sentByStaffId: user.staffId,
          mentions: mentions ?? [],
          waTimestamp: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, optimistic]);
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId
              ? { ...c, lastMessageAt: optimistic.waTimestamp, preview: "🔒 內部備註" }
              : c
          )
        );
        return { ok: true };
      } catch {
        return { ok: false, error: "網絡錯誤" };
      }
    },
    [user.staffId]
  );

  // ── ★ H1：轉交 / 接手 / 放返隊列（POST assign）──────────────────────
  const [takeoverBusy, setTakeoverBusy] = useState(false);
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);

  const applyAssignResult = useCallback((convId: string, toStaffId: string | null, assignVersion?: number) => {
    setConversations((prev) =>
      prev.map((c) =>
        c.id === convId
          ? {
              ...c,
              assigneeId: toStaffId,
              assigneeName: toStaffId
                ? staffRef.current.find((s) => s.id === toStaffId)?.name ?? null
                : null,
              // ★ Realtime P0 (R5)：成功 → 新版本（server 回傳值為準；缺 = 本地 +1）
              assignVersion: assignVersion ?? c.assignVersion + 1,
            }
          : c
      )
    );
  }, []);

  const takeover = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    const convId = selectedIdRef.current;
    if (!convId) return { ok: false, error: "未選擇對話" };
    setTakeoverBusy(true);
    setAssignError(null);
    try {
      // ★ Realtime P0 (R5)：帶 client 端 version — 陳舊（有人先接手咗）→ 409 ASSIGN_CONFLICT
      const cur = conversationsRef.current.find((c) => c.id === convId);
      const res = await fetch(`/api/conversations/${convId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toStaffId: user.staffId, assignVersion: cur?.assignVersion }),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        message?: string;
        assignVersion?: number;
        currentAssigneeName?: string | null;
      } | null;
      if (!res.ok) {
        // ★ R5：版本陳舊 → 「啱啱俾 {name} 接咗手」+ refetch 列表（唔覆寫對方）
        if (res.status === 409 && data?.error === "ASSIGN_CONFLICT") {
          const name = data.currentAssigneeName ?? "另一位 staff";
          setNotice(`呢個對話啱啱俾 ${name} 接咗手 — 列表已更新`);
          void fetchConversations(activeClinicRef.current);
          return { ok: false, error: `啱啱俾 ${name} 接咗手` };
        }
        const msg = data?.message ?? data?.error ?? `接手失敗（${res.status}）`;
        setAssignError(msg);
        return { ok: false, error: msg };
      }
      applyAssignResult(convId, user.staffId, data?.assignVersion);
      setNotice("你而家係呢個對話嘅負責人 — 可以發 WhatsApp 訊息");
      return { ok: true };
    } catch {
      return { ok: false, error: "網絡錯誤" };
    } finally {
      setTakeoverBusy(false);
    }
  }, [user.staffId, applyAssignResult, fetchConversations]);

  const assignConversationApi = useCallback(
    async (toStaffId: string | null): Promise<{ ok: boolean; error?: string }> => {
      const convId = selectedIdRef.current;
      if (!convId) return { ok: false, error: "未選擇對話" };
      setAssignBusy(true);
      setAssignError(null);
      try {
        // ★ Realtime P0 (R5)：帶 client 端 version — 陳舊 → 409 ASSIGN_CONFLICT
        const cur = conversationsRef.current.find((c) => c.id === convId);
        const res = await fetch(`/api/conversations/${convId}/assign`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ toStaffId, assignVersion: cur?.assignVersion }),
        });
        const data = (await res.json().catch(() => null)) as {
          ok?: boolean;
          error?: string;
          message?: string;
          assignVersion?: number;
          currentAssigneeName?: string | null;
        } | null;
        if (!res.ok) {
          // ★ R5：版本陳舊 → 「啱啱俾 {name} 接咗手」+ refetch 列表（唔覆寫對方）
          if (res.status === 409 && data?.error === "ASSIGN_CONFLICT") {
            const name = data.currentAssigneeName ?? "另一位 staff";
            setNotice(`呢個對話啱啱俾 ${name} 接咗手 — 列表已更新`);
            void fetchConversations(activeClinicRef.current);
            return { ok: false, error: `啱啱俾 ${name} 接咗手` };
          }
          const msg = data?.message ?? data?.error ?? `轉交失敗（${res.status}）`;
          setAssignError(msg);
          return { ok: false, error: msg };
        }
        applyAssignResult(convId, toStaffId, data?.assignVersion);
        return { ok: true };
      } catch {
        return { ok: false, error: "網絡錯誤" };
      } finally {
        setAssignBusy(false);
      }
    },
    [applyAssignResult, fetchConversations]
  );

  const sendFlow = useCallback(async () => {
    const convId = selectedIdRef.current;
    if (!convId) return { ok: false, error: "未選擇對話" };
    setFlowBusy(true);
    try {
      const res = await fetch(`/api/conversations/${convId}/flows`, { method: "POST" });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        reused?: boolean;
        error?: string;
        message?: string;
      } | null;
      if (res.status === 422) {
        return { ok: false, error: data?.message ?? "窗口已過，Flow 要用 template" };
      }
      if (!res.ok) {
        return { ok: false, error: data?.error ?? `發送失敗（${res.status}）` };
      }
      if (data?.reused) {
        setNotice("預約連結已經發咗，病人撳入去繼續就得");
      }
      return { ok: true };
    } catch {
      return { ok: false, error: "網絡錯誤" };
    } finally {
      setFlowBusy(false);
    }
  }, []);

  // ── 側欄 patch ────────────────────────────────────────────────────────
  const patchConversation = useCallback(
    async (body: { status?: ConvStatus; assigneeId?: string | null; urgent?: boolean }) => {
      const convId = selectedIdRef.current;
      if (!convId) return;
      try {
        const res = await fetch(`/api/conversations/${convId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          const data = (await res.json()) as Partial<ConversationItem>;
          setConversations((prev) =>
            prev.map((c) =>
              c.id === convId
                ? {
                    ...c,
                    status: (data.status as ConvStatus) ?? c.status,
                    assigneeId: data.assigneeId ?? c.assigneeId,
                    urgent: typeof data.urgent === "boolean" ? data.urgent : c.urgent,
                  }
                : c
            )
          );
        }
      } catch {
        /* ignore */
      }
    },
    []
  );

  // ── search（debounce 300ms） ─────────────────────────────────────────
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!search.trim()) {
      setSearchResults(null);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      try {
        const clinicQs = activeClinicId !== "all" ? `&clinicId=${activeClinicId}` : "";
        const res = await fetch(`/api/search?type=contact&q=${encodeURIComponent(search.trim())}${clinicQs}`);
        if (!res.ok) {
          setSearchResults([]);
          return;
        }
        const data = (await res.json()) as { results: ContactSearchHit[] };
        const items: ConversationItem[] = data.results.map((hit) => {
          const existing = conversations.find((c) => c.contactId === hit.id);
          if (existing) return existing;
          return {
            id: `contact:${hit.id}`,
            clinicId: hit.clinicId,
            contactId: hit.id,
            status: "OPEN",
            pinnedPatient: null,
            assigneeId: null,
            assigneeName: null,
            assignVersion: 0,
            unreadCount: 0,
            lastInboundAt: null,
            lastMessageAt: new Date(0).toISOString(),
            intent: null,
            intentConfidence: null,
            urgency: null,
            urgent: false,
            aiSummary: null,
            contact: { id: hit.id, waId: hit.waId, profileName: hit.profileName, labels: hit.labels },
            pendingBooking: null,
            holdEvent: null,
            window: { open: false, remainingMs: 0, remainingHours: 0, tone: "red" },
            preview: "（未開始對話）",
          };
        });
        setSearchResults(items);
      } catch {
        setSearchResults([]);
      }
    }, 300);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [search, activeClinicId, conversations]);

  // ── 隊列列表 filter（client 端：activeClinicId + statusFilter 喺 component 內做） ──
  const visibleConversations = useMemo(() => {
    if (user.role === "STAFF") return conversations; // 已 scoped
    if (activeClinicId === "all") return conversations;
    return conversations.filter((c) => c.clinicId === activeClinicId);
  }, [conversations, activeClinicId, user.role]);

  const selectedConv = useMemo(
    () => conversations.find((c) => c.id === selectedConvId) ?? null,
    [conversations, selectedConvId]
  );

  return (
    <div className="h-full flex min-h-0 relative">
      <ConversationList
        hidden={selectedConvId !== null}
        userRole={user.role}
        clinics={clinics}
        activeClinicId={activeClinicId}
        onActiveClinic={(id) => {
          setActiveClinicId(id);
          setSearchResults(null);
          setSearch("");
          void fetchConversations(id);
        }}
        statusFilter={statusFilter}
        onStatusFilter={setStatusFilter}
        conversations={visibleConversations}
        selectedId={selectedConvId}
        onSelect={(id) => void selectConversation(id)}
        search={search}
        onSearch={setSearch}
        searchResults={searchResults}
        onClearSearch={() => {
          setSearch("");
          setSearchResults(null);
        }}
        myStaffId={user.staffId}
        mentionUnread={mentionUnread}
        mentionTotal={mentionTotal}
        onBellClick={() => void onBellClick()}
        notices={notices}
        onNoticeClick={onNoticeClick}
        unreadTotal={unreadTotal}
        prefs={prefs}
        onPrefsChange={updatePrefs}
      />

      {/* ★ Part B：首次登入 banner 一次（localStorage flag；啟 = 請求 permission + 開桌面通知） */}
      {notifyBanner && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-40 w-[min(94%,540px)] bg-panel border border-line rounded-xl shadow-lg px-4 py-3 flex items-center gap-3">
          <span className="text-sm text-t1 flex-1">開啟通知？客人嚟訊息即刻知</span>
          <button
            onClick={() => {
              void (async () => {
                const perm = await ensurePermission();
                updatePrefs({ ...prefsRef.current, desktop: perm === "granted" });
                dismissNotifyBanner();
                setNotifyBanner(false);
              })();
            }}
            className="text-xs px-3 py-1.5 rounded-full bg-brand text-white hover:opacity-90 shrink-0"
          >
            開啟通知
          </button>
          <button
            onClick={() => {
              dismissNotifyBanner();
              setNotifyBanner(false);
            }}
            className="text-xs px-3 py-1.5 rounded-full bg-panel-2 text-t2 hover:text-t1 shrink-0"
          >
            唔該
          </button>
        </div>
      )}

      <ChatPane
        onBack={() => setSelectedConvId(null)}
        onOpenDetail={() => setDetailOpen(true)}
        conversation={selectedConv}
        messages={messages}
        hasMore={hasMore}
        loadingOlder={loadingOlder}
        onScrollTop={() => void loadOlder()}
        window={selectedConv?.window ?? null}
        onSend={sendMessage}
        onSendTemplate={sendTemplate}
        staffName={user.name}
        pendingDraft={selectedConv ? (pendingDrafts[selectedConv.id] ?? null) : null}
        onAdopt={adoptDraft}
        onDiscard={discardDraft}
        draftBusy={draftBusy}
        onSendFlow={sendFlow}
        flowBusy={flowBusy}
        myStaffId={user.staffId}
        onSendNote={sendNote}
        onTakeover={takeover}
        takeoverBusy={takeoverBusy}
        staff={staff}
        readReceipts={receipts}
        onNoteRead={markNoteRead}
        onBookingActionDone={() => {
          void fetchConversations(activeClinicRef.current);
          setCtxRefreshKey((k) => k + 1);
        }}
      />

      <DetailPane
        conversation={selectedConv}
        staff={staff}
        onPatch={patchConversation}
        mobileOpen={detailOpen}
        onMobileClose={() => setDetailOpen(false)}
        myStaffId={user.staffId}
        clinicCode={clinics.find((c) => c.id === selectedConv?.clinicId)?.code ?? null}
        userRole={user.role}
        onAssign={assignConversationApi}
        assignBusy={assignBusy}
        assignError={assignError}
        onBookingUiChanged={() => {
          void fetchConversations(activeClinicRef.current);
          setCtxRefreshKey((k) => k + 1);
        }}
        ctxRefreshKey={ctxRefreshKey}
        notesRefreshKey={notesRefreshKey}
      />

      {/* Phase 2：急症升級 toast（socket urgent:escalation） */}
      {urgentToast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 bg-danger text-white text-sm px-4 py-2.5 rounded-xl shadow-lg z-50 flex items-center gap-3 w-[calc(100%-2rem)] md:w-auto">
          <span className="font-medium">🚨 急症升級：{urgentToast.contactName ?? "病人"} 主訴緊急不適 — 請即刻處理</span>
          <button
            onClick={() => {
              const cid = urgentToast.conversationId;
              setUrgentToast(null);
              setSelectedConvId(cid);
              void fetchMessagesLatest(cid);
              void fetchPendingDrafts(cid);
              void markRead(cid);
            }}
            className="text-xs underline underline-offset-2 shrink-0"
          >
            查看
          </button>
          <button onClick={() => setUrgentToast(null)} className="text-white/70 hover:text-white shrink-0">
            ✕
          </button>
        </div>
      )}

      {notice && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-t1 text-canvas text-sm px-4 py-2 rounded-xl shadow-lg z-50">
          {notice}
          <button onClick={() => setNotice(null)} className="ml-3 text-t3 hover:text-canvas">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

function windowFromLastInbound(lastInboundAt: string | null | undefined) {
  const lastIn = lastInboundAt ? new Date(lastInboundAt).getTime() : null;
  const remainingMs = lastIn === null ? 0 : Math.max(0, lastIn + WINDOW_MS - Date.now());
  return {
    open: remainingMs > 0,
    remainingMs,
    remainingHours: remainingMs / 3600000,
    tone: (!remainingMs ? "red" : remainingMs < 6 * 3600 * 1000 ? "yellow" : "green") as "red" | "yellow" | "green",
  };
}

// ★ Part B（N-7）：favicon 紅點（canvas 畫 — 零新資產；unread>0 時換 data URL，=0 還原）
function unreadFaviconDataUrl(n: number): string {
  try {
    const S = 64;
    const canvas = document.createElement("canvas");
    canvas.width = S;
    canvas.height = S;
    const g = canvas.getContext("2d");
    if (!g) return "/favicon.ico";
    // 底：品牌綠圓角方塊（同 light theme --brand 一致）
    g.fillStyle = "#7a8a5e";
    g.beginPath();
    if (typeof g.roundRect === "function") g.roundRect(2, 2, 60, 60, 14);
    else g.rect(2, 2, 60, 60);
    g.fill();
    // 紅點（右上角）
    g.fillStyle = "#e5484d";
    g.beginPath();
    g.arc(46, 18, 15, 0, Math.PI * 2);
    g.fill();
    // 數字
    g.fillStyle = "#fff";
    g.font = `bold ${n > 99 ? 12 : n > 9 ? 14 : 18}px sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(n > 99 ? "99+" : String(n), 46, 19);
    return canvas.toDataURL("image/png");
  } catch {
    return "/favicon.ico";
  }
}

// playChime 已移去 @/lib/notify-client（Part B — 同 fireNotify 一起統一管理）

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  AiClassifiedEvent,
  BookingEvent,
  ClinicInfo,
  ClinicLite,
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
  RoutingAssignedEvent,
  RoutingEscalationEvent,
  StaffInfo,
  StaffNoticeItem,
  UrgentEscalationEvent,
  UserCtx,
} from "./types";
import {
  DEFAULT_NOTIFY_PREFS,
  dismissNotifyBanner,
  ensurePermission,
  ensurePushSubscription,
  fireNotify,
  notifyBannerDismissed,
  notifyPrefs,
  setNotifyPrefs,
  shouldNotify,
  isAudioUnlocked,
  unlockAudio,
  type NotifyPrefs,
} from "@/lib/notify-client";
import { ConversationList } from "./conversation-list";
import { ChatPane } from "./chat-pane";
import { DetailPane } from "./detail-pane";

const PAGE_SIZE = 50;
const WINDOW_MS = 24 * 3600 * 1000;
// cwi-realtime-fix §1.3 (RT-2) 補漏重疊窗 → cwi-realtime-v2 §2 收窄到 10s：
// 游標改用 server createdAt（單調、無偏差）— 重疊窗只係保同秒寫入嘅邊界情況。
const RT_OVERLAP_MS = 10_000;

/**
 * ★ cwi-realtime-v2 §2：訊息排序 — createdAt 主序（server 寫入時間，病人手機時鐘偏差
 *   唔會令新訊息插上面）+ waTimestamp 次序（同秒穩定）。
 *   例外：channel=HISTORY（匯入舊訊息）嘅 createdAt 係匯入時間（唔係訊息時間）— 若跟
 *   createdAt 排序會被插去最新；佢哋本來就係舊嘢 → 永遠排最舊，內裡用 waTimestamp 序。
 *   前端顯示時間照舊用 waTimestamp（病人發送時間）。
 */
function msgSortCmp(a: MessageItem, b: MessageItem): number {
  const aH = a.channel === "HISTORY";
  const bH = b.channel === "HISTORY";
  if (aH !== bH) return aH ? -1 : 1;
  if (aH) return new Date(a.waTimestamp).getTime() - new Date(b.waTimestamp).getTime();
  const ca = new Date(a.createdAt).getTime();
  const cb = new Date(b.createdAt).getTime();
  if (ca !== cb) return ca - cb;
  return new Date(a.waTimestamp).getTime() - new Date(b.waTimestamp).getTime();
}

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
  // ── cwi-multiclinic-20260903（MD A.6）：全店 staff + 診所清單 ──────────────────
  //   ① 指派選單二級（「其他分店…」店→員工 — ASSIGN target = 任何 active staff，
  //      /api/staff 已授權列齊；跨店由 assign 端守）② clinic 名 map（跨店線店名 badge）。
  //   fail-soft：拉唔到 → 選單降級只本店 / badge 唔顯（唔阻 inbox）。
  const [allStaff, setAllStaff] = useState<StaffInfo[]>([]);
  const [allClinics, setAllClinics] = useState<ClinicLite[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [staffRes, clinicRes] = await Promise.all([fetch("/api/staff"), fetch("/api/clinics?scope=schedule")]);
        if (cancelled) return;
        if (staffRes.ok) {
          const s = (await staffRes.json()) as StaffInfo[];
          if (Array.isArray(s)) setAllStaff(s);
        }
        if (clinicRes.ok) {
          const j = (await clinicRes.json()) as { clinics?: ClinicLite[] };
          if (Array.isArray(j.clinics)) setAllClinics(j.clinics);
        }
      } catch {
        /* 網絡抖動 — fail-soft（選單/badge 降級，唔阻 inbox） */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const allStaffRef = useRef<StaffInfo[]>([]);
  allStaffRef.current = allStaff;
  // clinic id → 基本資料（allClinics 優先；SSR clinics 打底 — STAFF 嘅 SSR 只有自己店）
  const clinicById = useMemo(() => {
    const m = new Map<string, ClinicLite>();
    for (const c of clinics) m.set(c.id, { id: c.id, code: c.code, name: c.name });
    for (const c of allClinics) m.set(c.id, c);
    return m;
  }, [clinics, allClinics]);
  const clinicByIdRef = useRef(clinicById);
  clinicByIdRef.current = clinicById;
  // D.4（cwi-schedv2-20260903）：舊當值卡管線（dutyMap/refreshDuty/15min）移除 —
  //   側欄改「今日可約迷你表」（MiniSchedule 自拉 /api/flows/slots）。
  const [conversations, setConversations] = useState<ConversationItem[]>(initialConversations);
  const [activeClinicId, setActiveClinicId] = useState<string | "all">(
    user.role === "STAFF" ? (user.clinicId ?? "all") : "all"
  );
  const [statusFilter, setStatusFilter] = useState<ConvStatus | "ALL">("ALL");
  // ★ cwi-inboxfix-20260905（MD I-10）：連線狀態（斷線時列表頂 banner — 避免「靜靜哋唔更新」）
  const [connOffline, setConnOffline] = useState(false);
  // ★ cwi-inboxfix-20260905（MD I-1/I-2）：公海膠囊指派維度 filter（server 端）+ 計數（?counts=1 順帶）
  const [assignedFilter, setAssignedFilter] = useState<"all" | "unassigned" | "mine" | "routed">("all"); // ★ cwi-routing-20260906：+派俾我
  const [convCounts, setConvCounts] = useState<{
    all: number;
    unassigned: number;
    mine: number;
    routed: number;
    pending: number;
    resolved: number;
  } | null>(null);
  const assignedFilterRef = useRef<"all" | "unassigned" | "mine" | "routed">("all");
  assignedFilterRef.current = assignedFilter;
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
  // ★ cwi-audit2-20260908 T2（A-3 超額）：>250 條 gap 有界續攞唔切齊時嘅中間斷層邊界
  //   （createdAt ms）—「最舊已載入訊息」= 第一條 createdAt > 邊界嘅 row；ChatPane 喺佢之上
  //   render「⋯ 中間有訊息未載入，向上捲查看 ⋯」分隔線（中間位置，唔係頭尾）。換對話 / 取消
  //   選中時清（selectConversation 兩分支 / 防呆 effect / onBack）。
  const [gapDividerAfterMs, setGapDividerAfterMs] = useState<number | null>(null);
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
  // ★ cwi-realtime-fix §1.1 (RT-1)：per-conversation 補漏游標 — convId → 最後見過嘅 createdAt (ms)。
  //   cwi-realtime-v2 §2：改用 server 寫入時間（waTimestamp 係病人手機時鐘，IN 訊息可偏慢幾分鐘
  //   → 游標被推過真實位置 → 補漏永久漏）。
  //   舊版全域共用游標會被「其他對話較新訊息」推進 → 選中對話嘅補漏 delta 窗口推過自己最後一條
  //   → 食訊息（根因 A）。
  const lastMsgTsRef = useRef<Map<string, number>>(new Map());
  // ★ cwi-realtime-v2 §1：message:new 去重 — 同店 assignee 會收兩次（clinic room + staff room
  //   補推）— 保留最近 500 個 message id（Set 保插入序，超額剔最舊）。
  const seenMsgIdsRef = useRef<Set<string>>(new Set());
  const rememberMsgId = (id: string | null | undefined): boolean => {
    // 回傳 true = 首次見過（應該處理）；false = 重複（skip）
    if (!id) return true;
    if (seenMsgIdsRef.current.has(id)) return false;
    seenMsgIdsRef.current.add(id);
    if (seenMsgIdsRef.current.size > 500) {
      const it = seenMsgIdsRef.current.values();
      for (let i = seenMsgIdsRef.current.size - 500; i > 0; i--) {
        const oldest = it.next().value;
        if (oldest != null) seenMsgIdsRef.current.delete(oldest);
      }
    }
    return true;
  };
  // §1.1：推進 per-conversation 游標（只進唔退；null/非法 ts 無動作）
  const bumpCursor = useCallback((convId: string, ts: string | number | null | undefined) => {
    if (!convId || ts == null || ts === "") return;
    const ms = typeof ts === "number" ? ts : new Date(ts).getTime();
    if (!Number.isFinite(ms)) return;
    const cur = lastMsgTsRef.current.get(convId) ?? 0;
    if (ms > cur) lastMsgTsRef.current.set(convId, ms);
  }, []);

  // ── cwi-realtime-fix §3 (RT-6)：realtime 可觀測性 — socket 事件計數 + 補漏時間 ──
  const rtStatsRef = useRef<Record<string, number>>({});
  const lastCatchUpAtRef = useRef<number | null>(null);
  const [rtDebug, setRtDebug] = useState<{
    connected: boolean;
    events: Record<string, number>;
    cursors: Record<string, number>;
    lastCatchUpAt: number | null;
  }>({ connected: false, events: {}, cursors: {}, lastCatchUpAt: null });
  const takeRtSnapshot = useCallback(() => {
    const cursors = [...lastMsgTsRef.current.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    setRtDebug({
      connected: !!(socketRef.current && !socketRef.current.disconnected),
      events: { ...rtStatsRef.current },
      cursors: Object.fromEntries(cursors),
      lastCatchUpAt: lastCatchUpAtRef.current,
    });
  }, []);
  const rtRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRtSnapshot = useCallback(() => {
    if (rtRefreshTimerRef.current) return; // 1s debounce — 事件 burst 唔會每條都 re-render
    rtRefreshTimerRef.current = setTimeout(() => {
      rtRefreshTimerRef.current = null;
      takeRtSnapshot();
    }, 1000);
  }, [takeRtSnapshot]);
  useEffect(
    () => () => {
      if (rtRefreshTimerRef.current) clearTimeout(rtRefreshTimerRef.current);
    },
    []
  );
  // ★ Realtime P0 (R3, cwi-rt-20260823-a1)：focus/visibility/3 分鐘 idle refetch 游標
  const lastConvSeenRef = useRef<number>(Date.now()); // 對話列表 lastMessageAt 游標（ms epoch）
  const deltaInFlightRef = useRef<boolean>(false); // focus+visibility 同時觸發 → 唔重複 fetch
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesRef = useRef<MessageItem[]>([]);
  const activeClinicRef = useRef<string | "all">(activeClinicId);
  // ★ cwi-audit2-20260908 T1：selectedIdRef 唔再 render-body 隱式同步 — 所有選中路徑明確 sync
  //   （selectConversation 內部 / onBack / 防呆 effect）。render 時「ref 跟 state」會掩飾
  //   「state 改咗但載入/markRead 冇做」一類 bug（A-1/A-2 根因）。
  messagesRef.current = messages;
  activeClinicRef.current = activeClinicId;

  // ── ★ H2：已讀回執（tick 語義）+ mention 通知（bell badge / 黃點 / Notification） ──
  const [receipts, setReceipts] = useState<NoteReceipt[]>([]); // 選中對話嘅回執（socket note:read 增量更新）
  const [mentionUnread, setMentionUnread] = useState<Record<string, number>>({}); // conversationId → 未讀 mention 數
  const lastMentionRef = useRef<{ conversationId: string; messageId: string } | null>(null);
  const mentionUnreadRef = useRef<Record<string, number>>({});
  mentionUnreadRef.current = mentionUnread;

  const mentionTotal = Object.values(mentionUnread).reduce((a, b) => a + b, 0);

  // ── ★ cwi-realtime-v2 §5：音效實時狀態（設定面板顯示 — 唔使再估） ──
  // audioOk = 已解鎖（首次互動後）；pwaStandalone = 已安裝為 App（Chrome autoplay 政策
  //   明文例外 — 零互動即准播音，正式解法）。見 notify-client unlockAudio 註釋。
  const [audioOk, setAudioOk] = useState(false);
  const [pwaStandalone, setPwaStandalone] = useState(false);
  const unlockAudioNow = useCallback(() => {
    unlockAudio(() => setAudioOk(true));
  }, []);
  useEffect(() => {
    setAudioOk(isAudioUnlocked());
    const mq = window.matchMedia("(display-mode: standalone)");
    const upd = () =>
      setPwaStandalone(mq.matches || (navigator as unknown as { standalone?: boolean }).standalone === true);
    upd();
    mq.addEventListener?.("change", upd);
    return () => mq.removeEventListener?.("change", upd);
  }, []);

  // ── ★ Part B 通知 v1（N-8）：開關 localStorage per-device + 首次登入 banner ──
  //   預設先渲染（SSR 安全），mount 後先讀真實 localStorage — 避 hydration mismatch。
  const [prefs, setPrefs] = useState<NotifyPrefs>(DEFAULT_NOTIFY_PREFS);
  const prefsRef = useRef<NotifyPrefs>(prefs);
  prefsRef.current = prefs;
  const [notifyBanner, setNotifyBanner] = useState(false);
  useEffect(() => {
    // 首屏：localStorage cache（可能係壞值/舊值 — notifyPrefs 已自我修復 muted===adminMsg 特徵；§2.2）
    const local = notifyPrefs();
    setPrefs(local);
    if (!notifyBannerDismissed()) setNotifyBanner(true);
    // ★ cwi-realtime-fix §2.1 (RT-4)：DB 係 prefs 唯一真相 — mount 時先 fetch server
    //   → 覆蓋 localStorage → 再用（localStorage 只係離線/首屏 cache）。
    //   舊版 mount 時 syncPushPrefs（localStorage → DB）會用舊本地值污染 DB — 已廢。
    void (async () => {
      try {
        const res = await fetch("/api/push/prefs", { cache: "no-store" });
        if (!res.ok) return; // 網絡/server 錯 → 用 local cache 兜底（下次 mount 再試）
        const d = (await res.json()) as { mutedClinics?: string[]; adminMsgClinics?: string[] };
        const strArr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
        // §2.3 角色語義：每個角色只持有自己嗰個欄（另一欄強制空 — 防跨角色污染）
        const merged =
          user.role === "STAFF"
            ? { ...local, mutedClinics: strArr(d.mutedClinics), adminMsgClinics: [] as string[] }
            : { ...local, mutedClinics: [] as string[], adminMsgClinics: strArr(d.adminMsgClinics) };
        setNotifyPrefs(merged); // 覆蓋 localStorage（server 為準）
        setPrefs(merged);
        // eslint-disable-next-line no-console -- §2.4 prefs mount sync 留痕
        console.debug("[prefs] mount sync from DB（單一真相）", user.role);
      } catch {
        /* offline / 首屏 — 用 local cache */
      }
    })();
    // v2 Web Push：每次登入（mount）冪等確保 subscription（endpoint unique — 已授權先）
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      void ensurePushSubscription();
    }
    // cwi-realtime-fix §8：SW 先於 mount 完成註冊/更新接管 → 補確保 subscription
    // （mount 時 reg 未 ready → ensurePushSubscription 直接 false 且唔會自動重試 — 修首次登入 race）
    const onSwActivated = () => {
      if (typeof Notification !== "undefined" && Notification.permission === "granted") void ensurePushSubscription();
    };
    window.addEventListener("sw:activated", onSwActivated);
    // §4 Android 音效解鎖：首次 pointerdown → 0 音量 chime（一次性；失敗靜默跳過）
    // ★ v2 §5：解鎖成功 → 設定面板實時狀態更新
    const onFirstPointerDown = () => {
      unlockAudio(() => setAudioOk(true));
    };
    window.addEventListener("pointerdown", onFirstPointerDown, { once: true, capture: true });
    return () => {
      window.removeEventListener("pointerdown", onFirstPointerDown, { capture: true });
      window.removeEventListener("sw:activated", onSwActivated);
    };
  }, []);
  const updatePrefs = useCallback(
    async (next: NotifyPrefs) => {
      setPrefs(next); // UI 即時回應
      // per-device 欄（desktop/sound）唔過 DB → localStorage 直接寫
      setNotifyPrefs({ ...prefsRef.current, desktop: next.desktop, sound: next.sound });
      // ★ cwi-realtime-fix §2.1 (RT-4)：角色欄（mutedClinics/adminMsgClinics）先 POST（只發自己角色欄 —
      //   F-2），成功之後先寫 localStorage（唔好樂觀寫）；失敗保舊本地值，下次 mount 由 server 覆蓋自愈
      const body =
        user.role === "ADMIN" ? { adminMsgClinics: next.adminMsgClinics } : { mutedClinics: next.mutedClinics };
      try {
        const res = await fetch("/api/push/prefs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          // eslint-disable-next-line no-console -- §2.4 prefs POST 失敗留痕（本地保舊值）
          console.warn("[prefs] POST /api/push/prefs 失敗 (HTTP", res.status, ") — 本地保舊值（下次 mount 重同步）");
          return;
        }
        setNotifyPrefs(next); // server 確認寫入 → localStorage 覆蓋
        // eslint-disable-next-line no-console -- §2.4 prefs POST ok 留痕
        console.debug("[prefs] POST ok → localStorage", user.role);
      } catch {
        // eslint-disable-next-line no-console -- §2.4 prefs POST 網絡錯留痕
        console.warn("[prefs] POST 網絡錯 — 本地保舊值（下次 mount 重同步）");
      }
    },
    [user.role]
  );

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

    // ★ cwi-realtime-fix §3 (RT-6)：所有 socket 事件計數（debug 面板第一站）
    socket.onAny((ev: string) => {
      rtStatsRef.current[ev] = (rtStatsRef.current[ev] ?? 0) + 1;
      scheduleRtSnapshot();
    });

    socket.on("message:new", (e: NewMessageEvent) => {
      // ★ cwi-realtime-v2 §1：去重 — 同店 assignee 經 clinic room + staff room 收同一條兩次；
      //   唔去重會雙彈 OS 通知 / 雙更新列表。
      if (!rememberMsgId(e.message.id)) return;
      if (e.message.createdAt) bumpCursor(e.conversationId, e.message.createdAt); // §1.2 + v2 §2：游標用 server createdAt
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.id === e.conversationId);
        const msg = e.message;
        const isOut = msg.direction === "OUT";
        const existing = idx >= 0 ? prev[idx] : null;
        const item: ConversationItem = {
          id: e.conversationId,
          clinicId: e.clinicId,
          // cwi-multiclinic-20260903：店名 badge 資料（payload 零 PII 只帶 clinicId → map 補）
          clinicName: clinicByIdRef.current.get(e.clinicId)?.name ?? null,
          clinicCode: clinicByIdRef.current.get(e.clinicId)?.code ?? null,
          contactId: e.contact?.id ?? existing?.contactId ?? "",
          status: e.conversation.status,
          assigneeId: existing?.assigneeId ?? null,
          assigneeName: existing?.assigneeName ?? null,
          assignVersion: existing?.assignVersion ?? 0,
          pinnedPatient: existing?.pinnedPatient ?? null,
          unreadCount: isOut
            ? (existing?.unreadCount ?? 0)
            : selectedIdRef.current === e.conversationId && document.visibilityState === "visible"
              ? 0 // ★ cwi-hotfix-20260908 §2 (T303)：開住對話 + tab 可見 → badge 即時清（server markRead 另走 debounce）
              : e.conversation.unreadCount, // tab hidden → 保留事件值（用戶真未睇；visibilitychange 返嚟先清 — T304）
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
          return [...prev, msg].sort(msgSortCmp);
        });
        // ★ cwi-hotfix-20260908 §2 (T303)：開住對話收 IN + tab 可見 → 即清（server markRead
        //   包 300ms debounce — 連發十條只打一次 API）。hidden 唔 markRead（T304）。
        if (msg.direction === "IN" && document.visibilityState === "visible") {
          void markReadDebounced(e.conversationId);
        }
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
          // eslint-disable-next-line no-console -- F-7 通知來源留痕（MD 要求 console.debug）
          console.debug("notify:", "socket:message:new"); // F-7：通知來源留痕（只准 socket/push 觸發）
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
        prev.map((m) =>
          m.waMessageId === e.waMessageId || m.id === e.waMessageId
            ? {
                ...m,
                status: e.status,
                errorCode: e.errorCode,
                // ★ cwi-inboxfix-20260905（MD §5.3）：void 事件帶 voidedAt → 氣泡即時加「已作廢」tag
                ...(e.voidedAt ? { voidedAt: e.voidedAt } : {}),
              }
            : m
        )
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
                // cwi-multiclinic-20260903：全店 staff 先查（跨店負責人）→ fallback 本店
                assigneeName: e.assigneeId
                  ? allStaffRef.current.find((s) => s.id === e.assigneeId)?.name ??
                    staffRef.current.find((s) => s.id === e.assigneeId)?.name ??
                    null
                  : null,
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
          // ★ Part F（F.7）：trace panel 數據源
          traceJson: e.traceJson ?? null,
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
        // eslint-disable-next-line no-console -- F-7 通知來源留痕（MD 要求 console.debug）
        console.debug("notify:", "socket:notice:new"); // F-7：通知來源留痕（只准 socket/push 觸發）
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
        // eslint-disable-next-line no-console -- F-7 通知來源留痕（MD 要求 console.debug）
        console.debug("notify:", "socket:urgent:escalation"); // F-7：通知來源留痕（只准 socket/push 觸發）
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

    // ★ cwi-inboxfix-20260905（MD I-10）：socket 重連修復 —
    //   現況只有 disconnect handler，connect/reconnect 後冇重新註冊/補漏 →
    //   重連後收唔到 message:new（「唔即時更新」）。
    //   改：connect → 顯式 emit register（server 冪等 handler）+ 重連後 refetch 補漏 + connState。
    let wasDisconnected = false;
    let firstConnect = true;

    // ── ★ H1：Send Lock / 內部備註 事件 ────────────────────────

    // 轉交/接手/放返隊列/auto-claim → 負責人 chip 即時更新（payload 零內文）
    socket.on("conversation:assigned", (e: ConversationAssignedEvent) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === e.conversationId
            ? {
                ...c,
                assigneeId: e.assigneeId,
                // cwi-multiclinic-20260903：全店 staff 先查（跨店負責人唔喺 initialStaff）→ fallback 本店
                assigneeName: e.assigneeId
                  ? allStaffRef.current.find((s) => s.id === e.assigneeId)?.name ??
                    staffRef.current.find((s) => s.id === e.assigneeId)?.name ??
                    null
                  : null,
                // ★ Realtime P0 (R5)：version 同步 — 其他 client 之後 assign 先唔會 409
                assignVersion: e.assignVersion,
              }
            : c
        )
      );
    });

    // ── ★ cwi-auditfix-20260908（M-1）：routing 事件 → patch 該 row + 重算 counts.routed ──
    // 「派俾我」predicate（同 server conversations/route.ts 同源）：
    //   未指派 且（routedStaffId=我 ∨ routedGroupId∈我組）。舊狀況：只有 push/notice，
    //   inbox 列表要手動 reload 先見到新 route 行（「派俾我」膠囊計數唔變）。
    const routedForMe = (c: ConversationItem): boolean =>
      c.assigneeId == null &&
      (c.routedStaffId === user.staffId ||
        (c.routedGroupId != null && (user.myGroupIds ?? []).includes(c.routedGroupId)));
    const patchRoutingRow = (
      convId: string,
      patch: Partial<ConversationItem>,
      before: ConversationItem | undefined
    ) => {
      setConversations((prev) => prev.map((c) => (c.id === convId ? { ...c, ...patch } : c)));
      setConvCounts((prevCounts) => {
        if (!prevCounts || !before) return prevCounts; // row 唔喺列表（filter 外）→ 唔敢估 delta
        const wasRouted = routedForMe(before);
        const nowRouted = routedForMe({ ...before, ...patch } as ConversationItem);
        const delta = (nowRouted ? 1 : 0) - (wasRouted ? 1 : 0);
        if (delta === 0) return prevCounts;
        return { ...prevCounts, routed: Math.max(0, prevCounts.routed + delta) };
      });
    };

    // routing:assigned — 路由引擎寫咗 routed* 標記（組 ∨ R-9 當值單人；R-2：唔掂 assignee）
    socket.on("routing:assigned", (e: RoutingAssignedEvent) => {
      const before = conversationsRef.current.find((c) => c.id === e.conversationId);
      patchRoutingRow(
        e.conversationId,
        {
          routedGroupId: e.groupId,
          routedGroupName: e.groupName,
          routedStaffId: e.staffId,
          routedAt: new Date().toISOString(),
          escalatedAt: null,
        },
        before
      );
    });

    // routing:escalation — 升級計時器 claim 咗對話（routed → 升級組；routedStaffId 清 null）
    socket.on("routing:escalation", (e: RoutingEscalationEvent) => {
      const before = conversationsRef.current.find((c) => c.id === e.conversationId);
      patchRoutingRow(
        e.conversationId,
        {
          routedGroupId: e.toGroupId,
          routedGroupName: e.groupName,
          routedStaffId: null,
          escalatedAt: e.escalatedAt,
        },
        before
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
        // eslint-disable-next-line no-console -- F-7 通知來源留痕（MD 要求 console.debug）
        console.debug("notify:", "socket:notify:mention"); // F-7：通知來源留痕（只准 socket/push 觸發）
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

    // ★ cwi-inboxfix-20260905（MD I-4）：指派 → 定向 push（title「新指派 · {店簡稱}」/「有一條對話指派咗俾你」）。
    //   跨店被派者唔喺店 room — server 用 staff:{id} 定向 send 保證到；bell（StaffNotice row）順帶重拉。
    socket.on("notify:assigned", (e: { conversationId: string; clinicId: string; clinicCode?: string | null }) => {
      if (
        shouldNotify({
          kind: "assigned",
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
        // eslint-disable-next-line no-console -- F-7 通知來源留痕（MD 要求 console.debug）
        console.debug("notify:", "socket:notify:assigned"); // F-7：通知來源留痕（只准 socket/push 觸發）
        void fireNotify({
          kind: "assigned",
          clinicShort: e.clinicCode || clinicShortOf(e.clinicId),
          conversationId: e.conversationId,
          body: "有一條對話指派咗俾你",
          onClick: () => void selectConversation(e.conversationId),
          prefs: prefsRef.current,
        });
      }
      // 列表即時更新（新指派線要即刻見到）+ bell 重拉（StaffNotice row）
      void fetchConversations(activeClinicRef.current);
      fetch("/api/notices", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d?.notices) setNotices(d.notices);
        })
        .catch(() => {});
    });

    // ★ cwi-inboxfix-20260905（MD §1.4 I-5）：公海 SLA — 未指派超過 N 分鐘 → 全店 active STAFF 定向 push
    //   （server 已 filter；body 零病人資料：店 code + 數目 + N）。bell（StaffNotice row）順帶重拉。
    socket.on(
      "notify:sla",
      (e: { clinicId: string; clinicCode?: string | null; conversationId?: string | null; count?: number; n?: number }) => {
        if (
          shouldNotify({
            kind: "sla",
            clinicId: e.clinicId,
            conversationId: e.conversationId ?? "",
            assigneeId: null,
            myStaffId: user.staffId,
            myRole: user.role,
            activeConversationId: selectedIdRef.current,
            mutedClinics: prefsRef.current.mutedClinics,
            adminMsgClinics: prefsRef.current.adminMsgClinics,
          })
        ) {
          // eslint-disable-next-line no-console -- F-7 通知來源留痕（MD 要求 console.debug）
          console.debug("notify:", "socket:notify:sla"); // F-7：通知來源留痕（只准 socket/push 觸發）
          void fireNotify({
            kind: "sla",
            clinicShort: e.clinicCode || clinicShortOf(e.clinicId),
            conversationId: e.conversationId ?? "",
            body: `有 ${e.count ?? 1} 條對話未有人跟（超過 ${e.n ?? 10} 分鐘）`,
            onClick: () => e.conversationId && void selectConversation(e.conversationId),
            prefs: prefsRef.current,
          });
        }
        // 公海計數可能變（新入公海嘅線要即刻見到）+ bell 重拉（StaffNotice row）
        void fetchConversations(activeClinicRef.current);
        fetch("/api/notices", { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (d?.notices) setNotices(d.notices);
          })
          .catch(() => {});
      }
    );

    socket.on("disconnect", () => {
      wasDisconnected = true;
      setConnOffline(true);
      takeRtSnapshot();
    });
    socket.on("connect", () => {
      // ★ cwi-inboxfix-20260905（MD I-10）：每次 connect（首次/重連）都顯式重註冊 + 恢復 online。
      socket.emit("register");
      setConnOffline(false);
      takeRtSnapshot();
      if (firstConnect) {
        // 首次 connect：數據由 SSR/initial fetch 提供 — 唔重複 refetch（避免 load 雙拉）
        firstConnect = false;
        return;
      }
      if (wasDisconnected) {
        wasDisconnected = false;
        // 1) 重連 → 重新註冊已 emit；補返斷線期間漏咗嘅對話列表
        void fetchConversations(activeClinicRef.current);
        // 2) 開住嘅 thread 補漏（full page refetch — 長斷線後 delta cursor 可能漏）
        if (selectedIdRef.current) void fetchMessagesLatest(selectedIdRef.current);
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
  // ★ cwi-audit2-20260908 T1 (A-2)：改行 selectConversation 唯一入口 — 同步 selectedIdRef
  //   （舊版 ref 頭幾 render 靠 render-body 同步、冇 markRead → 深連結入嚟 unread 唔清；
  //   而家 render sync 已移除，呢度必經 selectConversation 先至 socket 新訊息會 append）。
  //   selectConversation 聲明喺呢度之後，但 effect 只在 mount 後先執行 → 運行時安全（冇 TDZ）。
  //   冪等：fetchMessagesLatest merge-by-id / markRead 冪等 — 即使雙調用都冇重複載入副作用。
  useEffect(() => {
    if (initialSelectedConvId) {
      void selectConversation(initialSelectedConvId);
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
      // ★ cwi-inboxfix-20260905：always 全量 list（帶 counts=1 順帶攞計數 — MD §1.1）。
      //   膠囊指派維度 filter 喺 client 做（與 server ?assigned= 語義完全等價：
      //   STAFF list scope 本身唔含外店未指派線 → unassigned client filter = I-2 公海；
      //   ADMIN = 全店 ∪ activeClinicId filter）。理由：state 保持全量 → delta merge /
      //   unreadTotal / 指派後行離開公海 都一致，唔會出現 stale 行。
      const qs = new URLSearchParams();
      if (clinicId !== "all") qs.set("clinicId", clinicId);
      qs.set("counts", "1");
      const res = await fetch(`/api/conversations?${qs.toString()}`);
      if (!res.ok) return;
      const data = (await res.json()) as
        | ConversationItem[]
        | { items: ConversationItem[]; counts: {
            all: number;
            unassigned: number;
            mine: number;
            routed: number;
            pending: number;
            resolved: number;
          } };
      const items = Array.isArray(data) ? data : data.items;
      if (!Array.isArray(data)) setConvCounts(data.counts ?? null);
      setConversations(items);
      // ★ R3：全量 fetch 後游標 = 列表最尾 ts（「我見到咗全部」— 之後 delta 只補新嘅）
      let maxTs = 0;
      for (const c of items) maxTs = Math.max(maxTs, new Date(c.lastMessageAt).getTime());
      lastConvSeenRef.current = maxTs;
    } catch {
      /* UI 會喺下次 action 補齊 */
    }
  }, []);

  const fetchMessagesLatest = useCallback(async (convId: string): Promise<number> => {
    try {
      const res = await fetch(`/api/conversations/${convId}/messages?limit=${PAGE_SIZE}`);
      if (!res.ok) return 0;
      const data = (await res.json()) as { messages: MessageItem[]; hasMore: boolean };
      // F-8（cwi-notify-fix）：merge by messageId — socket 已 append 入 state 嘅行（server list
      // 未反映 / refetch race 回舊 list）唔會因整包覆蓋消失；id 撞車 server row 為準。
      // 換對話要先喺 call site setMessages([]) 清空（避免 A 嘅行漏入 B）。
      if (selectedIdRef.current !== convId) return 0; // fetch 期間已換咗對話 → 舊結果棄
      // ★ cwi-realtime-v2 §3：回傳新增行數（reconcile tick 計 [rt] reconcile added N）
      const prevIds = new Set(messagesRef.current.map((m) => m.id));
      const addedCount = data.messages.filter((m) => !prevIds.has(m.id)).length;
      setMessages((prev) => {
        const map = new Map(prev.map((m) => [m.id, m]));
        for (const m of data.messages) map.set(m.id, m);
        return [...map.values()].sort(msgSortCmp);
      });
      setHasMore(data.hasMore);
      if (data.messages.length > 0) {
        // v2 §2：游標 = 該頁最大 createdAt（latest 頁 server 按 waTimestamp 排序 — 尾行唔一定係 max）
        const maxCreated = data.messages.reduce(
          (mx, m) => Math.max(mx, new Date(m.createdAt).getTime() || 0),
          0
        );
        bumpCursor(convId, maxCreated); // 只喺結果實際應用時
      }
      return addedCount;
    } catch {
      /* ignore */
    }
    return 0;
  }, []);

  const fetchMessagesAfter = useCallback(
    async (convId: string, afterMs: number): Promise<number> => {
      // ★ cwi-audit2-20260908 T2（A-3 有界續攞 / A-4 bump 游標 / A-6 hasMore 唔丟棄）：
      //   - 每頁成功即 bumpCursor（本頁 max createdAt；0 條唔 bump）— 唔再靠 20s reconcile
      //     跳走游標（舊 bug：reconcile 攞最新 50 + 游標跳 max → 中間永久斷層）
      //   - server hasMore 續攞最多 5 頁（250 條）— 根治 gap>50 永久中間斷層
      //   - 5 頁後仍然 hasMore（gap>250）：fetchMessagesLatest 兜最新 50 + 中間斷層分隔線
      //   - dedup：local seen 跨頁有效（setMessages 批次化喺 loop 尾 — loop 內 messagesRef 未更新）
      let totalFetched = 0;
      let totalAdded = 0;
      let lastHasMore = false;
      let pages = 0;
      let lastPageMax = 0;
      const fetchedAll: MessageItem[] = [];
      const seen = new Set(messagesRef.current.map((m) => m.id));
      try {
        let after = afterMs;
        while (pages < 5) {
          if (selectedIdRef.current !== convId) break; // fetch 期間換咗對話 → 停（防 A 嘅行漏入 B）
          const res = await fetch(
            `/api/conversations/${convId}/messages?after=${new Date(after).toISOString()}&limit=${PAGE_SIZE}`
          );
          if (!res.ok) break; // 中途中斷（網絡）：已攞頁已 apply + 游標已推進 — 下次 catchUp 由新游標接埋
          const data = (await res.json()) as { messages: MessageItem[]; hasMore: boolean };
          pages += 1;
          totalFetched += data.messages.length;
          fetchedAll.push(...data.messages);
          for (const m of data.messages) {
            if (!seen.has(m.id)) {
              totalAdded += 1;
              seen.add(m.id);
            }
          }
          lastHasMore = data.hasMore;
          if (data.messages.length > 0) {
            // A-4：本頁 max createdAt 推進游標（只進唔退）
            lastPageMax = data.messages.reduce(
              (mx, m) => Math.max(mx, new Date(m.createdAt).getTime() || 0),
              0
            );
            bumpCursor(convId, lastPageMax);
          }
          if (!lastHasMore) break;
          // ★ cwi-audit2 A-5（T313-B）：same-createdAt 群邊界保護 — 若本頁尾部群（lastPageMax）被
          //   take 截斷（例：HISTORY import batch 全部同 createdAt 橫跨頁面邊界），strict
          //   `createdAt > after` 會跳過群內剩餘行 → 游標退返群內第一行前 1ms → 下頁重攞整群
          //   （by-id dedup，零重複）。群大過頁時 5 頁上限攔截（同 gap>250 殘留行為）。
          const firstOfMaxGroup = data.messages.find((m) => new Date(m.createdAt).getTime() === lastPageMax);
          after = firstOfMaxGroup ? new Date(firstOfMaxGroup.createdAt).getTime() - 1 : lastPageMax;
        }
        // ★ cwi-realtime-fix §3 (RT-6)：補漏結果一定要 log（上次靠 code review 先搵到，今次靠 log）
        //   T2：加 hasMore 欄（MD §7 簽收）— true = 仲有 gap 未攞完；pages = 呢次續攞頁數
        // eslint-disable-next-line no-console -- §3 catchUp 留痕（realtime 排障第一停）
        console.debug("[rt] catchUp result", {
          convId,
          fetched: totalFetched,
          added: totalAdded,
          hasMore: lastHasMore,
          pages,
        });
        if (fetchedAll.length > 0 && selectedIdRef.current === convId) {
          setMessages((prev) => {
            // ★ cwi-audit2 A-5（T313-B）：fetchedAll 可含重複 id（same-createdAt 群邊界退cursor
            //   重攞整群 — 下頁重覆上頁尾群）→ 除咗對 prev dedup，仲要 in-list dedup（舊版只對
            //   prev filter → fetchedAll 內重複 id 雙倍入 state = 重複行）。
            const ids = new Set(prev.map((m) => m.id));
            const added: MessageItem[] = [];
            for (const m of fetchedAll) {
              if (!ids.has(m.id)) {
                ids.add(m.id);
                added.push(m);
              }
            }
            return added.length ? [...prev, ...added].sort(msgSortCmp) : prev;
          });
        }
        if (lastHasMore && pages >= 5 && selectedIdRef.current === convId) {
          // 超額（gap > 250）：兜最新 50（游標推到最新）+ 標記中間斷層（MD §3 方案 1）
          await fetchMessagesLatest(convId);
          setGapDividerAfterMs(lastPageMax);
        }
      } catch {
        /* ignore */
      }
      return totalAdded;
    },
    [bumpCursor, fetchMessagesLatest]
  );

  // ── cwi-realtime-fix §1.3 (RT-2 / RT-3)：per-conversation 補漏 ────────────
  // cur===0 / state 空（從未載入，或啱啱清空）→ 一定要攞完整最新一頁（清空後只做 delta
  //   係「彈完消失」第二條路 — RT-3）；否則 delta + 60 秒重疊窗（RT-2 秒級 ts 容錯，
  //   fetchMessagesAfter 已 by-id 去重 — 重疊窗唔會出重複行）。
  const catchUp = useCallback(
    async (convId: string): Promise<number> => {
      const cur = lastMsgTsRef.current.get(convId) ?? 0;
      if (cur === 0 || messagesRef.current.length === 0) {
        // eslint-disable-next-line no-console -- §3 catchUp 留痕（realtime 排障第一停）
        console.debug("[rt] catchUp", { convId, cursor: cur, mode: "latest" });
        return await fetchMessagesLatest(convId); // v2 §3：回傳 added count
      }
      // eslint-disable-next-line no-console -- §3 catchUp 留痕（realtime 排障第一停）
      console.debug("[rt] catchUp", { convId, cursor: cur, mode: "after", from: cur - RT_OVERLAP_MS });
      lastCatchUpAtRef.current = Date.now();
      void takeRtSnapshot();
      return await fetchMessagesAfter(convId, cur - RT_OVERLAP_MS); // v2 §3：回傳 added count
    },
    [fetchMessagesAfter, fetchMessagesLatest, takeRtSnapshot]
  );

  // ── ★ Realtime P0 (R3, cwi-rt-20260823-a1)：focus-refetch ────────────────
  // visibilitychange(visible) / window focus / 3 分鐘 idle timer → 同一個 refetchDelta()。
  // 覆 live 期間漏收嘅 socket event（e.g. Redis 重啟窗口 / 斷線重連之間嘅空隙）：
  //  1) 對話列表：GET /api/conversations?after=<lastSeen>（server = 現有 list route 加 param）
  //     → lastMessageAt >= after 嘅對話用 id merge（重疊容許）+ 游標推進
  //  2) 開住嘅 thread：若選中對話喺 delta 內 → fetchMessagesAfter 補訊息
  const refetchDelta = useCallback(async (opts?: { noCatchUp?: boolean }): Promise<number> => {
    if (deltaInFlightRef.current) return 0;
    const cursor = lastConvSeenRef.current;
    if (cursor <= 0) return 0;
    deltaInFlightRef.current = true;
    try {
      const qs = new URLSearchParams({ after: new Date(cursor).toISOString() });
      if (activeClinicRef.current !== "all") qs.set("clinicId", activeClinicRef.current);
      const res = await fetch(`/api/conversations?${qs.toString()}`);
      if (!res.ok) return 0;
      const rows = (await res.json()) as ConversationItem[];
      if (rows.length === 0) return 0;
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
      // cwi-realtime-fix §1.3：開住嘅 thread 補漏 — per-conversation 游標 + 重疊窗；
      // state 空/游標 0 一律行最新一頁（RT-3）。唔再「選中喺 rows 先補」— 對話列表 delta
      // 漏咗某對話都要補（游標自帶判斷，唔空攪）。
      // ★ v2 §3：reconcile tick 傳 noCatchUp（佢自己已 fetchMessagesLatest — 避免雙重計 added）。
      const sel = selectedIdRef.current;
      if (sel && !opts?.noCatchUp) return await catchUp(sel);
      return 0;
    } catch {
      /* ignore — 下次 trigger 再試 */
      return 0;
    } finally {
      deltaInFlightRef.current = false;
    }
  }, [catchUp]);

  // R3 triggers：tab focus 返 / window focus / 每 3 分鐘 idle 掃一次
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      // ★ cwi-notify-fix（T4）：背景返前台 — socket 重連/重註冊（冪等）+ 補漏
      //   （refetchConversations + refetchMessages 走 F-8 merge — 唔會 drop socket append 行）
      const s = socketRef.current;
      if (s) {
        if (s.disconnected) s.connect(); // 斷緊 → 重連（connect handler 會 register + refetch）
        else s.emit("register"); // 連緊 → 冪等重註冊（server room 重 join 兜底）
      }
      void refetchDelta();
      // ★ cwi-hotfix-20260908 §2 (T304)：tab hidden 期間選中對話收咗 IN（handler 保留 badge —
      //   用戶真未睇）→ 返前台先清：列表 badge 寫 0 + server markRead（同 IN handler 共用 debounce）。
      const sel = selectedIdRef.current;
      if (sel) {
        const c = conversationsRef.current.find((x) => x.id === sel);
        if (c && c.unreadCount > 0) {
          setConversations((prev) => prev.map((x) => (x.id === sel ? { ...x, unreadCount: 0 } : x)));
          void markReadDebounced(sel);
        }
        void fetchMessagesLatest(sel);
      }
    };
    const onFocus = () => { void refetchDelta(); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    const timer = setInterval(() => { void refetchDelta(); }, 3 * 60 * 1000);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      clearInterval(timer);
    };
  }, [refetchDelta, fetchMessagesLatest]);

  // ── ★ cwi-realtime-v2 §3：20 秒 reconcile 安全網 ─────────────────────────
  // tab 可見 + 有選中對話 → 每 20s merge 最新一頁（fetchMessagesLatest 已係 by-id merge
  //   唔會覆蓋）+ 對話列表同款 delta（noCatchUp — 訊息補漏由 fetchMessagesLatest 負責，
  //   唔雙重計 added）。任何 socket race / 事件遺失 → 漏 = 最多遲 20 秒。
  // N > 0 就係捉到一次 race — [rt] reconcile log 累積幾日就知係邊種 race。
  useEffect(() => {
    const tick = async () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      const sel = selectedIdRef.current;
      let added = 0;
      if (sel) added += await fetchMessagesLatest(sel);
      added += await refetchDelta({ noCatchUp: true });
      // eslint-disable-next-line no-console -- v2 §3 reconcile 留痕（N>0 = 捉到一次 race；string log — spy 按字符串捕）
      console.debug(`[rt] reconcile added ${added}`);
    };
    const t = setInterval(() => { void tick(); }, 20_000);
    return () => clearInterval(t);
  }, [fetchMessagesLatest, refetchDelta]);

  // ★ cwi-audit2-20260908 T3（A-5）：「createdAt 軸洞已補」per-conversation 標記（換對話時 selectConversation 清）。
  // 最新 50 用 waTimestamp 軸（hotfix 行為唔郁）— 病人手機時鐘偏差可令已載入集喺 createdAt 軸上
  // 留洞（已載行唔係連續後綴）→ 首次向上捲用 catchUp 同款 after= 機制補一次（有界 ≤5 頁 +
  // 分隔線兜底），補完向上 walk（createdAt 軸）先完整 — 舊軸「重複拉同一批／靜默跳過」根治。
  const holeFilledRef = useRef<Set<string>>(new Set());

  const loadOlder = useCallback(async () => {
    const convId = selectedIdRef.current;
    if (!convId || loadingOlder) return;
    const list = messagesRef.current;
    if (!list.length) return;
    if (!holeFilledRef.current.has(convId)) {
      holeFilledRef.current.add(convId);
      const nonHist = list
        .filter((m) => m.channel !== "HISTORY")
        .map((m) => new Date(m.createdAt).getTime())
        .filter((t) => Number.isFinite(t));
      if (list.length >= PAGE_SIZE && nonHist.length > 0) {
        const minLoaded = Math.min(...nonHist);
        await fetchMessagesAfter(convId, minLoaded - RT_OVERLAP_MS);
        if (selectedIdRef.current !== convId) return; // 補洞期間已換對話
      }
    }
    // ★ cwi-audit2 A-5：cursor = 最舊 loaded non-HISTORY 行嘅 createdAt（同 server before filter /
    // 顯示排序同軸）。HISTORY 行 createdAt = 匯入時間（同 timeline 無因果）— 直用最舊顯示行會：
    // 匯入時間新於全部 normal 行 → 重複拉同一已載入批（stuck）；舊於全部 → 提前停。
    // Fallback（純 HISTORY 對話）= 最舊顯示行（best-effort 行 import batch）。
    const cursorList = messagesRef.current;
    if (!cursorList.length) return;
    const cursor = cursorList.find((m) => m.channel !== "HISTORY") ?? cursorList[0];
    if (!cursor) return;
    setLoadingOlder(true);
    try {
      const res = await fetch(
        `/api/conversations/${convId}/messages?before=${encodeURIComponent(cursor.createdAt)}&limit=${PAGE_SIZE}`
      );
      if (!res.ok) return;
      const data = (await res.json()) as { messages: MessageItem[]; hasMore: boolean };
      const prevIds = new Set(messagesRef.current.map((m) => m.id));
      const addedCount = data.messages.filter((m) => !prevIds.has(m.id)).length;
      setMessages((prev) => {
        const ids = new Set(prev.map((m) => m.id));
        const added = data.messages.filter((m) => !ids.has(m.id));
        // v2 §2：向上捲 merge 後亦用 createdAt 主序排序（server 回傳係 createdAt desc + reverse）
        return added.length ? [...added, ...prev].sort(msgSortCmp) : prev;
      });
      // A-5 stuck guard：整頁都係已載入行（例 HISTORY 重複頁）→ 無更舊行 → 停（防 hasMore 永久 true）。
      setHasMore(data.hasMore && addedCount > 0);
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, fetchMessagesAfter]);

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
        // ★ cwi-audit2-20260908 T1：統一行 selectConversation（ref 同步 + 清 + 載入 + markRead）
        //   — 舊式只補兩個 fetch 唔清 messages（merge 語義 → 上一病人嘅行會留喺畫面）
        selectConvRef.current(convId);
      }
      window.setTimeout(() => {
        const el = document.getElementById(`msg-${msgId}`);
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("msg-flash");
        window.setTimeout(() => el.classList.remove("msg-flash"), 1600);
      }, 450);
    },
    [] // ★ cwi-audit2-20260908 T1：只經 selectConvRef（ref 恆定）→ 唔需要 reactive deps
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
      // ★ cwi-audit2-20260908 T1 (A-1)：bell 通知改行 selectConversation 唯一入口 — 清上一病人
      //   messages + 載入 + ref 同步 + markRead（舊式只 setSelectedConvId：PII 交叉顯示 +
      //   A 嘅 socket 訊息照 append 入 B 畫面 + B 新訊息唔 append + unread 唔清）。
      //   selectConvRef 模式：onNoticeClick 定義喺 selectConversation 之前（useCallback([])）
      //   → 用 ref 喺 runtime 取最新實例，避 forward-reference / stale closure。
      if (n.conversationId) selectConvRef.current(n.conversationId);
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
              selectedIdRef.current = match.id; // F-8：ref 同步（fetch guard 要即時准）
              setMessages([]); // F-8：換對話先清（fetchMessagesLatest 已改 merge）
              setGapDividerAfterMs(null); // T2：換對話清中間斷層分隔線
              holeFilledRef.current.clear(); // T3：換對話清補洞標記
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
      selectedIdRef.current = id; // F-8：ref 同步（fetch guard 要即時准）
      setMessages([]); // F-8：換對話先清（fetchMessagesLatest 已改 merge — 唔清會混兩對話）
      setGapDividerAfterMs(null); // T2：換對話清中間斷層分隔線
      holeFilledRef.current.clear(); // T3：換對話清補洞標記
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

  // ★ cwi-audit2-20260908 T1（防呆 effect）：最後防線 — 所有選中路徑必經 selectConversation
  //   （ref 同步 + setMessages([]) + 載入 + markRead）。日後任何路徑若直接 setSelectedConvId
  //   而冇同步 ref，呢個 effect 會補做完整載入 + 同步 ref + warn（可 trace）。
  //   無死循環：selectConversation 喺 setSelectedConvId 前先同步 ref（同一次同步調用）→
  //   本 effect 執行時 mismatch 已係 false → no-op；只有真 mismatch（直調路徑）先 fire 一次補載，
  //   ref 同步後即收斂。聲明位置喺深連結 mount effect 之後 → 深連結 mount 時深連結 effect
  //   先跑（selectConversation 同步 ref）→ 本 effect no-op，唔會 double load。
  useEffect(() => {
    if (selectedConvId && selectedIdRef.current !== selectedConvId) {
      // eslint-disable-next-line no-console -- 防呆 backstop 留痕（MD §1 要求）
      console.warn(
        "[inbox] selectedConvId changed without selectConversation — defensive load",
        selectedConvId
      );
      selectedIdRef.current = selectedConvId;
      setMessages([]);
      setGapDividerAfterMs(null); // T2：補載入 = 重頭載 → 清中間斷層分隔線
      holeFilledRef.current.clear(); // T3：補載入 = 重頭載 → 清補洞標記（防重載後洞唔補）
      void fetchMessagesLatest(selectedConvId);
      void fetchPendingDrafts(selectedConvId);
      void fetchNoteReceipts(selectedConvId);
      void markRead(selectedConvId);
    }
  }, [selectedConvId, fetchMessagesLatest, fetchPendingDrafts, fetchNoteReceipts]);

  // v2 Web Push：SW notificationclick → postMessage open-conversation → 選中該對話
  // （撳 push 通知：focus 本 tab 後由呢度補齊對話選中）
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onSwMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; conversationId?: string } | null;
      if (d && d.type === "open-conversation" && d.conversationId) selectConvRef.current(d.conversationId);
    };
    navigator.serviceWorker.addEventListener("message", onSwMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onSwMessage);
  }, []);

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

  // ★ cwi-hotfix-20260908 §2：markRead 300ms debounce — socket 連發 IN（burst）收斂成一次
  //   flush；flush 內每個對話只打一次 PATCH（Set 去重）。300ms 窗內換到嘅其他對話都會
  //   喺同一 flush 各自 markRead 一次（唔會漏）。
  const markReadPendingRef = useRef<Set<string>>(new Set());
  const markReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markReadDebounced = useCallback((id: string) => {
    markReadPendingRef.current.add(id);
    if (markReadTimerRef.current) clearTimeout(markReadTimerRef.current);
    markReadTimerRef.current = setTimeout(() => {
      markReadTimerRef.current = null;
      const ids = [...markReadPendingRef.current];
      markReadPendingRef.current = new Set();
      for (const i of ids) void markRead(i); // 首 render 實例只依賴 fetch + setConversations（穩定）
    }, 300);
  }, []);
  useEffect(() => {
    return () => {
      if (markReadTimerRef.current) clearTimeout(markReadTimerRef.current);
    };
  }, []);

  // ── composer ──────────────────────────────────────────────────────────
  const sendMessage = useCallback(
    async (body: string): Promise<{ ok: boolean; error?: string; templates?: { name: string; language: string }[]; takenOverBy?: string | null }> => {
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
          // cwi-multiclinic-20260903（A.6.2）：423 SEND_LOCKED 帶新負責人 id（header 即時更新）
          assigneeId?: string | null;
        } | null;
        if (res.status === 422) {
          return { ok: false, error: data?.message ?? "窗口已過，只可發 template", templates: data?.templates };
        }
        // ★ cwi-multiclinic-20260903（MD A.6.2）423 打字保護：打緊字時有人接手咗 →
        //   ① toast「{name} 已接手呢個對話」② composer 文字唔清走（chat-pane 只成功先清）
        //   ③ header 負責人名即時更新 — optimistic 寫入；socket conversation:assigned
        //      事件（接手時已 emit）會再對齊 assignVersion，唔會雙計。
        if (res.status === 423) {
          const newAssigneeId = data?.assigneeId ?? null;
          if (newAssigneeId) {
            const name = allStaffRef.current.find((s) => s.id === newAssigneeId)?.name ?? "同事";
            setNotice(`${name} 已接手呢個對話`);
            setConversations((prev) =>
              prev.map((c) =>
                c.id === convId && c.assigneeId !== newAssigneeId
                  ? { ...c, assigneeId: newAssigneeId, assigneeName: name, assignVersion: c.assignVersion + 1 }
                  : c
              )
            );
          }
          return { ok: false, error: data?.message ?? "此對話已有負責人", takenOverBy: newAssigneeId };
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

  // ── cwi-inboxfix-20260905（MD §5.3）：標記已作廢 ──
  // ★ cwi-notify-fix-20260907（§7 撤回作廢）：8 秒撤回整節剷（server undo route 已刪；
  //   MsgStatus.CANCELLED enum 保留 — legacy 顯示用，唔會再產生）
  const voidMessage = useCallback(async (messageId: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(`/api/messages/${messageId}/void`, { method: "POST" });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; voidedAt?: string; error?: string } | null;
      if (!res.ok) return { ok: false, error: data?.error ?? `標記失敗（${res.status}）` };
      return { ok: true };
    } catch {
      return { ok: false, error: "網絡錯誤" };
    }
  }, []);

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

  // ── cwi-multiclinic-20260903（MD A.6.1）放手：release = assign toStaffId:null ──────
  //   權限：現任 assignee ∨ ADMIN（server assertCanAssign 守）；確認一步喺 UI（chat-pane）。
  const release = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    const r = await assignConversationApi(null);
    if (r.ok) setNotice("已放手 — 呢條線放返隊列");
    return r;
  }, [assignConversationApi]);

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
        assignedFilter={assignedFilter}
        onAssignedFilter={(f) => setAssignedFilter(f)}
        counts={convCounts}
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
        myGroupIds={user.myGroupIds ?? []}
        myClinicIds={user.clinicIds}
        clinicById={clinicById}
        mentionUnread={mentionUnread}
        mentionTotal={mentionTotal}
        onBellClick={() => void onBellClick()}
        notices={notices}
        onNoticeClick={onNoticeClick}
        unreadTotal={unreadTotal}
        prefs={prefs}
        onPrefsChange={updatePrefs}
        connOffline={connOffline}
        rtDebug={rtDebug}
        audioStatus={{ ok: audioOk, standalone: pwaStandalone }}
        onUnlockAudio={unlockAudioNow}
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
                // v2：permission 授予後 → 確保 Web Push subscription（tab 閂咗都收到）
                if (perm === "granted") void ensurePushSubscription();
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
        onBack={() => {
          // ★ cwi-audit2-20260908 T1：取消選中都要同步 ref（render-body sync 已移除）
          //   — 否則舊對話嘅 socket 訊息會 append 入「未選中」狀態
          selectedIdRef.current = null;
          setSelectedConvId(null);
          setGapDividerAfterMs(null); // T2：取消選中清中間斷層分隔線
        }}
        onOpenDetail={() => setDetailOpen(true)}
        conversation={selectedConv}
        messages={messages}
        hasMore={hasMore}
        gapDividerAfterMs={gapDividerAfterMs}
        loadingOlder={loadingOlder}
        onScrollTop={() => void loadOlder()}
        window={selectedConv?.window ?? null}
        onSend={sendMessage}
        onSendTemplate={sendTemplate}
        // cwi-inboxfix-20260905（MD §5.3）：標記已作廢（§7：8s 撤回已作廢）
        onVoidMessage={voidMessage}
        userRole={user.role}
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
        onRelease={release}
        releaseBusy={assignBusy}
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
        // cwi-multiclinic-20260903：clinicById 打底（STAFF 多店 — SSR clinics 只冇主店）
        clinicCode={clinicById.get(selectedConv?.clinicId ?? "")?.code ?? null}
        userRole={user.role}
        onAssign={assignConversationApi}
        assignBusy={assignBusy}
        assignError={assignError}
        allStaff={allStaff}
        allClinics={allClinics}
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
              // ★ cwi-audit2-20260908 T1：統一行 selectConversation（仲補齊 fetchNoteReceipts + mention 未讀清）
              void selectConversation(cid);
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

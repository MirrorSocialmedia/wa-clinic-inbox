/**
 * notify-client — Part B 通知 v1 + v2（客人來訊一定要有提示）。
 *
 * v1 設計決定（MD §Part B B.1/B.2）：
 * - N-1 三觸發：message(IN) 主角 / urgent 急音 / notice 輕音（mention 統一走呢度）
 * - N-2 未指派 → 全店 STAFF 響；已指派 → 只負責人響；ADMIN 預設唔收（可逐店 opt-in）
 * - N-3 多店員工收自己 clinicIds 全部店（socket room 層已保證）；可逐店靜音
 * - N-4 OS 層零 PII：只有「新訊息 · TKW」級文案（mention 嘅同事名可保留）
 * - N-5 正開住嗰個對話 → 唔響唔彈（純列表更新）
 * - N-7 降級（permission denied/唔支援）：(N) WA Inbox 標題 + favicon 紅點 + bell badge
 *       （inbox-client state 驅動 — 常駐，唔單止 denied fallback）
 * - N-8 開關存 localStorage per-device
 *
 * v2 補丁（cwi-notify-v2-20260903，MD §0–§4）：
 * - V-1 Web Push（VAPID）：tab 閂咗／鎖屏都收到 — SW 註冊 + push subscription
 *       （ensurePushSubscription / pushUnsubscribe）+ 統一 show() 出口（SW 優先，
 *       冇 SW 先 new Notification — 手機必須行 SW）。
 * - V-2 節流：**刪除 per-conversation 30 秒**；改**全域音效最小間隔 3 秒**
 *       （純防音疊，唔擋通知）。每條通知照出，靠 tag 同對話互相取代（業界一致：
 *       WhatsApp/Telegram/Slack 都係全域 rate limit，唔係 per-chat 靜音）。
 * - 音效：message/notice/mention → public/chime.wav（2870 correct-answer tone，
 *       原檔照用）；urgent → public/notify-urgent.mp3（保留 — 要同普通聲分得清）。
 *   §4 Android 解鎖：首次 pointerdown 播一次 0 音量 chime 解鎖 audio（失敗靜默）。
 * - push 偏好落 DB（StaffUser.pushPrefs）：mutedClinics/adminMsgClinics 同步
 *   server（syncPushPrefs）— server 推送以 DB 為準；localStorage 只做即時 UI。
 *
 * PII 鐵律：呢個 module 嘅任何字串永遠唔得由 socket payload 帶病人資料入
 * Notification title/body — clinicShort 係營運代碼（TKW），mention body 只係同事名。
 * Push payload 只有 kind/clinicShort/conversationId（server 側，見 src/lib/push.ts）。
 */

export type NotifyKind = "message" | "urgent" | "notice" | "mention" | "assigned" | "sla";

// Chromium 延伸：renotify（取代時仍提示）— 標準 NotificationOptions 冇，擴充類型
// （iOS Safari 忽略；Android/desktop Chrome 支援）
declare global {
  interface NotificationOptions {
    renotify?: boolean;
    /** Chromium 延伸：震動模式（數字/模式陣列）— 手機最重要嘅提示層 */
    vibrate?: number | number[];
  }
}

export interface NotifyPrefs {
  /** OS 桌面通知開關（N-7 斷咗/唔支援時自動降級標題+紅點+badge） */
  desktop: boolean;
  /** 提示音開關 */
  sound: boolean;
  /** 逐店靜音（N-3；multi-clinic 員工先見得到呢組 checkbox）— v2：同步 DB（server push 準） */
  mutedClinics: string[];
  /** ADMIN 逐店 opt-in 收 message/notice（N-2 — 預設唔收，六店會炸）— v2：同步 DB */
  adminMsgClinics: string[];
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  desktop: true,
  sound: true,
  mutedClinics: [],
  adminMsgClinics: [],
};

const PREFS_KEY = "wa_inbox_notify_prefs_v1";
const BANNER_KEY = "wa_inbox_notify_banner_v1";

function cloneDefaults(): NotifyPrefs {
  return { ...DEFAULT_NOTIFY_PREFS, mutedClinics: [], adminMsgClinics: [] };
}

/** N-8：讀 localStorage 開關（per-device）。SSR/損壞 → 預設值。
 *  ★ cwi-realtime-fix §2.2 (client 自我修復，同 server F-3 同一套邏輯)：
 *    muted === adminMsg（非空且完全相同）= 舊 bug 遺留 → muted 當空 + 順手寫返正。 */
export function notifyPrefs(): NotifyPrefs {
  if (typeof window === "undefined") return cloneDefaults();
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return cloneDefaults();
    const p = JSON.parse(raw) as Partial<NotifyPrefs>;
    const desktop = p.desktop !== false;
    const sound = p.sound !== false;
    let mutedClinics = Array.isArray(p.mutedClinics) ? p.mutedClinics.filter((x) => typeof x === "string") : [];
    const adminMsgClinics = Array.isArray(p.adminMsgClinics) ? p.adminMsgClinics.filter((x) => typeof x === "string") : [];
    const same =
      mutedClinics.length > 0 &&
      mutedClinics.length === adminMsgClinics.length &&
      mutedClinics.every((c) => adminMsgClinics.includes(c));
    if (same) {
      // eslint-disable-next-line no-console -- §2.4 自我修復留痕（壞資料 → muted 當空）
      console.warn("[notify] prefs 壞資料（muted === adminMsg）→ mutedClinics 當空");
      mutedClinics = [];
      setNotifyPrefs({ desktop, sound, mutedClinics, adminMsgClinics }); // 順手寫返正（冪等）
    }
    return { desktop, sound, mutedClinics, adminMsgClinics };
  } catch {
    return cloneDefaults();
  }
}

/** N-8：寫 localStorage 開關（per-device）。失敗靜默（private mode 等）。 */
export function setNotifyPrefs(p: NotifyPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

/**
 * v2：push 偏好同步 server（StaffUser.pushPrefs — server 推送以 DB 為準）。
 * desktop/sound 係 per-device UI 設定，唔同步。
 * F-2（cwi-notify-fix-20260907）：一動作一欄 — 只發自己角色嘅欄
 * （STAFF → mutedClinics；ADMIN → adminMsgClinics）— 唔再整包盲寫（server 側有兜底忽略 + warn）。
 * 失敗靜默（server 會用 DB 現值）。
 *
 * ★ cwi-realtime-fix §2.1 註：client 不再 mount 時盲用呢個寫 DB（DB 係單一真相 —
 *   mount 改由 GET 拉 server 覆蓋 localStorage）；只保留做 API（未來 caller 用）。
 */
export function syncPushPrefs(p: NotifyPrefs, role: "ADMIN" | "STAFF"): void {
  if (typeof window === "undefined") return;
  const body =
    role === "ADMIN" ? { adminMsgClinics: p.adminMsgClinics } : { mutedClinics: p.mutedClinics };
  void fetch("/api/push/prefs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {
    /* 靜默 — 下次改動會再同步 */
  });
}

/** 首次登入 banner 有冇攞咗（一次性）。 */
export function notifyBannerDismissed(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(BANNER_KEY) === "1";
  } catch {
    return true;
  }
}

export function dismissNotifyBanner(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(BANNER_KEY, "1");
  } catch {
    /* ignore */
  }
}

/** 請求 OS 通知 permission（唔支援 → "denied"）。 */
export async function ensurePermission(): Promise<NotificationPermission> {
  if (typeof Notification === "undefined") return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

export interface ShouldNotifyArgs {
  kind: NotifyKind;
  clinicId: string;
  conversationId: string;
  /** 對畫而家嘅 assigneeId（client state — message:new payload 唔帶） */
  assigneeId: string | null;
  myStaffId: string;
  myRole: "ADMIN" | "STAFF" | "SUPERVISOR"; // ★ cwi-routing-20260906 §8：通知照 STAFF 規則
  /** 正開住嘅對話 id（N-5） */
  activeConversationId: string | null;
  mutedClinics: string[];
  adminMsgClinics: string[];
}

/**
 * N-2/N-3/N-5 集中判斷（pure — 節流喺 fireNotify）。
 *
 * - N-5：正開住嘅對話 → 靜（列表更新照走，純 UI）
 * - N-3：逐店靜音（mutedClinics）→ 靜
 * - mention：server 已定向推送（只 @ 中嗰個人收）→ 唔再走 assignee 邏輯
 * - ADMIN：預設唔收 message/notice（N-2，六店會炸）— urgent 除外（急症安全網）；
 *   opt-in 咗嘅店（adminMsgClinics）先收 message/notice
 * - STAFF：未指派 → 全店響；已指派 → 只負責人響（N-2）
 */
export function shouldNotify(a: ShouldNotifyArgs): boolean {
  if (a.activeConversationId === a.conversationId) return false; // N-5
  if (a.mutedClinics.includes(a.clinicId)) return false; // N-3
  if (a.kind === "mention") return true; // 定向推送（server 已 filter）
  if (a.kind === "assigned") return true; // cwi-inboxfix-20260905（MD I-4）：指派定向推送（server 已 filter）
  if (a.kind === "sla") return true; // cwi-inboxfix-20260905（MD I-5）：公海 SLA 定向推送（server 已 filter 該店 active STAFF）
  if (a.myRole === "ADMIN") {
    if (a.kind === "urgent") return true; // 七閘/URGENT 語義 — 急症預設全收
    return a.adminMsgClinics.includes(a.clinicId); // N-2 opt-in
  }
  if (a.assigneeId == null) return true; // N-2：未指派 → 全店
  return a.assigneeId === a.myStaffId; // N-2：已指派 → 只負責人
}

// ── V-2 節流（module-level，per tab） ────────────────────────────────────
/** V-2：全域音效最小間隔 — 只擋「聲」，唔擋通知同 badge。
 *  同業界一致（WhatsApp/Telegram/Slack 都係全域 rate limit，唔係 per-chat 靜音）。 */
const GLOBAL_SOUND_GAP_MS = 3_000;
let lastSoundAt = 0;

// ── 音效 ──────────────────────────────────────────────────────────────────
/**
 * message/notice/mention → public/chime.wav（2870 correct-answer tone — 老細指定，
 * 原檔照用唔重編碼）。`<audio preload="auto">` 語義：module 單例，首次用即建。
 * 任何失敗靜默 skip（autoplay policy / 唔支援）。
 */
let chimeAudio: HTMLAudioElement | null = null;
function chimeEl(): HTMLAudioElement | null {
  if (typeof window === "undefined" || typeof Audio === "undefined") return null;
  if (!chimeAudio) {
    chimeAudio = new Audio("/chime.wav");
    chimeAudio.preload = "auto";
  }
  return chimeAudio;
}

/** 統一普通提示音（2870 chime）。kind 留參數俾 API 對齊（三類同音）。 */
export function playChime(_kind?: NotifyKind): void {
  try {
    const el = chimeEl();
    if (!el) return;
    try {
      el.currentTime = 0; // 重播由頭起（metadata 未載會 throw — 兜住）
    } catch {
      /* ignore */
    }
    void el.play().catch(() => {
      /* autoplay policy — 靜默 skip，唔擋流程 */
    });
  } catch {
    /* ignore */
  }
}

// urgent → public/notify-urgent.mp3（0.7s 三聲；保留 — 同 chime.wav 有明顯分別先分得清緊急）
let urgentAudio: HTMLAudioElement | null = null;
export function playUrgentSound(): void {
  try {
    if (typeof window === "undefined" || typeof Audio === "undefined") return;
    if (!urgentAudio) {
      urgentAudio = new Audio("/notify-urgent.mp3");
      urgentAudio.preload = "auto";
    }
    try {
      urgentAudio.currentTime = 0; // 重播由頭起（metadata 未載會 throw — 兜住）
    } catch {
      /* ignore */
    }
    void urgentAudio.play().catch(() => {
      /* autoplay policy — 靜默 skip，唔擋流程 */
    });
  } catch {
    /* ignore */
  }
}

/**
 * V-2：全域音效最小間隔 3 秒（純防音疊）— 靜靜跳過，通知照出。
 * urgent 行第二音（notify-urgent.mp3），其他行 chime.wav。
 * ★ urgent 繞過 3s 間隔（T169 迴歸語義 + 緊急音唔好被前面 message chime 壓 3 秒）；
 *   urgent 響過一樣推 lastSoundAt（之後 3s 內嘅 chime 照會被壓）。
 */
function playIfAllowed(kind: NotifyKind, prefs: NotifyPrefs): void {
  if (!prefs.sound) return;
  const now = Date.now();
  if (kind === "urgent") {
    lastSoundAt = now;
    playUrgentSound();
    return;
  }
  if (now - lastSoundAt < GLOBAL_SOUND_GAP_MS) return; // 靜靜跳過，通知照出
  lastSoundAt = now;
  playChime(kind);
}

/**
 * §4 Android 音效解鎖：Android 唔准未經用戶互動播音 — 首次 pointerdown（一次性）
 * 播一次 0 音量 chime 解鎖 audio element（失敗靜默跳過）。
 * 震動（vibrate）唔受限制，係手機最可靠嘅提示。
 * ★ cwi-realtime-fix §7.2：play() resolve 先計「解鎖」— 未解鎖前 fireNotify 唔試頁面音
 *   （autoplay 政策必擋），改行 SW 系統通知音。
 */
let audioUnlocked = false;
export function isAudioUnlocked(): boolean {
  return audioUnlocked;
}

export function unlockAudio(): void {
  try {
    const el = chimeEl();
    if (!el) return;
    const prev = el.volume;
    el.volume = 0;
    try {
      el.currentTime = 0;
    } catch {
      /* ignore */
    }
    void el.play()
      .then(() => {
        audioUnlocked = true; // 解鎖成功 → 之後頁面 chime 可信
      })
      .catch(() => {
        /* autoplay policy — 靜默 skip */
      });
    window.setTimeout(() => {
      try {
        el.volume = prev;
      } catch {
        /* ignore */
      }
    }, 300);
  } catch {
    /* ignore */
  }
}

// ── 統一通知出口（V-1：SW 優先，桌面手機同一條路） ────────────────────────
/**
 * Android Chrome 唔支援 `new Notification()` — 一定要 `registration.showNotification()`。
 * 有 SW → 行 SW（手機必須；桌面同樣行得；撳通知由 sw.js notificationclick 處理：
 * focus + postMessage open-conversation）；冇 SW 嘅舊環境 → `new Notification`
 * fallback（onclick = focus + caller 跳轉）。
 */
async function show(title: string, opts: NotificationOptions, onClick?: () => void): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      // ★ 用 getRegistration()（未註冊 → 立即 resolve null）— 唔好用 .ready：
      // SW 從未註冊時 .ready 永遠唔 settle → fallback 會被 hang（通知靜默丟失）
      const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
      if (reg) {
        try {
          await reg.showNotification(title, opts);
        } catch {
          /* SW 顯示失敗 → fallback 試 OS 通知 */
          tryShowOsNotification(title, opts, onClick);
        }
        return;
      }
    }
  } catch {
    /* ignore */
  }
  tryShowOsNotification(title, opts, onClick);
}

function tryShowOsNotification(title: string, opts: NotificationOptions, onClick?: () => void): void {
  try {
    const n = new Notification(title, opts);
    if (onClick) {
      n.onclick = () => {
        window.focus();
        onClick();
      };
    }
  } catch {
    /* Notification 構建失敗（mobile / 非 secure context）— 靜默 skip，唔擋流程 */
  }
}

// ── 統一觸發（N-4/N-7 + V-1/V-2） ────────────────────────────────────────
/** N-4 OS 層零 PII 文案：只準 clinic short code（營運元數據）。 */
const TITLE_FN: Record<NotifyKind, (clinicShort: string) => string> = {
  message: (c) => `新訊息 · ${c}`,
  urgent: (c) => `⚠ 緊急 · ${c}`,
  notice: (c) => `通知 · ${c}`,
  mention: () => "WA Inbox @mention",
  // cwi-inboxfix-20260905（MD I-4）：指派 push — title「新指派 · {店簡稱}」+ body「有一條對話指派咗俾你」（零病人資料）
  assigned: (c) => `新指派 · ${c}`,
  // cwi-inboxfix-20260905（MD I-5）：公海 SLA — title「公海 SLA · {店簡稱}」（零 PII：只店 code + 營運元數據）
  sla: (c) => `公海 SLA · ${c}`,
};

export interface FireNotifyArgs {
  kind: NotifyKind;
  /** clinic code（TKW）— 唔准傳病人名/電話/內文 */
  clinicShort: string;
  conversationId: string;
  /** 可選 body（mention/assigned/sla 用：同事名/營運文案 — MD 准保留） */
  body?: string | null;
  /** 撳 OS 通知 → 跳該對話（caller 自己 focus + select） */
  onClick?: () => void;
  prefs: NotifyPrefs;
}

export type FireNotifyResult = "fired" | "no-desktop";

/**
 * V-2 音效（全域 3s 最小間隔 — 純防音疊）→ OS/SW 通知（**每條都出**，
 * tag = conversationId 同對話互相取代，唔會疊爆；N-4 零 PII）。
 *
 * 降級（N-7：prefs.desktop=false 或 permission denied/唔支援）：
 * 聲画唔出，但 (N) 標題 + favicon 紅點 + bell badge 由 inbox-client state 常駐
 * 驅動 — 唔會漏。返回碼供 caller log（唔會 throw）。
 */
export function fireNotify(a: FireNotifyArgs): FireNotifyResult {
  // cwi-realtime-fix §7.2：已解鎖 → 頁面 chime（V-2 全域 3 秒最小間隔）；
  // 未解鎖（頁面零互動）→ 唔好淨係試 playChime()（autoplay 政策必擋）— 靠下面
  // SW 通知路徑嘅系統通知音（唔受 autoplay 限制）；已解鎖 → 兩者都出（雙保險）。
  if (audioUnlocked) playIfAllowed(a.kind, a.prefs);

  const canDesktop =
    a.prefs.desktop && typeof Notification !== "undefined" && Notification.permission === "granted";
  if (canDesktop) {
    const opts: NotificationOptions = {
      body: a.body ?? undefined,
      tag: a.conversationId, // ★ 同一對話互相取代，唔會疊爆
      renotify: true, // 取代時仍然提示
      requireInteraction: a.kind === "urgent", // 緊急唔自動消失
      vibrate: a.kind === "urgent" ? [200, 100, 200] : [120],
      data: { conversationId: a.conversationId },
    };
    // V-2：通知路徑唔加任何節流 — 每條都出（靠 tag 取代）；聲先受 3s 全域間隔
    void show(TITLE_FN[a.kind](a.clinicShort), opts, a.onClick);
  }
  return canDesktop ? "fired" : "no-desktop";
}

// ── V-1 Web Push（VAPID）client 側 ────────────────────────────────────────
/** URL-safe base64 → Uint8Array（pushManager.subscribe applicationServerKey）。 */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

/**
 * V-1：確保有 Web Push subscription（冪等 — endpoint unique，server upsert）。
 * 呼叫點：permission 授予之後 + 每次登入後（inbox-client mount）。
 * 任何失敗 → false（靜默 — 通知照走 socket/SW 常規路徑）。
 */
export async function ensurePushSubscription(): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return false;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
    // 未註冊 → 即時 false（唔等 .ready — 佢喺 SW 从未註冊時永遠唔 settle）
    const reg0 = await navigator.serviceWorker.getRegistration().catch(() => null);
    if (!reg0) return false;
    const reg = await navigator.serviceWorker.ready; // 等 activation 完成
    const existing = await reg.pushManager.getSubscription();
    const sub =
      existing ??
      (await (async () => {
        const r = await fetch("/api/push/vapid-key");
        if (!r.ok) return null;
        const d = (await r.json()) as { publicKey?: string };
        if (!d.publicKey) return null;
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(d.publicKey) as BufferSource,
        });
      })());
    if (!sub) return false;
    const json = sub.toJSON();
    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: json.endpoint,
        keys: json.keys,
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
      }),
    }).catch(() => {
      /* 靜默 — 下次 mount 再試 */
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * §3.6/§5 登出流程：先清 Web Push subscription（共用前台機鐵律 — client 層），
 * server logout route 另有 DB 兜底刪 → POST /api/auth/logout → 跳 /login。
 * NavRail（桌面 avatar menu）同 AccountCard（手機/管理頁）共用。
 */
export async function logoutWithPushCleanup(): Promise<void> {
  try {
    await pushUnsubscribe();
  } catch {
    /* 靜默 — server 兜底 */
  }
  try {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  } catch {
    /* 靜默 */
  }
  window.location.href = "/login";
}

/**
 * §3.6 登出清理：解本地 subscription + 通知 server 刪 DB row
 * （防止換人登入仲收到上一個人嘅通知 — 共用前台機必須做）。
 * 任何失敗靜默（server logout route 另有 DB 兜底刪除）。
 */
export async function pushUnsubscribe(): Promise<void> {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => {});
    await fetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint }),
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}

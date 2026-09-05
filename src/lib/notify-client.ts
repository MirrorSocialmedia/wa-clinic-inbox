/**
 * notify-client — Part B 通知 v1（客人來訊一定要有提示）。
 *
 * 設計決定（MD §Part B B.1/B.2）：
 * - N-1 三觸發：message(IN) 主角 / urgent 急音 / notice 輕音（mention 統一走呢度）
 * - N-2 未指派 → 全店 STAFF 響；已指派 → 只負責人響；ADMIN 預設唔收（可逐店 opt-in）
 * - N-3 多店員工收自己 clinicIds 全部店（socket room 層已保證）；可逐店靜音
 * - N-4 OS 層零 PII：只有「新訊息 · TKW」級文案（mention 嘅同事名可保留）
 * - N-5 正開住嗰個對話 → 唔響唔彈（純列表更新）
 * - N-6 節流：同 conversation 30 秒一次；全域 10 秒最多 3 次音
 * - N-7 降級（permission denied/唔支援）：(N) WA Inbox 標題 + favicon 紅點 + bell badge
 *       （inbox-client state 驅動 — 常駐，唔單止 denied fallback）
 * - N-8 開關存 localStorage per-device
 * - N-9 Tab 閂 = 收唔到（已知限制；PWA + Web Push = v2）
 *
 * PII 鐵律：呢個 module 嘅任何字串永遠唔得由 socket payload 帶病人資料入
 * Notification title/body — clinicShort 係營運代碼（TKW），mention body 只係同事名。
 */

export type NotifyKind = "message" | "urgent" | "notice" | "mention" | "assigned" | "sla";

export interface NotifyPrefs {
  /** OS 桌面通知開關（N-7 斷咗/唔支援時自動降級標題+紅點+badge） */
  desktop: boolean;
  /** 提示音開關 */
  sound: boolean;
  /** 逐店靜音（N-3；multi-clinic 員工先見得到呢組 checkbox） */
  mutedClinics: string[];
  /** ADMIN 逐店 opt-in 收 message/notice（N-2 — 預設唔收，六店會炸） */
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

/** N-8：讀 localStorage 開關（per-device）。SSR/損壞 → 預設值。 */
export function notifyPrefs(): NotifyPrefs {
  if (typeof window === "undefined") return cloneDefaults();
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return cloneDefaults();
    const p = JSON.parse(raw) as Partial<NotifyPrefs>;
    return {
      desktop: p.desktop !== false,
      sound: p.sound !== false,
      mutedClinics: Array.isArray(p.mutedClinics) ? p.mutedClinics.filter((x) => typeof x === "string") : [],
      adminMsgClinics: Array.isArray(p.adminMsgClinics) ? p.adminMsgClinics.filter((x) => typeof x === "string") : [],
    };
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
  myRole: "ADMIN" | "STAFF";
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

// ── N-6 節流（module-level，per tab） ──────────────────────────────────────
const CONV_THROTTLE_MS = 30_000; // 同 conversation 30 秒一次
const GLOBAL_SOUND_WINDOW_MS = 10_000; // 全域 10 秒窗口
const GLOBAL_SOUND_MAX = 3; // 最多 3 次音

const lastConvFire = new Map<string, number>();
const soundTimes: number[] = [];

/** 同 conversation 30 秒內第二條 → true（抑制）。fire 前調用；fire 咗先記。 */
function isThrottled(convId: string, now: number): boolean {
  const last = lastConvFire.get(convId);
  if (last != null && now - last < CONV_THROTTLE_MS) return true;
  lastConvFire.set(convId, now);
  // 邊界：清舊 key（防長期運行無限增）
  if (lastConvFire.size > 1000) {
    for (const [k, t] of lastConvFire) {
      if (now - t >= CONV_THROTTLE_MS) lastConvFire.delete(k);
    }
  }
  return false;
}

/** 全域 10 秒最多 3 次音 — 放過先記時間戳。 */
function isSoundAllowed(now: number): boolean {
  while (soundTimes.length > 0 && now - soundTimes[0] >= GLOBAL_SOUND_WINDOW_MS) soundTimes.shift();
  if (soundTimes.length >= GLOBAL_SOUND_MAX) return false;
  soundTimes.push(now);
  return true;
}

// ── 音效 ──────────────────────────────────────────────────────────────────
// message/notice/mention → 現有 playChime（WebAudio 短 beep；任何失敗靜默 skip）
export function playChime(): void {
  try {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = 0.04;
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
    osc.onended = () => void ctx.close();
  } catch {
    /* ignore */
  }
}

// urgent → public/notify-urgent.mp3（0.7s 三聲；音量同 playChime 一致）
// `<audio preload="auto">` 語義：module 單例，首次用即建 + preload auto。
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

// ── 統一觸發（N-4/N-6/N-7） ────────────────────────────────────────────────
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
  /** 可選 body（只 mention 用：同事名 — MD 准保留） */
  body?: string | null;
  /** 撳 OS 通知 → 跳該對話（caller 自己 focus + select） */
  onClick?: () => void;
  prefs: NotifyPrefs;
}

export type FireNotifyResult = "fired" | "throttled" | "sound-skipped" | "no-desktop";

/**
 * 節流（N-6）→ 音（urgent 第二音 / 其他 playChime）→ OS 通知（N-4 零 PII）。
 *
 * 降級（N-7：prefs.desktop=false 或 permission denied/唔支援）：
 * 聲画唔出，但 (N) 標題 + favicon 紅點 + bell badge 由 inbox-client state 常駐
 * 驅動 — 唔會漏。返回碼供 caller log（唔會 throw）。
 */
export function fireNotify(a: FireNotifyArgs): FireNotifyResult {
  const now = Date.now();
  if (isThrottled(a.conversationId, now)) return "throttled";

  if (a.prefs.sound && isSoundAllowed(now)) {
    if (a.kind === "urgent") playUrgentSound();
    else playChime();
  }

  const canDesktop =
    a.prefs.desktop && typeof Notification !== "undefined" && Notification.permission === "granted";
  if (canDesktop) {
    try {
      const n = new Notification(TITLE_FN[a.kind](a.clinicShort), a.body ? { body: a.body } : undefined);
      if (a.onClick) {
        n.onclick = () => {
          window.focus();
          a.onClick?.();
        };
      }
    } catch {
      /* Notification 構建失敗（mobile / 非 secure context）— 靜默 skip，唔擋流程 */
    }
  }
  return canDesktop ? "fired" : "no-desktop";
}

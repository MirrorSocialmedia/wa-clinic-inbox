/**
 * push.ts — Part B v2（cwi-notify-v2-20260903 MD §3）：Web Push server 側（VAPID）。
 *
 * ★ PII 鐵律：push payload 只有 kind / clinicShort / conversationId，冇病人資料。
 *   push 內容會經 Google/Apple push 伺服器 — 病人名/電話/內文一律唔入 payload
 *   （e2e T190 regex 斷言）。
 *
 * 收件人解析（mirror client shouldNotify 語義 — server 側為準）：
 * - message：未指派 → 全店 active STAFF；已指派 → 只負責人
 * - urgent：同 message（急症安全網 — 未指派全店、已指派負責人）+ 全 active ADMIN
 * - notice（mention/assigned/takeover）：caller 已知 staffId → 直接用 pushToStaff
 * - ADMIN：預設唔收 message（N-2 六店會炸）— 只 pushPrefs.adminMsgClinics 含該店
 *   先收；urgent 預設全收。
 * - 全部 filter pushPrefs.mutedClinics 含該店嘅人（逐店靜音 — DB 為準）。
 *
 * Fire-and-forget：任何失敗只 log，絕唔 throw / 絕唔擋主 pipeline。
 * 404/410 → 刪 subscription row（browser 端已作廢）；2xx → lastOkAt（運維驗證）。
 */
import webpush from "web-push";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import type { Prisma } from "@prisma/client";

export interface PushPayload {
  kind: "message" | "notice" | "urgent";
  clinicShort: string;
  conversationId: string;
}

interface ParsedPrefs {
  mutedClinics: string[];
  adminMsgClinics: string[];
}

// ── F-3（cwi-notify-fix-20260907）：自我修復 warn 去重（per staff 一次 — 防每個事件重複刷 log） ──
const selfHealWarned = new Set<string>();
function noteSelfHeal(staffId: string, count: number): void {
  if (selfHealWarned.has(staffId)) return;
  selfHealWarned.add(staffId);
  if (selfHealWarned.size > 500) selfHealWarned.clear(); // cap（進程級；重啟即清）
  log.warn(
    { staffId, duplicateCount: count },
    "push: 自我修復 — mutedClinics 同 adminMsgClinics 完全相同（舊版盲寫整包污染源）→ muted 當空"
  );
}

// ★ cwi-realtime-fix §2.1：export 畀 GET /api/push/prefs（DB 單一真相 — 同 client 同一套自我修復邏輯）
export function parsePushPrefs(p: Prisma.JsonValue | null | undefined, staffId?: string): ParsedPrefs {
  const d = (p ?? {}) as { mutedClinics?: unknown; adminMsgClinics?: unknown };
  const mutedClinics = Array.isArray(d.mutedClinics) ? d.mutedClinics.filter((x): x is string => typeof x === "string") : [];
  const adminMsgClinics = Array.isArray(d.adminMsgClinics) ? d.adminMsgClinics.filter((x): x is string => typeof x === "string") : [];
  // F-3 自我修復：兩 array 非空且完全相同 = 舊 prefs route 盲寫整包嘅 corruption 特徵
  // → muted 失效（當空）。讀取層自愈 — 舊 DB row 唔使 migration 就恢復正常推送。
  if (
    staffId &&
    mutedClinics.length > 0 &&
    mutedClinics.length === adminMsgClinics.length &&
    mutedClinics.every((c) => adminMsgClinics.includes(c))
  ) {
    noteSelfHeal(staffId, mutedClinics.length);
    return { mutedClinics: [], adminMsgClinics };
  }
  return { mutedClinics, adminMsgClinics };
}

let vapidReady: boolean | null = null; // null = 未試過
function ensureVapid(): boolean {
  if (vapidReady !== null) return vapidReady;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!pub || !priv || !subject) {
    vapidReady = false;
    log.warn("push: VAPID env 未設 — Web Push 停用（socket 通知照行）");
    return false;
  }
  try {
    webpush.setVapidDetails(subject, pub, priv);
    vapidReady = true;
    return true;
  } catch (err) {
    vapidReady = false;
    log.error({ err: err instanceof Error ? err.message : String(err) }, "push: VAPID key 無效");
    return false;
  }
}

/** 定向 push 結果（/api/push/test 用 — 同真通知同一條路；fire-and-forget 版唔暴露呢啲）。 */
export interface PushToStaffResult {
  /** VAPID env 未設（Web Push 停用）→ true 以外嘅結果都係 false */
  vapidReady: boolean;
  /** 該 staff 名下有效 subscription 數（0 = 冇裝置訂閱） */
  subscriptions: number;
  /** 2xx 成功送達數 */
  sent: number;
  /** 失敗原因（非 2xx statusCode / err message；404/410 自動刪 row 後亦計入） */
  failures: string[];
}

/**
 * 定向 push 一個 staff 名下所有 subscription（冪等；staff 唔 active / 無 sub → no-op）。
 * 永不 throw。内部逐 sub 8s timeout（假 endpoint 唔好 hang 成個 push 流程）。
 */
export async function pushToStaff(staffId: string, payload: PushPayload): Promise<void> {
  try {
    if (!ensureVapid()) return;
    await pushToStaffCore(staffId, payload);
  } catch (err) {
    log.warn({ staffId, err: err instanceof Error ? err.message : String(err) }, "push: pushToStaff 失敗（靜默）");
  }
}

/** pushToStaff 結果版（T3 /api/push/test：同一條路行完，回傳逐 sub 結果）。永不 throw。 */
export async function pushToStaffResult(staffId: string, payload: PushPayload): Promise<PushToStaffResult> {
  try {
    if (!ensureVapid()) return { vapidReady: false, subscriptions: 0, sent: 0, failures: [] };
    return await pushToStaffCore(staffId, payload);
  } catch (err) {
    return { vapidReady: true, subscriptions: 0, sent: 0, failures: [err instanceof Error ? err.message : String(err)] };
  }
}

async function pushToStaffCore(staffId: string, payload: PushPayload): Promise<PushToStaffResult> {
  const staff = await prisma.staffUser.findUnique({
    where: { id: staffId },
    select: { active: true, pushSubscriptions: true },
  });
  if (!staff || !staff.active) return { vapidReady: true, subscriptions: 0, sent: 0, failures: [] };
  const subs = staff.pushSubscriptions;
  if (subs.length === 0) return { vapidReady: true, subscriptions: 0, sent: 0, failures: [] };
  const body = JSON.stringify(payload);
  const failures: string[] = [];
  let sent = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        const res = await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
          { TTL: 60, timeout: 8_000 } // ★ 8s timeout：假 endpoint（斷網 GCM 等）唔好 hang 成個 push 流程
        );
        if (res.statusCode === 404 || res.statusCode === 410) {
          // browser 端已取消/過期 — 刪 row
          await prisma.pushSubscription.delete({ where: { endpoint: s.endpoint } }).catch(() => {});
          failures.push(`status ${res.statusCode}（row 已刪）`);
          log.info({ staffId, status: res.statusCode }, "push: subscription 已失效（404/410）— 刪除 row");
        } else if (res.statusCode >= 200 && res.statusCode < 300) {
          sent += 1;
          await prisma.pushSubscription
            .update({ where: { endpoint: s.endpoint }, data: { lastOkAt: new Date() } })
            .catch(() => {});
        } else {
          failures.push(`status ${res.statusCode}`);
          log.warn({ staffId, status: res.statusCode }, "push: 非 2xx（保留 row 下次再試）");
        }
      } catch (err) {
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          await prisma.pushSubscription.delete({ where: { endpoint: s.endpoint } }).catch(() => {});
          failures.push(`status ${status}（row 已刪）`);
          log.info({ staffId, status }, "push: 訂閱已失效（404/410）— 刪除 row");
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          failures.push(msg);
          log.warn({ staffId, err: msg }, "push: 發送失敗");
        }
      }
    })
  );
  return { vapidReady: true, subscriptions: subs.length, sent, failures };
}

/**
 * 店級事件（message/urgent）→ 解析收件人 → push 各人。
 * Fire-and-forget：返回 void，內部吞晒所有錯。
 */
export function pushEvent(e: { kind: "message" | "urgent"; clinicId: string; conversationId: string }): void {
  if (!ensureVapid()) return;
  void (async () => {
    try {
      const [conv, clinic] = await Promise.all([
        prisma.conversation.findUnique({ where: { id: e.conversationId }, select: { assigneeId: true } }),
        prisma.clinic.findUnique({ where: { id: e.clinicId }, select: { code: true } }),
      ]);
      if (!conv || !clinic?.code) return;

      const payload: PushPayload = { kind: e.kind, clinicShort: clinic.code, conversationId: e.conversationId };

      // F-5（cwi-notify-fix）：Map<staffId> 去重 — ADMIN 做 assignee 唔會喺 assignee path
      // 同 ADMIN 循環各入一次（舊碼會 push 兩次）。forced = assignee（F-5 必收，繞過靜音）。
      const targetMap = new Map<string, { prefs: ParsedPrefs; forced: boolean }>();
      const addTarget = (id: string, prefs: ParsedPrefs, forced: boolean): void => {
        const ex = targetMap.get(id);
        if (!ex) targetMap.set(id, { prefs, forced });
        else if (forced) ex.forced = true; // assignee 身份優先（ADMIN assignee 唔会被循環覆蓋）
      };

      // STAFF：已指派 → 只負責人（F-5 forced 必收）；未指派 → 全店 active STAFF
      if (conv.assigneeId) {
        const s = await prisma.staffUser.findUnique({
          where: { id: conv.assigneeId },
          select: { id: true, active: true, pushPrefs: true },
        });
        if (s?.active) addTarget(s.id, parsePushPrefs(s.pushPrefs, s.id), true);
      } else {
        const rows = await prisma.staffUser.findMany({
          where: { role: "STAFF", active: true, clinics: { some: { clinicId: e.clinicId } } },
          select: { id: true, pushPrefs: true },
        });
        for (const r of rows) addTarget(r.id, parsePushPrefs(r.pushPrefs, r.id), false);
      }

      // ADMIN：urgent → 全 active ADMIN（急症安全網 — 唔受 adminMsgClinics 限制）；
      // message → 只 opt-in 咗該店嘅
      const admins = await prisma.staffUser.findMany({
        where: { role: "ADMIN", active: true },
        select: { id: true, pushPrefs: true },
      });
      for (const a of admins) {
        const prefs = parsePushPrefs(a.pushPrefs, a.id);
        const eligible = e.kind === "urgent" ? true : prefs.adminMsgClinics.includes(e.clinicId);
        if (eligible) addTarget(a.id, prefs, false);
      }

      // 逐店靜音（DB 為準）— F-5：assignee forced 繞過靜音（自己跟緊嘅線唔會靜到漏）
      const finalTargets = [...targetMap.entries()].filter(([, t]) => t.forced || !t.prefs.mutedClinics.includes(e.clinicId));
      if (finalTargets.length === 0) {
        // F-4：靜默 return 必留痕 — 根因事故（prefs 濾走全部收件人 → 零通知零 log 查唔到）
        log.warn(
          { kind: e.kind, clinicId: e.clinicId, targetsBefore: targetMap.size, assigneeId: conv.assigneeId ?? null },
          "push: 全部收件人被 prefs 濾走（無推送）"
        );
        return;
      }

      log.info({ kind: e.kind, clinicId: e.clinicId, recipients: finalTargets.length }, "push: 事件 → 收件人解析");
      // ★ 並行：一個 staff 嘅假 endpoint hang 咗唔好阻塞其他 staff（MD 生死格：事件必達）。
      // 每人内部 8s timeout 兜底。
      await Promise.all(finalTargets.map(([id]) => pushToStaff(id, payload)));
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "push: 事件處理失敗（靜默）");
    }
  })();
}

/** F-6（cwi-notify-fix）：/api/push/test 用 — 該 staff 有冇靜音該店（含 F-3 自我修復語義：
 * 兩 array 相同 → muted 當空 → 唔靜）。staff 唔存在 → false。 */
export async function isClinicMutedForStaff(staffId: string, clinicId: string): Promise<boolean> {
  try {
    const s = await prisma.staffUser.findUnique({ where: { id: staffId }, select: { pushPrefs: true } });
    if (!s) return false;
    return parsePushPrefs(s.pushPrefs, staffId).mutedClinics.includes(clinicId);
  } catch {
    return false;
  }
}

/** VAPID public key（client subscribe 用）。未設 → null（route 回 503）。 */
export function vapidPublicKey(): string | null {
  if (!ensureVapid()) return null;
  return process.env.VAPID_PUBLIC_KEY ?? null;
}

/** 登出清理：刪 staff 所有 subscription（共用前台機鐵律 — server 兜底）。 */
export async function deleteSubscriptionsForStaff(staffId: string): Promise<void> {
  try {
    const r = await prisma.pushSubscription.deleteMany({ where: { staffId } });
    if (r.count > 0) log.info({ staffId, count: r.count }, "push: 登出清理 — 刪 subscription");
  } catch (err) {
    log.warn({ staffId, err: err instanceof Error ? err.message : String(err) }, "push: 登出清理失敗（靜默）");
  }
}

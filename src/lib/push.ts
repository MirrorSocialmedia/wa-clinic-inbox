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

function parsePushPrefs(p: Prisma.JsonValue | null | undefined): ParsedPrefs {
  const d = (p ?? {}) as { mutedClinics?: unknown; adminMsgClinics?: unknown };
  return {
    mutedClinics: Array.isArray(d.mutedClinics) ? d.mutedClinics.filter((x): x is string => typeof x === "string") : [],
    adminMsgClinics: Array.isArray(d.adminMsgClinics) ? d.adminMsgClinics.filter((x): x is string => typeof x === "string") : [],
  };
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

/**
 * 定向 push 一個 staff 名下所有 subscription（冪等；staff 唔 active / 無 sub → no-op）。
 * 永不 throw。
 */
export async function pushToStaff(staffId: string, payload: PushPayload): Promise<void> {
  try {
    if (!ensureVapid()) return;
    const staff = await prisma.staffUser.findUnique({
      where: { id: staffId },
      select: { active: true, pushSubscriptions: true },
    });
    if (!staff || !staff.active) return;
    if (staff.pushSubscriptions.length === 0) return;
    const body = JSON.stringify(payload);
    await Promise.all(
      staff.pushSubscriptions.map(async (s) => {
        try {
          const res = await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            body,
            { TTL: 60, timeout: 8_000 } // ★ 8s timeout：假 endpoint（斷網 GCM 等）唔好 hang 成個 push 流程
          );
          if (res.statusCode === 404 || res.statusCode === 410) {
            // browser 端已取消/過期 — 刪 row
            await prisma.pushSubscription.delete({ where: { endpoint: s.endpoint } }).catch(() => {});
            log.info({ staffId, status: res.statusCode }, "push: subscription 已失效（404/410）— 刪除 row");
          } else if (res.statusCode >= 200 && res.statusCode < 300) {
            await prisma.pushSubscription
              .update({ where: { endpoint: s.endpoint }, data: { lastOkAt: new Date() } })
              .catch(() => {});
          } else {
            log.warn({ staffId, status: res.statusCode }, "push: 非 2xx（保留 row 下次再試）");
          }
        } catch (err) {
          const status = (err as { statusCode?: number })?.statusCode;
          if (status === 404 || status === 410) {
            await prisma.pushSubscription.delete({ where: { endpoint: s.endpoint } }).catch(() => {});
            log.info({ staffId, status }, "push: 訂閱已失效（404/410）— 刪除 row");
          } else {
            log.warn({ staffId, err: err instanceof Error ? err.message : String(err) }, "push: 發送失敗");
          }
        }
      })
    );
  } catch (err) {
    log.warn({ staffId, err: err instanceof Error ? err.message : String(err) }, "push: pushToStaff 失敗（靜默）");
  }
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

      // STAFF：已指派 → 只負責人；未指派 → 全店 active STAFF
      let targets: { id: string; prefs: ParsedPrefs }[] = [];
      if (conv.assigneeId) {
        const s = await prisma.staffUser.findUnique({
          where: { id: conv.assigneeId },
          select: { id: true, active: true, pushPrefs: true },
        });
        if (s?.active) targets = [{ id: s.id, prefs: parsePushPrefs(s.pushPrefs) }];
      } else {
        const rows = await prisma.staffUser.findMany({
          where: { role: "STAFF", active: true, clinics: { some: { clinicId: e.clinicId } } },
          select: { id: true, pushPrefs: true },
        });
        targets = rows.map((r) => ({ id: r.id, prefs: parsePushPrefs(r.pushPrefs) }));
      }

      // ADMIN：urgent → 全 active ADMIN；message → 只 opt-in 咗該店嘅
      const admins = await prisma.staffUser.findMany({
        where: { role: "ADMIN", active: true },
        select: { id: true, pushPrefs: true },
      });
      for (const a of admins) {
        const prefs = parsePushPrefs(a.pushPrefs);
        const eligible = e.kind === "urgent" ? true : prefs.adminMsgClinics.includes(e.clinicId);
        if (eligible) targets.push({ id: a.id, prefs });
      }

      // 逐店靜音（DB 為準）
      const finalTargets = targets.filter((t) => !t.prefs.mutedClinics.includes(e.clinicId));
      if (finalTargets.length === 0) return;

      log.info({ kind: e.kind, clinicId: e.clinicId, recipients: finalTargets.length }, "push: 事件 → 收件人解析");
      // ★ 並行：一個 staff 嘅假 endpoint hang 咗唔好阻塞其他 staff（MD 生死格：事件必達）。
      // 每人内部 8s timeout 兜底。
      await Promise.all(finalTargets.map((t) => pushToStaff(t.id, payload)));
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "push: 事件處理失敗（靜默）");
    }
  })();
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

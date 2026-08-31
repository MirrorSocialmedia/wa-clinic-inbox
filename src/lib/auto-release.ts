/**
 * ★ cwi-h6-20260830（h5 §3 / MD §3）：auto-release — 負責人超時未回覆 → 自動放手回隊列。
 *
 * 三條件（shouldAutoRelease，全真先放）：
 *   1. 有未覆訊息 — unreadCount > 0（inbound 才計；打開對話 markRead / 回覆後歸零）
 *   2. 病人等夠 N — now - lastInboundAt ≥ N 分鐘
 *   3. 負責人齋夠 N — now - assigneeLastActionAt ≥ N 分鐘
 *      （assigneeLastActionAt 四寫入點：assign 成功 / 發送成功 / 落內部備註 / 發 Flow；
 *        null = 從未記錄 → 保守處理 = 視為 idle（已 backfill assignedAt 兜底））
 *
 * N = triage.autoReleaseMinutes（per-clinic workflow params，default 15；env 底 AI_AUTO_RELEASE_MINUTES）。
 * cron 每 5 分鐘掃（runAutoReleaseSweep，cron pattern 每 5 分）；release 用 assignConversation(by=AUTO_RELEASE) —
 * 過同一套樂觀鎖 / INTERNAL note 留痕 / audit（meta.by=AUTO_RELEASE）。
 *
 * 放手後：AI 等病人下一句先接力（AI triage 只處理新 inbound — 天然唔追覆舊訊息，h5 §3 原文）。
 *
 * 反循環：每 5 分鐘掃一次；已放手嘅對話 assigneeId=null → 下次掃唔會再命中；
 *          併發 sweep 撞車 → assigneeId 樂觀鎖 409 → 計 failed（冇副作用）。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { assignConversation, AssignError } from "@/lib/assign";
import { getParams } from "@/lib/workflow/store";

/** shouldAutoRelease 純函數入參（E2E / unit 都可直接構造）。 */
export interface AutoReleaseCandidate {
  id: string;
  clinicId: string;
  assigneeId: string;
  /** inbound 未讀數（打開對話 / 回覆後歸零）— 條件 1：有未覆訊息 */
  unreadCount: number;
  /** 病人最近一句 — 條件 2：病人等夠 N */
  lastInboundAt: Date | null;
  /** 負責人最近一次動作 — 條件 3：負責人齋夠 N（null = 視為 idle） */
  assigneeLastActionAt: Date | null;
}

/**
 * 三條件判定（純函數 — unit 測試直接入；now 可注入做 deterministic 測試）。
 * 邊界：「等夠 N」= ≥（剛好 N 分鐘 → 放）。
 */
export function shouldAutoRelease(
  conv: AutoReleaseCandidate,
  autoReleaseMinutes: number,
  now: Date = new Date()
): boolean {
  const nMs = autoReleaseMinutes * 60_000;
  const hasUnanswered = conv.unreadCount > 0;
  const patientWaited =
    conv.lastInboundAt != null && now.getTime() - conv.lastInboundAt.getTime() >= nMs;
  const assigneeIdle =
    conv.assigneeLastActionAt == null ||
    now.getTime() - conv.assigneeLastActionAt.getTime() >= nMs;
  return hasUnanswered && patientWaited && assigneeIdle;
}

/**
 * Sweep（cron `auto-release` 每 5 分鐘調）：掃所有 OPEN + 已 assign 對話 → 逐店取 triage params →
 * 三條件全真 → assignConversation(AUTO_RELEASE)（放手回隊列）。
 * 回傳 { checked, released, failed }（failed = 樂觀鎖 409 / 個別異常 — 下次 sweep 再試）。
 */
export async function runAutoReleaseSweep(
  now: Date = new Date()
): Promise<{ checked: number; released: number; failed: number }> {
  const rows = await prisma.conversation.findMany({
    where: { assigneeId: { not: null }, status: "OPEN" },
    select: {
      id: true,
      clinicId: true,
      assigneeId: true,
      unreadCount: true,
      lastInboundAt: true,
      assigneeLastActionAt: true,
    },
  });

  // where 已過濾 assigneeId 非空 — filter 做 TS 收窄（type guard）
  const candidates = rows.filter((r): r is (typeof r) & { assigneeId: string } => r.assigneeId !== null);

  let checked = 0;
  let released = 0;
  let failed = 0;
  // per-clinic params（getParams 有 in-memory cache — 順帶慳 DB）
  const paramsByClinic = new Map<string, { autoReleaseMinutes: number }>();

  for (const c of candidates) {
    checked++;
    let p = paramsByClinic.get(c.clinicId);
    if (!p) {
      try {
        p = await getParams("triage", c.clinicId);
      } catch (err) {
        log.warn({ clinicId: c.clinicId, err: err instanceof Error ? err.message : String(err) }, "auto-release: triage params 讀唔到 — skip 該店");
        continue;
      }
      paramsByClinic.set(c.clinicId, p);
    }
    if (!shouldAutoRelease(c, p.autoReleaseMinutes, now)) continue;
    try {
      await assignConversation({
        conversationId: c.id,
        toStaffId: null,
        by: "AUTO_RELEASE",
      });
      released++;
      log.info(
        { conversationId: c.id, clinicId: c.clinicId, prevAssigneeId: c.assigneeId, n: p.autoReleaseMinutes },
        "auto-release: 超時未回覆 → 放手回隊列"
      );
    } catch (err) {
      // 併發 sweep / 人手 action 撞車（樂觀鎖 409）→ 下次再試；唔拋（單對話失敗唔阻其他）
      failed++;
      log.warn(
        {
          conversationId: c.id,
          conflict: err instanceof AssignError ? err.code : "unknown",
        },
        "auto-release: release 失敗（併發/異常）— 下次 sweep 再試"
      );
    }
  }

  return { checked, released, failed };
}

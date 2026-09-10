/**
 * ★ cwi-statusrole2-20260910（MD §4）：auto-resolve — 每日 03:00 自動執枱。
 *
 * 守門（三條 + 時序前提，缺一唔關）：
 *   ① 靜音夠 N 日 — lastMessageAt <= now - N（N = triage.autoResolveDays per-clinic，default 3）
 *   ② 病人最後一句已覆 — lastInboundAt != null 且 lastOutboundAt != null 且 lastInboundAt <= lastOutboundAt
 *   ③ 無 SCHEDULED/DUE FollowupTask — ★ 本 repo 無 FollowupTask model（未實施）→ 恒真；
 *      followup 功能落 DB 後喺 shouldAutoResolve 補（MD：「等緊跟進唔好關」；followup MD §4 自帶）。
 *   ④ 無 terminal IS NULL 嘅 ConsultSession — ★ 本 repo 無 ConsultSession model（未實施）→ 恒真；
 *      consult 功能落 DB 後喺 shouldAutoResolve 補（MD C-5：「銷售對話進行中唔好關」）。
 *
 * 時序（MD §4 註）：CONSULT session 48h 無 inbound 會自己 EXPIRED（consult §4.2 #23）→
 *   正常流程 = 48h session 終態 → 第 3 日對話 auto-resolve，兩者唔打架；
 *   守門 ④ 只防「session 仲 active 但對話靜咗 3 日」嘅邊緣情況。
 *
 * 達標 → RESOLVED + resolvedBy="AUTO" + resolvedAt=now + urgent 清（對齊手動 RESOLVED 語義）
 *   + INTERNAL 備註「系統自動標記已解決（{N} 日冇活動）」（零 PII — 只記 N，冇病人內容）
 *   + **唔 push**（MD：唔推通知 — 病人冇新訊息，staff 唔需要被打擾）。
 *
 * 反循環：cron 每日跑；已 RESOLVED 嘅對話下次唔再命中；併發（inbound 同時落）→
 *   updateMany where status=OPEN 命中 0 → skip（冪等，冇副作用）。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { getParams } from "@/lib/workflow/store";

/** shouldAutoResolve 純函數入參（E2E / unit 都可直接構造）。 */
export interface AutoResolveCandidate {
  id: string;
  clinicId: string;
  /** 最後活動（IN/OUT/INTERNAL 任一）— 守門 ①：靜音夠 N 日 */
  lastMessageAt: Date;
  /** 病人最後一句 — 守門 ②（null = 從未有病人訊息 → 唔達標，保守） */
  lastInboundAt: Date | null;
  /** staff/AI 最後覆（SENT）— 守門 ②（null = 從未有覆 → 唔達標，保守） */
  lastOutboundAt: Date | null;
}

/**
 * 守門判定（純函數 — deterministic 測試；now 可注入）。
 * 守門 ③④（followup/consult）本 repo 無 model → 恒真；功能落地後喺呢度加參數（MD 掛鉤點）。
 */
export function shouldAutoResolve(
  conv: AutoResolveCandidate,
  autoResolveDays: number,
  now: Date = new Date()
): boolean {
  const cutoff = now.getTime() - autoResolveDays * 86_400_000;
  // ① 靜音夠 N 日（最後活動早過 cutoff）
  if (conv.lastMessageAt.getTime() > cutoff) return false;
  // ② 病人最後一句已覆（兩者都要有 — null 保守唔關）
  if (conv.lastInboundAt == null || conv.lastOutboundAt == null) return false;
  if (conv.lastInboundAt.getTime() > conv.lastOutboundAt.getTime()) return false;
  // ③ 無 SCHEDULED/DUE FollowupTask — ★ 未實施（model 唔存在）→ 恒真；功能落地後補
  // ④ 無 active（terminal IS NULL）ConsultSession — ★ 未實施（model 唔存在）→ 恒真；功能落地後補
  return true;
}

/**
 * Sweep（cron `auto-resolve` 每日 03:00 調）：掃所有 OPEN 對話 → 逐店取 triage params →
 * 守門全真 → RESOLVED + AUTO 備註（tx 原子；updateMany where OPEN 冪等搶佔）。
 * @param now 可注入（E2E deterministic）
 * @param daysOverride E2E 注入用：覆蓋全部店嘅 N（production scheduler 唔會傳 — 跟 health-check overrides 慣例）
 * 回傳 { checked, resolved, failed }。
 */
export async function runAutoResolveSweep(
  now: Date = new Date(),
  daysOverride?: number
): Promise<{ checked: number; resolved: number; failed: number }> {
  const rows = await prisma.conversation.findMany({
    where: { status: "OPEN" },
    select: {
      id: true,
      clinicId: true,
      lastMessageAt: true,
      lastInboundAt: true,
      lastOutboundAt: true,
    },
  });

  let checked = 0;
  let resolved = 0;
  let failed = 0;
  // per-clinic params（getParams 有 in-memory cache — 順帶慳 DB）
  const paramsByClinic = new Map<string, { autoResolveDays: number }>();

  for (const c of rows) {
    checked++;
    let p = paramsByClinic.get(c.clinicId);
    if (!p) {
      try {
        p = await getParams("triage", c.clinicId);
      } catch (err) {
        log.warn(
          { clinicId: c.clinicId, err: err instanceof Error ? err.message : String(err) },
          "auto-resolve: triage params 讀唔到 — skip 該店"
        );
        continue;
      }
      paramsByClinic.set(c.clinicId, p);
    }
    const n = daysOverride ?? p.autoResolveDays;
    if (!shouldAutoResolve(c, n, now)) continue;

    try {
      // tx 原子：updateMany where OPEN（併發 inbound 先 commit → 命中 0 → skip 唔錯殺）+ INTERNAL 備註
      await prisma.$transaction(async (tx) => {
        const r = await tx.conversation.updateMany({
          where: { id: c.id, status: "OPEN" },
          data: {
            status: "RESOLVED",
            resolvedBy: "AUTO",
            resolvedAt: now,
            urgent: false, // 對齊手動 RESOLVED 語義（急症已處理）
          },
        });
        if (r.count === 0) return; // 併發翻開/人手解決 — 冪等 skip
        await tx.message.create({
          data: {
            conversationId: c.id,
            direction: "OUT",
            channel: "INTERNAL",
            type: "note",
            body: `系統自動標記已解決（${n} 日冇活動）`,
            status: "SENT",
            waMessageId: null, // INTERNAL 永唔出 Graph API
            sentByStaffId: null, // 系統動作（無 staff 參與）
            mentions: [],
            billingCategory: "NONE",
            waTimestamp: now,
          },
        });
        await tx.$executeRaw`UPDATE "Conversation" SET "lastMessageAt" = GREATEST("lastMessageAt", ${now}) WHERE "id" = ${c.id}`;
      });
      resolved++;
      log.info(
        { conversationId: c.id, clinicId: c.clinicId, n },
        "auto-resolve: 規則達標 → RESOLVED（AUTO + 備註，唔 push）"
      );
    } catch (err) {
      failed++;
      log.warn(
        { conversationId: c.id, err: err instanceof Error ? err.message : String(err) },
        "auto-resolve: 個別失敗 — 下次 sweep 再試"
      );
    }
  }

  return { checked, resolved, failed };
}

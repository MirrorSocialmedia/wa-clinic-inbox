/**
 * ★ cwi-inboxfix-20260905（MD §1.4 / I-5）：公海 SLA 提醒（unassigned-sla）。
 *
 * cron 每 5 分鐘掃（job: unassigned-sla，5 分間隔 pattern）：
 *   揀：assigneeId=null AND status != RESOLVED AND lastInboundAt <= now - N 分鐘
 *       AND slaNotifiedAt IS NULL（新 nullable 欄 — 防重複洗版）
 *   → 該 clinic 全部 active STAFF push「{店簡稱} 有病人未有人跟（{N} 分鐘）」
 *     （clinic room 廣播 — connect 時 isStaffActive 已擋停用帳號；+ StaffNotice 持久化）
 *   → 標 slaNotifiedAt = now
 *   被接手時清返 slaNotifiedAt = null（assign.ts — 指派成功嗰度）。
 *
 * N = triage.unassignedSlaMinutes（per-clinic workflow params，default 10，min 3 max 120）。
 *
 * 同 auto-release 係一對：auto-release 放手令對話跌返公海，SLA 提醒確保真係有人望到。
 *
 * 防重複語義（MD 註意）：
 *   - slaNotifiedAt 只在「被接手」時清 → 同一段 unassigned 期最多洗一次版；
 *   - release 唔清旗 → 放手回公海嘅對話唔會即刻再洗（要再被接手先重新計期）；
 *   - 已 RESOLVED / 已有 assignee 嘅對話永遠唔入 scope。
 *
 * 反循環：每 5 分鐘掃；標咗 slaNotifiedAt 嘅對話下次掃唔會再命中；冪等可空跑。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { getParams } from "@/lib/workflow/store";
import { publishNotify } from "@/lib/notify";

/** sweep 結果（now 可注入 — e2e/unit deterministic）。 */
export interface UnassignedSlaResult {
  /** 入 scope（DB 預篩後）嘅對話數 */
  checked: number;
  /** 達標並標記 slaNotifiedAt 嘅對話數 */
  notified: number;
  /** 有通知嘅 clinic 數 */
  clinicsNotified: number;
  /** 覆蓋到嘅 active STAFF 數（該店 StaffClinic 綁定 + active） */
  staffNotified: number;
  /** 個別 clinic 讀 params / 通知失敗數（skip 該店，下次再試） */
  failed: number;
}

export async function runUnassignedSlaSweep(
  now: Date = new Date()
): Promise<UnassignedSlaResult> {
  // 全局底線預篩：N 最小值 = 3 分鐘（zod min）— lastInboundAt 舊過 3 分鐘先值得逐店核
  const floorCutoff = new Date(now.getTime() - 3 * 60_000);
  const rows = await prisma.conversation.findMany({
    where: {
      assigneeId: null,
      status: { not: "RESOLVED" },
      slaNotifiedAt: null,
      lastInboundAt: { not: null, lte: floorCutoff },
    },
    select: { id: true, clinicId: true, lastInboundAt: true },
  });

  const checked = rows.length;
  let notified = 0;
  let clinicsNotified = 0;
  let staffNotified = 0;
  let failed = 0;

  const byClinic = new Map<string, { id: string; lastInboundAt: Date | null }[]>();
  for (const r of rows) {
    const arr = byClinic.get(r.clinicId) ?? [];
    arr.push(r);
    byClinic.set(r.clinicId, arr);
  }

  const clinicRows = await prisma.clinic.findMany({
    where: { id: { in: [...byClinic.keys()] } },
    select: { id: true, code: true },
  });
  const codeByClinic = new Map(clinicRows.map((c) => [c.id, c.code]));

  for (const [clinicId, convs] of byClinic) {
    let n: number;
    try {
      const p = await getParams("triage", clinicId);
      n = p.unassignedSlaMinutes;
    } catch (err) {
      failed++;
      log.warn(
        { clinicId, err: err instanceof Error ? err.message : String(err) },
        "unassigned-sla: triage params 讀唔到 — skip 該店"
      );
      continue;
    }
    const nMs = n * 60_000;
    const due = convs.filter(
      (c) => c.lastInboundAt != null && now.getTime() - c.lastInboundAt.getTime() >= nMs
    );
    if (due.length === 0) continue;

    const code = codeByClinic.get(clinicId) ?? "?";
    const title = `${code} 有病人未有人跟（${n} 分鐘）`;
    try {
      // 持久化 StaffNotice（clinic 級 — 離線員工返嚟 bell 都睇到；零病人資料）
      await prisma.staffNotice.create({
        data: {
          clinicId,
          conversationId: null,
          kind: "SYSTEM",
          title,
          meta: { reason: "unassigned-sla", count: due.length, minutes: n },
        },
      });
      // clinic room 廣播 → 全店 active STAFF（connect 時已驗 active）
      // payload 零病人資料；conversationId=null = clinic 級通知（client bell 照 refetch）
      publishNotify(clinicId, "notice:new", {
        conversationId: null,
        kind: "SYSTEM",
        reason: "unassigned-sla",
        title,
        count: due.length,
      });
      // 標記防重複（單店一次性 updateMany；slaNotifiedAt=null 條件防併發雙洗）
      await prisma.conversation.updateMany({
        where: { id: { in: due.map((d) => d.id) }, slaNotifiedAt: null },
        data: { slaNotifiedAt: now },
      });
      // 覆蓋 staff 數（active 綁定 — 只計 staff reach，唔逐一推送）
      const activeStaff = await prisma.staffClinic.count({
        where: { clinicId, staff: { active: true } },
      });
      notified += due.length;
      clinicsNotified++;
      staffNotified += activeStaff;
      log.info(
        { clinicId, count: due.length, n, activeStaff },
        "unassigned-sla: 公海超時提醒已發"
      );
    } catch (err) {
      failed++;
      log.warn(
        { clinicId, err: err instanceof Error ? err.message : String(err) },
        "unassigned-sla: 通知失敗 — 該店下次 sweep 再試"
      );
    }
  }

  return { checked, notified, clinicsNotified, staffNotified, failed };
}

/**
 * ★ cwi-routing-20260906（§3）：投訴兩級升級 sweep（cron `routing-escalate` 每 5 分鐘）。
 *
 * 兩級語義（MD §3）：
 *   第一級 = 規則命中 → 標記 + 通知技能組（ai.worker 同步路徑，T2）；
 *   第二級 = N 分鐘冇人接手（assigneeId 仍 null）→ 通知升級組（出廠 = 主管組 SUPV）+ 標 escalatedAt。
 *
 * 鐵律：
 * - **只升一次**：escalatedAt != null → 永遠唔再升（第二級之後冇第三級 — MD §3）。
 * - 15 分鐘內有人接手（assigneeId != null）→ 唔升（接手勝過升級）。
 * - N 分鐘係**規則參數**（RoutingRule.escalateAfterMin，出廠 15）— 唔係全局硬編碼。
 * - 原子 claim：`updateMany({ id, escalatedAt: null, assigneeId: null } → escalatedAt=now,
 *   routedGroupId=升級組, routedStaffId=null)` count===1 先至發通知（冪等防重複）。
 *   ★ cwi-auditfix-20260908（B-2）：claim 同時把路由指向升級組 — 否則第二級組成員
 *   「派俾我」（routedGroupId ∈ 我組）搵唔到該對話。原組留 audit meta（fromGroupId）。
 * - 升級組無 active 成員（或唔服務該店）→ skip 唔 claim（下轮重試）。
 * - 零 PII：StaffNotice title / socket payload / push payload / audit meta 全部 metadata only。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { Prisma } from "@prisma/client";
import { publishNotify } from "@/lib/notify";
import { pushRoutingEvent } from "@/lib/push";

export interface EscalateSweepResult {
  /** 候選數（routed 到升級規則 + 未升級 + 未接手 + 未 RESOLVED） */
  checked: number;
  /** 已達時限且升級成功（claim + 通知）數 */
  escalated: number;
  /** 升級組無 active 成員 → skip（唔 claim，下輪重試）數 */
  skippedNoMembers: number;
  /** 單條對話處理失敗數（fail-soft，唔阻其他） */
  failed: number;
}

export async function runRoutingEscalateSweep(): Promise<EscalateSweepResult> {
  const out: EscalateSweepResult = { checked: 0, escalated: 0, skippedNoMembers: 0, failed: 0 };
  const now = new Date();

  // 1. 有升級設定嘅規則（escalateAfterMin + escalateToGroupId 都有）
  const escRules = await prisma.routingRule.findMany({
    where: { enabled: true, escalateAfterMin: { not: null }, escalateToGroupId: { not: null } },
    select: { id: true, escalateAfterMin: true, escalateToGroupId: true },
  });
  if (escRules.length === 0) return out;
  const ruleMap = new Map(escRules.map((r) => [r.id as string, r]));

  // 2. 候選對話（routedRuleId 係 bare string — 手動 join）
  const convs = await prisma.conversation.findMany({
    where: {
      routedRuleId: { in: [...ruleMap.keys()] },
      escalatedAt: null,
      assigneeId: null,
      status: { not: "RESOLVED" },
    },
    select: { id: true, clinicId: true, routedRuleId: true, routedAt: true, routedGroupId: true },
  });
  out.checked = convs.length;

  for (const c of convs) {
    const ruleId = c.routedRuleId as string | null;
    const rule = ruleId ? ruleMap.get(ruleId) : undefined;
    if (!rule || !c.routedAt) continue;
    const waitedMin = (now.getTime() - c.routedAt.getTime()) / 60_000;
    if (waitedMin < (rule.escalateAfterMin as number)) continue; // 未達時限

    try {
      // 3. 升級組成員（active + 服務該店 — R-4 同 T2 一致）
      const group = await prisma.skillGroup.findUnique({
        where: { id: rule.escalateToGroupId as string },
        select: { id: true, name: true, enabled: true },
      });
      let members: { id: string }[] = [];
      if (group && group.enabled) {
        const served = await prisma.skillGroupClinic.count({ where: { groupId: group.id, clinicId: c.clinicId } });
        if (served > 0) {
          const memberIds = (
            await prisma.skillGroupMember.findMany({ where: { groupId: group.id }, select: { staffId: true } })
          ).map((m) => m.staffId);
          members = await prisma.staffUser.findMany({ where: { id: { in: memberIds }, active: true }, select: { id: true } });
        }
      }
      if (group && group.enabled && members.length === 0) {
        out.skippedNoMembers++;
        log.warn({ conversationId: c.id, toGroupId: group.id }, "routing: escalate skipped — 升級組無 active 成員（下輪重試）");
        continue;
      }
      if (!group || !group.enabled) {
        out.skippedNoMembers++;
        log.warn({ conversationId: c.id, toGroupId: rule.escalateToGroupId }, "routing: escalate skipped — 升級組唔存在/停用");
        continue;
      }

      // 4. 原子 claim（先 claim 後通知 — 冪等防重複）
      // ★ cwi-auditfix-20260908（B-2）：同時把路由指向升級組（第二級「派俾我」搵得到）；
      //   routedStaffId 清 null（第一級當值標記唔再適用 — 升級 = 組級接手）。
      const fromGroupId = c.routedGroupId;
      const claimed = await prisma.conversation.updateMany({
        where: { id: c.id, escalatedAt: null, assigneeId: null },
        data: { escalatedAt: now, routedGroupId: group.id, routedStaffId: null },
      });
      if (claimed.count === 0) continue; // 輸咗 race（已升級 / 有人接手咗）

      // 5. 通知（StaffNotice + socket + web push → 全組）
      const clinic = await prisma.clinic.findUnique({ where: { id: c.clinicId }, select: { code: true } });
      const title = `升級 · ${group.name} · ${clinic?.code ?? ""}`;
      await prisma.staffNotice.create({
        data: {
          clinicId: c.clinicId,
          conversationId: c.id,
          kind: "ROUTING_ESCALATION",
          title,
          meta: { ruleId, fromGroupId, toGroupId: group.id, waitedMin: Math.round(waitedMin) } as Prisma.InputJsonValue,
        },
      });
      // commit-then-emit（鐵律 — 通知 commit 咗先 publish）
      // ★ cwi-auditfix-20260908（M-1）：payload 補 escalatedAt — client patch 行用（零 PII metadata）
      publishNotify(c.clinicId, "routing:escalation", {
        conversationId: c.id,
        ruleId,
        fromGroupId,
        toGroupId: group.id,
        groupName: group.name,
        escalatedAt: now.toISOString(),
      });
      pushRoutingEvent({ clinicId: c.clinicId, conversationId: c.id, staffIds: members.map((m) => m.id), escalated: true });

      // 5b. INTERNAL 備註（系統 — 零 PII metadata only；接手人睇到升級原因）
      await prisma.message.create({
        data: {
          conversationId: c.id,
          direction: "OUT",
          channel: "INTERNAL",
          type: "note",
          body: `[Routing] 路由 ${Math.round(waitedMin)} 分鐘無人接手 — 已升級「${group.name}」組`,
          status: "SENT",
          waMessageId: null, // INTERNAL 永唔出 Graph API
          sentByStaffId: null, // 系統備註
          mentions: [],
          billingCategory: "NONE",
          waTimestamp: now,
        },
      });

      // 6. audit（零 PII metadata only）
      await prisma.auditLog.create({
        data: {
          staffId: null,
          action: "ROUTING_ESCALATED",
          entity: "Conversation",
          entityId: c.id,
          meta: { ruleId, fromGroupId, toGroupId: group.id, waitedMin: Math.round(waitedMin) } as Prisma.InputJsonValue,
        },
      });

      out.escalated++;
      log.info(
        { conversationId: c.id, clinicId: c.clinicId, ruleId, toGroupId: group.id, waitedMin: Math.round(waitedMin) },
        "routing: escalated（兩級第二級，只此一次）"
      );
    } catch (err) {
      out.failed++;
      log.warn(
        { err: err instanceof Error ? err.message : String(err), conversationId: c.id },
        "routing: escalate failed（單條 fail-soft，唔阻其他）"
      );
    }
  }

  return out;
}

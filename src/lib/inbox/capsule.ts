/**
 * ★ cwi-final S1-2（L-3）：膠囊 predicate — client 同 server 共用嘅單一來源。
 *
 * 計數不變式（MD §2 / I-2）：膠囊數字 === 列表 row 數 — 要成立，
 * server counts（loadCounts）/ server list（assigned= filter）/ client filter
 * 三處必須用同一個 predicate — 就係呢度。
 *
 * ★ S2-3 口徑：followup（待跟進）唔排除 RESOLVED（有 SUGGESTED 建議嘅已解決對話
 * 都計 — 跟進回覆可以令佢復活）；list 同 count 同一 predicate → 不變式照成立。
 */

export type CapsuleKey = "all" | "unassigned" | "mine" | "routed" | "followup";

export const CAPSULE_KEYS: readonly CapsuleKey[] = ["all", "unassigned", "mine", "routed", "followup"];

export interface CapsuleCtx {
  meId: string;
  myGroupIds: string[];
  /** null = 全店（ALL scope / SUPERVISOR） */
  scopeClinicIds: string[] | null;
  /** 現行 clinic tab（"all" = 全部） */
  activeClinicId: string | "all";
}

/** predicate 需要嘅最小 row 形狀（API item / Prisma row 都 match） */
export interface CapsuleRow {
  id: string;
  clinicId: string;
  assigneeId: string | null;
  // ★ cwi-final S1-2：client ConversationItem 呢兩欄係 optional（`?: string | null`）— 接受 undefined
  routedStaffId?: string | null;
  routedGroupId?: string | null;
  /** 最舊未處理 SUGGESTED 建議 dueAt（ISO）— 冇 = null/undefined */
  followupDueAt?: string | null;
}

export function matchCapsule(
  key: CapsuleKey,
  c: CapsuleRow,
  x: CapsuleCtx,
  followupIds?: Set<string> | null,
): boolean {
  // 公海（unassigned）永遠唔含外店線（I-2 鐵律）— clinic 維度雙保險
  // （server scope 已限；client 端 activeClinicId tab 收窄同步）
  const inClinic =
    x.activeClinicId !== "all"
      ? c.clinicId === x.activeClinicId
      : x.scopeClinicIds === null || x.scopeClinicIds.includes(c.clinicId);
  switch (key) {
    case "all":
      return true;
    case "unassigned":
      return c.assigneeId == null && inClinic;
    case "mine":
      return c.assigneeId === x.meId;
    case "routed":
      // 「派俾我」= 未指派 且（routedStaffId=我 ∨ routedGroupId∈我組）
      return (
        c.assigneeId == null &&
        (c.routedStaffId === x.meId || (c.routedGroupId != null && x.myGroupIds.includes(c.routedGroupId)))
      );
    case "followup":
      // ★ S2-3：有 SUGGESTED 建議（server 傳 followupIds = 同一 loadFollowupDue 集合）；
      // 冇 server 集合（client 純本機）先 fallback followupDueAt 欄。
      return followupIds ? followupIds.has(c.id) : c.followupDueAt != null;
  }
}

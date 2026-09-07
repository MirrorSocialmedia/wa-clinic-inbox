import prisma from "@/lib/prisma";

/**
 * ★ cwi-routing-20260906（MD §4.2）：路由規則 API 共用校驗（admin 管理頁 + reorder 同源）。
 *
 * 語義（同 engine matchRule 對齊）：
 * - intents / keywords 空 = 唔限；patientType null = 唔限（NEW | RETURNING）
 * - targetType: GROUP（要 targetGroupId）/ STAFF（要 targetStaffId）/ CLINIC_POOL（兩者都 null）
 * - escalateAfterMin 同 escalateToGroupId 要麼一齊有、要麼一齊無（升級兩件套）
 */

export const ROUTE_INTENTS = ["BOOKING_REQUEST", "QUESTION", "URGENT_PAIN", "COMPLAINT", "OUT_OF_SCOPE", "OTHER"] as const;
export const ROUTE_PATIENT_TYPES = ["NEW", "RETURNING"] as const;
export const ROUTE_TARGET_TYPES = ["GROUP", "STAFF", "CLINIC_POOL"] as const;

export interface RuleInput {
  name: string;
  clinicId: string | null;
  priority: number;
  enabled: boolean;
  intents: string[];
  keywords: string[];
  patientType: string | null;
  targetType: "GROUP" | "STAFF" | "CLINIC_POOL";
  targetGroupId: string | null;
  targetStaffId: string | null;
  autoReplyTemplate: string | null;
  escalateAfterMin: number | null;
  escalateToGroupId: string | null;
}

/** 校驗 raw body → RuleInput；失敗返 [error message, null]。partial=true 時允許只送部分欄（PATCH）。 */
export function validateRuleBody(
  raw: Record<string, unknown>,
  opts: { partial?: boolean; current?: Partial<RuleInput> } = {}
): [string | null, RuleInput | null] {
  const base: RuleInput = {
    name: opts.current?.name ?? "",
    clinicId: opts.current?.clinicId ?? null,
    priority: opts.current?.priority ?? 50,
    enabled: opts.current?.enabled ?? true,
    intents: opts.current?.intents ?? [],
    keywords: opts.current?.keywords ?? [],
    patientType: opts.current?.patientType ?? null,
    targetType: opts.current?.targetType ?? "CLINIC_POOL",
    targetGroupId: opts.current?.targetGroupId ?? null,
    targetStaffId: opts.current?.targetStaffId ?? null,
    autoReplyTemplate: opts.current?.autoReplyTemplate ?? null,
    escalateAfterMin: opts.current?.escalateAfterMin ?? null,
    escalateToGroupId: opts.current?.escalateToGroupId ?? null,
  };
  const set = (k: keyof RuleInput) => raw[k] !== undefined;

  if (!opts.partial) {
    // create：必要欄齊
    if (!set("name") || !set("priority") || !set("targetType")) {
      return ["missing fields: name, priority, targetType", null];
    }
  }
  if (set("name")) {
    if (typeof raw.name !== "string" || raw.name.trim().length === 0 || raw.name.trim().length > 40) {
      return ["name must be 1-40 chars", null];
    }
    base.name = (raw.name as string).trim();
  }
  if (set("clinicId")) {
    if (raw.clinicId !== null && typeof raw.clinicId !== "string") return ["clinicId must be string|null", null];
    base.clinicId = raw.clinicId as string | null;
  }
  if (set("priority")) {
    if (typeof raw.priority !== "number" || !Number.isInteger(raw.priority) || raw.priority < 1 || raw.priority > 10000) {
      return ["priority must be int 1-10000", null];
    }
    base.priority = raw.priority;
  }
  if (set("enabled")) {
    if (typeof raw.enabled !== "boolean") return ["enabled must be boolean", null];
    base.enabled = raw.enabled;
  }
  if (set("intents")) {
    if (!Array.isArray(raw.intents) || !raw.intents.every((x) => typeof x === "string" && ROUTE_INTENTS.includes(x as (typeof ROUTE_INTENTS)[number]))) {
      return ["intents must be subset of " + ROUTE_INTENTS.join("|"), null];
    }
    base.intents = [...new Set(raw.intents as string[])];
  }
  if (set("keywords")) {
    if (!Array.isArray(raw.keywords) || !raw.keywords.every((x) => typeof x === "string" && x.trim().length > 0) || raw.keywords.length > 30) {
      return ["keywords must be string[] (≤30, 非空字串)", null];
    }
    base.keywords = [...new Set(raw.keywords.map((x: string) => x.trim()))];
  }
  if (set("patientType")) {
    if (raw.patientType !== null && !ROUTE_PATIENT_TYPES.includes(raw.patientType as (typeof ROUTE_PATIENT_TYPES)[number])) {
      return ["patientType must be null|NEW|RETURNING", null];
    }
    base.patientType = raw.patientType as string | null;
  }
  if (set("targetType")) {
    if (!ROUTE_TARGET_TYPES.includes(raw.targetType as (typeof ROUTE_TARGET_TYPES)[number])) {
      return ["targetType must be GROUP|STAFF|CLINIC_POOL", null];
    }
    base.targetType = raw.targetType as RuleInput["targetType"];
  }
  if (set("targetGroupId")) {
    if (raw.targetGroupId !== null && typeof raw.targetGroupId !== "string") return ["targetGroupId must be string|null", null];
    base.targetGroupId = raw.targetGroupId as string | null;
  }
  if (set("targetStaffId")) {
    if (raw.targetStaffId !== null && typeof raw.targetStaffId !== "string") return ["targetStaffId must be string|null", null];
    base.targetStaffId = raw.targetStaffId as string | null;
  }
  if (set("autoReplyTemplate")) {
    if (raw.autoReplyTemplate !== null && (typeof raw.autoReplyTemplate !== "string" || raw.autoReplyTemplate.length > 2000)) {
      return ["autoReplyTemplate must be null or string ≤2000", null];
    }
    base.autoReplyTemplate = raw.autoReplyTemplate as string | null;
  }
  if (set("escalateAfterMin")) {
    if (raw.escalateAfterMin !== null && (typeof raw.escalateAfterMin !== "number" || raw.escalateAfterMin < 1 || raw.escalateAfterMin > 1440)) {
      return ["escalateAfterMin must be null or 1-1440", null];
    }
    base.escalateAfterMin = raw.escalateAfterMin as number | null;
  }
  if (set("escalateToGroupId")) {
    if (raw.escalateToGroupId !== null && typeof raw.escalateToGroupId !== "string") return ["escalateToGroupId must be string|null", null];
    base.escalateToGroupId = raw.escalateToGroupId as string | null;
  }

  // 目標一致性
  if (base.targetType === "GROUP" && !base.targetGroupId) return ["targetType GROUP 要 targetGroupId", null];
  if (base.targetType === "STAFF" && !base.targetStaffId) return ["targetType STAFF 要 targetStaffId", null];
  if (base.targetType === "CLINIC_POOL" && (base.targetGroupId || base.targetStaffId)) {
    return ["targetType CLINIC_POOL 唔可以帶 targetGroupId/targetStaffId", null];
  }
  // 升級兩件套：一齊有或一齊無
  const hasMin = (base.escalateAfterMin ?? null) !== null;
  const hasGroup = (base.escalateToGroupId ?? null) !== null;
  if (hasMin !== hasGroup) {
    return ["escalateAfterMin 同 escalateToGroupId 要一齊設或一齊留空", null];
  }

  return [null, base];
}

/** 目標引用存在性（GROUP 組存在 / STAFF staff 存在）— 落庫前擋死引用。 */
export async function assertTargetsExist(r: RuleInput): Promise<string | null> {
  if (r.targetGroupId) {
    const g = await prisma.skillGroup.findUnique({ where: { id: r.targetGroupId }, select: { id: true } });
    if (!g) return "targetGroupId 不存在";
  }
  if (r.targetStaffId) {
    const s = await prisma.staffUser.findUnique({ where: { id: r.targetStaffId }, select: { id: true } });
    if (!s) return "targetStaffId 不存在";
  }
  if (r.escalateToGroupId) {
    const g = await prisma.skillGroup.findUnique({ where: { id: r.escalateToGroupId }, select: { id: true } });
    if (!g) return "escalateToGroupId 不存在";
  }
  return null;
}

/** 重排：orderedIds 順序 → priority = (i+1)*10（限同一 clinicId 域）。 */
export async function reorderRules(clinicId: string | null, orderedIds: string[]): Promise<void> {
  await prisma.$transaction(
    orderedIds.map((id, i) =>
      prisma.routingRule.update({
        where: { id },
        data: { priority: (i + 1) * 10 },
      })
    )
  );
  void clinicId; // 同域校驗喺 route 層做（orderedIds 必須 = 該域全部規則 id）
}

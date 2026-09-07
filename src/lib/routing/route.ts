/**
 * ★ cwi-routing-20260906（§2/§3）：規則式路由 — 標記 + 通知，**唔真指派**（R-2 鐵律）。
 *
 * 鐵律：
 * - R-2：只寫 Conversation.routed*（標記欄），**唔掂 assigneeId / assignVersion / assignedAt** —
 *   對話仍然「未指派」：公海照見、任何人接手得、Send Lock 唔生效。
 * - R-8：急症（URGENT_PAIN / HIGH）嘅全店 urgent:escalation 廣播係 ai.worker 現有路徑 —
 *   本模組**唔介入**佢（唔取代、唔收窄）；路由命中只額外加組標記 + 組通知。
 * - R-4：組明確指定服務店 — 組唔服務該店 / 冇該店 active 成員 → 唔標記（落預設公海）。
 * - R-9：GROUP 目標查當值 roster（staffName 匹配 + 時間落喺 shift 內）：
 *   恰一個當值成員 → routedStaffId = 佢；零個/多個 → 只標 routedGroupId。**兩種情況都通知全組**。
 * - 零 PII：StaffNotice title / socket payload / push payload / audit meta 全部 metadata only
 *   （ruleId / groupId / staffId / wamid / intent — 冇病人姓名/訊息原文）。
 * - fail-soft：任何失敗 log.warn + 當冇命中（唔阻 AI pipeline）。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { Prisma } from "@prisma/client";
import { applyLexicon, type LexiconEntry } from "@/lib/sessions/lexicon";
import { fetchDutyRoster, hkToday } from "@/lib/duty/client";
import { phoneHash } from "@/lib/phone-hash";
import { lookupPatient } from "@/lib/workforce/client";
import { publishNotify } from "@/lib/notify";
import { pushRoutingEvent } from "@/lib/push";

export interface RouteRule {
  id: string;
  clinicId: string | null;
  name: string;
  priority: number;
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

export interface MatchCtx {
  intent: string;
  /** lexicon canonical 後嘅訊息文字（引擎外算好 — 避免重複 fetch 詞表） */
  textCanonical: string;
  patientType: "NEW" | "RETURNING" | null;
}

/**
 * Pure：priority 細數行先，首個「全條件命中」即回（MD §2 — T251 斷言點）。
 * 條件：intents 空 = 唔限；keywords 空 = 唔限（任一 canonical 命中）；patientType 空 = 唔限。
 */
export function matchRule(rules: RouteRule[], ctx: MatchCtx): RouteRule | null {
  const sorted = [...rules].sort((a, b) => a.priority - b.priority);
  for (const r of sorted) {
    if (r.intents.length > 0 && !r.intents.includes(ctx.intent)) continue;
    if (r.keywords.length > 0 && !r.keywords.some((k) => k.length > 0 && ctx.textCanonical.includes(k))) continue;
    if (r.patientType && ctx.patientType !== r.patientType) continue;
    return r;
  }
  return null;
}

/**
 * 規則解析（MD §2）：該店規則 ∪ 全局規則（clinicId=null）；
 * 該店規則同全局**同名或同 priority** → 全局嗰條被覆寫（剔除）。enabled=false 唔行。
 */
export async function resolveEffectiveRules(clinicId: string): Promise<RouteRule[]> {
  const rows = await prisma.routingRule.findMany({
    where: { enabled: true, OR: [{ clinicId: null }, { clinicId }] },
    select: {
      id: true,
      clinicId: true,
      name: true,
      priority: true,
      intents: true,
      keywords: true,
      patientType: true,
      targetType: true,
      targetGroupId: true,
      targetStaffId: true,
      autoReplyTemplate: true,
      escalateAfterMin: true,
      escalateToGroupId: true,
    },
  });
  const globalRules = rows.filter((r) => r.clinicId === null);
  const clinicRules = rows.filter((r) => r.clinicId !== null);
  const shadowed = new Set(clinicRules.flatMap((r) => [r.name, String(r.priority)]));
  const keptGlobal = globalRules.filter((r) => !shadowed.has(r.name) && !shadowed.has(String(r.priority)));
  return [...keptGlobal, ...clinicRules];
}

// ── patientType（靠 patient-lookup；查唔到當 NEW；10 分鐘 in-memory cache 防每條訊息打 workforce）──
const patientTypeCache = new Map<string, { at: number; returning: boolean }>();
const PATIENT_TTL_MS = 10 * 60_000;

export async function resolvePatientType(args: {
  pinnedPatientApricotId: string | null;
  waId: string | null;
}): Promise<"NEW" | "RETURNING"> {
  if (args.pinnedPatientApricotId) return "RETURNING"; // 已釘住舊客
  if (!args.waId) return "NEW";
  const key = phoneHash(args.waId);
  const hit = patientTypeCache.get(key);
  if (hit && Date.now() - hit.at < PATIENT_TTL_MS) return hit.returning ? "RETURNING" : "NEW";
  let returning = false;
  try {
    const lk = await lookupPatient(key);
    returning = (lk.matches?.length ?? 0) > 0;
  } catch {
    returning = false; // fail-soft：workforce 離線/查唔到 → NEW
  }
  if (patientTypeCache.size > 500) patientTypeCache.clear();
  patientTypeCache.set(key, { at: Date.now(), returning });
  return returning ? "RETURNING" : "NEW";
}

/** Test hook（E2E 用）：清 patientType cache。 */
export function __resetPatientTypeCache(): void {
  patientTypeCache.clear();
}

/** HH:mm → 分鐘數（壞格式 → null）。 */
function hmToMin(hhmm: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * R-9 當值檢查（pure）：member 名喺 roster 且而家（HK）落喺 [shiftStart, shiftEnd] 內。
 * roster=null（攞唔到）→ fail-soft 當冇當值。跨日 shift（end<start）→ 當無效 row 丟。
 */
export function onDutyMembers(
  members: { id: string; name: string }[],
  roster: { staffName: string; shiftStart: string; shiftEnd: string }[] | null,
  now: Date = new Date()
): string[] {
  if (!roster) return [];
  const nowMin = (() => {
    const parts = now.toLocaleTimeString("en-GB", { timeZone: "Asia/Hong_Kong", hour12: false, hour: "2-digit", minute: "2-digit" }).split(":");
    return Number(parts[0]) * 60 + Number(parts[1]);
  })();
  const out: string[] = [];
  for (const m of members) {
    for (const e of roster) {
      const s = hmToMin(e.shiftStart);
      const e2 = hmToMin(e.shiftEnd);
      if (s === null || e2 === null || e2 <= s) continue; // 壞 row / 跨日 → 丟
      if (e.staffName === m.name && nowMin >= s && nowMin < e2) {
        out.push(m.id);
        break;
      }
    }
  }
  return out;
}

export interface RoutingInput {
  conv: { id: string; clinicId: string; contactId: string; assigneeId: string | null; pinnedPatientApricotId: string | null; status: string; routedRuleId: string | null };
  clinic: { id: string; code: string };
  contact: { waId: string | null } | null;
  msg: { id: string; type: string; body: string; waMessageId: string | null };
  intent: string;
  urgency: string;
  /** lexicon entries（worker 已 fetch — ptLex；零重複 DB/HTTP） */
  lexicon: LexiconEntry[];
}

export interface RoutingResult {
  rule: RouteRule | null;
  /** 有冇寫 routed* 標記（CLINIC_POOL / R-4 唔服務 → false） */
  marked: boolean;
  groupId: string | null;
  groupName: string | null;
  /** R-9 當值單人（恰一個當值成員先有值） */
  staffId: string | null;
}

/**
 * 命中後全套（MD §2 applyRouting）：目標解析 → R-9 當值 → 寫 routed*（唔掂 assigneeId）
 * → StaffNotice + socket + web push（全組）→ audit ROUTING_APPLIED。
 * 任何例外 → fail-soft（log + 當冇命中），唔阻 AI pipeline。
 */
export async function applyRouting(input: RoutingInput): Promise<RoutingResult> {
  const none: RoutingResult = { rule: null, marked: false, groupId: null, groupName: null, staffId: null };
  try {
    // ★ cwi-routing-guard-20260908：已路由且未 RESOLVED → 唔重標記。
    //   保留首次 routedAt（15min 升級計時器唔後移）+ StaffNotice/push/audit 去重。
    //   RESOLVED = re-open 新週期 → 放行（下方 update 會 reset escalatedAt=null）。
    if (input.conv.routedRuleId != null && input.conv.status !== "RESOLVED") {
      log.debug({ conversationId: input.conv.id, ruleId: input.conv.routedRuleId }, "routing: already routed — skip re-mark");
      return none;
    }
    const [rules, patientType] = await Promise.all([
      resolveEffectiveRules(input.conv.clinicId),
      resolvePatientType({ pinnedPatientApricotId: input.conv.pinnedPatientApricotId, waId: input.contact?.waId ?? null }),
    ]);
    const textCanonical = applyLexicon(input.msg.body ?? "", input.lexicon);
    const rule = matchRule(rules, { intent: input.intent, textCanonical, patientType });
    if (!rule) return none;

    // ── 1. 目標解析 ────────────────────────────────────────────────────
    let groupId: string | null = null;
    let groupName: string | null = null;
    let members: { id: string; name: string }[] = [];
    let singleStaffId: string | null = null; // STAFF 單人目標（active + 服務該店）
    const keywordHits = rule.keywords.filter((k) => k.length > 0 && textCanonical.includes(k));

    if (rule.targetType === "GROUP" && rule.targetGroupId) {
      const group = await prisma.skillGroup.findUnique({
        where: { id: rule.targetGroupId },
        select: { id: true, name: true, enabled: true },
      });
      if (group && group.enabled) {
        // R-4：組要明確服務該店
        const served = await prisma.skillGroupClinic.count({ where: { groupId: group.id, clinicId: input.conv.clinicId } });
        if (served > 0) {
          const memberIds = (
            await prisma.skillGroupMember.findMany({ where: { groupId: group.id }, select: { staffId: true } })
          ).map((m) => m.staffId);
          const staff = await prisma.staffUser.findMany({
            where: { id: { in: memberIds }, active: true },
            select: { id: true, name: true },
          });
          if (staff.length > 0) {
            groupId = group.id;
            groupName = group.name;
            members = staff;
          }
          // staff.length === 0（組冇 active 成員）→ 唔標記（落預設公海）
        }
        // 組唔服務該店 → 唔標記（T252）
      }
    } else if (rule.targetType === "STAFF" && rule.targetStaffId) {
      const s = await prisma.staffUser.findUnique({
        where: { id: rule.targetStaffId },
        select: {
          id: true,
          name: true,
          active: true,
          clinics: { where: { clinicId: input.conv.clinicId }, select: { clinicId: true } },
        },
      });
      if (s && s.active && s.clinics.length > 0) {
        singleStaffId = s.id;
        members = [{ id: s.id, name: s.name }];
      }
      // 唔 active / 唔服務該店 → 唔標記（落預設公海）
    }
    // CLINIC_POOL → 唔做任何標記（= 現行行為）

    // ── 2. R-9 當值檢查（duty roster；fail-soft null → 冇當值）────────
    let routedStaffId: string | null = null;
    const roster = await fetchDutyRoster(input.clinic.code, hkToday()).catch(() => null);
    if (singleStaffId) {
      // STAFF 單人：當值 → 標佢；唔當值 → 唔標（「只標組」冇組可標 → 落公海），通知照俾佢
      if (onDutyMembers(members, roster).includes(singleStaffId)) routedStaffId = singleStaffId;
    } else if (groupId) {
      // GROUP：恰一個當值成員 → 標佢；零/多個 → 只標組
      const duty = onDutyMembers(members, roster);
      routedStaffId = duty.length === 1 ? duty[0] : null;
    }

    // ── 3. 寫 Conversation.routed*（R-2：唔掂 assigneeId）─────────────
    //   標記 = 有組或有當值單人（STAFF 唔當值 → 唔標記，落預設公海）
    const marked = groupId !== null || routedStaffId !== null;
    if (marked) {
      await prisma.conversation.update({
        where: { id: input.conv.id },
        data: {
          routedGroupId: groupId,
          routedStaffId,
          routedRuleId: rule.id,
          routedAt: new Date(),
          // ★ cwi-routing-guard-20260908：re-open（RESOLVED → 新 inbound）= 新升級週期 → 清 escalatedAt。
          //   首次路由時 escalatedAt 本來就係 null → 無副作用。
          escalatedAt: null,
        },
      });
    }

    // ── 4. 通知（有解析到目標時 — 含 STAFF 唔當值嗰個；全組 — 唔係淨係當值嗰個）────
    if (marked || singleStaffId !== null) {
      const title = `新個案 · ${groupName ?? "指定人員"} · ${input.clinic.code}`;
      await prisma.staffNotice.create({
        data: {
          clinicId: input.conv.clinicId,
          conversationId: input.conv.id,
          kind: "ROUTING_ASSIGNED",
          title,
          meta: {
            ruleId: rule.id,
            groupId,
            staffId: routedStaffId,
            wamid: input.msg.waMessageId,
          } as Prisma.InputJsonValue,
        },
      });
      // commit-then-emit（commit 咗先 publish — 鐵律）
      publishNotify(input.conv.clinicId, "routing:assigned", {
        conversationId: input.conv.id,
        ruleId: rule.id,
        groupId,
        groupName,
        staffId: routedStaffId,
      });
      // Web push → 全組 active 成員（per-store 靜音偏好照舊生效）
      pushRoutingEvent({ clinicId: input.conv.clinicId, conversationId: input.conv.id, staffIds: members.map((m) => m.id), escalated: false });
    }

    // ── 5. audit（零 PII metadata only — 命中原因）────────────────────
    await prisma.auditLog.create({
      data: {
        staffId: null,
        action: "ROUTING_APPLIED",
        entity: "Conversation",
        entityId: input.conv.id,
        meta: {
          ruleId: rule.id,
          ruleName: rule.name,
          target: rule.targetType,
          groupId,
          staffId: routedStaffId,
          hit: { intent: input.intent, keywords: keywordHits, patientType },
        } as Prisma.InputJsonValue,
      },
    });

    log.info(
      {
        clinic: input.clinic.code,
        conversationId: input.conv.id,
        ruleId: rule.id,
        target: rule.targetType,
        groupId: groupId ?? undefined,
        staffId: routedStaffId ?? undefined,
        marked,
        keywordHits,
        patientType,
      },
      "routing: applied"
    );

    return { rule, marked, groupId, groupName, staffId: routedStaffId };
  } catch (err) {
    // fail-soft：路由失敗唔阻 AI pipeline（對話照落公海、照通知 — 現行行為兜底）
    log.warn({ err: err instanceof Error ? err.message : String(err), conversationId: input.conv.id }, "routing: apply failed（fail-soft）");
    return { ...none };
  }
}

/**
 * R-7 首覆（療程組）：規則有 autoReplyTemplate 且命中 → 呢個 template 做嗰條 inbound 嘅
 * **唯一** AiDraft（取代 AI 草稿 — 命中高價值療程嘅首覆係規則文案，唔係 AI 自由答）。
 * 發送決策**全部交返 ai.worker 現有 4.5 閘**（L1 → 草稿俾 staff；L2+ → 自動發；
 * window/assigned/RESOLVED/human-recent 等鐵律零改動）。
 *
 * 只喺正常 draft 路徑調用（booking/PAIN session 有自己回覆路徑 — 唔會重複覆）。
 * 鐵律：URGENT_PAIN / COMPLAINT / HIGH 永不建（同 canDraft 同一水位）。
 */
export async function applyRoutingFirstReply(args: {
  convId: string;
  msgId: string;
  msgType: string;
  rule: RouteRule;
  intent: string;
  urgency: string;
  winOpen: boolean;
}): Promise<string | null> {
  const { rule } = args;
  if (!rule.autoReplyTemplate) return null;
  if (args.msgType !== "text") return null; // 媒體 → Phase A media 流程（MD §5）
  if (args.intent === "URGENT_PAIN" || args.intent === "COMPLAINT" || args.urgency === "HIGH") return null; // 鐵律

  try {
    let draft = await prisma.aiDraft.findUnique({
      where: { conversationId_inReplyToMessageId: { conversationId: args.convId, inReplyToMessageId: args.msgId } },
    });
    if (!draft) {
      try {
        draft = await prisma.aiDraft.create({
          data: {
            conversationId: args.convId,
            inReplyToMessageId: args.msgId,
            draftText: rule.autoReplyTemplate,
            model: "routing-r7",
            latencyMs: 0,
            intent: args.intent,
            mode: args.winOpen ? "NORMAL" : "COPY_ONLY",
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          draft = await prisma.aiDraft.findUnique({
            where: { conversationId_inReplyToMessageId: { conversationId: args.convId, inReplyToMessageId: args.msgId } },
          });
        } else {
          throw err;
        }
      }
    }
    if (draft) {
      const msg = await prisma.message.findUnique({ where: { id: args.msgId }, select: { aiDraftId: true } });
      if (msg && msg.aiDraftId !== draft.id) {
        await prisma.message.update({ where: { id: args.msgId }, data: { aiDraftId: draft.id } });
      }
      return draft.id;
    }
    return null;
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err), conversationId: args.convId }, "routing: R-7 first reply draft failed（fail-soft）");
    return null;
  }
}

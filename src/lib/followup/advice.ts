/**
 * ★ cwi-advice-20261024：醫生建議跟進（DOCTOR_ADVICE）— 共用常數 + 通知收件人 + 通知落庫。
 *
 * 流程（掃描本體喺 engine.ts scanDoctorAdvice — 要用 createTask 總門）：
 *   CWM 夜跑（03:00）同步診症記錄 → 每 10 分鐘 followup-scan 問 CWM /clinical-index/advice
 *   （觸發字／排除字由規則傳）→ 建 SUGGESTED（subjectKey advice:<病人>:<診症日>）→ 呢度出 🔔。
 *   「立即更新」（patient refresh）成功後即刻對該病人跑一次（runDoctorAdviceForPatient）。
 *
 * 🔴 紅線：wa-inbox 唔存臨床全文 — task.contextJson 只入欄名 + 觸發字 + 日期／醫生；
 *   「原文」句由跟進卡即時問 CWM（GET /api/followups/tasks/:id/advice — CWM 落 EXTERNAL_ADVICE_VIEWED）。
 *   通知 title 零病人資料（同 routing 口徑）。
 *
 * 通知邊個（老細 2026-10-24 拍板）：對話負責人 → 該店「顧問」技能組 active 成員 → 全店（targetStaffIds 空）。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import type { Prisma } from "@prisma/client";
import { FOLLOWUP_ADVICE_RULES } from "@/lib/followup/factory-defaults";

/** 出廠觸發字／排除字（單一來源 = factory-defaults）— 唔分大細楷；「adv」唔會中「advance」（CWM 端字母邊界）。 */
export const DEFAULT_ADVICE_KEYWORDS: string[] = FOLLOWUP_ADVICE_RULES[0].keywords ?? [];
export const DEFAULT_ADVICE_EXCLUDES: string[] = FOLLOWUP_ADVICE_RULES[0].excludeKeywords ?? [];

/** 醫生建議 task 時效：建議日 + 30 日（規則頁「30 日仍未處理就自動過期」）。 */
export const ADVICE_EXPIRY_DAYS = 30;

/** 同一病人同一日診症只出一張卡（同日報價併入呢張 — E 類見到就唔再出）。 */
export function adviceSubjectKey(patientApricotId: string, visitDate: string): string {
  return `advice:${patientApricotId}:${visitDate}`;
}

/** 觸發字／排除字正規化：trim、去空、去重（唔分大細楷）、每個 ≤ 40 字、最多 50 個；逗號唔准（CWM 用逗號拆）。 */
export function normalizeAdviceTerms(raw: unknown): string[] {
  const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\n，]/) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of arr) {
    const t = String(x ?? "").replace(/[,，]/g, " ").replace(/\s+/g, " ").trim();
    if (!t || t.length > 40) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= 50) break;
  }
  return out;
}

/** 「顧問」技能組：enabled 且（名含「顧問」或 code = CONSULT）且（綁咗呢間店 或 冇綁任何店 = 全店通用）。 */
export async function consultantStaffIds(clinicId: string): Promise<string[]> {
  const groups = await prisma.skillGroup.findMany({
    where: { enabled: true, OR: [{ name: { contains: "顧問" } }, { code: "CONSULT" }] },
    select: { id: true },
  });
  if (!groups.length) return [];
  const links = await prisma.skillGroupClinic.findMany({ where: { groupId: { in: groups.map((g) => g.id) } } });
  const groupIds = groups
    .map((g) => g.id)
    .filter((gid) => {
      const mine = links.filter((l) => l.groupId === gid);
      return mine.length === 0 || mine.some((l) => l.clinicId === clinicId);
    });
  if (!groupIds.length) return [];
  const members = await prisma.skillGroupMember.findMany({ where: { groupId: { in: groupIds } }, select: { staffId: true } });
  const ids = [...new Set(members.map((m) => m.staffId))];
  if (!ids.length) return [];
  const active = await prisma.staffUser.findMany({ where: { id: { in: ids }, active: true }, select: { id: true } });
  return active.map((s) => s.id);
}

/** 收件人：負責人 → 顧問組 → []（= 全店）。 */
export async function adviceRecipients(conv: { clinicId: string; assigneeId: string | null }): Promise<string[]> {
  if (conv.assigneeId) {
    const a = await prisma.staffUser.findUnique({ where: { id: conv.assigneeId }, select: { active: true } });
    if (a?.active) return [conv.assigneeId];
  }
  return consultantStaffIds(conv.clinicId);
}

/**
 * 建議 task 落咗 DB 之後出 🔔（commit-then-emit；best-effort — 失敗只 log，唔擋 scan）。
 * 定向（有收件人）→ StaffNotice.targetStaffIds + staff room socket + Web Push；
 * 全店（冇收件人）→ 對話級事件（publishConvEvent — 同其他 notice 一樣）。
 */
export async function notifyDoctorAdvice(input: {
  taskId: string;
  conversationId: string;
  visitDate: string;
  clinicCode: string;
  keywords: string[];
}): Promise<void> {
  try {
    const conv = await prisma.conversation.findUnique({
      where: { id: input.conversationId },
      select: { id: true, clinicId: true, assigneeId: true, routedStaffId: true, routedGroupId: true },
    });
    if (!conv) return;
    const targets = await adviceRecipients(conv);
    const title = `醫生建議跟進 · ${input.visitDate.slice(5).replace("-", "/")} ${input.clinicCode} 診症記錄有「${input.keywords.slice(0, 2).join("／")}」`;
    const notice = await prisma.staffNotice.create({
      data: {
        clinicId: conv.clinicId,
        conversationId: conv.id,
        kind: "FOLLOWUP_ADVICE",
        title,
        targetStaffIds: targets,
        meta: { taskId: input.taskId, visitDate: input.visitDate, target: targets.length ? "staff" : "clinic" } as Prisma.InputJsonValue,
      },
    });
    const payload = { conversationId: conv.id, clinicId: conv.clinicId, kind: "FOLLOWUP_ADVICE", noticeId: notice.id };
    const { publishConvEvent, publishStaffNotify, convRef } = await import("@/lib/notify");
    if (targets.length === 0) {
      await publishConvEvent(convRef(conv), "notice:new", payload);
      return;
    }
    for (const sid of targets) publishStaffNotify(sid, conv.clinicId, "notice:new", payload);
    const { pushToStaff, isClinicMutedForStaff } = await import("@/lib/push");
    const clinic = await prisma.clinic.findUnique({ where: { id: conv.clinicId }, select: { code: true } });
    for (const sid of targets) {
      if (await isClinicMutedForStaff(sid, conv.clinicId)) continue;
      void pushToStaff(sid, { kind: "notice", clinicShort: clinic?.code ?? input.clinicCode, conversationId: conv.id });
    }
  } catch (err) {
    log.warn({ taskId: input.taskId, err: err instanceof Error ? err.message : String(err) }, "followup: 醫生建議通知失敗（best-effort）");
  }
}

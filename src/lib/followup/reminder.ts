/**
 * ★ cwi-reminder-20261025：「⏰ 待跟進」— 員工自設跟進提醒（取代右欄「等回覆」狀態）。
 *
 * 一個提醒 = FollowupTask（source=MANUAL、ruleId=null、status=SUGGESTED），每個對話最多一個未處理提醒
 * （再設 = 改日期／原因，唔疊）。
 *   - 未到期：唔入「待跟進」分頁、唔出建議卡；列表行顯示「⏰ 10/28 提醒」。
 *   - 到期（dueAt ≤ now）：入「待跟進」分頁 + 對話頂提醒卡；followup-scan 每 10 分鐘出 🔔
 *     （StaffNotice FOLLOWUP_REMINDER，定向 → 設提醒嗰個人／負責人；contextJson.notifiedAt 防重發）。
 *   - 病人喺設定之後覆咗 → recheckOpenSuggestions 照 REPLIED 取消（rule=null → cancelOnReply 預設開）。
 *   - 卡上：已跟進（COMPLETED）／再延 N 日（改 dueAt + 清 notifiedAt）／取消（CANCELLED MANUAL）。
 *
 * 時間：揀「聽日／N 日後／某日」= 該日香港時間 09:00；揀今日 = 即刻到期。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import type { Prisma } from "@prisma/client";
import { hkDateOffset, hkTodayStr } from "@/lib/availability";

// 延遲 import：engine 好大 — 列表 DTO（openRemindersByConv）唔使載佢
async function emitFollowupChanged(conversationId: string | null, clinicId: string, taskId: string, status: string): Promise<void> {
  const { emitFollowupChanged: emit } = await import("@/lib/followup/engine");
  await emit(conversationId, clinicId, taskId, status);
}

export const REMINDER_MAX_DAYS = 180;
export const REMINDER_REASON_MAX = 100;

export interface ReminderCtx {
  /** 到期通知邊個（staff id） */
  remindStaffId: string;
  remindStaffName: string | null;
  setByStaffId: string;
  reason: string | null;
  /** 已出 🔔 嘅時間（ISO）— 再延會清走 */
  notifiedAt?: string | null;
}

export interface ReminderView {
  id: string;
  dueAt: string;
  reason: string | null;
  remindStaffId: string;
  remindStaffName: string | null;
  due: boolean;
}

/** 提醒時間：dateStr（YYYY-MM-DD，香港日）09:00；今日或之前 = now（即刻到期）。 */
export function reminderDueAt(dateStr: string, now: Date = new Date()): Date {
  if (dateStr <= hkTodayStr(now)) return now;
  return new Date(`${dateStr}T09:00:00+08:00`);
}

/** body → 香港日（days 優先；date = YYYY-MM-DD）；非法 → null。 */
export function reminderDateFromBody(body: { days?: unknown; date?: unknown }, now: Date = new Date()): string | null {
  if (body.days !== undefined) {
    const d = Number(body.days);
    if (!Number.isInteger(d) || d < 0 || d > REMINDER_MAX_DAYS) return null;
    return hkDateOffset(d, now);
  }
  if (typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    const t = new Date(`${body.date}T00:00:00Z`).getTime();
    if (Number.isNaN(t)) return null;
    const today = hkTodayStr(now);
    if (body.date < today || body.date > hkDateOffset(REMINDER_MAX_DAYS, now)) return null;
    return body.date;
  }
  return null;
}

export function reminderView(t: { id: string; dueAt: Date; contextJson: Prisma.JsonValue | null }, now: Date = new Date()): ReminderView {
  const c = (t.contextJson ?? {}) as Partial<ReminderCtx>;
  return {
    id: t.id,
    dueAt: t.dueAt.toISOString(),
    reason: c.reason ?? null,
    remindStaffId: c.remindStaffId ?? "",
    remindStaffName: c.remindStaffName ?? null,
    due: t.dueAt.getTime() <= now.getTime(),
  };
}

/** 對話未處理提醒（最多一個）。 */
export async function openReminder(conversationId: string) {
  return prisma.followupTask.findFirst({
    where: { conversationId, source: "MANUAL", status: "SUGGESTED" },
    orderBy: { createdAt: "desc" },
  });
}

/** 一批對話嘅未處理提醒（列表 DTO 用）。 */
export async function openRemindersByConv(convIds: string[], now: Date = new Date()): Promise<Map<string, ReminderView>> {
  if (!convIds.length) return new Map();
  const rows = await prisma.followupTask.findMany({
    where: { conversationId: { in: convIds }, source: "MANUAL", status: "SUGGESTED" },
    orderBy: { createdAt: "asc" },
    select: { id: true, conversationId: true, dueAt: true, contextJson: true },
  });
  return new Map(rows.map((r) => [r.conversationId as string, reminderView(r, now)]));
}

/**
 * 設定（或改）提醒。對話 RESOLVED → 翻返處理中（設提醒 = 仲要跟）。
 * target = "me"（設提醒嗰個人 — 預設）｜ "assignee"（對話負責人；冇負責人 → 退返自己）。
 */
export async function setReminder(input: {
  conversationId: string;
  staffId: string;
  date: string;
  reason: string | null;
  target: "me" | "assignee";
  now?: Date;
}): Promise<ReminderView> {
  const now = input.now ?? new Date();
  const conv = await prisma.conversation.findUniqueOrThrow({
    where: { id: input.conversationId },
    select: { id: true, clinicId: true, assigneeId: true, status: true, pinnedPatientApricotId: true },
  });
  const remindStaffId = input.target === "assignee" && conv.assigneeId ? conv.assigneeId : input.staffId;
  const remindStaff = await prisma.staffUser.findUnique({ where: { id: remindStaffId }, select: { name: true } });
  const ctx: ReminderCtx = {
    remindStaffId,
    remindStaffName: remindStaff?.name ?? null,
    setByStaffId: input.staffId,
    reason: input.reason,
    notifiedAt: null,
  };
  const dueAt = reminderDueAt(input.date, now);
  const existing = await openReminder(conv.id);
  const task = existing
    ? await prisma.followupTask.update({
        where: { id: existing.id },
        data: { dueAt, note: input.reason, contextJson: ctx as unknown as Prisma.InputJsonValue },
      })
    : await prisma.followupTask.create({
        data: {
          clinicId: conv.clinicId,
          conversationId: conv.id,
          patientApricotId: conv.pinnedPatientApricotId,
          phoneHashes: [],
          ruleId: null,
          subjectKey: `manual:${conv.id}:${now.toISOString()}`,
          source: "MANUAL",
          dueAt,
          status: "SUGGESTED",
          note: input.reason,
          createdBy: input.staffId,
          contextJson: ctx as unknown as Prisma.InputJsonValue,
        },
      });
  if (conv.status !== "OPEN") {
    await prisma.conversation.update({ where: { id: conv.id }, data: { status: "OPEN" } });
  }
  await prisma.auditLog.create({
    data: {
      staffId: input.staffId,
      action: existing ? "FOLLOWUP_REMINDER_UPDATED" : "FOLLOWUP_REMINDER_SET",
      entity: "FollowupTask",
      entityId: task.id,
      meta: { conversationId: conv.id, dueAt: dueAt.toISOString(), remindStaffId } as object,
    },
  });
  void emitFollowupChanged(conv.id, conv.clinicId, task.id, "SUGGESTED");
  return reminderView(task, now);
}

/** 卡上操作：done = 已跟進（COMPLETED）｜ snooze = 再延 N 日｜ cancel = 取消。回 null = 搵唔到未處理提醒。 */
export async function actOnReminder(input: {
  conversationId: string;
  staffId: string;
  action: "done" | "snooze" | "cancel";
  days?: number;
  now?: Date;
}): Promise<ReminderView | { status: string } | null> {
  const now = input.now ?? new Date();
  const t = await openReminder(input.conversationId);
  if (!t) return null;
  if (input.action === "snooze") {
    const days = Math.min(Math.max(1, Math.floor(input.days ?? 3)), REMINDER_MAX_DAYS);
    const ctx = { ...((t.contextJson ?? {}) as unknown as ReminderCtx), notifiedAt: null };
    const updated = await prisma.followupTask.update({
      where: { id: t.id },
      data: { dueAt: reminderDueAt(hkDateOffset(days, now), now), contextJson: ctx as unknown as Prisma.InputJsonValue },
    });
    await audit(input.staffId, "FOLLOWUP_REMINDER_SNOOZED", t.id, { days });
    void emitFollowupChanged(t.conversationId, t.clinicId, t.id, "SUGGESTED");
    return reminderView(updated, now);
  }
  const status = input.action === "done" ? "COMPLETED" : "CANCELLED";
  const r = await prisma.followupTask.updateMany({
    where: { id: t.id, status: "SUGGESTED" },
    data: { status, handledBy: input.staffId, handledAt: now, ...(status === "CANCELLED" ? { cancelReason: "MANUAL" } : {}) },
  });
  if (r.count === 0) return null;
  await audit(input.staffId, input.action === "done" ? "FOLLOWUP_REMINDER_DONE" : "FOLLOWUP_REMINDER_CANCELLED", t.id, {});
  void emitFollowupChanged(t.conversationId, t.clinicId, t.id, status);
  return { status };
}

async function audit(staffId: string, action: string, entityId: string, meta: Record<string, unknown>): Promise<void> {
  await prisma.auditLog.create({ data: { staffId, action, entity: "FollowupTask", entityId, meta: meta as object } });
}

/**
 * followup-scan 每輪：到期未出 🔔 嘅提醒 → StaffNotice（定向）+ socket + push + followup:changed
 * （列表「待跟進」計數／對話卡即時出）。回出咗幾多個。
 */
export async function notifyDueReminders(now: Date = new Date()): Promise<number> {
  const due = await prisma.followupTask.findMany({
    where: { source: "MANUAL", status: "SUGGESTED", dueAt: { lte: now }, conversationId: { not: null } },
    select: { id: true, clinicId: true, conversationId: true, contextJson: true },
    take: 500,
  });
  let n = 0;
  for (const t of due) {
    const ctx = (t.contextJson ?? {}) as unknown as ReminderCtx;
    if (ctx.notifiedAt) continue;
    // 先標 notifiedAt（防並行 scan 雙發）— 只有標到嘅一方先出通知
    const claimed = await prisma.$executeRaw`
      UPDATE "FollowupTask" SET "contextJson" = jsonb_set(COALESCE("contextJson", '{}'::jsonb), '{notifiedAt}', to_jsonb(${now.toISOString()}::text))
      WHERE "id" = ${t.id} AND "status" = 'SUGGESTED' AND ("contextJson"->>'notifiedAt') IS NULL`;
    if (claimed === 0) continue;
    n++;
    try {
      const conv = await prisma.conversation.findUnique({
        where: { id: t.conversationId as string },
        select: { id: true, clinicId: true, assigneeId: true, routedStaffId: true, routedGroupId: true },
      });
      if (!conv) continue;
      const targets = ctx.remindStaffId ? [ctx.remindStaffId] : [];
      const notice = await prisma.staffNotice.create({
        data: {
          clinicId: conv.clinicId,
          conversationId: conv.id,
          kind: "FOLLOWUP_REMINDER",
          title: "⏰ 跟進提醒到期",
          targetStaffIds: targets,
          meta: { taskId: t.id } as Prisma.InputJsonValue,
        },
      });
      const payload = { conversationId: conv.id, clinicId: conv.clinicId, kind: "FOLLOWUP_REMINDER", noticeId: notice.id };
      const { publishConvEvent, publishStaffNotify, convRef } = await import("@/lib/notify");
      if (targets.length === 0) {
        await publishConvEvent(convRef(conv), "notice:new", payload);
      } else {
        for (const sid of targets) publishStaffNotify(sid, conv.clinicId, "notice:new", payload);
        const { pushToStaff, isClinicMutedForStaff } = await import("@/lib/push");
        const clinic = await prisma.clinic.findUnique({ where: { id: conv.clinicId }, select: { code: true } });
        for (const sid of targets) {
          if (await isClinicMutedForStaff(sid, conv.clinicId)) continue;
          void pushToStaff(sid, { kind: "notice", clinicShort: clinic?.code ?? "", conversationId: conv.id });
        }
      }
      void emitFollowupChanged(conv.id, conv.clinicId, t.id, "SUGGESTED");
    } catch (err) {
      log.warn({ taskId: t.id, err: err instanceof Error ? err.message : String(err) }, "followup: 跟進提醒通知失敗（best-effort）");
    }
  }
  if (n > 0) log.info({ reminders: n }, "followup: 跟進提醒到期 → 🔔");
  return n;
}

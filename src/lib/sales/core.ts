/**
 * ★ cwi-sales-20261028：銷售系統第 1 期核心（保護期／綁定／預約綁定／對話鎖）。
 *
 * - 預約綁定：經 inbox 落嘅預約（booking-write worker 成功、Flow 佔位入單）→ SalesBooking；
 *   歸屬 = Flow 發送人（係銷售先算）> 落單人（係銷售先算）。前台／Apricot 直接 book 唔計。
 * - 保護期：由落預約開始，到「預約日後 protectionDays 日」23:59:59（香港時間）。
 *   公海／冇歸屬 → PROTECTED；同一銷售再約 → 續期（rounds+1，上限 cycleCap）；
 *   其他銷售保護中／綁定 → 唔改（OWNED_BY_OTHER）。
 * - 到期 sweep：到期前先問 workforce 病人有冇之後嘅預約（前台改期／直接 book 都計）→ 有就跟新日子延期；
 *   冇 → POOL（銷售公海）+ 通知原銷售。
 * - 對話鎖：對話連結嘅病人（釘住／此電話嘅病人／電話認到）有任何一個 PROTECTED / BOUND →
 *   只有負責銷售同被轉交嘅同事可以覆。
 *
 * PII：只用 Apricot 病人／預約 id、員工 id；通知 title 零病人資料。
 */
import { Prisma, type SalesSettings } from "@prisma/client";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { hkDateOffset, hkTodayStr } from "@/lib/availability";

export const INTENT_LEVELS = ["HIGH", "MEDIUM", "LOW"] as const;
export type SalesIntent = (typeof INTENT_LEVELS)[number];

export type SalesBookingOutcome =
  | "PROTECTED"
  | "RENEWED"
  | "BOUND_KEEP"
  | "OWNED_BY_OTHER"
  | "CAP_REACHED"
  | "TOO_FAR"
  | "CYCLE_CAP";

type Db = Prisma.TransactionClient | typeof prisma;

// ── 設定 ────────────────────────────────────────────────────────────────────

export async function getSalesSettings(db: Db = prisma): Promise<SalesSettings> {
  const row = await db.salesSettings.findUnique({ where: { id: "global" } });
  if (row) return row;
  return db.salesSettings.upsert({ where: { id: "global" }, create: { id: "global" }, update: {} });
}

/** 預約日後 N 日嘅 23:59:59.999（香港時間） */
export function protectedUntilFor(apptDate: string, days: number): Date {
  const end = hkDateOffset(days, new Date(`${apptDate}T12:00:00+08:00`));
  return new Date(`${end}T23:59:59.999+08:00`);
}

// ── 員工 ────────────────────────────────────────────────────────────────────

/** 有效銷售（active + isSales）；唔係 → null */
export async function activeSales(staffId: string | null | undefined, db: Db = prisma): Promise<{ id: string; name: string } | null> {
  if (!staffId) return null;
  const s = await db.staffUser.findUnique({ where: { id: staffId }, select: { id: true, name: true, isSales: true, active: true } });
  return s && s.active && s.isSales ? { id: s.id, name: s.name } : null;
}

/** 呢張預約歸邊個銷售：Flow 發送人（係銷售）> 落單人（係銷售）> null */
export async function resolveBookingSales(input: { flowToken?: string | null; actorStaffId?: string | null }, db: Db = prisma): Promise<string | null> {
  if (input.flowToken) {
    const session = await db.flowSession.findUnique({ where: { flowToken: input.flowToken }, select: { messageId: true } });
    if (session?.messageId) {
      const msg = await db.message.findUnique({ where: { id: session.messageId }, select: { sentByStaffId: true } });
      const sender = await activeSales(msg?.sentByStaffId, db);
      if (sender) return sender.id;
    }
  }
  return (await activeSales(input.actorStaffId, db))?.id ?? null;
}

// ── 病人 ↔ 對話 ─────────────────────────────────────────────────────────────

/** 對話連結嘅全部 Apricot 病人 id（釘住 + 此電話嘅病人 + 電話認到）— 屋企人共用電話：一個綁定成個對話鎖 */
export async function conversationPatientIds(conversationId: string, db: Db = prisma): Promise<string[]> {
  const conv = await db.conversation.findUnique({ where: { id: conversationId }, select: { contactId: true, pinnedPatientApricotId: true } });
  if (!conv) return [];
  const [contact, links] = await Promise.all([
    db.contact.findUnique({ where: { id: conv.contactId }, select: { identifiedPatientApricotId: true } }),
    db.contactPatientLink.findMany({ where: { contactId: conv.contactId }, select: { patientApricotId: true } }),
  ]);
  const ids = new Set<string>();
  if (conv.pinnedPatientApricotId) ids.add(conv.pinnedPatientApricotId);
  if (contact?.identifiedPatientApricotId) ids.add(contact.identifiedPatientApricotId);
  for (const l of links) ids.add(l.patientApricotId);
  return [...ids];
}

// ── 預約綁定 ────────────────────────────────────────────────────────────────

export interface RecordSalesBookingInput {
  apricotApptId: string;
  patientApricotId: string;
  apptDate: string; // YYYY-MM-DD
  clinicId: string | null;
  conversationId: string | null;
  flowToken?: string | null;
  actorStaffId?: string | null;
  source: "BOOKING" | "HOLD";
  now?: Date;
}

/**
 * 經 inbox 落嘅預約 → 保護期。冪等（同一 apricotApptId 只計一次）；唔係銷售落 → null（唔記錄）。
 * best-effort：任何錯誤只 log，唔影響落單本身。
 */
export async function recordSalesBooking(input: RecordSalesBookingInput): Promise<{ outcome: SalesBookingOutcome; salesStaffId: string } | null> {
  try {
    return await recordSalesBookingInner(input);
  } catch (err) {
    log.warn({ apricotApptId: input.apricotApptId, err: err instanceof Error ? err.message : String(err) }, "sales: 預約綁定失敗（best-effort）");
    return null;
  }
}

async function recordSalesBookingInner(input: RecordSalesBookingInput): Promise<{ outcome: SalesBookingOutcome; salesStaffId: string } | null> {
  const now = input.now ?? new Date();
  const existing = await prisma.salesBooking.findUnique({ where: { apricotApptId: input.apricotApptId } });
  if (existing) return existing.salesStaffId ? { outcome: existing.outcome as SalesBookingOutcome, salesStaffId: existing.salesStaffId } : null;
  const salesStaffId = await resolveBookingSales(input);
  if (!salesStaffId) return null;

  const result = await prisma.$transaction(async (tx) => {
    // 同一病人並發落單 → 串行（advisory lock，交易完自動放）
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sales:${input.patientApricotId}`}))`;
    const settings = await getSalesSettings(tx);
    const own = await tx.salesOwnership.findUnique({ where: { patientApricotId: input.patientApricotId } });
    const until = protectedUntilFor(input.apptDate, settings.protectionDays);
    const apptFields = { lastApptId: input.apricotApptId, lastApptDate: input.apptDate, clinicId: input.clinicId };
    let outcome: SalesBookingOutcome;

    if (input.apptDate > hkDateOffset(settings.maxDaysAhead, now)) {
      outcome = "TOO_FAR";
    } else if (!own || own.state === "POOL" || !own.salesStaffId) {
      const held = await tx.salesOwnership.count({ where: { salesStaffId, state: "PROTECTED" } });
      if (held >= settings.concurrentCap) {
        outcome = "CAP_REACHED";
      } else {
        const data = { state: "PROTECTED" as const, salesStaffId, lastSalesStaffId: salesStaffId, protectedUntil: until, rounds: 1, noShowStreak: 0, since: now, ...apptFields };
        await tx.salesOwnership.upsert({ where: { patientApricotId: input.patientApricotId }, create: { patientApricotId: input.patientApricotId, ...data }, update: data });
        outcome = "PROTECTED";
      }
    } else if (own.salesStaffId !== salesStaffId) {
      outcome = "OWNED_BY_OTHER";
    } else if (own.state === "BOUND") {
      await tx.salesOwnership.update({ where: { id: own.id }, data: apptFields });
      outcome = "BOUND_KEEP";
    } else if (own.rounds >= settings.cycleCap) {
      outcome = "CYCLE_CAP";
    } else {
      const keep = own.protectedUntil && own.protectedUntil > until ? own.protectedUntil : until;
      await tx.salesOwnership.update({ where: { id: own.id }, data: { protectedUntil: keep, rounds: own.rounds + 1, ...apptFields } });
      outcome = "RENEWED";
    }

    await tx.salesBooking.create({
      data: {
        apricotApptId: input.apricotApptId,
        patientApricotId: input.patientApricotId,
        salesStaffId,
        conversationId: input.conversationId,
        clinicId: input.clinicId,
        apptDate: input.apptDate,
        source: input.source,
        outcome,
      },
    });
    await tx.auditLog.create({
      data: {
        staffId: salesStaffId,
        action: "SALES_BOOKING_RECORDED",
        entity: "SalesOwnership",
        entityId: input.patientApricotId,
        meta: { apricotApptId: input.apricotApptId, apptDate: input.apptDate, outcome, source: input.source, conversationId: input.conversationId } as Prisma.InputJsonValue,
      },
    });
    return { outcome, salesStaffId, ownerStaffId: own?.salesStaffId ?? null };
  });

  if (result.outcome !== "PROTECTED" && result.outcome !== "RENEWED" && result.outcome !== "BOUND_KEEP" && input.conversationId) {
    const why: Record<string, string> = {
      OWNED_BY_OTHER: "呢個病人由其他銷售保護中／綁定，今次預約唔計保護期",
      CAP_REACHED: "你保護中嘅病人已到上限，今次預約唔計保護期",
      TOO_FAR: "預約日太遠，今次預約唔計保護期",
      CYCLE_CAP: "已到循環邀約上限，今次預約冇再延長保護期",
    };
    await notifyStaff([salesStaffId], input.conversationId, "SALES_PROTECTION", `銷售 · ${why[result.outcome]}`, { outcome: result.outcome });
  }
  return { outcome: result.outcome, salesStaffId: result.salesStaffId };
}

/** 經 inbox 改期（新預約 id 取代舊）：舊預約有計保護 → 新預約承接，保護期跟新日子（唔加輪數）。回 true = 舊預約有計（已承接） */
export async function rescheduleSalesBooking(input: { oldApptId: string; newApptId: string; newDate: string; now?: Date }): Promise<boolean> {
  try {
    const old = await prisma.salesBooking.findUnique({ where: { apricotApptId: input.oldApptId } });
    if (!old || !old.salesStaffId) return false;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sales:${old.patientApricotId}`}))`;
      const settings = await getSalesSettings(tx);
      await tx.salesBooking.upsert({
        where: { apricotApptId: input.newApptId },
        create: { ...pickBooking(old), apricotApptId: input.newApptId, apptDate: input.newDate, outcome: old.outcome },
        update: {},
      });
      const own = await tx.salesOwnership.findUnique({ where: { patientApricotId: old.patientApricotId } });
      if (own?.state === "PROTECTED" && own.salesStaffId === old.salesStaffId && own.lastApptId === input.oldApptId) {
        await tx.salesOwnership.update({
          where: { id: own.id },
          data: { lastApptId: input.newApptId, lastApptDate: input.newDate, protectedUntil: protectedUntilFor(input.newDate, settings.protectionDays) },
        });
      }
    });
    return true;
  } catch (err) {
    log.warn({ oldApptId: input.oldApptId, err: err instanceof Error ? err.message : String(err) }, "sales: 改期承接保護失敗（best-effort）");
    return false;
  }
}

function pickBooking(b: { patientApricotId: string; salesStaffId: string | null; conversationId: string | null; clinicId: string | null; source: string }) {
  return { patientApricotId: b.patientApricotId, salesStaffId: b.salesStaffId, conversationId: b.conversationId, clinicId: b.clinicId, source: b.source };
}

// ── 到期 sweep ──────────────────────────────────────────────────────────────

export type FutureApptLookup = (patientApricotId: string, from: string, to: string) => Promise<{ apricotApptId: string; date: string }[] | null>;

/** 預設：問 workforce 病人預約（有效 = bookingStatus ≥ 0 且唔係 102 改期舊單）；workforce 唔得 → null（今次唔處理） */
export const workforceFutureAppts: FutureApptLookup = async (patientApricotId, from, to) => {
  const { fetchAppointmentsByPatient } = await import("@/lib/workforce/client");
  try {
    const res = await fetchAppointmentsByPatient(patientApricotId, from, to);
    return res.appointments.filter((a) => a.bookingStatus >= 0 && a.bookingStatus !== 102).map((a) => ({ apricotApptId: a.apricotApptId, date: a.date }));
  } catch {
    return null;
  }
};

/**
 * PROTECTED 到期 → 先睇病人之後有冇預約（前台改期／Apricot 直接 book 都計）→ 有就跟新日子延期（唔加輪數）；
 * 冇 → POOL + 通知原銷售。workforce 唔得 → 跳過（下次再試）。
 */
export async function expireProtections(now: Date = new Date(), lookup: FutureApptLookup = workforceFutureAppts): Promise<{ extended: number; pooled: number; skipped: number }> {
  const out = { extended: 0, pooled: 0, skipped: 0 };
  const settings = await getSalesSettings();
  const due = await prisma.salesOwnership.findMany({
    where: { state: "PROTECTED", protectedUntil: { lt: now } },
    orderBy: { protectedUntil: "asc" },
    take: 200,
  });
  const today = hkTodayStr(now);
  for (const own of due) {
    const future = await lookup(own.patientApricotId, today, hkDateOffset(settings.maxDaysAhead, now));
    if (future === null) {
      out.skipped++;
      continue;
    }
    const next = future.filter((a) => a.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
    if (next && protectedUntilFor(next.date, settings.protectionDays) > now) {
      await prisma.salesOwnership.updateMany({
        where: { id: own.id, state: "PROTECTED", updatedAt: own.updatedAt },
        data: { protectedUntil: protectedUntilFor(next.date, settings.protectionDays), lastApptId: next.apricotApptId, lastApptDate: next.date },
      });
      out.extended++;
      continue;
    }
    const res = await prisma.salesOwnership.updateMany({
      where: { id: own.id, state: "PROTECTED", updatedAt: own.updatedAt },
      data: { state: "POOL", salesStaffId: null, lastSalesStaffId: own.salesStaffId, protectedUntil: null, rounds: 0, since: now },
    });
    if (res.count !== 1) continue;
    out.pooled++;
    await prisma.auditLog
      .create({
        data: {
          staffId: null,
          action: "SALES_PROTECTION_EXPIRED",
          entity: "SalesOwnership",
          entityId: own.patientApricotId,
          meta: { salesStaffId: own.salesStaffId, lastApptId: own.lastApptId } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
    if (own.salesStaffId) {
      const convId = (await patientConversationIds(own.patientApricotId))[0] ?? null;
      if (convId) await notifyStaff([own.salesStaffId], convId, "SALES_PROTECTION", "銷售 · 保護期到期，病人已放返銷售公海", { reason: "EXPIRED" });
    }
  }
  return out;
}

/** 病人連住嘅對話（最近優先）— 通知用 */
export async function patientConversationIds(patientApricotId: string): Promise<string[]> {
  const [linked, identified] = await Promise.all([
    prisma.contactPatientLink.findMany({ where: { patientApricotId }, select: { contactId: true }, take: 20 }),
    prisma.contact.findMany({ where: { identifiedPatientApricotId: patientApricotId }, select: { id: true }, take: 20 }),
  ]);
  const contactIds = [...new Set([...linked.map((l) => l.contactId), ...identified.map((c) => c.id)])];
  const convs = await prisma.conversation.findMany({
    where: { OR: [{ pinnedPatientApricotId: patientApricotId }, ...(contactIds.length ? [{ contactId: { in: contactIds } }] : [])] },
    orderBy: { lastMessageAt: "desc" },
    select: { id: true },
    take: 10,
  });
  return convs.map((c) => c.id);
}

// ── 對話鎖 ──────────────────────────────────────────────────────────────────

export interface ConversationSalesLock {
  owners: { staffId: string; name: string; state: "PROTECTED" | "BOUND"; patientApricotId: string; protectedUntil: string | null }[];
  delegates: { staffId: string; kind: string; expiresAt: string | null }[];
}

export async function conversationSalesLock(conversationId: string, now: Date = new Date(), db: Db = prisma): Promise<ConversationSalesLock> {
  const patientIds = await conversationPatientIds(conversationId, db);
  if (patientIds.length === 0) return { owners: [], delegates: [] };
  const owns = await db.salesOwnership.findMany({
    where: { patientApricotId: { in: patientIds }, state: { in: ["PROTECTED", "BOUND"] }, salesStaffId: { not: null } },
  });
  if (owns.length === 0) return { owners: [], delegates: [] };
  const staff = await db.staffUser.findMany({
    where: { id: { in: [...new Set(owns.map((o) => o.salesStaffId!))] }, active: true, isSales: true },
    select: { id: true, name: true },
  });
  const nameOf = new Map(staff.map((s) => [s.id, s.name]));
  // 停用／取消銷售嘅員工唔鎖（老闆要轉移）— 防止對話永遠冇人覆到
  const owners = owns
    .filter((o) => nameOf.has(o.salesStaffId!))
    .map((o) => ({
      staffId: o.salesStaffId!,
      name: nameOf.get(o.salesStaffId!)!,
      state: o.state as "PROTECTED" | "BOUND",
      patientApricotId: o.patientApricotId,
      protectedUntil: o.protectedUntil ? o.protectedUntil.toISOString() : null,
    }));
  if (owners.length === 0) return { owners: [], delegates: [] };
  const dels = await db.salesDelegation.findMany({
    where: { conversationId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    orderBy: { createdAt: "desc" },
  });
  return {
    owners,
    delegates: dels.map((d) => ({ staffId: d.toStaffId, kind: d.kind, expiresAt: d.expiresAt ? d.expiresAt.toISOString() : null })),
  };
}

/** 呢個員工可唔可以覆呢個對話（冇鎖 / 係負責銷售 / 被轉交 → true） */
export function canReplyUnderLock(lock: ConversationSalesLock, staffId: string): boolean {
  if (lock.owners.length === 0) return true;
  return lock.owners.some((o) => o.staffId === staffId) || lock.delegates.some((d) => d.staffId === staffId);
}

export class SalesLockedError extends Error {
  constructor(public owners: ConversationSalesLock["owners"]) {
    super("SALES_LOCKED");
  }
}

/** 發送前守門：鎖住而唔係負責人／被轉交 → throw SalesLockedError（route 轉 423） */
export async function assertCanReplyUnderSalesLock(conversationId: string, staffId: string): Promise<void> {
  const lock = await conversationSalesLock(conversationId);
  if (!canReplyUnderLock(lock, staffId)) throw new SalesLockedError(lock.owners);
}

// ── 通知 ────────────────────────────────────────────────────────────────────

export async function notifyStaff(
  staffIds: string[],
  conversationId: string,
  kind: "SALES_PROTECTION" | "SALES_HANDOVER" | "SALES_UNANSWERED",
  title: string,
  meta: Record<string, unknown> = {}
): Promise<void> {
  const targets = [...new Set(staffIds.filter(Boolean))];
  if (targets.length === 0) return;
  try {
    const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { id: true, clinicId: true } });
    if (!conv) return;
    const notice = await prisma.staffNotice.create({
      data: { clinicId: conv.clinicId, conversationId: conv.id, kind, title, targetStaffIds: targets, meta: meta as Prisma.InputJsonValue },
    });
    const payload = { conversationId: conv.id, clinicId: conv.clinicId, kind, noticeId: notice.id };
    const { publishStaffNotify } = await import("@/lib/notify");
    for (const sid of targets) publishStaffNotify(sid, conv.clinicId, "notice:new", payload);
    const { pushToStaff, isClinicMutedForStaff } = await import("@/lib/push");
    const clinic = await prisma.clinic.findUnique({ where: { id: conv.clinicId }, select: { code: true } });
    for (const sid of targets) {
      if (await isClinicMutedForStaff(sid, conv.clinicId)) continue;
      void pushToStaff(sid, { kind: "notice", clinicShort: clinic?.code ?? "", conversationId: conv.id });
    }
  } catch (err) {
    log.warn({ conversationId, kind, err: err instanceof Error ? err.message : String(err) }, "sales: 通知失敗（best-effort）");
  }
}

/**
 * ★ cwi-sales 第 5 期（R2）：預約日過咗 → 查到診結果；保護中病人連續爽約到上限 → 放返銷售公海。
 *
 * - 範圍：經 inbox 落嘅 SalesBooking，預約日喺 [今日 − 14 日, 今日)，未有到診結果；每次最多 200 張。
 * - 每個病人問 workforce 一次（讀 workforce 預約索引，唔直接打 Apricot）；索引過期（stale）／連唔到 → 跳過，聽日再試。
 * - Apricot bookingStatus：−3 = 爽約（NO_SHOW）；−7 等其他負數 = 取消（CANCELLED）；102 = 改期舊單（RESCHEDULED）；≥ 0 = 有嚟（SHOWN）。
 * - 只影響「同一銷售保護中」嘅病人：爽約 → noShowStreak + 1，到 noShowCap → 公海 + 通知原銷售；有嚟 → streak 歸 0。
 *   綁定（BOUND）病人唔會因爽約放走。noShowCap = 0 → 唔放（只記錄）。
 * - 冪等：attendance 由 null 寫一次（條件 update）先郁 streak；重跑唔會重計。
 *
 * PII：只用 Apricot 病人／預約 id；通知 title 零病人資料。
 */
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { hkDateOffset, hkTodayStr } from "@/lib/availability";
import { getSalesSettings, notifyStaff, patientConversationIds } from "@/lib/sales/core";

export type Attendance = "SHOWN" | "NO_SHOW" | "CANCELLED" | "RESCHEDULED";

/** 病人喺 [from, to] 嘅預約狀態；null = 今次查唔到（跳過） */
export type ApptStatusLookup = (patientApricotId: string, from: string, to: string) => Promise<{ apricotApptId: string; bookingStatus: number }[] | null>;

export const workforceApptStatuses: ApptStatusLookup = async (patientApricotId, from, to) => {
  const { fetchAppointmentsByPatient } = await import("@/lib/workforce/client");
  try {
    const res = await fetchAppointmentsByPatient(patientApricotId, from, to);
    if (res.stale) return null; // 索引未更新 → 狀態可能未反映，聽日再查
    return res.appointments.map((a) => ({ apricotApptId: a.apricotApptId, bookingStatus: a.bookingStatus }));
  } catch {
    return null;
  }
};

export function attendanceOf(bookingStatus: number): Attendance {
  if (bookingStatus === -3) return "NO_SHOW";
  if (bookingStatus === 102) return "RESCHEDULED";
  if (bookingStatus < 0) return "CANCELLED";
  return "SHOWN";
}

const LOOKBACK_DAYS = 14;
const MAX_BOOKINGS = 200;

export async function runSalesAttendance(
  now: Date = new Date(),
  lookup: ApptStatusLookup = workforceApptStatuses
): Promise<{ checked: number; noShow: number; shown: number; pooled: number; skipped: number }> {
  const out = { checked: 0, noShow: 0, shown: 0, pooled: 0, skipped: 0 };
  const today = hkTodayStr(now);
  const from = hkDateOffset(-LOOKBACK_DAYS, now);
  const due = await prisma.salesBooking.findMany({
    where: { attendance: null, apptDate: { gte: from, lt: today } },
    orderBy: [{ apptDate: "asc" }, { createdAt: "asc" }],
    take: MAX_BOOKINGS,
  });
  if (due.length === 0) return out;
  const settings = await getSalesSettings();
  const byPatient = new Map<string, typeof due>();
  for (const b of due) byPatient.set(b.patientApricotId, [...(byPatient.get(b.patientApricotId) ?? []), b]);

  for (const [pid, bookings] of byPatient) {
    const statuses = await lookup(pid, from, today);
    if (statuses === null) {
      out.skipped += bookings.length;
      continue;
    }
    const statusOf = new Map(statuses.map((s) => [s.apricotApptId, s.bookingStatus]));
    for (const b of bookings) {
      const st = statusOf.get(b.apricotApptId);
      if (st === undefined) {
        out.skipped++; // 索引搵唔到（刪咗／未同步）→ 下次再試；過咗 14 日就唔再理
        continue;
      }
      const att = attendanceOf(st);
      const r = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sales:${pid}`}))`;
        const marked = await tx.salesBooking.updateMany({ where: { id: b.id, attendance: null }, data: { attendance: att } });
        if (marked.count !== 1) return null; // 並發／重跑：已處理
        const own = await tx.salesOwnership.findUnique({ where: { patientApricotId: pid } });
        const mine = own && own.state === "PROTECTED" && b.salesStaffId && own.salesStaffId === b.salesStaffId;
        if (!mine) return { pooled: false, streak: null as number | null, ownerId: null as string | null };
        if (att === "SHOWN") {
          if (own.noShowStreak !== 0) await tx.salesOwnership.update({ where: { id: own.id }, data: { noShowStreak: 0 } });
          return { pooled: false, streak: 0, ownerId: own.salesStaffId };
        }
        if (att !== "NO_SHOW") return { pooled: false, streak: own.noShowStreak, ownerId: own.salesStaffId };
        const streak = own.noShowStreak + 1;
        if (settings.noShowCap > 0 && streak >= settings.noShowCap) {
          await tx.salesOwnership.update({
            where: { id: own.id },
            data: { state: "POOL", salesStaffId: null, lastSalesStaffId: own.salesStaffId, protectedUntil: null, rounds: 0, noShowStreak: 0, highValue: false, expiryRemindedFor: null, since: now },
          });
          await tx.auditLog.create({
            data: {
              staffId: null,
              action: "SALES_PROTECTION_NO_SHOW",
              entity: "SalesOwnership",
              entityId: pid,
              meta: { salesStaffId: own.salesStaffId, apricotApptId: b.apricotApptId, streak, cap: settings.noShowCap } as Prisma.InputJsonValue,
            },
          });
          return { pooled: true, streak, ownerId: own.salesStaffId };
        }
        await tx.salesOwnership.update({ where: { id: own.id }, data: { noShowStreak: streak } });
        return { pooled: false, streak, ownerId: own.salesStaffId };
      });
      if (!r) continue;
      out.checked++;
      if (att === "NO_SHOW") out.noShow++;
      if (att === "SHOWN") out.shown++;
      if (r.pooled && r.ownerId) {
        out.pooled++;
        const convId = (await patientConversationIds(pid))[0] ?? null;
        if (convId) await notifyStaff([r.ownerId], convId, "SALES_PROTECTION", `銷售 · 病人連續 ${r.streak} 次爽約，已放返銷售公海`, { reason: "NO_SHOW" });
      }
    }
  }
  return out;
}

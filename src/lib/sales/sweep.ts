/**
 * ★ cwi-sales-20261028：銷售 cron（每 5 分鐘，cron light lane）。
 *
 * ① 保護期到期：expireProtections（之後有預約 → 延期；冇 → 銷售公海 + 通知原銷售）
 * ② 冇人覆：綁定／保護中病人嘅對話，病人最後一句之後 N 分鐘冇人覆 →
 *    通知負責銷售 + 主管（SUPERVISOR）+ ADMIN（只喺 notifyWindowStart–End 香港時間；每條 inbound 只通知一次）
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { conversationSalesLock, expireProtections, getSalesSettings, notifyStaff, patientConversationIds } from "@/lib/sales/core";

/** "HH:mm" 香港時間係咪喺 [start, end) */
export function inHkWindow(now: Date, start: string, end: string): boolean {
  const hk = new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(11, 16);
  return start <= end ? hk >= start && hk < end : hk >= start || hk < end;
}

export async function runSalesUnansweredSweep(now: Date = new Date()): Promise<{ checked: number; notified: number }> {
  const out = { checked: 0, notified: 0 };
  const settings = await getSalesSettings();
  if (!inHkWindow(now, settings.notifyWindowStart, settings.notifyWindowEnd)) return out;
  const cutoff = new Date(now.getTime() - settings.unansweredNotifyMinutes * 60_000);
  const since = new Date(now.getTime() - 24 * 3600_000);

  const owned = await prisma.salesOwnership.findMany({
    where: { state: { in: ["PROTECTED", "BOUND"] }, salesStaffId: { not: null } },
    select: { patientApricotId: true },
  });
  if (owned.length === 0) return out;
  const pids = owned.map((o) => o.patientApricotId);
  const [links, identified] = await Promise.all([
    prisma.contactPatientLink.findMany({ where: { patientApricotId: { in: pids } }, select: { contactId: true } }),
    prisma.contact.findMany({ where: { identifiedPatientApricotId: { in: pids } }, select: { id: true } }),
  ]);
  const contactIds = [...new Set([...links.map((l) => l.contactId), ...identified.map((c) => c.id)])];
  const convs = await prisma.conversation.findMany({
    where: {
      lastInboundAt: { gte: since, lte: cutoff },
      OR: [{ pinnedPatientApricotId: { in: pids } }, ...(contactIds.length ? [{ contactId: { in: contactIds } }] : [])],
    },
    select: { id: true, clinicId: true, lastInboundAt: true, lastOutboundAt: true, salesUnansweredNotifiedAt: true },
    take: 500,
  });

  for (const c of convs) {
    if (!c.lastInboundAt) continue;
    if (c.lastOutboundAt && c.lastOutboundAt >= c.lastInboundAt) continue; // 已覆
    if (c.salesUnansweredNotifiedAt && c.salesUnansweredNotifiedAt >= c.lastInboundAt) continue; // 呢條 inbound 已通知
    out.checked++;
    const lock = await conversationSalesLock(c.id, now);
    if (lock.owners.length === 0) continue;
    // 原子 claim（並發 sweep 唔會雙發）
    const claimed = await prisma.conversation.updateMany({
      where: { id: c.id, OR: [{ salesUnansweredNotifiedAt: null }, { salesUnansweredNotifiedAt: { lt: c.lastInboundAt } }] },
      data: { salesUnansweredNotifiedAt: now },
    });
    if (claimed.count !== 1) continue;
    const supervisors = await prisma.staffUser.findMany({
      where: {
        active: true,
        OR: [{ role: "ADMIN" }, { role: "SUPERVISOR", OR: [{ scopeType: "ALL" }, { clinics: { some: { clinicId: c.clinicId } } }] }],
      },
      select: { id: true },
    });
    const mins = Math.round((now.getTime() - c.lastInboundAt.getTime()) / 60_000);
    await notifyStaff(
      [...lock.owners.map((o) => o.staffId), ...supervisors.map((s) => s.id)],
      c.id,
      "SALES_UNANSWERED",
      `銷售 · ${lock.owners.map((o) => o.name).join("／")} 負責嘅病人 ${mins} 分鐘冇人覆`,
      { minutes: mins }
    );
    out.notified++;
  }
  return out;
}

export async function runSalesSweep(now: Date = new Date()): Promise<Record<string, number>> {
  const r: Record<string, number> = {};
  try {
    Object.assign(r, await expireProtections(now));
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "sales-sweep: 保護期到期失敗");
  }
  try {
    const u = await runSalesUnansweredSweep(now);
    r.unansweredChecked = u.checked;
    r.unansweredNotified = u.notified;
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "sales-sweep: 冇人覆通知失敗");
  }
  return r;
}

/**
 * ★ cwi-sales 第 3 期：綁定病人 N 個月（設定，預設 24）冇付款 → 自動放返公海（每日一次，heavy cron）。
 * - 只睇綁定咗超過 N 個月嘅（since 早過 cutoff）；最後付款由 workforce 分類帳拎（每張單一次 bills/{id} 嘅結果）
 * - workforce 連唔到 → 成批跳過（唔肯定就唔放）
 * - 條件 update（since + 狀態冇變先放）— 並發／老闆啱啱轉移都唔會錯放；通知原本銷售；審計只記 id
 */
export async function runBoundAutoRelease(
  now: Date = new Date(),
  activity: (ids: string[]) => Promise<{ patientApricotId: string; lastPaymentAt: string | null }[]> = async (ids) => (await import("@/lib/workforce/client")).fetchPatientActivity(ids)
): Promise<{ checked: number; released: number; skipped: string | null }> {
  const settings = await getSalesSettings();
  const months = Math.max(1, settings.boundAutoReleaseMonths);
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const rows = await prisma.salesOwnership.findMany({ where: { state: "BOUND", since: { lt: cutoff } }, orderBy: { since: "asc" }, take: 200 });
  if (rows.length === 0) return { checked: 0, released: 0, skipped: null };
  let acts: { patientApricotId: string; lastPaymentAt: string | null }[];
  try {
    acts = await activity(rows.map((r) => r.patientApricotId));
  } catch {
    return { checked: rows.length, released: 0, skipped: "WORKFORCE_UNAVAILABLE" };
  }
  const lastOf = new Map(acts.map((a) => [a.patientApricotId, a.lastPaymentAt]));
  let released = 0;
  for (const r of rows) {
    if (!lastOf.has(r.patientApricotId)) continue; // workforce 冇回呢個 → 唔肯定，唔放
    const last = lastOf.get(r.patientApricotId);
    if (last && new Date(last) >= cutoff) continue;
    const done = await prisma.salesOwnership.updateMany({
      where: { id: r.id, state: "BOUND", salesStaffId: r.salesStaffId, since: r.since },
      data: { state: "POOL", salesStaffId: null, lastSalesStaffId: r.salesStaffId, protectedUntil: null, rounds: 0, since: now },
    });
    if (done.count !== 1) continue;
    released++;
    await prisma.auditLog.create({
      data: { staffId: null, action: "SALES_OWNER_AUTO_RELEASED", entity: "SalesOwnership", entityId: r.patientApricotId, meta: { fromStaffId: r.salesStaffId, months } },
    });
    const convId = (await patientConversationIds(r.patientApricotId))[0];
    if (convId && r.salesStaffId) await notifyStaff([r.salesStaffId], convId, "SALES_PROTECTION", `銷售 · 綁定病人 ${months} 個月冇付款，已放返銷售公海`, { reason: "BOUND_AUTO_RELEASE" });
  }
  return { checked: rows.length, released, skipped: null };
}

/**
 * ★ cwi-sales-20261028：銷售 cron（每 5 分鐘，cron light lane）。
 *
 * ① 保護期到期：expireProtections（之後有預約 → 延期；冇 → 銷售公海 + 通知原銷售）
 * ② 冇人覆：綁定／保護中病人嘅對話，病人最後一句之後 N 分鐘冇人覆 →
 *    通知負責銷售 + 主管（SUPERVISOR）+ ADMIN（只喺 notifyWindowStart–End 香港時間；每條 inbound 只通知一次）
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { conversationSalesLock, expireProtections, getSalesSettings, notifyStaff } from "@/lib/sales/core";

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

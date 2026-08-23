/**
 * Flow data_exchange screen data（MD §8.2）
 *
 * 原則：**每次 call 先經 getSlots()（四層降級鏈）確保 L2 新鮮，再查 AvailabilitySlot**
 *（precheck 原則：病人揀親 = 真有空）。NONE 變體（純收需求）由 endpoint 層處理。
 * 三個 screen：
 * - SCREEN_PROVIDER → 該店 active 醫生（Provider/ProviderClinic 對照）
 * - SCREEN_DATE     → 聽日 ~ +30 日，只回「該醫生有空檔」嘅日期
 * - SCREEN_TIME     → 該日該醫生 bookedCount=0 嘅 30 分鐘 slot
 */
import prisma from "@/lib/prisma";
import { syncWindow } from "@/lib/availability";

export interface ProviderOption {
  id: string; // apricotId
  name: string;
}

/** SCREEN_PROVIDER：該店醫生名錄（Provider/ProviderClinic — seed 派生 / admin 手動維護） */
export async function screenProviders(clinicId: string): Promise<ProviderOption[]> {
  const rows = await prisma.providerClinic.findMany({
    where: { clinicId, provider: { active: true, apricotId: { not: null } } },
    include: { provider: true },
    orderBy: { provider: { name: "asc" } },
  });
  return rows.map((r) => ({ id: r.provider.apricotId!, name: r.provider.name }));
}

/** SCREEN_DATE：聽日~+30 日，只回該醫生有「空 slot」嘅日期（決定性升冪） */
export async function screenDates(clinicId: string, providerApricotId: string): Promise<string[]> {
  const { start, end, dates } = syncWindow();
  const rows = await prisma.availabilitySlot.findMany({
    where: {
      clinicId,
      providerApricotId,
      date: { gte: start, lte: end },
      isOpen: true,
      bookedCount: 0,
    },
    select: { date: true },
    distinct: ["date"],
  });
  const has = new Set(rows.map((r) => r.date));
  return dates.filter((d) => has.has(d));
}

/** SCREEN_TIME：該日該醫生有空嘅時段（HH:mm 開始時間，30 分鐘 slot） */
export async function screenTimes(
  clinicId: string,
  providerApricotId: string,
  date: string
): Promise<string[]> {
  const rows = await prisma.availabilitySlot.findMany({
    where: { clinicId, providerApricotId, date, isOpen: true, bookedCount: 0 },
    select: { startTime: true },
    orderBy: { startTime: "asc" },
  });
  return rows.map((r) => r.startTime);
}

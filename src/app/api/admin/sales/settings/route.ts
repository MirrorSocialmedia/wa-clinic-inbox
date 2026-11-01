/**
 * ★ cwi-sales-20261028：/api/admin/sales/settings — 銷售規則設定（GET = ADMIN；PUT = 集團管理員）。
 * PUT body = 部分欄位（保護日數、上限、通知時段、意向名稱…）；審計 SALES_SETTINGS_UPDATE。
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireAdmin, isGlobalAdmin } from "@/lib/rbac";
import { handle, toResponse } from "@/lib/api-error";
import { getSalesSettings } from "@/lib/sales/core";

export const dynamic = "force-dynamic";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const putSchema = z
  .object({
    protectionDays: z.number().int().min(1).max(90),
    highValueProtectionDays: z.number().int().min(1).max(180),
    maxDaysAhead: z.number().int().min(1).max(180),
    cycleCap: z.number().int().min(1).max(20),
    noShowCap: z.number().int().min(0).max(10), // ★ 第 5 期：0 = 唔因爽約放走（只記錄）
    expiryRemindDays: z.number().int().min(0).max(14), // ★ 第 5 期：保護期到期前 N 日提醒（0 = 唔提）
    concurrentCap: z.number().int().min(1).max(1000),
    boundAutoReleaseMonths: z.number().int().min(1).max(120),
    unansweredNotifyMinutes: z.number().int().min(5).max(24 * 60),
    notifyWindowStart: hhmm,
    notifyWindowEnd: hhmm,
    intentLabels: z.array(z.string().trim().min(1).max(6)).length(3),
  })
  .partial();

export const GET = handle(async (req: NextRequest) => {
  await requireAdmin(req);
  return NextResponse.json({ settings: await getSalesSettings() });
});

export const PUT = handle(async (req: NextRequest) => {
  const admin = await requireAdmin(req);
  if (!isGlobalAdmin(admin)) return NextResponse.json({ error: "FORBIDDEN", message: "只有集團管理員可以改銷售規則" }, { status: 403 });
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);
  await getSalesSettings();
  const settings = await prisma.salesSettings.update({ where: { id: "global" }, data: { ...parsed.data, updatedByStaffId: admin.staff.id } });
  await prisma.auditLog.create({
    data: { staffId: admin.staff.id, action: "SALES_SETTINGS_UPDATE", entity: "SalesSettings", entityId: "global", meta: parsed.data as Prisma.InputJsonValue },
  });
  return NextResponse.json({ settings });
});

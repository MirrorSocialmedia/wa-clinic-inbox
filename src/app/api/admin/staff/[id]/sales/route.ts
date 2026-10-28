/**
 * ★ cwi-sales-20261028：PUT /api/admin/staff/[id]/sales — 員工「☑ 銷售人員」+ 綁定（只限集團管理員 = 老闆）。
 *
 * body { isSales, salesApricotUserId?, salesApricotUserName?, workforceEmployeeId?, workforceEmployeeName? }
 * - SUPERVISOR 唔可以係銷售（唔覆客）→ 400
 * - 一個 Apricot 銷售員／workforce 員工只可以綁一個 inbox 帳號 → 409 DUPLICATE_BINDING
 * - 取消勾選：仲有保護中／綁定病人 → 409 HAS_PATIENTS（老闆要先喺「銷售 · 病人歸屬」轉移）
 * 審計 SALES_STAFF_SET（只記 id）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireAdmin, isGlobalAdmin } from "@/lib/rbac";
import { handle, toResponse } from "@/lib/api-error";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  isSales: z.boolean(),
  salesApricotUserId: z.string().min(1).max(64).nullish(),
  salesApricotUserName: z.string().max(100).nullish(),
  workforceEmployeeId: z.string().min(1).max(64).nullish(),
  workforceEmployeeName: z.string().max(100).nullish(),
});

export const PUT = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireAdmin(req);
  if (!isGlobalAdmin(admin)) return NextResponse.json({ error: "FORBIDDEN", message: "只有集團管理員可以設定銷售人員" }, { status: 403 });
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);
  const b = parsed.data;
  const target = await prisma.staffUser.findUnique({ where: { id }, select: { id: true, role: true, isSales: true } });
  if (!target) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (b.isSales && target.role === "SUPERVISOR") {
    return NextResponse.json({ error: "BAD_ROLE", message: "主管唔覆客，唔可以做銷售人員" }, { status: 400 });
  }
  if (!b.isSales && target.isSales) {
    const held = await prisma.salesOwnership.count({ where: { salesStaffId: id, state: { in: ["PROTECTED", "BOUND"] } } });
    if (held > 0) {
      return NextResponse.json(
        { error: "HAS_PATIENTS", message: `佢仲有 ${held} 個保護中／綁定病人 — 請先喺「銷售 · 病人歸屬」轉移或者放返公海`, count: held },
        { status: 409 }
      );
    }
  }
  const data = b.isSales
    ? {
        isSales: true,
        salesApricotUserId: b.salesApricotUserId ?? null,
        salesApricotUserName: b.salesApricotUserId ? (b.salesApricotUserName ?? null) : null,
        workforceEmployeeId: b.workforceEmployeeId ?? null,
        workforceEmployeeName: b.workforceEmployeeId ? (b.workforceEmployeeName ?? null) : null,
      }
    : { isSales: false, salesApricotUserId: null, salesApricotUserName: null, workforceEmployeeId: null, workforceEmployeeName: null };
  try {
    await prisma.staffUser.update({ where: { id }, data });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: "DUPLICATE_BINDING", message: "呢個 Apricot 銷售員或者 workforce 員工已經綁咗另一個帳號" }, { status: 409 });
    }
    throw err;
  }
  await prisma.auditLog.create({
    data: {
      staffId: admin.staff.id,
      action: "SALES_STAFF_SET",
      entity: "StaffUser",
      entityId: id,
      meta: { isSales: data.isSales, salesApricotUserId: data.salesApricotUserId, workforceEmployeeId: data.workforceEmployeeId } as Prisma.InputJsonValue,
    },
  });
  return NextResponse.json({ ok: true, ...data });
});

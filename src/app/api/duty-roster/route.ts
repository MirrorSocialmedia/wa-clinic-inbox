import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, assertClinicAccess, scopedClinicSet } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { fetchDutyRoster, hkToday, type DutyEntry } from "@/lib/duty/client";
import log from "@/lib/log";

/**
 * GET /api/duty-roster — 今日當值（MD §9.2 消費端）。
 *
 * Scope（fail-closed；S3-9 統一全 role）：
 * - 帶 `?clinicId=`（code）→ assertClinicAccess（STAFF 別店 / scoped ADMIN 外範圍 → 403；
 *   ALL/SUPERVISOR 放行）。
 * - 唔帶 → scopedClinicSet(ctx)?.[0]（STAFF = 自己店；ALL/SUPERVISOR 無 scope 概念 →
 *   400 clinicId required — 唔好亂猜店）。
 * - date 選填（YYYY-MM-DD，預設今日 HK）。
 *
 * Fail-soft（iron rule：唔 crash inbox）：
 * - workforce API 失敗 / 404 / timeout（3s）→ 200 `{ duty: null }`（UI 隱藏卡）。
 *
 * 欄位白名單（MD §9.2）：只回 staffName / role / shiftStart / shiftEnd 四欄 —
 * 薪酬/打卡永遠掂唔到。log 只記「duty fetched, count=N」（client 層）— 呢度再記一次
 * route-level metadata（clinic/date/count），零名單原文。
 */
export const dynamic = "force-dynamic";

const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req); // 未登入 → 401；（fail-closed）

  const p = req.nextUrl.searchParams;
  const clinicParam = (p.get("clinicId") ?? "").trim();
  const dateParam = (p.get("date") ?? "").trim();

  // date 驗證（壞 date → 400，唔好透去 upstream）
  let date = dateParam;
  if (date) {
    if (!RE_DATE.test(date)) {
      return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
    }
  } else {
    date = hkToday();
  }

  // scope 解析（S3-9：統一全 role — 移除 ctx.clinicId! 直用）
  let clinic: { id: string; code: string };
  if (clinicParam) {
    // 帶 param：任何 role 都過 assertClinicAccess（STAFF 跨店 → 403；ALL/SUPERVISOR 放行；
    // scoped ADMIN 外範圍 → 403）
    const found = await prisma.clinic.findUnique({ where: { code: clinicParam }, select: { id: true, code: true } });
    if (!found) return NextResponse.json({ error: "clinic not found" }, { status: 404 });
    assertClinicAccess(ctx, found.id);
    clinic = found;
  } else {
    // 唔帶 param：自己 scope 集合頭間店（STAFF = StaffClinic 集合；
    // ALL/SUPERVISOR 無 scope 概念 → 400 clinicId required）
    const set = scopedClinicSet(ctx);
    if (!set || set.length === 0) {
      return NextResponse.json({ error: "clinicId required" }, { status: 400 });
    }
    const found = await prisma.clinic.findUnique({ where: { id: set[0] }, select: { id: true, code: true } });
    if (!found) return NextResponse.json({ error: "clinic not found" }, { status: 404 });
    clinic = found;
  }

  // fail-soft：client 永遠唔 throw（3s timeout / 404 / 壞 shape → null）
  const duty: DutyEntry[] | null = await fetchDutyRoster(clinic.code, date);
  log.info(
    { clinic: clinic.code, date, count: duty ? duty.length : null, by: ctx.staff.role },
    "duty-roster api: fetched (metadata only)"
  );
  return NextResponse.json({ duty, clinicId: clinic.code, date });
});

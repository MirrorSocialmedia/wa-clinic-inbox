import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { fetchDutyRoster, hkToday, type DutyEntry } from "@/lib/duty/client";
import log from "@/lib/log";

/**
 * GET /api/duty-roster — 今日當值（MD §9.2 消費端）。
 *
 * Scope（fail-closed）：
 * - STAFF：只可攞自己店。`?clinicId=` 指定嘅 code 必須 = 自己店（否則 403）；
 *   唔帶 param = 自己店。
 * - ADMIN：`?clinicId=` 必帶（攞邊間店）。
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

  // scope 解析
  let clinic: { id: string; code: string } | null;
  if (ctx.staff.role === "STAFF") {
    // 自己店 code（param 必須同自己店一致）
    const own = await prisma.clinic.findUnique({ where: { id: ctx.clinicId! }, select: { id: true, code: true } });
    if (!own) return NextResponse.json({ error: "clinic not found" }, { status: 404 });
    if (clinicParam && clinicParam !== own.code) {
      return NextResponse.json({ error: "cross-clinic access denied" }, { status: 403 });
    }
    clinic = own;
  } else {
    // ADMIN：必帶 clinicId
    if (!clinicParam) {
      return NextResponse.json({ error: "clinicId required" }, { status: 400 });
    }
    clinic = await prisma.clinic.findUnique({ where: { code: clinicParam }, select: { id: true, code: true } });
    if (!clinic) return NextResponse.json({ error: "clinic not found" }, { status: 404 });
  }

  // fail-soft：client 永遠唔 throw（3s timeout / 404 / 壞 shape → null）
  const duty: DutyEntry[] | null = await fetchDutyRoster(clinic.code, date);
  log.info(
    { clinic: clinic.code, date, count: duty ? duty.length : null, by: ctx.staff.role },
    "duty-roster api: fetched (metadata only)"
  );
  return NextResponse.json({ duty, clinicId: clinic.code, date });
});

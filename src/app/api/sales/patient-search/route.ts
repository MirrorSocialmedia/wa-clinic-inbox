/**
 * ★ cwi-sales 第 5 期（U9）：GET /api/sales/patient-search?q= — 銷售冇對話開單用嘅病人搜尋（編號／姓名／電話）。
 * 只限 active 銷售；每人每分鐘 20 次；結果記喺 server 15 分鐘（開單時核對，唔信 client 編號）。
 * 🔴 q 可能係電話／姓名 → 唔入 log／audit（只記長度同筆數）。
 */
import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { hit } from "@/lib/rate-limit";
import { searchPatientsByKeyword, WorkforceApiError } from "@/lib/workforce/client";
import { rememberSearchHits } from "@/lib/patient-links";
import { DIRECT_SEARCH_NS } from "@/lib/sales/invoice";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  const auth = await requireAuth(req);
  const me = await prisma.staffUser.findUnique({ where: { id: auth.staff.id }, select: { isSales: true, active: true } });
  if (!me?.isSales || !me.active) return NextResponse.json({ error: "NOT_SALES", message: "只有銷售人員可以咁開單" }, { status: 403 });
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 2 || q.length > 50) return NextResponse.json({ error: "bad_request", message: "請輸入 2–50 個字" }, { status: 400 });
  if (!(await hit(`psearch:${auth.staff.id}`, 20, 60))) return NextResponse.json({ error: "RATE_LIMITED", message: "搜尋太密，請一分鐘後再試" }, { status: 429 });
  let r;
  try {
    r = await searchPatientsByKeyword(q, auth.staff.id);
  } catch (e) {
    log.warn({ err: e instanceof WorkforceApiError ? `status=${e.status}` : e instanceof Error ? e.name : "unknown" }, "sales patient-search: workforce failed");
    return NextResponse.json({ error: "WORKFORCE_UNAVAILABLE", message: "暫時搜唔到 — 稍後重試" }, { status: 502 });
  }
  await rememberSearchHits(auth.staff.id, DIRECT_SEARCH_NS, r.patients);
  await prisma.auditLog
    .create({ data: { staffId: auth.staff.id, action: "PATIENT_SEARCH", entity: "Sales", entityId: auth.staff.id, meta: { qLen: q.length, count: r.patients.length, via: "sales-direct" } } })
    .catch(() => undefined);
  return NextResponse.json({ patients: r.patients.slice(0, 30) });
});

/**
 * GET /api/clinics — 診所清單（cwi-sched-20260901 §4）
 *
 *   ?scope=schedule → 所有登入員工（ADMIN/STAFF）見晒全部啟用中診所
 *     （時間表全店唯讀配套 — 診所下拉用；code/name only，零 PII）
 *   其他 scope → 400（scope 白名單，防止意外公開）
 *
 * 注意：Clinic 表無 active/enabled 欄（現行 schema）→ 「啟用中」= 全部 row。
 * 若日後加 active 欄，query 改 `where: { active: true }` 就得。
 */
import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, scopedClinicSet } from "@/lib/rbac";
import { handle } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const scope = new URL(req.url).searchParams.get("scope")?.trim() ?? "";
  if (scope !== "schedule") {
    return NextResponse.json({ error: "scope must be 'schedule'" }, { status: 400 });
  }
  const set = ctx.staff.role === "ADMIN" ? scopedClinicSet(ctx) : null;
  const clinics = await prisma.clinic.findMany({
    // ★ cwi-hub-a-20260914（Part A）：時間表店列表跟 scope — scoped ADMIN（COMPANY/CLINICS）只得範圍內店；
    //   STAFF / SUPERVISOR 保持全店列表（cwi-sched T-B 跨店時間表讀 + SCHEDULE_VIEW audit）
    where: set ? { id: { in: set } } : undefined,
    select: { id: true, code: true, name: true },
    orderBy: { code: "asc" },
  });
  return NextResponse.json({ ok: true, scope, clinics });
});

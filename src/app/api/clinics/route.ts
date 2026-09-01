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
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const scope = new URL(req.url).searchParams.get("scope")?.trim() ?? "";
  if (scope !== "schedule") {
    return NextResponse.json({ error: "scope must be 'schedule'" }, { status: 400 });
  }
  const clinics = await prisma.clinic.findMany({
    select: { id: true, code: true, name: true },
    orderBy: { code: "asc" },
  });
  return NextResponse.json({ ok: true, scope, clinics });
});

/**
 * POST /api/availability/refresh — 醫生時間表 / booking 候選「更新」掣後端（cwi-refresh-20260831 §4）
 *
 * body: { clinicCode: string, dates: string[] }（1..7 個 YYYY-MM-DD；超出 400 — 對齊 F 側 contract）
 *
 * 三步鏈（前端負責順序；呢度負責 ①→②）：
 *   ① 轉 workforce POST /api/external/v1/availability/refresh（scope availability；窄範圍限流）
 *   ② 逐日 ok:true → invalidateAvailabilityDay（L2 清 + 即刻重填 + broadcast availability:busted）
 *   ③ 前端重讀重繪 + 「資料截至 {syncedAt HH:mm}」
 *
 * 200 { v:1, refreshed:[{date,ok,syncedAt?}|{date,ok:false,error}], durationMs, syncedAt }
 * 429 { error, code:RATE_LIMITED, retryAfterSec } / 409 { code:APRICOT_BUSY } /
 * 404 { code:CLINIC_NOT_FOUND } / 403（STAFF 跨店 fail-closed；或 workforce scope 未加）/ 400
 *
 * Scope：所有 role 統一 scope 解析（S3-9）— 帶 clinicCode → assertClinicAccess（fail-closed：
 * STAFF 別店 / scoped ADMIN 外範圍店 → 403；ALL/SUPERVISOR 放行）；唔帶 → scopedClinicSet[0]
 *（STAFF = 自己店；ALL/SUPERVISOR 無 scope 概念 → 400 required）。零 PII：response 只日期/狀態元數據。
 */
import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, assertClinicAccess, scopedClinicSet } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { refreshAvailability, WorkforceApiError } from "@/lib/workforce/client";
import { invalidateAvailabilityDay } from "@/lib/availability";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const body = (await req.json().catch(() => null)) as { clinicCode?: unknown; dates?: unknown } | null;

  const clinicCodeIn = typeof body?.clinicCode === "string" ? body.clinicCode.trim() : "";
  const dates = Array.isArray(body?.dates) ? (body?.dates as unknown[]) : [];

  // S3-9：scope 統一解析（all roles；移除 ctx.clinicId! 直用）
  //   帶 clinicCode → assertClinicAccess（fail-closed：STAFF 別店 / scoped ADMIN 外範圍 → 403）；
  //   唔帶 → scopedClinicSet(ctx)?.[0]（ALL/SUPERVISOR 無 scope 概念 → 400 required）
  let clinicCode = clinicCodeIn;
  if (!clinicCode) {
    const set = scopedClinicSet(ctx);
    if (!set || set.length === 0) {
      return NextResponse.json({ error: "clinicCode required" }, { status: 400 });
    }
    const first = await prisma.clinic.findUnique({ where: { id: set[0] }, select: { code: true } });
    if (!first) return NextResponse.json({ error: "clinic not found", code: "CLINIC_NOT_FOUND" }, { status: 404 });
    clinicCode = first.code;
  }
  const target = await prisma.clinic.findUnique({ where: { code: clinicCode }, select: { id: true } });
  if (!target) return NextResponse.json({ error: "clinic not found", code: "CLINIC_NOT_FOUND" }, { status: 404 });
  assertClinicAccess(ctx, target.id);

  if (dates.length < 1 || dates.length > 7) {
    return NextResponse.json({ error: "dates: 1..7 YYYY-MM-DD" }, { status: 400 });
  }
  const uniq = new Set<string>();
  for (const d of dates) {
    if (typeof d !== "string" || !DATE_RE.test(d) || uniq.has(d)) {
      return NextResponse.json({ error: "dates: 1..7 unique YYYY-MM-DD" }, { status: 400 });
    }
    uniq.add(d);
  }

  let r: Awaited<ReturnType<typeof refreshAvailability>>;
  try {
    r = await refreshAvailability(clinicCode, [...uniq]);
  } catch (e) {
    if (e instanceof WorkforceApiError) {
      if (e.status === 429) {
        return NextResponse.json(
          { error: "rate limited", code: "RATE_LIMITED", retryAfterSec: e.retryAfterSec ?? 60 },
          { status: 429 },
        );
      }
      if (e.status === 409) return NextResponse.json({ error: "APRICOT_BUSY", code: "APRICOT_BUSY" }, { status: 409 });
      if (e.status === 404) {
        return NextResponse.json({ error: "clinic not found", code: "CLINIC_NOT_FOUND" }, { status: 404 });
      }
      if (e.status === 403) {
        return NextResponse.json(
          { error: "workforce not connected（scope 未加）", code: "FORBIDDEN" },
          { status: 403 },
        );
      }
      if (e.status === 400) return NextResponse.json({ error: "bad request", code: "BAD_REQUEST" }, { status: 400 });
    }
    return NextResponse.json({ error: "workforce refresh failed", code: "UPSTREAM_ERROR" }, { status: 502 });
  }

  // ② 逐日 bust（fail-soft — invalidateAvailabilityDay 內部已吞錯；逐日串行，量細）
  for (const day of r.refreshed) {
    if (day.ok) await invalidateAvailabilityDay(clinicCode, day.date);
  }

  const syncedAt =
    r.refreshed.filter((d) => d.ok && d.syncedAt).map((d) => d.syncedAt as string).sort().at(-1) ?? null;

  return NextResponse.json({
    v: 1,
    refreshed: r.refreshed,
    durationMs: r.durationMs,
    syncedAt, // 資料截至（HH:mm 由前端 render）
  });
});

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
 * Scope：STAFF 只可刷自己店（fail-closed，同 /api/flows/slots 一致）；ADMIN 任店。
 * 零 PII：response 只日期/狀態元數據。
 */
import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { refreshAvailability, WorkforceApiError } from "@/lib/workforce/client";
import { invalidateAvailabilityDay } from "@/lib/availability";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const body = (await req.json().catch(() => null)) as { clinicCode?: unknown; dates?: unknown } | null;

  const clinicCode = typeof body?.clinicCode === "string" ? body.clinicCode.trim() : "";
  const dates = Array.isArray(body?.dates) ? (body?.dates as unknown[]) : [];
  if (!clinicCode) return NextResponse.json({ error: "clinicCode required" }, { status: 400 });
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

  // STAFF 只可刷自己店（fail-closed — 同 /api/flows/slots 一致）
  if (ctx.staff.role === "STAFF") {
    const own = await prisma.clinic.findUnique({ where: { id: ctx.clinicId! } });
    if (!own || own.code !== clinicCode) {
      return NextResponse.json({ error: "cross-clinic access denied" }, { status: 403 });
    }
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

/**
 * GET /api/flows/slots — 醫生時間表數據（cwi-sched-20260901 §2；provider 分組 v2）
 *
 *   ?clinicCode=&from=&to=（YYYY-MM-DD；from ≥ today（workforce 契約）；span ≤ 7 日）
 *   [&granularity=week|day]（default week）
 *   200 { ok:true, v:2, clinicCode, from, to, granularity, connected, syncedAt, stale,
 *         days:[{ date, closed, duty[], providers:[{ providerId, providerName,
 *                onlineSeats, slots?[] }] }] }
 *   - duty + slots 一次過回（同一 syncedAt）— 減 round trip
 *   - granularity=week 唔回 slots（慳 payload）；day 嘅 slots[] 只回非 CLOSED 格
 *   - 四態：TAKEN（hold 覆蓋）/ ONLINE（offerable）/ CLOSED（其餘）/ MANUAL_ONLY（保留）
 *   - fail-soft：workforce 連唔到 → connected=false + 空 days（UI「未接通」pattern）
 *
 * Scope（T-A 過渡）：STAFF 只可查自己店（fail-closed，同舊行為）。
 *   ⚠️ cwi-sched §4（T-B）改全店唯讀：STAFF 可讀任何店 — 落單/claim/commit 一律唔受影響。
 */
import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { hkToday } from "@/lib/duty/client";
import { buildFlowSlots } from "@/lib/flow-slots";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const qp = new URL(req.url).searchParams;
  const clinicCode = qp.get("clinicCode")?.trim() ?? "";
  const from = qp.get("from")?.trim() ?? "";
  const to = qp.get("to")?.trim() ?? "";
  const granularity = qp.get("granularity")?.trim() ?? "week";

  if (granularity !== "week" && granularity !== "day") {
    return NextResponse.json({ error: "granularity must be week|day" }, { status: 400 });
  }
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || !clinicCode) {
    return NextResponse.json({ error: "clinicCode + from + to (YYYY-MM-DD) required" }, { status: 400 });
  }
  const today = hkToday();
  if (from < today) return NextResponse.json({ error: "from must be today or later" }, { status: 400 });
  if (to < from) return NextResponse.json({ error: "to must be >= from" }, { status: 400 });
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
  if (span > 7) return NextResponse.json({ error: "window too large (max 7 days)" }, { status: 400 });

  // STAFF 只可查自己店（fail-closed）— ⚠️ T-B §4 改 assertScheduleReadAccess（全店唯讀）
  if (ctx.staff.role === "STAFF") {
    const own = await prisma.clinic.findUnique({ where: { id: ctx.clinicId! } });
    if (!own || own.code !== clinicCode) {
      return NextResponse.json({ error: "cross-clinic access denied" }, { status: 403 });
    }
  }

  const j = await buildFlowSlots(clinicCode, from, to, granularity);
  return NextResponse.json(j);
});

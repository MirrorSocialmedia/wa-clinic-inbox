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
 * Scope（cwi-sched §4 — T-B）：時間表全店唯讀 — assertScheduleReadAccess
 *（active 就得，唔查 clinic；⚠️ 只准用喺時間表讀路徑 — 落單/claim/commit 一律唔受影響）。
 * Audit：STAFF 跨店睇 → SCHEDULE_VIEW（meta 只記 clinicCode，零 PII；fail-soft）。
 */
import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, assertScheduleReadAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { auditScheduleView } from "@/lib/schedule-view-audit";
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

  // cwi-sched §4：全店唯讀（active 已驗；唔查 clinic）
  assertScheduleReadAccess(ctx);

  // Audit：跨店睇時間表 → SCHEDULE_VIEW（STAFF only；meta 只記 clinicCode — 零 PII；fail-soft）
  const clinicRow = await prisma.clinic
    .findUnique({ where: { code: clinicCode }, select: { id: true } })
    .catch(() => null);
  if (clinicRow) void auditScheduleView(ctx, clinicRow.id, clinicCode);

  const j = await buildFlowSlots(clinicCode, from, to, granularity);
  return NextResponse.json(j);
});

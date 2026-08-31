/**
 * GET /api/flows/slots — 可約時段四態格數據（providerslot-20260830 T3；/schedule?view=slots）
 *
 *   ?clinicCode=&from=&to=（YYYY-MM-DD；from ≥ today（workforce 契約）；span ≤ 7 日）
 *   200 { v:1, clinicCode, from, to, connected, slots, held, holdTimeoutHours }
 *   - slots = workforce bookable-slots（只出 offerable 格）；fail-soft → null + connected=false
 *   - held = workforce held API（HELD/IN_APRICOT — 四態格「已佔」橙 + 監看用；零 PII）
 *
 * Scope：STAFF 只可查自己店（fail-closed，同 /schedule 一致）；ADMIN 任店。
 */
import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { hkToday } from "@/lib/duty/client";
import { getBookableSlots, getHeld } from "@/lib/workforce/client";
import { getSlotFreshness } from "@/lib/availability";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const qp = new URL(req.url).searchParams;
  const clinicCode = qp.get("clinicCode")?.trim() ?? "";
  const from = qp.get("from")?.trim() ?? "";
  const to = qp.get("to")?.trim() ?? "";

  if (!DATE_RE.test(from) || !DATE_RE.test(to) || !clinicCode) {
    return NextResponse.json({ error: "clinicCode + from + to (YYYY-MM-DD) required" }, { status: 400 });
  }
  const today = hkToday();
  if (from < today) return NextResponse.json({ error: "from must be today or later" }, { status: 400 });
  if (to < from) return NextResponse.json({ error: "to must be >= from" }, { status: 400 });
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
  if (span > 7) return NextResponse.json({ error: "window too large (max 7 days)" }, { status: 400 });

  // STAFF 只可查自己店（fail-closed）
  if (ctx.staff.role === "STAFF") {
    const own = await prisma.clinic.findUnique({ where: { id: ctx.clinicId! } });
    if (!own || own.code !== clinicCode) {
      return NextResponse.json({ error: "cross-clinic access denied" }, { status: 403 });
    }
  }

  const [slotsRes, heldRes, clinicRow] = await Promise.all([
    getBookableSlots(clinicCode, from, to).catch(() => null),
    getHeld(clinicCode).catch(() => null),
    // cwi-refresh-20260831 §5：L2 新鮮度（資料截至 / 可能滯後）— fail-soft
    prisma.clinic.findUnique({ where: { code: clinicCode }, select: { id: true } }).catch(() => null),
  ]);
  const clinicId = ctx.staff.role === "STAFF" ? ctx.clinicId! : clinicRow?.id ?? null;
  const freshness = clinicId ? await getSlotFreshness(clinicId, from, to) : { maxSyncedAt: null, stale: false };

  return NextResponse.json({
    v: 1,
    clinicCode,
    from,
    to,
    connected: slotsRes !== null,
    slots: slotsRes,
    held: heldRes?.holds ?? [],
    holdTimeoutHours: heldRes?.holdTimeoutHours ?? null,
    syncedAt: freshness.maxSyncedAt ? freshness.maxSyncedAt.toISOString() : null,
    stale: freshness.stale,
  });
});

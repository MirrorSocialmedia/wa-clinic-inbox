import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";

/**
 * ★ cwi-followup-p3-20260916：規則編輯（ADMIN-only）。
 *
 * PATCH /api/admin/followups/rules/:id
 *   body（全可選）：{ enabled?, delayValue?, delayUnit?, minAmount?, level?, maxSends?,
 *                    cancelOnReply?, cancelOnBooking?, cancelOnArrival?, cancelOnResolved?, cancelOnPaid? }
 *   驗證：delayValue 1–365；delayUnit HOUR/DAY/WEEK/MONTH；minAmount >= 0（null = 唔設門檻）；
 *   level L1/L2。改動即時生效（下一次掃描用新值；進行中 task 唔受影響 — 發送前取消檢查重跑）。
 */
export const dynamic = "force-dynamic";

const UNITS = new Set(["HOUR", "DAY", "WEEK", "MONTH"]);

export const PATCH = handle(async (req, { params }) => {
  const ctx = await requireAdmin(req);
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const rule = await prisma.followupRule.findUnique({ where: { id } });
  if (!rule) return NextResponse.json({ error: "rule not found" }, { status: 404 });

  const data: Record<string, unknown> = {};
  if (typeof body.enabled === "boolean") data.enabled = body.enabled;
  if (body.delayValue !== undefined) {
    const v = Number(body.delayValue);
    if (!Number.isInteger(v) || v < 1 || v > 365) return NextResponse.json({ error: "delayValue 1-365" }, { status: 400 });
    data.delayValue = v;
  }
  if (body.delayUnit !== undefined) {
    const u = String(body.delayUnit);
    if (!UNITS.has(u)) return NextResponse.json({ error: "bad delayUnit" }, { status: 400 });
    data.delayUnit = u;
  }
  if (body.minAmount !== undefined) {
    if (body.minAmount === null) data.minAmount = null;
    else {
      const v = Number(body.minAmount);
      if (!Number.isFinite(v) || v < 0) return NextResponse.json({ error: "minAmount >= 0" }, { status: 400 });
      data.minAmount = Math.round(v);
    }
  }
  if (body.level !== undefined) {
    const lv = String(body.level);
    if (lv !== "L1" && lv !== "L2") return NextResponse.json({ error: "level L1|L2" }, { status: 400 });
    data.level = lv;
  }
  if (body.maxSends !== undefined) {
    const v = Number(body.maxSends);
    if (!Number.isInteger(v) || v < 1 || v > 10) return NextResponse.json({ error: "maxSends 1-10" }, { status: 400 });
    data.maxSends = v;
  }
  for (const k of ["cancelOnReply", "cancelOnBooking", "cancelOnArrival", "cancelOnResolved", "cancelOnPaid"] as const) {
    if (typeof body[k] === "boolean") data[k] = body[k];
  }

  const updated = await prisma.followupRule.update({
    where: { id },
    data: { ...data, updatedAt: new Date() },
  });
  await prisma.auditLog.create({
    data: {
      staffId: ctx.staff.id,
      action: "FOLLOWUP_RULE_UPDATED",
      entity: "FollowupRule",
      entityId: id,
      meta: { changed: Object.keys(data) } as object,
    },
  });
  return NextResponse.json({ rule: updated });
});

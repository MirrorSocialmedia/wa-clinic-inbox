import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAdmin, assertConfigScope } from "@/lib/rbac";
import { handle } from "@/lib/api-error";

/**
 * ★ cwi-followup-p3-20260916 → cwi-followup-v3-20260916：規則編輯（ADMIN-only）。
 *
 * PATCH /api/admin/followups/rules/:id
 *   body（全可選）：{ enabled?, delayValue?, delayUnit?, level?, maxSends?,
 *                    dedupWindowDays?, firstUseConfirmedAt?,
 *                    cancelOnReply?, cancelOnBooking?, cancelOnArrival?, cancelOnResolved? }
 *   驗證：delayValue 1–365；delayUnit HOUR/DAY/WEEK/MONTH；level 只收 L1（v3 全部硬性 L1 — 建議層）；
 *   dedupWindowDays 1–30（B-4② 同病人同 trigger 終態抑制窗）；
 *   firstUseConfirmedAt = B1 首啟用確認（ISO 串；BEFORE_APPOINTMENT 規則啟用時 UI 彈確認後帶上）；
 *   ★ cwi-final S0-8（N-11）：firstUseConfirmed（boolean）= 同一確認嘅簡化口徑（server 寫 firstUseConfirmedAt=now）。
 *   BEFORE_APPOINTMENT 規則首啟用（firstUseConfirmedAt 為 null）未帶確認 → 409 FIRST_USE_CONFIRM_REQUIRED。
 *   改動即時生效（下一次掃描用新值）。（v3 已剔 minAmount/cancelOnPaid — F 類整類剷走。）
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
  // ★ cwi-final S3-1：規則 clinicId null（全局）→ global only；店規則 → 喺 scope 內
  assertConfigScope(ctx, rule.clinicId);

  // ★ cwi-final S0-8（N-11）：B1 首啟用確認 — BEFORE_APPOINTMENT 規則第一次啟用（firstUseConfirmedAt
  //   為 null）必須帶確認（「確認診所冇其他渠道發預約提醒？」）→ 409；確認過一次以後唔再問。
  //   兼容兩口徑：v3 UI 帶 firstUseConfirmedAt（ISO 串）；新 spec 帶 firstUseConfirmed（boolean）。
  const hasFreshConfirm = body.firstUseConfirmed === true || typeof body.firstUseConfirmedAt === "string";
  if (body.enabled === true && rule.trigger === "BEFORE_APPOINTMENT" && !rule.firstUseConfirmedAt && !hasFreshConfirm) {
    return NextResponse.json(
      { error: "FIRST_USE_CONFIRM_REQUIRED", message: "確認診所冇其他渠道發預約提醒？" },
      { status: 409 }
    );
  }

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
  // ★ v3：全部硬性 L1（建議層）— L2 自動發已取消；DB 欄保留（enum 唔拆），engine 忽略
  if (body.level !== undefined) {
    const lv = String(body.level);
    if (lv !== "L1") return NextResponse.json({ error: "v3: 全部跟進 = L1 建議（冇 L2 自動發）" }, { status: 400 });
    data.level = lv;
  }
  if (body.maxSends !== undefined) {
    const v = Number(body.maxSends);
    if (!Number.isInteger(v) || v < 1 || v > 10) return NextResponse.json({ error: "maxSends 1-10" }, { status: 400 });
    data.maxSends = v;
  }
  // ★ v3 B-4②：dedupWindowDays（同病人同 trigger 終態後 N 日內唔再出）— 老細拍板 default 7
  if (body.dedupWindowDays !== undefined) {
    const v = Number(body.dedupWindowDays);
    if (!Number.isInteger(v) || v < 1 || v > 30) return NextResponse.json({ error: "dedupWindowDays 1-30" }, { status: 400 });
    data.dedupWindowDays = v;
  }
  // ★ v3 §3 B1：首啟用確認（「確認診所冇其他渠道發預約提醒？」）— UI 彈確認後帶 ISO 串
  if (typeof body.firstUseConfirmedAt === "string") {
    const d = new Date(body.firstUseConfirmedAt);
    if (Number.isNaN(d.getTime())) return NextResponse.json({ error: "bad firstUseConfirmedAt" }, { status: 400 });
    data.firstUseConfirmedAt = d;
  }
  // ★ cwi-final S0-8（N-11）：boolean 口徑 — server 用自己時鐘寫（唔信 client 時鐘）
  if (body.firstUseConfirmed === true) data.firstUseConfirmedAt = new Date();
  for (const k of ["cancelOnReply", "cancelOnBooking", "cancelOnArrival", "cancelOnResolved"] as const) {
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

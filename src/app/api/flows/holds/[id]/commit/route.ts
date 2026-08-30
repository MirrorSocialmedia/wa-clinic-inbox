/**
 * POST /api/flows/holds/[id]/commit — 預約卡「已入 Apricot · 完成」掣（providerslot-20260830 T3）
 *
 * 狀態機：只 HELD 可 commit（其餘 → 409）。
 * 1. RBAC：assertClinicAccess（clinicId 缺失 = 只 ADMIN）
 * 2. call workforce commit（MD 3.3：HELD → IN_APRICOT；冪等）
 * 3. 本地 → COMMITTED + committedAt + AuditLog(COMMIT_HOLD)
 *
 * workforce fail（404/409 = 已 RELEASED）→ 本地 EXPIRED + 200 {already}；
 * 其他 fail（離線/超時）→ 502 保持 HELD（可重試）。
 */
import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertClinicAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { commitHold, WorkforceApiError } from "@/lib/workforce/client";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;

  const hold = await prisma.flowHoldEvent.findUnique({ where: { id } });
  if (!hold) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (hold.clinicId) assertClinicAccess(ctx, hold.clinicId);
  else if (ctx.staff.role !== "ADMIN") return NextResponse.json({ error: "cross-clinic access denied" }, { status: 403 });

  if (hold.status !== "HELD") {
    return NextResponse.json({ error: `hold already ${hold.status}`, status: hold.status }, { status: 409 });
  }
  if (!hold.workforceHoldId) {
    return NextResponse.json({ error: "workforce hold id missing" }, { status: 500 });
  }

  let wf;
  try {
    wf = await commitHold(hold.workforceHoldId);
  } catch (err) {
    if (err instanceof WorkforceApiError && (err.status === 404 || err.status === 409)) {
      // workforce 端已放開（RELEASED/時間過）→ 本地 EXPIRED，卡轉「已過期」
      await prisma.flowHoldEvent.update({ where: { id: hold.id }, data: { status: "EXPIRED" } });
      log.info({ id, wfStatus: err.status }, "hold commit: workforce 已放開 → EXPIRED");
      return NextResponse.json({ ok: true, status: "EXPIRED", already: true });
    }
    log.warn({ id, err: err instanceof Error ? err.name : "?" }, "hold commit: workforce fail → 502（保持 HELD 可重試）");
    return NextResponse.json({ error: "workforce unavailable — 請重試" }, { status: 502 });
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.flowHoldEvent.update({
      where: { id: hold.id },
      data: { status: "COMMITTED", committedAt: now },
    }),
    prisma.auditLog.create({
      data: {
        staffId: ctx.staff.id,
        action: "COMMIT_HOLD",
        entity: "FlowHoldEvent",
        entityId: hold.id,
        meta: { holdId: hold.workforceHoldId, clinicCode: hold.clinicCode, date: hold.date } as object,
      },
    }),
  ]);
  log.info({ id, wfStatus: wf.status }, "hold commit: COMMITTED");
  return NextResponse.json({ ok: true, status: "COMMITTED", committedAt: now.toISOString() });
});

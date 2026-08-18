/**
 * POST /api/apricot/refresh — 員工手動 refresh 空檔（MD 任務 A：ADMIN/STAFF 本店）
 *
 * - RBAC：requireAuth + assertClinicAccess（STAFF 只准 refresh 自己店）
 * - 執行：enqueue apricot `sync-clinic`（concurrency=1 序列化；唔直接打 Apricot）
 * - 回傳 202（sync 喺 apricot worker 背景行；/api/admin/apricot-status 睇結果）
 */
import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertClinicAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { enqueueApricot } from "@/workers/apricot.worker";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const url = new URL(req.url);
  const clinicParam = url.searchParams.get("clinicId") ?? (ctx.staff.role === "STAFF" ? ctx.clinicId : "");
  if (!clinicParam) return NextResponse.json({ error: "clinicId required (ADMIN)" }, { status: 400 });

  const clinic = await prisma.clinic.findUnique({ where: { id: clinicParam } });
  if (!clinic) return NextResponse.json({ error: "clinic not found" }, { status: 404 });
  assertClinicAccess(ctx, clinic.id); // STAFF 別店 → 403

  const jobId = await enqueueApricot("sync-clinic", { clinicId: clinic.id, reason: "manual-refresh" });
  log.info({ clinic: clinic.code, staffId: ctx.staff.id, jobId }, "apricot: manual refresh enqueued");
  return NextResponse.json({ ok: true, jobId, status: "QUEUED" }, { status: 202 });
});

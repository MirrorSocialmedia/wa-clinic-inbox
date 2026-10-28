/**
 * ★ cwi-sales-20261028：/api/admin/sales/owners — 病人歸屬（GET = ADMIN；POST = 集團管理員）。
 *
 * GET ?state=PROTECTED|BOUND|POOL&salesStaffId= → { owners: OwnershipRow[], sales: [{id,name}] }
 * POST { action: "assign", patientApricotId, toStaffId, state: "BOUND"|"PROTECTED" }
 *      { action: "transfer", patientApricotId, toStaffId }
 *      { action: "release", patientApricotId }
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireAdmin, isGlobalAdmin } from "@/lib/rbac";
import { handle, toResponse } from "@/lib/api-error";
import { assignOwnership, listOwnerships, releaseOwnership, transferOwnership } from "@/lib/sales/admin";
import { SalesActionError } from "@/lib/sales/handover";

export const dynamic = "force-dynamic";

const STATES = ["PROTECTED", "BOUND", "POOL"] as const;
const postSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("assign"), patientApricotId: z.string().min(1).max(64), toStaffId: z.string().min(1), state: z.enum(["BOUND", "PROTECTED"]) }),
  z.object({ action: z.literal("transfer"), patientApricotId: z.string().min(1).max(64), toStaffId: z.string().min(1) }),
  z.object({ action: z.literal("release"), patientApricotId: z.string().min(1).max(64) }),
]);

export const GET = handle(async (req: NextRequest) => {
  await requireAdmin(req);
  const sp = req.nextUrl.searchParams;
  const stateRaw = sp.get("state");
  const state = stateRaw && (STATES as readonly string[]).includes(stateRaw) ? (stateRaw as (typeof STATES)[number]) : null;
  const [owners, sales] = await Promise.all([
    listOwnerships({ state, salesStaffId: sp.get("salesStaffId") || null }),
    prisma.staffUser.findMany({ where: { isSales: true, active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  return NextResponse.json({ owners, sales });
});

export const POST = handle(async (req: NextRequest) => {
  const admin = await requireAdmin(req);
  if (!isGlobalAdmin(admin)) return NextResponse.json({ error: "FORBIDDEN", message: "只有集團管理員可以改病人歸屬" }, { status: 403 });
  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);
  const b = parsed.data;
  try {
    if (b.action === "assign") await assignOwnership({ byStaffId: admin.staff.id, patientApricotId: b.patientApricotId, toStaffId: b.toStaffId, state: b.state });
    else if (b.action === "transfer") await transferOwnership({ byStaffId: admin.staff.id, patientApricotId: b.patientApricotId, toStaffId: b.toStaffId });
    else await releaseOwnership({ byStaffId: admin.staff.id, patientApricotId: b.patientApricotId });
  } catch (err) {
    if (err instanceof SalesActionError) return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    throw err;
  }
  return NextResponse.json({ ok: true });
});

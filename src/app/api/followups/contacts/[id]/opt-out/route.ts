import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, scopedClinicSet } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { applyFollowupOptOut, clearFollowupOptOut } from "@/lib/followup/opt-out";

/**
 * ★ cwi-followup-p3-20260916（MD §4.6：手動 toggle — 老細鐵律：opt-out 永遠優先）：
 *
 * PATCH /api/followups/contacts/:id/opt-out  body { optOut: true | false }
 *   true  → 標記（optOutSource = manual）— 所有 follow-up 永久跳過；
 *   false → 復原（staff 人手；audit 留痕 FOLLOWUP_OPT_OUT_CLEARED）。
 *   病人主動查詢嘅正常回覆完全唔受影響（只係唔再主動跟進）。
 *   權限：staff+（contact 所属 clinic scope 內）。
 */
export const dynamic = "force-dynamic";

export const PATCH = handle(async (req, { params }) => {
  const ctx = await requireAuth(req);
  if (ctx.staff.role === "SUPERVISOR") return NextResponse.json({ error: "read-only" }, { status: 403 }); // 全店唯讀
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { optOut?: boolean } | null;
  if (typeof body?.optOut !== "boolean") return NextResponse.json({ error: "optOut: true|false" }, { status: 400 });
  const contact = await prisma.contact.findUnique({ where: { id }, select: { id: true, clinicId: true } });
  if (!contact) return NextResponse.json({ error: "contact not found" }, { status: 404 });
  const clinicSet = scopedClinicSet(ctx);
  if (clinicSet && !clinicSet.includes(contact.clinicId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const result = body.optOut
    ? await applyFollowupOptOut({ contactId: id, source: "manual", staffId: ctx.staff.id })
    : await clearFollowupOptOut({ contactId: id, staffId: ctx.staff.id });
  return NextResponse.json(result);
});

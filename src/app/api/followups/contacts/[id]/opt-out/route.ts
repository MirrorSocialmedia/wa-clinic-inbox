import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, scopedClinicSet } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { applyFollowupOptOut, clearFollowupOptOut } from "@/lib/followup/opt-out";

/**
 * ★ cwi-followup-p3-20260916（MD §4.6：手動 toggle — 老細鐵律：opt-out 永遠優先）：
 *
 * PATCH /api/followups/contacts/:id/opt-out  body { optOut: true | false }
 *   true  → 標記（optOutSource = manual）— 所有主動訊息永久跳過（follow-up / 提醒 / template / AI AUTO）；
 *   false → 復原（★ wa-meta-compliance-20261016 B.3：必帶 consent.purpose — 來源/時間/用途 三要素
 *           落 ContactConsent 先清旗；唔准裸 flip 復活）。
 *   病人主動查詢時嘅 staff 正常回覆唔受影響（只係唔再主動跟進）。
 *   權限：staff+（contact 所属 clinic scope 內）。
 */
export const dynamic = "force-dynamic";

export const PATCH = handle(async (req, { params }) => {
  const ctx = await requireAuth(req);
  if (ctx.staff.role === "SUPERVISOR") return NextResponse.json({ error: "read-only" }, { status: 403 }); // 全店唯讀
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as {
    optOut?: boolean;
    consent?: { purpose?: unknown };
  } | null;
  if (typeof body?.optOut !== "boolean") return NextResponse.json({ error: "optOut: true|false" }, { status: 400 });
  const contact = await prisma.contact.findUnique({ where: { id }, select: { id: true, clinicId: true } });
  if (!contact) return NextResponse.json({ error: "contact not found" }, { status: 404 });
  const clinicSet = scopedClinicSet(ctx);
  if (clinicSet && !clinicSet.includes(contact.clinicId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (body.optOut) {
    const result = await applyFollowupOptOut({ contactId: id, source: "manual", staffId: ctx.staff.id });
    return NextResponse.json(result);
  }
  // ★ wa-meta-compliance-20261016（B.3）：重新啟用 = 只可經有效同意 — purpose 必填。
  const purpose = typeof body.consent?.purpose === "string" ? body.consent.purpose.trim() : "";
  if (!purpose) {
    return NextResponse.json(
      { error: "consent.purpose 必填 — 重新啟用主動聯絡需要記錄病人同意嘅用途（來源/時間/用途）" },
      { status: 400 }
    );
  }
  const result = await clearFollowupOptOut({
    contactId: id,
    staffId: ctx.staff.id,
    consent: { source: "STAFF_MANUAL", purpose },
  });
  return NextResponse.json(result);
});

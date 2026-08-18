import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertClinicAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";

/**
 * PATCH /api/conversations/[id]/drafts/[draftId] — 採用 draft（「一鍵採用」）。
 *
 * 語義：staff 決定用呢個建議 — 前端將 draftText 填入 composer（可再改）。
 * DB 狀態保持 PROPOSED（最終狀態由發送決定：SENT_AS_IS / SENT_EDITED，見 send route）；
 * 呢度寫 AuditLog(ADOPT_DRAFT) 做採用率統計 + 審計。
 *
 * 鐵律 2：採用 ≠ 發送。發出仍要 staff 按「發送」（sentByStaffId）。
 *
 * DELETE /api/conversations/[id]/drafts/[draftId] — 棄用 draft。
 *   PROPOSED → DISCARDED（200）；已 DISCARDED → 200（冪等）；SENT_* → 409（已發出，唔可棄）。
 *
 * 別店 → 403（assertClinicAccess，fail-closed）。
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; draftId: string }> };

export const PATCH = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id, draftId } = await ctx.params;
  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertClinicAccess(auth, conv.clinicId);
  const draft = await prisma.aiDraft.findFirst({ where: { id: draftId, conversationId: id } });
  if (!draft) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (draft.status === "DISCARDED") {
    return NextResponse.json({ error: "draft already discarded" }, { status: 409 });
  }
  if (draft.status !== "PROPOSED") {
    return NextResponse.json({ error: "draft already sent" }, { status: 409 });
  }

  // ★ 採用 ≠ 發送（鐵律 2）：只記 audit + 回傳 draftText 俾前端填 composer
  await prisma.auditLog.create({
    data: {
      staffId: auth.staff.id,
      action: "ADOPT_DRAFT",
      entity: "AiDraft",
      entityId: draft.id,
    },
  });
  log.info(
    { clinicId: conv.clinicId, conversationId: id, draftId, staffId: auth.staff.id },
    "draft adopted (composer fill; send 仍係人手)"
  );

  return NextResponse.json({
    ok: true,
    draftId: draft.id,
    draftText: draft.draftText,
    model: draft.model,
    latencyMs: draft.latencyMs,
    status: draft.status,
  });
});

export const DELETE = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id, draftId } = await ctx.params;
  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertClinicAccess(auth, conv.clinicId);
  const draft = await prisma.aiDraft.findFirst({ where: { id: draftId, conversationId: id } });
  if (!draft) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (draft.status === "SENT_AS_IS" || draft.status === "SENT_EDITED") {
    return NextResponse.json({ error: "draft already sent" }, { status: 409 });
  }
  if (draft.status === "PROPOSED") {
    await prisma.aiDraft.update({ where: { id: draft.id }, data: { status: "DISCARDED" } });
    await prisma.auditLog.create({
      data: {
        staffId: auth.staff.id,
        action: "DISCARD_DRAFT",
        entity: "AiDraft",
        entityId: draft.id,
      },
    });
    log.info(
      { clinicId: conv.clinicId, conversationId: id, draftId, staffId: auth.staff.id },
      "draft discarded"
    );
  }
  // PROPOSED→DISCARDED 或已 DISCARDED：都 200（冪等）
  return NextResponse.json({ ok: true, draftId: draft.id, status: "DISCARDED" });
});

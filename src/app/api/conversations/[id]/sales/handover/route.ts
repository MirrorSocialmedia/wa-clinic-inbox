/**
 * ★ cwi-sales-20261028：/api/conversations/[id]/sales/handover — 綁定／保護中病人對話嘅轉交。
 *
 * POST body
 *   { action: "delegate", toStaffId, kind: "ONCE" | "PERMANENT" } — 負責銷售轉交（ONCE = 24 小時）
 *   { action: "request" }                                          — 其他同事請負責銷售轉交（通知）
 *   { action: "force", toStaffId?, reason? }                       — ADMIN / SUPERVISOR 強制接手（24 小時）
 *   { action: "revoke", delegationId }                             — 負責銷售 / ADMIN 收回
 * → { sales: SalesView }
 *
 * 權限：requireAuth + 對話 scope；SUPERVISOR 只可以 force（揀同事），其他動作 403。
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireAuth, assertConversationAccess, assertCanWriteConversation } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { SalesActionError, delegateConversation, forceTakeover, requestHandover, revokeDelegation, salesView } from "@/lib/sales/handover";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("delegate"), toStaffId: z.string().min(1), kind: z.enum(["ONCE", "PERMANENT"]) }),
  z.object({ action: z.literal("request") }),
  z.object({ action: z.literal("force"), toStaffId: z.string().min(1).nullish(), reason: z.string().max(200).nullish() }),
  z.object({ action: z.literal("revoke"), delegationId: z.string().min(1) }),
]);

export const POST = handle(async (req: NextRequest, ctxP: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctxP.params;
  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  await assertConversationAccess(auth, conv);
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const body = parsed.data;
  if (body.action !== "force") assertCanWriteConversation(auth); // SUPERVISOR 只可以強制接手（揀同事）
  const viewer = { id: auth.staff.id, role: auth.staff.role };
  try {
    if (body.action === "delegate") await delegateConversation({ conversationId: conv.id, viewer, toStaffId: body.toStaffId, kind: body.kind });
    else if (body.action === "request") await requestHandover({ conversationId: conv.id, viewer });
    else if (body.action === "force") await forceTakeover({ conversationId: conv.id, viewer, toStaffId: body.toStaffId ?? null, reason: body.reason ?? null });
    else await revokeDelegation({ conversationId: conv.id, viewer, delegationId: body.delegationId });
  } catch (err) {
    if (err instanceof SalesActionError) return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    throw err;
  }
  return NextResponse.json({ sales: await salesView(conv.id, viewer) });
});

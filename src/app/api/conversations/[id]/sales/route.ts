/**
 * ★ cwi-sales-20261028：/api/conversations/[id]/sales — 對話右欄「銷售」。
 *
 * GET   → { sales: SalesView }（歸屬、轉交、可唔可以覆、可唔可以強制接手、意向）
 * PATCH body { intent: "HIGH" | "MEDIUM" | "LOW" | null } → 設／清意向（只限銷售人員；鎖住而唔係負責人 → 423）
 *
 * 權限：requireAuth + 對話 scope；PATCH SUPERVISOR 唯讀（403）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireAuth, assertConversationAccess, assertCanWriteConversation } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { INTENT_LEVELS } from "@/lib/sales/core";
import { SalesActionError, salesView, setSalesIntent } from "@/lib/sales/handover";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z.object({ intent: z.enum(INTENT_LEVELS).nullable() });

export const GET = handle(async (req: NextRequest, ctxP: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctxP.params;
  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  await assertConversationAccess(auth, conv);
  return NextResponse.json({ sales: await salesView(conv.id, { id: auth.staff.id, role: auth.staff.role }) });
});

export const PATCH = handle(async (req: NextRequest, ctxP: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctxP.params;
  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  await assertConversationAccess(auth, conv);
  assertCanWriteConversation(auth);
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    await setSalesIntent(conv.id, { id: auth.staff.id, role: auth.staff.role }, parsed.data.intent);
  } catch (err) {
    if (err instanceof SalesActionError) return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    throw err;
  }
  return NextResponse.json({ sales: await salesView(conv.id, { id: auth.staff.id, role: auth.staff.role }) });
});

/**
 * ★ cwi-reminder-20261025：/api/conversations/[id]/reminder —「⏰ 待跟進」跟進提醒（取代「等回覆」狀態）。
 *
 * POST  body { days?: 0–180 | date?: "YYYY-MM-DD", reason?: string(≤100), target?: "me" | "assignee" }
 *       → 設定／改提醒（每個對話最多一個）；target 預設 "me"（設提醒嗰個人）。→ { reminder }
 * PATCH body { action: "done" | "snooze" | "cancel", days?: 1–180（snooze 預設 3）}
 *       → 已跟進／再延／取消。→ { reminder } ｜ { status }；冇未處理提醒 → 404
 *
 * 權限：requireAuth + 對話 scope；SUPERVISOR 唯讀（403）。詳細語義見 lib/followup/reminder.ts。
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireAuth, assertConversationAccess, assertCanWriteConversation } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { REMINDER_REASON_MAX, actOnReminder, reminderDateFromBody, setReminder } from "@/lib/followup/reminder";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const postSchema = z.object({
  days: z.number().int().optional(),
  date: z.string().optional(),
  reason: z.string().max(REMINDER_REASON_MAX).nullish(),
  target: z.enum(["me", "assignee"]).optional(),
});
const patchSchema = z.object({
  action: z.enum(["done", "snooze", "cancel"]),
  days: z.number().int().min(1).max(180).optional(),
});

async function load(req: NextRequest, ctxP: Ctx) {
  const auth = await requireAuth(req);
  const { id } = await ctxP.params;
  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return { auth, conv: null };
  await assertConversationAccess(auth, conv);
  assertCanWriteConversation(auth); // SUPERVISOR 唯讀
  return { auth, conv };
}

export const POST = handle(async (req: NextRequest, ctxP: Ctx) => {
  const { auth, conv } = await load(req, ctxP);
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const date = reminderDateFromBody(parsed.data);
  if (!date) return NextResponse.json({ error: "bad_date", message: "揀今日至 180 日內嘅日子" }, { status: 400 });
  const reason = parsed.data.reason?.trim() || null;
  const reminder = await setReminder({
    conversationId: conv.id,
    staffId: auth.staff.id,
    date,
    reason,
    target: parsed.data.target ?? "me",
  });
  return NextResponse.json({ reminder });
});

export const PATCH = handle(async (req: NextRequest, ctxP: Ctx) => {
  const { auth, conv } = await load(req, ctxP);
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const r = await actOnReminder({ conversationId: conv.id, staffId: auth.staff.id, action: parsed.data.action, days: parsed.data.days });
  if (!r) return NextResponse.json({ error: "no_reminder" }, { status: 404 });
  return "status" in r ? NextResponse.json(r) : NextResponse.json({ reminder: r });
});

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertClinicAccess } from "@/lib/rbac";
import { handle, toResponse } from "@/lib/api-error";
import { publishNotify } from "@/lib/notify";

/**
 * POST /api/conversations/[id]/notes — 內部備註（MD §4.1）。
 *
 * body: { body: string (1..2000), mentions?: string[] (staffId) }
 *
 * 語義：
 * - Message(channel=INTERNAL, direction=OUT, type=note, waMessageId=null, status=SENT)
 *   — 重用 Message 表 = 同病人訊息同等保護（at-rest 加密 / log redaction / RBAC / retention）。
 * - ★ 物理隔離：唔入 outbound queue、唔觸發 AI（ai.worker 只撈 direction=IN && channel=API）、
 *   唔入對答庫候選（ai.worker 只處理 API inbound）— outbound.worker / graph.ts 零改動。
 * - ★ touch 只更新 lastMessageAt（GREATEST）— 唔加 unreadCount（病人冇新嘢）。
 * - ★ Send Lock 唔適用：任何人（包括 ADMIN）都攞到 423 都可以發 INTERNAL note（MD §3.2）。
 * - RBAC：assertClinicAccess（STAFF 別店 → 403）；ADMIN 跨店照舊。
 * - mentions：只保留同店 active staffId（UI autocomplete 只出合法值；非法值靜默 drop）。
 * - socket：note:new（room clinic:{id}，payload 零內文 — 內容由 client 撳完拉）。
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({
  body: z.string().min(1).max(2000),
  mentions: z.array(z.string().min(1)).max(50).optional(),
});

export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);

  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertClinicAccess(auth, conv.clinicId); // STAFF 別店 → 403

  // mentions：只保留同店 active staff（非法值靜默 drop — 防注入別店/停用 staff）
  let mentions: string[] = [];
  if (parsed.data.mentions?.length) {
    const staff = await prisma.staffUser.findMany({
      where: { id: { in: parsed.data.mentions }, active: true, clinicId: conv.clinicId },
      select: { id: true },
    });
    mentions = staff.map((s) => s.id);
  }

  const now = new Date();
  const msg = await prisma.message.create({
    data: {
      conversationId: conv.id,
      direction: "OUT",
      channel: "INTERNAL",
      type: "note",
      body: parsed.data.body,
      status: "SENT",
      waMessageId: null, // INTERNAL 永唔出 Graph API — 冇 wamid
      sentByStaffId: auth.staff.id,
      mentions,
      waTimestamp: now,
    },
  });

  // ★ touch lastMessageAt only — 唔加 unreadCount（MD §4.1：病人冇新訊息）
  await prisma.$executeRaw`UPDATE "Conversation" SET "lastMessageAt" = GREATEST("lastMessageAt", ${now}) WHERE "id" = ${conv.id}`;

  // socket：同店全員收 note:new（零內文 — 內容由 client 拉；payload 只係 id + 元數據）
  publishNotify(conv.clinicId, "note:new", {
    conversationId: conv.id,
    clinicId: conv.clinicId,
    messageId: msg.id,
  });

  // log：零內文（bodyLen + mentions count 只）— 符合 D5 PII 鐵律
  log.info(
    { clinicId: conv.clinicId, conversationId: conv.id, staffId: auth.staff.id, messageId: msg.id, bodyLen: parsed.data.body.length, mentions: mentions.length },
    "note: internal note created"
  );

  return NextResponse.json({ ok: true, messageId: msg.id }, { status: 201 });
});

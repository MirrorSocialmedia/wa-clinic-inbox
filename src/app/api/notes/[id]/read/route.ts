import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { requireAuth, assertClinicAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { publishNotify } from "@/lib/notify";

/**
 * POST /api/notes/[id]/read — 內部備註已讀回執（MD §4.2 / H2）。
 *
 * 語義：
 * - 只對 channel=INTERNAL 嘅 note 生效（其他 message → 400 "not a note"）。
 * - upsert NoteReadReceipt（@@unique([messageId, staffId])）— 冪等：重複 read 唔新增 row、
 *   readAt 保留首次已讀時間（tick hover 顯示「邊個・幾點」用首次時間，似 WhatsApp）。
 * - RBAC：assertClinicAccess — STAFF 跨店 → 403（ADMIN 跨店照舊，同其他 route 一致）。
 * - socket：note:read → room clinic:{id}（payload **零內文** — 只 id/時間戳元數據；
 *   收方 client 即時重算 tick）。
 *
 * 回應帶 tick 快照（server 端為準 — UI 同 e2e 都用同一個判定）：
 * - requiredStaff = mentions 非空 → mentions；否則 → [現任 assigneeId]（無 mention → 走 assignee）
 * - allRead = requiredStaff 全部有回執（requiredStaff 為空 → false，永遠灰 ✓）
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;

  const msg = await prisma.message.findUnique({ where: { id } });
  if (!msg) return NextResponse.json({ error: "not found" }, { status: 404 });
  // schema 設計：Message 無 @relation（conversationId 純欄）→ 分開查
  const conv = await prisma.conversation.findUnique({
    where: { id: msg.conversationId },
    select: { id: true, clinicId: true, assigneeId: true },
  });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  assertClinicAccess(auth, conv.clinicId); // STAFF 別店 → 403
  if (msg.channel !== "INTERNAL" || msg.type !== "note") {
    return NextResponse.json({ error: "not a note" }, { status: 400 });
  }

  // 冪等 upsert：重複 read 唔新增 row；readAt 保留首次（update: {} 唔覆蓋）
  const receipt = await prisma.noteReadReceipt.upsert({
    where: { messageId_staffId: { messageId: msg.id, staffId: auth.staff.id } },
    update: {},
    create: { messageId: msg.id, staffId: auth.staff.id },
  });

  // tick 快照：required = mentions（非空）否則現任 assignee
  const allReceipts = await prisma.noteReadReceipt.findMany({
    where: { messageId: msg.id },
    select: { staffId: true, readAt: true },
  });
  const readBy = allReceipts.map((r) => ({ staffId: r.staffId, readAt: r.readAt.toISOString() }));
  const requiredStaff = msg.mentions.length > 0 ? msg.mentions : conv.assigneeId ? [conv.assigneeId] : [];
  const readSet = new Set(allReceipts.map((r) => r.staffId));
  const allRead = requiredStaff.length > 0 && requiredStaff.every((s) => readSet.has(s));

  // socket：全店收 note:read（零內文 — tick 即時更新；content 唔喺度）
  publishNotify(conv.clinicId, "note:read", {
    conversationId: conv.id,
    clinicId: conv.clinicId,
    messageId: msg.id,
    staffId: auth.staff.id,
    readAt: receipt.readAt.toISOString(),
  });

  // log：零內文（id 只）
  log.info(
    { clinicId: conv.clinicId, conversationId: conv.id, messageId: msg.id, staffId: auth.staff.id },
    "note: read receipt recorded"
  );

  return NextResponse.json({
    ok: true,
    readAt: receipt.readAt.toISOString(),
    note: { id: msg.id, mentions: msg.mentions, sentByStaffId: msg.sentByStaffId },
    assigneeId: conv.assigneeId,
    requiredStaff,
    readBy,
    allRead,
  });
});

import { NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import { assertClinicAccess, type AuthContext } from "@/lib/rbac";
import { resolveListScope, baseScope, decodeCursor, encodeCursor, afterCursor } from "@/lib/inbox/conversation-list";
import { shouldClearUnread, MARK_ALL_READ_LIMIT } from "@/lib/inbox/mark-read";
import { publishStaffNotify } from "@/lib/notify";

/**
 * POST /api/conversations/mark-all-read — 一鍵已讀（cwi-ux UX-01 §1.2-B）。
 *
 * 權限：所有已登入角色（已讀係個人狀態 — 同逐條 PATCH markRead 同水位，SUPERVISOR 亦放行）。
 * body：`{ clinicId?: string, cursor?: string }`（冇 clinicId = 我可見範圍全部；ADMIN 跟頂部
 *   「全部診所」下拉；受限角色砌外範圍 → 403 assertClinicAccess — 同列表 API 同守門。
 *   cursor = 列表同款 keyset（base64url {u,t,id}）— 只喺 capped 後跟住用）。
 *
 * 範圍：**同收件箱列表一樣嘅 scope 函數**（resolveListScope + baseScope 單一來源 —
 *   唔自己再寫 where，跨店 scope bug 已經出過好多次 — FX-03/QA-03 教訓）。
 *
 * 寫法 = 逐條 markRead 一模一樣嘅兩層規則（mark-read.ts 共用 function）：
 * ① 所有角色：bulk upsert ConversationRead（個人已讀 — 只清自己 myUnread）
 * ② Conversation.unreadCount（全店「未處理」/公海 SLA）：只清 shouldClearUnread 命中嘅
 *    （我係負責人 / 未指派且我係 STAFF/ADMIN；SUPERVISOR 唔清）。
 *
 * 上限：一次最多 MARK_ALL_READ_LIMIT（500）條 — 排序同列表一致（urgent desc, lastMessageAt
 *   desc, id desc）→ 最新優先；超過 → capped=true + nextCursor（列表同款 keyset）→
 *   client 用 cursor 跟住撳剩餘（client 自動 loop 最多 5 輪）。無 cursor 重調 = 再標前 500
 *   （冪等：upsert 只刷新 lastReadAt，已讀唔變未讀）。
 *
 * audit：CONVERSATIONS_MARK_ALL_READ（staffId + count/cleared — metadata only，零 PII）。
 * socket：`conversation:read` 定向 `staff:{staffId}` room（本人其他裝置同步 badge；
 *   發起裝置已本地清過 — 重複收 = 冪等）。
 *
 * ★ cwi-qa FX-16：handler core 放呢度（route module 只准 route field 導出 —
 *   unknown named export = Next 15 build 硬紅）。
 */

const bodySchema = z.object({
  clinicId: z.string().min(1).optional(),
  cursor: z.string().min(1).optional(),
});

export interface MarkAllReadResult {
  /** 已 upsert ConversationRead 嘅對話數（≤500） */
  marked: number;
  /** 層②清咗 unreadCount 嘅對話數（我負責 / 未指派且 STAFF/ADMIN） */
  unreadCleared: number;
  /** scope 內超過上限 — 仲有嘢未清（跟住用 nextCursor） */
  capped: boolean;
  /** capped=true 時：下一批 keyset cursor（列表同款） */
  nextCursor?: string;
}

export async function markAllRead(ctx: AuthContext, body: unknown): Promise<NextResponse> {
  const parsed = bodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body（clinicId?/cursor?: string）" }, { status: 400 });
  }
  const clinicParam = parsed.data.clinicId ?? null;
  const cursor = decodeCursor(parsed.data.cursor ?? null);
  if (parsed.data.cursor && !cursor) {
    return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
  }
  // 範圍 guard（同列表 API 同守門）：外範圍 clinicId → 403
  if (clinicParam) assertClinicAccess(ctx, clinicParam);

  // ★ 範圍 = 列表同一份 scope 函數（baseScope 含 店範圍 ∪ 我係 assignee ∪ 派俾我）
  const s = await resolveListScope(ctx, clinicParam);
  const rows = await prisma.conversation.findMany({
    where: { AND: [baseScope(s), ...(cursor ? [afterCursor(cursor, true)] : [])] },
    orderBy: [{ urgent: "desc" }, { lastMessageAt: "desc" }, { id: "desc" }],
    take: MARK_ALL_READ_LIMIT + 1,
    select: { id: true, clinicId: true, assigneeId: true, urgent: true, lastMessageAt: true },
  });
  const capped = rows.length > MARK_ALL_READ_LIMIT;
  const page = capped ? rows.slice(0, MARK_ALL_READ_LIMIT) : rows;
  if (page.length === 0) {
    return NextResponse.json({ marked: 0, unreadCleared: 0, capped: false } satisfies MarkAllReadResult);
  }
  const now = new Date();
  // ① 所有角色：bulk upsert ConversationRead（冪等；重標只刷新 lastReadAt — 同逐條 upsert 同語義）
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ConversationRead" ("conversationId", "staffId", "lastReadAt")
     SELECT v, $1, $2
     FROM unnest($3::text[]) AS v
     ON CONFLICT ("conversationId", "staffId") DO UPDATE SET "lastReadAt" = EXCLUDED."lastReadAt"`,
    ctx.staff.id,
    now,
    page.map((r) => r.id),
  );

  // ② 全店 unreadCount — 同逐條 markRead 同一個判定 function（shouldClearUnread 單一來源）
  const clearIds = page.filter((r) => shouldClearUnread(r, ctx.staff)).map((r) => r.id);
  let unreadCleared = 0;
  if (clearIds.length > 0) {
    unreadCleared = (await prisma.conversation.updateMany({
      where: { id: { in: clearIds } },
      data: { unreadCount: 0 },
    })).count;
  }

  // audit log（metadata only — staffId + count，零 PII）
  await prisma.auditLog.create({
    data: {
      staffId: ctx.staff.id,
      action: "CONVERSATIONS_MARK_ALL_READ",
      entity: "Conversation",
      meta: {
        count: page.length,
        unreadCleared,
        capped,
        ...(clinicParam ? { clinicId: clinicParam } : {}),
        ...(cursor ? { cursorPage: true } : {}),
      },
    },
  });

  // socket：本人其他裝置同步 badge（staff:{staffId} room；clinicId 只係 log metadata）
  publishStaffNotify(ctx.staff.id, page[0]?.clinicId ?? "", "conversation:read", {
    conversationIds: page.map((r) => r.id),
    unreadClearedIds: clearIds,
    eventId: randomUUID(),
  });

  return NextResponse.json({
    marked: page.length,
    unreadCleared,
    capped,
    ...(capped && page.length > 0 ? { nextCursor: encodeCursor(page[page.length - 1]) } : {}),
  } satisfies MarkAllReadResult);
}

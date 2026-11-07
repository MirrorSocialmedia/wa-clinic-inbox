/**
 * ★ cwi-search-20261107：GET /api/conversations/[id]/search?q=&internal=1 — 對話內搜尋（只搵呢個對話）。
 *
 * - 權限：同開對話一樣（assertConversationAccess；外店 403、唔存在 404）
 * - 搵：訊息內文（文字、相片／文件說明、AI／同事覆）ILIKE（萬用字 escape）；作廢訊息唔計
 * - 內部備註：預設唔搵；internal=1 先包
 * - 回傳：命中（舊 → 新，最多 500）{ id, createdAt, waTimestamp, direction, channel, type, snippet }
 *   + total（真實命中數，可能 > 500）。前端 ▲▼ 逐個跳（跳轉用 /messages?until=）
 * - statement_timeout 3s（保護 DB）；每人每分鐘 60 次
 */
import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, assertConversationAccess } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { hit } from "@/lib/rate-limit";
import { escapeLike, snippetAround } from "@/lib/search/snippet";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const MAX_HITS = 500;

interface Row {
  id: string;
  createdAt: Date;
  waTimestamp: Date;
  direction: string;
  channel: string;
  type: string;
  body: string | null;
}

export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  const conv = await prisma.conversation.findUnique({ where: { id } });
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  await assertConversationAccess(auth, conv);
  if (!(await hit(`convsearch:${auth.staff.id}`, 60, 60))) return NextResponse.json({ error: "too many attempts", message: "搵得太快，等一陣再試" }, { status: 429 });
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return NextResponse.json({ error: "q required", message: "請輸入要搵嘅字" }, { status: 400 });
  if (q.length > 100) return NextResponse.json({ error: "q too long", message: "搜尋字太長（最多 100 字）" }, { status: 400 });
  const includeInternal = url.searchParams.get("internal") === "1";
  const qEsc = escapeLike(q);
  let rows: Row[];
  let total: number;
  try {
    [rows, total] = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '3s'");
      const r = await tx.$queryRaw<Row[]>`
        SELECT id, "createdAt", "waTimestamp", direction::text AS direction, channel::text AS channel, type, left(body, 2000) AS body
        FROM "Message"
        WHERE "conversationId" = ${id}
          AND "voidedAt" IS NULL
          AND (${includeInternal} OR channel <> 'INTERNAL')
          AND coalesce(body, '') ILIKE '%' || ${qEsc} || '%'
        ORDER BY "createdAt" DESC, id DESC
        LIMIT ${MAX_HITS}`;
      const c = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM "Message"
        WHERE "conversationId" = ${id}
          AND "voidedAt" IS NULL
          AND (${includeInternal} OR channel <> 'INTERNAL')
          AND coalesce(body, '') ILIKE '%' || ${qEsc} || '%'`;
      return [r, Number(c[0]?.n ?? 0)] as const;
    });
  } catch (e) {
    if (e instanceof Error && e.message.includes("statement timeout")) return NextResponse.json({ error: "search timed out", message: "搜尋太耐，請試更長嘅字" }, { status: 504 });
    throw e;
  }
  const hits = rows
    .reverse()
    .map((r) => ({ id: r.id, createdAt: r.createdAt, waTimestamp: r.waTimestamp, direction: r.direction, channel: r.channel, type: r.type, snippet: snippetAround(r.body, q) }));
  return NextResponse.json({ q, total, hits });
});

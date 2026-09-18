/**
 * /api/admin/quotes — cwi-followup-p4-20260916 S6：報價確認隊列。
 *
 * MD §5.3/S3：CWM 抽到嘅報價項目（per patient + item + amount + certainty + status）
 * 入隊列等醫生／護士 ✓ 收貨 / ✎ 改 / ✗ 丟；收貨可「順手教字典」（teachTerm → CWM ClinicalTermMap）。
 *
 * GET  ?status=pending,confirmed,corrected&limit=200 → { v:1, quotes:[...] }（零原始電話）
 * POST { id, action: confirm|correct|discard, fields?, teachTerm?, correctionNote? }
 *   → { v:1, id, status, termMapUpserted }
 *
 * RBAC：requireAuth（隊列係日常臨床操作 — 醫生／護士）；decidedBy = staff.id（opaque 入 CWM）。
 *
 * ★ cwi-final S0-7（audit3 P0-09 → P1 + D-5）：
 * - GET：受限用戶（非 ALL / 非 SUPERVISOR）只見到自己 scope 內 clinic code 嘅報價
 *   （workforce 端未有 clinic filter — S5-13 會加；而家 server-side filter 兜底）。
 * - POST：assertCanWriteConversation（SUPERVISOR 唯讀 → 403）+ scope 內報價先可決定（403）。
 * - D-5：teachTerm（全局術語字典）只限全集團 ADMIN（ADMIN + scopeType ALL）— 其他角色
 *   照做決定但 teachTerm 唔送（回 teachTermIgnored=true 叫 UI 提示）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAuth, scopedClinicSet, assertCanWriteConversation, type AuthContext } from "@/lib/rbac";
import prisma from "@/lib/prisma";
import { handle } from "@/lib/api-error";
import { fetchQuotes, decideQuote, WorkforceApiError } from "@/lib/workforce/client";

export const dynamic = "force-dynamic";

/** ★ cwi-final S0-7：scope 內 clinic code 集合（null = 全店 — SUPERVISOR / ALL）。 */
async function scopedCodes(ctx: AuthContext): Promise<Set<string> | null> {
  const set = scopedClinicSet(ctx);
  if (set === null) return null;
  const rows = await prisma.clinic.findMany({ where: { id: { in: set } }, select: { code: true } });
  return new Set(rows.map((r) => r.code));
}

export const GET = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const sp = new URL(req.url).searchParams;
  const status = sp.get("status") ?? undefined;
  const limit = sp.get("limit") ? Math.min(Number(sp.get("limit")) || 200, 500) : 200;
  const codes = await scopedCodes(ctx);
  // workforce 未支援 clinic filter（W 側 S5-13 會加）→ 受限用戶攞 500 條再 filter
  const data = await fetchQuotes({ status, limit: codes ? 500 : limit });
  const quotes = codes ? data.quotes.filter((q) => codes.has(q.clinicCode)).slice(0, limit) : data.quotes;
  return NextResponse.json({ ...data, quotes });
});

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  assertCanWriteConversation(ctx); // ★ cwi-final S0-7：SUPERVISOR 唯讀
  const body = (await req.json()) as {
    id: string;
    action: "confirm" | "correct" | "discard";
    fields?: { amountMin?: number; amountMax?: number; termShorthand?: string | null; nameCn?: string; text?: string; correctionNote?: string };
    teachTerm?: { shorthand: string; nameCn: string; nameEn?: string; usedFor?: string[] };
    correctionNote?: string;
  };
  if (!body.id || !["confirm", "correct", "discard"].includes(body.action)) {
    return NextResponse.json({ error: "id + action(confirm|correct|discard) required" }, { status: 400 });
  }
  const codes = await scopedCodes(ctx);
  if (codes) {
    // workforce 未有 GET /quotes/{id}（S5-13 會加）→ 暫時用 pending+confirmed+corrected 500 條搵
    const all = await fetchQuotes({ status: "pending,confirmed,corrected", limit: 500 });
    const q = all.quotes.find((x) => x.id === body.id);
    if (!q || !codes.has(q.clinicCode)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // ★ D-5：全局術語字典只限全集團 ADMIN（S3-4 同源）
  const canTeach = ctx.staff.role === "ADMIN" && ctx.scopeType === "ALL";
  try {
    const data = await decideQuote(body.id, {
      action: body.action,
      // ★ audit3：workforce decision/route.ts:94 對 correct 讀 body.fields.correctionNote
      //   （header 註釋寫錯）→ 兩個位都送，兼容兩口徑。
      fields: body.fields ? { ...body.fields, ...(body.action === "correct" && body.correctionNote ? { correctionNote: body.correctionNote } : {}) } : undefined,
      teachTerm: canTeach ? body.teachTerm : undefined,
      correctionNote: body.correctionNote,
      decidedBy: ctx.staff.id,
    });
    return NextResponse.json({ ...data, teachTermIgnored: !!body.teachTerm && !canTeach });
  } catch (e) {
    if (e instanceof WorkforceApiError) {
      return NextResponse.json({ error: e.code ?? "workforce error", status: e.status }, { status: e.status });
    }
    throw e;
  }
});

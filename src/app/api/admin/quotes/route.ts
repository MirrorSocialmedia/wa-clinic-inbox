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
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { fetchQuotes, decideQuote, WorkforceApiError } from "@/lib/workforce/client";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const sp = new URL(req.url).searchParams;
  const status = sp.get("status") ?? undefined;
  const limit = sp.get("limit") ? Math.min(Number(sp.get("limit")) || 200, 500) : 200;
  const data = await fetchQuotes({ status, limit });
  return NextResponse.json(data);
});

export const POST = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const body = (await req.json()) as {
    id: string;
    action: "confirm" | "correct" | "discard";
    fields?: { amountMin?: number; amountMax?: number; termShorthand?: string | null; nameCn?: string; text?: string };
    teachTerm?: { shorthand: string; nameCn: string; nameEn?: string; usedFor?: string[] };
    correctionNote?: string;
  };
  if (!body.id || !["confirm", "correct", "discard"].includes(body.action)) {
    return NextResponse.json({ error: "id + action(confirm|correct|discard) required" }, { status: 400 });
  }
  try {
    const data = await decideQuote(body.id, {
      action: body.action,
      fields: body.fields,
      teachTerm: body.teachTerm,
      correctionNote: body.correctionNote,
      decidedBy: ctx.staff.id,
    });
    return NextResponse.json(data);
  } catch (e) {
    if (e instanceof WorkforceApiError) {
      return NextResponse.json({ error: e.code ?? "workforce error", status: e.status }, { status: e.status });
    }
    throw e;
  }
});

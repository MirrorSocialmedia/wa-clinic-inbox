/**
 * /api/admin/clinical-terms — cwi-followup-p4-20260916 S6：術語對照表（醫生／護士可編輯）。
 *
 * MD §5.3：零技術詞 UI（「速記 → 標準名稱 · 用喺」）；解析規則本身（牙位／金額／否定詞）
 * 唔可編輯 —— 只有詞表可改。
 *
 * GET → { v:1, terms:[{ shorthand, nameCn, nameEn, usedFor, active, updatedAt }] }
 * PUT { terms:[{ shorthand, nameCn, nameEn?, usedFor?, active? }] } → 同 GET
 *   - 冪等 upsert（CWM 側按 shorthand）
 *   - 零 PII；經 workforce external API（scope 守門喺 CWM 端）
 *
 * RBAC：requireAuth（醫生／護士 = 活躍 staff 皆可編輯 — MD §5.3 口徑）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { fetchTermMap, putTermMap, WorkforceApiError } from "@/lib/workforce/client";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const data = await fetchTermMap();
  return NextResponse.json(data);
});

export const PUT = handle(async (req: NextRequest) => {
  const ctx = await requireAuth(req);
  const body = (await req.json()) as {
    terms?: { shorthand: string; nameCn: string; nameEn?: string | null; usedFor?: string[]; active?: boolean }[];
  };
  if (!Array.isArray(body.terms) || body.terms.length === 0) {
    return NextResponse.json({ error: "terms required" }, { status: 400 });
  }
  try {
    const data = await putTermMap(body.terms);
    return NextResponse.json({ ...data, decidedBy: ctx.staff.id });
  } catch (e) {
    if (e instanceof WorkforceApiError) {
      return NextResponse.json({ error: e.code ?? "workforce error", status: e.status }, { status: e.status });
    }
    throw e;
  }
});

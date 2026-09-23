/**
 * /api/admin/clinical-terms — cwi-followup-p4-20260916 S6：術語對照表（讀：全部員工；改：只限全集團 ADMIN（D-5，2026-09-17））。
 *
 * MD §5.3：零技術詞 UI（「速記 → 標準名稱 · 用喺」）；解析規則本身（牙位／金額／否定詞）
 * 唔可編輯 —— 只有詞表可改。
 *
 * GET → { v:1, terms:[{ shorthand, nameCn, nameEn, usedFor, active, updatedAt }] }
 * PUT { terms:[{ shorthand, nameCn, nameEn?, usedFor?, active? }] } → 同 GET
 *   - 冪等 upsert（CWM 側按 shorthand）
 *   - 零 PII；經 workforce external API（scope 守門喺 CWM 端）
 *
 * RBAC：讀 = requireAuth（報價卡／跟進要顯示標準名）；改 = requireGlobalAdmin（★ cwi-final S3-4（D-5））。
 */
import { type NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, requireGlobalAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { fetchTermMap, putTermMap, WorkforceApiError } from "@/lib/workforce/client";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  await requireAuth(req);
  const data = await fetchTermMap();
  return NextResponse.json(data);
});

export const PUT = handle(async (req: NextRequest) => {
  const ctx = await requireGlobalAdmin(req); // ★ cwi-final S3-4（D-5）：只限全集團 ADMIN
  const body = (await req.json()) as {
    terms?: { shorthand: string; nameCn: string; nameEn?: string | null; usedFor?: string[]; active?: boolean }[];
  };
  if (!Array.isArray(body.terms) || body.terms.length === 0) {
    return NextResponse.json({ error: "terms required" }, { status: 400 });
  }
  try {
    const data = await putTermMap(body.terms, ctx.staff.id);
    // ★ cwi-final S3-4（D-5）：審計留痕（零 PII：只記數量 + shorthand 列表前 50）
    await prisma.auditLog.create({
      data: { staffId: ctx.staff.id, action: "CLINICAL_TERMS_UPDATE", entity: "ClinicalTermMap", entityId: "global",
              meta: { count: body.terms.length, shorthands: body.terms.map((t) => t.shorthand).slice(0, 50).join(",") } as object },
    }).catch(() => undefined);
    return NextResponse.json({ ...data, decidedBy: ctx.staff.id });
  } catch (e) {
    if (e instanceof WorkforceApiError) {
      return NextResponse.json({ error: e.code ?? "workforce error", status: e.status }, { status: e.status });
    }
    throw e;
  }
});

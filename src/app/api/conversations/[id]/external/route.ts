/**
 * ★ cwi-workgroup-p2-20261105：標記外部人（Lab 師傅、供應商 — 唔係病人）。
 * POST   { name, org? } → 對話搬去「工作群 → 外部對話」；唔再觸發 AI／預約／銷售／跟進
 * DELETE                → 取消標記，返返收件箱
 * GET                   → { external: { name, org } | null }（對話頂部橫額用；冇權 403）
 * 權限：睇得到 + 寫得到呢個對話（SUPERVISOR 唯讀 403）；銷售保護中病人唔准標記（409）。
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { ExternalError, externalInfo, markExternal, unmarkExternal, EXT_NAME_MAX, EXT_ORG_MAX } from "@/lib/external-contacts";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const schema = z
  .object({
    name: z.string().max(EXT_NAME_MAX * 2),
    org: z.string().max(EXT_ORG_MAX * 2).nullish(),
  })
  .strict();

function extError(err: unknown): NextResponse {
  if (err instanceof ExternalError) return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
  throw err;
}

export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request", message: "格式唔啱" }, { status: 400 });
  try {
    await markExternal(auth, id, parsed.data);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return extError(e);
  }
});

export const DELETE = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  try {
    await unmarkExternal(auth, id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return extError(e);
  }
});

export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await requireAuth(req);
  const { id } = await ctx.params;
  return NextResponse.json({ external: await externalInfo(auth, id) });
});

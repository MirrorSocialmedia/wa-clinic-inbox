import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ZodError } from "zod";
import { RbacError } from "@/lib/rbac";
import log from "@/lib/log";

/**
 * API route 錯誤處理統一層（fail-closed + 唔洩漏堆疊細節）。
 *
 * - RbacError      → 401/403（message 只係內部代碼層嘅描述，無 PII）
 * - ZodError       → 400 + 欄位級錯誤
 * - Prisma P2002   → 409（unique violation，e.g. 重複 email / waPhoneNumberId）
 * - Prisma P2025   → 404（record 唔存在）
 * - 其他           → 500 + log（log 只帶 error message，唔帶 request body）
 */
export function toResponse(err: unknown): NextResponse {
  if (err instanceof RbacError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      {
        error: "invalid input",
        issues: err.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 }
    );
  }
  const code = (err as { code?: string } | null)?.code;
  if (code === "P2002") {
    return NextResponse.json({ error: "conflict (duplicate)" }, { status: 409 });
  }
  if (code === "P2025") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // ★ PII 鐵律：log 只帶 err.message（可能含欄位名），絕唔帶 request body / payload
  log.error(
    { err: err instanceof Error ? err.message : String(err) },
    "api: unhandled error"
  );
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}

/**
 * App Router route handler wrapper：
 *   export const POST = handle(async (req) => { ... });
 *   export const GET = handle(async (req, ctx) => { const { id } = await ctx.params; ... });
 * 任何 throw（RbacError/ZodError/Prisma/意外）都變正確 HTTP status。
 */
export function handle<Ctx = { params: Promise<Record<string, string>> }>(
  handler: (req: NextRequest, ctx: Ctx) => Promise<Response>
): (req: NextRequest, ctx: Ctx) => Promise<Response> {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      return toResponse(err);
    }
  };
}

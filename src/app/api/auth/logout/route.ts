import { type NextRequest, NextResponse } from "next/server";
import { destroySession } from "@/lib/session";
import log from "@/lib/log";

/**
 * POST /api/auth/logout — 清 session cookie。
 * destroy() 會直接 set 清除 cookie（唔使再 save）。
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const res = await destroySession(req);
  log.info("logout: done");
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": res.headers.get("set-cookie") ?? "",
    },
  });
}

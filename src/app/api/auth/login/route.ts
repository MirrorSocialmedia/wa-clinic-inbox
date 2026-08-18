import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import argon2 from "argon2";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { setSession } from "@/lib/session";
import { handle, toResponse } from "@/lib/api-error";

/**
 * POST /api/auth/login — email + argon2 verify（框架 MD §2：自建 auth）。
 *
 * - 帳號唔存在 / 密碼錯 / 停用 → 同一個 401（唔洩露邊個帳號存在）
 * - STAFF session 帶 clinicId（RBAC 鐵律）；ADMIN 唔帶（null = 跨店）
 * - 簡單 per-IP 限流（5 次/分鐘）— 内部工具，防撞庫足夠
 */
export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

/** 簡單 in-memory 限流（單 process 內部工具；多 process 時換 Redis 計數） */
const attempts = new Map<string, { count: number; windowStart: number }>();
const LIMIT = 5;
const WINDOW_MS = 60_000;

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || now - a.windowStart > WINDOW_MS) {
    attempts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  a.count += 1;
  return a.count > LIMIT;
}
// 定期清地圖，防內存洩漏
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (now - v.windowStart > WINDOW_MS * 2) attempts.delete(k);
}, 5 * 60_000).unref();

export const POST = handle(async (req: NextRequest) => {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (rateLimited(ip)) {
    log.warn({ ip }, "login: rate limited");
    return NextResponse.json({ error: "too many attempts" }, { status: 429 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);

  const { email, password } = parsed.data;
  const user = await prisma.staffUser.findUnique({ where: { email } });

  if (!user || !(await argon2.verify(user.passwordHash, password).catch(() => false))) {
    return unauthorized();
  }
  if (!user.active) {
    log.warn({ staffId: user.id, ip }, "login: inactive account attempt");
    return unauthorized();
  }

  const res = await setSession(req, {
    staffId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    clinicId: user.role === "STAFF" ? user.clinicId : null,
    loginAt: Date.now(),
  });

  await prisma.auditLog.create({
    data: { staffId: user.id, action: "LOGIN", entity: "StaffUser", entityId: user.id },
  }).catch(() => undefined);

  log.info({ staffId: user.id, role: user.role }, "login: success");
  return new Response(JSON.stringify({ ok: true, redirect: "/inbox" }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": res.headers.get("set-cookie") ?? "",
    },
  });
});

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import argon2 from "argon2";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { setSession } from "@/lib/session";
import { handle, toResponse } from "@/lib/api-error";
import { isAccountLocked, recordLoginFailure, clearLoginFailures } from "@/lib/auth-lockout";

/**
 * POST /api/auth/login — email + argon2 verify（框架 MD §2：自建 auth）。
 *
 * - 帳號唔存在 / 密碼錯 / 停用 → 同一個 401（唔洩露邊個帳號存在）
 * - STAFF session 帶 clinicId（RBAC 鐵律）；ADMIN 唔帶（null = 跨店）
 * - per-IP 限流（5 次/分鐘）+ ★ AS-3③ per-account lockout（同 email 連續 5 次
 *   fail → 15min 冷卻，Redis SET NX EX — 換 IP 都繞唔到；mock mode 禁用）
 */
export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

/**
 * 客戶端 IP（AS-3②）：XFF 係 append 語義 — 反代（nginx）會喺尾部 append 真 client IP，
 * 而客戶端可以自己送 `X-Forwarded-For: 1.2.3.4` 塞咗頭個值。所以攞**最後一個**值
 * 先可信（defence-in-depth）；nginx 層仲要 `proxy_set_header X-Forwarded-For $remote_addr`
 * （覆蓋唔係 append，見部署 checklist）。
 */
function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return "local";
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
  const ip = clientIp(req);
  if (rateLimited(ip)) {
    log.warn({ ip }, "login: rate limited");
    return NextResponse.json({ error: "too many attempts" }, { status: 429 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return toResponse(parsed.error);

  const { email, password } = parsed.data;

  // ★ AS-3③ per-account lockout：冷卻期内直接 429（mock mode 禁用，見 auth-lockout.ts）
  if (await isAccountLocked(email)) {
    log.warn({ ip, locked: true }, "login: account locked out");
    return NextResponse.json({ error: "too many attempts" }, { status: 429 });
  }

  const user = await prisma.staffUser.findUnique({ where: { email } });
  const pwOk = user
    ? await argon2.verify(user.passwordHash, password).catch(() => false)
    : false;
  if (!user || !pwOk) {
    await recordLoginFailure(email); // 失敗計數（連續 5 次 → lockout）
    return unauthorized();
  }
  if (!user.active) {
    log.warn({ staffId: user.id, ip }, "login: inactive account attempt");
    await recordLoginFailure(email); // 停用帳號撞庫同密碼錯一樣計
    return unauthorized();
  }

  await clearLoginFailures(email); // 成功 → 重計

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

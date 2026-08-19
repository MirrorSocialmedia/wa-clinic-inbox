import { getIronSession, unsealData, type SessionOptions } from "iron-session";
import { type NextRequest, NextResponse } from "next/server";
import log from "@/lib/log";

/**
 * Session 基礎 — iron-session encrypted cookie（框架 MD §2：自建 email+argon2+iron-session）。
 * Phase 0-C 只有 skeleton：login route（argon2 verify）Phase 1 先加。
 *
 * iron-session v8 API 注意：
 * - cookie 名喺 top-level `cookieName`（運行時硬性要求）
 * - 改咗 session 要手動 `await session.save()` 先寫 cookie
 * - destroy() 自己會 set 清除 cookie，唔使再 save()
 */

/** 同 Prisma `Role` enum 一致（結構性兼容，避免 session lib 硬綁 generate 順序） */
export type SessionRole = "ADMIN" | "STAFF";

export interface SessionData {
  /** StaffUser.id */
  staffId: string;
  email: string;
  name: string;
  role: SessionRole;
  /** STAFF 硬性綁定嘅 clinicId；ADMIN = null（跨店） */
  clinicId: string | null;
  /** login 時間（epoch ms），session 過期檢查用 */
  loginAt: number;
}

export const SESSION_COOKIE_NAME = "wa_inbox_session";

/**
 * ★ M-4：role-based session 有效期（由登入起算，不 sliding）：
 * - STAFF 7d → **24h**
 * - ADMIN → **12h**（高權限 session 先過期）
 *
 * 實現：iron-session 層用兩者最大值（24h）做 unseal — role 要解密密文先知道，
 * 無法喺 unseal 前用 per-role ttl；精確檢查喺 unseal 之後用 loginAt（isSessionFresh，
 * 所有讀路徑都過：getSession / getSocketSession / getServerSession）。
 * 舊 7d session（loginAt > 24h）喺下一次讀取即失效 = 一次性強制重登（預期行為）。
 */
export const SESSION_TTL_SECONDS: Record<SessionRole, number> = {
  STAFF: 24 * 3600, // 24h（M-4：原 7d）
  ADMIN: 12 * 3600, // 12h
};
const UNSEAL_TTL_SECONDS = Math.max(SESSION_TTL_SECONDS.STAFF, SESSION_TTL_SECONDS.ADMIN);

/** session 有冇喺該 role 嘅有效期内（loginAt 起算；fail-closed：無 loginAt = 失效）。 */
export function isSessionFresh(data: Pick<SessionData, "role" | "loginAt">): boolean {
  if (typeof data.loginAt !== "number") return false;
  return Date.now() - data.loginAt <= SESSION_TTL_SECONDS[data.role] * 1000;
}

function assertSecret(): string {
  const secret = process.env.SESSION_SECRET ?? "";
  // iron-session 要求 secret >= 32 chars
  if (secret.length < 32) {
    throw new Error(
      "SESSION_SECRET missing or < 32 chars — generate: openssl rand -base64 48"
    );
  }
  return secret;
}

export function sessionOptions(): SessionOptions {
  return {
    cookieName: SESSION_COOKIE_NAME,
    password: assertSecret(),
    // unseal/maxAge 用最大值 — 精確 role TTL 喺 isSessionFresh（loginAt 檢查）
    ttl: UNSEAL_TTL_SECONDS,
    cookieOptions: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: UNSEAL_TTL_SECONDS,
    },
  };
}

export interface SessionResult {
  /** null = 未登入 / session 无效 */
  data: SessionData | null;
  /** 必需要將呢個 response（或其 set-cookie header）帶返畀 client */
  res: NextResponse;
}

/**
 * 讀 session。Route handler 用法：
 *   const { data, res } = await getSession(req);
 *   ...
 *   return next(res)  // 或將 res 嘅 set-cookie header 帶落自己個 response
 *
 * 壞 cookie（被篡改 / 解密失敗 / SESSION_SECRET 冇設）→ 當未登入（401 由 requireAuth 抛），
 * 唔好俾佢變 500。
 */
export async function getSession(req: NextRequest): Promise<SessionResult> {
  const res = NextResponse.next();
  try {
    const session = await getIronSession<SessionData>(req, res, sessionOptions());
    const data = session.staffId ? (session as unknown as SessionData) : null;
    if (data && !isSessionFresh(data)) {
      // M-4：超出 role 有效期 → 清 cookie（瀏覽器唔會再送呢個舊 session）
      session.destroy();
      return { data: null, res };
    }
    return { data, res };
  } catch (err) {
    // 只 log 錯誤 metadata — cookie 內容可能係客戶 PII，絕對唔可以入 log
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "session: invalid cookie, treating as unauthenticated"
    );
    return { data: null, res };
  }
}

/** 寫 session（login 時用）。改完必需要 save() 先寫 cookie。 */
export async function setSession(
  req: NextRequest,
  data: SessionData
): Promise<NextResponse> {
  const res = NextResponse.next();
  const session = await getIronSession<SessionData>(req, res, sessionOptions());
  Object.assign(session, data);
  await session.save();
  return res;
}

/** 清 session（logout 時用）。destroy() 會直接 set 清除 cookie，唔使再 save()。 */
export async function destroySession(req: NextRequest): Promise<NextResponse> {
  const res = NextResponse.next();
  const session = await getIronSession<SessionData>(req, res, sessionOptions());
  session.destroy();
  return res;
}

/**
 * 簡單 cookie header 解析（socket.io handshake 用 — 唔使引 cookie package）。
 * 只取 name → value 第一個；value 唔 decode（iron-session 會自行處理 base64）。
 */
export function parseCookieHeader(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!(name in out)) out[name] = value;
  }
  return out;
}

/**
 * Socket.IO handshake 用：由 request cookie 解 iron-session（唔郁 res）。
 * unsealData 內置 tamper 檢查 + ttl 過期檢查；任何異常 → null（fail-closed）。
 * ★ PII 鐵律：log 只帶 staffId/role，cookie 內容絕唔入 log。
 */
export async function getSocketSession(req: { headers: { cookie?: string } }): Promise<SessionData | null> {
  try {
    const value = parseCookieHeader(req.headers.cookie ?? "")[SESSION_COOKIE_NAME] ?? "";
    if (!value) return null;
    const data = await unsealData<SessionData>(value, {
      password: assertSecret(),
      ttl: UNSEAL_TTL_SECONDS,
    });
    // M-4：role 有效期（loginAt 檢查）— socket 路徑同 web 同水位
    if (data && !isSessionFresh(data)) return null;
    return data && data.staffId ? data : null;
  } catch {
    return null;
  }
}

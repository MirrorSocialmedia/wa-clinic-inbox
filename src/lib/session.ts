import { getIronSession, type SessionOptions } from "iron-session";
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

const TTL_SECONDS = 60 * 60 * 24 * 7; // 7 日

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
    cookieName: "wa_inbox_session",
    password: assertSecret(),
    ttl: TTL_SECONDS,
    cookieOptions: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: TTL_SECONDS,
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

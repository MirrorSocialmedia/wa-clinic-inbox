import { cookies } from "next/headers";
import { getIronSession } from "iron-session";
import { sessionOptions, isSessionFresh, type SessionData } from "@/lib/session";

/**
 * Server component / server route 讀 session（iron-session v8 cookie-store overload）。
 *
 * Fail-closed：SESSION_SECRET 冇設 / cookie 壞 / 解密失敗 → null（當未登入）。
 * 任何 throw 都唔會洩漏 cookie 內容入 log。
 */
export async function getServerSession(): Promise<SessionData | null> {
  try {
    const cookieStore = await cookies();
    const session = await getIronSession<SessionData>(cookieStore, sessionOptions());
    if (!session.staffId) return null;
    // M-4：role 有效期（loginAt 起算）— server component 路徑同 web/socket 同水位
    if (!isSessionFresh(session)) return null;
    return session as unknown as SessionData;
  } catch {
    return null;
  }
}

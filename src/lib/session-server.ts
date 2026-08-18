import { cookies } from "next/headers";
import { getIronSession } from "iron-session";
import { sessionOptions, type SessionData } from "@/lib/session";

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
    return session.staffId ? (session as unknown as SessionData) : null;
  } catch {
    return null;
  }
}

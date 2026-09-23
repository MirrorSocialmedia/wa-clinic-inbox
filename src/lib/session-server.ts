import { cookies } from "next/headers";
import { getIronSession } from "iron-session";
import { sessionOptions, isSessionFresh, type SessionData } from "@/lib/session";
import { isStaffActive, isStaffSessionCurrent, isSessionDenied } from "@/lib/rbac";

/**
 * Server component / server route 讀 session（iron-session v8 cookie-store overload）。
 *
 * Fail-closed：SESSION_SECRET 冇設 / cookie 壞 / 解密失敗 → null（當未登入）。
 * 任何 throw 都唔會洩漏 cookie 內容入 log。
 *
 * ★ cwi-final S3-2：server 路徑同 web/socket 拉齊四重檢查 —
 * fresh（role TTL）+ active（停用即時，P0-3）+ current（password reset cutoff，C-3）+
 * denied（本機登出，A1）— 任何一層唔過 → null → (inbox)/(admin) layout redirect /login。
 */
export async function getServerSession(): Promise<SessionData | null> {
  try {
    const cookieStore = await cookies();
    const session = await getIronSession<SessionData>(cookieStore, sessionOptions());
    if (!session.staffId || !isSessionFresh(session)) return null;
    if (!(await isStaffActive(session.staffId))) return null;
    if (!(await isStaffSessionCurrent(session))) return null;
    if (await isSessionDenied(session.sid)) return null;
    return session as unknown as SessionData;
  } catch {
    return null;
  }
}

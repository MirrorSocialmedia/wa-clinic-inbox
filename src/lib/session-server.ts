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
 *
 * ★ cwi-qa FX-04（QA-04，已重現）：enrollOnly session（TOTP 強制 enroll 窗口）
 *   唔准當完整 session 用 — 舊版 getServerSession 只查 fresh/active/current/denied，
 *   enrollOnly session 係 fresh 嘅 → /inbox 200 + HTML 帶病人電話同名。
 *   而家：enrollOnly → null（enroll 流程只經 getEnrollSession + /api/admin/totp/*）。
 */

/**
 * 已解 seal session 嘅 server 路徑驗證鏈（getServerSession 核心 — 拆出俾 unit test 直調）。
 * 順序：staffId → fresh（role TTL / enroll 15min）→ ★enrollOnly 拒（FX-04）→
 * active（P0-3）→ current（C-3）→ denied（A1）。任何一層 fail → false（fail-closed）。
 */
export async function validateServerSession(session: SessionData): Promise<boolean> {
  if (!session.staffId) return false;
  if (!isSessionFresh(session)) return false;
  // ★ cwi-qa FX-04：enrollOnly session 唔準進 server-side 完整 session（enroll 頁用 getEnrollSession）
  if (session.enrollOnly) return false;
  if (!(await isStaffActive(session.staffId))) return false;
  if (!(await isStaffSessionCurrent(session))) return false;
  if (await isSessionDenied(session.sid)) return false;
  return true;
}

/**
 * enroll 專用驗證鏈（getEnrollSession 核心）— 只接受 enrollOnly session。
 * 同 validateServerSession 同一組底層 check，但方向相反：非 enrollOnly → false
 * （正常 session 唔使走 enroll 頁；enroll 窗口外都一律 fail-closed）。
 */
export async function validateEnrollSession(session: SessionData): Promise<boolean> {
  if (!session.staffId) return false;
  if (!session.enrollOnly) return false;
  if (!isSessionFresh(session)) return false; // enroll 窗口 15min（isSessionFresh 內置）
  if (!(await isStaffActive(session.staffId))) return false;
  if (!(await isStaffSessionCurrent(session))) return false;
  if (await isSessionDenied(session.sid)) return false;
  return true;
}

export async function getServerSession(): Promise<SessionData | null> {
  try {
    const cookieStore = await cookies();
    const session = await getIronSession<SessionData>(cookieStore, sessionOptions());
    if (!(await validateServerSession(session))) return null;
    return session as unknown as SessionData;
  } catch {
    return null;
  }
}

/**
 * ★ cwi-qa FX-04：enroll 頁（TOTP 強制 enroll UI）讀 session — 只接受 enrollOnly session。
 * 正常 session 入嚟 → null（enroll 頁只服務 15 分鐘 enroll 窗口；窗口外 redirect 登入）。
 */
export async function getEnrollSession(): Promise<SessionData | null> {
  try {
    const cookieStore = await cookies();
    const session = await getIronSession<SessionData>(cookieStore, sessionOptions());
    if (!(await validateEnrollSession(session))) return null;
    return session as unknown as SessionData;
  } catch {
    return null;
  }
}

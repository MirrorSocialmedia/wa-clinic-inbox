/**
 * POST /api/admin/apricot/session — 真 Apricot bot 帳號首次對接（bootstrap cookie 三件套）
 *
 * 真 mode 冇「自動登入」：指揮大神喺瀏覽器登入 Apricot（專用 bot 帳號）後，
 * 由 DevTools 攞 cookie（access_token / refresh_token / iat 三件套）貼落嚟，
 * admin POST 呢度加密落 DB — 之後 system 自己維護 rotation（每次 response 攞新 cookie）
 * + 3 日 keepalive，14 日 token 唔死靠 keepalive 推 sliding window。
 *
 * 安全：
 * - ADMIN-only（requireAdmin）
 * - token 經 APRICOT_ENC_KEY AES-256-GCM 加密先落 DB（明文唔落 disk）
 * - log 只記「bootstrap 成功 + 有冇 rotation」— 零 token 原文（iron rule 2）
 * - mock mode（APRICOT_MOCK=1）→ 409（mock session 由 ensureMockSession 自管理）
 */
import { type NextRequest, NextResponse } from "next/server";
import log from "@/lib/log";
import { requireAdmin } from "@/lib/rbac";
import { handle } from "@/lib/api-error";
import { saveCreds, apricotMock } from "@/lib/apricot/session";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest) => {
  const _ctx = await requireAdmin(req);

  if (apricotMock()) {
    return NextResponse.json(
      { error: "apricot_mock", message: "APRICOT_MOCK=1 — mock session 自動管理，唔使 bootstrap" },
      { status: 409 }
    );
  }

  const body = (await req.json().catch(() => null)) as {
    accessToken?: string;
    refreshToken?: string;
    iat?: string;
  } | null;
  const accessToken = (body?.accessToken ?? "").trim();
  const refreshToken = (body?.refreshToken ?? "").trim();
  const iat = (body?.iat ?? "").trim();

  if (!accessToken || !refreshToken || !iat) {
    return NextResponse.json(
      { error: "missing_fields", message: "要齊 accessToken / refreshToken / iat 三件套" },
      { status: 422 }
    );
  }

  // saveCreds 內部 AES-GCM 加密 + upsert；寫入失敗 throw（route 層 500 — 唔靜默）
  await saveCreds(
    { accessToken, refreshToken, iat },
    { lastKeepaliveAt: new Date(), lastError: null }
  );

  log.info({ by: _ctx.staff.id }, "apricot: session bootstrapped by admin（真 mode）");
  return NextResponse.json({ ok: true });
});

import { NextResponse, type NextRequest } from "next/server";

/**
 * ★ cwi-final S3-6：CSRF / Origin 守門（audit3 P2-16）。
 *
 * 所有 /api/* 非 GET/HEAD 寫請求：
 * 1) Origin 必須同站（`origin` header host === APP_HOST ?? request host）；
 *    冇 Origin 時信 `sec-fetch-site: same-origin`。否則 403。
 * 2) Content-Type 必須 application/json / multipart/form-data（或空 body content-length=0）。
 *    否則 415（text/plain 跨站 form 攻擊載體）。
 *
 * EXEMPT（外部端點 — 身份靠獨立驗證，唔靠 cookie/origin）：
 * - /api/wa/webhook（Meta 簽名驗證）
 * - /api/flows/endpoint（RSA 雙信封 + flow_token JWT）
 * - /api/internal/（S2-9 proxy — 冇 cookie，靠信封驗證）
 *
 * .env：APP_HOST=wa.hkclinicworkforce.com（上線後加入 S0-10 predeploy 必填 list）；
 * dev 喺 .env.local set APP_HOST=127.0.0.1:3100（local-only 零 commit — 因為 `next({dev})`
 * custom server 嘅 req.nextUrl.host 係 Next 內部 default localhost:3000，唔係實際 request host —
 * 固定 APP_HOST 先匹配 harness Origin；e2e harness 帶同站 Origin）。
 */
const EXEMPT = ["/api/wa/webhook", "/api/flows/endpoint", "/api/internal/"]; // /api/internal = S2-9 proxy（冇 cookie，靠信封驗證）

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (!pathname.startsWith("/api/") || req.method === "GET" || req.method === "HEAD" || EXEMPT.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }
  const host = process.env.APP_HOST ?? req.nextUrl.host;
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site");
  const originOk = origin ? new URL(origin).host === host : site === "same-origin";
  if (!originOk) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const ct = req.headers.get("content-type") ?? "";
  // empty-body 判定：content-length=0，或者兩個 body 訊號都冇（content-length / transfer-encoding）
  // — curl/fetch 無 body 唔會傳 content-length（實測 T630 DELETE 40 格 415 事故：只認 cl=0 會誤殺）
  const cl = req.headers.get("content-length");
  const emptyBody = cl === "0" || (cl === null && req.headers.get("transfer-encoding") === null);
  if (ct.startsWith("application/json") || ct.startsWith("multipart/form-data") || emptyBody) {
    return NextResponse.next();
  }
  return NextResponse.json({ error: "unsupported content-type" }, { status: 415 });
}

export const config = { matcher: ["/api/:path*"] };

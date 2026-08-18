/**
 * Apricot HTTP client — ★ 移植 clinic-workforce-mvp client.ts 核心邏輯（原封不動搬）
 *
 * 已實測機制（照搬）：
 * - cookie 三件套一個 request 一組 cookie header；`redirect: "manual"` 防 302 登入頁
 * - 每個 response 用 `res.headers.getSetCookie()` 攞**全部** Set-Cookie（rotation
 *   喺每個 response 發生；`get('set-cookie')` 只回第一隻 = 炒車）
 * - 攞到新 cookie → saveCreds（寫入失敗 throw）
 * - 401/403/3xx → APRICOT_AUTH_EXPIRED（唔重試 — 重試會加速 token 作廢）
 * - 429 → APRICOT_RATE_LIMITED（唔重試）
 * - 其他 HTTP 錯誤：保留短 body（300 char）做錯訊；成功 response 有病人資料 —
 *   一律唔 log（★ PII 鐵律：raw response 永不入 log 永不落 disk）。
 *
 * ★ 序列化：本 module 唔可以直接當「任意地方都可 call」用 —
 *   所有 caller 必須經 apricotQueue（concurrency=1）：見 src/workers/apricot.worker.ts。
 */
import { loadCreds, saveCreds, markError, type ApricotCreds } from "./session";

const BASE = () => process.env.APRICOT_BASE_URL ?? "https://apricotvita.com";

export async function apricotCall(path: string, init?: RequestInit): Promise<unknown> {
  const creds = await loadCreds();
  if (!creds) throw new Error("APRICOT_NOT_CONFIGURED");

  const res = await fetch(`${BASE()}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      origin: BASE(),
      ...(init?.headers ?? {}),
      cookie: `access_token=${creds.accessToken}; refresh_token=${creds.refreshToken}; iat=${creds.iat}`,
    },
    redirect: "manual", // ★ 防 302 登入頁
    signal: AbortSignal.timeout(20_000),
  });

  // ★★ 每次都要接住 Set-Cookie — rotation 喺每個 response 發生
  const setCookies = res.headers.getSetCookie?.() ?? []; // ★ 一定要 getSetCookie()
  if (setCookies.length) {
    const next: ApricotCreds = { ...creds };
    let changed = false;
    for (const sc of setCookies) {
      const [pair] = sc.split(";");
      const i = pair.indexOf("=");
      if (i <= 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (name === "access_token" && value !== next.accessToken) {
        next.accessToken = value;
        changed = true;
      }
      if (name === "iat" && value !== next.iat) {
        next.iat = value;
        changed = true;
      }
      if (name === "refresh_token" && value !== next.refreshToken) {
        next.refreshToken = value;
        changed = true;
      }
    }
    if (changed) {
      // ★ 寫入失敗一定要 throw（rotation 丟失 = 下次 request 用舊 token = 炒車）
      await saveCreds(next);
    }
  }

  if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
    await markError(`auth failed HTTP ${res.status}`);
    throw new Error("APRICOT_AUTH_EXPIRED"); // ★ 唔重試
  }
  if (res.status === 429) {
    await markError("rate limited 429");
    throw new Error("APRICOT_RATE_LIMITED"); // ★ 唔重試
  }
  if (!res.ok) {
    // ★ H2: 只保留短錯誤 body（成功 response 有病人資料，唔准 log）
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* 讀唔到就算 */
    }
    console.error("[apricot] HTTP error", { status: res.status, path, detail });
    throw new Error(`APRICOT_HTTP_${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return res.json();
}

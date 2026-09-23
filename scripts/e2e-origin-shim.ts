/**
 * ★ cwi-final S3-6 harness 兼容：e2e scripts 共用 global fetch Origin shim。
 *
 * S3-6 CSRF middleware 上線後，所有打 W API（/api/*）嘅非 GET/HEAD 請求要同站 Origin。
 * 每個打 W API 嘅 e2e-*.ts 喺檔案頂部 `import "./e2e-origin-shim";`（要係第一個 import，
 * 確保 fetch 被 patch 先過任何其他 fetch call）。
 *
 * 語義：request 打 http://127.0.0.1:<port>/api/* 且無 origin/sec-fetch-site → 自動補
 * 「request 自己嘅 origin」（同站 by construction）。已自帶 origin 嘅 call（例外測試）原樣放行。
 * 非 127.0.0.1（外網 / mock 端點）唔管。
 *
 * 註：server 端 middleware 用 APP_HOST（.env.local = 127.0.0.1:3100）做對照 — 3100 流量
 * 同站匹配；t639 flag-off 同用 3100 port（.env.local 同一份）→ 匹配。
 */
const __origFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  try {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (typeof url === "string" && url.startsWith("http://127.0.0.1:") && url.includes("/api/")) {
      const m = (init?.method ?? "GET").toUpperCase();
      if (m !== "GET" && m !== "HEAD") {
        const h = new Headers(init?.headers);
        if (!h.has("origin") && !h.has("sec-fetch-site")) h.set("origin", new URL(url).origin);
        if (!h.has("content-type") && init?.body !== undefined) h.set("content-type", "application/json");
        init = { ...init, headers: h };
      }
    }
  } catch { /* shim 唔好破 e2e — 靜默 */ }
  return __origFetch(input, init);
}) as typeof fetch;

export {};

/**
 * cwi-qa FX-19（QA-19）— graph fetch 網絡錯誤分類（unit，hermetic — 零 DB / 零網絡）。
 *
 * 施工單規格：`src/lib/wa/graph.ts` — fetch 送出 body 後斷線（ECONNRESET/UND_ERR_SOCKET）
 * → 當結果未知 UNKNOWN；DNS/ECONNREFUSED → transient。
 *
 * 背景（S1-15 遗留洞）：outbound worker 只辨 `err.name === "TimeoutError"` → UNKNOWN（禁重發）；
 * socket 喺「body 已送出、response 未回」時死 → 舊路徑當 transient retry → **雙發風險**。
 * 修復（graph.ts 層，零改 outbound.worker — lane B 檔案）：
 *   - `graphFetch(url, init, { outcomeUnknown })`：send 路徑（outcomeUnknown=true）斷線
 *     → `GraphOutcomeUnknownError`（刻意 `name = "TimeoutError"` → worker S1-15 UNKNOWN 路徑）；
 *     DNS/ECONNREFUSED / 其他 → rethrow 原錯誤（worker 既有 transient 口徑）。
 *   - upload / GET 路徑（outcomeUnknown 未設）：一律 rethrow（upload 重試安全、GET 無副作用）。
 *
 * 本 test 只斷 pure classifier + 錯誤橋（mock globalThis.fetch — 零真網絡）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyFetchNetError,
  netErrorCode,
  graphFetch,
  GraphOutcomeUnknownError,
} from "@/lib/wa/graph";

// ── 錯誤形狀 helper（照 Node/undici 真實形狀：TypeError "fetch failed" + .cause 帶 .code） ──

function fetchFailed(code: string | undefined): TypeError {
  const cause = new Error(code ? `${code} simulated` : "simulated failure");
  if (code) (cause as { code?: string }).code = code;
  return new TypeError("fetch failed", { cause });
}

/** undici 形狀：cause 係 AggregateError（dual-stack）— .errors[0].code */
function fetchFailedAggregate(code: string): TypeError {
  const inner = new Error(`${code} inner`);
  (inner as { code?: string }).code = code;
  const agg = new AggregateError([inner], "connect failed") as AggregateError & { code?: string };
  return new TypeError("fetch failed", { cause: agg });
}

const prevFetch = globalThis.fetch;
function mockFetch(rejectWith: unknown): void {
  globalThis.fetch = (async () => {
    throw rejectWith;
  }) as typeof fetch;
}
function restoreFetch(): void {
  globalThis.fetch = prevFetch;
}

// ── netErrorCode（pure） ────────────────────────────────────────────────────

test("netErrorCode: 直屬 .code", () => {
  const e = new Error("x");
  (e as { code?: string }).code = "ECONNRESET";
  assert.equal(netErrorCode(e), "ECONNRESET");
});

test("netErrorCode: cause 鏈（fetch failed → cause.code）", () => {
  assert.equal(netErrorCode(fetchFailed("ECONNRESET")), "ECONNRESET");
  assert.equal(netErrorCode(fetchFailed("ECONNREFUSED")), "ECONNREFUSED");
  assert.equal(netErrorCode(fetchFailed("ENOTFOUND")), "ENOTFOUND");
});

test("netErrorCode: cause 深兩層（AbortError 包 cause 形狀）", () => {
  const deep = new Error("deep");
  (deep as { code?: string }).code = "UND_ERR_SOCKET";
  const mid = new Error("mid", { cause: deep });
  const outer = new Error("outer", { cause: mid });
  assert.equal(netErrorCode(outer), "UND_ERR_SOCKET");
});

test("netErrorCode: AggregateError.errors[0].code（dual-stack）", () => {
  assert.equal(netErrorCode(fetchFailedAggregate("ECONNREFUSED")), "ECONNREFUSED");
});

test("netErrorCode: 無 code → null", () => {
  assert.equal(netErrorCode(new Error("plain")), null);
  assert.equal(netErrorCode("string error"), null);
  assert.equal(netErrorCode(null), null);
  assert.equal(netErrorCode(undefined), null);
});

// ── classifyFetchNetError（pure — 規格核心） ─────────────────────────────────

test("classify: 斷線（body 可能已達）→ outcome-unknown", () => {
  for (const code of ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]) {
    assert.equal(classifyFetchNetError(fetchFailed(code)), "outcome-unknown", code);
  }
});

test("classify: DNS / 拒絕連線（肯定未送到）→ transient", () => {
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"]) {
    assert.equal(classifyFetchNetError(fetchFailed(code)), "transient", code);
  }
});

test("classify: 其他 code / 無 code → other（保持原行為）", () => {
  assert.equal(classifyFetchNetError(fetchFailed("EACCES")), "other");
  assert.equal(classifyFetchNetError(new Error("plain")), "other");
});

// ── GraphOutcomeUnknownError（worker S1-15 橋） ──────────────────────────────

test("GraphOutcomeUnknownError: name=TimeoutError（worker UNKNOWN 路徑口徑）+ cause 保留", () => {
  const orig = new Error("read ECONNRESET");
  const e = new GraphOutcomeUnknownError("ECONNRESET", orig);
  assert.equal(e.name, "TimeoutError"); // outbound.worker: err.name === "TimeoutError" → UNKNOWN
  assert.ok(e instanceof Error);
  assert.equal(e.cause, orig);
  assert.match(e.message, /outcome unknown/);
  assert.match(e.message, /ECONNRESET/);
});

// ── graphFetch（mock fetch — 零真網絡） ──────────────────────────────────────

test("graphFetch: send 路徑 ECONNRESET（fetch 階段）→ GraphOutcomeUnknownError", async () => {
  mockFetch(fetchFailed("ECONNRESET"));
  try {
    await assert.rejects(
      graphFetch("http://graph.test/m", { method: "POST", body: "{}" }, { outcomeUnknown: true }),
      (e: unknown) => e instanceof GraphOutcomeUnknownError && e.name === "TimeoutError"
    );
  } finally {
    restoreFetch();
  }
});

test("graphFetch: send 路徑 UND_ERR_SOCKET（fetch 階段）→ GraphOutcomeUnknownError", async () => {
  mockFetch(fetchFailed("UND_ERR_SOCKET"));
  try {
    await assert.rejects(
      graphFetch("http://graph.test/m", { method: "POST", body: "{}" }, { outcomeUnknown: true }),
      (e: unknown) => e instanceof GraphOutcomeUnknownError && e.name === "TimeoutError"
    );
  } finally {
    restoreFetch();
  }
});

test("graphFetch: send 路徑 ECONNREFUSED → rethrow 原錯誤（transient — 肯定未送到，重試安全）", async () => {
  const orig = fetchFailed("ECONNREFUSED");
  mockFetch(orig);
  try {
    await assert.rejects(graphFetch("http://graph.test/m", { method: "POST", body: "{}" }, { outcomeUnknown: true }), (e: unknown) => e === orig && !(e instanceof GraphOutcomeUnknownError));
  } finally {
    restoreFetch();
  }
});

test("graphFetch: send 路徑 ENOTFOUND（DNS）→ rethrow 原錯誤（transient）", async () => {
  const orig = fetchFailed("ENOTFOUND");
  mockFetch(orig);
  try {
    await assert.rejects(graphFetch("http://graph.test/m", { method: "POST", body: "{}" }, { outcomeUnknown: true }), (e: unknown) => e === orig);
  } finally {
    restoreFetch();
  }
});

test("graphFetch: upload 路徑（outcomeUnknown 未設）ECONNRESET → rethrow（upload 重試安全）", async () => {
  const orig = fetchFailed("ECONNRESET");
  mockFetch(orig);
  try {
    await assert.rejects(graphFetch("http://graph.test/media", { method: "POST", body: new FormData() }), (e: unknown) => e === orig && !(e instanceof GraphOutcomeUnknownError));
  } finally {
    restoreFetch();
  }
});

test("graphFetch: 無 code 錯誤 → rethrow 原錯誤（two unknown → 原行為）", async () => {
  const orig = new Error("plain failure");
  mockFetch(orig);
  try {
    await assert.rejects(graphFetch("http://graph.test/m", { method: "POST", body: "{}" }, { outcomeUnknown: true }), (e: unknown) => e === orig);
  } finally {
    restoreFetch();
  }
});

test("graphFetch: 成功 → 照返 Response", async () => {
  const fakeRes = new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async () => fakeRes) as typeof fetch;
  try {
    const res = await graphFetch("http://graph.test/m", { method: "POST", body: "{}" }, { outcomeUnknown: true });
    assert.equal(res, fakeRes);
  } finally {
    restoreFetch();
  }
});

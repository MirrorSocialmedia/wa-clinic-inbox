/**
 * unit-labdoc-extract — cwi-labdoc-extract（cwm-labdoc §5.2）wa-inbox 讀單 proxy 單元測試
 *
 * 範圍（零 DB；redis 只用於 replay + 429 契約路徑 — CI service 一定有）：
 *   1. 信封 round-trip：seal/open @ context "labdoc-extract.v1" + respContext(nonce)；
 *      錯 context / 錯 key → throw（防兩 repo 實作漂移）
 *   2. 契約 fixture lock：prompt.v1.txt === prompt.ts 文字（byte-identical）；
 *      schema.v1.json === src/lib/labdoc/schema.json（byte-identical）
 *   3. prompt build：{labHint} 佔位行替換／移除語義
 *   4. validateLabDocRequest：TEXT/VISION 入參驗證（60000 字、8 張 jpeg、base64、mode 互斥）
 *   5. parseLabDocResponse：parse_error / bad_response / 多餘欄位丟棄 / 日期格式 / sections-groups invariant
 *   6. route in-process（env hermetic pin + 本 process mock OpenAI 上游，ephemeral port）：
 *      200 happy（TEXT/VISION + prompt/image 上游斷言）、413、400/401/409、
 *      reason 路徑（parse_error / bad_response / llm_error / breaker_open）、429 BUSY、503 NOT_ENABLED
 *
 * 跑法（repo root）：pnpm tsx scripts/unit-labdoc-extract.ts
 * 退出碼：0 = 全過；1 = 有 fail
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── env pin（必須喺動態 import 之前；route module top-level 讀 CONCURRENCY）──────────────
const TEST_SECRET_B64 = Buffer.from("cwi-labdoc-test-key-00000000000000000000000000001").toString("base64");
process.env.LLM_PROXY_ENABLED = "1";
process.env.INTERNAL_LLM_SECRET = TEST_SECRET_B64;
process.env.INTERNAL_LLM_KID = "k1";
process.env.LABDOC_LLM_CONCURRENCY = "1";
process.env.AI_MOCK = "0";
process.env.VLLM_FALLBACK_MODEL = "";
process.env.AI_TIMEOUT_MS = "8000";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── mock OpenAI-compatible 上游（本 process，ephemeral port；零真 GPU）─────────────────
type UpstreamMode = { kind: "content"; content: string } | { kind: "sleep"; ms: number; content: string } | { kind: "500" };
let upstreamMode: UpstreamMode = { kind: "content", content: "" };
const upstreamBodies: unknown[] = [];
const upstream = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const finish = (body: string, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    };
    if (upstreamMode.kind === "500") {
      finish(JSON.stringify({ error: { message: "mock upstream boom" } }), 500);
      return;
    }
    const content = JSON.stringify({ choices: [{ message: { content: upstreamMode.content } }], usage: { total_tokens: 10 } });
    if (upstreamMode.kind === "sleep") {
      setTimeout(() => finish(content), upstreamMode.ms);
    } else {
      finish(content);
    }
  });
});

// 最小合法 JPEG（magic FF D8 FF E0 + 尾 FF D9；內容無意義）
const TINY_JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]).toString("base64");
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

// ── §5.4 合法 sample（測試用；零 PII 純 fixture 文字）─────────────────────────────────
function invoiceSample(over: Record<string, any> = {}): any {
  return {
    kind: "INVOICE",
    lab: { nameRaw: "LAB A", nameCnRaw: null, payeeRaw: null },
    billTo: { nameRaw: "CLINIC A", addressRaw: null, customerNoRaw: null, shortCodeRaw: null, doctorRaw: null },
    docNoRaw: "INV-001",
    docNoLabel: "Invoice No.",
    dateRaw: "01/10/2026",
    date: "2026-10-01",
    deliveryDate: null,
    orderReceivedDate: null,
    statementMonth: null,
    groups: [
      {
        patientNameRaw: "PT ONE",
        patientCodeRaw: "TY9845",
        labCaseRef: "DT9003874",
        lines: [
          { description: "Crown", toothRaw: "11", qty: 1, unitPrice: 3200, listPrice: 3500, discountRaw: "10%", amount: 3200 },
        ],
      },
    ],
    sections: [],
    subtotal: 3200,
    total: 3200,
    readIssues: [],
    ...over,
  };
}
function statementSample(over: Record<string, any> = {}): any {
  return {
    kind: "STATEMENT",
    lab: { nameRaw: "LAB A", nameCnRaw: null, payeeRaw: null },
    billTo: { nameRaw: "CLINIC A", addressRaw: null, customerNoRaw: "C01", shortCodeRaw: null, doctorRaw: null },
    docNoRaw: null,
    docNoLabel: null,
    dateRaw: "Sep 2026",
    date: "2026-09-30",
    deliveryDate: null,
    orderReceivedDate: null,
    statementMonth: "2026-09",
    groups: [],
    sections: [
      {
        clinicRaw: "CLINIC A",
        doctorRaw: "DR B",
        customerNoRaw: "C01",
        addressRaw: null,
        pageFrom: 1,
        pageTo: 2,
        total: 1000,
        currentTotal: 1000,
        lines: [
          {
            lineType: "INVOICE",
            docNoRaw: "INV-001",
            date: "2026-09-05",
            patientRaw: "PT ONE",
            patientCodeRaw: "TY9845",
            labCaseRef: "DT9003874",
            description: "Crown",
            toothRaw: "11",
            qty: 1,
            unitPrice: 3200,
            amount: 3200,
            agingBucket: "CURRENT",
          },
        ],
      },
    ],
    subtotal: null,
    total: 1000,
    readIssues: [],
    ...over,
  };
}

async function main(): Promise<void> {
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  process.env.VLLM_BASE_URL = `http://127.0.0.1:${port}/v1`;

  // 動態 import（env pin 完先）
  const { seal, open, respContext } = await import("../src/lib/internal/llm-envelope");
  const {
    REQ_CONTEXT_LABDOC,
    validateLabDocRequest,
    parseLabDocResponse,
    extractLabDoc,
    countPages,
    LABDOC_MAX_TEXT_CHARS,
    LabDocValidationError,
    __resetLabDocBreakerForTest,
  } = await import("../src/lib/internal/labdoc-llm");
  const { LABDOC_EXTRACT_PROMPT, buildLabDocPrompt, LABDOC_MAX_HINT_CHARS } = await import("../src/lib/labdoc/prompt");
  const { POST } = await import("../src/app/api/internal/labdoc-extract/route");
  const { NextRequest } = await import("next/server");
  const { getAppRedis } = await import("../src/lib/queue");

  // ══════════ 1. 信封 round-trip ══════════
  console.log("[1] 信封 round-trip（context = labdoc-extract.v1）");
  {
    const body = { mode: "TEXT", kindHint: "INVOICE", labHint: null, text: "ENVELOPE TEST 信封測試", images: null };
    const env = seal(TEST_SECRET_B64, "k1", body, REQ_CONTEXT_LABDOC);
    check("REQ_CONTEXT = 'labdoc-extract.v1'", REQ_CONTEXT_LABDOC === "labdoc-extract.v1");
    const dec = open<typeof body>(TEST_SECRET_B64, env, REQ_CONTEXT_LABDOC);
    check("open 還原原文", JSON.stringify(dec) === JSON.stringify(body));
    let threw = false;
    try {
      open(TEST_SECRET_B64, env, `${REQ_CONTEXT_LABDOC}x`);
    } catch {
      threw = true;
    }
    check("context 改一字 → open throw（AAD 綁 context）", threw);
    // llm-extract 嘅 context 開唔到我哋嘅信封（context 隔離）
    let threwOldCtx = false;
    try {
      open(TEST_SECRET_B64, env, "req:llm-extract");
    } catch {
      threwOldCtx = true;
    }
    check("用 llm-extract context open → throw（唔共用 context）", threwOldCtx);
    // 回應路徑：respContext(nonce)
    const respBody = { result: null, reason: "mock" };
    const respEnv = seal(TEST_SECRET_B64, "k1", respBody, respContext(env.nonce));
    const dec2 = open<typeof respBody>(TEST_SECRET_B64, respEnv, respContext(env.nonce));
    check("respContext(nonce) round-trip", JSON.stringify(dec2) === JSON.stringify(respBody));
    // 錯 key（改一個 b64 char — 必變）
    const badSecret = TEST_SECRET_B64.slice(0, 10) + (TEST_SECRET_B64[10] === "A" ? "B" : "A") + TEST_SECRET_B64.slice(11);
    let threwKey = false;
    try {
      open(badSecret, env, REQ_CONTEXT_LABDOC);
    } catch {
      threwKey = true;
    }
    check("錯 key → open throw", threwKey);
  }

  // ══════════ 2. 契約 fixture lock（兩 repo 防漂移）══════════
  console.log("[2] 契約 fixture lock");
  {
    const promptFxDest = path.join(REPO, "test", "fixtures", "labdoc", "prompt.v1.txt");
    const promptFx = fs.readFileSync(promptFxDest, "utf8");
    check("prompt.v1.txt === LABDOC_EXTRACT_PROMPT（byte-identical）", promptFx === LABDOC_EXTRACT_PROMPT,
      `fx=${Buffer.byteLength(promptFx)}B vs embedded=${Buffer.byteLength(LABDOC_EXTRACT_PROMPT)}B`);
    check("prompt 含 {labHint} 佔位行", LABDOC_EXTRACT_PROMPT.endsWith("{labHint}\n"));
    check("prompt 首行正確", LABDOC_EXTRACT_PROMPT.startsWith("你係牙科 Lab 單據讀取器。"));

    const schemaSrc = fs.readFileSync(path.join(REPO, "src", "lib", "labdoc", "schema.json"), "utf8");
    const schemaFx = fs.readFileSync(path.join(REPO, "test", "fixtures", "labdoc", "schema.v1.json"), "utf8");
    check("schema.v1.json === schema.json（byte-identical）", schemaSrc === schemaFx);
    const schema = JSON.parse(schemaSrc);
    for (const k of ["kind", "lab", "billTo", "groups", "sections", "subtotal", "total", "readIssues"]) {
      check(`schema.json 有頂層欄 ${k}`, k in (schema.properties ?? {}));
    }
    check("schema.json kind enum", JSON.stringify(schema.properties?.kind?.enum) === JSON.stringify(["INVOICE", "STATEMENT"]));
  }

  // ══════════ 3. prompt build（{labHint} 語義）══════════
  console.log("[3] prompt build");
  {
    const noHint = buildLabDocPrompt(null);
    check("null hint → 佔位行移除", !noHint.includes("{labHint}") && noHint.endsWith("f. 付款、承上結餘、服務費行要標 lineType（PAYMENT／BF／CHARGE）。\n"));
    check("null hint = 原文 − 最後一行", noHint === LABDOC_EXTRACT_PROMPT.slice(0, -"{labHint}\n".length));
    const withHint = buildLabDocPrompt("Lab 名常見拼寫：DentaLab / DENTALAB");
    check("hint → 佔位行替換", withHint.endsWith("Lab 名常見拼寫：DentaLab / DENTALAB\n") && !withHint.includes("{labHint}"));
    const padded = buildLabDocPrompt("   HINT SPACED   ");
    check("hint trim", padded.endsWith("HINT SPACED\n"));
    const long = buildLabDocPrompt("x".repeat(LABDOC_MAX_HINT_CHARS + 50));
    check(`hint cap ${LABDOC_MAX_HINT_CHARS}`, long.endsWith("x".repeat(LABDOC_MAX_HINT_CHARS) + "\n"));
    const blank = buildLabDocPrompt("   ");
    check("空白 hint = null（移除）", blank === noHint);
  }

  // ══════════ 4. validateLabDocRequest ══════════
  console.log("[4] validateLabDocRequest（TEXT/VISION 入參驗證）");
  {
    const okText = { mode: "TEXT", kindHint: "INVOICE", labHint: "hint", text: "p1\n<<<PAGE 2>>>\np2", images: null };
    const r1 = validateLabDocRequest(okText);
    check("TEXT 合法", r1.mode === "TEXT" && r1.text === okText.text && r1.labHint === "hint" && r1.images === null);
    check("countPages = 2", countPages("p1\n<<<PAGE 2>>>\np2") === 2);
    check("countPages 無分界 = 1", countPages("just one page") === 1);

    const okVision = { mode: "VISION", kindHint: "STATEMENT", labHint: null, text: null, images: [TINY_JPEG_B64, TINY_JPEG_B64] };
    const r2 = validateLabDocRequest(okVision);
    check("VISION 合法（2 張 jpeg）", r2.mode === "VISION" && r2.images?.length === 2 && r2.text === null);

    const mustThrow = (name: string, p: unknown) => {
      let threw = false;
      try {
        validateLabDocRequest(p);
      } catch (e) {
        threw = e instanceof LabDocValidationError;
      }
      check(name, threw);
    };
    mustThrow("mode 錯", { ...okText, mode: "AUDIO" });
    mustThrow("kindHint 錯", { ...okText, kindHint: "RECEIPT" });
    mustThrow("payload 唔係 object", [1, 2]);
    mustThrow("TEXT 空 text", { ...okText, text: "" });
    mustThrow("TEXT 無 text", { mode: "TEXT", kindHint: "INVOICE" });
    mustThrow("TEXT 60001 字", { ...okText, text: "x".repeat(LABDOC_MAX_TEXT_CHARS + 1) });
    const boundary = validateLabDocRequest({ ...okText, text: "x".repeat(LABDOC_MAX_TEXT_CHARS) });
    check("TEXT 60000 字 = 合法（邊界）", boundary.text === "x".repeat(LABDOC_MAX_TEXT_CHARS));
    mustThrow("TEXT 帶非空 images", { ...okText, images: [TINY_JPEG_B64] });
    check("TEXT 帶空 images = 合法", validateLabDocRequest({ ...okText, images: [] }).text === okText.text);
    mustThrow("VISION 0 張", { ...okVision, images: [] });
    mustThrow("VISION 9 張", { ...okVision, images: Array(9).fill(TINY_JPEG_B64) });
    mustThrow("VISION 非 base64", { ...okVision, images: ["!!!not-b64!!!"] });
    mustThrow("VISION 非 JPEG（PNG magic）", { ...okVision, images: [PNG_B64] });
    mustThrow("VISION 帶非空 text", { ...okVision, text: "some text" });
    mustThrow("labHint 非 string", { ...okText, labHint: 42 });
    mustThrow("images 元素非 string", { ...okVision, images: [123] });
    const capped = validateLabDocRequest({ ...okText, labHint: "y".repeat(900) });
    check("labHint cap 500", capped.labHint === "y".repeat(500));
    const extra = validateLabDocRequest({ ...okText, unknownFutureField: true });
    check("未知多餘欄位忽略", extra.text === okText.text);
  }

  // ══════════ 5. parseLabDocResponse ══════════
  console.log("[5] parseLabDocResponse（parse_error / bad_response / 丟棄多餘欄位）");
  {
    const good = parseLabDocResponse(JSON.stringify(invoiceSample()));
    check("合法 INVOICE → result + reason null", good.reason === null && good.result?.kind === "INVOICE");
    const fenced = parseLabDocResponse("```json\n" + JSON.stringify(statementSample()) + "\n```");
    check("``` fence → 照解", fenced.reason === null && fenced.result?.kind === "STATEMENT");
    const prose = parseLabDocResponse("我睇咗張單，總數係 3200 蚊");
    check("非 JSON → parse_error", prose.reason === "parse_error" && prose.result === null);
    const arr = parseLabDocResponse("[1,2,3]");
    check("JSON 陣列（唔係物件）→ parse_error", arr.reason === "parse_error");
    const num = parseLabDocResponse("42");
    check("JSON 數字 → parse_error", num.reason === "parse_error");

    const noTotal = invoiceSample();
    delete noTotal.total;
    const bad1 = parseLabDocResponse(JSON.stringify(noTotal));
    check("缺必填 total → bad_response", bad1.reason === "bad_response" && bad1.result === null);
    const badDate = parseLabDocResponse(JSON.stringify(invoiceSample({ date: "2026/10/01" })));
    check("date 唔係 YYYY-MM-DD → bad_response", badDate.reason === "bad_response");
    const badMonth = parseLabDocResponse(JSON.stringify(statementSample({ statementMonth: "09/2026" })));
    check("statementMonth 格式錯 → bad_response", badMonth.reason === "bad_response");
    const invWithSections = parseLabDocResponse(JSON.stringify(invoiceSample({ sections: [statementSample().sections[0]] })));
    check("INVOICE 帶 sections → bad_response（invariant）", invWithSections.reason === "bad_response");
    const stWithGroups = parseLabDocResponse(JSON.stringify(statementSample({ groups: [invoiceSample().groups[0]] })));
    check("STATEMENT 帶 groups → bad_response（invariant）", stWithGroups.reason === "bad_response");
    const badLineType = statementSample();
    badLineType.sections[0].lines[0].lineType = "XXX";
    check("lineType 唔喺 enum → bad_response", parseLabDocResponse(JSON.stringify(badLineType)).reason === "bad_response");
    const badAmt = invoiceSample();
    badAmt.groups[0].lines[0].amount = "3200";
    check("amount 字符串 → bad_response", parseLabDocResponse(JSON.stringify(badAmt)).reason === "bad_response");

    const extra = parseLabDocResponse(JSON.stringify(invoiceSample({ extraField: "drop me", lab: { nameRaw: "LAB A", nameCnRaw: null, payeeRaw: null, unknownDeep: 1 } })));
    check("多餘頂層欄位丟棄", extra.reason === null && !("extraField" in (extra.result ?? {})));
    check("多餘深層欄位丟棄", extra.reason === null && !("unknownDeep" in (extra.result?.lab ?? {})));
  }
  // ══════════ 6. AI_MOCK 決定性 mock ══════════
  console.log("[6] AI_MOCK 決定性 mock");
  {
    process.env.AI_MOCK = "1";
    const m1 = await extractLabDoc({ mode: "TEXT", kindHint: "INVOICE", labHint: null, text: "x", images: null });
    check("mock INVOICE → reason=mock + kind=INVOICE", m1.reason === "mock" && m1.result?.kind === "INVOICE");
    const m2 = await extractLabDoc({ mode: "VISION", kindHint: "STATEMENT", labHint: null, text: null, images: [TINY_JPEG_B64] });
    check("mock STATEMENT → kind=STATEMENT", m2.reason === "mock" && m2.result?.kind === "STATEMENT");
    process.env.AI_MOCK = "0";
  }

  // ══════════ 7. route in-process ══════════
  console.log("[7] route in-process（mock 上游）");
  const ROUTE_URL = "http://127.0.0.1:3105/api/internal/labdoc-extract";
  async function hit(rawBody: string): Promise<{ status: number; body: any }> {
    const req = new NextRequest(ROUTE_URL, { method: "POST", body: rawBody, headers: { "content-type": "application/json" } });
    const res = await POST(req);
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
    return { status: res.status, body };
  }
  const sealReq = (payload: unknown, kid = "k1") => seal(TEST_SECRET_B64, kid, payload, REQ_CONTEXT_LABDOC);
  function openResp(hitR: { body: any }, reqNonce: string): { result: any; reason: string | null } | null {
    try {
      return open<{ result: any; reason: string | null }>(TEST_SECRET_B64, hitR.body, respContext(reqNonce));
    } catch {
      return null;
    }
  }

  // 7a. 503 NOT_ENABLED（flag 關）
  process.env.LLM_PROXY_ENABLED = "0";
  {
    const r = await hit(JSON.stringify(sealReq({ mode: "TEXT", kindHint: "INVOICE", text: "x", images: null })));
    check("LLM_PROXY_ENABLED=0 → 503 NOT_ENABLED", r.status === 503 && r.body?.error === "NOT_ENABLED");
  }
  process.env.LLM_PROXY_ENABLED = "1";

  // 7b. 413 TOO_LARGE（>12MB，JSON parse 之前）
  {
    const big = "A".repeat(12 * 1024 * 1024 + 1024);
    const raw = `{"v":1,"kid":"k1","ts":${Date.now()},"nonce":"n413","iv":"x","ct":"${big}","tag":"x"}`;
    const r = await hit(raw);
    check("12MB+1KB → 413 TOO_LARGE", r.status === 413 && r.body?.error === "TOO_LARGE");
  }
  // 413 TOO_LARGE（m-1：嚴-byte 語義 — astral 字元 = 2 UTF-16 code units / 4 UTF-8 bytes，
  //   舊 raw.length 檢查對呢類 body 會放過 ~2× 上限）
  {
    const big = "🚀".repeat(4_000_000); // code units = 8MB，bytes = 16MB
    check(
      "前提：code units <12MB 但 bytes >12MB（舊 raw.length 會放過）",
      big.length <= 12 * 1024 * 1024 && Buffer.byteLength(big) > 12 * 1024 * 1024,
      `len=${big.length} bytes=${Buffer.byteLength(big)}`
    );
    const raw = `{"v":1,"kid":"k1","ts":${Date.now()},"nonce":"n413b","iv":"x","ct":"${big}","tag":"x"}`;
    const r = await hit(raw);
    check("astral 密集 body（bytes >12MB、code units <12MB）→ 413 TOO_LARGE", r.status === 413 && r.body?.error === "TOO_LARGE", `got ${r.status}`);
  }
  // 400 BAD_JSON
  {
    const r = await hit("this is not json");
    check("非 JSON → 400 BAD_JSON", r.status === 400 && r.body?.error === "BAD_JSON");
  }
  // 401 BAD_ENVELOPE（kid 錯）
  {
    const r = await hit(JSON.stringify(sealReq({ mode: "TEXT", kindHint: "INVOICE", text: "x", images: null }, "k2")));
    check("kid k2 vs server k1 → 401 BAD_ENVELOPE", r.status === 401 && r.body?.error === "BAD_ENVELOPE");
  }
  // 401 STALE（ts 早 2 分鐘）
  {
    const realNow = Date.now.bind(Date);
    let shiftMs = 0;
    (Date as any).now = () => realNow() + shiftMs;
    shiftMs = -120_000;
    const env = sealReq({ mode: "TEXT", kindHint: "INVOICE", text: "x", images: null });
    shiftMs = 0;
    (Date as any).now = realNow;
    const r = await hit(JSON.stringify(env));
    check("ts 早 2 分鐘 → 401 STALE", r.status === 401 && r.body?.error === "STALE");
  }
  // 401 BAD_TAG（tag 改一 byte）
  {
    const env = sealReq({ mode: "TEXT", kindHint: "INVOICE", text: "x", images: null });
    const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const i = B64.indexOf(env.tag[0]);
    const bad = { ...env, tag: (i >= 0 ? B64[(i + 7) % B64.length] : B64[0]) + env.tag.slice(1) };
    const r = await hit(JSON.stringify(bad));
    check("tag 改一 byte → 401 BAD_TAG", r.status === 401 && r.body?.error === "BAD_TAG");
    check("BAD_TAG 回應只含原因碼", r.body !== null && Object.keys(r.body).length === 1 && r.body?.error === "BAD_TAG");
  }
  // 400 BAD_PAYLOAD（mode 錯；回應 detail 係固定原因碼、唔含原文）
  {
    const MARKER = "LABDOCRAWMARKER_7f3a";
    const env = sealReq({ mode: "AUDIO", kindHint: "INVOICE", text: `含 ${MARKER} 嘅 text`, images: null });
    const r = await hit(JSON.stringify(env));
    check("mode=AUDIO → 400 BAD_PAYLOAD", r.status === 400 && r.body?.error === "BAD_PAYLOAD");
    check("BAD_PAYLOAD detail 係固定原因碼", r.body?.detail === "mode must be TEXT|VISION");
    check("BAD_PAYLOAD 回應唔含原文 marker", !JSON.stringify(r.body).includes(MARKER));
  }
  // 409 REPLAY（同一信封兩次 — 要 redis）
  {
    const raw = JSON.stringify(sealReq({ mode: "TEXT", kindHint: "INVOICE", text: "replay test", images: null }));
    const r1 = await hit(raw);
    const r2 = await hit(raw);
    check("同一信封第一次 → 200", r1.status === 200, `got ${r1.status}`);
    check("同一信封第二次 → 409 REPLAY", r2.status === 409 && r2.body?.error === "REPLAY");
  }

  // 7c. happy TEXT（mock 上游回合法 INVOICE；驗 prompt 上游斷言）
  {
    upstreamBodies.length = 0;
    upstreamMode = { kind: "content", content: JSON.stringify(invoiceSample()) };
    const text = "CLINIC INVOICE 2026\n<<<PAGE 2>>>\nCONTINUED";
    const env = sealReq({ mode: "TEXT", kindHint: "INVOICE", labHint: "Lab 常見名：DentaLab", text, images: null });
    const r = await hit(JSON.stringify(env));
    check("happy TEXT → 200", r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`);
    const dec = openResp(r, env.nonce);
    check("resp 解得（respContext）", dec !== null);
    check("result.kind=INVOICE + reason=null", dec?.reason === null && dec?.result?.kind === "INVOICE");
    check("result 內容同上游一致", dec?.result?.total === 3200 && dec?.result?.docNoRaw === "INV-001");
    const sent = upstreamBodies.at(-1) as any;
    const sys = sent?.messages?.[0]?.content;
    const usr = sent?.messages?.[1]?.content;
    check("system message = §5.3 prompt + labHint 替換", typeof sys === "string" && sys.includes("你係牙科 Lab 單據讀取器") && sys.includes("Lab 常見名：DentaLab") && !sys.includes("{labHint}"));
    check("user message = 原文 text（pass-through）", usr === text);
    check("guided_json 有送（同 schema.json 契約）", typeof sent?.guided_json === "object" && sent?.guided_json?.properties?.kind !== undefined);
  }
  // 7d. happy VISION（驗 image_url data URL）
  {
    upstreamBodies.length = 0;
    upstreamMode = { kind: "content", content: JSON.stringify(statementSample()) };
    const env = sealReq({ mode: "VISION", kindHint: "STATEMENT", labHint: null, text: null, images: [TINY_JPEG_B64] });
    const r = await hit(JSON.stringify(env));
    check("happy VISION → 200", r.status === 200, `got ${r.status}`);
    const dec = openResp(r, env.nonce);
    check("VISION result.kind=STATEMENT", dec?.result?.kind === "STATEMENT" && dec?.reason === null);
    const sent = upstreamBodies.at(-1) as any;
    const usr = sent?.messages?.[1]?.content;
    check("VISION user = content parts（text + image_url）", Array.isArray(usr) && usr[0]?.type === "text" && usr[1]?.type === "image_url" && usr[1]?.image_url?.url === `data:image/jpeg;base64,${TINY_JPEG_B64}`);
  }
  // 7e. reason 路徑：parse_error / bad_response
  {
    upstreamMode = { kind: "content", content: "呢個唔係 JSON，我睇到總數 3200" };
    let env = sealReq({ mode: "TEXT", kindHint: "INVOICE", labHint: null, text: "page", images: null });
    let r = await hit(JSON.stringify(env));
    let dec = openResp(r, env.nonce);
    check("上游非 JSON → result=null + reason=parse_error", r.status === 200 && dec?.result === null && dec?.reason === "parse_error");

    const missing = invoiceSample();
    delete missing.total;
    upstreamMode = { kind: "content", content: JSON.stringify(missing) };
    env = sealReq({ mode: "TEXT", kindHint: "INVOICE", labHint: null, text: "page", images: null });
    r = await hit(JSON.stringify(env));
    dec = openResp(r, env.nonce);
    check("上游 JSON 缺必填 → result=null + reason=bad_response", r.status === 200 && dec?.result === null && dec?.reason === "bad_response");
  }
  // 7f. 429 BUSY（CONCURRENCY=1 + 上游 sleep 占位）
  // ★ M-1（2026-10-04 reviewer 修復）：429 唔消耗 nonce — CWM 重試同一信封
  //   必須 429→(恢復後) 200，而唔係永久 409 REPLAY（舊行為：BUSY 時 nonce 已入 Redis）。
  {
    upstreamMode = { kind: "sleep", ms: 1200, content: JSON.stringify(invoiceSample()) };
    const envA = sealReq({ mode: "TEXT", kindHint: "INVOICE", labHint: null, text: "busy A", images: null });
    const envB = sealReq({ mode: "TEXT", kindHint: "INVOICE", labHint: null, text: "busy B", images: null });
    const [ra, rb] = await Promise.all([hit(JSON.stringify(envA)), hit(JSON.stringify(envB))]);
    const pairs = [{ env: envA, r: ra }, { env: envB, r: rb }];
    const busyP = pairs.find((p) => p.r.status === 429);
    const okP = pairs.find((p) => p.r.status === 200);
    check("同時兩請求（CONCURRENCY=1）→ 一個 429 BUSY", busyP !== undefined && busyP.r.body?.error === "BUSY" && busyP.r.body?.retryAfterSec === 5, `statuses=${[ra.status, rb.status]}`);
    check("另一個照 200", okP !== undefined);
    if (busyP && okP) {
      const redis = getAppRedis();
      check("429 BUSY 嘅 nonce 未消耗（Redis key 唔存在）", (await redis.exists(`labdocx:nonce:${busyP.env.nonce}`)) === 0);
      check("200 嘅 nonce 已消耗（Redis key 存在）", (await redis.exists(`labdocx:nonce:${okP.env.nonce}`)) === 1);
      // CWM 重試契約：429 後原信封重發 → 200（唔係 409 REPLAY）
      const retry = await hit(JSON.stringify(busyP.env));
      check("429 後原信封重發 → 200（重試契約）", retry.status === 200, `got ${retry.status} ${JSON.stringify(retry.body)}`);
      check("重試成功後 nonce 已消耗 → 再重發 409 REPLAY", (await hit(JSON.stringify(busyP.env))).status === 409);
    } else {
      check("429/200 pair 異常 — M-1 契約斷言 skip", false, `statuses=${[ra.status, rb.status]}`);
    }
  }
  // 7g. llm_error ×3 → breaker_open（獨立 breaker）
  {
    __resetLabDocBreakerForTest();
    upstreamMode = { kind: "500" };
    const reasons: string[] = [];
    for (let i = 0; i < 4; i++) {
      const env = sealReq({ mode: "TEXT", kindHint: "INVOICE", labHint: null, text: `fail ${i}`, images: null });
      const r = await hit(JSON.stringify(env));
      const dec = openResp(r, env.nonce);
      reasons.push(`${r.status}:${dec?.reason ?? "NOOPEN"}`);
    }
    check("上游 500 ×3 → reason=llm_error", reasons[0] === "200:llm_error" && reasons[1] === "200:llm_error" && reasons[2] === "200:llm_error", reasons.join(","));
    check("第 4 次 → breaker_open（breaker 已開）", reasons[3] === "200:breaker_open", reasons.join(","));
    __resetLabDocBreakerForTest();
    // 復位後控制組
    upstreamMode = { kind: "content", content: JSON.stringify(invoiceSample()) };
    const env = sealReq({ mode: "TEXT", kindHint: "INVOICE", labHint: null, text: "recover", images: null });
    const r = await hit(JSON.stringify(env));
    const dec = openResp(r, env.nonce);
    check("breaker reset 後 → 200 + result", r.status === 200 && dec?.result?.kind === "INVOICE");
  }

  upstream.close();
  console.log(failures === 0 ? "\nunit-labdoc-extract: ALL PASS" : `\nunit-labdoc-extract: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});

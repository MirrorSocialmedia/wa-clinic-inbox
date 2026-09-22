/**
 * e2e-s29a-t745-749.ts — cwi-final S2-9a wa-inbox LLM proxy 驗收
 *
 *   T745  tag 改一 byte → 401 BAD_TAG；kid 錯 → 401 BAD_ENVELOPE（回應只回原因碼，唔洩 error message）
 *   T746  同一信封送兩次 → 第二次 409 REPLAY（Redis nonce 180s NX）
 *   T747  ts 早 2 分鐘 → 401 STALE
 *   T623-W wa-inbox 側：打 route 前後 6 張業務表（Message/AuditLog/AiDraft/Alert/WebhookEvent/StaffNotice）
 *                count(*) 不變（route 零 DB 寫入）；notePlain 含 marker 字串 → 任何 log 0 hit
 *                （marker grep 喺 mock-e2e.sh N 段做 — 佢攞住本 process 全部 stdout 連 pino fd1 行）
 *   S29A-VECTOR 信封 test vector：fixture open 返原文；context 改一字 → throw（防兩邊實作漂移）
 *   T748  CONCURRENCY=1 同時兩個 → 一個 429 BUSY + retryAfterSec=5（429 契約；workforce 重試邏輯係 C6 單）
 *   T749  mock 上游連續 500×3 → proxy 回 reason:"llm_error"×3 然後 "breaker_open"；
 *                同 process chatWithFallback（skipBreaker=false）shared breaker 仍 closed（獨立 breaker 隔離 R-29）
 *
 * 前置：dev stack live（server 3100 / DB 15432 / redis 6379）+ .env.local 有 INTERNAL_LLM_SECRET
 *   （gitignored，random — openssl rand -base64 48；.env.example 只預設 OFF 模板，唔含實值）。
 * 跑法（repo root）：pnpm -s tsx scripts/e2e-s29a-t745-749.ts
 *
 * 方法：in-process 打 route（import route 嘅 POST 直接 call — 同 J/K/L/M 段 in-process 慣例）。
 *   理由：(a) 3100 dev server 嘅 env 冇 LLM_PROXY_*（起機時 snapshot），in-process 可以 hermetic pin；
 *         (b) T749「同 process breaker」斷言要求 route 同斷言喺同一 module instance；
 *         (c) 本 process 零 DB 寫入 → T623 count 斷言乾淨。
 *   route 鐵律自檢（零 prisma / 零 body log / 零 cache）由 scripts/check-internal-no-persist.sh 靜態鎖。
 *
 * 決定性：
 *   - 上游 = 本 process 起嘅 127.0.0.1 ephemeral port mock（sleep200 / 500 兩 mode）— 唔打真 GPU。
 *   - T748 用 upstream 延遲（1.2s）令第一請求真占住 concurrency slot 先發第二個 — 429 必現。
 *   - T749 排最後（佢會開 quote-llm 自己個 breaker 60s，唔會連累前面任何測試）。
 *
 * 輸出 markers（mock-e2e.sh N 段 grep）：
 *   T745-OK / T746-OK / T747-OK / T623W-OK / S29A-VECTOR-OK / T748-OK / T749-OK / S29A-SWEEP-OK
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── 0. env pin（必須喺 loadEnvFile + 動態 import 之前；loadEnvFile 唔會覆寫已有 env）────────
process.env.LLM_PROXY_ENABLED = "1"; // 本測試明確開 flag（.env.example 預設 0 = 鐵律唔受影響）
process.env.INTERNAL_LLM_KID = "k1";
process.env.LLM_PROXY_CONCURRENCY = "1"; // T748 用；route module top-level 讀 → 必須先 pin
process.env.AI_MOCK = "1"; // T745–T623/VECTOR 走 deterministic mock 路徑；T748/T749 先改 "0" 打 mock 上游
process.env.AI_TIMEOUT_MS = "5000";

try {
  process.loadEnvFile(path.join(REPO, ".env"));
} catch {
  /* 靠 process env */
}
try {
  process.loadEnvFile(path.join(REPO, ".env.local"));
} catch {
  /* 靠 process env */
}

const SECRET = process.env.INTERNAL_LLM_SECRET ?? "";
const SECRET_BYTES = Buffer.from(SECRET, "base64").length;
if (SECRET_BYTES < 32) {
  console.error(`FATAL: INTERNAL_LLM_SECRET 未設或 < 32 bytes（base64 decode=${SECRET_BYTES}）— 應該喺 .env.local（gitignored）放 random 值（openssl rand -base64 48）`);
  process.exit(1);
}

let failures = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok: ${msg}`);
  else {
    failures++;
    console.error(`  ❌ FAIL: ${msg}`);
  }
}

async function main(): Promise<void> {
// ── mock 上游（127.0.0.1 ephemeral port，OpenAI-compatible）──────────────────────────────
let upstreamMode: "sleep200" | "500" = "sleep200";
const MOCK_CONTENT = JSON.stringify({ items: [{ text: "A1", code: "A1", amount: 4000, perUnit: false }] });
const upstream = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }
  req.resume();
  req.on("end", () => {
    if (upstreamMode === "500") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "mock upstream boom" } }));
      return;
    }
    // sleep200：延遲 1.2s 先回（T748 令第一請求真占住 concurrency slot）
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: MOCK_CONTENT } }], usage: { total_tokens: 10 } }));
    }, 1200);
  });
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = (upstream.address() as AddressInfo).port;
process.env.VLLM_BASE_URL = `http://127.0.0.1:${upstreamPort}/v1`;
process.env.VLLM_FALLBACK_MODEL = ""; // 單一 model — T749 失敗計數路徑清晰

// ── 動態 import（env pin 完先初始化 route module — CONCURRENCY top-level 讀）─────────────
const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient();
const { seal, open, REQ_CONTEXT, respContext } = await import("../src/lib/internal/llm-envelope");
const { POST } = await import("../src/app/api/internal/llm-extract/route");
const vllm = await import("../src/lib/ai/vllm");

const ROUTE_URL = "http://127.0.0.1:3100/api/internal/llm-extract";
const MARKER = "S29A_LEAK_PROBE_7f3a"; // T623 洩露 probe（controlled 字串 — 零 PII；只准出現喺 envelope 密文入面）
let BASELINE: Record<string, number> | null = null; // T623 前態 6 表 count — SWEEP 對返（全 run 零 DB 寫入）
const TERMS = [
  { shorthand: "A1", nameCn: "牙冠修復", nameEn: "Crown" },
  { shorthand: "B2", nameCn: "根管治療", nameEn: "RCT" },
  { shorthand: "C3", nameCn: "洗牙抛光", nameEn: "Scaling" },
];

interface Hit { status: number; body: any; cc: string | null }
async function hit(rawBody: string): Promise<Hit> {
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(ROUTE_URL, { method: "POST", body: rawBody, headers: { "content-type": "application/json" } });
  const res = await POST(req);
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* 非 JSON body（唔應該發生） */
  }
  return { status: res.status, body, cc: res.headers.get("cache-control") };
}
function openResp(hitR: Hit, reqNonce: string): { items: any[] | null; reason: string | null } | null {
  try {
    return open<{ items: any[] | null; reason: string | null }>(SECRET, hitR.body, respContext(reqNonce));
  } catch {
    return null;
  }
}

// ══════════════ T745：tag 改一 byte → 401 BAD_TAG；kid 錯 → 401 BAD_ENVELOPE ══════════════
{
  const f0 = failures;
  const body745 = { notePlain: "T745 驗封裝：A1 做咗。", terms: TERMS };
  const env745 = seal(SECRET, "k1", body745, REQ_CONTEXT);
  // control：有效信封 → 200 + resp envelope（順帶驗 resp 路徑）
  const ctrl = await hit(JSON.stringify(env745));
  ok(ctrl.status === 200 && ctrl.cc === "no-store", "T745 control：有效信封 → 200 + cache-control no-store");
  const ctrlDec = openResp(ctrl, env745.nonce);
  ok(ctrlDec?.reason === "mock" && Array.isArray(ctrlDec?.items) && ctrlDec?.items?.[0]?.code === "A1", "T745 control：resp envelope open → reason=mock + items 含 A1");
  // (a) tag 改一個 base64 char（= 至少 1 byte 變）→ GCM auth 必 fail → 401 BAD_TAG
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const i = B64.indexOf(env745.tag[0]);
  const envBadTag = { ...env745, tag: (i >= 0 ? B64[(i + 7) % B64.length] : B64[0]) + env745.tag.slice(1) };
  const r745a = await hit(JSON.stringify(envBadTag));
  ok(r745a.status === 401 && r745a.body?.error === "BAD_TAG", "T745a：tag 改一 byte → 401 BAD_TAG");
  ok(r745a.body !== null && Object.keys(r745a.body).length === 1 && r745a.body?.error === "BAD_TAG", "T745a：回應體只含原因碼（唔洩 error message / 內容）");
  // (b) kid 錯（信封 k2 vs server k1）→ 401 BAD_ENVELOPE（kid 檢查喺 open 之前）
  const r745b = await hit(JSON.stringify(seal(SECRET, "k2", body745, REQ_CONTEXT)));
  ok(r745b.status === 401 && r745b.body?.error === "BAD_ENVELOPE", "T745b：kid 錯 → 401 BAD_ENVELOPE");
  if (failures === f0) console.log("T745-OK");
}

// ══════════════ T746：同一信封送兩次 → 第二次 409 REPLAY ══════════════
{
  const f0 = failures;
  const raw746 = JSON.stringify(seal(SECRET, "k1", { notePlain: "T746 重放驗：B2 未做。", terms: TERMS }, REQ_CONTEXT));
  const r1 = await hit(raw746);
  ok(r1.status === 200, "T746：同一信封第一次 → 200（nonce 入 Redis 180s NX）");
  const r2 = await hit(raw746);
  ok(r2.status === 409 && r2.body?.error === "REPLAY", "T746：同一信封第二次 → 409 REPLAY");
  if (failures === f0) console.log("T746-OK");
}

// ══════════════ T747：ts 早 2 分鐘 → 401 STALE ══════════════
{
  const f0 = failures;
  // 合法嘅 stale 信封：patch Date.now 後 seal（AAD 綁 ts → 簽完先還原，tag 依然有效 — 401 一定要出喺 STALE 檢查）
  const realNow = Date.now.bind(Date);
  let shiftMs = 0;
  (Date as any).now = () => realNow() + shiftMs;
  shiftMs = -120_000;
  const env747 = seal(SECRET, "k1", { notePlain: "T747 stale 驗。", terms: TERMS }, REQ_CONTEXT);
  shiftMs = 0;
  (Date as any).now = realNow;
  ok(Math.abs(env747.ts - realNow()) >= 119_000, "T747：seal 成功喺 2 分鐘前嘅時鐘（ts 偏移確認）");
  const r747 = await hit(JSON.stringify(env747));
  ok(r747.status === 401 && r747.body?.error === "STALE", "T747：ts 早 2 分鐘 → 401 STALE");
  if (failures === f0) console.log("T747-OK");
}

// ══════════════ S29A-VECTOR：信封 test vector（fixture open 返原文 + context 改一字 throw）══════════════
{
  const f0 = failures;
  const fixture = JSON.parse(fs.readFileSync(path.join(REPO, "test", "fixtures", "llm-envelope.v1.json"), "utf8")) as any;
  const dec = open<unknown>(fixture._meta.secret_b64, fixture.envelope, fixture._meta.context);
  ok(JSON.stringify(dec) === JSON.stringify(fixture._meta.body), "VECTOR：open(fixture) 還原原文（固定測試 key）");
  let threwCtx = false;
  try {
    open<unknown>(fixture._meta.secret_b64, fixture.envelope, `${fixture._meta.context}x`);
  } catch {
    threwCtx = true;
  }
  ok(threwCtx, "VECTOR：context 改一字 → open throw（AAD 綁 context — 防兩邊實作漂移）");
  let threwKey = false;
  const badSecret = fixture._meta.secret_b64.slice(0, 10) + (fixture._meta.secret_b64[10] === "A" ? "B" : "A") + fixture._meta.secret_b64.slice(11);
  try {
    open<unknown>(badSecret, fixture.envelope, fixture._meta.context);
  } catch {
    threwKey = true;
  }
  ok(threwKey, "VECTOR：錯 key → open throw");
  if (failures === f0) console.log("S29A-VECTOR-OK");
}

// ══════════════ T623-W：route 零 DB 寫入（6 表 count 前後不變）+ marker 唔落 log ══════════════
{
  const f0 = failures;
  const TABLES = ["Message", "AuditLog", "AiDraft", "Alert", "WebhookEvent", "StaffNotice"] as const;
  // WebhookEvent 冇 createdAt（佢用 receivedAt）— 診斷用 time column per table
  const TIME_COL: Record<string, string> = { WebhookEvent: "receivedAt" };
  async function tableCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of TABLES) {
      const rows = (await prisma.$queryRawUnsafe(`SELECT count(*)::bigint AS c FROM "${t}"`)) as unknown as { c: bigint }[];
      out[t] = Number(rows[0].c);
    }
    return out;
  }
  const t0 = new Date().toISOString();
  const before = await tableCounts();
  BASELINE = before;
  // notePlain 含 marker — 鐵律：佢只可以活喺 envelope 密文入面；任何 log / DB / 回應 items 都唔應該有佢
  const env623 = seal(SECRET, "k1", { notePlain: `報價 follow-up（${MARKER}）：A1 做咗，B2 未做。`, terms: TERMS }, REQ_CONTEXT);
  const r623 = await hit(JSON.stringify(env623));
  ok(r623.status === 200, "T623-W：打 route → 200");
  const dec623 = openResp(r623, env623.nonce);
  ok(dec623?.reason === "mock" && dec623?.items?.length === 2, "T623-W：resp envelope open → items=2（A1+B2，mock 路徑決定性）");
  const t1 = new Date().toISOString();
  const after = await tableCounts();
  let equal = true;
  for (const t of TABLES) {
    if (after[t] !== before[t]) {
      equal = false;
      console.error(`  count 漂移：${t} ${before[t]} → ${after[t]}`);
      // 診斷：漂移窗（t0,t1）內新行喺邊（dev worker 背景寫入嘅话會喺呢度見到）
      try {
        const col = TIME_COL[t] ?? "createdAt";
        const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "${t}" WHERE "${col}" >= $1 AND "${col}" < $2 LIMIT 5`, new Date(t0), new Date(t1)) as unknown as unknown[];
        console.error(`  diag ${t} window rows: ${JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? String(v) : v)).slice(0, 1000)}`);
      } catch (e) {
        console.error(`  diag ${t}: ${(e as Error).message.slice(0, 200)}`);
      }
    }
  }
  ok(equal, "T623-W：打 route 前後 6 張業務表 count(*) 全不變（route 零 DB 寫入）");
  if (failures === f0) console.log("T623W-OK");
}

// ══════════════ T748：CONCURRENCY=1 同時兩個 → 一個 429 BUSY + retryAfterSec=5 ══════════════
{
  const f0 = failures;
  process.env.AI_MOCK = "0"; // 打 mock 上游（sleep200 mode：1.2s 延遲）
  upstreamMode = "sleep200";
  const envA = seal(SECRET, "k1", { notePlain: "T748 並發 A：A1 x4K。", terms: TERMS }, REQ_CONTEXT);
  const envB = seal(SECRET, "k1", { notePlain: "T748 並發 B：B2 x900。", terms: TERMS }, REQ_CONTEXT);
  const p1 = hit(JSON.stringify(envA)); // 占住唯一 slot（~1.2s）
  await new Promise((r) => setTimeout(r, 400));
  const rB = await hit(JSON.stringify(envB));
  const rA = await p1;
  ok(rA.status === 200, "T748：第一請求（占 slot）→ 200");
  ok(rB.status === 429 && rB.body?.error === "BUSY" && rB.body?.retryAfterSec === 5, "T748：同時第二個 → 429 BUSY + retryAfterSec=5（429 契約；重試邏輯喺 C6 workforce client）");
  const decA = openResp(rA, envA.nonce);
  ok(decA?.reason === null && decA?.items?.[0]?.code === "A1" && decA?.items?.[0]?.amount === 4000, "T748：第一請求 resp → items（A1 amount=4000）+ reason=null（上游 200 路徑）");
  if (failures === f0) console.log("T748-OK");
}

// ══════════════ T749：mock 上游 500×3 → llm_error×3 → breaker_open + shared breaker 隔離 ══════════════
// ★ 排最後 — quote-llm 自己個 breaker 會開 60s（唔影響前面測試，但前面唔應該依賴佢）
{
  const f0 = failures;
  process.env.AI_MOCK = "0";
  upstreamMode = "500";
  const mk = (tag: string) => seal(SECRET, "k1", { notePlain: `T749 ${tag}：上游 500。`, terms: TERMS }, REQ_CONTEXT);
  const e1 = mk("e1");
  const e2 = mk("e2");
  const e3 = mk("e3");
  const e4 = mk("e4");
  const r1 = await hit(JSON.stringify(e1));
  const r2 = await hit(JSON.stringify(e2));
  const r3 = await hit(JSON.stringify(e3));
  const r4 = await hit(JSON.stringify(e4));
  // resp envelope 用 respContext(請求 nonce) seal — 要用**請求**信封嘅 nonce 先 open 得
  ok(r1.status === 200 && openResp(r1, e1.nonce)?.reason === "llm_error", "T749a：上游 500 #1 → reason=llm_error（fail 1/3）");
  ok(r2.status === 200 && openResp(r2, e2.nonce)?.reason === "llm_error", "T749b：上游 500 #2 → reason=llm_error（fail 2/3）");
  ok(r3.status === 200 && openResp(r3, e3.nonce)?.reason === "llm_error", "T749c：上游 500 #3 → reason=llm_error（連續 3 fail → 自己個 breaker OPEN）");
  ok(r4.status === 200 && openResp(r4, e4.nonce)?.reason === "breaker_open", "T749d：#4 → reason=breaker_open（直接 skip，唔打 GPU）");
  ok(vllm.getBreakerState().state === "closed", "T749e：proxy 連續失敗唔開 shared breaker（獨立 breaker 隔離 R-29）");
  // 加碼證明：skipBreaker=false 嘅 chatWithFallback 仲係會真打（唔係被 breaker skip）
  let threwCall = false;
  let callMsg = "";
  try {
    await vllm.chatWithFallback(vllm.getAiConfig(), { messages: [{ role: "user", content: "T749 control call" }], skipBreaker: false });
  } catch (e) {
    threwCall = true;
    callMsg = e instanceof Error ? e.message : String(e);
  }
  ok(threwCall && !/breaker OPEN/i.test(callMsg), "T749f：chatWithFallback(skipBreaker=false) 照樣真打上游（throw 原因係上游 500 唔係 breaker skip）");
  ok(vllm.getBreakerState().state === "closed", "T749g：shared breaker 經歷 1 次 fail 仍 closed（要連續 3 次先 OPEN — 狀態未被 proxy 污染）");
  if (failures === f0) console.log("T749-OK");
}

// ══════════════ SWEEP：全 run 零 DB 寫入（終態 count == T623 前態）══════════════
{
  const f0 = failures;
  const TABLES = ["Message", "AuditLog", "AiDraft", "Alert", "WebhookEvent", "StaffNotice"] as const;
  const final: Record<string, number> = {};
  for (const t of TABLES) {
    const rows = (await prisma.$queryRawUnsafe(`SELECT count(*)::bigint AS c FROM "${t}"`)) as unknown as { c: bigint }[];
    final[t] = Number(rows[0].c);
  }
  // 對返 T623-W 段之前嘅 baseline（T623 已斷言 before==after；呢度再斷言 T748/T749 段零寫入 → 全 run 零 DB 寫入）
  let same = true;
  for (const t of TABLES) {
    if (!BASELINE || final[t] !== BASELINE[t]) {
      same = false;
      console.error(`  sweep 漂移：${t} baseline=${BASELINE?.[t]} final=${final[t]}`);
    }
  }
  ok(same, "SWEEP：終態 6 表 count == T623 前態（全 run 零 DB 寫入）");
  if (failures === f0) console.log("S29A-SWEEP-OK");
}

upstream.close();
await prisma.$disconnect();
console.log(failures === 0 ? "ALL S29A CHECKS PASSED" : `S29A CHECKS FAILED: ${failures} failure(s)`);
}

main()
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  });

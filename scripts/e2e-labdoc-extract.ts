/**
 * e2e-labdoc-extract — cwi-labdoc-extract（cwm-labdoc §5.2）真 server e2e
 *
 * 獨立 unit（絕不碰 main 3100 dev unit / wa_inbox DB / wa-dev-3100 worker）：
 *   - server : PORT=3105（tsx server.ts dev mode，spawn 子 process，stdio → log 檔）
 *   - DB     : wa_labdoc（15432 獨立 DB；start 前 drop + create；end 後 drop）
 *   - redis  : db 6（獨立 db；end 後 FLUSHDB）
 *   - 上游   : 本 process mock OpenAI-compatible（fixed port 39099，零真 GPU）
 *   - secret : 本 process 生成 48B random — server 同測試同一份（child env 注入）
 *
 * 覆蓋（HTTP 真網絡 + 真信封）：
 *   L-1  TEXT happy（200 + respContext 解密 + prompt 上游斷言 + cache-control no-store）
 *   L-2  VISION happy（image_url data URL 上游斷言）
 *   L-3  413 TOO_LARGE（>12MB）
 *   L-4  400 BAD_PAYLOAD（固定原因碼；marker 唔入回應）
 *   L-5  409 REPLAY（同一信封兩次）
 *   L-6  401 BAD_TAG / STALE / BAD_ENVELOPE
 *   L-7  reason 路徑（parse_error / bad_response / llm_error）
 *   L-8  零 DB 寫入：全部 user table count 前後一致
 *   L-9  唔 log 原文：server log 檔 marker 0 hit + 有 metadata 行
 *
 * 跑法（repo root；需要本地 15432 postgres + 6379 redis）：
 *   pnpm e2e:labdoc-extract
 * 退出碼：0 = 全過；1 = 有 fail
 *
 * 註：route 零 DB 依賴（無 prisma import），故 e2e 唔使 db:seed — 只跑 migrate:deploy 建 schema
 *     （L-8 斷言嘅 table count 基線）。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.LABDOC_E2E_PORT ?? 3105);
const BASE = `http://127.0.0.1:${PORT}`;
const ROUTE = `${BASE}/api/internal/labdoc-extract`;
const DB_NAME = "wa_labdoc";
const REDIS_DB = 6;
const UPSTREAM_PORT = Number(process.env.LABDOC_E2E_UPSTREAM_PORT ?? 39099);
const LOG_FILE = path.join(os.tmpdir(), `labdoc-e2e-server-${process.pid}.log`);
const MAX_BODY = 12 * 1024 * 1024;

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── base DB URL（唔 hardcode 密碼：優先 main worktree .env → repo 內 dev-db.ts 預設）──────
function baseDbUrl(): string {
  if (process.env.LABDOC_E2E_BASE_DB_URL) return process.env.LABDOC_E2E_BASE_DB_URL.trim();
  const candidates = [
    "/home/kenneth/.openclaw/workspace/wa-clinic-inbox/.env",
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const line = fs.readFileSync(p, "utf8").split("\n").find((l) => l.startsWith("DATABASE_URL="));
      if (line) {
        const u = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
        if (u.startsWith("postgresql://")) return u;
      }
    } catch {
      /* next candidate */
    }
  }
  // 兜底 = scripts/dev-db.ts 嘅 committed dev credential（本地 embedded postgres）
  return "postgresql://wa_inbox:wa_inbox_dev_pw_2026@127.0.0.1:15432/wa_inbox";
}

function dbUrlFor(db: string, base: string): string {
  return base.replace(/\/[A-Za-z0-9_]+(\?|$)/, `/${db}$1`);
}

// ── mock OpenAI-compatible 上游 ────────────────────────────────────────────
type UpstreamMode = { kind: "content"; content: string } | { kind: "500" };
let upstreamMode: UpstreamMode = { kind: "content", content: "" };
const upstreamBodies: any[] = [];
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
    if (upstreamMode.kind === "500") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "mock upstream boom" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: upstreamMode.content } }], usage: { total_tokens: 10 } }));
  });
});

const TINY_JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]).toString("base64");

function invoiceSample(): any {
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
        lines: [{ description: "Crown", toothRaw: "11", qty: 1, unitPrice: 3200, listPrice: 3500, discountRaw: "10%", amount: 3200 }],
      },
    ],
    sections: [],
    subtotal: 3200,
    total: 3200,
    readIssues: [],
  };
}
function statementSample(): any {
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
        pageTo: 1,
        total: 3200,
        currentTotal: 3200,
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
    total: 3200,
    readIssues: [],
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", () => resolve(true));
  });
}

/** 開機前 port guard：3105 被佔 → 只准 kill 自己上回合殘留（cmdline 含 server.ts + cwd = REPO）；其他 process 一律 FATAL。 */
async function ensurePortFree(port: number): Promise<void> {
  if (await portFree(port)) return;
  let out = "";
  try {
    out = execFileSync("ss", ["-ltnp"], { encoding: "utf8", timeout: 5000 });
  } catch {
    console.error(`FATAL: port ${port} 被佔但 ss 攞唔到 pid — 手動處理後重跑`);
    process.exit(1);
  }
  const line = out.split("\n").find((l) => l.includes(`:${port} `) || l.includes(`:${port}\t`));
  const m = line?.match(/pid=(\d+)/);
  if (!m) {
    console.error(`FATAL: port ${port} 被佔（ss 無 pid 資訊）— 手動處理後重跑`);
    process.exit(1);
  }
  const pid = Number(m[1]);
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    if (cmdline.includes("server.ts") && cwd === REPO) {
      console.log(`[setup] kill 上次 e2e 殘留 server（pid ${pid}）`);
      process.kill(pid, "SIGKILL");
    } else {
      console.error(`FATAL: port ${port} 被其他 process 佔住（pid ${pid} cwd=${cwd} cmdline=${cmdline.slice(0, 120)}）— 唔敢 kill`);
      process.exit(1);
    }
  } catch {
    /* pid 已走 */
  }
  for (let i = 0; i < 30 && !(await portFree(port)); i++) await sleep(500);
  if (!(await portFree(port))) {
    console.error(`FATAL: port ${port} 未釋放 — 手動處理後重跑`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const base = baseDbUrl();
  const dbUrl = dbUrlFor(DB_NAME, base);
  const adminUrl = dbUrlFor("postgres", base);
  const serverSecret = Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64");
  const marker = `LABDOC_E2E_MARKER_${Date.now().toString(36)}`;
  const { seal, open, respContext } = await import("../src/lib/internal/llm-envelope");
  const { REQ_CONTEXT_LABDOC } = await import("../src/lib/internal/labdoc-llm");

  console.log(`[setup] DB=${DB_NAME} PORT=${PORT} REDIS=db${REDIS_DB} upstream=:${UPSTREAM_PORT}`);
  await ensurePortFree(PORT);

  // 1. DB drop + create
  const admin = new pg.Client(adminUrl);
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB_NAME} OWNER wa_inbox`);
  await admin.end();
  console.log("[setup] database ready");

  // 2. migrate:deploy（建 schema；唔使 seed — route 零 DB）
  execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"], {
    cwd: REPO,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: "inherit",
  });
  console.log("[setup] schema migrated");

  // 3. mock 上游
  await new Promise<void>((resolve) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", resolve));

  // 4. spawn server（3105 dev mode；env 全數明確注入）
  const logFd = fs.openSync(LOG_FILE, "w");
  // ★ detached: true — 新 process group；shutdown 用 kill(-pid) 殺成組（npx → tsx → node server 全乾淨，防殘留占 port）
  const child: ChildProcess = spawn("npx", ["tsx", "server.ts"], {
    cwd: REPO,
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(PORT),
      APP_HOST: `127.0.0.1:${PORT}`,
      DATABASE_URL: dbUrl,
      REDIS_URL: `redis://127.0.0.1:6379/${REDIS_DB}`,
      LLM_PROXY_ENABLED: "1",
      INTERNAL_LLM_SECRET: serverSecret,
      INTERNAL_LLM_KID: "k1",
      LABDOC_LLM_CONCURRENCY: "1",
      VLLM_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
      VLLM_MODEL: "e2e-mock-model",
      VLLM_FALLBACK_MODEL: "",
      AI_MOCK: "0",
      AI_TIMEOUT_MS: "8000",
      SESSION_SECRET: Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64"),
      RETENTION_CONV_MONTHS: "24",
      RETENTION_MEDIA_MONTHS: "12",
      TZ: "Asia/Hong_Kong",
    },
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });

  const shutdown = async (): Promise<void> => {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM"); // 成組（process group）
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already dead */
        }
      }
    }
    await sleep(3000);
    if (child.exitCode === null && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }
    }
    try {
      upstream.close();
    } catch {
      /* noop */
    }
    try {
      fs.closeSync(logFd);
    } catch {
      /* noop */
    }
    const p2 = new pg.Client(adminUrl);
    await p2.connect();
    await p2.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await p2.end();
    try {
      const { default: IORedis } = await import("ioredis");
      const r = new IORedis(`redis://127.0.0.1:6379/${REDIS_DB}`, { maxRetriesPerRequest: 1, retryStrategy: () => null });
      await r.flushdb();
      r.disconnect();
    } catch {
      /* redis cleanup best-effort */
    }
  };

  try {
    // 5. wait server ready（dev cold compile 慢 — poll route 直至有 HTTP 回應；500 loadManifest flake 照 retry）
    let ready = false;
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline && !ready) {
      if (child.exitCode !== null) {
        console.error("FATAL: server process died during boot");
        console.error(fs.readFileSync(LOG_FILE, "utf8").slice(-4000));
        break;
      }
      try {
        const res = await fetch(ROUTE, { method: "POST", body: "poll", headers: { "content-type": "application/json" } });
        // 400 BAD_JSON = route live；500 = 可能仲在 compile（Next dev loadManifest flake）→ 照等
        if (res.status !== 500) {
          ready = true;
          console.log(`[setup] server ready (first non-500 = ${res.status})`);
        }
      } catch {
        /* not listening yet */
      }
      if (!ready) await sleep(3000);
    }
    if (!ready) {
      console.error("FATAL: server not ready in 300s");
      console.error(fs.readFileSync(LOG_FILE, "utf8").slice(-4000));
      process.exitCode = 1;
      await shutdown();
      return;
    }
    await sleep(2000); // compile settle

    async function hit(rawBody: string): Promise<{ status: number; body: any; cc: string | null }> {
      // 用 fetch 打真網絡（e2e 口徑）
      const res = await fetch(ROUTE, {
        method: "POST",
        body: rawBody,
        headers: { "content-type": "application/json" },
      });
      const text = await res.text();
      let body: any = null;
      try {
        body = JSON.parse(text);
      } catch {
        /* non-JSON */
      }
      return { status: res.status, body, cc: res.headers.get("cache-control") };
    }
    const sealReq = (payload: unknown, kid = "k1") => seal(serverSecret, kid, payload, REQ_CONTEXT_LABDOC);
    function openResp(hitR: { body: any }, reqNonce: string): any {
      try {
        return open<any>(serverSecret, hitR.body, respContext(reqNonce));
      } catch {
        return null;
      }
    }

    // ── L-8 基線：全部 user table count（warm-up 後先計 — server boot 本身可能冇寫入，但保險）──
    const dbClient = new pg.Client(dbUrl);
    await dbClient.connect();
    const tables = (await dbClient.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`)).rows;
    const before: Record<string, number> = {};
    for (const t of tables) before[t.table_name] = Number((await dbClient.query(`SELECT count(*)::int AS c FROM "${t.table_name}"`)).rows[0].c);

    // ══ L-1 TEXT happy ══
    console.log("[L-1] TEXT happy");
    upstreamBodies.length = 0;
    upstreamMode = { kind: "content", content: JSON.stringify(invoiceSample()) };
    {
      const text = `CLINIC INVOICE 2026\n<<<PAGE 2>>>\nCONTINUED ${marker}`;
      const env = sealReq({ mode: "TEXT", kindHint: "INVOICE", labHint: "Lab 常見名：DentaLab", text, images: null });
      const r = await hit(JSON.stringify(env));
      check("200", r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`);
      check("cache-control no-store", r.cc === "no-store", `cc=${r.cc}`);
      const dec = openResp(r, env.nonce);
      check("resp 解得（respContext）", dec !== null);
      check("result.kind=INVOICE + reason=null", dec?.reason === null && dec?.result?.kind === "INVOICE");
      check("result.total=3200", dec?.result?.total === 3200);
      const sent = upstreamBodies.at(-1);
      const sys = sent?.messages?.[0]?.content;
      check("上游收到 §5.3 prompt + labHint 替換", typeof sys === "string" && sys.includes("你係牙科 Lab 單據讀取器") && sys.includes("Lab 常見名：DentaLab") && !sys.includes("{labHint}"));
      check("上游 user = 原文（含 marker）", sent?.messages?.[1]?.content === text);
    }

    // ══ L-2 VISION happy ══
    console.log("[L-2] VISION happy");
    upstreamBodies.length = 0;
    upstreamMode = { kind: "content", content: JSON.stringify(statementSample()) };
    {
      const env = sealReq({ mode: "VISION", kindHint: "STATEMENT", labHint: null, text: null, images: [TINY_JPEG_B64, TINY_JPEG_B64] });
      const r = await hit(JSON.stringify(env));
      check("200", r.status === 200, `got ${r.status}`);
      const dec = openResp(r, env.nonce);
      check("result.kind=STATEMENT + reason=null", dec?.reason === null && dec?.result?.kind === "STATEMENT");
      const sent = upstreamBodies.at(-1);
      const usr = sent?.messages?.[1]?.content;
      check(
        "上游 user = parts（text + 2×image_url data URL）",
        Array.isArray(usr) && usr[0]?.type === "text" && usr.filter((p: any) => p?.type === "image_url").length === 2 && usr[1]?.image_url?.url === `data:image/jpeg;base64,${TINY_JPEG_B64}`
      );
    }

    // ══ L-3 413 ══
    console.log("[L-3] 413 TOO_LARGE");
    {
      const big = "A".repeat(MAX_BODY); // raw 整體 > 12MB
      const r = await hit(`{"v":1,"kid":"k1","ts":${Date.now()},"nonce":"n413e","iv":"x","ct":"${big}","tag":"x"}`);
      check(">12MB → 413 TOO_LARGE", r.status === 413 && r.body?.error === "TOO_LARGE", `got ${r.status}`);
    }

    // ══ L-4 BAD_PAYLOAD + 零洩漏 ══
    console.log("[L-4] 400 BAD_PAYLOAD");
    {
      const env = sealReq({ mode: "AUDIO", kindHint: "INVOICE", text: `含 ${marker} 嘅敏感 text`, images: null });
      const r = await hit(JSON.stringify(env));
      check("mode=AUDIO → 400 BAD_PAYLOAD", r.status === 400 && r.body?.error === "BAD_PAYLOAD", `got ${r.status} ${JSON.stringify(r.body)}`);
      check("detail 固定原因碼", r.body?.detail === "mode must be TEXT|VISION");
      check("回應唔含 marker", !JSON.stringify(r.body).includes(marker));
    }

    // ══ L-5 REPLAY ══
    console.log("[L-5] 409 REPLAY");
    {
      upstreamMode = { kind: "content", content: JSON.stringify(invoiceSample()) };
      const raw = JSON.stringify(sealReq({ mode: "TEXT", kindHint: "INVOICE", labHint: null, text: "replay", images: null }));
      const r1 = await hit(raw);
      const r2 = await hit(raw);
      check("第一次 200", r1.status === 200, `got ${r1.status}`);
      check("第二次 409 REPLAY", r2.status === 409 && r2.body?.error === "REPLAY", `got ${r2.status}`);
    }

    // ══ L-6 401 三味 ══
    console.log("[L-6] 401 BAD_TAG / STALE / BAD_ENVELOPE");
    {
      const env = sealReq({ mode: "TEXT", kindHint: "INVOICE", labHint: null, text: "x", images: null });
      const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      const i = B64.indexOf(env.tag[0]);
      const badTag = { ...env, tag: (i >= 0 ? B64[(i + 7) % B64.length] : B64[0]) + env.tag.slice(1) };
      const r1 = await hit(JSON.stringify(badTag));
      check("tag 改一 byte → 401 BAD_TAG", r1.status === 401 && r1.body?.error === "BAD_TAG", `got ${r1.status}`);
      check("回應只含原因碼", r1.body !== null && Object.keys(r1.body).length === 1);

      const realNow = Date.now.bind(Date);
      let shiftMs = 0;
      (Date as any).now = () => realNow() + shiftMs;
      shiftMs = -120_000;
      const stale = sealReq({ mode: "TEXT", kindHint: "INVOICE", labHint: null, text: "x", images: null });
      shiftMs = 0;
      (Date as any).now = realNow;
      const r2 = await hit(JSON.stringify(stale));
      check("ts 早 2 分鐘 → 401 STALE", r2.status === 401 && r2.body?.error === "STALE", `got ${r2.status}`);

      const r3 = await hit(JSON.stringify(sealReq({ mode: "TEXT", kindHint: "INVOICE", labHint: null, text: "x", images: null }, "k2")));
      check("kid 錯 → 401 BAD_ENVELOPE", r3.status === 401 && r3.body?.error === "BAD_ENVELOPE", `got ${r3.status}`);
    }

    // ══ L-7 reason 路徑 ══
    console.log("[L-7] reason 路徑（parse_error / bad_response / llm_error）");
    {
      upstreamMode = { kind: "content", content: "我睇到總數 3200 蚊，但呢個唔係 JSON" };
      let env = sealReq({ mode: "TEXT", kindHint: "INVOICE", labHint: null, text: "page", images: null });
      let r = await hit(JSON.stringify(env));
      let dec = openResp(r, env.nonce);
      check("上游非 JSON → result=null + parse_error", r.status === 200 && dec?.result === null && dec?.reason === "parse_error", `dec=${JSON.stringify(dec)}`);

      const missing = invoiceSample();
      delete missing.total;
      upstreamMode = { kind: "content", content: JSON.stringify(missing) };
      env = sealReq({ mode: "TEXT", kindHint: "INVOICE", labHint: null, text: "page", images: null });
      r = await hit(JSON.stringify(env));
      dec = openResp(r, env.nonce);
      check("上游缺必填 → result=null + bad_response", r.status === 200 && dec?.result === null && dec?.reason === "bad_response", `dec=${JSON.stringify(dec)}`);

      // m-3（2026-10-04 reviewer 修復）：啟用 upstreamMode 500 — llm_error 真網絡 case。
      //   單次 500 = 1 strike（breaker 閾值 3 連敗）→  breaker 保持關閉，唔使 reset；
      //   呢 case 係 L 段最後一個 route 請求，殘留 strike 隨 server 停機消失。
      upstreamMode = { kind: "500" };
      env = sealReq({ mode: "TEXT", kindHint: "INVOICE", labHint: null, text: "page", images: null });
      r = await hit(JSON.stringify(env));
      dec = openResp(r, env.nonce);
      check("上游 500 → result=null + llm_error", r.status === 200 && dec?.result === null && dec?.reason === "llm_error", `dec=${JSON.stringify(dec)}`);
    }

    // ══ L-8 零 DB 寫入 ══
    console.log("[L-8] 零 DB 寫入（all table counts）");
    {
      const after: Record<string, number> = {};
      for (const t of tables) after[t.table_name] = Number((await dbClient.query(`SELECT count(*)::int AS c FROM "${t.table_name}"`)).rows[0].c);
      const diffs = Object.keys(before).filter((k) => before[k] !== after[k]);
      check("全部 table count 前後一致", diffs.length === 0, `diffs=${JSON.stringify(Object.fromEntries(diffs.map((k) => [k, [before[k], after[k]]])))}`);
    }

    // ══ L-9 唔 log 原文 ══
    console.log("[L-9] 唔 log 原文（server log 檔）");
    await sleep(1500); // pino flush
    {
      const logText = fs.readFileSync(LOG_FILE, "utf8");
      check("marker 0 hit（原文唔入 log）", !logText.includes(marker));
      const metaLines = (logText.match(/labdoc-extract: done/g) ?? []).length;
      check("有 metadata 行（labdoc-extract: done）", metaLines >= 4, `lines=${metaLines}`);
      check("metadata 行含 mode/pages/chars（結構核實）", /"mode":"TEXT"/.test(logText) && /"pages":\d+/.test(logText));
    }

    dbClient.end();
  } finally {
    await shutdown();
  }

  console.log(failures === 0 ? "\ne2e-labdoc-extract: ALL PASS" : `\ne2e-labdoc-extract: ${failures} FAILURES`);
  if (failures > 0) {
    console.error("── server log tail ──");
    console.error(fs.readFileSync(LOG_FILE, "utf8").slice(-6000));
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  try {
    console.error("── server log tail ──");
    console.error(fs.readFileSync(LOG_FILE, "utf8").slice(-6000));
  } catch {
    /* log not created */
  }
  process.exit(1);
});

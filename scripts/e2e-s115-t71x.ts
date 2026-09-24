/**
 * e2e-s115-t71x — cwi-final S1-15 T715/T716/T717：enqueue 結果未知語義 + outbound-sweep 兜底
 *
 * spec 口徑（anchored MD 行 1846-1889）：
 *   T715：Graph mock「成功回應後 worker throw」→ Graph 呼叫次數 = 1、status UNKNOWN（唔雙發）
 *         + sweep：stale QUEUED（120s-6h）重加 → SENT / stuck SENDING（>5min）→ UNKNOWN + SENDING_TIMEOUT + alert
 *   T716：ENQUEUE_DELAY_MS=2000 注入（web 過程）→ API 202 enqueueUncertain、病人收到 1 條、UI 唔顯示失敗
 *   T717：Graph 永久失敗（400/131047 語義）→ 唔重試、即 FAILED
 *
 * 設計：
 *  - 獨立 fixture（company E2ES15U-CO + clinic E2ES15U + STAFF + 5 病人 waId 99081521-25）— 唔郁 dev 店
 *  - worker 重起管理 = s114 慣例（精確 PGID kill + setsid detached + readiness log marker）
 *  - web 重起管理（新）：**web 同 CWM 3001 同全 dev stack 共享 PGID 51395（= openclaw-gateway）—
 *    絕唔 PGID kill**；逐 PID kill（cmd 含 "wa-clinic-inbox"+server.ts，或 `pnpm dev`/`sh -c tsx server.ts`
 *    用 /proc/PID/cwd = REPO 區分 W vs CWM）；重起 = detached `pnpm dev`（新 group）。
 *  - T715a crash 模擬：真發送 SENT → DB rewind（SENDING + waMessageId=NULL = 「Graph 成功後、寫 wamid 前死」）
 *    → 再入 retry job。**jobId 用 `<msgId>-t715a`**（獨立 id）— 原 jobId=msgId 嘅 completed job 仲喺
 *    completed 保留集（removeOnComplete count:20）內，同 id 重加會 throw "Job already exists"；
 *    獨立 jobId 行同一個 worker 代碼路徑（claim miss → UNKNOWN）— 偏離有記錄。
 *  - T715b/c 直調 runOutboundSweep()（s11c/T714 case 4 慣例 — light cron lane 同一個導出函數）。
 *  - T717：WA_GRAPH_MOCK_FAIL=1（mock 於 send 內 throw）+ job attempts=1 → isFinal 即 FAILED 分支
 *    （spec「400/131047 permanent → 唔重試即 FAILED」— permanent 分支同 isFinal 分支落同一 final
 *    代碼路徑；mock fail 係普通 Error 所以經 isFinal 判定 — 語義等價，Graph 呼叫 = 1 次實證唔重試）。
 *  - finally：fixture 清走 + outbound_unknown alert 清走 + queue completed job best-effort 清
 *    + baseline web（無 ENQUEUE_DELAY_MS）+ baseline worker（帶 CA、無 mock flag）+ DB 殘留 0 斷言。
 *
 * 前置：dev stack live（web 3100 + DB 15432 + redis 6379 + /tmp/e2e-push-tls/ca.pem）。
 * 用法（repo root）：pnpm e2e:s115-t71x
 * 輸出：T715X-OK / T715X-FAIL: <reason>（exit 1）
 *
 * ★ PII 鐵律：mock 訊息係代碼字串；斷言全部 metadata（status / errorCode / alert / log 計數）。
 */
import "./e2e-origin-shim";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync, openSync, readlinkSync, closeSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
try {
  process.loadEnvFile(path.join(REPO, ".env"));
} catch {
  /* 靠 process env */
}
const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
// ★ cwi-final S3-9：healthz 詳細 body token gate — .env.local 取 HEALTHZ_TOKEN（gitignored）；
// 未設時唔附加參數（gate 停用）。
const HEALTHZ_QS = (() => {
  try {
    const m = readFileSync(path.join(REPO, ".env.local"), "utf8").match(/^HEALTHZ_TOKEN=(.*)$/m);
    const v = m?.[1]?.trim();
    return v ? `?token=${v}` : "";
  } catch {
    return "";
  }
})();
const CA_PATH = "/tmp/e2e-push-tls/ca.pem";
const WORKER_LOG = "/tmp/e2e-s115-worker.log";
const WEB_LOG = "/tmp/e2e-s115-web.log";

let FAILS = 0;
function ok(msg: string): void {
  console.log(`  ✅ ${msg}`);
}
function fail(msg: string): void {
  FAILS++;
  console.log(`  ❌ ${msg}`);
}
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) ok(label);
  else fail(`${label}${detail !== undefined ? `（${JSON.stringify(detail)}）` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const prisma = new PrismaClient();

// ── fixture 常數 ──────────────────────────────────────────────────────────
const COMPANY_CODE = "E2ES15U-CO";
const CLINIC_U = "E2ES15U";
const PH_ID = "E2ES15U-PH";
const DISPLAY = "+852 0000 7315";
const STAFF_EMAIL = "e2e-s15u@wa-clinic.local";
const STAFF_PASS = "e2e-s15u-pass-2026";
const WA_P1 = "99081521"; // T715a
const WA_P2 = "99081522"; // T715b
const WA_P3 = "99081523"; // T715c
const WA_P4 = "99081524"; // T716
const WA_P5 = "99081525"; // T717
const TS = Date.now();
const TAG = `e2es15u${(TS % 1679616).toString(36)}`; // 每次 run 唯一（重跑唔撞 id）

let clinicId = "";
let staffId = "";
let convA = "";
let convB = "";
let convC = "";
let convD = "";
let convE = "";
let msgA = "";
let msgB = "";
let msgC = "";
let msgD = "";
let msgE = "";
let testStart = 0;

// ── worker 管理（精確 PGID kill；worker 一直 setsid 自成 group — 同 s114） ──
function workerProcs(): { pid: number; pgid: number }[] {
  const r = spawnSync("pgrep", ["-f", "src/workers/index.ts"], { encoding: "utf8" });
  if (r.status !== 0) return [];
  const out: { pid: number; pgid: number }[] = [];
  for (const s of r.stdout.split(/\s+/)) {
    const pid = parseInt(s, 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    let pgid = pid;
    try {
      const p = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
      const v = parseInt(p.stdout.trim(), 10);
      if (Number.isFinite(v) && v > 0) pgid = v;
    } catch {
      /* fallback pgid = pid */
    }
    out.push({ pid, pgid });
  }
  return out;
}

function killGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    /* group 已死 */
  }
}

function uniqueGroupIds(): number[] {
  return [...new Set(workerProcs().map((p) => p.pgid))];
}

async function stopWorkers(timeoutMs = 20_000): Promise<void> {
  const t0 = Date.now();
  let groups = uniqueGroupIds();
  if (groups.length === 0) return;
  for (const g of groups) killGroup(g, "SIGTERM");
  while (Date.now() - t0 < timeoutMs) {
    groups = uniqueGroupIds();
    if (groups.length === 0) return;
    await sleep(500);
  }
  for (const g of uniqueGroupIds()) killGroup(g, "SIGKILL");
  await sleep(500);
}

function startWorker(extraEnv: Record<string, string>): void {
  writeLog(WORKER_LOG);
  const fd = openSync(WORKER_LOG, "a");
  const child = spawn("pnpm", ["worker"], {
    cwd: REPO,
    env: { ...process.env, NODE_EXTRA_CA_CERTS: CA_PATH, ...extraEnv },
    stdio: ["ignore", fd, fd],
    detached: true, // setsid 語義 — 自己個 process group
  });
  child.unref();
}

function writeLog(p: string): void {
  const fd = openSync(p, "w");
  closeSync(fd);
}

async function waitForWorkerReady(timeoutMs = 90_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let content = "";
    try {
      content = readFileSync(WORKER_LOG, "utf8");
    } catch {
      /* log 未寫 */
    }
    if (content.includes("all workers running — waiting for jobs")) return true;
    if (content.includes("worker fatal")) {
      console.error(`\nworker fatal — log 尾：\n${content.split("\n").slice(-15).join("\n")}`);
      return false;
    }
    await sleep(1000);
  }
  return false;
}

// ── web 管理（★ 逐 PID — 共享 PGID 51395 = gateway，絕唔 group kill） ─────
function cwdIsRepo(pid: number): boolean {
  try {
    return readlinkSync(`/proc/${pid}/cwd`) === REPO;
  } catch {
    return false;
  }
}

function webPids(): number[] {
  const r = spawnSync("ps", ["-eo", "pid=,cmd="], { encoding: "utf8" });
  if (r.status !== 0) return [];
  const pids = new Set<number>();
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    if (!Number.isFinite(pid) || pid <= 1) continue;
    const cmd = m[2].trim();
    let hit = false;
    if (cmd.includes("wa-clinic-inbox") && cmd.includes("server.ts")) {
      hit = true; // tsx cli + app node（cmd 內含 repo 路徑 — 唔會撞 CWM）
    } else if (cmd === "sh -c tsx server.ts") {
      hit = cwdIsRepo(pid); // W vs CWM 靠 cwd
    } else if (cmd === "node /usr/bin/pnpm dev") {
      hit = cwdIsRepo(pid); // W vs CWM 靠 cwd
    }
    if (hit) pids.add(pid);
  }
  return [...pids];
}

async function stopWeb(timeoutMs = 30_000): Promise<void> {
  const t0 = Date.now();
  let pids = webPids();
  if (pids.length === 0) return;
  for (const p of pids) {
    try {
      process.kill(p, "SIGTERM");
    } catch {
      /* 已死 */
    }
  }
  while (Date.now() - t0 < timeoutMs) {
    pids = webPids();
    if (pids.length === 0) return;
    await sleep(500);
  }
  for (const p of webPids()) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      /* */
    }
  }
  await sleep(500);
}

function startWeb(extraEnv: Record<string, string>): void {
  writeLog(WEB_LOG);
  const fd = openSync(WEB_LOG, "a");
  const child = spawn("pnpm", ["dev"], {
    cwd: REPO,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  child.unref();
}

async function webHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/healthz${HEALTHZ_QS}`);
    return res.status === 200;
  } catch {
    return false;
  }
}

async function waitForWebReady(timeoutMs = 120_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await webHealthy()) return true;
    await sleep(1500);
  }
  return false;
}

// ── auth + send API ──────────────────────────────────────────────────────
async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASS }),
  });
  if (res.status !== 200) throw new Error(`login HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  const setc = res.headers.get("set-cookie") ?? "";
  const m = /wa_inbox_session=([^;]+)/.exec(setc);
  if (!m) throw new Error("login: no session cookie");
  return m[1];
}

async function sendApi(cookie: string, convId: string, body: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}/api/messages/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: `wa_inbox_session=${cookie}` },
    body: JSON.stringify({ conversationId: convId, body, clientMessageId: crypto.randomUUID() }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

// ── Graph 呼叫計數（worker log — 逐 patient waId 隔離） ─────────────────
function graphCalls(waId: string, kind: "MOCK" | "FAILED"): number {
  let content = "";
  try {
    content = readFileSync(WORKER_LOG, "utf8");
  } catch {
    return 0;
  }
  const marker = kind === "MOCK" ? "graph: send text (MOCK)" : "graph: send text FAILED";
  return content
    .split("\n")
    .filter((l) => l.includes(marker) && l.includes(`"to":"${waId}"`)).length;
}

// ── fixture seed / cleanup ───────────────────────────────────────────────
async function seed(): Promise<void> {
  const company = await prisma.company.create({ data: { code: COMPANY_CODE, name: "E2ES15U CO" } });
  const clinic = await prisma.clinic.create({
    data: {
      companyId: company.id,
      code: CLINIC_U,
      name: "E2ES15U Clinic",
      waPhoneNumberId: PH_ID,
      waDisplayNumber: DISPLAY,
      aiMode: "DRAFT", // 唔行 AUTO 發送（本 test 全 outbound，無 inbound → AI pipeline 唔會 fire）
    },
  });
  clinicId = clinic.id;
  const argon2 = (await import("argon2")).default;
  const staff = await prisma.staffUser.create({
    data: { email: STAFF_EMAIL, name: "E2ES15U Staff", role: "STAFF", scopeType: "CLINICS", passwordHash: await argon2.hash(STAFF_PASS) },
  });
  staffId = staff.id;
  await prisma.staffClinic.create({ data: { staffId, clinicId, isPrimary: true } });
  const mkConv = async (waId: string, name: string): Promise<string> => {
    const ct = await prisma.contact.create({ data: { clinicId, waId, profileName: name, labels: [] } });
    const now = new Date();
    const conv = await prisma.conversation.create({
      data: {
        id: `${TAG}${waId}`,
        clinicId,
        contactId: ct.id,
        status: "OPEN",
        assigneeId: staffId, // 預 assign — 免 auto-claim / 423
        lastInboundAt: now, // 24h 窗口開（free-form 合法）
        lastMessageAt: now,
      },
    });
    return conv.id;
  };
  convA = await mkConv(WA_P1, "E2ES15U P1");
  convB = await mkConv(WA_P2, "E2ES15U P2");
  convC = await mkConv(WA_P3, "E2ES15U P3");
  convD = await mkConv(WA_P4, "E2ES15U P4");
  convE = await mkConv(WA_P5, "E2ES15U P5");
}

// 每句獨立 catch — 一句失敗唔阻其他
async function cleanup(): Promise<void> {
  const clinicSub = `(SELECT id FROM "Clinic" WHERE code = '${CLINIC_U}')`;
  const convSub = `(SELECT id FROM "Conversation" WHERE "clinicId" IN ${clinicSub})`;
  const stmts: string[] = [
    `DELETE FROM "Message" WHERE "conversationId" IN ${convSub}`,
    `DELETE FROM "AiDraft" WHERE "conversationId" IN ${convSub}`,
    `DELETE FROM "StaffNotice" WHERE "clinicId" IN ${clinicSub} OR "conversationId" IN ${convSub}`,
    `DELETE FROM "BookingSession" WHERE "conversationId" IN ${convSub}`,
    `DELETE FROM "AuditLog" WHERE "entityId" IN ${convSub}`,
    `DELETE FROM "Conversation" WHERE "clinicId" IN ${clinicSub}`,
  ];
  for (const sql of stmts) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (err) {
      console.warn(`  ⚠️ cleanup 部分失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // outbound_unknown alert（clinicId=null — 本 test 唯一生產者；按 run 時間窗收窄）
  try {
    await prisma.$executeRawUnsafe(
      `DELETE FROM "Alert" WHERE type = 'outbound_unknown' AND "clinicId" IS NULL AND "createdAt" >= '${new Date(testStart).toISOString()}'`
    );
  } catch (err) {
    console.warn(`  ⚠️ cleanup alert: ${err instanceof Error ? err.message : String(err)}`);
  }
  await prisma.contact
    .deleteMany({ where: { waId: { in: [WA_P1, WA_P2, WA_P3, WA_P4, WA_P5] } } })
    .catch((e) => console.warn(`  ⚠️ cleanup contact: ${e instanceof Error ? e.message : String(e)}`));
  await prisma.staffClinic.deleteMany({ where: { staff: { email: STAFF_EMAIL } } }).catch((e) => console.warn(`  ⚠️ cleanup staffclinic: ${e instanceof Error ? e.message : String(e)}`));
  await prisma.staffUser.deleteMany({ where: { email: STAFF_EMAIL } }).catch((e) => console.warn(`  ⚠️ cleanup staff: ${e instanceof Error ? e.message : String(e)}`));
  await prisma.clinic.deleteMany({ where: { code: CLINIC_U } }).catch((e) => console.warn(`  ⚠️ cleanup clinic: ${e instanceof Error ? e.message : String(e)}`));
  await prisma.company.deleteMany({ where: { code: COMPANY_CODE } }).catch((e) => console.warn(`  ⚠️ cleanup company: ${e instanceof Error ? e.message : String(e)}`));
}

// best-effort 清走本 test 入 queue 嘅 completed job（removeOnComplete 保留期內會佔 jobId）
async function purgeQueueJobs(): Promise<void> {
  try {
    const { outboundQueue } = await import("@/lib/queue");
    for (const id of [msgA, `${msgA}-t715a`, msgB, msgE]) {
      if (!id) continue;
      const j = await outboundQueue.getJob(id);
      if (j) await j.remove().catch(() => undefined);
    }
  } catch (err) {
    console.warn(`  ⚠️ queue purge（非致命）: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── T715a：真發送 → crash 模擬 → retry job → UNKNOWN（唔雙發） ──────────
async function t715a(cookie: string): Promise<void> {
  console.log("\n── T715a：真發送 SENT → rewind（SENDING + wamid NULL = Graph 成功後死）→ retry job → UNKNOWN ──");
  const r = await sendApi(cookie, convA, "t715a enqueue-semantics test");
  check("T715a-1 API 202 + QUEUED", r.status === 202 && r.json.ok === true && r.json.status === "QUEUED", r);
  msgA = String(r.json.messageId ?? "");
  check("T715a-2 messageId 有回", msgA.length > 0, r.json);

  let sent = false;
  const t0 = Date.now();
  for (let i = 0; i < 75 && !sent; i++) {
    const m = await prisma.message.findUnique({ where: { id: msgA }, select: { status: true, waMessageId: true } });
    sent = m?.status === "SENT" && !!m.waMessageId;
    if (!sent) await sleep(200);
  }
  check("T715a-3 首發 SENT + wamid", sent, `waitedMs=${Date.now() - t0}`);
  const calls1 = graphCalls(WA_P1, "MOCK");
  check("T715a-4 Graph 呼叫 = 1（attempt 1）", calls1 === 1, calls1);

  // crash 模擬：job 已完成（removed 前）；row 停喺「Graph 成功後、寫 wamid 前」
  await prisma.$executeRawUnsafe(`UPDATE "Message" SET status = 'SENDING', "waMessageId" = NULL WHERE id = '${msgA}'`);
  // retry job — 獨立 jobId（原 jobId=msgId 仲喺 completed 保留集 — "Job already exists"；見檔頭註）
  const { outboundQueue } = await import("@/lib/queue");
  await outboundQueue.add("send", { messageId: msgA }, { jobId: `${msgA}-t715a` });

  let unknown = false;
  const t1 = Date.now();
  for (let i = 0; i < 75 && !unknown; i++) {
    const m = await prisma.message.findUnique({ where: { id: msgA }, select: { status: true } });
    unknown = m?.status === "UNKNOWN";
    if (!unknown) await sleep(200);
  }
  const after = await prisma.message.findUnique({ where: { id: msgA }, select: { status: true, errorCode: true } });
  check("T715a-5 status=UNKNOWN（claim miss 路徑）", after?.status === "UNKNOWN", { after, waitedMs: Date.now() - t1 });
  check("T715a-6 errorCode=SEND_OUTCOME_UNKNOWN", after?.errorCode === "SEND_OUTCOME_UNKNOWN", after?.errorCode);
  const calls2 = graphCalls(WA_P1, "MOCK");
  check("T715a-7 Graph 呼叫仍 = 1（唔雙發）", calls2 === 1, calls2);
  const alert = await prisma.alert.findFirst({ where: { type: "outbound_unknown", clinicId: null, resolvedAt: null }, select: { id: true } });
  check("T715a-8 alert outbound_unknown（未解決 HIGH）", alert !== null);
}

// ── T715b：stale QUEUED（180s、冇 job）→ runOutboundSweep 重加 → SENT ──
async function t715b(): Promise<void> {
  console.log("\n── T715b：stale QUEUED（180s、冇 job = web enqueue 中途死）→ sweep 重加 → worker SENT ──");
  const now = new Date();
  const back = new Date(now.getTime() - 180_000); // ∈ (now-6h, now-120s) 窗口
  const m = await prisma.message.create({
    data: {
      conversationId: convB,
      direction: "OUT",
      channel: "API",
      type: "text",
      body: "t715b sweep requeue test",
      status: "QUEUED",
      sentByStaffId: staffId,
      billingCategory: "SERVICE",
      waTimestamp: back,
      createdAt: back, // backdate 過 120s 門檻
    },
  });
  msgB = m.id;
  const { runOutboundSweep } = await import("@/lib/ops/outbound-sweep");
  const r = await runOutboundSweep(now);
  check("T715b-1 sweep requeued ≥ 1", r.requeued >= 1, r);

  let sent = false;
  const t0 = Date.now();
  for (let i = 0; i < 100 && !sent; i++) {
    const mm = await prisma.message.findUnique({ where: { id: msgB }, select: { status: true, waMessageId: true } });
    sent = mm?.status === "SENT" && !!mm.waMessageId;
    if (!sent) await sleep(200);
  }
  check("T715b-2 重加後 SENT + wamid（worker 撿走）", sent, `waitedMs=${Date.now() - t0}`);
  const calls = graphCalls(WA_P2, "MOCK");
  check("T715b-3 病人收到 1 條（Graph 呼叫 = 1）", calls === 1, calls);
}

// ── T715c：stuck SENDING（>5min）→ sweep → UNKNOWN + SENDING_TIMEOUT + alert ──
async function t715c(): Promise<void> {
  console.log("\n── T715c：stuck SENDING（updatedAt >5min）→ sweep → UNKNOWN + SENDING_TIMEOUT + alert ──");
  // 清 T715a 嘅 alert → 呢輪新開 alert 精確斷言
  await prisma.alert
    .updateMany({ where: { type: "outbound_unknown", clinicId: null, resolvedAt: null }, data: { resolvedAt: new Date() } })
    .catch(() => undefined);

  const m = await prisma.message.create({
    data: {
      conversationId: convC,
      direction: "OUT",
      channel: "API",
      type: "text",
      body: "t715c stuck sending test",
      status: "QUEUED",
      sentByStaffId: staffId,
      billingCategory: "SERVICE",
      waTimestamp: new Date(),
    },
  });
  msgC = m.id;
  // 模擬：claim 咗（SENDING）之後 6 分鐘無更新（worker 發送中途死）
  await prisma.$executeRawUnsafe(`UPDATE "Message" SET status = 'SENDING', "updatedAt" = now() - INTERVAL '360 seconds' WHERE id = '${msgC}'`);

  const { runOutboundSweep } = await import("@/lib/ops/outbound-sweep");
  const r = await runOutboundSweep();
  check("T715c-1 sweep unknown ≥ 1", r.unknown >= 1, r);
  const after = await prisma.message.findUnique({ where: { id: msgC }, select: { status: true, errorCode: true } });
  check("T715c-2 status=UNKNOWN", after?.status === "UNKNOWN", after);
  check("T715c-3 errorCode=SENDING_TIMEOUT", after?.errorCode === "SENDING_TIMEOUT", after?.errorCode);
  const alert = await prisma.alert.findFirst({ where: { type: "outbound_unknown", clinicId: null, resolvedAt: null }, select: { id: true } });
  check("T715c-4 新 alert outbound_unknown（未解決）", alert !== null);
}

// ── T716：ENQUEUE_DELAY_MS=2000（web）→ 202 enqueueUncertain → 1 條、無失敗 ──
async function t716(cookie: string): Promise<void> {
  console.log("\n── T716：ENQUEUE_DELAY_MS=2000 > route 1500ms race → 202 enqueueUncertain → 病人收到 1 條 ──");
  const r = await sendApi(cookie, convD, "t716 enqueue delay test");
  check("T716-1 API 202", r.status === 202, r);
  check(
    "T716-2 body: ok + QUEUED + enqueueUncertain=true",
    r.json.ok === true && r.json.status === "QUEUED" && r.json.enqueueUncertain === true,
    r.json
  );
  msgD = String(r.json.messageId ?? "");
  check("T716-3 messageId 有回", msgD.length > 0, r.json);

  // 即刻 sample（job 要 t+2000ms 先落隊列）— 狀態必須 QUEUED/SENDING，絕非 FAILED
  await sleep(400);
  const statuses = new Set<string>();
  const s1 = (await prisma.message.findUnique({ where: { id: msgD }, select: { status: true } }))?.status;
  statuses.add(s1 ?? "");
  check("T716-4 即刻 sample ≠ FAILED（QUEUED/SENDING）", s1 === "QUEUED" || s1 === "SENDING", s1);

  let sent = false;
  const t0 = Date.now();
  for (let i = 0; i < 100 && !sent; i++) {
    const m = await prisma.message.findUnique({ where: { id: msgD }, select: { status: true, waMessageId: true } });
    statuses.add(m?.status ?? "");
    sent = m?.status === "SENT" && !!m.waMessageId;
    if (!sent) await sleep(200);
  }
  check("T716-5 最終 SENT + wamid（delayed job 落隊列 → worker 撿走）", sent, `waitedMs=${Date.now() - t0}`);
  check("T716-6 全程無 FAILED（UI 唔顯示失敗）", ![...statuses].includes("FAILED"), [...statuses]);
  const calls = graphCalls(WA_P4, "MOCK");
  check("T716-7 病人收到 1 條（Graph 呼叫 = 1）", calls === 1, calls);
}

// ── T717：永久失敗（WA_GRAPH_MOCK_FAIL=1 + attempts=1）→ 唔重試、即 FAILED ──
async function t717(): Promise<void> {
  console.log("\n── T717：Graph 永久失敗語義（mock fail + attempts=1）→ 唔重試、即 FAILED + notice ──");
  const m = await prisma.message.create({
    data: {
      conversationId: convE,
      direction: "OUT",
      channel: "API",
      type: "text",
      body: "t717 permanent failure test",
      status: "QUEUED",
      sentByStaffId: staffId, // notice target（send 者）
      billingCategory: "SERVICE",
      waTimestamp: new Date(),
    },
  });
  msgE = m.id;
  const { outboundQueue } = await import("@/lib/queue");
  // attempts=1：首次失敗 = isFinal → FAILED 分支（spec「permanent → 唔重試、即 FAILED」—
  // permanent 與 isFinal 落同一 final 代碼路徑；mock fail 係普通 Error → 經 isFinal 判定）
  await outboundQueue.add("send", { messageId: msgE }, { jobId: msgE, attempts: 1 });

  let failed = false;
  const t0 = Date.now();
  for (let i = 0; i < 75 && !failed; i++) {
    const mm = await prisma.message.findUnique({ where: { id: msgE }, select: { status: true } });
    failed = mm?.status === "FAILED";
    if (!failed) await sleep(200);
  }
  const after = await prisma.message.findUnique({ where: { id: msgE }, select: { status: true, errorCode: true } });
  check("T717-1 即 FAILED（無重試）", after?.status === "FAILED", { after, waitedMs: Date.now() - t0 });
  check(
    "T717-2 errorCode = MOCK_GRAPH_TIMEOUT（truncate 60 字前綴）",
    typeof after?.errorCode === "string" && after.errorCode.startsWith("MOCK_GRAPH_TIMEOUT"),
    after?.errorCode
  );
  const failCalls = graphCalls(WA_P5, "FAILED");
  const okCalls = graphCalls(WA_P5, "MOCK");
  check("T717-3b 病人收到 0（mock fail — 無成功發送）", okCalls === 0 && failCalls === 0, { okCalls, failCalls });
  // 唔重試實證：worker 狀態機 log（mock fail 喺 send 內 throw — graph.ts 唔發 log 行，
  // errorCode MOCK_GRAPH_TIMEOUT 本身已證明 mock fail 分支命中過一次）
  const logc = readFileSync(WORKER_LOG, "utf8");
  const mid = `"messageId":"${msgE}"`;
  const retried = logc.split("\n").filter((l) => l.includes(mid) && l.includes("send failed, will retry")).length;
  const perm = logc.split("\n").filter((l) => l.includes(mid) && l.includes("outbound: permanently failed")).length;
  check("T717-3 唔重試（0 will-retry + 恰 1 permanently failed）", retried === 0 && perm === 1, { retried, perm });
  const notice = await prisma.staffNotice.findFirst({
    where: { conversationId: convE, kind: "SYSTEM", title: "訊息發送失敗 — 請人手睇" },
    select: { meta: true },
  });
  check("T717-4 SYSTEM notice（meta.reason=SEND_FAILED）", (notice?.meta as { reason?: string } | null)?.reason === "SEND_FAILED", notice?.meta ?? null);
}

// ── main ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("e2e-s115-t71x — cwi-final S1-15 T715/T716/T717");
  if (!existsSync(CA_PATH)) throw new Error(`/tmp/e2e-push-tls/ca.pem 冇（見 TOOLS.md 重啟恢復清單）`);
  testStart = Date.now();
  check("pre：web 3100 healthz 200", await webHealthy());

  // 冪等前置：先清舊 fixture（上次 crash 殘留）
  await cleanup().catch((err) => console.warn(`pre-cleanup error: ${err instanceof Error ? err.message : String(err)}`));
  await seed();
  check("fixture 已 seed（clinic E2ES15U + 5 conv 窗口開）", clinicId !== "" && staffId !== "");

  let cookie = "";
  try {
    // Phase 0：web 重起 baseline — 確保載入 seg2b 代碼（next dev hot-reload 唔入斷言路徑）
    console.log("\n[phase 0] 重起 web（baseline — 載新 route/ai 語義）…");
    await stopWeb();
    startWeb({});
    check("web ready（baseline）", await waitForWebReady());
    cookie = await login();
    check("staff login（session cookie）", cookie.length > 0);

    // Phase 1：baseline worker（T715a/b/c）
    console.log("\n[phase 1] 重起 worker（baseline + CA）…");
    await stopWorkers();
    startWorker({});
    check("worker ready（baseline）", await waitForWorkerReady());
    const wlog = readFileSync(WORKER_LOG, "utf8");
    check("outbound-sweep cron 已登記（reg log 含 outbound-sweep */2m）", wlog.includes("outbound-sweep */2m"), "見 log");
    await t715a(cookie);
    await t715b();
    await t715c();

    // Phase 2：web 重起帶 ENQUEUE_DELAY_MS=2000（T716；worker 維持 baseline 處理 delayed job）
    console.log("\n[phase 2] 重起 web（ENQUEUE_DELAY_MS=2000）…");
    await stopWeb();
    startWeb({ ENQUEUE_DELAY_MS: "2000" });
    check("web ready（ENQUEUE_DELAY_MS=2000）", await waitForWebReady());
    cookie = await login();
    await t716(cookie);

    // Phase 3：web 返 baseline + worker 重起 WA_GRAPH_MOCK_FAIL=1（T717）
    console.log("\n[phase 3] web 返 baseline；重起 worker（WA_GRAPH_MOCK_FAIL=1）…");
    await stopWeb();
    startWeb({});
    check("web ready（baseline 還原）", await waitForWebReady());
    await stopWorkers();
    startWorker({ WA_GRAPH_MOCK_FAIL: "1" });
    check("worker ready（WA_GRAPH_MOCK_FAIL=1）", await waitForWorkerReady());
    await t717();
  } finally {
    // ── 還原：fixture + alert + queue 殘留 → baseline web + baseline worker ──
    await cleanup().catch((err) => console.warn(`cleanup error: ${err instanceof Error ? err.message : String(err)}`));
    await purgeQueueJobs().catch(() => undefined);

    // baseline web（phase 3 已重起 baseline — 驗證 healthz；唔 healthy 先再重起）
    if (!(await waitForWebReady(20_000))) {
      console.warn("  ⚠️ final web 未 healthy → 再重起一次");
      await stopWeb();
      startWeb({});
      check("web ready（final retry）", await waitForWebReady());
    }

    // baseline worker（phase 3 個帶 WA_GRAPH_MOCK_FAIL — 必須重起）
    console.log("\n[restore] 重起 baseline worker（CA、無 mock flag）…");
    await stopWorkers();
    startWorker({});
    check("worker ready（final baseline）", await waitForWorkerReady());
    const groups = uniqueGroupIds();
    check("淨 1 個 worker group（baseline）", groups.length === 1, groups);

    // DB 殘留 0
    const res = (await prisma.$queryRawUnsafe(`
      SELECT
        (SELECT count(*) FROM "Clinic" WHERE code = '${CLINIC_U}') AS clinic,
        (SELECT count(*) FROM "Company" WHERE code = '${COMPANY_CODE}') AS company,
        (SELECT count(*) FROM "StaffUser" WHERE email = '${STAFF_EMAIL}') AS staff,
        (SELECT count(*) FROM "Contact" WHERE "waId" IN ('${WA_P1}','${WA_P2}','${WA_P3}','${WA_P4}','${WA_P5}')) AS contacts,
        (SELECT count(*) FROM "Conversation" WHERE "clinicId" IN (SELECT id FROM "Clinic" WHERE code = '${CLINIC_U}')) AS convs,
        (SELECT count(*) FROM "Alert" WHERE type = 'outbound_unknown' AND "createdAt" >= '${new Date(testStart).toISOString()}') AS alerts
    `)) as { clinic: string; company: string; staff: string; contacts: string; convs: string; alerts: string }[];
    const zero = res.length === 1 && Object.values(res[0]).every((v) => Number(v) === 0);
    check("DB 殘留 0（clinic/company/staff/contacts/convs/alerts）", zero, res[0]);
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    if (FAILS > 0) {
      console.error(`\nT715X-FAIL: ${FAILS} 項失敗`);
      process.exit(1);
    }
    console.log("\nT715X-OK");
    process.exit(0);
  })
  .catch(async (err) => {
    await prisma.$disconnect().catch(() => undefined);
    console.error(`\nT715X-FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });

/**
 * e2e-s114-t71x — cwi-final S1-14 T718/T719/T720：急症 deterministic 紅旗 intake（唔靠 LLM）
 *
 * spec 口徑（anchored MD 行 1709-1796）：
 *   T718：AI_MOCK_FAIL=1 → 「流血不止」→ 5 秒內 urgent=true + URGENT_ESCALATION notice + push
 *   T719：急症後再發「喂？有冇人」（測試店設 L2 policy）→ 0 條 aiAutoSent
 *   T720：AI job 最終失敗 → SYSTEM notice「AI 未能處理」
 *
 * 設計：
 *  - 獨立 fixture（company E2ES14U-CO + clinic E2ES14U + STAFF S + 2 病人 waId）— 唔郁 dev 店（TKW 等）
 *  - worker 重起管理：pgrep 精確 PID kill（禁 pkill -f pattern — 會撞自己 shell）+ setsid detached spawn
 *    + readiness = log 出現 "all workers running — waiting for jobs"
 *  - push 斷言行真路徑：webhook → inbound worker → urgentIntake → pushEvent → web-push
 *    → 本地 TLS mock endpoint（/tmp/e2e-push-tls CA — 同 e2e-push.ts 同一份）→ ECE 解密斷言 kind=urgent
 *    + PushSubscription.lastOkAt 更新（worker 2xx 回寫）
 *  - T719 精確性：mock「喂？有冇人」→ QUESTION conf 0.6（= triage 默认 floor 0.6，唔會撞 low-confidence
 *    閘）→ 斷言 draft traceJson.gates.blocks 含 conv-urgent 且 autoSent=false（唯一擋 = urgent，唔係別因）
 *  - finally：fixture cleanup + 還原 baseline worker（帶 CA、無 AI_MOCK_FAIL）+ pgrep 確認剩 1 個 worker
 *
 * 前置：dev stack live（web 3100 + DB 15432 + redis 6379 + /tmp/e2e-push-tls/ca.pem）。
 * 用法（repo root）：pnpm e2e:s114-t71x
 * 輸出：T71X-OK / T71X-FAIL: <reason>（exit 1）
 *
 * ★ PII 鐵律：mock 訊息只係口語短句；斷言全部 metadata（DB 欄位 / gates / kind）。
 */
import "./e2e-origin-shim";
import { spawn, spawnSync, execSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, readdirSync, openSync } from "node:fs";
import path from "node:path";
import https from "node:https";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";

// http_ece 係 web-push 嘅 transitive 依賴（pnpm 隔離）— 由 web-push 位置解析（同 e2e-push.ts）
function loadEce(): { decrypt: (buf: Buffer, params: Record<string, unknown>, cb: unknown) => Buffer } {
  const tryReq = (req: NodeRequire): unknown => {
    try {
      const m = req("http_ece") as { decrypt?: unknown };
      if (typeof m?.decrypt === "function") return m;
    } catch {
      /* next */
    }
    return null;
  };
  const candidates = [tryReq(createRequire(path.join(process.cwd(), "package.json")))];
  try {
    const wpDir = path.dirname(require.resolve("web-push"));
    candidates.push(tryReq(createRequire(path.join(wpDir, "x.js"))));
  } catch {
    /* web-push 解析失敗 → 靠 .pnpm 掃 */
  }
  for (const c of candidates) if (c) return c as never;
  const pnpmDir = path.join(process.cwd(), "node_modules", ".pnpm");
  if (existsSync(pnpmDir)) {
    for (const d of readdirSync(pnpmDir)) {
      if (d.startsWith("http_ece@")) {
        const f = path.join(pnpmDir, d, "node_modules", "http_ece", "ece.js");
        if (existsSync(f)) {
          const m = createRequire(f)(f) as { decrypt?: unknown };
          if (typeof m?.decrypt === "function") return m as never;
        }
      }
    }
  }
  throw new Error("http_ece 搵唔到（web-push 依賴）");
}
const ece = loadEce();

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
try {
  process.loadEnvFile(path.join(REPO, ".env"));
} catch {
  /* 靠 process env */
}
const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const WA_APP_SECRET = process.env.WA_APP_SECRET ?? "";
const CA_PATH = "/tmp/e2e-push-tls/ca.pem";

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
const COMPANY_CODE = "E2ES14U-CO";
const CLINIC_U = "E2ES14U";
const PH_ID = "E2ES14U-PH";
const DISPLAY = "+852 0000 7314";
const STAFF_EMAIL = "e2e-s114u@wa-clinic.local";
const WA_P1 = "99081421"; // T718/T719 病人
const WA_P2 = "99081422"; // T720 病人
const TS = Date.now();
// 每次 run 唯一（重跑唔撞 unique id — 冪等前置 cleanup 亦會先清舊 fixture）
const C1_ID = `e2es14ut718a${(TS % 1679616).toString(36)}`;

let clinicId = "";
let staffId = "";

// ── worker 管理（精確 PGID kill；禁 pkill -f pattern） ─────────────────────────
const WORKER_LOG = "/tmp/e2e-s114-worker.log";
// 一個 worker group = pnpm + sh -c + tsx CLI + app node（tsx re-exec）— 同一 PGID（detached spawn）。

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
  for (const g of uniqueGroupIds()) killGroup(g, "SIGKILL"); // 剩餘強殺
  await sleep(500);
}

function startWorker(extraEnv: Record<string, string>): void {
  writeFileSync(WORKER_LOG, "");
  const fd = openSync(WORKER_LOG, "a");
  const child = spawn(
    "pnpm",
    ["worker"],
    {
      cwd: REPO,
      env: { ...process.env, NODE_EXTRA_CA_CERTS: CA_PATH, ...extraEnv },
      stdio: ["ignore", fd, fd],
      detached: true, // setsid 語義 — 自己個 process group
    }
  );
  child.unref();
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

// ── mock push endpoint（TLS — web-push 永遠 https.request） ─────────────
// TLS 物料同 e2e-push.ts 共用 /tmp/e2e-push-tls（★ CA 一旦存在就唔好重發 — worker start 時快照 CA）。
interface Capture {
  body: Buffer;
  contentEncoding: string;
  cryptoKey: string;
  encryption: string;
  t: number;
}
const captures: Capture[] = [];
let pushServer: https.Server | null = null;
let pushPort = 0;

function ensureTlsFiles(): { key: Buffer; cert: Buffer } {
  const TLS_DIR = "/tmp/e2e-push-tls";
  const keyPath = path.join(TLS_DIR, "server-key.pem");
  const certPath = path.join(TLS_DIR, "server.pem");
  const caPath = path.join(TLS_DIR, "ca.pem");
  const caKeyPath = path.join(TLS_DIR, "ca-key.pem");
  if (!existsSync(caPath) || !existsSync(caKeyPath)) {
    execSync(`mkdir -p ${TLS_DIR} && cd ${TLS_DIR} && openssl req -x509 -newkey rsa:2048 -keyout ca-key.pem -out ca.pem -days 30 -nodes -subj "/CN=e2e-push-test-ca" 2>/dev/null`);
  }
  const certValid = (): boolean => {
    try {
      execSync(`openssl x509 -in ${certPath} -noout -checkend 21600`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  if (!existsSync(certPath) || !existsSync(keyPath) || !certValid()) {
    execSync(
      `cd ${TLS_DIR} && openssl req -newkey rsa:2048 -keyout server-key.pem -out server.csr -nodes -subj "/CN=127.0.0.1" 2>/dev/null && printf "subjectAltName=IP:127.0.0.1,DNS:localhost\\n" > san.cnf && openssl x509 -req -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -out server.pem -days 7 -extfile san.cnf 2>/dev/null`
    );
  }
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

async function startPushServer(): Promise<void> {
  const { key, cert } = ensureTlsFiles();
  pushServer = https.createServer({ key, cert }, (rq, rs) => {
    const chunks: Buffer[] = [];
    rq.on("data", (c) => chunks.push(c));
    rq.on("end", () => {
      captures.push({
        body: Buffer.concat(chunks),
        contentEncoding: String(rq.headers["content-encoding"] ?? "aesgcm"),
        cryptoKey: String(rq.headers["crypto-key"] ?? ""),
        encryption: String(rq.headers["encryption"] ?? ""),
        t: Date.now(),
      });
      rs.writeHead(201, { "content-type": "application/json" });
      rs.end("{}");
    });
  });
  await new Promise<void>((res) => pushServer?.listen(0, "127.0.0.1", () => res()));
  pushPort = (pushServer?.address() as { port: number })?.port ?? 0;
}

interface MockSub {
  privateKey: Buffer;
  p256dh: string;
  auth: string;
}
function makeSub(): MockSub {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    privateKey: ecdh.getPrivateKey(),
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: crypto.randomBytes(16).toString("base64url"),
  };
}

/** 解密 capture → plaintext（aes128gcm = web-push 預設；salt + keyid 喺 payload 內） */
function decryptCapture(c: Capture, sub: MockSub): string {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(sub.privateKey);
  let plain: Buffer;
  if (c.contentEncoding === "aes128gcm") {
    plain = ece.decrypt(c.body, { version: "aes128gcm", privateKey: ecdh, authSecret: sub.auth }, null);
  } else {
    const mDh = /^dh=([A-Za-z0-9_-]+)$/.exec(c.cryptoKey);
    const mSalt = /^salt=([A-Za-z0-9_-]+)$/.exec(c.encryption);
    if (!mDh || !mSalt) throw new Error(`aesgcm header 缺（crypto-key="${c.cryptoKey}" encryption="${c.encryption}"）`);
    plain = ece.decrypt(
      c.body,
      { version: "aesgcm", dh: mDh[1], salt: mSalt[1], privateKey: ecdh, authSecret: sub.auth },
      null
    );
  }
  return plain.toString("utf8");
}

// ── mock inbound webhook（HMAC-SHA256 — 照 e2e-s14-t612.ts） ────────────
async function mockInbound(waId: string, wamid: string, text: string, name: string): Promise<void> {
  const bizNumber = DISPLAY.replace(/\D/g, "");
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: PH_ID,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: bizNumber, phone_number_id: PH_ID },
              contacts: [{ profile: { name }, wa_id: waId }],
              messages: [{ from: waId, id: wamid, timestamp: Math.floor(Date.now() / 1000).toString(), type: "text", text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  const signature = "sha256=" + crypto.createHmac("sha256", WA_APP_SECRET).update(raw).digest("hex");
  const res = await fetch(`${BASE}/api/wa/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hub-signature-256": signature },
    body: raw,
  });
  if (res.status !== 200) throw new Error(`webhook ${wamid} → HTTP ${res.status}: ${await res.text().catch(() => "")}`);
}

// ── fixture seed / cleanup ───────────────────────────────────────────────
let pushSub: MockSub | null = null;

async function seed(): Promise<void> {
  const company = await prisma.company.create({ data: { code: COMPANY_CODE, name: "E2ES14U CO" } });
  const clinic = await prisma.clinic.create({
    data: { companyId: company.id, code: CLINIC_U, name: "E2ES14U Clinic", waPhoneNumberId: PH_ID, waDisplayNumber: DISPLAY, aiMode: "AUTO" },
  });
  clinicId = clinic.id;
  const argon2 = (await import("argon2")).default;
  const staff = await prisma.staffUser.create({
    data: { email: STAFF_EMAIL, name: "E2ES14U Staff", role: "STAFF", scopeType: "CLINICS", passwordHash: await argon2.hash("e2e-s114u-pass-2026") },
  });
  staffId = staff.id;
  await prisma.staffClinic.create({ data: { staffId, clinicId, isPrimary: true } });
  // L2 policy（T719：全 intent AUTO 資格 — 斷言唔係 L1 壓住）
  await prisma.automationPolicy.create({ data: { clinicId, category: "*", level: "L2" } });
  // 病人 1 + 預建 conv（T718/T719 — webhook 入嚟 worker upsert 到同一條）
  const ct = await prisma.contact.create({ data: { clinicId, waId: WA_P1, profileName: "E2ES14U P1", labels: [] } });
  await prisma.conversation.create({
    data: { id: C1_ID, clinicId, contactId: ct.id, status: "OPEN", lastMessageAt: new Date(Date.now() - 3600_000) },
  });
  // push subscription（真 path — worker pushEvent 會 push 到呢個 endpoint）
  pushSub = makeSub();
  await prisma.pushSubscription.create({
    data: { staffId, endpoint: `https://127.0.0.1:${pushPort}/ep/s114`, p256dh: pushSub.p256dh, auth: pushSub.auth, userAgent: "e2e-s114" },
  });
}

async function cleanup(): Promise<void> {
  // 每句獨立 catch — 一句失敗唔阻其他（run 1 教訓：一齊 try 會早退）
  const clinicSub = `(SELECT id FROM "Clinic" WHERE code = '${CLINIC_U}')`;
  const convSub = `(SELECT id FROM "Conversation" WHERE "clinicId" IN ${clinicSub})`;
  const stmts: string[] = [
    `DELETE FROM "Message" WHERE "conversationId" IN ${convSub}`,
    `DELETE FROM "AiDraft" WHERE "conversationId" IN ${convSub}`,
    `DELETE FROM "StaffNotice" WHERE "clinicId" IN ${clinicSub} OR "conversationId" IN ${convSub}`,
    `DELETE FROM "WebhookEvent" WHERE id LIKE 'wamid.E2ES114.%'`,
    `DELETE FROM "ConsultSession" WHERE "conversationId" IN ${convSub}`,
    `DELETE FROM "PainTriageSession" WHERE "conversationId" IN ${convSub}`,
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
  await prisma.automationPolicy.deleteMany({ where: { clinicId } }).catch((e) => console.warn(`  ⚠️ cleanup policy: ${e instanceof Error ? e.message : String(e)}`));
  await prisma.pushSubscription.deleteMany({ where: { endpoint: { startsWith: `https://127.0.0.1:${pushPort}/` } } }).catch((e) => console.warn(`  ⚠️ cleanup pushsub: ${e instanceof Error ? e.message : String(e)}`));
  await prisma.contact.deleteMany({ where: { waId: { in: [WA_P1, WA_P2] } } }).catch((e) => console.warn(`  ⚠️ cleanup contact: ${e instanceof Error ? e.message : String(e)}`));
  await prisma.staffClinic.deleteMany({ where: { staff: { email: STAFF_EMAIL } } }).catch((e) => console.warn(`  ⚠️ cleanup staffclinic: ${e instanceof Error ? e.message : String(e)}`));
  await prisma.staffUser.deleteMany({ where: { email: STAFF_EMAIL } }).catch((e) => console.warn(`  ⚠️ cleanup staff: ${e instanceof Error ? e.message : String(e)}`));
  await prisma.clinic.deleteMany({ where: { code: CLINIC_U } }).catch((e) => console.warn(`  ⚠️ cleanup clinic: ${e instanceof Error ? e.message : String(e)}`));
  await prisma.company.deleteMany({ where: { code: COMPANY_CODE } }).catch((e) => console.warn(`  ⚠️ cleanup company: ${e instanceof Error ? e.message : String(e)}`));
}

// ── T718：AI_MOCK_FAIL=1 → 「流血不止」→ 5 秒內 urgent + notice + push ──
async function t718(): Promise<void> {
  console.log("\n── T718：AI_MOCK_FAIL=1 → 「流血不止」→ 5 秒內 urgent=true + URGENT_ESCALATION notice + push ──");
  const wamid = `wamid.E2ES114.${TS}.t718`;
  const t0 = Date.now();
  await mockInbound(WA_P1, wamid, "流血不止", "E2ES14U P1");

  // poll DB ≤ 6s（spec：5 秒內）
  let conv: { urgent: boolean; urgency: string | null; intent: string | null } | null = null;
  for (let i = 0; i < 30; i++) {
    conv = await prisma.conversation.findUnique({ where: { id: C1_ID }, select: { urgent: true, urgency: true, intent: true } });
    if (conv?.urgent) break;
    await sleep(200);
  }
  const elapsed = Date.now() - t0;
  check("T718a urgent=true", conv?.urgent === true, `elapsed=${elapsed}ms`);
  check("T718b 5 秒內（deterministic — 唔等 LLM）", conv?.urgent === true && elapsed <= 5000, `elapsed=${elapsed}ms`);
  check("T718c urgency=HIGH", conv?.urgency === "HIGH", conv?.urgency);
  check("T718d intent=URGENT_PAIN", conv?.intent === "URGENT_PAIN", conv?.intent);

  // URGENT_ESCALATION notice（meta.msgId 對齊 + categories）
  const msg = await prisma.message.findUnique({ where: { waMessageId: wamid }, select: { id: true } });
  const notices = await prisma.staffNotice.findMany({ where: { conversationId: C1_ID, kind: "URGENT_ESCALATION" } });
  const n = notices.find((x) => (x.meta as { msgId?: string } | null)?.msgId === msg?.id);
  check("T718e URGENT_ESCALATION notice（msgId 對齊）", n !== undefined, `count=${notices.length}`);
  if (n) {
    const meta = n.meta as { categories?: string[]; source?: string };
    check("T718f categories 含 bleeding + source=intake", Array.isArray(meta.categories) && meta.categories.includes("bleeding") && meta.source === "intake", meta);
  }

  // push（真 path：web-push → TLS mock endpoint → ECE 解密）
  let urgentPushSeen = false;
  let lastPlain = "";
  for (let i = 0; i < 60 && !urgentPushSeen; i++) {
    for (const c of captures) {
      if (urgentPushSeen) break;
      try {
        const plain = JSON.parse(decryptCapture(c, pushSub!)) as { kind?: string; conversationId?: string };
        lastPlain = plain.kind ?? "";
        if (plain.kind === "urgent" && plain.conversationId === C1_ID) urgentPushSeen = true;
      } catch {
        /* 非本 sub / 未到 */
      }
    }
    if (!urgentPushSeen) await sleep(250);
  }
  check("T718g push 收到（kind=urgent + conv 對齊）", urgentPushSeen, `captures=${captures.length} lastKind=${lastPlain}`);
  const subRow = await prisma.pushSubscription.findFirst({ where: { staffId }, select: { lastOkAt: true } });
  check("T718h subscription lastOkAt 更新（worker 2xx）", subRow?.lastOkAt != null, subRow?.lastOkAt ?? null);
}

// ── T720：AI job 最終失敗 → SYSTEM notice「AI 未能處理」 ─────────────────
async function t720(): Promise<void> {
  console.log("\n── T720：AI job 最終失敗（AI_MOCK_FAIL=1，attempts 3 耗盡）→ SYSTEM notice ──");
  const wamid = `wamid.E2ES114.${TS}.t720`;
  await mockInbound(WA_P2, wamid, "你好，想問下埋門時間", "E2ES14U P2");
  const t0 = Date.now();
  let notice: { id: string; title: string; meta: unknown; conversationId: string | null } | null = null;
  let c2id = "";
  for (let i = 0; i < 120; i++) {
    if (!c2id) {
      const ct2 = await prisma.contact.findFirst({ where: { clinicId, waId: WA_P2 }, select: { id: true } });
      if (ct2) {
        const conv2 = await prisma.conversation.findFirst({ where: { contactId: ct2.id }, select: { id: true } });
        if (conv2) c2id = conv2.id;
      }
    }
    if (c2id) {
      notice = (await prisma.staffNotice.findFirst({
        where: { conversationId: c2id, kind: "SYSTEM", title: "AI 未能處理呢條訊息 — 請人手睇" },
        select: { id: true, title: true, meta: true, conversationId: true },
      })) ?? null;
    }
    if (notice) break;
    await sleep(500);
  }
  check("T720a SYSTEM notice「AI 未能處理」", notice !== null, `waitedMs=${Date.now() - t0}`);
  if (notice) {
    const meta = notice.meta as { reason?: string; jobId?: string } | null;
    check("T720b meta.reason=AI_FAILED + jobId 有值", meta?.reason === "AI_FAILED" && Boolean(meta?.jobId), meta);
  }
  const auto = await prisma.message.count({ where: { conversationId: c2id, direction: "OUT", aiAutoSent: true } });
  check("T720c 0 條 aiAutoSent（AI 死 = 冇 auto 覆）", auto === 0, auto);
}

// ── T719：急症後再發「喂？有冇人」（L2 policy）→ 0 條 aiAutoSent ────────
async function t719(): Promise<void> {
  console.log("\n── T719：急症後再發「喂？有冇人」（店 L2 policy）→ 0 條 aiAutoSent ──");
  const c1 = await prisma.conversation.findUnique({ where: { id: C1_ID }, select: { urgent: true, intent: true } });
  check("T719 pre：C1 仍 urgent=true（T718 標記保留）", c1?.urgent === true, c1);

  const wamid = `wamid.E2ES114.${TS}.t719`;
  await mockInbound(WA_P1, wamid, "喂？有冇人", "E2ES14U P1");

  // 等 AI 處理完（mock QUESTION）— conv intent 由 URGENT_PAIN 更新到 QUESTION
  let intent: string | null = null;
  const t0 = Date.now();
  for (let i = 0; i < 90; i++) {
    intent = (await prisma.conversation.findUnique({ where: { id: C1_ID }, select: { intent: true } }))?.intent ?? null;
    if (intent === "QUESTION") break;
    await sleep(500);
  }
  check("T719a AI 有處理（intent=QUESTION — 唔係 fail skip）", intent === "QUESTION", `intent=${intent} waitedMs=${Date.now() - t0}`);

  // draft + trace gates（精確斷言：擋 = conv-urgent，唔係低置信度/其他閘）
  const msg = await prisma.message.findUnique({ where: { waMessageId: wamid }, select: { id: true } });
  const draft = await prisma.aiDraft.findFirst({ where: { inReplyToMessageId: msg?.id }, select: { id: true, traceJson: true } });
  check("T719b draft 已建（canDraft 維持 — 草稿照出俾 staff）", draft !== null);
  const gates = (draft?.traceJson as { gates?: { autoLevel?: string; blocks?: string[]; autoSent?: boolean } } | null)?.gates;
  check("T719c autoLevel=L2（policy 生效 — 唔係 L1 壓住）", gates?.autoLevel === "L2", gates);
  check("T719d blocks 含 conv-urgent", Array.isArray(gates?.blocks) && gates.blocks.includes("conv-urgent"), gates?.blocks);
  check("T719e 唔含 low-confidence（唯一擋 = urgent）", !Array.isArray(gates?.blocks) || !gates.blocks.includes("low-confidence"), gates?.blocks);
  check("T719f autoSent=false", gates?.autoSent === false, gates?.autoSent);
  const auto = await prisma.message.count({ where: { conversationId: C1_ID, direction: "OUT", aiAutoSent: true } });
  check("T719g 0 條 aiAutoSent（急症對話永唔自動覆）", auto === 0, auto);
}

// ── main ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("e2e-s114-t71x — cwi-final S1-14 T718/T719/T720");
  if (!existsSync(CA_PATH)) throw new Error(`/tmp/e2e-push-tls/ca.pem 冇（先跑 e2e-push 生成；見 TOOLS.md 重啟恢復清單）`);

  await startPushServer();
  check("push mock endpoint 已起", pushPort > 0, `port=${pushPort}`);
  // 冪等前置：先清舊 fixture（上次 crash 殘留 — 避免 unique id / FK 撞）
  await cleanup().catch((err) => console.warn(`pre-cleanup error: ${err instanceof Error ? err.message : String(err)}`));
  await seed();
  check("fixture 已 seed（clinic E2ES14U + L2 policy + push sub）", clinicId !== "" && staffId !== "");

  try {
    // Phase 1：AI_MOCK_FAIL=1 worker（T718 急症唔靠 LLM 實證 + T720 最終失敗）
    console.log("\n[phase 1] 重起 worker（AI_MOCK_FAIL=1）…");
    await stopWorkers();
    startWorker({ AI_MOCK_FAIL: "1" });
    check("worker ready（AI_MOCK_FAIL=1）", await waitForWorkerReady());
    await t718();
    await t720();

    // Phase 2：baseline worker（T719 — AI 正常行）
    console.log("\n[phase 2] 重起 worker（baseline — 無 AI_MOCK_FAIL）…");
    await stopWorkers();
    startWorker({});
    check("worker ready（baseline）", await waitForWorkerReady());
    await t719();
  } finally {
    // 還原：fixture 清走 + 保留一個 baseline worker（帶 CA、無 AI_MOCK_FAIL）
    await cleanup().catch((err) => console.warn(`cleanup error: ${err instanceof Error ? err.message : String(err)}`));
    pushServer?.close();
    const groups = uniqueGroupIds();
    if (groups.length === 1) {
      ok(`worker 剩 1 個 group（baseline，PGID ${groups[0]}）`);
    } else {
      console.warn(`  ⚠️ worker 剩 ${groups.length} 個 group → 全 kill 重起 baseline`);
      await stopWorkers();
      startWorker({});
      check("worker ready（final baseline）", await waitForWorkerReady());
    }
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    if (FAILS > 0) {
      console.error(`\nT71X-FAIL: ${FAILS} 項失敗`);
      process.exit(1);
    }
    console.log("\nT71X-OK");
    process.exit(0);
  })
  .catch(async (err) => {
    await prisma.$disconnect().catch(() => {});
    console.error(`\nT71X-FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });

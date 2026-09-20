/**
 * e2e-s15-t704 — cwi-final S1-5 T704：push 收件人按 scope（N-5 STAFF 三 scope / L-2 路由目標 / P2-12 ADMIN 收窄）。
 *
 * fixture（全 fake，hermetic — 段尾 cleanup + 零殘留斷言）：
 * - Company A（E2ET704A）+ Clinic CA（E2ET704A）；Company B（E2ET704B）+ Clinic CB（E2ET704B = 「YMT」角色）
 * - S_B：STAFF / COMPANY scope 公司 B（無 StaffClinic 行 — N-5 核心：唔可以靠 StaffClinic）
 * - A_A：ADMIN / COMPANY scope 公司 A（scope 唔覆蓋 CB）
 * - A_B：ADMIN / COMPANY scope 公司 B（in-scope 對照）
 * - S_X：STAFF / CLINICS scope 綁 CA（跨店）+ 技能組 G 成員（L-2 路由目標）
 * - CV_CB：CB 對話（unassigned + routedGroupId=G）
 *
 * 斷言：
 * - P1（普通 message，未指派）：S_B 收（N-5 COMPANY scope）/ S_X 收（L-2 路由組跨店）/
 *   A_B 收（in-scope admin opt-in）/ A_A 唔收（scope 外）
 * - P2（urgent — FLOOR 紅旗詞「發燒」→ mock AI URGENT_PAIN）：A_A 唔收（P2-12 收窄核心）/
 *   A_B 收（in-scope urgent）/ S_B 收 / S_X 收
 * - P3（push/prefs ∩ scope）：A_A POST adminMsgClinics=[CB] → DB 裁走（[]）
 *
 * 用法（repo root，dev stack live + worker 帶 NODE_EXTRA_CA_CERTS=/tmp/e2e-push-tls/ca.pem）：
 *   pnpm e2e:s15-t704
 * 輸出：T704-OK / T704-FAIL: <reason>
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import https from "node:https";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { execFile, execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";

const REPO = path.join(import.meta.dirname, "..");
const BASE = (process.env.E2E_BASE ?? "http://127.0.0.1:3100").replace(/\/$/, "");
try {
  process.loadEnvFile(path.join(REPO, ".env"));
} catch {
  /* 靠 process env */
}

const prisma = new PrismaClient();

// ── 結果 ────────────────────────────────────────────────────────────────
let failCount = 0;
function ok(label: string): void {
  console.log(`  ✅ ${label}`);
}
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) ok(label);
  else {
    failCount++;
    console.error(`  ❌ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}
function fail(r: string): never {
  console.error(`T704-FAIL: ${r}`);
  process.exit(1);
}

// ── ECE 解密（照 e2e-push.ts：web-push 嘅 http_ece transitive 依賴）──────
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
    /* next */
  }
  for (const c of candidates) if (c) return c as never;
  const pnpmDir = path.join(process.cwd(), "node_modules", ".pnpm");
  if (existsSync(pnpmDir)) {
    for (const d of readdirSync(pnpmDir)) {
      if (d.startsWith("http_ece@")) {
        const f = path.join(pnpmDir, d, "node_modules", "http_ece", "ece.js");
        if (existsSync(f)) {
          const m = createRequire(f)(f) as { decrypt?: unknown };
          if (typeof m.decrypt === "function") return m as never;
        }
      }
    }
  }
  throw new Error("http_ece 搵唔到（web-push 依賴）");
}
const ece = loadEce();

// ── TLS（/tmp/e2e-push-tls 共用；CA 一旦存在唔好重發 — worker 起機快照）──
const TLS_DIR = "/tmp/e2e-push-tls";
function ensureTlsFiles(): { key: Buffer; cert: Buffer } {
  const keyPath = path.join(TLS_DIR, "server-key.pem");
  const certPath = path.join(TLS_DIR, "server.pem");
  const caPath = path.join(TLS_DIR, "ca.pem");
  const caKeyPath = path.join(TLS_DIR, "ca-key.pem");
  if (!existsSync(caPath) || !existsSync(caKeyPath)) {
    execSync(
      `mkdir -p ${TLS_DIR} && cd ${TLS_DIR} && openssl req -x509 -newkey rsa:2048 -keyout ca-key.pem -out ca.pem -days 30 -nodes -subj "/CN=e2e-push-test-ca" 2>/dev/null`
    );
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

// ── mock push endpoint（HTTPS；captures in-memory）─────────────────────
interface Capture {
  endpoint: string;
  body: Buffer;
  contentEncoding: string;
  vapidHeader: string;
  t: number;
}
const captures: Capture[] = [];
let serverPort = 0;
let pushServer: https.Server;

function startMockPushServer(): void {
  const tls = ensureTlsFiles();
  pushServer = https.createServer({ key: tls.key, cert: tls.cert }, (rq, rs) => {
    const chunks: Buffer[] = [];
    rq.on("data", (c) => chunks.push(c));
    rq.on("end", () => {
      if (rq.method === "POST" && rq.url?.startsWith("/ep/")) {
        captures.push({
          endpoint: `https://127.0.0.1:${serverPort}${rq.url}`,
          body: Buffer.concat(chunks),
          contentEncoding: String(rq.headers["content-encoding"] ?? "aes128gcm"),
          vapidHeader: String(rq.headers["authorization"] ?? ""),
          t: Date.now(),
        });
        rs.writeHead(200, { "content-type": "application/json" });
        rs.end("{}");
      } else {
        rs.writeHead(404);
        rs.end();
      }
    });
  });
}

interface MockSub {
  endpoint: string;
  p256dh: string;
  auth: string;
  privateKey: Buffer;
}
function makeSub(token: string): MockSub {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint: `https://127.0.0.1:${serverPort}/ep/${token}`,
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: crypto.randomBytes(16).toString("base64url"),
    privateKey: ecdh.getPrivateKey(),
  };
}
function decryptCapture(c: Capture, sub: MockSub): string {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(sub.privateKey);
  const plain =
    c.contentEncoding === "aes128gcm"
      ? ece.decrypt(c.body, { version: "aes128gcm", privateKey: ecdh, authSecret: sub.auth }, null)
      : (() => {
          throw new Error(`unexpected contentEncoding ${c.contentEncoding}`);
        })();
  return plain.toString("utf8");
}

// ── fixture ids（cuid 形 — normalizeRoute 鐵律）────────────────────────
const FIX = {
  companyA: "t704companya00000000000001",
  companyB: "t704companyb00000000000002",
  clinicA: "t704clinica0000000000000001",
  clinicB: "t704clinicb0000000000000002",
  staffB: "t704staffb0000000000000001", // STAFF / COMPANY B
  adminA: "t704admina0000000000000001", // ADMIN / COMPANY A
  adminB: "t704adminb0000000000000001", // ADMIN / COMPANY B
  staffX: "t704staffx0000000000000001", // STAFF / CLINICS 綁 CA（跨店組員）
  group: "t704group00000000000000001",
  contact: "t704contact00000000000001",
  conv: "t704convcb00000000000000001",
  codeA: "E2ET704A",
  codeB: "E2ET704B",
  waId: "85291704001",
  password: "T704-e2e-passw0rd",
};

let clinicBId = "";

// ── login（限流 5/60s/IP → cookie cache；probe 先重用）─────────────────
const COOKIE_CACHE = "/tmp/w-t704-cookies.json";
async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`login ${email} → ${res.status}`);
  const m = (res.headers.get("set-cookie") ?? "").match(/wa_inbox_session=([^;]+)/);
  if (!m) throw new Error("login 冇 wa_inbox_session cookie");
  return m[1];
}
async function cookieFor(email: string, password: string): Promise<string> {
  const key = `t704:${email}`;
  try {
    const cache = JSON.parse(readFileSync(COOKIE_CACHE, "utf8")) as Record<string, string>;
    if (cache[key]) {
      const probe = await fetch(`${BASE}/api/conversations?counts=1`, { headers: { cookie: `wa_inbox_session=${cache[key]}` } });
      if (probe.status === 200) return cache[key];
    }
  } catch {
    /* 無 cache */
  }
  const c = await login(email, password);
  let next: Record<string, string> = {};
  try {
    next = JSON.parse(readFileSync(COOKIE_CACHE, "utf8")) as Record<string, string>;
  } catch {
    /* fresh */
  }
  next[key] = c;
  try {
    const fs = await import("node:fs");
    fs.writeFileSync(COOKIE_CACHE, JSON.stringify(next));
  } catch {
    /* cache 失敗唔阻測試 */
  }
  return c;
}

async function api(cookie: string, urlPath: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${BASE}${urlPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `wa_inbox_session=${cookie}` },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await res.json().catch(() => null)) as unknown;
  return { status: res.status, json };
}

async function subscribe(cookie: string, staffId: string, sub: MockSub): Promise<void> {
  const r = await api(cookie, "/api/push/subscribe", { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth }, userAgent: "e2e-t704" });
  if (r.status !== 200) fail(`subscribe ${staffId} 失敗 status=${r.status} json=${JSON.stringify(r.json)}`);
  const row = await prisma.pushSubscription.findUnique({ where: { endpoint: sub.endpoint }, select: { staffId: true } });
  if (!row) fail("subscribe DB row 缺");
  if (row.staffId !== staffId) fail(`subscribe owner 錯（expected=${staffId} actual=${row.staffId}）`);
}

// ── inbound（真 webhook path：worker → notifyNewMessage / ai.worker → pushEvent）
let msgSeq = 0;
async function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function sendInbound(text: string): Promise<void> {
  const wamid = `wamid.T704_${Date.now()}_${++msgSeq}`;
  await new Promise<void>((res, rej) => {
    execFile(
      "pnpm",
      ["-s", "mock-inbound", "message", "--clinic", FIX.codeB, "--from", FIX.waId, "--text", text, "--wamid", wamid],
      { cwd: process.cwd(), timeout: 30_000 },
      (err) => (err ? rej(err) : res())
    );
  });
  const t0 = Date.now();
  for (;;) {
    const m = await prisma.message.findFirst({ where: { waMessageId: wamid }, select: { id: true } });
    if (m) return;
    if (Date.now() - t0 > 60_000) fail(`worker 60s 未處理 inbound（wamid=${wamid}）`);
    await waitMs(1000);
  }
}
async function waitForCapture(endpoint: string, sinceT: number, what: string, timeoutMs = 45_000): Promise<Capture> {
  const t0 = Date.now();
  for (;;) {
    const c = captures.filter((x) => x.endpoint === endpoint && x.t > sinceT).pop();
    if (c) return c;
    if (Date.now() - t0 > timeoutMs) fail(`${what}：等 capture 逾時（captures=${captures.length}）`);
    await waitMs(750);
  }
}
async function assertNoCapture(endpoint: string, sinceT: number, what: string, windowMs = 12_000): Promise<void> {
  await waitMs(windowMs);
  const n = captures.filter((x) => x.endpoint === endpoint && x.t > sinceT).length;
  check(what, n === 0, { unexpectedCaptures: n });
}

// ── fixture setup / cleanup ─────────────────────────────────────────────
const PW = () => argon2.hash(FIX.password);
async function setupFixture(): Promise<void> {
  // 冪等：先洗舊（re-run 安全）
  await cleanupFixture();

  await prisma.company.create({ data: { id: FIX.companyA, code: FIX.codeA, name: "T704 公司 A" } });
  await prisma.company.create({ data: { id: FIX.companyB, code: FIX.codeB, name: "T704 公司 B" } });
  await prisma.clinic.create({
    data: { id: FIX.clinicA, code: FIX.codeA, name: "T704 店 A", companyId: FIX.companyA, waPhoneNumberId: "9999999999001", waDisplayNumber: "85299000001" },
  });
  await prisma.clinic.create({
    data: { id: FIX.clinicB, code: FIX.codeB, name: "T704 店 B", companyId: FIX.companyB, waPhoneNumberId: "9999999999002", waDisplayNumber: "85299000002" },
  });
  clinicBId = FIX.clinicB;

  // S_B：STAFF / COMPANY B（無 StaffClinic — N-5 核心）
  await prisma.staffUser.create({
    data: { id: FIX.staffB, email: "t704-staff-b@wa-clinic.local", passwordHash: await PW(), name: "T704 Staff B", role: "STAFF", scopeType: "COMPANY", scopeCompanyId: FIX.companyB },
  });
  await prisma.staffUser.create({
    data: { id: FIX.adminA, email: "t704-admin-a@wa-clinic.local", passwordHash: await PW(), name: "T704 Admin A", role: "ADMIN", scopeType: "COMPANY", scopeCompanyId: FIX.companyA },
  });
  await prisma.staffUser.create({
    data: { id: FIX.adminB, email: "t704-admin-b@wa-clinic.local", passwordHash: await PW(), name: "T704 Admin B", role: "ADMIN", scopeType: "COMPANY", scopeCompanyId: FIX.companyB },
  });
  await prisma.staffUser.create({
    data: { id: FIX.staffX, email: "t704-staff-x@wa-clinic.local", passwordHash: await PW(), name: "T704 Staff X", role: "STAFF", scopeType: "CLINICS", clinicId: FIX.clinicA },
  });
  await prisma.staffClinic.create({ data: { staffId: FIX.staffX, clinicId: FIX.clinicA, isPrimary: true } });

  await prisma.skillGroup.create({ data: { id: FIX.group, name: "T704 測試組", code: "E2ET704G" } });
  await prisma.skillGroupMember.create({ data: { groupId: FIX.group, staffId: FIX.staffX } });

  await prisma.contact.create({ data: { id: FIX.contact, clinicId: FIX.clinicB, waId: FIX.waId, profileName: "E2E T704 病人", labels: [] } });
  await prisma.conversation.create({
    data: { id: FIX.conv, clinicId: FIX.clinicB, contactId: FIX.contact, status: "OPEN", lastMessageAt: new Date(), routedGroupId: FIX.group },
  });
}

async function cleanupFixture(): Promise<void> {
  for (const id of [FIX.staffB, FIX.adminA, FIX.adminB, FIX.staffX]) {
    await prisma.pushSubscription.deleteMany({ where: { staffId: id } }).catch(() => {});
  }
  await prisma.message.deleteMany({ where: { conversationId: FIX.conv } }).catch(() => {});
  await prisma.conversation.deleteMany({ where: { id: FIX.conv } }).catch(() => {});
  await prisma.contact.deleteMany({ where: { id: FIX.contact } }).catch(() => {});
  await prisma.skillGroupMember.deleteMany({ where: { groupId: FIX.group } }).catch(() => {});
  await prisma.skillGroup.deleteMany({ where: { id: FIX.group } }).catch(() => {});
  await prisma.staffClinic.deleteMany({ where: { staffId: FIX.staffX } }).catch(() => {});
  for (const id of [FIX.staffB, FIX.adminA, FIX.adminB, FIX.staffX]) {
    await prisma.staffUser.deleteMany({ where: { id } }).catch(() => {});
  }
  await prisma.clinic.deleteMany({ where: { id: { in: [FIX.clinicA, FIX.clinicB] } } }).catch(() => {});
  await prisma.company.deleteMany({ where: { id: { in: [FIX.companyA, FIX.companyB] } } }).catch(() => {});
}

async function assertZeroResidue(): Promise<void> {
  const residue: string[] = [];
  const probes: [string, () => Promise<number>][] = [
    ["staffUser", () => prisma.staffUser.count({ where: { id: { in: [FIX.staffB, FIX.adminA, FIX.adminB, FIX.staffX] } } })],
    ["staffClinic", () => prisma.staffClinic.count({ where: { staffId: FIX.staffX } })],
    ["skillGroup", () => prisma.skillGroup.count({ where: { id: FIX.group } })],
    ["skillGroupMember", () => prisma.skillGroupMember.count({ where: { groupId: FIX.group } })],
    ["clinic", () => prisma.clinic.count({ where: { id: { in: [FIX.clinicA, FIX.clinicB] } } })],
    ["company", () => prisma.company.count({ where: { id: { in: [FIX.companyA, FIX.companyB] } } })],
    ["contact", () => prisma.contact.count({ where: { id: FIX.contact } })],
    ["conversation", () => prisma.conversation.count({ where: { id: FIX.conv } })],
    ["pushSubscription", () => prisma.pushSubscription.count({ where: { staffId: { in: [FIX.staffB, FIX.adminA, FIX.adminB, FIX.staffX] } } })],
  ];
  for (const [name, q] of probes) {
    const n = await q().catch(() => 0);
    if (n > 0) residue.push(`${name}=${n}`);
  }
  check("cleanup 零殘留", residue.length === 0, residue);
}

// ── main ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("T704: push 收件人按 scope（N-5 / L-2 / P2-12）");
  startMockPushServer();
  await new Promise<void>((res) => pushServer.listen(0, "127.0.0.1", () => res()));
  serverPort = (pushServer.address() as { port: number }).port;

  await setupFixture();
  let subB: MockSub, subA: MockSub, subX: MockSub;
  try {
    const cB = await cookieFor("t704-staff-b@wa-clinic.local", FIX.password);
    const cA = await cookieFor("t704-admin-a@wa-clinic.local", FIX.password);
    const cB2 = await cookieFor("t704-admin-b@wa-clinic.local", FIX.password);
    const cX = await cookieFor("t704-staff-x@wa-clinic.local", FIX.password);

    subB = makeSub("t704-b");
    subA = makeSub("t704-a");
    subX = makeSub("t704-x");
    await subscribe(cB, FIX.staffB, subB);
    await subscribe(cA, FIX.adminA, subA);
    await subscribe(cX, FIX.staffX, subX);
    const subB2 = makeSub("t704-b2");
    await subscribe(cB2, FIX.adminB, subB2);

    // hermetic：A_B opt-in（API — 驗 ∩ scope 保留 in-scope id）
    let r = await api(cB2, "/api/push/prefs", { adminMsgClinics: [clinicBId] });
    check("A_B（in-scope admin）opt-in CB → API 200", r.status === 200, r);
    const aBprefs = await prisma.staffUser.findUnique({ where: { id: FIX.adminB }, select: { pushPrefs: true } });
    const kept = (aBprefs?.pushPrefs as { adminMsgClinics?: string[] } | null)?.adminMsgClinics ?? [];
    check("A_B adminMsgClinics 保留 CB（in-scope）", kept.includes(clinicBId), aBprefs?.pushPrefs);

    // ── P1：普通 message（未指派；CV_CB routedGroupId=G）──────────────────
    console.log("P1: 普通 message（未指派）— N-5 S_B / L-2 S_X / A_B in-scope / A_A 唔收");
    let t0 = Date.now();
    await sendInbound("我想問下");
    const capB = await waitForCapture(subB.endpoint, t0, "P1 S_B（COMPANY scope B STAFF — N-5）");
    let p1 = JSON.parse(decryptCapture(capB, subB)) as { kind?: string; conversationId?: string };
    check("P1 S_B 收到 message push（payload 口徑）", p1.kind === "message" && p1.conversationId === FIX.conv, p1);

    const capX = await waitForCapture(subX.endpoint, t0, "P1 S_X（路由組跨店成員 — L-2）");
    p1 = JSON.parse(decryptCapture(capX, subX)) as { kind?: string; conversationId?: string };
    check("P1 S_X 收到（跨店路由目標 — L-2）", p1.kind === "message" && p1.conversationId === FIX.conv, p1);

    const capB2 = await waitForCapture(subB2.endpoint, t0, "P1 A_B（in-scope admin opt-in）");
    p1 = JSON.parse(decryptCapture(capB2, subB2)) as { kind?: string };
    check("P1 A_B 收到（in-scope + opt-in）", p1.kind === "message", p1);

    await assertNoCapture(subA.endpoint, t0, "P1 A_A（scope 公司 A 唔覆蓋 CB）唔收");

    // ── P2：urgent（「發燒」= FLOOR 紅旗 → URGENT_PAIN）──────────────────
    // 注：urgent push 只喺 ai.worker 判 URGENT_PAIN 時發 — 收到 capture 即證明 URGENT_PAIN 路徑行過
    console.log("P2: urgent — P2-12 A_A 唔收 / A_B in-scope 收 / S_B / S_X 收");
    t0 = Date.now();
    await sendInbound("我而家發燒好攰");

    const capA2 = await waitForCapture(subB2.endpoint, t0, "P2 A_B（in-scope admin — urgent 安全網）");
    p1 = JSON.parse(decryptCapture(capA2, subB2)) as { kind?: string };
    check("P2 A_B 收到 urgent", p1.kind === "urgent", p1);
    const capB2u = await waitForCapture(subB.endpoint, t0, "P2 S_B（in-scope STAFF）");
    p1 = JSON.parse(decryptCapture(capB2u, subB)) as { kind?: string };
    check("P2 S_B 收到 urgent", p1.kind === "urgent", p1);
    const capX2 = await waitForCapture(subX.endpoint, t0, "P2 S_X（路由目標 — 跟靜音，冇 mute 照收）");
    p1 = JSON.parse(decryptCapture(capX2, subX)) as { kind?: string };
    check("P2 S_X 收到 urgent", p1.kind === "urgent", p1);

    // ★ P2-12 核心：公司 A 嘅 COMPANY ADMIN → YMT（CB）urgent → 冇 push
    await assertNoCapture(subA.endpoint, t0, "P2 A_A（公司 A admin）urgent 唔收（P2-12 收窄）");

    // ── P3：push/prefs ∩ scope ──────────────────────────────────────────
    console.log("P3: A_A POST adminMsgClinics=[CB]（scope 外）→ DB 裁走");
    r = await api(cA, "/api/push/prefs", { adminMsgClinics: [clinicBId] });
    check("P3 A_A prefs POST 200", r.status === 200, r);
    const aAprefs = await prisma.staffUser.findUnique({ where: { id: FIX.adminA }, select: { pushPrefs: true } });
    const aAarr = (aAprefs?.pushPrefs as { adminMsgClinics?: string[] } | null)?.adminMsgClinics ?? [];
    check("P3 A_A adminMsgClinics 被裁成 []（scope 外唔准 opt-in）", aAarr.length === 0, aAprefs?.pushPrefs);

    // ── cleanup + 零殘留（綠路先斷言；失敗時 finally 照 cleanup）────────
    await cleanupFixture();
    await assertZeroResidue();
  } finally {
    await cleanupFixture().catch((e) => console.error("cleanup 失敗:", e instanceof Error ? e.message : e));
    pushServer.close();
    await prisma.$disconnect();
  }

  if (failCount > 0) {
    console.error(`T704-FAIL: ${failCount} 項斷言失敗`);
    process.exit(1);
  }
  console.log("T704-OK: push 收件人按 scope（N-5 STAFF 三 scope / L-2 路由目標 / P2-12 ADMIN 收窄 / prefs ∩ scope）");
  process.exit(0);
}

main().catch((e) => {
  console.error(`T704-FAIL: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});

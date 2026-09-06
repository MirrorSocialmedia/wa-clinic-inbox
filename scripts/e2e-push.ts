/**
 * e2e-push — cwi-notify-v2-20260903 T190–T193：Web Push server 側斷言（真 path）。
 *
 * 方法：
 * - 本 script 扮「瀏覽器」：自造 P-256 keypair（p256dh = 65-byte raw point base64url）
 *   + 16-byte auth → POST /api/push/subscribe（endpoint 指向本 script 起嘅 mock HTTP server）。
 * - 觸發用**真 inbound webhook**（`pnpm mock-inbound message`）→ worker → notifyNewMessage
 *   → pushEvent — 完整真實路徑（唔係 spy / 唔係直接調 pushToStaff）。
 * - mock server 收 web-push 加密 body → 用 web-push 嘅 http_ece 依賴 + 自己嘅私有 key
 *   解密 → 斷言 plaintext。
 *
 * 場景：
 * - t190：真 inbound → push 到；payload **只有** kind/clinicShort/conversationId；零 PII regex
 * - t191：收件人解析 — 未指派 → 全店 STAFF（B+C）；已指派 → 只 B；
 *         ADMIN 跟 DB pushPrefs.adminMsgClinics（唔係 localStorage）
 * - t192：410/404 → subscription row 自動刪；200 → lastOkAt 更新
 * - t193：登出 → DB row 刪（server 兜底）→ 同 endpoint 換人登入重訂閱 → 新主收自己嘅 push
 *
 * 用法（repo root）：
 *   pnpm e2e:push --scenario t190 --base http://127.0.0.1:3100 \
 *     --cookie-b <jar> --cookie-c <jar> --cookie-admin <jar> \
 *     --staff-b <id> --staff-c <id> --clinic <tkwId>
 *
 * 輸出：PUSH-OK / PUSH-FAIL: <reason>
 *
 * ★ PII 鐵律：斷言用 canary 病人資料做陷阱（t190）。
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { execFile, execSync } from "node:child_process";
import { Prisma, PrismaClient } from "@prisma/client";

/* eslint-disable @typescript-eslint/no-require-imports */
// http_ece 係 web-push 嘅 transitive 依賴（pnpm 隔離）— 由 web-push 位置解析
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
          if (typeof m.decrypt === "function") return m as never;
        }
      }
    }
  }
  throw new Error("http_ece 搵唔到（web-push 依賴）");
}
const ece = loadEce();

const prisma = new PrismaClient();

// ── args ─────────────────────────────────────────────────────────────────
function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
function req(name: string): string {
  const v = arg(name);
  if (!v) {
    console.error(`missing ${name}`);
    process.exit(2);
  }
  return v;
}

const scenario = req("--scenario");
const base = req("--base").replace(/\/$/, "");
const clinic = req("--clinic");
const cookieB = arg("--cookie-b");
const cookieC = arg("--cookie-c");
const cookieAdmin = arg("--cookie-admin");
const staffB = arg("--staff-b");
const staffC = arg("--staff-c");

const PII_NAME = "PII 張三 E2E";
const PII_WAID = "85291234580";
const PII_TEXT = "e2e-push-pii-xyz 牙痛瞓唔着想約明日";

let clinicCode = "TKW"; // ensureFixture 由 DB 讀真值

// ── mock push endpoint server（同 process — captures 直接 in-memory） ─────
interface Capture {
  endpoint: string;
  body: Buffer;
  contentEncoding: string;
  cryptoKey: string; // "dh=<base64url>"
  encryption: string; // "salt=<base64url>"
  vapidHeader: string;
  t: number;
}
const captures: Capture[] = [];
const endpointStatus: Record<string, number> = {}; // path prefix → status code

/**
 * TLS 物料（/tmp/e2e-push-tls/）：web-push 永遠用 https.request → mock endpoint 必須 HTTPS。
 * ★ 鐵律：CA 一旦存在就唔好重發（worker 用 NODE_EXTRA_CA_CERTS 喺 start 時快照 CA；重發 CA = worker 永遠 verify 失敗）。
 * server cert 7 日；剩 <6h 先重發（cert 重發唔影響 CA，worker 繼續 trust）。
 */
const TLS_DIR = "/tmp/e2e-push-tls";
function ensureTlsFiles(): { key: Buffer; cert: Buffer } {
  const keyPath = path.join(TLS_DIR, "server-key.pem");
  const certPath = path.join(TLS_DIR, "server.pem");
  const caPath = path.join(TLS_DIR, "ca.pem");
  const caKeyPath = path.join(TLS_DIR, "ca-key.pem");
  if (!existsSync(caPath) || !existsSync(caKeyPath)) {
    execSync(`mkdir -p ${TLS_DIR} && cd ${TLS_DIR} && openssl req -x509 -newkey rsa:2048 -keyout ca-key.pem -out ca.pem -days 30 -nodes -subj "/CN=e2e-push-test-ca" 2>/dev/null`);
  }
  const certValid = () => {
    try {
      execSync(`openssl x509 -in ${certPath} -noout -checkend 21600`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  if (!existsSync(certPath) || !existsSync(keyPath) || !certValid()) {
    execSync(`cd ${TLS_DIR} && openssl req -newkey rsa:2048 -keyout server-key.pem -out server.csr -nodes -subj "/CN=127.0.0.1" 2>/dev/null && printf "subjectAltName=IP:127.0.0.1,DNS:localhost\\n" > san.cnf && openssl x509 -req -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -out server.pem -days 7 -extfile san.cnf 2>/dev/null`);
  }
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

let server: http.Server;
let serverPort = 0;
async function startMockServer(): Promise<void> {
  const tls = ensureTlsFiles();
  const https = await import("node:https");
  server = https.createServer({ key: tls.key, cert: tls.cert }, (rq, rs) => {
    const chunks: Buffer[] = [];
    rq.on("data", (c) => chunks.push(c));
    rq.on("end", () => {
      const body = Buffer.concat(chunks);
      if (rq.method === "POST" && rq.url?.startsWith("/ep/")) {
        const status = endpointStatus[rq.url] ?? 200;
        captures.push({
          endpoint: `https://127.0.0.1:${serverPort}${rq.url}`,
          body,
          contentEncoding: String(rq.headers["content-encoding"] ?? "aesgcm"),
          cryptoKey: String(rq.headers["crypto-key"] ?? ""),
          encryption: String(rq.headers["encryption"] ?? ""),
          vapidHeader: String(rq.headers["authorization"] ?? ""),
          t: Date.now(),
        });
        rs.writeHead(status, { "content-type": "application/json" });
        rs.end("{}");
      } else {
        rs.writeHead(404);
        rs.end();
      }
    });
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  serverPort = (server.address() as { port: number }).port;
}

/**
 * 解密最近一次 capture → plaintext string
 * aes128gcm（web-push 預設）：salt + 發件人 eph pubkey（keyid）都喺 payload 內；
 *   收端只需 privateKey（ECDH）+ authSecret → 冇 Crypto-Key/Encryption header（實測）。
 * aesgcm（舊）：salt 喺 Encryption header、eph pubkey 喺 Crypto-Key: dh=。
 */
function decryptCapture(c: Capture, sub: MockSub): string {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(sub.privateKey);
  let plain: Buffer;
  if (c.contentEncoding === "aes128gcm") {
    plain = ece.decrypt(
      c.body,
      { version: "aes128gcm", privateKey: ecdh, authSecret: sub.auth },
      null
    );
  } else {
    const mDh = /^dh=([A-Za-z0-9_-]+)$/.exec(c.cryptoKey);
    const mSalt = /^salt=([A-Za-z0-9_-]+)$/.exec(c.encryption);
    if (!mDh || !mSalt) throw new Error(`aesgcm header 缺（crypto-key="${c.cryptoKey}" encryption="${c.encryption}"）`);
    plain = ece.decrypt(
      c.body,
      {
        version: "aesgcm",
        dh: mDh[1],
        salt: mSalt[1],
        privateKey: ecdh,
        authSecret: sub.auth,
      },
      null
    );
  }
  return plain.toString("utf8");
}

// ── mock subscription（P-256） ────────────────────────────────────────────
interface MockSub {
  endpoint: string;
  path: string;
  p256dh: string;
  auth: string;
  privateKey: Buffer;
}
function makeSub(token: string): MockSub {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint: `https://127.0.0.1:${serverPort}/ep/${token}`,
    path: `/ep/${token}`,
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: crypto.randomBytes(16).toString("base64url"),
    privateKey: ecdh.getPrivateKey(),
  };
}

// ── cookie / fetch helpers ───────────────────────────────────────────────
function readSession(cookieFile: string): string {
  if (!cookieFile) return "";
  const jar = readFileSync(cookieFile, "utf8");
  const line = jar.split("\n").find((l) => l.includes("wa_inbox_session"));
  return (line ?? "").trim().split(/\s+/).pop() ?? "";
}

async function api(cookieFile: string, urlPath: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const session = readSession(cookieFile);
  const res = await fetch(`${base}${urlPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `wa_inbox_session=${session}` },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await res.json().catch(() => null)) as unknown;
  return { status: res.status, json };
}

let failReason: string | null = null;
function fail(r: string): never {
  failReason = r;
  throw new Error(r);
}

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 等 mock-inbound 落咗 DB（Message.waMessageId 出現）— 證明 worker 處理咗 */
async function waitForMessage(waMessageId: string, timeoutMs = 60_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const m = await prisma.message.findFirst({ where: { waMessageId }, select: { id: true } });
    if (m) return;
    if (Date.now() - t0 > timeoutMs) fail(`worker ${timeoutMs}ms 未處理 inbound（waMessageId=${waMessageId}）`);
    await waitMs(1000);
  }
}

let msgSeq = 0;
/** 真 inbound webhook（完整 path：webhook → worker → notifyNewMessage → pushEvent） */
async function sendInbound(convWaId: string, name: string, text: string): Promise<string> {
  const wamid = `wamid.E2EPUSH_${Date.now()}_${++msgSeq}`;
  await new Promise<void>((res, rej) => {
    execFile(
      "pnpm",
      ["-s", "mock-inbound", "message", "--clinic", clinicCode, "--from", convWaId, "--text", text, "--name", name, "--wamid", wamid],
      { cwd: process.cwd(), timeout: 30_000 },
      (err) => (err ? rej(err) : res())
    );
  });
  await waitForMessage(wamid);
  return wamid;
}

/** 等指定 endpoint 新增 capture（> sinceT） */
async function waitForCapture(endpoint: string, sinceT: number, timeoutMs = 45_000): Promise<Capture> {
  const t0 = Date.now();
  for (;;) {
    const c = captures.filter((x) => x.endpoint === endpoint && x.t > sinceT).pop();
    if (c) return c;
    if (Date.now() - t0 > timeoutMs) fail(`等 ${endpoint} capture 逾時（${timeoutMs}ms；captures=${captures.length}）`);
    await waitMs(750);
  }
}

/** 負向：等一段 worker 處理時間後斷言冇新 capture */
async function assertNoCapture(endpoint: string, sinceT: number, windowMs = 10_000, what = ""): Promise<void> {
  await waitMs(windowMs);
  const n = captures.filter((x) => x.endpoint === endpoint && x.t > sinceT).length;
  if (n > 0) fail(`${what}：期望 ${endpoint} 冇 push，actual=${n}`);
}

/** subscribe（API）+ 斷言 DB row（expectStaff 空 = 唔斷言 owner — admin 用） */
async function subscribe(cookieFile: string, expectStaff: string, sub: MockSub): Promise<void> {
  const doFetch = () => api(cookieFile, "/api/push/subscribe", { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth }, userAgent: "e2e-push" });
  let r = await doFetch();
  if (r.status >= 500) {
    // dev 環境 flake（Redis lazy-reconnect / 首編譯）→ 等 2s 重試一次
    await waitMs(2000);
    r = await doFetch();
  }
  if (r.status !== 200) fail(`subscribe 失敗 status=${r.status} json=${JSON.stringify(r.json)}`);
  const row = await prisma.pushSubscription.findUnique({ where: { endpoint: sub.endpoint }, select: { staffId: true } });
  if (!row) fail("subscribe DB row 缺");
  if (expectStaff && row.staffId !== expectStaff) fail(`subscribe DB owner 錯（expected=${expectStaff} actual=${row.staffId}）`);
}

/** 清 staff 所有 sub（DB 直刪 — 冪等） */
async function clearSubs(...staffIds: string[]): Promise<void> {
  for (const id of staffIds) {
    if (id) await prisma.pushSubscription.deleteMany({ where: { staffId: id } });
  }
}

/** 讀 staff pushPrefs（DB 原值 — 還原用） */
function readPrefsRaw(staffId: string) {
  return prisma.staffUser.findUnique({ where: { id: staffId }, select: { pushPrefs: true } });
}

// ── fixture（e2e-push 專用 conversation + contact；固定 id 冪等） ─────────
const PC_CONTACT = "e2epushct1";
const PC_CONV = "e2epushcv1";
const PC2_CONTACT = "e2epushct2";
const PC2_CONV = "e2epushcv2";

async function ensureFixture(): Promise<void> {
  const c = await prisma.clinic.findUnique({ where: { id: clinic }, select: { code: true } });
  if (!c?.code) fail(`clinic 搵唔到（id=${clinic}）`);
  clinicCode = c.code;
  await prisma.conversation.deleteMany({ where: { id: { in: [PC_CONV, PC2_CONV] } } }).catch(() => {});
  await prisma.contact.deleteMany({ where: { id: { in: [PC_CONTACT, PC2_CONTACT] } } }).catch(() => {});
  await prisma.contact.create({
    data: { id: PC_CONTACT, clinicId: clinic, waId: PII_WAID, profileName: PII_NAME, labels: [] },
  });
  await prisma.contact.create({
    data: { id: PC2_CONTACT, clinicId: clinic, waId: "85291234581", profileName: "E2E Push 李四", labels: [] },
  });
  await prisma.conversation.create({
    data: { id: PC_CONV, clinicId: clinic, contactId: PC_CONTACT, status: "OPEN", lastMessageAt: new Date() },
  });
  await prisma.conversation.create({
    data: { id: PC2_CONV, clinicId: clinic, contactId: PC2_CONTACT, status: "OPEN", lastMessageAt: new Date() },
  });
}

async function cleanupFixture(): Promise<void> {
  // Message 先洗（FK）— 再 Conversation/Contact
  await prisma.message.deleteMany({ where: { conversationId: { in: [PC_CONV, PC2_CONV] } } }).catch(() => {});
  await prisma.conversation.deleteMany({ where: { id: { in: [PC_CONV, PC2_CONV] } } }).catch(() => {});
  await prisma.contact.deleteMany({ where: { id: { in: [PC_CONTACT, PC2_CONTACT] } } }).catch(() => {});
}

// ── scenarios ────────────────────────────────────────────────────────────
async function t190(): Promise<void> {
  if (!staffB || !cookieB) throw new Error("t190 要 --staff-b --cookie-b");
  const sub = makeSub("t190-b");
  await subscribe(cookieB, staffB, sub);
  const t0 = Date.now();
  await sendInbound(PII_WAID, PII_NAME, PII_TEXT);
  const cap = await waitForCapture(sub.endpoint, t0);
  // VAPID Authorization header 有（真 web-push 加密路徑）：`vapid t=<jwt>, k=<pubkey>`
  if (!cap.vapidHeader.startsWith("vapid t=") || !cap.vapidHeader.includes(", k=")) fail(`t190: VAPID Authorization header 缺（"${cap.vapidHeader.slice(0, 60)}"）`);
  // 解密 + 斷言
  let plain: string;
  try {
    plain = decryptCapture(cap, sub);
  } catch (e) {
    fail(`t190: 解密失敗（${e instanceof Error ? e.message : String(e)}）— contentEncoding=${cap.contentEncoding}`);
    return;
  }
  // 生死格：payload 只有 kind/clinicShort/conversationId
  let parsed: { kind?: string; clinicShort?: string; conversationId?: string; [k: string]: unknown };
  try {
    parsed = JSON.parse(plain) as never;
  } catch {
    fail(`t190: payload 唔係 JSON（"${plain.slice(0, 120)}"）`);
    return;
  }
  const keys = Object.keys(parsed).sort().join(",");
  if (keys !== "clinicShort,conversationId,kind") fail(`t190: payload keys 錯（expected=clinicShort,conversationId,kind actual=${keys}）`);
  if (parsed.kind !== "message") fail(`t190: kind 錯（${parsed.kind}）`);
  if (parsed.clinicShort !== clinicCode) fail(`t190: clinicShort 錯（${parsed.clinicShort}）`);
  if (parsed.conversationId !== PC_CONV) fail(`t190: conversationId 錯（${parsed.conversationId}）`);
  // 零 PII regex：canary 病人資料一律唔准出現
  if (plain.includes(PII_NAME) || plain.includes(PII_WAID) || plain.includes(PII_TEXT)) fail(`t190: push payload 含 PII: ${plain}`);
  if (!/^[\x20-\x7e]*$/.test(plain)) fail(`t190: payload 有非 ASCII（嫌疑 PII 漏出）: ${plain}`);
  console.log(`PUSH-OK: t190 payload="${plain}"`);
}

async function t191(): Promise<void> {
  if (!staffB || !staffC || !cookieB || !cookieC || !cookieAdmin) throw new Error("t191 要 B/C/admin 全套");
  const subB = makeSub("t191-b");
  const subC = makeSub("t191-c");
  const subA = makeSub("t191-admin");
  await subscribe(cookieB, staffB, subB);
  await subscribe(cookieC, staffC, subC);
  await subscribe(cookieAdmin, "", subA); // owner 由 API 認定（admin session）— 下面重讀
  const adminRow = await prisma.pushSubscription.findUnique({ where: { endpoint: subA.endpoint }, select: { staffId: true } });
  const adminId = adminRow?.staffId ?? "";

  // 原值保存（還原用）
  const adminPrefsBefore = await readPrefsRaw(adminId);
  const bPrefsBefore = await readPrefsRaw(staffB);
  const cPrefsBefore = await readPrefsRaw(staffC);
  // ★ hermetic：前面 scenario（T167 UI sync）可能已寫 B/C/admin pushPrefs 落 DB → 強制清乾淨，
  //   否則舊 mute/opt-in 污染收件人矩陣（實測：T167 mute 咗 C 嘅 TKW → P1 C 收唔到 → 45s 逾時）
  for (const id of [staffB, staffC, adminId]) {
    if (id) await prisma.staffUser.update({ where: { id }, data: { pushPrefs: Prisma.JsonNull } }).catch(() => {});
  }

  try {
    // Phase 1：未指派 → 全店 STAFF（B + C 都收）
    let t0 = Date.now();
    await sendInbound(PII_WAID, PII_NAME, "e2e-push-t191-p1");
    const capB1 = await waitForCapture(subB.endpoint, t0);
    const capC1 = await waitForCapture(subC.endpoint, t0);
    const pB1 = JSON.parse(decryptCapture(capB1, subB)) as { conversationId?: string };
    const pC1 = JSON.parse(decryptCapture(capC1, subC)) as { conversationId?: string };
    if (pB1.conversationId !== PC_CONV || pC1.conversationId !== PC_CONV) fail(`t191 P1: 未指派應全店收（B=${pB1.conversationId} C=${pC1.conversationId}）`);

    // Phase 2：已指派 → 只 B（C 靜）
    await prisma.conversation.update({ where: { id: PC_CONV }, data: { assigneeId: staffB } });
    t0 = Date.now();
    await sendInbound(PII_WAID, PII_NAME, "e2e-push-t191-p2");
    await waitForCapture(subB.endpoint, t0);
    await assertNoCapture(subC.endpoint, t0, 10_000, "t191 P2（已指派 → C 唔應收）");

    // Phase 3：ADMIN opt-in（DB pushPrefs.adminMsgClinics=[clinic]）→ 收
    let r = await api(cookieAdmin, "/api/push/prefs", { mutedClinics: [], adminMsgClinics: [clinic] });
    if (r.status !== 200) fail(`t191 P3: admin prefs 寫失敗（${r.status}）`);
    t0 = Date.now();
    await sendInbound(PII_WAID, PII_NAME, "e2e-push-t191-p3");
    const capA3 = await waitForCapture(subA.endpoint, t0);
    const pA3 = JSON.parse(decryptCapture(capA3, subA)) as { kind?: string };
    if (pA3.kind !== "message") fail(`t191 P3: admin opt-in 應收 message（kind=${pA3.kind}）`);

    // Phase 4：ADMIN opt-out（DB 改 []）→ 唔收（localStorage 無效 — DB 為準）
    r = await api(cookieAdmin, "/api/push/prefs", { mutedClinics: [], adminMsgClinics: [] });
    if (r.status !== 200) fail(`t191 P4: admin prefs 寫失敗（${r.status}）`);
    t0 = Date.now();
    await sendInbound(PII_WAID, PII_NAME, "e2e-push-t191-p4");
    await waitForCapture(subB.endpoint, t0); // 交付證明（B 照收 = 事件到咗）
    await assertNoCapture(subA.endpoint, t0, 10_000, "t191 P4（admin opt-out 後唔應收）");

    // Phase 5：mutedClinics（DB）— ★ cwi-notify-fix F-5 新語義：assignee forced 必收（P2 嘅
    //   assignee B 即使 mute 都照收 — 舊斷言已廢）；mute 只濾非 assignee →
    //   解指派 + C mute TKW 測：C 唔收；B（未 mute）照收（交付證明 + 事件到咗證明）
    await prisma.conversation.update({ where: { id: PC_CONV }, data: { assigneeId: null } });
    r = await api(cookieC, "/api/push/prefs", { mutedClinics: [clinic], adminMsgClinics: [] });
    if (r.status !== 200) fail(`t191 P5: C prefs 寫失敗（${r.status}）`);
    t0 = Date.now();
    await sendInbound(PII_WAID, PII_NAME, "e2e-push-t191-p5");
    await assertNoCapture(subC.endpoint, t0, 10_000, "t191 P5（C muted TKW 唔應收）");
    await waitForCapture(subB.endpoint, t0); // B 未 mute → 照收
  } finally {
    // 還原：prefs 原值 + 解指派 + 清 sub
    if (adminPrefsBefore) await prisma.staffUser.update({ where: { id: adminId }, data: { pushPrefs: adminPrefsBefore.pushPrefs ?? Prisma.JsonNull } }).catch(() => {});
    if (bPrefsBefore) await prisma.staffUser.update({ where: { id: staffB }, data: { pushPrefs: bPrefsBefore.pushPrefs ?? Prisma.JsonNull } }).catch(() => {});
    if (cPrefsBefore) await prisma.staffUser.update({ where: { id: staffC }, data: { pushPrefs: cPrefsBefore.pushPrefs ?? Prisma.JsonNull } }).catch(() => {});
    await prisma.conversation.update({ where: { id: PC_CONV }, data: { assigneeId: null } }).catch(() => {});
    await clearSubs(staffB, staffC, adminId);
  }
  console.log("PUSH-OK: t191 recipients（unassigned 全店 / assigned 只負責人 / ADMIN DB opt-in / muted DB）");
}

async function t192(): Promise<void> {
  if (!staffB || !cookieB) throw new Error("t192 要 --staff-b --cookie-b");
  const ok = makeSub("t192-ok");
  const gone = makeSub("t192-gone");
  const miss = makeSub("t192-miss");
  endpointStatus[ok.path] = 200;
  endpointStatus[gone.path] = 410;
  endpointStatus[miss.path] = 404;
  await subscribe(cookieB, staffB, ok);
  await subscribe(cookieB, staffB, gone);
  await subscribe(cookieB, staffB, miss);

  const t0 = Date.now();
  await sendInbound(PII_WAID, PII_NAME, "e2e-push-t192");
  await waitForCapture(ok.endpoint, t0);
  await waitForCapture(gone.endpoint, t0);
  await waitForCapture(miss.endpoint, t0);

  // 410/404 → row 刪；200 → row 留 + lastOkAt
  const rowOk = await prisma.pushSubscription.findUnique({ where: { endpoint: ok.endpoint }, select: { lastOkAt: true } });
  if (!rowOk) fail("t192: 200 row 應該保留");
  if (!rowOk.lastOkAt) fail("t192: 200 → lastOkAt 未更新");
  const rowGone = await prisma.pushSubscription.findUnique({ where: { endpoint: gone.endpoint }, select: { id: true } });
  if (rowGone) fail("t192: 410 row 應該自動刪");
  const rowMiss = await prisma.pushSubscription.findUnique({ where: { endpoint: miss.endpoint }, select: { id: true } });
  if (rowMiss) fail("t192: 404 row 應該自動刪");
  delete endpointStatus[ok.path];
  delete endpointStatus[gone.path];
  delete endpointStatus[miss.path];
  console.log("PUSH-OK: t192 410/404 自動刪 + 200 lastOkAt");
}

async function t193(): Promise<void> {
  if (!staffB || !staffC || !cookieB || !cookieC) throw new Error("t193 要 B/C 全套");
  // ★ hermetic：T167 可能已寫 C 嘅 TKW mute 落 DB（UI sync）→ 強制清，否則尾段「C 收自己 push」唔會中
  const bPrefsBefore = await readPrefsRaw(staffB);
  const cPrefsBefore = await readPrefsRaw(staffC);
  for (const id of [staffB, staffC]) {
    await prisma.staffUser.update({ where: { id }, data: { pushPrefs: Prisma.JsonNull } }).catch(() => {});
  }
  try {
    const e = makeSub("t193-e");
  await subscribe(cookieB, staffB, e);
  const nB = await prisma.pushSubscription.count({ where: { staffId: staffB } });
  if (nB !== 1) fail(`t193: B 應該有 1 sub（actual=${nB}）`);

  // 登出（server 兜底刪）
  const out = await api(cookieB, "/api/auth/logout", {});
  if (out.status !== 200) fail(`t193: logout status=${out.status}`);
  const nB2 = await prisma.pushSubscription.count({ where: { staffId: staffB } });
  if (nB2 !== 0) fail(`t193: 登出後 B 應該 0 sub（actual=${nB2}）`);

  // 登出後舊 endpoint 唔再收 B 嘅 push
  let t0 = Date.now();
  await sendInbound(PII_WAID, PII_NAME, "e2e-push-t193-a");
  await assertNoCapture(e.endpoint, t0, 10_000, "t193（登出後舊 endpoint 唔應收 B 嘅 push）");

  // 換人（C）同 endpoint 重訂閱 → ownership 轉 C → C 收自己嘅
  await subscribe(cookieC, staffC, e);
  const row = await prisma.pushSubscription.findUnique({ where: { endpoint: e.endpoint }, select: { staffId: true } });
  if (row?.staffId !== staffC) fail(`t193: endpoint ownership 應轉 C（actual=${row?.staffId ?? "null"}）`);
  t0 = Date.now();
  await sendInbound(PII_WAID, PII_NAME, "e2e-push-t193-b");
  await waitForCapture(e.endpoint, t0);
    console.log("PUSH-OK: t193 登出清 sub + endpoint 換人 ownership");
  } finally {
    if (bPrefsBefore) await prisma.staffUser.update({ where: { id: staffB }, data: { pushPrefs: bPrefsBefore.pushPrefs ?? Prisma.JsonNull } }).catch(() => {});
    if (cPrefsBefore) await prisma.staffUser.update({ where: { id: staffC }, data: { pushPrefs: cPrefsBefore.pushPrefs ?? Prisma.JsonNull } }).catch(() => {});
  }
}

function countCaptures(endpoint: string, sinceT: number): number {
  return captures.filter((c) => c.endpoint === endpoint && c.t >= sinceT).length;
}

// ── cwi-notify-fix-20260907 scenarios（T260–T264） ────────────────────────
async function t260(): Promise<void> {
  if (!staffB || !cookieB || !cookieAdmin) throw new Error("t260 要 staff-b/cookie-b/cookie-admin");
  const probe = makeSub("t260-probe");
  await subscribe(cookieAdmin, "", probe);
  const adminRow = await prisma.pushSubscription.findUnique({ where: { endpoint: probe.endpoint }, select: { staffId: true } });
  const adminId = adminRow?.staffId ?? "";
  if (!adminId) fail("t260: admin session 認定失敗");
  const bBefore = await readPrefsRaw(staffB);
  const adminBefore = await readPrefsRaw(adminId);
  try {
    // STAFF：payload 帶兩欄 → 只寫 mutedClinics（黑名單語義）；另一欄永不被寫
    let r = await api(cookieB, "/api/push/prefs", { mutedClinics: [clinic], adminMsgClinics: [clinic] });
    if (r.status !== 200) fail(`t260: STAFF prefs 寫失敗（${r.status}）`);
    const rowB = await readPrefsRaw(staffB);
    const afterB = (rowB?.pushPrefs ?? null) as Record<string, unknown> | null;
    const bMuted = Array.isArray(afterB?.mutedClinics) ? (afterB!.mutedClinics as string[]) : null;
    if (JSON.stringify(bMuted) !== JSON.stringify([clinic])) fail(`t260: STAFF mutedClinics 應=[clinic]（actual=${JSON.stringify(bMuted)}）`);
    if (afterB && "adminMsgClinics" in afterB) fail(`t260: STAFF pushPrefs 唔應該含 adminMsgClinics（actual=${JSON.stringify(afterB)}）`);
    // ADMIN：只寫 adminMsgClinics（白名單語義）
    r = await api(cookieAdmin, "/api/push/prefs", { mutedClinics: [clinic], adminMsgClinics: [clinic] });
    if (r.status !== 200) fail(`t260: ADMIN prefs 寫失敗（${r.status}）`);
    const rowA = await readPrefsRaw(adminId);
    const afterA = (rowA?.pushPrefs ?? null) as Record<string, unknown> | null;
    const aAdminMsg = Array.isArray(afterA?.adminMsgClinics) ? (afterA!.adminMsgClinics as string[]) : null;
    if (JSON.stringify(aAdminMsg) !== JSON.stringify([clinic])) fail(`t260: ADMIN adminMsgClinics 應=[clinic]（actual=${JSON.stringify(aAdminMsg)}）`);
    if (afterA && "mutedClinics" in afterA) fail(`t260: ADMIN pushPrefs 唔應該含 mutedClinics（actual=${JSON.stringify(afterA)}）`);
  } finally {
    if (bBefore) await prisma.staffUser.update({ where: { id: staffB }, data: { pushPrefs: bBefore.pushPrefs ?? Prisma.JsonNull } }).catch(() => {});
    if (adminBefore) await prisma.staffUser.update({ where: { id: adminId }, data: { pushPrefs: adminBefore.pushPrefs ?? Prisma.JsonNull } }).catch(() => {});
    await clearSubs(staffB, adminId);
  }
  console.log("PUSH-OK: t260 prefs 角色分離（STAFF→mutedClinics / ADMIN→adminMsgClinics / 另一欄不寫）");
}

async function t261(): Promise<void> {
  if (!staffB || !cookieB) throw new Error("t261 要 staff-b/cookie-b");
  const sub = makeSub("t261-b");
  await subscribe(cookieB, staffB, sub);
  const before = await readPrefsRaw(staffB);
  try {
    // 兩 array 完全相同 = 舊版盲寫整包污染（根因形狀）→ 讀取自我修復 muted 當空
    await prisma.staffUser.update({ where: { id: staffB }, data: { pushPrefs: { mutedClinics: [clinic], adminMsgClinics: [clinic] } } });
    await prisma.conversation.update({ where: { id: PC_CONV }, data: { assigneeId: null } });
    const t0 = Date.now();
    await sendInbound(PII_WAID, PII_NAME, "e2e-push-t261");
    const cap = await waitForCapture(sub.endpoint, t0); // 自我修復 → 照收
    const p = JSON.parse(decryptCapture(cap, sub)) as { kind?: string };
    if (p.kind !== "message") fail(`t261: kind 應=message（actual=${p.kind}）`);
    // worker log "push: 自我修復" warn 由 shell driver 斷言
  } finally {
    if (before) await prisma.staffUser.update({ where: { id: staffB }, data: { pushPrefs: before.pushPrefs ?? Prisma.JsonNull } }).catch(() => {});
    await prisma.conversation.update({ where: { id: PC_CONV }, data: { assigneeId: null } }).catch(() => {});
    await clearSubs(staffB);
  }
  console.log("PUSH-OK: t261 自我修復（相同 array → muted 當空 + 照收）");
}

async function t262(): Promise<void> {
  if (!staffB || !staffC || !cookieB || !cookieC) throw new Error("t262 要 B/C 全套");
  const subB = makeSub("t262-b");
  const subC = makeSub("t262-c");
  await subscribe(cookieB, staffB, subB);
  await subscribe(cookieC, staffC, subC);
  // hermetic：該店全部 active STAFF mute + 全部 ADMIN prefs 清（保還原）
  const allStaff = await prisma.staffUser.findMany({ where: { role: "STAFF", active: true, clinics: { some: { clinicId: clinic } } }, select: { id: true, pushPrefs: true } });
  const allAdmins = await prisma.staffUser.findMany({ where: { role: "ADMIN", active: true }, select: { id: true, pushPrefs: true } });
  const saved = new Map<string, Prisma.JsonValue | null>();
  for (const s of allStaff) saved.set(s.id, s.pushPrefs);
  for (const a of allAdmins) saved.set(a.id, a.pushPrefs);
  try {
    await prisma.staffUser.updateMany({ where: { id: { in: allStaff.map((s) => s.id) } }, data: { pushPrefs: { mutedClinics: [clinic] } } });
    await prisma.staffUser.updateMany({ where: { id: { in: allAdmins.map((a) => a.id) } }, data: { pushPrefs: Prisma.JsonNull } });
    await prisma.conversation.update({ where: { id: PC_CONV }, data: { assigneeId: null } });
    const t0 = Date.now();
    await sendInbound(PII_WAID, PII_NAME, "e2e-push-t262");
    await assertNoCapture(subB.endpoint, t0, 10_000, "t262 B（muted）");
    await assertNoCapture(subC.endpoint, t0, 10_000, "t262 C（muted）");
    // worker log "push: 全部收件人被 prefs 濾走" warn 由 shell driver 斷言
  } finally {
    for (const [id, p] of saved) await prisma.staffUser.update({ where: { id }, data: { pushPrefs: p ?? Prisma.JsonNull } }).catch(() => {});
    await clearSubs(staffB, staffC);
  }
  console.log("PUSH-OK: t262 全濾走（全部 mute → 零推送）");
}

async function t263(): Promise<void> {
  if (!staffB || !cookieB || !cookieAdmin) throw new Error("t263 要 staff-b/cookie-b/cookie-admin");
  const subB = makeSub("t263-b");
  const subA = makeSub("t263-admin");
  await subscribe(cookieB, staffB, subB);
  await subscribe(cookieAdmin, "", subA);
  const adminRow = await prisma.pushSubscription.findUnique({ where: { endpoint: subA.endpoint }, select: { staffId: true } });
  const adminId = adminRow?.staffId ?? "";
  if (!adminId) fail("t263: admin session 認定失敗");
  const bBefore = await readPrefsRaw(staffB);
  const adminBefore = await readPrefsRaw(adminId);
  try {
    // Part A：assignee = B + B mute 該店 → forced 必收（F-5）
    await prisma.conversation.update({ where: { id: PC_CONV }, data: { assigneeId: staffB } });
    await prisma.staffUser.update({ where: { id: staffB }, data: { pushPrefs: { mutedClinics: [clinic] } } });
    let t0 = Date.now();
    await sendInbound(PII_WAID, PII_NAME, "e2e-push-t263-a");
    await waitForCapture(subB.endpoint, t0); // forced 照收
    // Part B：assignee = ADMIN + adminMsgClinics 含該店 → Map 去重只收 1 次（舊碼 = 2 次）
    await prisma.staffUser.update({ where: { id: adminId }, data: { pushPrefs: { adminMsgClinics: [clinic] } } });
    await prisma.conversation.update({ where: { id: PC_CONV }, data: { assigneeId: adminId } });
    t0 = Date.now();
    await sendInbound(PII_WAID, PII_NAME, "e2e-push-t263-b");
    await waitForCapture(subA.endpoint, t0);
    await waitMs(10_000); // 等夠窗 → 若舊碼雙推，第二條必喺此窗內
    const n = countCaptures(subA.endpoint, t0);
    if (n !== 1) fail(`t263: ADMIN 做 assignee 應去重收 1 次（actual=${n}）`);
  } finally {
    if (bBefore) await prisma.staffUser.update({ where: { id: staffB }, data: { pushPrefs: bBefore.pushPrefs ?? Prisma.JsonNull } }).catch(() => {});
    if (adminBefore) await prisma.staffUser.update({ where: { id: adminId }, data: { pushPrefs: adminBefore.pushPrefs ?? Prisma.JsonNull } }).catch(() => {});
    await prisma.conversation.update({ where: { id: PC_CONV }, data: { assigneeId: null } }).catch(() => {});
    await clearSubs(staffB, adminId);
  }
  console.log("PUSH-OK: t263 assignee 靜音照收（forced）+ ADMIN assignee 去重（=1）");
}

async function t264(): Promise<void> {
  if (!staffB || !cookieB) throw new Error("t264 要 staff-b/cookie-b");
  const before = await readPrefsRaw(staffB);
  const sub = makeSub("t264-b");
  try {
    // (1) 冇裝置訂閱
    await prisma.staffUser.update({ where: { id: staffB }, data: { pushPrefs: Prisma.JsonNull } });
    let r = await api(cookieB, "/api/push/test", { clinicId: clinic });
    let d = r.json as { result?: string; count?: number; reason?: string };
    if (r.status !== 200 || d?.result !== "no-subscription") fail(`t264 no-sub: 期望 no-subscription（actual=${r.status} ${JSON.stringify(d)}）`);
    // (2) 已推送 1 部裝置（mock 200）
    await subscribe(cookieB, staffB, sub);
    r = await api(cookieB, "/api/push/test", { clinicId: clinic });
    d = r.json as { result?: string; count?: number };
    if (r.status !== 200 || d?.result !== "pushed" || d?.count !== 1) fail(`t264 pushed: 期望 pushed/1（actual=${r.status} ${JSON.stringify(d)}）`);
    // (3) 推送失敗（mock 500 → reason）
    endpointStatus[sub.path] = 500;
    r = await api(cookieB, "/api/push/test", { clinicId: clinic });
    d = r.json as { result?: string; reason?: string };
    if (r.status !== 200 || d?.result !== "failed" || !d?.reason) fail(`t264 failed: 期望 failed+reason（actual=${r.status} ${JSON.stringify(d)}）`);
    delete endpointStatus[sub.path];
    // (4) 呢間店被你靜音咗
    await prisma.staffUser.update({ where: { id: staffB }, data: { pushPrefs: { mutedClinics: [clinic] } } });
    r = await api(cookieB, "/api/push/test", { clinicId: clinic });
    d = r.json as { result?: string };
    if (r.status !== 200 || d?.result !== "muted") fail(`t264 muted: 期望 muted（actual=${r.status} ${JSON.stringify(d)}）`);
  } finally {
    delete endpointStatus[sub.path];
    if (before) await prisma.staffUser.update({ where: { id: staffB }, data: { pushPrefs: before.pushPrefs ?? Prisma.JsonNull } }).catch(() => {});
    await clearSubs(staffB);
  }
  console.log("PUSH-OK: t264 /api/push/test 四種結果（no-subscription/pushed/failed/muted）");
}

// Prisma Json null（pushPrefs 還原）
async function main(): Promise<void> {
  await startMockServer();
  await ensureFixture();
  try {
    if (scenario === "t190") await t190();
    else if (scenario === "t191") await t191();
    else if (scenario === "t192") await t192();
    else if (scenario === "t193") await t193();
    else if (scenario === "t260") await t260();
    else if (scenario === "t261") await t261();
    else if (scenario === "t262") await t262();
    else if (scenario === "t263") await t263();
    else if (scenario === "t264") await t264();
    else throw new Error(`unknown scenario: ${scenario}`);
  } catch (e) {
    const r = e instanceof Error ? e.message : String(e);
    console.log(`PUSH-FAIL: ${failReason ?? r}`);
    process.exitCode = 1;
  } finally {
    if (staffB) await clearSubs(staffB);
    if (staffC) await clearSubs(staffC);
    await cleanupFixture();
    server?.close();
    await prisma.$disconnect();
  }
}

void main();

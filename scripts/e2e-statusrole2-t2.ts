/**
 * cwi-statusrole2-20260910 T2 — e2e：已解決翻開四聯動 + 3 日自動解決（三守門）+ SUPERVISOR 權限缺口
 *
 * 覆蓋（MD §6）：
 * - T242：RESOLVED + inbound → OPEN + reopenedAt + badge 資料；原負責人保留；audit CONVERSATION_REOPENED
 * - T243：負責人已停用 → 跌公海（assigneeId=null）+ 公海計數 +1
 * - T244：auto-resolve 守門 — 病人最後一句未覆 → 唔關；近期活動 → 唔關；null 保守 → 唔關；
 *         全達標 → RESOLVED + resolvedBy=AUTO + INTERNAL 備註 + 唔 push
 *   （SCHEDULED followup / active ConsultSession 守門：本 repo 無 model → vacuously true — 缺口記錄 Kairo）
 * - T245：翻開聯動 — routing 保留（routedGroupId/routedStaffId）、escalatedAt 清 null、負責人保留
 *   （EXPIRED consult <7 日復活 / ≥7 日開新：無 ConsultSession model — 缺口記錄 Kairo）
 * - T246：SUPERVISOR — /api/conversations 200 全店 / notes 200 / send/assign/adopt 403 / admin/* 403 / AI 級別 200
 * - T247：SUPERVISOR 有 socket room（message:new 實時）；通知預設靜音 → opt-in 之後收到
 *
 * 截圖（≥3）：
 *  1 /tmp/kairo-statusrole2-t2-1-reopen-badge.png   — 翻開 badge「↻ 重新開啟」
 *  2 /tmp/kairo-statusrole2-t2-2-autoresolve-note.png — auto-resolve INTERNAL 備註 + 已解決
 *  3 /tmp/kairo-statusrole2-t2-3-supervisor-inbox.png  — SUPERVISOR inbox 唯讀
 *  4 /tmp/kairo-statusrole2-t2-4-supervisor-admin.png  — SUPERVISOR /admin 側欄（設定類隱藏）
 *
 * 前置：dev stack live（server 3100 + worker + DB 15432 + Redis）
 * 用法（repo root）：pnpm tsx scripts/e2e-statusrole2-t2.ts
 * 輸出：STATUSROLE2-T2-OK / STATUSROLE2-T2-FAIL: <reason>
 * fixture：`sr2t2` 前綴 id + email — 段尾 hermetic sweep（assert 零殘留）
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createHmac } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { runAutoResolveSweep, shouldAutoResolve } from "../src/lib/auto-resolve";

const REPO = path.join(import.meta.dirname, "..");
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:3100";
// tsx 唔自動載 .env（Node 22 內置 loadEnvFile — 照 mock-inbound.ts 慣例）
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* 靠 process env */
}
const WA_APP_SECRET = process.env.WA_APP_SECRET ?? "";
const prisma = new PrismaClient();

function ok(label: string): void {
  console.log(`  ✅ ${label}`);
}
function fail(label: string, detail?: unknown): never {
  console.error(`  ❌ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  throw new Error(label);
}
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) ok(label);
  else fail(label, detail);
}

// ── fixtures（id 全部 cuid 形：20+ lowercase alnum — normalizeRoute 鐵律）──
const FIX = {
  supEmail: "sr2t2-supervisor@wa-clinic.local",
  supPassword: "Sr2t2-Sup-Passw0rd!x",
  disEmail: "sr2t2-disabled@wa-clinic.local",
  disPassword: "Sr2t2-Dis-Passw0rd!x",
  groupCode: "SR2T2",
  contactPrefix: "sr2t2c",
  convPrefix: "sr2t2conv",
  conv: {
    reopen: "sr2t2convreopen000000001", // T242：RESOLVED + active 負責人 → 翻開保留
    drop: "sr2t2convdrop00000000002", // T243：RESOLVED + 停用負責人 → 跌公海
    route: "sr2t2convroute00000000003", // T245：RESOLVED + routing + escalatedAt → 聯動
    push: "sr2t2convpush00000000004", // T247：OPEN 已指派（socket + push 通知路徑）
    ar1: "sr2t2convar1000000000005", // T244 守門②：未覆 → 唔關
    ar2: "sr2t2convar2000000000006", // T244 守門①：近期活動 → 唔關
    ar3: "sr2t2convar3000000000007", // T244 全達標 → 自動 RESOLVED
    ar4: "sr2t2convar4000000000008", // T244 null 保守 → 唔關
  },
};

interface Ctx {
  tkwId: string;
  staffTkwId: string;
  supId: string;
  disId: string;
  groupId: string;
  supvId: string;
  ruleId: string;
}

async function setupFixtures(): Promise<Ctx> {
  const tkw = await prisma.clinic.findFirst({ where: { code: "TKW" } });
  if (!tkw) fail("clinic TKW 搵唔到");
  const staffTkw = await prisma.staffUser.findFirst({ where: { email: "staff-tkw@wa-clinic.local" } });
  if (!staffTkw) fail("staff-tkw 搵唔到");

  // SUPERVISOR（全店 — clinicId null）
  let sup = await prisma.staffUser.findUnique({ where: { email: FIX.supEmail } });
  if (!sup) {
    sup = await prisma.staffUser.create({
      data: {
        email: FIX.supEmail,
        passwordHash: await argon2.hash(FIX.supPassword),
        name: "SR2T2 E2E Supervisor",
        role: "SUPERVISOR",
      },
    });
  }
  // 停用 STAFF（T243 跌公海場景）
  let dis = await prisma.staffUser.findUnique({ where: { email: FIX.disEmail } });
  if (!dis) {
    dis = await prisma.staffUser.create({
      data: {
        email: FIX.disEmail,
        passwordHash: await argon2.hash(FIX.disPassword),
        name: "SR2T2 Disabled",
        role: "STAFF",
        clinicId: tkw.id,
        active: false,
      },
    });
  }
  let grp = await prisma.skillGroup.findUnique({ where: { code: FIX.groupCode } });
  if (!grp) grp = await prisma.skillGroup.create({ data: { name: "SR2T2 測試組", code: FIX.groupCode } });

  const days = (n: number): number => Date.now() - n * 86_400_000;

  const mkContact = async (key: string, waId: string, name: string): Promise<string> => {
    const id = `${FIX.contactPrefix}${key}000000`.slice(0, 24);
    const existing = await prisma.contact.findFirst({ where: { id } });
    if (existing) return existing.id;
    return (await prisma.contact.create({ data: { id, clinicId: tkw.id, waId, profileName: name, labels: [] } })).id;
  };
  const mkConv = async (id: string, contactId: string, extra: Record<string, unknown>): Promise<void> => {
    const existing = await prisma.conversation.findUnique({ where: { id } });
    if (existing) return;
    const now = new Date();
    await prisma.conversation.create({
      data: { id, clinicId: tkw.id, contactId, lastMessageAt: now, ...extra },
    });
  };

  const cA = await mkContact("a", "85299020001", "SR2T2 Reopen");
  const cB = await mkContact("b", "85299020002", "SR2T2 Drop");
  const cC = await mkContact("c", "85299020003", "SR2T2 Route");
  const cP = await mkContact("p", "85299020004", "SR2T2 Push");
  const c1 = await mkContact("1", "85299020005", "SR2T2 AR1");
  const c2 = await mkContact("2", "85299020006", "SR2T2 AR2");
  const c3 = await mkContact("3", "85299020007", "SR2T2 AR3");
  const c4 = await mkContact("4", "85299020008", "SR2T2 AR4");

  await mkConv(FIX.conv.reopen, cA, {
    status: "RESOLVED",
    assigneeId: staffTkw.id,
    resolvedBy: "STAFF",
    resolvedAt: new Date(days(2)),
    lastInboundAt: new Date(days(2)),
    lastOutboundAt: new Date(days(2) + 3_600_000),
  });
  await mkConv(FIX.conv.drop, cB, {
    status: "RESOLVED",
    assigneeId: dis.id,
    resolvedAt: new Date(days(2)),
    lastInboundAt: new Date(days(2)),
    lastOutboundAt: new Date(days(2) + 3_600_000),
  });
  // T245：routedRuleId 必 seed 真值（路由引擎 re-mark 閘 = routedRuleId null OR status RESOLVED；
  //        有值 + 已翻開 OPEN → 引擎 skip → 可斷「翻開不清 routing」）
  const rule = await prisma.routingRule.findFirst({ where: { clinicId: tkw.id, enabled: true } });
  const ruleId = rule?.id ?? "sr2t2ruleplaceholder000001";
  const supvGrp = (await prisma.skillGroup.findFirst({ where: { code: "SUPV" } })) ?? grp;
  await mkConv(FIX.conv.route, cC, {
    status: "RESOLVED",
    assigneeId: staffTkw.id,
    routedGroupId: supvGrp.id,
    routedStaffId: staffTkw.id,
    routedRuleId: ruleId,
    routedAt: new Date(days(2)),
    escalatedAt: new Date(days(1)),
    resolvedAt: new Date(days(2)),
    lastInboundAt: new Date(days(2)),
    lastOutboundAt: new Date(days(2) + 3_600_000),
  });
  await mkConv(FIX.conv.push, cP, {
    assigneeId: staffTkw.id,
    lastInboundAt: new Date(days(1)),
    lastOutboundAt: new Date(days(1) + 3_600_000),
  });
  // T244 守門矩阵（全部 OPEN；N=3 日 default）
  await mkConv(FIX.conv.ar1, c1, {
    lastMessageAt: new Date(days(4)),
    lastInboundAt: new Date(days(4)),
    lastOutboundAt: new Date(days(4) - 7_200_000), // 病人最後一句未覆
  });
  await mkConv(FIX.conv.ar2, c2, {
    lastMessageAt: new Date(Date.now() - 3_600_000), // 近期活動（1h）
    lastInboundAt: new Date(days(2)),
    lastOutboundAt: new Date(days(2) + 3_600_000),
  });
  await mkConv(FIX.conv.ar3, c3, {
    lastMessageAt: new Date(days(4)),
    lastInboundAt: new Date(days(4)),
    lastOutboundAt: new Date(days(4) + 3_600_000), // 已覆 + 靜音 4 日
  });
  await mkConv(FIX.conv.ar4, c4, {
    lastMessageAt: new Date(days(4)),
    lastOutboundAt: new Date(days(4)), // lastInboundAt=null → 保守唔關
  });

  return { tkwId: tkw.id, staffTkwId: staffTkw.id, supId: sup!.id, disId: dis!.id, groupId: grp.id, supvId: supvGrp.id, ruleId };
}

// ── sweep（hermetic：零殘留）─────────────────────────────────────────────
async function sweep(): Promise<void> {
  const convs = await prisma.conversation.findMany({ where: { id: { startsWith: FIX.convPrefix } }, select: { id: true } });
  const convIds = convs.map((c) => c.id);
  if (convIds.length > 0) {
    // Message.conversationId 係裸 scalar（無 Prisma relation / cascade）— 必須先刪訊息，否則 waMessageId 殘留令重跑撞冪等 key
    await prisma.message.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.aiDraft.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.bookingRequest.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.staffNotice.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.conversation.deleteMany({ where: { id: { in: convIds } } });
  }
  await prisma.webhookEvent.deleteMany({ where: { id: { startsWith: "messages:wamid.SR2T2" } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { startsWith: FIX.convPrefix } } });
  const contacts = await prisma.contact.findMany({ where: { id: { startsWith: FIX.contactPrefix } } });
  if (contacts.length > 0) await prisma.contact.deleteMany({ where: { id: { startsWith: FIX.contactPrefix } } });
  const grp = await prisma.skillGroup.findUnique({ where: { code: FIX.groupCode } });
  if (grp) {
    await prisma.skillGroupMember.deleteMany({ where: { groupId: grp.id } });
    await prisma.skillGroup.delete({ where: { id: grp.id } });
  }
  const sup = await prisma.staffUser.findUnique({ where: { email: FIX.supEmail } });
  if (sup) {
    await prisma.pushSubscription.deleteMany({ where: { staffId: sup.id } });
    await prisma.staffUser.delete({ where: { id: sup.id } });
  }
  const dis = await prisma.staffUser.findUnique({ where: { email: FIX.disEmail } });
  if (dis) await prisma.staffUser.delete({ where: { id: dis.id } });
  const left =
    (await prisma.conversation.count({ where: { id: { startsWith: FIX.convPrefix } } })) +
    (await prisma.message.count({ where: { conversationId: { startsWith: FIX.convPrefix } } })) +
    (await prisma.contact.count({ where: { id: { startsWith: FIX.contactPrefix } } })) +
    (await prisma.skillGroup.count({ where: { code: FIX.groupCode } })) +
    (await prisma.staffUser.count({ where: { email: { in: [FIX.supEmail, FIX.disEmail] } } }));
  check("fixture sweep 零殘留", left === 0, left);
}

// ── API helpers ───────────────────────────────────────────────────────────
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
// login 限流 5 次/60s/IP — cookie 重用（/tmp cache；key 必帶 userId 防 stale session）
const COOKIE_CACHE = "/tmp/w-statusrole2-e2e-cookies.json";
async function cookieFor(email: string, password: string, cacheKey?: string): Promise<string> {
  const key = cacheKey ?? email;
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
    /* first */
  }
  next[key] = c;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(COOKIE_CACHE, JSON.stringify(next));
  return c;
}
async function api(
  cookie: string,
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method: init?.method ?? "GET",
    headers: { cookie: `wa_inbox_session=${cookie}`, ...(init?.body ? { "content-type": "application/json" } : {}) },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ── mock webhook（照 mock-inbound.ts：HMAC-SHA256 簽名）─────────────────
interface ClinicRow {
  id: string;
  waPhoneNumberId: string;
  waDisplayNumber: string | null;
}
async function mockInboundMessage(clinic: ClinicRow, wamid: string, waId: string, text: string, name: string): Promise<void> {
  const bizNumber = (clinic.waDisplayNumber ?? "").replace(/\D/g, "");
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: clinic.waPhoneNumberId,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: bizNumber, phone_number_id: clinic.waPhoneNumberId },
              contacts: [{ profile: { name }, wa_id: waId }],
              messages: [{ from: waId, id: wamid, timestamp: Math.floor(Date.now() / 1000).toString(), type: "text", text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  const signature = "sha256=" + createHmac("sha256", WA_APP_SECRET).update(raw).digest("hex");
  const res = await fetch(`${BASE}/api/wa/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hub-signature-256": signature },
    body: raw,
  });
  if (res.status !== 200) throw new Error(`webhook ${wamid} → HTTP ${res.status}: ${await res.text().catch(() => "")}`);
}

async function waitForDb(label: string, fn: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeoutMs) fail(`${label} — timeout ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ── fake push endpoint（web-push 永遠 https.request → 必須 HTTPS mock + 本地 CA）
// 照 e2e-push.ts 慣例：/tmp/e2e-push-tls/ CA 持久（worker 用 NODE_EXTRA_CA_CERTS 起機快照；CA 唔好重發）
import { createECDH, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

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
    execSync(`cd ${TLS_DIR} && openssl req -newkey rsa:2048 -keyout server-key.pem -out server.csr -nodes -subj "/CN=127.0.0.1" 2>/dev/null && printf "subjectAltName=IP:127.0.0.1,DNS:localhost\\n" > san.cnf && openssl x509 -req -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -out server.pem -days 7 -extfile san.cnf 2>/dev/null`);
  }
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

interface PushHit {
  url: string;
  body: string;
  at: number;
}
async function startFakePushServer(): Promise<{ server: http.Server; endpoint: string; hits: PushHit[] }> {
  const hits: PushHit[] = [];
  const { key, cert } = ensureTlsFiles();
  const https = await import("node:https");
  const server = https.createServer({ key, cert }, (req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      hits.push({ url: req.url ?? "", body: b, at: Date.now() });
      res.writeHead(200).end("ok");
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, endpoint: `https://127.0.0.1:${port}/mock-sub`, hits });
    })
  );
}
function makePushKeys(): { p256dh: string; auth: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
}

// ── T242：已解決翻開（負責人 active 保留）────────────────────────────────
async function t242(tkw: ClinicRow, ctx: Ctx): Promise<void> {
  console.log("\n[T242] RESOLVED + inbound → OPEN + reopenedAt + 原負責人保留");
  await mockInboundMessage(tkw, "wamid.SR2T2T242", "85299020001", "e2e 我仲有問題想問", "SR2T2 Reopen");
  await waitForDb("T242 reopen commit", async () => {
    const c = await prisma.conversation.findUnique({ where: { id: FIX.conv.reopen } });
    return c?.status === "OPEN" && c.reopenedAt != null;
  });
  const c = await prisma.conversation.findUnique({ where: { id: FIX.conv.reopen } });
  check("T242 status → OPEN", c?.status === "OPEN", c?.status);
  check("T242 reopenedAt 已寫", c?.reopenedAt != null);
  check("T242 原負責人保留（staff-tkw）", c?.assigneeId === ctx.staffTkwId, c?.assigneeId);
  check("T242 resolvedAt/resolvedBy 清 null", c?.resolvedAt == null && c?.resolvedBy == null);
  const audit = await prisma.auditLog.count({
    where: { action: "CONVERSATION_REOPENED", entityId: FIX.conv.reopen },
  });
  check("T242 audit CONVERSATION_REOPENED 恰 1", audit === 1, audit);
  const row = await prisma.auditLog.findFirst({ where: { action: "CONVERSATION_REOPENED", entityId: FIX.conv.reopen } });
  const meta = (row?.meta ?? {}) as Record<string, unknown>;
  check("T242 audit meta 零 PII（prevAssigneeId/assigneeKept 有值）", meta.prevAssigneeId === ctx.staffTkwId && meta.assigneeKept === true, meta);
}

// ── T243：負責人已停用 → 跌公海 + 公海計數 +1 ─────────────────────────────
async function t243(tkw: ClinicRow, tkwCookie: string, ctx: Ctx): Promise<void> {
  console.log("\n[T243] 負責人已停用 → 跌公海 + 公海計數 +1");
  const before = await api(tkwCookie, "/api/conversations?counts=1");
  const beforeCounts = (before.body as { counts?: { unassigned: number } })?.counts;
  if (!beforeCounts) fail("T243 baseline counts 缺失", before.body);
  await mockInboundMessage(tkw, "wamid.SR2T2T243", "85299020002", "e2e 跌公海測試", "SR2T2 Drop");
  await waitForDb("T243 reopen commit", async () => {
    const c = await prisma.conversation.findUnique({ where: { id: FIX.conv.drop } });
    return c?.status === "OPEN" && c.assigneeId == null;
  });
  const c = await prisma.conversation.findUnique({ where: { id: FIX.conv.drop } });
  check("T243 status → OPEN", c?.status === "OPEN", c?.status);
  check("T243 停用負責人 → 跌公海（assigneeId null）", c?.assigneeId == null, c?.assigneeId);
  check("T243 reopenedAt 已寫", c?.reopenedAt != null);
  await new Promise((r) => setTimeout(r, 500));
  const after = await api(tkwCookie, "/api/conversations?counts=1");
  const afterCounts = (after.body as { counts?: { unassigned: number } })?.counts;
  check("T243 公海計數 +1", afterCounts?.unassigned === beforeCounts.unassigned + 1, {
    before: beforeCounts.unassigned,
    after: afterCounts?.unassigned,
  });
}

// ── T245：翻開聯動 — routing 保留 + escalatedAt 清 ────────────────────────
async function t245(tkw: ClinicRow, ctx: Ctx): Promise<void> {
  console.log("\n[T245] 翻開聯動：routing 保留、escalatedAt 清空、負責人保留");
  await mockInboundMessage(tkw, "wamid.SR2T2T245", "85299020003", "e2e 投訴翻開測試", "SR2T2 Route");
  await waitForDb("T245 reopen commit", async () => {
    const c = await prisma.conversation.findUnique({ where: { id: FIX.conv.route } });
    return c?.status === "OPEN" && c.reopenedAt != null;
  });
  const c = await prisma.conversation.findUnique({ where: { id: FIX.conv.route } });
  // 路由引擎 re-mark 閘（routedRuleId 有值 + OPEN）→ 引擎 skip；斷言 = 翻開路徑冇清 routing
  check("T245 routedGroupId 保留", c?.routedGroupId === ctx.supvId, { got: c?.routedGroupId, want: ctx.supvId });
  check("T245 routedStaffId 保留", c?.routedStaffId === ctx.staffTkwId, c?.routedStaffId);
  check("T245 routedRuleId 保留", c?.routedRuleId === ctx.ruleId, c?.routedRuleId);
  check("T245 escalatedAt 清 null（容許重新計時）", c?.escalatedAt == null, c?.escalatedAt);
  check("T245 負責人保留", c?.assigneeId === ctx.staffTkwId);
  // consult/followup 聯動：本 repo 無 ConsultSession/FollowupTask model → 無 row 可斷言（缺口記錄 Kairo）
  ok("T245 consult 復活 / followup COMPLETED — 無 model（vacuous；掛鉤點喺 touchConversation reopen 註釋）");
}

// ── T244：auto-resolve 三守門 ─────────────────────────────────────────────
async function t244(ctx: Ctx): Promise<void> {
  console.log("\n[T244] auto-resolve 守門（N=3 日 default）");
  // 純函數守門單測（deterministic）
  const now = new Date();
  const d = (h: number) => new Date(now.getTime() - h * 3_600_000);
  const base = { id: "x", clinicId: ctx.tkwId, lastMessageAt: d(96) };
  check("守門②：未覆（lastInbound > lastOutbound）→ false", shouldAutoResolve({ ...base, lastInboundAt: d(90), lastOutboundAt: d(96) }, 3, now) === false);
  check("守門①：靜音不足（lastMessageAt 新）→ false", shouldAutoResolve({ ...base, lastMessageAt: d(1), lastInboundAt: d(96), lastOutboundAt: d(95) }, 3, now) === false);
  check("守門 null：lastInboundAt=null → false（保守）", shouldAutoResolve({ ...base, lastInboundAt: null, lastOutboundAt: d(95) }, 3, now) === false);
  check("全達標 → true", shouldAutoResolve({ ...base, lastInboundAt: d(96), lastOutboundAt: d(95) }, 3, now) === true);

  const r = await runAutoResolveSweep(now);
  ok(`sweep 完成：checked=${r.checked} resolved=${r.resolved} failed=${r.failed}`);
  check("sweep 零失敗", r.failed === 0, r);

  const ar3 = await prisma.conversation.findUnique({ where: { id: FIX.conv.ar3 } });
  check("AR3 全達標 → RESOLVED", ar3?.status === "RESOLVED", ar3?.status);
  check("AR3 resolvedBy = AUTO", ar3?.resolvedBy === "AUTO", ar3?.resolvedBy);
  check("AR3 resolvedAt 已寫", ar3?.resolvedAt != null);
  const note = await prisma.message.findFirst({
    where: { conversationId: FIX.conv.ar3, channel: "INTERNAL", type: "note" },
  });
  check("AR3 INTERNAL 備註落（系統自動標記已解決）", note?.body?.startsWith("系統自動標記已解決") === true, note?.body);
  check("AR3 備註 = 系統動作（sentByStaffId null）", note?.sentByStaffId == null);

  const ar1 = await prisma.conversation.findUnique({ where: { id: FIX.conv.ar1 } });
  const ar2 = await prisma.conversation.findUnique({ where: { id: FIX.conv.ar2 } });
  const ar4 = await prisma.conversation.findUnique({ where: { id: FIX.conv.ar4 } });
  check("AR1 未覆 → 保持 OPEN", ar1?.status === "OPEN", ar1?.status);
  check("AR2 近期活動 → 保持 OPEN", ar2?.status === "OPEN", ar2?.status);
  check("AR4 null 保守 → 保持 OPEN", ar4?.status === "OPEN", ar4?.status);

  // followup/consult 守門：本 repo 無 model → vacuously true（缺口記錄 Kairo）
  ok("守門③④：無 FollowupTask/ConsultSession model → vacuous（掛鉤點喺 shouldAutoResolve 註釋）");
}

// ── T246：SUPERVISOR 權限邊界 ─────────────────────────────────────────────
async function t246(supCookie: string, ctx: Ctx): Promise<void> {
  console.log("\n[T246] SUPERVISOR：讀 200 / 寫 403 / admin 403 / AI 級別 200");
  // 讀：全店
  const list = await api(supCookie, "/api/conversations?counts=1");
  check("GET /api/conversations 200", list.status === 200, list.status);
  const items = (list.body as { items?: { clinicId: string }[] })?.items ?? [];
  const clinics = new Set(items.map((i) => i.clinicId));
  // 動態基準：DB 有對話嘅 clinic 必須全部喺 SUPERVISOR 列表（全店唯讀）
  const dbClinicIds = await prisma.conversation.groupBy({ by: ["clinicId"], _count: true });
  const expected = new Set(dbClinicIds.map((g) => g.clinicId));
  const missing = [...expected].filter((id) => !clinics.has(id));
  check("SUPERVISOR 全店可見（DB 有對話嘅 clinic 全部喺列表）", missing.length === 0, { missing, got: clinics.size });
  // 寫：notes 准
  const note = await api(supCookie, `/api/conversations/${FIX.conv.push}/notes`, { method: "POST", body: { body: "e2e supervisor 觀察備註" } });
  check("POST notes 201（可寫內部備註）", note.status === 201 || note.status === 200, note.status);
  const noteRow = await prisma.message.count({
    where: { conversationId: FIX.conv.push, channel: "INTERNAL", body: "e2e supervisor 觀察備註" },
  });
  check("SUPERVISOR note 落庫（INTERNAL）", noteRow >= 1, noteRow);
  // 寫：send / assign / adopt / status → 403
  const send = await api(supCookie, "/api/messages/send", { method: "POST", body: { conversationId: FIX.conv.push, body: "e2e" } });
  check("POST /api/messages/send 403", send.status === 403, send.status);
  const assign = await api(supCookie, `/api/conversations/${FIX.conv.push}/assign`, { method: "POST", body: { toStaffId: ctx.staffTkwId } });
  check("POST /assign 403", assign.status === 403, assign.status);
  const adopt = await api(supCookie, `/api/conversations/${FIX.conv.push}/drafts/fake1234567890abcdefg`, { method: "PATCH", body: { draftText: "x" } });
  check("PATCH drafts/adopt 403", adopt.status === 403, adopt.status);
  const patchStatus = await api(supCookie, `/api/conversations/${FIX.conv.push}`, { method: "PATCH", body: { status: "RESOLVED" } });
  check("PATCH conversations status 403", patchStatus.status === 403, patchStatus.status);
  // admin 設定類 → 403
  const staff = await api(supCookie, "/api/admin/staff");
  check("GET /api/admin/staff 403", staff.status === 403, staff.status);
  const mkStaff = await api(supCookie, "/api/admin/staff", { method: "POST", body: { name: "X", email: "x@x.local", role: "STAFF", clinicId: ctx.tkwId, password: "X-password-123" } });
  check("POST /api/admin/staff 403（唔可開帳號）", mkStaff.status === 403, mkStaff.status);
  // AI 級別 → 200（ADMIN ∨ SUPERVISOR；audit 記 role）
  const policyBefore = await prisma.automationPolicy.findUnique({ where: { clinicId_category: { clinicId: ctx.tkwId, category: "QUESTION" } } });
  const aiPatch = await api(supCookie, "/api/admin/automation", { method: "PATCH", body: { clinicId: ctx.tkwId, category: "QUESTION", level: "L1" } });
  check("PATCH /api/admin/automation 200（AI 級別讀寫）", aiPatch.status === 200, aiPatch.status);
  const aiAudit = await prisma.auditLog.findFirst({
    where: { action: "SET_AUTOMATION_LEVEL", entityId: ctx.tkwId },
    orderBy: { createdAt: "desc" },
  });
  const aiMeta = (aiAudit?.meta ?? {}) as Record<string, unknown>;
  check("AI 級別 audit 記 role=SUPERVISOR", aiMeta.role === "SUPERVISOR", aiMeta);
  // 還原
  if (policyBefore) {
    await api(supCookie, "/api/admin/automation", { method: "PATCH", body: { clinicId: ctx.tkwId, category: "QUESTION", level: policyBefore.level } });
  } else {
    await prisma.automationPolicy.deleteMany({ where: { clinicId: ctx.tkwId, category: "QUESTION" } });
  }
}

// ── T247：SUPERVISOR socket room + 通知預設靜音/opt-in ────────────────────
async function t247(tkw: ClinicRow, supCookie: string, pushServer: Awaited<ReturnType<typeof startFakePushServer>>, ctx: Ctx): Promise<void> {
  console.log("\n[T247] SUPERVISOR socket room + 通知預設靜音 → opt-in 收到");
  /* eslint-disable @typescript-eslint/no-require-imports -- repo 慣例 */
  const { io } = require("socket.io-client") as { io: (url: string, opts: Record<string, unknown>) => SocketLike };
  interface SocketLike {
    on: (ev: string, cb: (...args: unknown[]) => void) => void;
    close: () => void;
  }
  const events: Record<string, unknown>[] = [];
  const socket = io(BASE, {
    extraHeaders: { Cookie: `wa_inbox_session=${supCookie}` },
    transports: ["websocket"],
    timeout: 10_000,
  });
  socket.on("message:new", (e: unknown) => events.push(e as Record<string, unknown>));
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("T247 socket connect timeout")), 15_000);
    socket.on("connect", () => {
      clearTimeout(t);
      resolve();
    });
    socket.on("connect_error", (err: unknown) => {
      clearTimeout(t);
      reject(new Error(`T247 socket connect_error: ${String(err)}`));
    });
  });
  ok("T247 SUPERVISOR socket 已連（authenticated）");

  // ① 預設靜音：push 0 收（pushPrefs 無 adminMsgClinics）
  const hitsBefore = pushServer.hits.length;
  await mockInboundMessage(tkw, "wamid.SR2T2T247A", "85299020004", "e2e 靜音測試一", "SR2T2 Push");
  await waitForDb("T247A inbound commit", async () =>
    prisma.message.findFirst({ where: { waMessageId: "wamid.SR2T2T247A" } }) != null
  );
  // socket 收唔收到（SUPERVISOR join 全 clinic room）
  const t0 = Date.now();
  let got = events.find((e) => (e as { waMessageId?: string } & { message?: { waMessageId?: string } }).message?.waMessageId === "wamid.SR2T2T247A");
  while (!got && Date.now() - t0 < 20_000) {
    await new Promise((r) => setTimeout(r, 300));
    got = events.find((e) => (e as { message?: { waMessageId?: string } }).message?.waMessageId === "wamid.SR2T2T247A");
  }
  check("T247 socket room：message:new 實時收到", got != null);
  await new Promise((r) => setTimeout(r, 6_000)); // push fire-and-forget 窗口
  check("T247 通知預設靜音（push 0 收）", pushServer.hits.length === hitsBefore, pushServer.hits.length - hitsBefore);

  // ② opt-in（設定面板 path：/api/push/prefs — SUPERVISOR 持 adminMsgClinics 欄）
  const prefs = await api(supCookie, "/api/push/prefs", { method: "POST", body: { adminMsgClinics: [ctx.tkwId] } });
  check("POST /api/push/prefs 200（opt-in TKW）", prefs.status === 200, prefs.status);
  const rows = await prisma.staffUser.findUnique({ where: { id: ctx.supId }, select: { pushPrefs: true } });
  const adminMsg = ((rows?.pushPrefs as { adminMsgClinics?: string[] } | null)?.adminMsgClinics ?? []);
  check("DB pushPrefs.adminMsgClinics 含 TKW", adminMsg.includes(ctx.tkwId), adminMsg);

  // ③ opt-in 後收到
  const hitsBefore2 = pushServer.hits.length;
  await mockInboundMessage(tkw, "wamid.SR2T2T247B", "85299020004", "e2e opt-in 測試二", "SR2T2 Push");
  await waitForDb("T247B inbound commit", async () =>
    prisma.message.findFirst({ where: { waMessageId: "wamid.SR2T2T247B" } }) != null
  );
  const t1 = Date.now();
  while (pushServer.hits.length === hitsBefore2 && Date.now() - t1 < 20_000) {
    await new Promise((r) => setTimeout(r, 500));
  }
  check("T247 opt-in 後收到 push", pushServer.hits.length > hitsBefore2, pushServer.hits.length - hitsBefore2);
  socket.close();
}

// ── 截圖（playwright — 照 T1 慣例：openclaw global playwright-core + 最小結構類型）──
interface LocatorLike {
  count: () => Promise<number>;
  first: () => LocatorLike;
  nth: (i: number) => LocatorLike;
  waitFor: (o?: Record<string, unknown>) => Promise<unknown>;
  click: (o?: Record<string, unknown>) => Promise<void>;
}
interface PageLike {
  goto: (url: string, o?: Record<string, unknown>) => Promise<void>;
  locator: (sel: string, o?: Record<string, unknown>) => LocatorLike;
  getByText: (t: string | RegExp, o?: Record<string, unknown>) => LocatorLike;
  waitForTimeout: (ms: number) => Promise<void>;
  screenshot: (o: Record<string, unknown>) => Promise<void>;
}
interface CtxLike {
  newPage: () => Promise<PageLike>;
  addCookies: (c: { name: string; value: string; domain: string; path: string }[]) => Promise<void>;
  close: () => Promise<void>;
}
interface PwChromium {
  chromium: {
    launch(opts: { executablePath: string; args: string[] }): Promise<{
      newContext(opts: { viewport: { width: number; height: number } }): Promise<CtxLike>;
      close(): Promise<void>;
    }>;
  };
}
function findChromium(): string {
  const baseDir = path.join(os.homedir(), ".cache", "ms-playwright");
  const dirs = readdirSync(baseDir).filter((d) => d.startsWith("chromium-")).sort().reverse();
  for (const d of dirs) {
    const exe = path.join(baseDir, d, "chrome-linux64", "chrome");
    try {
      readFileSync(exe);
      return exe;
    } catch {
      /* next */
    }
  }
  throw new Error("chromium binary 搵唔到");
}

async function screenshots(tkwCookie: string, supCookie: string): Promise<void> {
  console.log("\n[SHOT] 截圖 ×4");
  /* eslint-disable @typescript-eslint/no-require-imports -- repo 慣例 */
  const { chromium } = require("/usr/lib/node_modules/openclaw/node_modules/playwright-core") as PwChromium;
  const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });
  try {
    // 1+2：staff-tkw inbox（T242 badge + T244 auto-resolve 備註）
    const ctx1 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx1.newPage();
    await ctx1.addCookies([{ name: "wa_inbox_session", value: tkwCookie, domain: "127.0.0.1", path: "/" }]);
    await page.goto(`${BASE}/inbox`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    const badge = page.getByText("↻ 重新開啟");
    await badge.first().waitFor({ timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
    check("SHOT1 badge 顯示（↻ 重新開啟）", (await badge.count()) >= 1);
    await page.screenshot({ path: "/tmp/kairo-statusrole2-t2-1-reopen-badge.png" });
    ok("screenshot 1: /tmp/kairo-statusrole2-t2-1-reopen-badge.png");
    // 打開 AR3 對話 → INTERNAL 備註
    const arRow = page.locator("button", { hasText: "SR2T2 AR3" });
    await arRow.first().waitFor({ timeout: 15_000 }).catch(() => undefined);
    await arRow.first().click().catch(() => undefined);
    await page.waitForTimeout(2000);
    const note = page.getByText("系統自動標記已解決");
    const noteVisible = (await note.count()) >= 1;
    check("SHOT2 auto-resolve 備註可見", noteVisible);
    await page.screenshot({ path: "/tmp/kairo-statusrole2-t2-2-autoresolve-note.png" });
    ok("screenshot 2: /tmp/kairo-statusrole2-t2-2-autoresolve-note.png");
    await ctx1.close();

    // 3：SUPERVISOR inbox（唯讀）
    const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page3 = await ctx3.newPage();
    await ctx3.addCookies([{ name: "wa_inbox_session", value: supCookie, domain: "127.0.0.1", path: "/" }]);
    await page3.goto(`${BASE}/inbox`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page3.waitForTimeout(2500);
    await page3.screenshot({ path: "/tmp/kairo-statusrole2-t2-3-supervisor-inbox.png" });
    ok("screenshot 3: /tmp/kairo-statusrole2-t2-3-supervisor-inbox.png");
    await ctx3.close();

    // 4：SUPERVISOR /admin（側欄設定類隱藏）
    const ctx4 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page4 = await ctx4.newPage();
    await ctx4.addCookies([{ name: "wa_inbox_session", value: supCookie, domain: "127.0.0.1", path: "/" }]);
    await page4.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page4.waitForTimeout(2000);
    check("SHOT4 SUPERVISOR /admin 側欄：診所設定 隱藏", (await page4.getByText("診所設定", { exact: true }).count()) === 0);
    check("SHOT4 SUPERVISOR /admin 側欄：員工帳號 隱藏", (await page4.getByText("員工帳號", { exact: true }).count()) === 0);
    check("SHOT4 SUPERVISOR /admin 側欄：AI 自動化 可見", (await page4.getByText("AI 自動化", { exact: true }).count()) >= 1);
    check("SHOT4 SUPERVISOR /admin 側欄：總覽 可見", (await page4.getByText("總覽", { exact: true }).count()) >= 1);
    await page4.screenshot({ path: "/tmp/kairo-statusrole2-t2-4-supervisor-admin.png" });
    ok("screenshot 4: /tmp/kairo-statusrole2-t2-4-supervisor-admin.png");
    await ctx4.close();
  } finally {
    await browser.close();
  }
}

// ── main ─────────────────────────────────────────────────────────────────
function readCredLine(label: string): string {
  const lines = readFileSync(path.join(REPO, ".dev", "credentials.txt"), "utf8").split("\n");
  const l = lines.find((x) => x.startsWith(`${label}:`));
  if (!l) throw new Error(`credentials.txt 冇 ${label}`);
  return l.split(" / ")[1];
}

async function main(): Promise<void> {
  console.log(`STATUSROLE2-T2 e2e — base=${BASE}`);
  if (!WA_APP_SECRET) fail("WA_APP_SECRET 唔係（.env 要有）");
  const probe = await fetch(`${BASE}/`, { redirect: "manual" }).catch(() => null);
  if (!probe || probe.status >= 500) fail("server 未 live（3100）", probe?.status);
  ok("server live");

  const ctx = await setupFixtures();
  ok(`fixtures ready（sup=${ctx.supId.slice(0, 8)}… grp=${ctx.groupId.slice(0, 8)}…）`);

  const tkw = (await prisma.clinic.findFirst({ where: { code: "TKW" } })) as ClinicRow;
  const adminCookie = await cookieFor("admin@wa-clinic.local", readCredLine("ADMIN"));
  const tkwCookie = await cookieFor("staff-tkw@wa-clinic.local", readCredLine("TKW STAFF"));
  const supCookie = await cookieFor(FIX.supEmail, FIX.supPassword, `${FIX.supEmail}:${ctx.supId}`);
  void adminCookie;
  ok("login ×3");

  const pushServer = await startFakePushServer();
  // SUPERVISOR push subscription（fake endpoint — P-256 真 keypair）
  const keys = makePushKeys();
  const sub = await api(supCookie, "/api/push/subscribe", {
    method: "POST",
    body: { endpoint: pushServer.endpoint, keys, userAgent: "e2e-statusrole2-t2" },
  });
  check("push subscribe 200", sub.status === 200, sub.status);

  try {
    await t247(tkw, supCookie, pushServer, ctx); // 先做（push/socket 狀態最敏感）
    await t242(tkw, ctx);
    await t245(tkw, ctx);
    await t243(tkw, tkwCookie, ctx);
    await t244(ctx);
    await t246(supCookie, ctx);
    await screenshots(tkwCookie, supCookie);
  } finally {
    pushServer.server.close();
    await sweep();
  }
  console.log("\nSTATUSROLE2-T2-OK");
}

main()
  .then(async () => {
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(`STATUSROLE2-T2-FAIL: ${e instanceof Error ? e.message : e}`);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });

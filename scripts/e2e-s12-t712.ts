/**
 * e2e-s12-t712 — cwi-final S1-12 T712：per-staff 已讀隔離（A 開對話 → B myUnread 保持；SUPERVISOR 開 → unreadCount 唔變）
 *
 * 設計（spec S1-12 測試 T712）：
 *  - 獨立 fixture：company E2ES12B-CO + clinic E2ES12B-C1（零既有數據）
 *  - STAFF A / STAFF B（CLINICS 綁 fixture 店）+ SUPERVISOR S（全店）
 *  - C1（A 開）：3 條 IN 訊息、unreadCount=3、未指派
 *    A: PATCH markRead → A myUnread=0（ConversationRead 落）
 *    B: myUnread 保持 3（A 讀咗唔代表 B 讀咗）+ B socket 照收 conv:updated（unreadCount=0 全店值）
 *  - C2（S 開）：3 條 IN 訊息、unreadCount=3
 *    SUPERVISOR markRead → 全店 unreadCount 保持 3（S1-12 角色分層：SUPERVISOR 唔清）
 *    S 自己 myUnread=0（ConversationRead 照落）
 *
 * 前置：dev stack live（server 3100 + DB 15432）。
 * 用法（repo root）：pnpm tsx scripts/e2e-s12-t712.ts
 * 輸出：T712-OK / T712-FAIL: <reason>（exit 1）
 */
import "./e2e-origin-shim";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { io, type Socket } from "socket.io-client";

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
try {
  process.loadEnvFile(path.join(REPO, ".env"));
} catch {
  /* 靠 process env */
}

const COMPANY_CODE = "E2ES12B-CO";
const CLINIC_CODE = "E2ES12B-C1";
const A_EMAIL = "e2e-s12b-a@wa-clinic.local";
const B_EMAIL = "e2e-s12b-b@wa-clinic.local";
const S_EMAIL = "e2e-s12b-s@wa-clinic.local";
const PASS = "e2e-s12b-pass-2026";
const WA_PREFIX = "990617";
const N_MSG = 3;

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
interface Item {
  id: string;
  unreadCount: number;
  myUnread?: number;
}

let CLINIC = "";
let C1 = "";
let C2 = "";
let A_ID = "";
let B_ID = "";

async function cleanup(): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM "ConversationRead" WHERE "conversationId" IN ('${C1}','${C2}')`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Message" WHERE "conversationId" IN ('${C1}','${C2}')`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE "clinicId" IN (SELECT id FROM "Clinic" WHERE code = '${CLINIC_CODE}')`);
  await prisma.contact.deleteMany({ where: { waId: { startsWith: WA_PREFIX } } });
  await prisma.staffClinic.deleteMany({ where: { staff: { email: { in: [A_EMAIL, B_EMAIL] } } } });
  await prisma.staffUser.deleteMany({ where: { email: { in: [A_EMAIL, B_EMAIL, S_EMAIL] } } });
  await prisma.clinic.deleteMany({ where: { code: CLINIC_CODE } });
  await prisma.company.deleteMany({ where: { code: COMPANY_CODE } });
}

async function seed(): Promise<void> {
  const company = await prisma.company.create({ data: { code: COMPANY_CODE, name: "E2ES12B CO" } });
  CLINIC = (
    await prisma.clinic.create({
      data: { companyId: company.id, code: CLINIC_CODE, name: "E2ES12B Clinic", waPhoneNumberId: "E2ES12B-PH", waDisplayNumber: "+852 0000 7161" },
    })
  ).id;
  const argon2 = (await import("argon2")).default;
  const hash = await argon2.hash(PASS);
  const a = await prisma.staffUser.create({ data: { email: A_EMAIL, name: "E2E S12B A", role: "STAFF", scopeType: "CLINICS", passwordHash: hash } });
  const b = await prisma.staffUser.create({ data: { email: B_EMAIL, name: "E2E S12B B", role: "STAFF", scopeType: "CLINICS", passwordHash: hash } });
  A_ID = a.id;
  B_ID = b.id;
  await prisma.staffUser.create({ data: { email: S_EMAIL, name: "E2E S12B S", role: "SUPERVISOR", scopeType: "ALL", passwordHash: hash } });
  await prisma.staffClinic.create({ data: { staffId: A_ID, clinicId: CLINIC, isPrimary: true } });
  await prisma.staffClinic.create({ data: { staffId: B_ID, clinicId: CLINIC, isPrimary: true } });

  const ts = Date.now();
  for (const [key, wa] of [
    ["C1", `${WA_PREFIX}00`],
    ["C2", `${WA_PREFIX}01`],
  ] as const) {
    const ct = await prisma.contact.create({ data: { clinicId: CLINIC, waId: wa, profileName: `E2ES12B ${key}`, labels: [] } });
    const conv = await prisma.conversation.create({
      data: { clinicId: CLINIC, contactId: ct.id, status: "OPEN", assigneeId: null, unreadCount: N_MSG, lastMessageAt: new Date(ts) },
    });
    for (let i = 0; i < N_MSG; i++) {
      await prisma.message.create({
        data: {
          conversationId: conv.id,
          waMessageId: `wamid.t712.${key}.${i}.${ts}`,
          direction: "IN",
          channel: "API",
          type: "text",
          body: `E2E T712 ${key} msg ${i + 1}`,
          status: "RECEIVED",
          mentions: [],
          billingCategory: "NONE",
          waTimestamp: new Date(ts - (N_MSG - i) * 1000),
          createdAt: new Date(ts - (N_MSG - i) * 1000),
        },
      });
    }
    if (key === "C1") C1 = conv.id;
    else C2 = conv.id;
  }
}

async function login(email: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASS }),
  });
  if (res.status !== 200) throw new Error(`login ${email} → ${res.status}`);
  const m = (res.headers.get("set-cookie") ?? "").match(/wa_inbox_session=([^;]+)/);
  if (!m) throw new Error("login 冇 wa_inbox_session cookie");
  return m[1];
}

async function getItem(cookie: string, convId: string): Promise<Item> {
  const r = await fetch(`${BASE}/api/conversations?ids=${convId}`, { headers: { cookie: `wa_inbox_session=${cookie}` } });
  if (r.status !== 200) throw new Error(`GET ids=${convId} → ${r.status}`);
  const body = (await r.json()) as { items: Item[] };
  const it = body.items.find((x) => x.id === convId);
  if (!it) throw new Error(`GET ids=${convId} → item 唔存在`);
  return it;
}

async function markRead(cookie: string, convId: string): Promise<Item | null> {
  const r = await fetch(`${BASE}/api/conversations/${convId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: `wa_inbox_session=${cookie}` },
    body: JSON.stringify({ markRead: true }),
  });
  if (r.status !== 200) throw new Error(`PATCH markRead ${convId} → ${r.status}`);
  return (await r.json()) as Item;
}

function connectSocket(cookie: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = io(BASE, {
      transports: ["websocket"],
      extraHeaders: { Cookie: `wa_inbox_session=${cookie}` },
      timeout: 8000,
      reconnection: false,
    });
    const timer = setTimeout(() => reject(new Error("socket connect timeout")), 10_000);
    s.on("connect", () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.on("connect_error", (err) => {
      clearTimeout(timer);
      reject(new Error(`socket connect_error: ${err.message}`));
    });
  });
}

async function main(): Promise<void> {
  console.log(`[T712] per-staff 已讀隔離 — base=${BASE}`);
  const probe = await fetch(`${BASE}/`).catch(() => null);
  if (!probe || probe.status >= 500) {
    console.error(`T712-ERR server 未 live（status=${probe?.status}）`);
    process.exit(2);
  }

  await cleanup();
  await seed();
  const aCookie = await login(A_EMAIL);
  const bCookie = await login(B_EMAIL);
  const sCookie = await login(S_EMAIL);

  // B 嘅 socket 掛住（收 A markRead 嘅 conv:updated — 驗證事件照行、per-staff 值唔受影響）
  const bSock = await connectSocket(bCookie);
  let bConvUpdated = 0;
  let bConvUpdatedUnread: number | null = null;
  bSock.onAny((event: string, payload: unknown) => {
    const p = (payload ?? {}) as { conversationId?: string; unreadCount?: number };
    if (event === "conv:updated" && p.conversationId === C1) {
      bConvUpdated++;
      if (typeof p.unreadCount === "number") bConvUpdatedUnread = p.unreadCount;
    }
  });
  await sleep(800); // room join 窗口

  // ══ T712-A：baseline（A/B 都未讀 C1）══
  console.log("\n[T712-A] baseline：A/B myUnread(C1) = 3");
  const aBase = await getItem(aCookie, C1);
  const bBase = await getItem(bCookie, C1);
  check("A myUnread(C1) baseline === 3", aBase.myUnread === N_MSG, aBase.myUnread);
  check("B myUnread(C1) baseline === 3", bBase.myUnread === N_MSG, bBase.myUnread);
  check("unreadCount(C1) baseline === 3（全店）", aBase.unreadCount === N_MSG, aBase.unreadCount);

  // ══ T712-B：A 開對話（markRead）→ B myUnread 保持 ══
  console.log("\n[T712-B] A markRead(C1) → B myUnread 保持");
  const aPatch = await markRead(aCookie, C1);
  await sleep(2500); // socket 事件 + DB 沉降
  const aAfter = await getItem(aCookie, C1);
  const bAfter = await getItem(bCookie, C1);
  check("A PATCH 200（markRead 成功）", aPatch !== null);
  check("A myUnread(C1) === 0（A 已讀）", aAfter.myUnread === 0, aAfter.myUnread);
  check("B myUnread(C1) 保持 === 3（A 讀咗唔代表 B 讀咗）— T712 核心", bAfter.myUnread === N_MSG, bAfter.myUnread);
  check("B unreadCount(C1) === 0（A = STAFF + 未指派 → 全店清）", bAfter.unreadCount === 0, bAfter.unreadCount);
  check("B socket 收 conv:updated(C1)（事件照行）", bConvUpdated >= 1, bConvUpdated);
  check("B socket conv:updated 帶 unreadCount=0（全店值，per-staff 值獨立）", bConvUpdatedUnread === 0, bConvUpdatedUnread);

  // ══ T712-C：SUPERVISOR 開 C2 → 全店 unreadCount 唔變 ══
  console.log("\n[T712-C] SUPERVISOR markRead(C2) → unreadCount 唔變");
  const sBase = await getItem(sCookie, C2);
  check("S myUnread(C2) baseline === 3", sBase.myUnread === N_MSG, sBase.myUnread);
  check("unreadCount(C2) baseline === 3", sBase.unreadCount === N_MSG, sBase.unreadCount);
  const sPatch = await markRead(sCookie, C2);
  const sAfter = await getItem(sCookie, C2);
  check("S PATCH 回應 unreadCount === 3（SUPERVISOR 唔清全店 unreadCount）", sPatch?.unreadCount === N_MSG, sPatch?.unreadCount);
  check("S 之後 fetch：unreadCount(C2) 保持 === 3（DB 唔變）", sAfter.unreadCount === N_MSG, sAfter.unreadCount);
  check("S myUnread(C2) === 0（SUPERVISOR 自己已讀 — ConversationRead 照落）", sAfter.myUnread === 0, sAfter.myUnread);

  // ══ T712-D：DB 層 ConversationRead 精確性 ══
  console.log("\n[T712-D] ConversationRead 行精確性");
  const reads = await prisma.conversationRead.findMany({ where: { conversationId: { in: [C1, C2] } } });
  const c1Staff = new Set(reads.filter((r) => r.conversationId === C1).map((r) => r.staffId));
  const c2Staff = new Set(reads.filter((r) => r.conversationId === C2).map((r) => r.staffId));
  check("C1 ConversationRead === 恰 {A}（B 冇讀過）", c1Staff.size === 1 && c1Staff.has(A_ID), [...c1Staff]);
  check("C2 ConversationRead === 恰 {S}", c2Staff.size === 1, [...c2Staff]);

  bSock.close();
  await cleanup();
  console.log(FAILS === 0 ? "\nT712-OK（per-staff 已讀隔離全綠）" : `\nT712-FAIL（${FAILS} 項紅）`);
  process.exit(FAILS === 0 ? 0 : 1);
}

main()
  .catch((e) => {
    console.error("T712-FAIL:", e);
    try {
      void cleanup();
    } catch {
      /* ignore */
    }
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

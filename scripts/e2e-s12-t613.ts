/**
 * e2e-s12-t613 — cwi-final S1-2 T613：大列表 keyset 分頁「重不漏」（≥5000 conv）
 *
 * 設計（接盤單 #5 / handover2 Gates 3）：
 *  - 獨立 fixture：company E2ES12K-CO + clinic E2ES12K-C1 + STAFF K（CLINICS 綁 fixture 店）
 *    → K 嘅 baseScope = fixture 店（K 新用戶，assignee/routed 支路零既有數據）
 *  - 5200 Conversation：4800 OPEN（非 RESOLVED）+ 400 RESOLVED；52 Contact（每 contact 100 線）
 *  - 撞 ts 組：rows 0/10/20/30/40/50 同 lastMessageAt + 同 urgent=true → 驗 id desc tiebreak
 *  - walk：作 K 打 GET /api/conversations（cursor 跟到 nextCursor=null）
 *  斷言：
 *   A1 每頁 ≤200（第一頁 = 200 active + resolved tail ≤100 → ≤300）
 *   A2 零重複（每 id 全 walk 只出現一次）
 *   A3 唔漏：active 部分 === 全部 4800 非 RESOLVED；resolved 部分 === 最新 100 條 RESOLVED（RESOLVED_TAIL）
 *   A4 排序：active 序列 === (urgent desc, lastMessageAt desc, id desc) 全序；resolved 序列 === (lastMessageAt desc, id desc) top-100
 *   A5 counts（第一頁 counts=1）：all=4800 / unassigned=4800 / mine=0 / routed=0 / resolved=400 / followup=0 / pending=0
 *
 * 前置：dev stack live（server 3100 + DB 15432）。worker 唔影響（fixture lastInboundAt=null → sweep 守門跳過）。
 * 用法（repo root）：pnpm tsx scripts/e2e-s12-t613.ts
 * 輸出：T613-OK / T613-FAIL: <reason>（exit 1）
 */
import "./e2e-origin-shim";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
try {
  process.loadEnvFile(path.join(REPO, ".env"));
} catch {
  /* 靠 process env */
}

const COMPANY_CODE = "E2ES12K-CO";
const CLINIC_CODE = "E2ES12K-C1";
const EMAIL = "e2e-s12k@wa-clinic.local";
const PASS = "e2e-s12k-pass-2026";
const N_OPEN = 4800;
const N_RESOLVED = 400;
const N_TOTAL = N_OPEN + N_RESOLVED;
const N_CONTACTS = N_TOTAL; // Conversation @@unique([clinicId, contactId]) → 一 conv 一 contact（5200）
const PAGE = 200;
const RESOLVED_TAIL = 100;
const WA_PREFIX = "990613";
// 撞 ts 組：同 lastMessageAt + 同 urgent=true → 順序由 id desc 決定
const COLLIDE_IDX = new Set([0, 10, 20, 30, 40, 50]);

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

const prisma = new PrismaClient();
interface FixRow {
  id: string;
  status: "OPEN" | "RESOLVED";
  urgent: boolean;
  ts: number;
}
let fixtures: FixRow[] = [];

function genId(n: number): string {
  return `s12k${String(n).padStart(5, "0")}`;
}

async function cleanupFirst(): Promise<void> {
  // 冪等：開頭先洗上一輪殘留（by clinic code / contact prefix / email）
  await prisma.$executeRawUnsafe(
    `DELETE FROM "Message" WHERE "conversationId" IN (SELECT c.id FROM "Conversation" c JOIN "Clinic" cl ON cl.id = c."clinicId" WHERE cl.code = '${CLINIC_CODE}')`
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "Conversation" WHERE "clinicId" IN (SELECT id FROM "Clinic" WHERE code = '${CLINIC_CODE}')`
  );
  await prisma.contact.deleteMany({ where: { waId: { startsWith: WA_PREFIX } } });
  await prisma.staffClinic.deleteMany({ where: { staff: { email: EMAIL } } });
  await prisma.staffUser.deleteMany({ where: { email: EMAIL } });
  await prisma.clinic.deleteMany({ where: { code: CLINIC_CODE } });
  await prisma.company.deleteMany({ where: { code: COMPANY_CODE } });
}

async function cleanupLast(clinicId: string): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM "Message" WHERE "conversationId" IN (SELECT id FROM "Conversation" WHERE "clinicId" = '${clinicId}')`);
  await prisma.conversation.deleteMany({ where: { clinicId } });
  await prisma.contact.deleteMany({ where: { waId: { startsWith: WA_PREFIX } } });
  await prisma.staffClinic.deleteMany({ where: { staff: { email: EMAIL } } });
  await prisma.staffUser.deleteMany({ where: { email: EMAIL } });
  await prisma.clinic.deleteMany({ where: { code: CLINIC_CODE } });
  await prisma.company.deleteMany({ where: { code: COMPANY_CODE } });
}

async function seed(): Promise<{ clinicId: string }> {
  const company = await prisma.company.create({ data: { code: COMPANY_CODE, name: "E2ES12K CO" } });
  const clinic = await prisma.clinic.create({
    data: { companyId: company.id, code: CLINIC_CODE, name: "E2ES12K Clinic 1", waPhoneNumberId: "E2ES12K-C1-PH", waDisplayNumber: "+852 0000 6131" },
  });
  const staff = await prisma.staffUser.create({
    data: { email: EMAIL, name: "E2E S12K staff", role: "STAFF", scopeType: "CLINICS", passwordHash: await (await import("argon2")).default.hash(PASS) },
  });
  await prisma.staffClinic.create({ data: { staffId: staff.id, clinicId: clinic.id, isPrimary: true } });

  // contacts：N_TOTAL 個（Conversation @@unique([clinicId, contactId]) → 一 conv 一 contact），waId = WA_PREFIX + 4 位
  const contactIds: string[] = [];
  for (let o = 0; o < N_CONTACTS; o += 500) {
    const chunk = Array.from({ length: Math.min(500, N_CONTACTS - o) }, (_, k) => {
      const c = o + k;
      return {
        id: `s12kct${String(c).padStart(5, "0")}`,
        clinicId: clinic.id,
        waId: `${WA_PREFIX}${String(c).padStart(4, "0")}`,
        profileName: `E2E S12K C${String(c).padStart(4, "0")}`,
        labels: [],
      };
    });
    await prisma.contact.createMany({ data: chunk });
    for (const r of chunk) contactIds.push(r.id);
  }

  // 5200 conv：ts = now - (5200-i)*60s（i 越大越新）；collide 組全部 top ts
  const nowMs = Date.now();
  const stepMs = 60_000;
  const topTs = nowMs - stepMs; // collide 組共享（最新位）
  const rows: FixRow[] = [];
  for (let i = 0; i < N_TOTAL; i++) {
    const status: "OPEN" | "RESOLVED" = i < N_OPEN ? "OPEN" : "RESOLVED";
    const ts = COLLIDE_IDX.has(i) ? topTs : topTs - (i * stepMs + stepMs);
    const urgent = COLLIDE_IDX.has(i) ? true : i % 100 < 3;
    rows.push({ id: genId(i), status, urgent, ts });
  }
  fixtures = rows;
  const data = rows.map((r, i) => ({
    id: r.id,
    clinicId: clinic.id,
    contactId: contactIds[i % N_CONTACTS],
    status: r.status,
    urgent: r.urgent,
    lastMessageAt: new Date(r.ts),
  }));
  for (let o = 0; o < data.length; o += 500) {
    await prisma.conversation.createMany({ data: data.slice(o, o + 500) });
  }
  const dbCount = await prisma.conversation.count({ where: { clinicId: clinic.id } });
  check("fixture 落庫 5200 條", dbCount === N_TOTAL, dbCount);
  return { clinicId: clinic.id };
}

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  });
  if (res.status !== 200) throw new Error(`login ${EMAIL} → ${res.status}`);
  const m = (res.headers.get("set-cookie") ?? "").match(/wa_inbox_session=([^;]+)/);
  if (!m) throw new Error("login 冇 wa_inbox_session cookie");
  return m[1];
}

interface ItemRow {
  id: string;
  status: string;
  urgent: boolean;
  lastMessageAt: string;
}

async function main(): Promise<void> {
  console.log("[T613] S1-2 大列表 keyset 重不漏（5200 conv fixture）");
  await cleanupFirst();
  const { clinicId } = await seed();
  const cookie = await login();

  // ── walk cursor 到盡 ──
  let cursor: string | null = null;
  let counts: Record<string, number> | null = null;
  const seq: ItemRow[] = [];
  let pages = 0;
  let firstPageLen = 0;
  const pageLens: number[] = [];
  for (;;) {
    const url = `${BASE}/api/conversations?counts=${cursor === null ? 1 : 0}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await fetch(url, { headers: { cookie: `wa_inbox_session=${cookie}` } });
    if (r.status !== 200) throw new Error(`walk page ${pages + 1} → ${r.status}`);
    const body = (await r.json()) as { items: ItemRow[]; nextCursor: string | null; counts?: Record<string, number> };
    if (pages === 0) {
      firstPageLen = body.items.length;
      if (body.counts) counts = body.counts;
    }
    pageLens.push(body.items.length);
    for (const it of body.items) seq.push(it);
    cursor = body.nextCursor;
    pages++;
    if (cursor === null) break;
    if (pages > 60) throw new Error("walk > 60 頁 — 異常");
  }

  const activeSeq = seq.filter((r) => r.status !== "RESOLVED");
  const resolvedSeq = seq.filter((r) => r.status === "RESOLVED");

  // A1 頁大小
  check("A1 頁數 = 24（4800 active / 200）", pages === 24, pages);
  check("A1 第一頁 = 300（200 active + 100 resolved tail）", firstPageLen === 300, firstPageLen);
  check("A1 第 2+ 頁全部 = 200", pageLens.slice(1).every((n) => n === PAGE), pageLens.slice(1, 8));

  // A2 零重複
  const idSet = new Set(seq.map((r) => r.id));
  check("A2 零重複（4900 個唯一 id）", idSet.size === seq.length && seq.length === N_OPEN + RESOLVED_TAIL, { total: seq.length, unique: idSet.size });

  // A3/A4 期望序列
  const activeFix = fixtures.filter((f) => f.status === "OPEN");
  const resolvedFix = fixtures.filter((f) => f.status === "RESOLVED");
  const cmpActive = (a: FixRow, b: FixRow): number =>
    Number(b.urgent) - Number(a.urgent) || b.ts - a.ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  const cmpResolved = (a: FixRow, b: FixRow): number => b.ts - a.ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  const expActiveIds = [...activeFix].sort(cmpActive).map((f) => f.id);
  const expResolvedIds = [...resolvedFix].sort(cmpResolved).slice(0, RESOLVED_TAIL).map((f) => f.id);
  const gotActiveIds = activeSeq.map((r) => r.id);
  const gotResolvedIds = resolvedSeq.map((r) => r.id);

  check("A3 active 唔漏（=== 全部 4800 非 RESOLVED）", gotActiveIds.length === N_OPEN && gotActiveIds.every((id) => idSet.has(id)) && new Set(expActiveIds).size === new Set(gotActiveIds).size, { got: gotActiveIds.length, exp: expActiveIds.length });
  check("A3 resolved = 最新 100 條（RESOLVED_TAIL）", gotResolvedIds.length === RESOLVED_TAIL && new Set(expResolvedIds).size === new Set(gotResolvedIds).size && [...new Set(expResolvedIds)].every((id: string) => gotResolvedIds.includes(id)), { got: gotResolvedIds.length });
  check("A4 active 全序 === (urgent desc, ts desc, id desc)", JSON.stringify(gotActiveIds) === JSON.stringify(expActiveIds), { firstGot: gotActiveIds.slice(0, 8), firstExp: expActiveIds.slice(0, 8) });
  check("A4 撞 ts 組 top6 按 id desc（tiebreak）", JSON.stringify(gotActiveIds.slice(0, 6)) === JSON.stringify(expActiveIds.slice(0, 6)), { got: gotActiveIds.slice(0, 6) });
  check("A4 resolved 全序 === (ts desc, id desc) top-100", JSON.stringify(gotResolvedIds) === JSON.stringify(expResolvedIds), { firstGot: gotResolvedIds.slice(0, 4), firstExp: expResolvedIds.slice(0, 4) });

  // A5 counts 不變式（fixture 範圍零既有數據 → 精確值）
  if (!counts) throw new Error("第一頁冇 counts");
  check("A5 counts.all = 4800（base ∧ 非 RESOLVED）", counts.all === N_OPEN, counts);
  check("A5 counts.unassigned = 4800", counts.unassigned === N_OPEN, counts.unassigned);
  check("A5 counts.mine = 0 / routed = 0", counts.mine === 0 && counts.routed === 0, { mine: counts.mine, routed: counts.routed });
  check("A5 counts.resolved = 400", counts.resolved === N_RESOLVED, counts.resolved);
  check("A5 counts.followup = 0 / pending = 0", counts.followup === 0 && counts.pending === 0, { followup: counts.followup, pending: counts.pending });

  await cleanupLast(clinicId);
  console.log(FAILS === 0 ? "\nT613-OK" : `\nT613-FAIL（${FAILS} 項紅）`);
  process.exit(FAILS === 0 ? 0 : 1);
}

main()
  .catch((e) => {
    console.error("T613-FAIL:", e);
    process.exit(1);
  })
  .finally(async () => {
    try {
      const c = await prisma.clinic.findUnique({ where: { code: CLINIC_CODE } });
      if (c) await cleanupLast(c.id); // 崩潰後兜底
    } catch {
      /* ignore */
    }
    await prisma.$disconnect();
  });

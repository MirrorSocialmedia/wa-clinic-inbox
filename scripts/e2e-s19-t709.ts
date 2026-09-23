/**
 * e2e-s19-t709 — cwi-final S1-9 T709：停用員工釋放（L-4 真問題）
 *
 * 覆蓋（MD §1423-1444）：
 * - A：停用有 3 條（1 跨店 / 1 RESOLVED）的員工 → 3 條 assigneeId=null、
 *   2 條 INTERNAL 備註（RESOLVED 唔落備註）、公海 +2（TKW+1 / WTC+1）、
 *   audit STAFF_DISABLED_RELEASE meta.released=3
 * - B（並發核心）：停用同時另一員工（staff-tkw）接手其中一條 → 接手結果保留
 *   （updateMany 自指條件 { id, assigneeId=id } — 期間被接手嘅唔郁）
 * - D（兜底 cron）：runDisabledAssigneeSweep（auto-release 每 5 分鐘掛入 — 直接調）
 *   殘留停用帳號指派 → 釋放（sentByStaffId=null）
 *
 * 前置：dev stack live（server 3100 + worker + DB 15432 + Redis）
 * 用法（repo root）：pnpm tsx scripts/e2e-s19-t709.ts
 * 輸出：T709-OK / T709-FAIL: <reason>
 * fixture：`t709` 前綴 id — 段尾 hermetic sweep（assert 零殘留）
 */
import "./e2e-origin-shim";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { runDisabledAssigneeSweep } from "@/lib/auto-release";

const REPO = path.join(import.meta.dirname, "..");
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:3100";
const prisma = new PrismaClient();
const NOTE_BODY = "原負責人帳號已停用，對話已放返公海。";

function ok(label: string): void {
  console.log(`  ✅ ${label}`);
}
function fail(label: string, detail?: unknown): never {
  console.error(`  ❌ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  process.exit(1);
}
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) ok(label);
  else fail(label, detail);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── fixtures（id 全部 cuid 形：20+ lowercase alnum — normalizeRoute 鐵律）──
const FIX = {
  staff1: "t709staffa000000000001", // A：停用對象（3 條：TKW OPEN / WTC OPEN 跨店 / TKW RESOLVED）
  staff2: "t709staffb000000000002", // B：停用對象（convB4 + 12 dummy 拖長 transaction 窗口）
  staff3: "t709staffc000000000003", // D：DB 直接 active=false（模擬歷史殘留）
  convA1: "t709conv0a0000000000001", // TKW OPEN
  convA2: "t709conv0b0000000000002", // WTC OPEN（跨店）
  convA3: "t709conv0c0000000000003", // TKW RESOLVED
  convB4: "t709conv9z0000000000004", // TKW OPEN — 並發接手（id 排序最後 → 循環最後處理；窗口最大化）
  convD: "t709conv0e0000000000005", // D：sweep 對象
  dummies: Array.from({ length: 40 }, (_, i) => `t709conv1${String(i).padStart(2, "0")}00000000${String(i + 1)}`),
  allConvs: [] as string[],
};
FIX.allConvs = [FIX.convA1, FIX.convA2, FIX.convA3, FIX.convB4, FIX.convD, ...FIX.dummies];
const ALL_STAFF = [FIX.staff1, FIX.staff2, FIX.staff3];
const CT = Array.from({ length: 45 }, (_, i) => ({
  id: `t709ctc${String(i).padStart(2, "0")}0000000000${String(i + 1)}`,
  name: `T709-${String(i).padStart(2, "0")}`,
  waId: `8529904${String(1000 + i)}`,
}));

const COOKIE_CACHE = "/tmp/w-t709-e2e-cookies.json";
function readCredLine(label: string): string {
  const l = readFileSync(path.join(REPO, ".dev", "credentials.txt"), "utf8").split("\n").find((x) => x.startsWith(`${label}:`));
  if (!l) fail(`credentials.txt 冇 ${label}`);
  return l.split(" / ")[1];
}
async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) fail(`login ${email} → ${res.status}`, res.status);
  const m = (res.headers.get("set-cookie") ?? "").match(/wa_inbox_session=([^;]+)/);
  if (!m) fail("login 冇 wa_inbox_session cookie");
  return m[1];
}
async function cookieFor(email: string, password: string, cacheKey?: string): Promise<string> {
  const key = cacheKey ?? email;
  try {
    const cache = JSON.parse(readFileSync(COOKIE_CACHE, "utf8")) as Record<string, string>;
    if (cache[key]) {
      const probe = await fetch(`${BASE}/api/conversations?counts=1`, { headers: { cookie: `wa_inbox_session=${cache[key]}` } });
      if (probe.status === 200) return cache[key];
    }
  } catch { /* 無 cache */ }
  const c = await login(email, password);
  let next: Record<string, string> = {};
  try { next = JSON.parse(readFileSync(COOKIE_CACHE, "utf8")); } catch { /* first */ }
  next[key] = c;
  writeFileSync(COOKIE_CACHE, JSON.stringify(next));
  return c;
}
type ApiBody = { counts?: { unassigned?: number }; conversation?: { assignVersion?: number } } | null;
async function api(cookie: string, url: string, init?: RequestInit): Promise<{ status: number; body: ApiBody }> {
  const res = await fetch(`${BASE}${url}`, { ...init, headers: { ...(init?.headers ?? {}), cookie: `wa_inbox_session=${cookie}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function mkContact(i: number, clinicId: string): Promise<string> {
  const c = CT[i];
  const existing = await prisma.contact.findUnique({ where: { id: c.id } });
  if (existing) return existing.id;
  await prisma.contact.create({ data: { id: c.id, clinicId, waId: c.waId, profileName: c.name, labels: [] } });
  return c.id;
}
async function mkConv(id: string, clinicId: string, contactIdx: number, extra: Record<string, unknown>): Promise<void> {
  const existing = await prisma.conversation.findUnique({ where: { id } });
  if (existing) return;
  const now = new Date();
  await prisma.conversation.create({
    data: { id, clinicId, contactId: await mkContact(contactIdx, clinicId), lastMessageAt: now, lastInboundAt: now, ...extra },
  });
}
async function mkStaff(id: string, email: string, clinicId: string, active = true): Promise<void> {
  const existing = await prisma.staffUser.findUnique({ where: { id } });
  if (existing) {
    await prisma.staffUser.update({ where: { id }, data: { active } });
    return;
  }
  await prisma.staffUser.create({
    data: { id, email, passwordHash: await argon2.hash("T709-e2e-Passw0rd!x"), name: `T709 ${id.slice(6, 12)}`, role: "STAFF", active, scopeType: "CLINICS", clinicId },
  });
  await prisma.staffClinic.create({ data: { staffId: id, clinicId, isPrimary: true } });
}

async function noteCount(convId: string): Promise<number> {
  return prisma.message.count({
    where: { conversationId: convId, channel: "INTERNAL", type: "note", body: NOTE_BODY },
  });
}
/**
 * 公海統計（drift-tolerant 分解）：dev DB 有真實 webhook 流量（2026-09-21 06:11 實測 —
 * 外部 cmuad* 對話 burst 入 TKW/WTC）→ 全局 delta 會混入外部新線。法：
 * un = API counts.unassigned（server 口徑：status≠RESOLVED ∧ assigneeId=null ∧ 該店）；
 * foreign/foreignUn = 非 fixture 行（外部漂移）— my = (un delta) − (foreignUn delta) 必 = 自家貢獻。
 */
async function poolStats(cookie: string, clinicId: string, fixtureIds: string[]): Promise<{ un: number; foreign: number; foreignUn: number }> {
  const r = await api(cookie, `/api/conversations?counts=1&clinicId=${clinicId}`);
  if (r.status !== 200) fail("counts API 非 200", r.status);
  const un = r.body?.counts?.unassigned ?? -1;
  const foreign = await prisma.conversation.count({ where: { clinicId, id: { notIn: fixtureIds } } });
  const foreignUn = await prisma.conversation.count({ where: { clinicId, id: { notIn: fixtureIds }, assigneeId: null, status: { not: "RESOLVED" } } });
  return { un, foreign, foreignUn };
}

async function sweep(): Promise<void> {
  await prisma.message.deleteMany({ where: { conversationId: { in: FIX.allConvs } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: ALL_STAFF } } });
  await prisma.conversation.deleteMany({ where: { id: { in: FIX.allConvs } } });
  await prisma.contact.deleteMany({ where: { id: { in: CT.map((c) => c.id) } } });
  await prisma.staffClinic.deleteMany({ where: { staffId: { in: ALL_STAFF } } });
  await prisma.staffUser.deleteMany({ where: { id: { in: ALL_STAFF } } });
  const left =
    (await prisma.conversation.count({ where: { id: { in: FIX.allConvs } } })) +
    (await prisma.contact.count({ where: { id: { in: CT.map((c) => c.id) } } })) +
    (await prisma.staffUser.count({ where: { id: { in: ALL_STAFF } } })) +
    (await prisma.staffClinic.count({ where: { staffId: { in: ALL_STAFF } } })) +
    (await prisma.message.count({ where: { conversationId: { in: FIX.allConvs } } }));
  check("cleanup 零殘留", left === 0, left);
}

async function main(): Promise<void> {
  console.log("T709: 停用員工釋放（3 條釋放 + 2 備註 + 公海+2 / 並發接手保留 / 兜底 sweep）");
  const probe = await fetch(`${BASE}/`, { redirect: "manual" }).catch(() => null);
  if (!probe || probe.status >= 500) fail("server 未 live（3100）", probe?.status);
  ok("server live");

  const tkw = await prisma.clinic.findFirst({ where: { code: "TKW" } });
  const wtc = await prisma.clinic.findFirst({ where: { code: "WTC" } });
  const staffTkw = await prisma.staffUser.findFirst({ where: { email: "staff-tkw@wa-clinic.local" } });
  const adminRow = await prisma.staffUser.findFirst({ where: { role: "ADMIN", active: true } });
  if (!tkw || !wtc || !staffTkw || !adminRow) fail("TKW/WTC/staff-tkw/admin 搵唔到");

  const adminCookie = await cookieFor("admin@wa-clinic.local", readCredLine("ADMIN"));
  const tkwCookie = await cookieFor("staff-tkw@wa-clinic.local", readCredLine("TKW STAFF"));
  ok("admin + staff-tkw login");

  // ── A：3 條（1 跨店 / 1 RESOLVED）→ 停用 → 3 null / 2 備註 / 公海 +2 ──
  console.log("\n[A] 停用有 3 條嘅員工");
  await mkStaff(FIX.staff1, "t709a@wa-clinic.local", tkw.id);
  await mkConv(FIX.convA1, tkw.id, 0, { assigneeId: FIX.staff1 });
  await mkConv(FIX.convA2, wtc.id, 1, { assigneeId: FIX.staff1 }); // 跨店（WTC）
  await mkConv(FIX.convA3, tkw.id, 2, { assigneeId: FIX.staff1, status: "RESOLVED" });
  const bT = await poolStats(adminCookie, tkw.id, FIX.allConvs);
  const bW = await poolStats(adminCookie, wtc.id, FIX.allConvs);

  const putA = await api(adminCookie, `/api/admin/staff/${FIX.staff1}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ active: false }),
  });
  check("A：PUT active=false → 200", putA.status === 200, putA);
  const [c1, c2, c3] = await Promise.all([
    prisma.conversation.findUnique({ where: { id: FIX.convA1 }, select: { assigneeId: true, assignVersion: true, status: true } }),
    prisma.conversation.findUnique({ where: { id: FIX.convA2 }, select: { assigneeId: true, status: true } }),
    prisma.conversation.findUnique({ where: { id: FIX.convA3 }, select: { assigneeId: true, status: true } }),
  ]);
  check("A：3 條 assigneeId 全部 = null", !c1?.assigneeId && !c2?.assigneeId && !c3?.assigneeId, { c1, c2, c3 });
  check("A：convA1 assignVersion +1（樂觀鎖留痕）", (c1?.assignVersion ?? 0) >= 1, c1);
  const [n1, n2, n3] = await Promise.all([noteCount(FIX.convA1), noteCount(FIX.convA2), noteCount(FIX.convA3)]);
  check("A：2 條 OPEN 有 INTERNAL 備註（RESOLVED 唔落）", n1 === 1 && n2 === 1 && n3 === 0, { n1, n2, n3 });
  const noteSender = await prisma.message.findFirst({
    where: { conversationId: FIX.convA1, body: NOTE_BODY },
    select: { sentByStaffId: true },
  });
  check("A：備註 sentByStaffId = 操作 admin", noteSender?.sentByStaffId === adminRow.id, noteSender);
  const aT = await poolStats(adminCookie, tkw.id, FIX.allConvs);
  const aW = await poolStats(adminCookie, wtc.id, FIX.allConvs);
  // 自家貢獻 = 全局 delta − 外部漂移（必 = +1 每店；RESOLVED 唔計公海）
  const myT = (aT.un - bT.un) - (aT.foreignUn - bT.foreignUn);
  const myW = (aW.un - bW.un) - (aW.foreignUn - bW.foreignUn);
  check(
    "A：公海 +2（TKW +1 / WTC +1 — RESOLVED 唔計；外部漂移已分解）",
    myT === 1 && myW === 1,
    { myT, myW, extDrift: { tkw: aT.foreignUn - bT.foreignUn, wtc: aW.foreignUn - bW.foreignUn }, raw: { bT: bT.un, aT: aT.un, bW: bW.un, aW: aW.un } },
  );
  const auditA = await prisma.auditLog.findFirst({
    where: { action: "STAFF_DISABLED_RELEASE", entityId: FIX.staff1 },
    select: { meta: true },
  });
  check("A：audit STAFF_DISABLED_RELEASE meta.released=3", (auditA?.meta as { released?: number } | null)?.released === 3, auditA?.meta);

  // ── B：並發 — 停用同時 staff-tkw 接手其中一條 → 接手結果保留 ──
  console.log("\n[B] 並發接手（updateMany 自指條件驗證）");
  const N_DUMMY = 40; // 拖長 transaction 循環窗口（40 × updateMany+note ≈ 180ms）→ 接手 burst 落喺窗口內概率極高
  await mkStaff(FIX.staff2, "t709b@wa-clinic.local", tkw.id);
  for (let i = 0; i < N_DUMMY; i++) await mkConv(FIX.dummies[i], tkw.id, 3 + i, { assigneeId: FIX.staff2 });
  await mkConv(FIX.convB4, tkw.id, 43, { assigneeId: FIX.staff2 }); // id 排序最後 → transaction 循環最後處理

  const disableB = api(adminCookie, `/api/admin/staff/${FIX.staff2}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ active: false }),
  });
  await sleep(25); // 快照已攞（findMany ~15ms）；transaction 循環仲喺 40 dummy 入面（窗口 ≈ 180ms）
  let takeStatus = 0;
  let attempts = 0;
  let takeOk = false;
  for (let i = 0; i < 8 && !takeOk; i++) {
    attempts++;
    if (i > 0) await sleep(30); // tight burst — 目標：第一撃落喺 [快照, convB4 updateMany] 窗口內
    const cur = await api(tkwCookie, `/api/conversations/${FIX.convB4}`);
    if (cur.status !== 200) fail("B：GET convB4 非 200", cur.status);
    const ver = cur.body?.conversation?.assignVersion as number;
    const r = await api(tkwCookie, `/api/conversations/${FIX.convB4}/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toStaffId: staffTkw.id, assignVersion: ver }),
    });
    takeStatus = r.status;
    if (r.status === 200) { takeOk = true; break; }
    if (r.status !== 409) fail("B：assign 意外狀態", r);
    // 409 = 同 release 撞車 — 重讀 version 再試
  }
  const putB = await disableB;
  check("B：PUT active=false → 200", putB.status === 200, putB);
  check("B：接手最終成功（takeover 落定）", takeOk, { takeStatus, attempts });
  const c4 = await prisma.conversation.findUnique({ where: { id: FIX.convB4 }, select: { assigneeId: true, status: true, routedStaffId: true } });
  check("B：★ 接手結果保留（convB4 assignee = staff-tkw）", c4?.assigneeId === staffTkw.id, c4);
  check("B：convB4 仍然 OPEN", c4?.status === "OPEN", c4);
  const dummiesReleased = await prisma.conversation.count({ where: { id: { in: FIX.dummies.slice(0, N_DUMMY) }, assigneeId: null } });
  check(`B：${N_DUMMY} dummy 全部釋放回公海`, dummiesReleased === N_DUMMY, dummiesReleased);
  const auditB = await prisma.auditLog.findFirst({
    where: { action: "STAFF_DISABLED_RELEASE", entityId: FIX.staff2 },
    select: { meta: true },
  });
  const relB = (auditB?.meta as { released?: number } | null)?.released;
  check(`B：audit released ∈ {${N_DUMMY},${N_DUMMY + 1}}（convB4 有冇俾自指條件擋住）`, relB === N_DUMMY || relB === N_DUMMY + 1, relB);
  const n4 = await noteCount(FIX.convB4);
  console.log(`  ℹ️ B 子場景：released=${relB}、convB4 備註=${n4}（${N_DUMMY}+0 = ★ 自指條件擋住 release — 核心驗證；${N_DUMMY + 1}+1 = release 贏咗 race 先接手 — 都正確）`);

  // ── D：兜底 cron sweep（runDisabledAssigneeSweep 直調 — 同 cron auto-release case 同一入口）──
  console.log("\n[D] 兜底 sweep（DB 直接 active=false 嘅歷史殘留）");
  await mkStaff(FIX.staff3, "t709c@wa-clinic.local", tkw.id, false);
  await mkConv(FIX.convD, tkw.id, 44, { assigneeId: FIX.staff3 });
  const sweepR = await runDisabledAssigneeSweep();
  check("D：sweep released ≥ 1", sweepR.released >= 1, sweepR);
  const cD = await prisma.conversation.findUnique({ where: { id: FIX.convD }, select: { assigneeId: true, assignVersion: true } });
  check("D：convD 釋放回公海", cD?.assigneeId === null, cD);
  const noteD = await prisma.message.findFirst({
    where: { conversationId: FIX.convD, body: NOTE_BODY, sentByStaffId: null },
    select: { sentByStaffId: true },
  });
  check("D：備註 sentByStaffId = null（無真人）", noteD !== null, noteD);

  await sweep();
  console.log("T709-OK: 停用員工釋放（3 null / 2 備註 / 公海+2 / 並發接手保留 / 兜底 sweep）");
  process.exit(0);
}

main().catch((e) => {
  console.error(`T709-FAIL: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});

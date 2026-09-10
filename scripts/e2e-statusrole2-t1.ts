/**
 * cwi-statusrole2-20260910 T1 — e2e：膠囊兩行六粒 + 三計數不變式 + PENDING 歸零
 *
 * 覆蓋（MD §1/§2/§1.2）：
 * - T240：膠囊第一行五粒（全部/公海/派俾我/我負責/待跟進）+「睇已解決 →」細字；
 *   處理中/等回覆 pill 膠囊唔再出現；公海橙、派俾我 brand 邊框；<400px 待跟進併入 ⋯ 選單
 * - T241：三計數（unassigned/mine/routed）× 三 scope（ADMIN 全店 / ADMIN 單店 / STAFF 多店）
 *   不變式全過；跨店 assignee 計入 mine（WTC 對話 assignee=staff-tkw → staff-tkw mine 必見）
 * - T248：PENDING migration 後 DB 歸零；側欄狀態切換器只兩選項（處理中/已解決）；
 *   GET /api/conversations?status=PENDING 舊 link 200
 * - 迴歸（cwi-inboxfix T200–T211 coverage mapping — 舊單 script 未遺留，以下 R-* 逐項對應）：
 *   R-1 assigned=unassigned 公海嚴格 scope（I-2：外店線漏唔入）
 *   R-2 assigned=mine 跨店線保留（A.3）
 *   R-3 assigned=routed 語義（R-2 鐵律：routed* 唔改 assignee）
 *   R-4 STAFF 砌別店 clinicId → 403（RBAC 鐵律）
 *   R-5 status filter OPEN/RESOLVED/PENDING
 *   R-6 urgent 排序頂（Phase 2 鐵律）
 *   R-7 無 counts=1 → 舊 client 兼容（純陣列回應）
 *
 * 前置：dev stack live（server 3100 + worker + DB 15432 + Redis）
 * 用法（repo root）：pnpm tsx scripts/e2e-statusrole2-t1.ts
 * 輸出：STATUSROLE2-T1-OK / STATUSROLE2-T1-FAIL: <reason>
 * fixture：`sr2t1` 前綴 id + email — 段尾 hermetic sweep（assert 零殘留）
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";

const REPO = path.join(import.meta.dirname, "..");
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:3100";
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
  staffEmail: "sr2t1-e2e@wa-clinic.local",
  staffPassword: "Sr2t1-E2e-Passw0rd!x",
  groupCode: "SR2T1",
  contactPrefix: "sr2t1ccontact",
  convPrefix: "sr2t1conv",
  conv: {
    pool: "sr2t1convpool00000000001",
    mine: "sr2t1convmine00000000002",
    rstaff: "sr2t1convrstaff0000000003",
    rgrp: "sr2t1convrgrp00000000004",
    cross: "sr2t1convcross0000000005",
    resPool: "sr2t1convrespool000000006",
    resMine: "sr2t1convresmine00000007",
    mfMine: "sr2t1convmfmine00000008",
    urgent: "sr2t1convurgent00000009",
  },
};

interface Ctx {
  tkwId: string;
  wtcId: string;
  mfId: string;
  staffTkwId: string;
  fixStaffId: string;
  fixGroupId: string;
}

async function setupFixtures(): Promise<Ctx> {
  // 逐個 findFirst — findMany({in:[]}) 順序唔保證（cwi-statusrole2 T1 實測陷阱）
  const tkw = await prisma.clinic.findFirst({ where: { code: "TKW" } });
  const wtc = await prisma.clinic.findFirst({ where: { code: "WTC" } });
  const mf = await prisma.clinic.findFirst({ where: { code: "MF" } });
  if (!tkw || !wtc || !mf) fail("clinic TKW/WTC/MF 搵唔到");
  const staffTkw = await prisma.staffUser.findFirst({ where: { email: "staff-tkw@wa-clinic.local" } });
  if (!staffTkw) fail("staff-tkw 搵唔到");

  // 多店 STAFF（TKW primary + MF）— 三 scope 嘅 STAFF 多店場景
  let fixStaff = await prisma.staffUser.findUnique({ where: { email: FIX.staffEmail } });
  if (!fixStaff) {
    fixStaff = await prisma.staffUser.create({
      data: {
        email: FIX.staffEmail,
        passwordHash: await argon2.hash(FIX.staffPassword),
        name: "SR2T1 E2E Staff",
        role: "STAFF",
      },
    });
    await prisma.staffClinic.createMany({
      data: [
        { staffId: fixStaff.id, clinicId: tkw.id, isPrimary: true },
        { staffId: fixStaff.id, clinicId: mf.id, isPrimary: false },
      ],
    });
  }
  // 技能組 + 成員（routedGroupId 場景）
  let grp = await prisma.skillGroup.findUnique({ where: { code: FIX.groupCode } });
  if (!grp) {
    grp = await prisma.skillGroup.create({ data: { name: "SR2T1 測試組", code: FIX.groupCode } });
  }
  const member = await prisma.skillGroupMember.findUnique({
    where: { groupId_staffId: { groupId: grp.id, staffId: fixStaff.id } },
  });
  if (!member) await prisma.skillGroupMember.create({ data: { groupId: grp.id, staffId: fixStaff.id } });

  // contacts + conversations（idempotent：已存在 skip）
  const mkContact = async (key: string, clinicId: string, waId: string, name: string): Promise<string> => {
    const id = `${FIX.contactPrefix}${key}0000`.slice(0, 24);
    const existing = await prisma.contact.findFirst({ where: { id } });
    if (existing) return existing.id;
    return (await prisma.contact.create({ data: { id, clinicId, waId, profileName: name, labels: [] } })).id;
  };
  const mkConv = async (id: string, clinicId: string, contactId: string, extra: Record<string, unknown>): Promise<void> => {
    const existing = await prisma.conversation.findUnique({ where: { id } });
    if (existing) return;
    const now = new Date();
    await prisma.conversation.create({
      data: { id, clinicId, contactId, lastMessageAt: now, lastInboundAt: now, ...extra },
    });
  };

  const contacts: Record<string, string> = {
    pool: await mkContact("pool", tkw.id, "85299010001", "SR2T1 Pool"),
    mine: await mkContact("mine", tkw.id, "85299010002", "SR2T1 Mine"),
    rstaff: await mkContact("rstaff", tkw.id, "85299010003", "SR2T1 RStaff"),
    rgrp: await mkContact("rgrp", tkw.id, "85299010004", "SR2T1 RGrp"),
    cross: await mkContact("cross", wtc.id, "85299010005", "SR2T1 Cross"),
    respool: await mkContact("respool", tkw.id, "85299010006", "SR2T1 ResPool"),
    resmine: await mkContact("resmine", tkw.id, "85299010007", "SR2T1 ResMine"),
    mfmine: await mkContact("mfmine", mf.id, "85299010008", "SR2T1 MfMine"),
    urgent: await mkContact("urgent", tkw.id, "85299010009", "SR2T1 Urgent"),
  };
  await mkConv(FIX.conv.pool, tkw.id, contacts.pool, {}); // 公海（TKW 未指派）
  await mkConv(FIX.conv.mine, tkw.id, contacts.mine, { assigneeId: fixStaff.id });
  await mkConv(FIX.conv.rstaff, tkw.id, contacts.rstaff, {
    assigneeId: null,
    routedStaffId: fixStaff.id,
    routedAt: new Date(),
  });
  await mkConv(FIX.conv.rgrp, tkw.id, contacts.rgrp, {
    assigneeId: null,
    routedGroupId: grp.id,
    routedAt: new Date(),
  });
  // ★ 跨店 assignee：WTC 對話 assignee = staff-tkw（TKW 專員）
  await mkConv(FIX.conv.cross, wtc.id, contacts.cross, { assigneeId: staffTkw.id });
  await mkConv(FIX.conv.resPool, tkw.id, contacts.respool, { status: "RESOLVED" });
  await mkConv(FIX.conv.resMine, tkw.id, contacts.resmine, { status: "RESOLVED", assigneeId: fixStaff.id });
  await mkConv(FIX.conv.mfMine, mf.id, contacts.mfmine, { assigneeId: fixStaff.id });
  // R-6：urgent 鐵律排序（lastMessageAt 故意舊 1 小時 — 都要排頂）
  await mkConv(FIX.conv.urgent, tkw.id, contacts.urgent, {
    urgent: true,
    urgency: "HIGH",
    lastMessageAt: new Date(Date.now() - 3600_000),
  });

  return { tkwId: tkw.id, wtcId: wtc.id, mfId: mf.id, staffTkwId: staffTkw.id, fixStaffId: fixStaff.id, fixGroupId: grp.id };
}

async function sweep(): Promise<void> {
  const convs = await prisma.conversation.findMany({ where: { id: { startsWith: FIX.convPrefix } } });
  if (convs.length > 0) await prisma.conversation.deleteMany({ where: { id: { startsWith: FIX.convPrefix } } });
  const contacts = await prisma.contact.findMany({ where: { id: { startsWith: FIX.contactPrefix } } });
  if (contacts.length > 0) await prisma.contact.deleteMany({ where: { id: { startsWith: FIX.contactPrefix } } });
  const grp = await prisma.skillGroup.findUnique({ where: { code: FIX.groupCode } });
  if (grp) {
    await prisma.skillGroupMember.deleteMany({ where: { groupId: grp.id } });
    await prisma.skillGroup.delete({ where: { id: grp.id } });
  }
  const staff = await prisma.staffUser.findUnique({ where: { email: FIX.staffEmail } });
  if (staff) {
    await prisma.staffClinic.deleteMany({ where: { staffId: staff.id } });
    await prisma.staffUser.delete({ where: { id: staff.id } });
  }
  const left =
    (await prisma.conversation.count({ where: { id: { startsWith: FIX.convPrefix } } })) +
    (await prisma.contact.count({ where: { id: { startsWith: FIX.contactPrefix } } })) +
    (await prisma.skillGroup.count({ where: { code: FIX.groupCode } })) +
    (await prisma.staffUser.count({ where: { email: FIX.staffEmail } }));
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
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = setCookie.match(/wa_inbox_session=([^;]+)/);
  if (!m) throw new Error("login 冇 wa_inbox_session cookie");
  return m[1];
}
// login 限流 5 次/60s/IP — e2e 重跑多輪會 429；cookie 有效就重用（/tmp cache）
const COOKIE_CACHE = "/tmp/w-statusrole2-e2e-cookies.json";
async function cookieFor(email: string, password: string, cacheKey?: string): Promise<string> {
  const key = cacheKey ?? email;
  try {
    const cache = JSON.parse(readFileSync(COOKIE_CACHE, "utf8")) as Record<string, string>;
    if (cache[key]) {
      const probe = await api(cache[key], "?counts=1");
      if (probe.status === 200) return cache[key];
    }
  } catch {
    /* 無 cache — fallthrough login */
  }
  const c = await login(email, password);
  let next: Record<string, string> = {};
  try {
    next = JSON.parse(readFileSync(COOKIE_CACHE, "utf8")) as Record<string, string>;
  } catch {
    /* first write */
  }
  next[key] = c;
  writeFileSync(COOKIE_CACHE, JSON.stringify(next));
  return c;
}
async function api(cookie: string, qs: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}/api/conversations${qs}`, { headers: { cookie: `wa_inbox_session=${cookie}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}
type Item = {
  id: string;
  clinicId: string;
  status: string;
  assigneeId: string | null;
  routedStaffId: string | null;
  routedGroupId: string | null;
  urgent: boolean;
  contact: { profileName: string | null; waId: string } | null;
};
type Counts = { all: number; unassigned: number; mine: number; routed: number; pending: number; resolved: number };
function parseList(body: unknown): { items: Item[]; counts: Counts | null } {
  if (Array.isArray(body)) return { items: body as Item[], counts: null };
  const o = body as { items?: Item[]; counts?: Counts } | null;
  if (!o || !Array.isArray(o.items)) throw new Error(`unexpected list body: ${JSON.stringify(body)?.slice(0, 200)}`);
  return { items: o.items, counts: o.counts ?? null };
}
async function myGroupsOf(staffId: string): Promise<string[]> {
  const rows = await prisma.skillGroupMember.findMany({ where: { staffId }, select: { groupId: true } });
  return rows.map((r) => r.groupId);
}

// §2 不變式：count === 列表 filter(predicate).length（全部排除 RESOLVED）
function assertInvariants(label: string, items: Item[], counts: Counts, me: string, myGroups: string[]): void {
  const active = items.filter((i) => i.status !== "RESOLVED");
  const unassigned = active.filter((i) => i.assigneeId == null).length;
  const mine = active.filter((i) => i.assigneeId === me).length;
  const routed = active.filter(
    (i) => i.assigneeId == null && (i.routedStaffId === me || (i.routedGroupId != null && myGroups.includes(i.routedGroupId))),
  ).length;
  check(`${label} unassigned 不變式（${counts.unassigned} === ${unassigned}）`, counts.unassigned === unassigned, counts);
  check(`${label} mine 不變式（${counts.mine} === ${mine}）`, counts.mine === mine, counts);
  check(`${label} routed 不變式（${counts.routed} === ${routed}）`, counts.routed === routed, counts);
}

// ── T241：三計數 × 三 scope + 跨店 mine ──────────────────────────────────
async function t241(adminCookie: string, tkwCookie: string, fixCookie: string, ctx: Ctx): Promise<void> {
  console.log("\n[T241] 三計數不變式 × 三 scope + 跨店 assignee → mine");
  const adminRow = (await prisma.staffUser.findFirst({ where: { role: "ADMIN" } }))!;
  const scopes: { label: string; cookie: string; qs: string; me: string }[] = [
    { label: "ADMIN 全店", cookie: adminCookie, qs: "?counts=1", me: adminRow.id },
    { label: "ADMIN 單店(TKW)", cookie: adminCookie, qs: `?counts=1&clinicId=${ctx.tkwId}`, me: adminRow.id },
    { label: "STAFF 多店(TKW+MF)", cookie: fixCookie, qs: "?counts=1", me: ctx.fixStaffId },
  ];
  for (const s of scopes) {
    const { status, body } = await api(s.cookie, s.qs);
    if (status !== 200) fail(`${s.label} list → ${status}`);
    const { items, counts } = parseList(body);
    if (!counts) fail(`${s.label} counts 缺失`);
    assertInvariants(s.label, items, counts, s.me, await myGroupsOf(s.me));
  }

  // ★ 跨店 assignee 必計入 mine：staff-tkw（TKW 專員）睇 WTC 對話（assignee=staff-tkw）
  const { status: st2, body: b2 } = await api(tkwCookie, "?counts=1");
  if (st2 !== 200) fail("staff-tkw list → " + st2);
  const { items, counts } = parseList(b2);
  if (!counts) fail("staff-tkw counts 缺失");
  check("跨店線喺 staff-tkw 預設列表（A.3 assignee 支路）", items.some((i) => i.id === FIX.conv.cross));
  check("跨店線計入 staff-tkw mine（mine ≥ 1）", counts.mine >= 1, counts.mine);
  const mineFromList = items.filter((i) => i.assigneeId === ctx.staffTkwId && i.status !== "RESOLVED").length;
  check("staff-tkw mine 不變式（跨店 scope）", counts.mine === mineFromList, { counts: counts.mine, mineFromList });
  assertInvariants("STAFF 單店(staff-tkw)", items, counts, ctx.staffTkwId, await myGroupsOf(ctx.staffTkwId));

  // RESOLVED 排除口徑：RESOLVED 公海線喺列表（顯示）但唔計入三計數
  const { status: st3, body: b3 } = await api(fixCookie, "?counts=1");
  if (st3 !== 200) fail("fix staff list → " + st3);
  const { items: i3, counts: c3 } = parseList(b3);
  if (!c3) fail("fix staff counts 缺失");
  check("RESOLVED 公海線喺列表（預設列表照顯示）", i3.some((i) => i.id === FIX.conv.resPool));
  const unassignedList = i3.filter((i) => i.assigneeId == null && i.status !== "RESOLVED").length;
  check("RESOLVED 線唔計入 unassigned（排除口徑）", c3.unassigned === unassignedList, { c3: c3.unassigned, unassignedList });
}

// ── T248：PENDING 歸零 + 舊 link 相容 ─────────────────────────────────────
async function t248Api(adminCookie: string): Promise<void> {
  console.log("\n[T248] PENDING migration 歸零 + 舊 link 相容");
  const pendingRows = await prisma.conversation.count({ where: { status: "PENDING" } });
  check("DB status=PENDING 歸零", pendingRows === 0, pendingRows);
  const enumRows = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int n FROM information_schema.columns WHERE table_name='Conversation' AND column_name='status'`,
  );
  check("status 欄存在（enum 保留，純資料 migration）", enumRows[0]?.n === 1);
  const { status, body } = await api(adminCookie, "?status=PENDING");
  check("GET ?status=PENDING 舊 link 200", status === 200, body);
  const arr = Array.isArray(body) ? body : null;
  check("舊 link 回純陣列（舊 client 兼容）", arr !== null, typeof body);
  check("舊 link PENDING 結果 = 空（DB 已歸零）", arr?.length === 0, arr?.length);
  const { body: cbody } = await api(adminCookie, "?counts=1&status=PENDING");
  const c = (cbody as { counts?: Counts } | null)?.counts;
  check("counts.pending = 0", c?.pending === 0, c);
}

// ── 迴歸（cwi-inboxfix coverage mapping）──────────────────────────────────
async function regressions(tkwCookie: string, fixCookie: string, ctx: Ctx): Promise<void> {
  console.log("\n[REG] cwi-inboxfix T200–T211 coverage mapping 迴歸");
  const tkwGroups = await myGroupsOf(ctx.staffTkwId);
  // R-4：STAFF 砌別店 clinicId → 403
  const r4 = await api(tkwCookie, `?clinicId=${ctx.wtcId}`);
  check("R-4 STAFF 別店 clinicId → 403", r4.status === 403, r4.status);
  // R-1：公海嚴格 scope — staff-tkw 只見到 TKW 未指派（外店未指派漏唔入）
  const r1 = await api(tkwCookie, "?assigned=unassigned");
  if (r1.status !== 200) fail("R-1 list → " + r1.status);
  const l1 = parseList(r1.body);
  check("R-1 公海列表全未指派", l1.items.every((i) => i.assigneeId == null));
  check("R-1 公海列表全 TKW（I-2 鐵律）", l1.items.every((i) => i.clinicId === ctx.tkwId));
  check("R-1 公海包含 fixture 公海線", l1.items.some((i) => i.id === FIX.conv.pool));
  // R-2：mine 跨店線保留
  const r2 = await api(tkwCookie, "?assigned=mine");
  if (r2.status !== 200) fail("R-2 list → " + r2.status);
  const l2 = parseList(r2.body);
  check("R-2 mine 列表全 assignee=staff-tkw", l2.items.every((i) => i.assigneeId === ctx.staffTkwId));
  check("R-2 mine 包含跨店 WTC 線", l2.items.some((i) => i.id === FIX.conv.cross));
  // R-3：routed 語義（未指派 ∧ routed 標記）
  const r3 = await api(tkwCookie, "?assigned=routed");
  if (r3.status !== 200) fail("R-3 list → " + r3.status);
  const l3 = parseList(r3.body);
  check("R-3 routed 列表全未指派", l3.items.every((i) => i.assigneeId == null));
  check(
    "R-3 routed 列表全 routed 俾 staff-tkw",
    l3.items.every((i) => i.routedStaffId === ctx.staffTkwId || (i.routedGroupId != null && tkwGroups.includes(i.routedGroupId))),
    l3.items,
  );
  // R-5：status filter
  const r5a = await api(fixCookie, "?status=RESOLVED");
  if (r5a.status !== 200) fail("R-5a → " + r5a.status);
  check("R-5 ?status=RESOLVED 全 RESOLVED", parseList(r5a.body).items.every((i) => i.status === "RESOLVED"));
  const r5b = await api(fixCookie, "?status=OPEN");
  if (r5b.status !== 200) fail("R-5b → " + r5b.status);
  check("R-5 ?status=OPEN 全 OPEN", parseList(r5b.body).items.every((i) => i.status === "OPEN"));
  // R-6：urgent 排序頂
  const r6 = await api(tkwCookie, "?assigned=unassigned");
  const l6 = parseList(r6.body);
  check("R-6 urgent 線排頂（Phase 2 鐵律）", l6.items[0]?.id === FIX.conv.urgent, l6.items[0]?.id);
  // R-7：無 counts=1 → 純陣列
  const r7 = await api(fixCookie, "");
  check("R-7 無 counts=1 回純陣列", Array.isArray(r7.body));
}

// ── T240：UI（playwright）────────────────────────────────────────────────
// repo 慣例（e2e-notify-ui.ts）：playwright-core 用最小結構類型（無 any）
interface LocatorLike {
  count: () => Promise<number>;
  nth: (i: number) => LocatorLike;
  waitFor: (o?: Record<string, unknown>) => Promise<unknown>;
  click: (o?: Record<string, unknown>) => Promise<void>;
  getAttribute: (n: string) => Promise<string | null>;
  evaluate: <T>(fn: (el: Element) => T) => Promise<T>;
  locator: (sel: string, o?: Record<string, unknown>) => LocatorLike;
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

async function t240Ui(adminCookie: string): Promise<void> {
  console.log("\n[T240] UI：膠囊兩行 + 溢出選單 + 已解決連結");
  /* eslint-disable @typescript-eslint/no-require-imports -- repo 慣例：playwright-core 從 openclaw global node_modules 載入 */
  const { chromium } = require("/usr/lib/node_modules/openclaw/node_modules/playwright-core") as PwChromium;
  const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });
  try {
    // ── 桌面 viewport（1280×900）──
    const ctxPw = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctxPw.newPage();
    await ctxPw.addCookies([{ name: "wa_inbox_session", value: adminCookie, domain: "127.0.0.1", path: "/" }]);
    await page.goto(`${BASE}/inbox`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    const capsuleRow = page.locator('[data-e2e="capsule-row"]');
    await capsuleRow.waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1200); // counts fetch 順帶

    const nCaps = await capsuleRow.locator("button").count();
    check("第一行五粒膠囊", nCaps === 5, nCaps);
    for (const re of [/^全部$/, /^公海 \d+$/, /^派俾我 \d+$/, /^我負責 \d+$/, /^待跟進 0$/]) {
      const has = await capsuleRow.locator("button", { hasText: re }).count();
      check(`膠囊存在：${re}`, has === 1, has);
    }
    // 處理中/等回覆 pill 膠囊剷除
    check("處理中 pill 膠囊唔存在", (await page.locator("button.rounded-full", { hasText: "處理中" }).count()) === 0);
    check("等回覆 pill 膠囊唔存在", (await page.locator("button.rounded-full", { hasText: "等回覆" }).count()) === 0);
    // 「睇已解決 →」細字連結
    check("「睇已解決 →」細字連結存在", (await page.locator('[data-e2e="status-toggle"]', { hasText: "睇已解決 →" }).count()) === 1);
    // 公海橙 / 派俾我 brand 邊框
    const poolCls = (await capsuleRow.locator("button", { hasText: /^公海/ }).getAttribute("class")) ?? "";
    check("公海 = 橙色（bg-warn）", poolCls.includes("bg-warn"), poolCls);
    const routedCls = (await capsuleRow.locator("button", { hasText: /^派俾我/ }).getAttribute("class")) ?? "";
    check("派俾我 = 重點色邊框（border-brand）", routedCls.includes("border-brand"), routedCls);
    // 狀態切換器 = 兩選項
    check("狀態切換器只兩選項（T248 UI）", (await page.locator('[data-e2e="status-toggle"] button').count()) === 2);
    check("切換器冇「等回覆」選項", (await page.locator('[data-e2e="status-toggle"]', { hasText: "等回覆" }).count()) === 0);
    // 橫向捲檢查（1280 desktop）
    const overflowDesk = await capsuleRow.evaluate((el: Element) => (el as HTMLElement).scrollWidth - (el as HTMLElement).clientWidth);
    check("desktop：膠囊行無橫向捲", overflowDesk <= 0, overflowDesk);
    await page.screenshot({ path: "/tmp/kairo-statusrole2-t1-1-capsules.png" });
    ok("screenshot 1: /tmp/kairo-statusrole2-t1-1-capsules.png");

    // 已解決連結展開：撳一次 = RESOLVED 視圖（再撳一次會返 ALL — attempt-2 根治：
    // 舊版連撳兩下令 filter ALL→RESOLVED→ALL，斷言時已返 ALL → 公海線顯示假紅）
    await page.locator('button', { hasText: /^睇已解決/ }).click();
    await page.waitForTimeout(800);
    check("撳「睇已解決 →」後顯示 RESOLVED 線", (await page.getByText("SR2T1 ResPool").count()) >= 1);
    const poolMatches = page.getByText("SR2T1 Pool");
    const poolN = await poolMatches.count();
    if (!process.env.E2E_NO_DEBUG_DOM && poolN > 0) {
      // debug：邊個 element match 到（應 0 — 排查假陽性來源）
      for (let i = 0; i < poolN; i++) {
        const info = await poolMatches
          .nth(i)
          .evaluate((e: Element) => ({
            tag: e.tagName,
            cls: ((e as HTMLElement).className ?? "").toString().slice(0, 100),
            text: (e.textContent ?? "").slice(0, 80),
            visible: (e as HTMLElement).getBoundingClientRect().width > 0,
          }));
        console.log(`    [debug] SR2T1 Pool match#${i}: ${JSON.stringify(info)}`);
      }
    }
    check("撳「睇已解決 →」後公海線唔顯示", poolN === 0, poolN);
    await page.screenshot({ path: "/tmp/kairo-statusrole2-t1-2-resolved.png" });
    ok("screenshot 2: /tmp/kairo-statusrole2-t1-2-resolved.png");
    await page.locator('button', { hasText: /^睇已解決/ }).click(); // 返轉去
    await page.waitForTimeout(300);
    await ctxPw.close();

    // ── 手機 <400px（375×700）──
    const ctxM = await browser.newContext({ viewport: { width: 375, height: 700 } });
    const pageM = await ctxM.newPage();
    await ctxM.addCookies([{ name: "wa_inbox_session", value: adminCookie, domain: "127.0.0.1", path: "/" }]);
    await pageM.goto(`${BASE}/inbox`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    const rowM = pageM.locator('[data-e2e="capsule-row"]');
    await rowM.waitFor({ timeout: 30_000 });
    await pageM.waitForTimeout(1200);
    check("<400px：待跟進 唔喺第一行", (await rowM.locator("button", { hasText: "待跟進" }).count()) === 0);
    check("<400px：第一行 = 4 膠囊 + ⋯（5 按鈕）", (await rowM.locator("button").count()) === 5, await rowM.locator("button").count());
    const moreBtn = rowM.locator("button", { hasText: "⋯" });
    check("<400px：⋯ 溢出按鈕存在", (await moreBtn.count()) === 1);
    await moreBtn.click();
    await pageM.waitForTimeout(300);
    check("<400px：⋯ 選單有「待跟進 0」", (await pageM.getByText("待跟進 0", { exact: true }).count()) >= 1);
    const overflowM = await rowM.evaluate((el: Element) => (el as HTMLElement).scrollWidth - (el as HTMLElement).clientWidth);
    check("<400px：無橫向捲（scrollWidth ≤ clientWidth）", overflowM <= 0, overflowM);
    await pageM.screenshot({ path: "/tmp/kairo-statusrole2-t1-3-overflow.png" });
    ok("screenshot 3: /tmp/kairo-statusrole2-t1-3-overflow.png");
    await ctxM.close();
  } finally {
    await browser.close();
  }
}

// ── main ─────────────────────────────────────────────────────────────────
function readCredLine(label: string): string {
  const file = path.join(REPO, ".dev", "credentials.txt");
  const lines = readFileSync(file, "utf8").split("\n");
  const l = lines.find((x) => x.startsWith(`${label}:`));
  if (!l) throw new Error(`credentials.txt 冇 ${label}`);
  return l.split(" / ")[1];
}

async function main(): Promise<void> {
  console.log(`STATUSROLE2-T1 e2e — base=${BASE}`);
  const probe = await fetch(`${BASE}/`, { redirect: "manual" }).catch(() => null);
  if (!probe || probe.status >= 500) fail("server 未 live（3100）", probe?.status);
  ok("server live");

  const ctx = await setupFixtures();
  ok(`fixtures ready（fixStaff=${ctx.fixStaffId.slice(0, 8)}… grp=${ctx.fixGroupId.slice(0, 8)}…）`);
  const adminCookie = await cookieFor("admin@wa-clinic.local", readCredLine("ADMIN"));
  const tkwCookie = await cookieFor("staff-tkw@wa-clinic.local", readCredLine("TKW STAFF"));
  // fixture staff 每輪 recreate — cache key 必帶 userId（stale session 會令 server 計數跟舊 id → mine 假紅）
  const fixCookie = await cookieFor(FIX.staffEmail, FIX.staffPassword, `${FIX.staffEmail}:${ctx.fixStaffId}`);
  ok("login ×3");

  try {
    await t241(adminCookie, tkwCookie, fixCookie, ctx);
    await t248Api(adminCookie);
    await regressions(tkwCookie, fixCookie, ctx);
    await t240Ui(adminCookie);
  } finally {
    await sweep();
  }
  console.log("\nSTATUSROLE2-T1-OK");
}

main()
  .then(async () => {
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(`STATUSROLE2-T1-FAIL: ${e instanceof Error ? e.message : e}`);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });

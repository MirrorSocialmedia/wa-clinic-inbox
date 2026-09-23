/**
 * e2e-s12-t700 — cwi-final S1-2 T700/T701/T702/T703/T725：STAFF fail-closed 公海／派俾我 跨店隔離
 *
 * 設計（接盤單 #5 / handover2 Gates 3）：
 *  - STAFF X：CLINICS 綁 TKW，屬技能組 G；STAFF Y：CLINICS 綁 TKW，無技能組（fail-closed 對照）
 *  - fixture 9 條 OPEN（contact waId 990614xx）：
 *      C1 MF  未指派 routedGroupId=G     → X: base✓ routed✓ 公海✗
 *      C2 WTC 未指派 無路由               → X: 全✗
 *      C3 WTC 未指派 routedStaffId=X     → X: base✓ routed✓ 公海✗
 *      C4 WTC 未指派 routedGroupId=H     → X: 全✗（H 非 X 組）
 *      C5 TKW 未指派 無路由               → X: base✓ 公海✓ routed✗
 *      C6 MF  assignee=X                 → X: base✓ mine✓
 *      C7 WTC 未指派 routedStaffId=Y     → Y: base✓ routed✓；X: 全✗
 *      C8 WTC 未指派 routedGroupId=G     → X: base✓ routed✓；Y: 全✗（Y 無組 = fail-closed）
 *      C9 WTC assignee=Y                 → Y: base✓ mine；X: 全✗
 *  斷言：
 *   T700 X base list：C1/C3/C5/C6/C8 ∈，C2/C4/C7/C9 ∉ + 每行滿足 baseScope（clinic∨assignee∨routed）零外溢
 *   T701 X ?assigned=unassigned（公海）：每行 clinicId=TKW ∧ assigneeId=null；C5 ∈；C1/C3/C8 ∉（跨店未指派唔入公海，I-2）
 *   T702 X ?assigned=routed（派俾我）：=== 恰 {C1,C3,C8}（X 新用戶 + G/H 新組 → 零既有數據）
 *   T703 counts 不變式（同 predicate 三處同源）：all=|items| / unassigned=|公海 filter| / mine / routed / resolved=DB / followup / pending=0
 *   T725 Y（無組 fail-closed）：C7/C9 ∈；C1/C3/C8 ∉（組支路閉合，唔放寬）；routed === {C7}；公海每行 clinicId=TKW
 *
 * 前置：dev stack live（server 3100 + DB 15432）。
 * 用法（repo root）：pnpm tsx scripts/e2e-s12-t700.ts
 * 輸出：T700-OK / T700-FAIL: <reason>（exit 1）
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

const G_CODE = "E2ES12RG";
const H_CODE = "E2ES12RH";
const X_EMAIL = "e2e-s12rx@wa-clinic.local";
const Y_EMAIL = "e2e-s12ry@wa-clinic.local";
const PASS = "e2e-s12r-pass-2026";
const WA_PREFIX = "990614";

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
interface ItemRow {
  id: string;
  clinicId: string;
  status: string;
  assigneeId: string | null;
  routedStaffId?: string | null;
  routedGroupId?: string | null;
  followupDueAt?: string | null;
}
let FX: Record<string, string> = {}; // C1..C9 → id
let X_ID = "";
let Y_ID = "";
let G_ID = "";
let TKW = "";
let MF = "";
let WTC = "";

async function cleanupFirst(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `DELETE FROM "Message" WHERE "conversationId" IN (SELECT c.id FROM "Conversation" c JOIN "Contact" ct ON ct.id = c."contactId" WHERE ct."waId" LIKE '${WA_PREFIX}%')`
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "Conversation" WHERE "contactId" IN (SELECT id FROM "Contact" WHERE "waId" LIKE '${WA_PREFIX}%')`
  );
  await prisma.contact.deleteMany({ where: { waId: { startsWith: WA_PREFIX } } });
  await prisma.skillGroupMember.deleteMany({ where: { groupId: { in: [G_CODE, H_CODE] } } });
  await prisma.skillGroup.deleteMany({ where: { code: { in: [G_CODE, H_CODE] } } });
  await prisma.staffClinic.deleteMany({ where: { staff: { email: { in: [X_EMAIL, Y_EMAIL] } } } });
  await prisma.staffUser.deleteMany({ where: { email: { in: [X_EMAIL, Y_EMAIL] } } });
}

async function cleanupLast(): Promise<void> {
  await cleanupFirst();
}

async function seed(): Promise<void> {
  const clinics = await prisma.clinic.findMany({ where: { code: { in: ["TKW", "MF", "WTC"] } }, select: { id: true, code: true } });
  const byCode = Object.fromEntries(clinics.map((c) => [c.code, c.id]));
  TKW = byCode.TKW;
  MF = byCode.MF;
  WTC = byCode.WTC;
  if (!TKW || !MF || !WTC) throw new Error("clinic TKW/MF/WTC 缺失");

  G_ID = (await prisma.skillGroup.create({ data: { code: G_CODE, name: "E2ES12R G 組" } })).id;
  const H_ID = (await prisma.skillGroup.create({ data: { code: H_CODE, name: "E2ES12R H 組" } })).id;

  const argon2 = (await import("argon2")).default;
  const x = await prisma.staffUser.create({
    data: { email: X_EMAIL, name: "E2E S12R X", role: "STAFF", scopeType: "CLINICS", passwordHash: await argon2.hash(PASS) },
  });
  const y = await prisma.staffUser.create({
    data: { email: Y_EMAIL, name: "E2E S12R Y", role: "STAFF", scopeType: "CLINICS", passwordHash: await argon2.hash(PASS) },
  });
  X_ID = x.id;
  Y_ID = y.id;
  await prisma.staffClinic.create({ data: { staffId: X_ID, clinicId: TKW, isPrimary: true } });
  await prisma.staffClinic.create({ data: { staffId: Y_ID, clinicId: TKW, isPrimary: true } });
  await prisma.skillGroupMember.create({ data: { groupId: G_ID, staffId: X_ID } }); // Y 無組

  const defs: Array<[string, string, { assigneeId?: string; routedStaffId?: string; routedGroupId?: string }]> = [
    ["C1", MF, { routedGroupId: G_ID }],
    ["C2", WTC, {}],
    ["C3", WTC, { routedStaffId: X_ID }],
    ["C4", WTC, { routedGroupId: H_ID }],
    ["C5", TKW, {}],
    ["C6", MF, { assigneeId: X_ID }],
    ["C7", WTC, { routedStaffId: Y_ID }],
    ["C8", WTC, { routedGroupId: G_ID }],
    ["C9", WTC, { assigneeId: Y_ID }],
  ];
  const nowMs = Date.now();
  for (let i = 0; i < defs.length; i++) {
    const [key, clinicId, extra] = defs[i];
    const ct = await prisma.contact.create({
      data: { clinicId: TKW, waId: `${WA_PREFIX}${String(i).padStart(2, "0")}`, profileName: `E2E S12R ${key}`, labels: [] },
    });
    const cv = await prisma.conversation.create({
      data: {
        clinicId,
        contactId: ct.id,
        status: "OPEN",
        assigneeId: extra.assigneeId ?? null,
        routedStaffId: extra.routedStaffId ?? null,
        routedGroupId: extra.routedGroupId ?? null,
        lastMessageAt: new Date(nowMs - (defs.length - i) * 60_000),
      },
    });
    FX[key] = cv.id;
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

/** walk 完整列表（cursor 到盡）→ { items, counts } */
async function walkAll(cookie: string): Promise<{ items: ItemRow[]; counts: Record<string, number> | null }> {
  let cursor: string | null = null;
  let counts: Record<string, number> | null = null;
  const items: ItemRow[] = [];
  for (let p = 0; ; p++) {
    const url = `${BASE}/api/conversations?counts=${cursor === null ? 1 : 0}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await fetch(url, { headers: { cookie: `wa_inbox_session=${cookie}` } });
    if (r.status !== 200) throw new Error(`walk ${p + 1} → ${r.status}`);
    const body = (await r.json()) as { items: ItemRow[]; nextCursor: string | null; counts?: Record<string, number> };
    if (counts === null && body.counts) counts = body.counts;
    items.push(...body.items);
    cursor = body.nextCursor;
    if (cursor === null) break;
    if (p > 30) throw new Error("walk > 30 頁 — 異常");
  }
  return { items, counts };
}

async function getList(cookie: string, q: string): Promise<ItemRow[]> {
  const r = await fetch(`${BASE}/api/conversations${q}`, { headers: { cookie: `wa_inbox_session=${cookie}` } });
  if (r.status !== 200) throw new Error(`GET ${q} → ${r.status}`);
  return ((await r.json()) as { items: ItemRow[] }).items;
}

function inSet(ids: string[]): (item: ItemRow) => boolean {
  const s = new Set(ids);
  return (item) => s.has(item.id);
}

async function main(): Promise<void> {
  console.log("[T700-703/T725] STAFF fail-closed 公海／派俾我 跨店隔離");
  await cleanupFirst();
  await seed();
  const xCookie = await login(X_EMAIL);
  const yCookie = await login(Y_EMAIL);

  // ══ T700：X base list（跨店 routed 入 base；外溢零）══
  console.log("\n[T700] X base list：routed 跨店線入 base + 零外溢");
  const xAll = await walkAll(xCookie);
  const xIds = xAll.items.map((i) => i.id);
  check("T700 C1/MF/routedG ∈ base", inSet([FX.C1])(xAll.items.find((i) => i.id === FX.C1) ?? ({} as ItemRow)) && xIds.includes(FX.C1));
  check("T700 C3/WTC/routedX ∈ base", xIds.includes(FX.C3));
  check("T700 C5/TKW/公海 ∈ base", xIds.includes(FX.C5));
  check("T700 C6/MF/assigneeX ∈ base", xIds.includes(FX.C6));
  check("T700 C8/WTC/routedG(同組) ∈ base", xIds.includes(FX.C8));
  check("T700 C2/WTC/無路由 ∉ base", !xIds.includes(FX.C2));
  check("T700 C4/WTC/routedH(非我組) ∉ base", !xIds.includes(FX.C4));
  check("T700 C7/WTC/routedY ∉ base", !xIds.includes(FX.C7));
  check("T700 C9/WTC/assigneeY ∉ base", !xIds.includes(FX.C9));
  const baseOk = xAll.items.every(
    (i) => i.clinicId === TKW || i.assigneeId === X_ID || (i.assigneeId == null && (i.routedStaffId === X_ID || i.routedGroupId === G_ID)),
  );
  check("T700 每行滿足 baseScope（clinic∨assignee∨routed）— 零外溢", baseOk, xAll.items.length);

  // ══ T701：公海跨店隔離 ══
  console.log("\n[T701] X 公海（?assigned=unassigned）跨店隔離");
  const xUn = await getList(xCookie, "?assigned=unassigned");
  check("T701 公海每行 = TKW ∧ 未指派（I-2）", xUn.every((i) => i.clinicId === TKW && i.assigneeId == null), xUn.length);
  check("T701 C5/TKW ∈ 公海", xUn.some((i) => i.id === FX.C5));
  check("T701 C1/MF/routedG ∉ 公海（跨店未指派唔入）", !xUn.some((i) => i.id === FX.C1));
  check("T701 C3/WTC/routedX ∉ 公海", !xUn.some((i) => i.id === FX.C3));
  check("T701 C8/WTC/routedG ∉ 公海", !xUn.some((i) => i.id === FX.C8));

  // ══ T702：派俾我精確集合 ══
  console.log("\n[T702] X 派俾我（?assigned=routed）精確集合");
  const xRouted = await getList(xCookie, "?assigned=routed");
  const gotRouted = new Set(xRouted.map((i) => i.id));
  const expRouted = new Set([FX.C1, FX.C3, FX.C8]);
  check("T702 派俾我 === 恰 {C1,C3,C8}", gotRouted.size === 3 && [...expRouted].every((id) => gotRouted.has(id)), { got: xRouted.map((i) => i.id) });
  check("T702 每行 = 未指派 ∧ (routedStaffId=X ∨ routedGroupId=G)", xRouted.every((i) => i.assigneeId == null && (i.routedStaffId === X_ID || i.routedGroupId === G_ID)));

  // ══ T703：counts 不變式（同 predicate 三處同源）══
  console.log("\n[T703] X counts 不變式（items 追齊後對帳）");
  const c = xAll.counts;
  if (!c) throw new Error("walk 冇返 counts");
  const fUn = xAll.items.filter((i) => i.assigneeId == null && i.clinicId === TKW);
  const fMine = xAll.items.filter((i) => i.assigneeId === X_ID);
  const fRouted = xAll.items.filter((i) => i.assigneeId == null && (i.routedStaffId === X_ID || i.routedGroupId === G_ID));
  const fFollowup = xAll.items.filter((i) => i.followupDueAt != null);
  check("T703 counts.all === |items|（追齊無 cap 截斷）", c.all === xAll.items.length, { counts: c.all, items: xAll.items.length });
  check("T703 counts.unassigned === |公海 filter|", c.unassigned === fUn.length, { counts: c.unassigned, filtered: fUn.length });
  check("T703 counts.mine === |mine filter|", c.mine === fMine.length, { counts: c.mine, filtered: fMine.length });
  check("T703 counts.routed === |routed filter|", c.routed === fRouted.length, { counts: c.routed, filtered: fRouted.length });
  check("T703 counts.routed === 3（恰 C1/C3/C8）", c.routed === 3, c.routed);
  check("T703 counts.pending === 0", c.pending === 0, c.pending);
  const dbResolved = await prisma.conversation.count({
    where: {
      AND: [
        { status: "RESOLVED" },
        { OR: [{ clinicId: TKW }, { assigneeId: X_ID }, { assigneeId: null, OR: [{ routedStaffId: X_ID }, { routedGroupId: { in: [G_ID] } }] }] },
      ],
    },
  });
  check("T703 counts.resolved === DB（base ∧ RESOLVED）", c.resolved === dbResolved, { counts: c.resolved, db: dbResolved });
  check("T703 counts.followup === |followupDueAt filter|（S2-3 含 RESOLVED 口徑由 loadFollowupDue 決定）", c.followup === fFollowup.length, { counts: c.followup, filtered: fFollowup.length });

  // ══ T725：Y 無組 fail-closed ══
  console.log("\n[T725] Y（無技能組）fail-closed：組支路閉合，唔放寬");
  const yAll = await walkAll(yCookie);
  const yIds = yAll.items.map((i) => i.id);
  check("T725 C7/WTC/routedY ∈ Y base", yIds.includes(FX.C7));
  check("T725 C9/WTC/assigneeY ∈ Y base", yIds.includes(FX.C9));
  check("T725 C8/WTC/routedG ∉ Y base（Y 無組 → 組支路閉合）", !yIds.includes(FX.C8));
  check("T725 C1/MF/routedG ∉ Y base", !yIds.includes(FX.C1));
  check("T725 C3/WTC/routedX ∉ Y base", !yIds.includes(FX.C3));
  const yBaseOk = yAll.items.every(
    (i) => i.clinicId === TKW || i.assigneeId === Y_ID || (i.assigneeId == null && i.routedStaffId === Y_ID),
  );
  check("T725 Y 每行滿足 baseScope（無組 → 無 routedGroupId 支路）零外溢", yBaseOk, yAll.items.length);
  const yRouted = await getList(yCookie, "?assigned=routed");
  check("T725 Y 派俾我 === 恰 {C7}", yRouted.length === 1 && yRouted[0]?.id === FX.C7, yRouted.map((i) => i.id));
  const yUn = await getList(yCookie, "?assigned=unassigned");
  check("T725 Y 公海每行 = TKW ∧ 未指派（無組都唔放寬）", yUn.every((i) => i.clinicId === TKW && i.assigneeId == null), yUn.length);

  await cleanupLast();
  console.log(FAILS === 0 ? "\nT700-OK（T700/T701/T702/T703/T725 全綠）" : `\nT700-FAIL（${FAILS} 項紅）`);
  process.exit(FAILS === 0 ? 0 : 1);
}

main()
  .catch((e) => {
    console.error("T700-FAIL:", e);
    try {
      void cleanupLast();
    } catch {
      /* ignore */
    }
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

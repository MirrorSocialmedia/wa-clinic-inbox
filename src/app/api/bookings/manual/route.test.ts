/**
 * ★ cwi-ux UX-07 T-UX07a/b/c/e/g（API 級）：人手落單跨分店
 *
 * 運行：cd src/app/api/bookings/manual && npx --prefix <repo> tsx --test route.test.ts
 *   （要 DB 15432 + Redis 6379 + WORKFORCE_MOCK=1 — .env；[id] 路徑 glob 陷阱 → 入目錄跑）
 *
 * 口徑（spec §7.5）：
 *   - a：負責人（已接手）喺 YL 落單 → 202；BookingRequest.clinicId=TKW（對話店唔變）
 *     + bookingClinicId=YL（目標店）；requestId 冪等（重試 = 同一張卡；改店 → 409）
 *   - b：非負責人跨店 → 403 CROSS_CLINIC_NOT_ALLOWED
 *   - c：目標店唔同公司（TY = 另一 company）→ 照樣成功（bookingClinicId=TY）
 *   - e：目標店（YL）同一時段已有 PENDING（同店舊行或跨店行）→ 409 pending_exists
 *   - g：/api/bookings 隊列（STAFF TKW scope）照見到張卡（clinicId 唔變）
 *
 * 注意：202 = enqueue booking-write 成功（dev worker 會處理 mock 寫入 — 斷言只限
 * 路由層不變量（clinicId/bookingClinicId/flowToken），唔斷言 status（worker race））。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { POST } from "./route";
import { GET as GET_BOOKINGS } from "../route";
import {
  loadEnvIfMissing,
  sessionCookie,
  jsonReq,
  getReq,
  drainRes,
  readJson,
  createConvFx,
  cleanupFx,
  type ConvFx,
} from "../../messages/qa3b-test-helpers";

const PX = "fxux07m";
let prisma: PrismaClient;
let tkwId: string;
let ylId: string;
let tyId: string;
let pYl: { id: string; apricotId: string };
let pTy: { id: string; apricotId: string };
let pTkwOnly: string; // seed 只綁 TKW 嘅 doctor（provider_not_at_clinic 用）
let assignee: { id: string; email: string };
let assigneeCookie: string;
let otherCookie: string; // staff-tkw（同店、非負責人）
const convs: ConvFx[] = [];
const bookingIds: string[] = [];
const DATE = "2026-12-01"; // 未來時段（落單必未來；mock 無 slot 行 → 唔會 SLOT_TAKEN）
const START = "10:00";

async function post(body: Record<string, unknown>, cookie: string) {
  // mock dictionaries fixture（test/fixtures/external-v1-dictionaries.json）有 vr-0010 → confirm-core 唔會 visit_reason_required
  const res = await POST(jsonReq("/api/bookings/manual", { visitReasonId: "vr-0010", ...body }, cookie), { params: Promise.resolve({}) } as never);
  const out = await readJson(res);
  await drainRes(res);
  return { status: res.status, body: out };
}

before(async () => {
  loadEnvIfMissing();
  prisma = new PrismaClient();
  const [tkw, yl, ty] = await Promise.all([
    prisma.clinic.findUnique({ where: { code: "TKW" } }),
    prisma.clinic.findUnique({ where: { code: "YL" } }),
    prisma.clinic.findUnique({ where: { code: "TY" } }),
  ]);
  if (!tkw || !yl || !ty) throw new Error("seed 要有 TKW/YL/TY 三間店");
  tkwId = tkw.id;
  ylId = yl.id;
  tyId = ty.id;
  assert.notEqual(tkw.companyId, ty.companyId, "TY 要同 TKW 唔同公司（T-UX07c 跨公司）");

  // fixture doctors（只綁目標店）
  const rYl = await prisma.provider.create({
    data: { name: "UX07 測試醫生YL", apricotId: `mock-pract-ux07m-yl-${randomUUID().slice(0, 6)}`, active: true },
  });
  pYl = { id: rYl.id, apricotId: rYl.apricotId! };
  await prisma.providerClinic.create({ data: { providerId: pYl.id, clinicId: ylId } });
  const rTy = await prisma.provider.create({
    data: { name: "UX07 測試醫生TY", apricotId: `mock-pract-ux07m-ty-${randomUUID().slice(0, 6)}`, active: true },
  });
  pTy = { id: rTy.id, apricotId: rTy.apricotId! };
  await prisma.providerClinic.create({ data: { providerId: pTy.id, clinicId: tyId } });
  const tkwOnly = await prisma.provider.findFirst({ where: { clinics: { some: { clinicId: tkwId } } } });
  if (!tkwOnly?.apricotId) throw new Error("seed 要有綁 TKW 嘅 doctor");
  pTkwOnly = tkwOnly.apricotId;

  // fixture assignee（TKW scope STAFF）
  const email = `ux07assignee-${Date.now()}@wa-clinic.local`;
  const su = await prisma.staffUser.create({
    data: { email, passwordHash: "ux07-fixture-no-login", name: "UX07 測試負責人", role: "STAFF", clinicId: tkwId, active: true, scopeType: "CLINICS" },
  });
  await prisma.staffClinic.create({ data: { staffId: su.id, clinicId: tkwId } });
  assignee = { id: su.id, email };
  assigneeCookie = await sessionCookie({
    staffId: su.id, role: "STAFF", name: su.name, email, clinicId: tkwId, scopeType: "CLINICS",
  });
  const other = await prisma.staffUser.findUnique({ where: { email: "staff-tkw@wa-clinic.local" } });
  if (!other) throw new Error("seed 要有 staff-tkw@wa-clinic.local");
  otherCookie = await sessionCookie({
    staffId: other.id, role: "STAFF", name: other.name, email: other.email, clinicId: tkwId, scopeType: "CLINICS",
  });

  // convA：TKW 對話，負責人 = fixture assignee（a/b/e/g 用）
  const a = await createConvFx(prisma, { prefix: PX, assigneeId: su.id });
  convs.push(a);
  await prisma.conversation.update({ where: { id: a.convId }, data: { pinnedPatientApricotId: "cp-std-001" } });
  // convB：跨公司落單（c 用）
  const b = await createConvFx(prisma, { prefix: PX, assigneeId: su.id });
  convs.push(b);
  await prisma.conversation.update({ where: { id: b.convId }, data: { pinnedPatientApricotId: "cp-std-001" } });
  // convD：Y 時段 PENDING 行嘅 FK 載體（e 用）
  const d = await createConvFx(prisma, { prefix: PX });
  convs.push(d);
  (globalThis as Record<string, unknown>).convA = a;
  (globalThis as Record<string, unknown>).convB = b;
  (globalThis as Record<string, unknown>).convD = d;
});

after(async () => {
  if (prisma) {
    for (const fx of convs) await cleanupFx(prisma, fx).catch(() => {});
    // 直接建嘅 PENDING 行（e 用）+ fixture 落單行
    await prisma.bookingRequest
      .deleteMany({ where: { OR: [{ conversationId: { in: convs.map((c) => c.convId) } }, { flowToken: { startsWith: "manual-" } }] } })
      .catch(() => {});
    if (pYl.id) await prisma.provider.deleteMany({ where: { id: { in: [pYl.id, pTy.id] } } }).catch(() => {});
    if (assignee.id) {
      await prisma.staffClinic.deleteMany({ where: { staffId: assignee.id } }).catch(() => {});
      await prisma.staffUser.deleteMany({ where: { id: assignee.id } }).catch(() => {});
    }
    await prisma.auditLog.deleteMany({ where: { entityId: { in: bookingIds } } }).catch(() => {});
    await prisma.$disconnect().catch(() => {});
    const { closeRedis } = await import("@/lib/queue");
    await closeRedis().catch(() => {});
  }
});

// ── T-UX07a：負責人跨店（YL）落單 → 202 + 行不變量 ─────────────────────────
test("T-UX07a: 負責人跨店（YL）落單 202 — clinicId=對話店 + bookingClinicId=目標店", async () => {
  const a = (globalThis as unknown as Record<string, ConvFx>).convA;
  const r1 = randomUUID();
  const r = await post(
    { requestId: r1, conversationId: a.convId, providerApricotId: pYl.apricotId, date: DATE, start: START, bookingClinicId: ylId },
    assigneeCookie
  );
  assert.ok(r.status === 202 || r.status === 200, `預期 202/200，得 ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.ok, true);
  const row = await prisma.bookingRequest.findUnique({ where: { flowToken: `manual-${r1}` } });
  assert.ok(row, "BookingRequest 行存在（flowToken=manual-<requestId>）");
  assert.equal(row.clinicId, tkwId, "clinicId 唔變 = 對話所屬店（TKW）");
  assert.equal(row.bookingClinicId, ylId, "bookingClinicId = 目標店（YL）");
  assert.equal(row.providerApricotId, pYl.apricotId);
  bookingIds.push(row.id);
});

test("T-UX07a: requestId 冪等 — 重試同店 = 同一張卡；改店 = 409", async () => {
  const a = (globalThis as unknown as Record<string, ConvFx>).convA;
  // 搵返剛先張卡嘅 requestId（flowToken=manual-<uuid>）
  const row = await prisma.bookingRequest.findFirst({
    where: { conversationId: a.convId, bookingClinicId: ylId },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(row, "剛先張跨店卡喺度");
  const r1 = row.flowToken.replace(/^manual-/, "");
  // 重試（同店）→ 202/200（WRITING replay / CONFIRMED replay），唔多一张卡
  const r = await post(
    { requestId: r1, conversationId: a.convId, providerApricotId: pYl.apricotId, date: DATE, start: START, bookingClinicId: ylId },
    assigneeCookie
  );
  assert.ok(r.status === 202 || r.status === 200, `重試預期 202/200，得 ${r.status}`);
  const count = await prisma.bookingRequest.count({ where: { flowToken: `manual-${r1}` } });
  assert.equal(count, 1, "冪等 — 同 requestId 永遠同一張卡");
  // 改店重試 → 409（provider 換做綁 TY 嗰位 — 唔使死喺 provider_not_at_clinic 先見唔到冪等 409）
  const r2 = await post(
    { requestId: r1, conversationId: a.convId, providerApricotId: pTy.apricotId, date: DATE, start: START, bookingClinicId: tyId },
    assigneeCookie
  );
  assert.equal(r2.status, 409);
  assert.equal(r2.body.error, "DUPLICATE_BOOKING");
});

// ── T-UX07b：非負責人跨店 → 403 ───────────────────────────────────────────
test("T-UX07b: 非負責人跨店 → 403 CROSS_CLINIC_NOT_ALLOWED", async () => {
  const a = (globalThis as unknown as Record<string, ConvFx>).convA;
  const r = await post(
    { requestId: randomUUID(), conversationId: a.convId, providerApricotId: pYl.apricotId, date: DATE, start: START, bookingClinicId: ylId },
    otherCookie
  );
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "CROSS_CLINIC_NOT_ALLOWED");
});

// ── T-UX07c：跨公司（TY）照樣成功 ─────────────────────────────────────────
test("T-UX07c: 目標店唔同公司（TY）→ 照樣 202 + bookingClinicId=TY", async () => {
  const b = (globalThis as unknown as Record<string, ConvFx>).convB;
  const r1 = randomUUID();
  const r = await post(
    { requestId: r1, conversationId: b.convId, providerApricotId: pTy.apricotId, date: DATE, start: START, bookingClinicId: tyId },
    assigneeCookie
  );
  assert.ok(r.status === 202 || r.status === 200, `預期 202/200，得 ${r.status}: ${JSON.stringify(r.body)}`);
  const row = await prisma.bookingRequest.findUnique({ where: { flowToken: `manual-${r1}` } });
  assert.ok(row);
  assert.equal(row.clinicId, tkwId);
  assert.equal(row.bookingClinicId, tyId, "跨公司容許 — 目標店 = 任何 active 診所（拍板 ①）");
  bookingIds.push(row.id);
});

test("T-UX07c 邊界：unknown_clinic → 400；doctor 未綁目標店 → 400 provider_not_at_clinic", async () => {
  const a = (globalThis as unknown as Record<string, ConvFx>).convA;
  const r1 = await post(
    { requestId: randomUUID(), conversationId: a.convId, providerApricotId: pYl.apricotId, date: DATE, start: START, bookingClinicId: "no-such-clinic" },
    assigneeCookie
  );
  assert.equal(r1.status, 400);
  assert.equal(r1.body.error, "unknown_clinic");
  const r2 = await post(
    { requestId: randomUUID(), conversationId: a.convId, providerApricotId: pTkwOnly, date: DATE, start: START, bookingClinicId: ylId },
    assigneeCookie
  );
  assert.equal(r2.status, 400);
  assert.equal(r2.body.error, "provider_not_at_clinic");
});

// ── T-UX07e：目標店同一時段已有 PENDING → 409（重複防護用目標店）──────────
test("T-UX07e: YL 時段已有 PENDING（同店舊行）→ 跨店落單 409 pending_exists", async () => {
  const a = (globalThis as unknown as Record<string, ConvFx>).convA;
  const d = (globalThis as unknown as Record<string, ConvFx>).convD;
  const t1 = "11:00"; // 避開 convA 自己 T-UX07a 行（10:00 — WRITING 會先中 dupConfirmed）
  const ft = `ux07e-same-${randomUUID()}`;
  await prisma.bookingRequest.create({
    data: {
      id: `ux07e1${randomUUID().slice(0, 12)}`,
      conversationId: d.convId,
      clinicId: ylId, // 同店舊行（YL 自己嘅預約佔咗 YL 該格）
      flowToken: ft,
      providerApricotId: pYl.apricotId,
      providerName: "UX07 測試醫生YL",
      requestedDate: DATE,
      requestedTime: t1,
      status: "PENDING",
    },
  });
  bookingIds.push(ft);
  const r = await post(
    { requestId: randomUUID(), conversationId: a.convId, providerApricotId: pYl.apricotId, date: DATE, start: t1, bookingClinicId: ylId },
    assigneeCookie
  );
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "pending_exists");
  assert.ok(String(r.body.bookingId ?? "").startsWith("ux07e1"), "409 指向 YL 嗰條 PENDING 行");
});

test("T-UX07e: YL 時段已被另一條對話跨店佔（bookingClinicId=YL）→ 照 409", async () => {
  const a = (globalThis as unknown as Record<string, ConvFx>).convA;
  const d = (globalThis as unknown as Record<string, ConvFx>).convD;
  const t2 = "11:30"; // 避開上一個 e-case + convA 自己行
  const ft = `ux07e-cross-${randomUUID()}`;
  // 清返上一個 e-case 嘅行（避免兩行 PENDING 同時佔格造成歧義）
  await prisma.bookingRequest.deleteMany({ where: { id: { startsWith: "ux07e1" } } }).catch(() => {});
  await prisma.bookingRequest.create({
    data: {
      id: `ux07e2${randomUUID().slice(0, 12)}`,
      conversationId: d.convId,
      clinicId: tkwId, // 跨店行：對話喺 TKW、預約喺 YL
      bookingClinicId: ylId,
      flowToken: ft,
      providerApricotId: pYl.apricotId,
      providerName: "UX07 測試醫生YL",
      requestedDate: DATE,
      requestedTime: t2,
      status: "PENDING",
    },
  });
  bookingIds.push(ft);
  const r = await post(
    { requestId: randomUUID(), conversationId: a.convId, providerApricotId: pYl.apricotId, date: DATE, start: t2, bookingClinicId: ylId },
    assigneeCookie
  );
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "pending_exists");
  assert.ok(String(r.body.bookingId ?? "").startsWith("ux07e2"), "409 指向跨店佔位行（bookingClinicId=YL 嗰條）");
});

// ── T-UX07g：/api/bookings 隊列（TKW staff）照見到跨店卡（clinicId 唔變）──
test("T-UX07g: /api/bookings 隊列 STAFF(TKW) 見到跨店卡 — clinicId 仍 = TKW", async () => {
  const a = (globalThis as unknown as Record<string, ConvFx>).convA;
  const row = await prisma.bookingRequest.findFirst({
    where: { conversationId: a.convId, bookingClinicId: ylId },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(row, "T-UX07a 張跨店卡喺度");
  const res = await GET_BOOKINGS(getReq("/api/bookings", assigneeCookie), { params: Promise.resolve({}) } as never); // 唔 filter status（dev worker 可能已處理 — 行照喺）
  const body = (await readJson(res)) as Record<string, unknown>[];
  await drainRes(res);
  assert.ok(Array.isArray(body), "隊列回陣列");
  const hit = (body as Record<string, unknown>[]).find((b) => b.id === row.id);
  assert.ok(hit, "跨店卡喺 TKW staff 嘅隊列（clinicId 唔變 → scope 唔漏）");
  assert.equal(hit.clinicId, tkwId);
});

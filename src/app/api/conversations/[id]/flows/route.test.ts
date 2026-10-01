/**
 * ★ cwi-ux UX-07 T-UX07d / T-UX07f（API 級）：發 Flow 跨分店 + 改期跟目標店
 *
 * 運行：cd src/app/api/conversations/[id]/flows && npx --prefix <repo> tsx --test route.test.ts
 *   （要 DB 15432 + Redis 6379 + WORKFORCE_MOCK=1 + FLOW_JWT_SECRET — .env）
 *
 * 口徑（spec §7.5）：
 *   - d：發預約 Flow 揀 YL → FlowSession.bookingClinicId=YL（clinicId 仍 = 對話店 TKW）；
 *     token 簽名帶 bookingClinicId（病人揀完用同一間店）；
 *     payload 改店（簽名有效但 ≠ session 店）→ endpoint 拒（mismatch 邏輯）；
 *     token 被改（簽名失配）→ verifyFlowToken null
 *   - d 舊 flow 零改動：body 唔帶 bookingClinicId → session.bookingClinicId=null + token 唔帶該欄
 *   - b：非負責人跨店發 Flow → 403 CROSS_CLINIC_NOT_ALLOWED
 *   - f：舊預約（bookingClinicId=null）改期（reschedule 重出 Flow）→ 照舊（session=null）；
 *     跨店 PENDING 卡改期 → 重出 Flow 同一目標店（YL）
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { POST as POST_FLOWS } from "./route";
import { POST as POST_RESCHEDULE } from "../../../bookings/[id]/reschedule/route";
import { signFlowToken, verifyFlowToken, flowJwtSecret, type FlowTokenPayload } from "@/lib/flows/crypto";
import {
  loadEnvIfMissing,
  sessionCookie,
  jsonReq,
  drainRes,
  readJson,
  createConvFx,
  cleanupFx,
  type ConvFx,
} from "../../../messages/qa3b-test-helpers";

const PX = "fxux07d";
let prisma: PrismaClient;
let tkwId: string;
let ylId: string;
let tyId: string;
let tkwProvider: string;
let assignee: { id: string; email: string };
let assigneeCookie: string;
let otherCookie: string;
const convs: ConvFx[] = [];
let prevAllowSlotClaim: string | undefined;

function postFlows(convId: string, body: Record<string, unknown>, cookie: string) {
  return POST_FLOWS(jsonReq(`/api/conversations/${convId}/flows`, body, cookie), {
    params: Promise.resolve({ id: convId }),
  } as never).then(async (res) => {
    const out = await readJson(res);
    await drainRes(res);
    return { status: res.status, body: out };
  });
}

async function latestSession(convId: string) {
  return prisma.flowSession.findFirst({ where: { conversationId: convId }, orderBy: { createdAt: "desc" } });
}

before(async () => {
  loadEnvIfMissing();
  prevAllowSlotClaim = process.env.ALLOW_SLOT_CLAIM;
  process.env.ALLOW_SLOT_CLAIM = "1"; // G2 閘（發 Flow 必需 — 測試域內開）
  prisma = new PrismaClient();
  const [tkw, yl, ty] = await Promise.all([
    prisma.clinic.findUnique({ where: { code: "TKW" } }),
    prisma.clinic.findUnique({ where: { code: "YL" } }),
    prisma.clinic.findUnique({ where: { code: "TY" } }),
  ]);
  if (!tkw || !yl || !ty) throw new Error("seed 要有 TKW/YL/TY");
  tkwId = tkw.id;
  ylId = yl.id;
  tyId = ty.id;
  const prov = await prisma.provider.findFirst({ where: { clinics: { some: { clinicId: tkwId } } } });
  if (!prov?.apricotId) throw new Error("seed 要有綁 TKW 嘅 doctor");
  tkwProvider = prov.apricotId;

  const email = `ux07flow-${Date.now()}@wa-clinic.local`;
  const su = await prisma.staffUser.create({
    data: { email, passwordHash: "ux07-fixture-no-login", name: "UX07 Flow 測試負責人", role: "STAFF", clinicId: tkwId, active: true, scopeType: "CLINICS" },
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
});

after(async () => {
  if (prevAllowSlotClaim === undefined) delete process.env.ALLOW_SLOT_CLAIM;
  else process.env.ALLOW_SLOT_CLAIM = prevAllowSlotClaim;
  if (prisma) {
    for (const fx of convs) await cleanupFx(prisma, fx).catch(() => {});
    await prisma.flowSession.deleteMany({ where: { conversationId: { in: convs.map((c) => c.convId) } } }).catch(() => {});
    await prisma.bookingRequest.deleteMany({ where: { conversationId: { in: convs.map((c) => c.convId) } } }).catch(() => {});
    if (assignee.id) {
      await prisma.staffClinic.deleteMany({ where: { staffId: assignee.id } }).catch(() => {});
      await prisma.staffUser.deleteMany({ where: { id: assignee.id } }).catch(() => {});
    }
    await prisma.$disconnect().catch(() => {});
    const { closeRedis } = await import("@/lib/queue");
    await closeRedis().catch(() => {});
  }
});

// ── T-UX07d：發 Flow 揀 YL → session + token 都帶 YL ─────────────────────
test("T-UX07d: 負責人發 Flow 揀 YL → session.bookingClinicId=YL + token 簽名帶 YL", async () => {
  const fx = await createConvFx(prisma, { prefix: PX, assigneeId: assignee.id });
  convs.push(fx);
  const r = await postFlows(fx.convId, { bookingClinicId: ylId }, assigneeCookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.reused, false);

  const session = await latestSession(fx.convId);
  assert.ok(session, "FlowSession 建咗");
  assert.equal(session.clinicId, tkwId, "session.clinicId 唔變 = 對話店（TKW）");
  assert.equal(session.bookingClinicId, ylId, "session.bookingClinicId = 目標店（YL）");

  const payload = verifyFlowToken(session.flowToken, flowJwtSecret());
  assert.ok(payload, "token 簽名有效");
  assert.equal(payload.convId, fx.convId);
  assert.equal(payload.clinicId, tkwId);
  assert.equal(payload.bookingClinicId, ylId, "token 簽名帶 bookingClinicId（YL）");
});

test("T-UX07d 舊 flow 零改動：body 唔帶 bookingClinicId → session=null + token 唔帶該欄", async () => {
  const fx = await createConvFx(prisma, { prefix: PX, assigneeId: assignee.id });
  convs.push(fx);
  const r = await postFlows(fx.convId, {}, assigneeCookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const session = await latestSession(fx.convId);
  assert.ok(session);
  assert.equal(session.bookingClinicId, null, "舊 flow：bookingClinicId=null（對話所屬店 — 零改動）");
  const payload = verifyFlowToken(session.flowToken, flowJwtSecret());
  assert.ok(payload);
  assert.equal(payload.bookingClinicId ?? null, null, "舊 token 唔帶 bookingClinicId");
});

test("T-UX07b（flow 版）：非負責人跨店發 Flow → 403 CROSS_CLINIC_NOT_ALLOWED", async () => {
  const fx = await createConvFx(prisma, { prefix: PX, assigneeId: assignee.id });
  convs.push(fx);
  const r = await postFlows(fx.convId, { bookingClinicId: ylId }, otherCookie);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "CROSS_CLINIC_NOT_ALLOWED");
  // 未副作用：冇 FlowSession
  assert.equal(await latestSession(fx.convId), null);
});

// ── T-UX07d：payload 改店 → 拒（token 簽名 vs session 店）─────────────────
test("T-UX07d: 簽名有效但目標店 ≠ session 店（改店攻擊）→ mismatch 拒；token 改壞 → null", async () => {
  const secret = flowJwtSecret();
  const fx = await createConvFx(prisma, { prefix: PX, assigneeId: assignee.id });
  convs.push(fx);
  await postFlows(fx.convId, { bookingClinicId: ylId }, assigneeCookie);
  const session = await latestSession(fx.convId);
  assert.ok(session);

  // 攻擊者喺 flow payload 改店（TY）但 token 簽名仍係 YL —
  // endpoint 邏輯（flows/endpoint/route.ts：session.bookingClinicId !== tokenPayload.bookingClinicId → 拒）
  const tamperedTarget = signFlowToken(
    { convId: fx.convId, clinicId: tkwId, bookingClinicId: tyId } as FlowTokenPayload,
    secret
  );
  const tamperedPayload = verifyFlowToken(tamperedTarget, secret);
  assert.ok(tamperedPayload, "簽名本身有效（攻擊用真 secret 簽唔到 — 呢度模擬 payload 層改店）");
  const mismatch = session.bookingClinicId !== (tamperedPayload?.bookingClinicId ?? null);
  assert.equal(mismatch, true, "endpoint 會拒（session=YL ≠ token=TY）");

  // token 被改壞（簽名失配）→ verifyFlowToken null（fail-closed → 427）
  const broken = session.flowToken.slice(0, -4) + "xxxx";
  assert.equal(verifyFlowToken(broken, secret), null);
});

// ── T-UX07f：舊預約（bookingClinicId=null）改期照舊；跨店卡改期跟目標店 ───
test("T-UX07f: 舊預約（bookingClinicId=null）reschedule → 200 + 重出 Flow session=null（零改動）", async () => {
  const fx = await createConvFx(prisma, { prefix: PX, assigneeId: assignee.id });
  convs.push(fx);
  const bk = await prisma.bookingRequest.create({
    data: {
      conversationId: fx.convId,
      clinicId: tkwId,
      bookingClinicId: null, // 舊預約
      flowToken: `ux07f-legacy-${randomUUID()}`,
      providerApricotId: tkwProvider,
      providerName: "測試醫生",
      requestedDate: "2026-12-01",
      requestedTime: "10:00",
      status: "PENDING",
    },
  });
  const res = await POST_RESCHEDULE(jsonReq(`/api/bookings/${bk.id}/reschedule`, {}, assigneeCookie), {
    params: Promise.resolve({ id: bk.id }),
  } as never);
  const out = await readJson(res);
  await drainRes(res);
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.ok, true);
  const session = await latestSession(fx.convId);
  assert.ok(session);
  assert.equal(session.bookingClinicId, null, "舊預約改期 — 目標店仍 = 對話店（零改動）");
});

test("T-UX07f: 跨店 PENDING 卡 reschedule → 重出 Flow 同一目標店（YL）", async () => {
  const fx = await createConvFx(prisma, { prefix: PX, assigneeId: assignee.id });
  convs.push(fx);
  const bk = await prisma.bookingRequest.create({
    data: {
      conversationId: fx.convId,
      clinicId: tkwId,
      bookingClinicId: ylId, // 跨店
      flowToken: `ux07f-cross-${randomUUID()}`,
      providerApricotId: tkwProvider,
      providerName: "測試醫生",
      requestedDate: "2026-12-01",
      requestedTime: "10:00",
      status: "PENDING",
    },
  });
  const res = await POST_RESCHEDULE(jsonReq(`/api/bookings/${bk.id}/reschedule`, {}, assigneeCookie), {
    params: Promise.resolve({ id: bk.id }),
  } as never);
  const out = await readJson(res);
  await drainRes(res);
  assert.equal(res.status, 200, JSON.stringify(out));
  const session = await latestSession(fx.convId);
  assert.ok(session);
  assert.equal(session.bookingClinicId, ylId, "跨店卡改期 — 重出 Flow 同一目標店（唔跳返對話店）");
});

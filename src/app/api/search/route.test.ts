/**
 * ★ cwi-ux UX-07 T-UX07i（API 級）：search mine=1 — 我負責緊嘅對話，唔按店/公司過濾
 *
 * 運行：npx tsx --test src/app/api/search/route.test.ts（要 DB 15432 + Redis 6379）
 *
 * 口徑（spec §7.5 + 老細 2026-10-01 拍板①②：跨公司容許；非負責人要先接手）：
 *   - 對話 clinic = TY（公司 A）、assignee = YL staff（公司 C）→ YL staff mine=1 **見到**
 *     （接咗手嘅對話，唔按公司過濾 — spec §7.3「（同公司）」以拍板為準）
 *   - excludeClinic = 對話嗰間店（TY）→ 唔返（目前顯示嗰間 — UI 分組用）
 *   - /api/conversations?mine=1 同口徑（完整 DTO：clinicName = 對話所屬店）
 *   - 非 assignee 嘅 staff mine=1 → 冇呢條（單線授權，唔洩別人線）
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { GET as GET_SEARCH } from "./route";
import { GET as GET_CONVS } from "../conversations/route";
import {
  loadEnvIfMissing,
  sessionCookie,
  getReq,
  drainRes,
  readJson,
  createConvFx,
  cleanupFx,
  type ConvFx,
} from "../messages/qa3b-test-helpers";

const PREFIX = "fxux07i";
let prisma: PrismaClient;
let tkwId: string;
let ylId: string;
let tyId: string;
let tyName: string;
let ylStaff: { id: string; email: string };
let ylCookie: string;
let otherCookie: string;
const convs: ConvFx[] = [];

async function get(path: string, cookie: string) {
  const res = await (path.includes("/api/search") ? GET_SEARCH : GET_CONVS)(getReq(path, cookie) as never, {
    params: Promise.resolve({}),
  } as never);
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
  if (!tkw || !yl || !ty) throw new Error("seed 要有 TKW/YL/TY");
  tkwId = tkw.id;
  ylId = yl.id;
  tyId = ty.id;
  tyName = ty.name;

  const email = `ux07i-${Date.now()}@wa-clinic.local`;
  const su = await prisma.staffUser.create({
    data: { email, passwordHash: "ux07-fixture-no-login", name: "UX07 Search 測試負責人", role: "STAFF", clinicId: ylId, active: true, scopeType: "CLINICS" },
  });
  await prisma.staffClinic.create({ data: { staffId: su.id, clinicId: ylId } });
  ylStaff = { id: su.id, email };
  ylCookie = await sessionCookie({ staffId: su.id, role: "STAFF", name: su.name, email, clinicId: ylId, scopeType: "CLINICS" });
  const other = await prisma.staffUser.findUnique({ where: { email: "staff-tkw@wa-clinic.local" } });
  if (!other) throw new Error("seed 要有 staff-tkw@wa-clinic.local");
  otherCookie = await sessionCookie({ staffId: other.id, role: "STAFF", name: other.name, email: other.email, clinicId: tkwId, scopeType: "CLINICS" });
});

after(async () => {
  if (prisma) {
    for (const fx of convs) await cleanupFx(prisma, fx).catch(() => {});
    if (ylStaff?.id) {
      await prisma.staffClinic.deleteMany({ where: { staffId: ylStaff.id } }).catch(() => {});
      await prisma.staffUser.deleteMany({ where: { id: ylStaff.id } }).catch(() => {});
    }
    await prisma.$disconnect().catch(() => {});
    const { closeRedis } = await import("@/lib/queue");
    await closeRedis().catch(() => {});
  }
});

test("T-UX07i: search mine=1 — 跨公司（TY 對話，YL 負責人）見到 + conversationId", async () => {
  const fx = await createConvFx(prisma, { prefix: PREFIX, assigneeId: ylStaff.id });
  convs.push(fx);
  // 對話調去 TY（公司 A）— 跨公司（負責人 YL = 公司 C）
  await prisma.conversation.update({ where: { id: fx.convId }, data: { clinicId: tyId } });

  const r = await get(`/api/search?q=${PREFIX}&mine=1&excludeClinic=${ylId}`, ylCookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const hit = ( (r.body.results ?? []) as Array<{ conversationId?: string | null; clinicId?: string; waId?: string }> ).find((h: { conversationId?: string | null }) => h.conversationId === fx.convId);
  assert.ok(hit, `mine=1 要見到自己負責緊嘅跨公司對話：${JSON.stringify( (r.body.results ?? []) as Array<{ conversationId?: string | null; clinicId?: string; waId?: string }> )}`);
  assert.equal(hit.clinicId, tyId, "hit.clinicId = 對話所屬店（TY）");
  assert.ok(hit.waId, "hit 帶 contact waId（UI 對住對話發 Flow/落單）");
});

test("T-UX07i: search mine=1 + excludeClinic=對話店 → 唔返（目前顯示嗰間分咗組）", async () => {
  const fx = await createConvFx(prisma, { prefix: PREFIX, assigneeId: ylStaff.id });
  convs.push(fx);
  await prisma.conversation.update({ where: { id: fx.convId }, data: { clinicId: tyId } });

  const r = await get(`/api/search?q=${PREFIX}&mine=1&excludeClinic=${tyId}`, ylCookie);
  assert.equal(r.status, 200);
  const hit = ( (r.body.results ?? []) as Array<{ conversationId?: string | null; clinicId?: string; waId?: string }> ).find((h: { conversationId?: string | null }) => h.conversationId === fx.convId);
  assert.equal(hit, undefined, "excludeClinic=TY → 呢條唔返（UI 會喺 TKW 時間表嗰組見到）");
});

test("T-UX07i: /api/conversations?mine=1 — 跨公司對話入列（完整 DTO + clinicName）", async () => {
  const fx = await createConvFx(prisma, { prefix: PREFIX, assigneeId: ylStaff.id });
  convs.push(fx);
  await prisma.conversation.update({ where: { id: fx.convId }, data: { clinicId: tyId } });

  const r = await get(`/api/conversations?mine=1&excludeClinic=${ylId}`, ylCookie);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  const item = ( (r.body.items ?? []) as Array<{ id?: string; clinicName?: string }> ).find((i: { id?: string }) => i.id === fx.convId);
  assert.ok(item, "mine=1 完整 DTO 入列（跨公司唔過濾）");
  assert.equal(item.clinicName, tyName, "clinicName = 對話所屬店（TY）— 非負責人自己嗰間");
});

test("T-UX07i 負向：非 assignee staff mine=1 → 冇（單線授權，唔洩別人線）", async () => {
  const fx = await createConvFx(prisma, { prefix: PREFIX, assigneeId: ylStaff.id });
  convs.push(fx);
  await prisma.conversation.update({ where: { id: fx.convId }, data: { clinicId: tyId } });

  const r = await get(`/api/conversations?mine=1`, otherCookie);
  assert.equal(r.status, 200);
  const item = ( (r.body.items ?? []) as Array<{ id?: string; clinicName?: string }> ).find((i: { id?: string }) => i.id === fx.convId);
  assert.equal(item, undefined, "非負責人 mine=1 唔見呢條");
});

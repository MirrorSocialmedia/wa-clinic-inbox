/**
 * FX-03 unit test — notices route 空範圍 fail-closed（QA-03，已重現）
 *
 * 運行：TZ=UTC npx tsx --test src/app/api/notices/route.test.ts
 *   （要 DB：migrate:deploy 過嘅 DATABASE_URL；npx 唔似 pnpm 自動注入 .env，
 *     DATABASE_URL 未設時呢度自己讀 repo root .env）
 *
 * 背景：COMPANY scope ADMIN（公司 0 間店）→ scopedClinicSet = [] →
 *   舊實作（$2::text[] = '{}' OR … / length > 0 ? … : TRUE）將空陣列當全店 →
 *   GET 回其他店 URGENT_ESCALATION、PATCH（冇 ids）標晒全店已讀。
 * 修：set !== null && set.length === 0 → GET {notices:[],count:0} / PATCH {updated:0}。
 *
 * 直接調 exported handler 核心（handleNoticesGet/Patch，ctx 注入），
 * 唔起 server（redline：unit test only）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac";
import { closeRedis } from "@/lib/queue";
import { handleNoticesGet, handleNoticesPatch } from "./route";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** npx tsx 唔自動載 .env — DATABASE_URL 未設時從 repo root 補（唔覆蓋已有值）。 */
function ensureDatabaseUrl(): void {
  if (process.env.DATABASE_URL) return;
  try {
    const env = readFileSync(path.resolve(__dirname, "../../.env"), "utf8");
    for (const line of env.split("\n")) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)=(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {
    /* 冇 .env → Prisma 報錯，fail loud 得 */
  }
}
ensureDatabaseUrl();

const prisma = new PrismaClient();

const NOTICE_TKW = "fx03tkw0000000000000000000001";
const NOTICE_MF = "fx03mf0000000000000000000000002";
const COMPANY_CODE = "FX03TEST";

let tkwClinicId: string;
let mfClinicId: string;
let adminId: string;

function makeCtx(partial: { role: "ADMIN" | "STAFF" | "SUPERVISOR"; scopeType: "ALL" | "COMPANY" | "CLINICS"; scopedClinicIds: string[] }, staffId: string): AuthContext {
  // handler 核心只用 ctx.staff.{id,role} + scopeType + scopedClinicIds —
  // 其餘欄（clinicId/clinicIds/res）呢兩 handler 唔用，test 用最小 fake。
  return {
    staff: { id: staffId, email: "test@fx03.local", name: "FX03 Test", role: partial.role },
    clinicId: null,
    clinicIds: [],
    scopeType: partial.scopeType,
    scopedClinicIds: partial.scopedClinicIds,
  } as unknown as AuthContext;
}

before(async () => {
  const [tkw, mf] = await Promise.all([
    prisma.clinic.findUnique({ where: { code: "TKW" } }),
    prisma.clinic.findUnique({ where: { code: "MF" } }),
    prisma.staffUser.findUnique({ where: { email: "admin@wa-clinic.local" } }),
  ]);
  assert.ok(tkw && mf && tkw, "seed 要有 TKW/MF clinic");
  assert.ok(mf && mf, "seed 要有 MF clinic");
  assert.ok(tkw, "seed 要有 admin");
  tkwClinicId = tkw.id;
  mfClinicId = mf.id;
  adminId = (await prisma.staffUser.findUnique({ where: { email: "admin@wa-clinic.local" } }))!.id;

  // fixtures：0 間店嘅公司（QA-03 重現形態）+ 兩間店各 1 條通知
  await prisma.company.upsert({
    where: { code: COMPANY_CODE },
    update: {},
    create: { code: COMPANY_CODE, name: "FX03 測試公司（0 店）" },
  });
  await prisma.staffNotice.deleteMany({ where: { id: { in: [NOTICE_TKW, NOTICE_MF] } } });
  await prisma.staffNoticeRead.deleteMany({ where: { noticeId: { in: [NOTICE_TKW, NOTICE_MF] } } });
  await prisma.staffNotice.create({
    data: { id: NOTICE_TKW, clinicId: tkwClinicId, kind: "URGENT_ESCALATION", title: "fx03 急症（TKW）" },
  });
  await prisma.staffNotice.create({
    data: { id: NOTICE_MF, clinicId: mfClinicId, kind: "SYSTEM", title: "fx03 系統（MF）" },
  });
});

after(async () => {
  await prisma.staffNoticeRead.deleteMany({ where: { noticeId: { in: [NOTICE_TKW, NOTICE_MF] } } });
  await prisma.staffNotice.deleteMany({ where: { id: { in: [NOTICE_TKW, NOTICE_MF] } } });
  await prisma.company.deleteMany({ where: { code: COMPANY_CODE } });
  // rbac 鏈會連 Redis（shared connection 令 event loop 唔空 → process 不退出）— 顯式 close
  await closeRedis();
  await prisma.$disconnect();
});

test("QA-03 重現修復：COMPANY ADMIN（0 店）GET notices = 0（唔洩其他店）", async () => {
  const ctx = makeCtx({ role: "ADMIN", scopeType: "COMPANY", scopedClinicIds: [] }, adminId);
  const res = await handleNoticesGet(ctx, null);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { notices: unknown[]; count: number };
  assert.equal(body.count, 0);
  assert.deepEqual(body.notices, []);
});

test("QA-03 重現修復：空範圍 PATCH（冇 ids）= 0 且零副作用", async () => {
  const ctx = makeCtx({ role: "ADMIN", scopeType: "COMPANY", scopedClinicIds: [] }, adminId);
  const res = await handleNoticesPatch(ctx, null);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { updated: number; shopCleared: number };
  assert.equal(body.updated, 0);
  assert.equal(body.shopCleared, 0);
  // 零副作用：冇 per-staff 已讀行、全店欄都唔設
  const reads = await prisma.staffNoticeRead.count({ where: { staffId: adminId } });
  assert.equal(reads, 0);
  for (const id of [NOTICE_TKW, NOTICE_MF]) {
    const n = await prisma.staffNotice.findUnique({ where: { id } });
    assert.equal(n!.readAt, null, `${id} 全店 readAt 唔應該被空範圍 PATCH 標記`);
  }
});

test("regression：ALL scope（set=null）照樣全店可見", async () => {
  const ctx = makeCtx({ role: "ADMIN", scopeType: "ALL", scopedClinicIds: [] }, adminId);
  const res = await handleNoticesGet(ctx, null);
  const body = (await res.json()) as { notices: { id: string }[]; count: number };
  const ids = body.notices.map((n) => n.id);
  assert.ok(body.count >= 1, "ALL scope 應該見到通知");
  assert.ok(ids.includes(NOTICE_TKW), "TKW 急症通知喺 ALL scope 要見到");
});

test("regression：CLINICS scope（[TKW]）只見到自己店", async () => {
  const ctx = makeCtx({ role: "ADMIN", scopeType: "CLINICS", scopedClinicIds: [tkwClinicId] }, adminId);
  const res = await handleNoticesGet(ctx, null);
  const body = (await res.json()) as { notices: { id: string; clinicId: string }[]; count: number };
  assert.ok(body.notices.some((n) => n.id === NOTICE_TKW), "自己店通知要見到");
  assert.ok(!body.notices.some((n) => n.id === NOTICE_MF), "外店通知唔可以見到");
});

test("PATCH ids 跨店攔截：CLINICS [TKW] 標 MF 通知 → updated 0", async () => {
  const ctx = makeCtx({ role: "ADMIN", scopeType: "CLINICS", scopedClinicIds: [tkwClinicId] }, adminId);
  const res = await handleNoticesPatch(ctx, { ids: [NOTICE_MF] });
  const body = (await res.json()) as { updated: number };
  assert.equal(body.updated, 0);
});

test("PATCH ids 在 scope 內 → updated 1 + per-staff 已讀行", async () => {
  const ctx = makeCtx({ role: "ADMIN", scopeType: "CLINICS", scopedClinicIds: [tkwClinicId] }, adminId);
  const res = await handleNoticesPatch(ctx, { ids: [NOTICE_TKW] });
  const body = (await res.json()) as { updated: number; shopCleared: number };
  assert.equal(body.updated, 1);
  // ADMIN → 全店欄都會設（shopCleared 1）
  assert.equal(body.shopCleared, 1);
  const read = await prisma.staffNoticeRead.findFirst({ where: { noticeId: NOTICE_TKW, staffId: adminId } });
  assert.ok(read, "per-staff 已讀行要建立");
  // 清返 — 之後嘅 test 唔受影響
  await prisma.staffNoticeRead.deleteMany({ where: { noticeId: NOTICE_TKW, staffId: adminId } });
  await prisma.staffNotice.update({ where: { id: NOTICE_TKW }, data: { readAt: null, readByStaffId: null } });
});

test("GET clinicParam 外範圍 → 403（RbacError）", async () => {
  const ctx = makeCtx({ role: "ADMIN", scopeType: "CLINICS", scopedClinicIds: [mfClinicId] }, adminId);
  await assert.rejects(
    handleNoticesGet(ctx, tkwClinicId),
    (err: unknown) => (err as { status?: number }).status === 403,
    "外範圍 clinicId 應該 403"
  );
});

test("PATCH 空 ids 陣列 → 400 ids required", async () => {
  const ctx = makeCtx({ role: "ADMIN", scopeType: "ALL", scopedClinicIds: [] }, adminId);
  const res = await handleNoticesPatch(ctx, { ids: [] });
  assert.equal(res.status, 400);
});

test("STAFF 空店集合（壞 session 形態）→ GET 零資料唔 throw（fail-closed）", async () => {
  const ctx = makeCtx({ role: "STAFF", scopeType: "CLINICS", scopedClinicIds: [] }, adminId);
  const res = await handleNoticesGet(ctx, null);
  const body = (await res.json()) as { count: number };
  assert.equal(body.count, 0);
});

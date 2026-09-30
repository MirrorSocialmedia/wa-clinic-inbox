/**
 * T779 — FX-32（QA-32）：telemetry 每 staff 每日每事件只計 1 次。
 * - 同 staff 同日再 POST → 唔計（SET tel:<event>:<staff>:<date> 1 EX 90000 NX 回 null）
 * - 另一個 staff 同日 → 照計（key 含 staffId）
 * - client 契約唔變：每次照回 200 {ok:true}（唔好 429/改 status — UI 依賴）
 *
 * 口徑：node:test 直打 POST handler；真 dev DB/Redis；
 * fixture：用 seeded admin + staff-tkw（唔建用戶）；counter row 先 record 舊值，after() 還原；
 * redis dedup key 開頭先清、結尾清走。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { POST } from "./route";
import { getAppRedis, closeRedis } from "@/lib/queue";
import {
  loadEnvIfMissing,
  sessionCookie,
  jsonReq,
  drainRes,
  readJson,
  hktDateStr,
} from "../messages/qa3b-test-helpers";

const EVENT = "listTruncated";
let prisma: PrismaClient;
let redis: ReturnType<typeof getAppRedis>;
let adminCookie: string;
let staffCookie: string;
let adminId: string;
let staffId: string;
let dateStr: string;
let prevCount: number | null;

const telKey = (staff: string) => `tel:${EVENT}:${staff}:${dateStr}`;

before(async () => {
  loadEnvIfMissing();
  prisma = new PrismaClient();
  redis = getAppRedis();
  const [admin, staff] = await Promise.all([
    prisma.staffUser.findUnique({ where: { email: "admin@wa-clinic.local" } }),
    prisma.staffUser.findUnique({ where: { email: "staff-tkw@wa-clinic.local" } }),
  ]);
  if (!admin || !staff) throw new Error("T779: admin / staff-tkw 未 seed");
  if (!staff.clinicId) throw new Error("T779: staff-tkw 冇 clinicId（STAFF session fail-closed 必需）");
  adminId = admin.id;
  staffId = staff.id;
  dateStr = hktDateStr();
  adminCookie = await sessionCookie({
    staffId: admin.id,
    role: "ADMIN",
    name: admin.name,
    email: admin.email,
    clinicId: null,
    scopeType: "ALL",
  });
  // STAFF + CLINICS scope fail-closed：session 必須帶 clinicId／clinicIds（rbac.ts toContext）
  staffCookie = await sessionCookie({
    staffId: staff.id,
    role: "STAFF",
    name: staff.name,
    email: staff.email,
    clinicId: staff.clinicId,
    clinicIds: [staff.clinicId],
    scopeType: "CLINICS",
  });
  // 乾淨起步：清 dedup key + record counter 舊值
  await redis.del(telKey(adminId), telKey(staffId)).catch(() => {});
  const row = await prisma.telemetryCounter.findUnique({ where: { key: EVENT } });
  prevCount = row ? row.count : null;
});

after(async () => {
  if (prisma) {
    try {
      await redis.del(telKey(adminId), telKey(staffId)).catch(() => {});
      if (prevCount === null) {
        await prisma.telemetryCounter.deleteMany({ where: { key: EVENT } }).catch(() => {});
      } else {
        await prisma.telemetryCounter
          .updateMany({ where: { key: EVENT }, data: { count: prevCount } })
          .catch(() => {});
      }
    } finally {
      // queue.ts 的 sharedRedis（BullMQ queues 共用）唔 close 會 hold 住 event loop → test process hang（outbound.worker.test 同口徑）
      await closeRedis().catch(() => {});
      await prisma.$disconnect().catch(() => {});
    }
  }
});

async function post(cookie: string): Promise<number> {
  const res = await POST(jsonReq("/api/telemetry", { event: EVENT }, cookie), { params: Promise.resolve({}) });
  const body = await readJson<{ ok?: boolean; error?: string }>(res);
  await drainRes(res);
  assert.equal(res.status, 200, `telemetry POST 必須照回 200（client 契約），得 ${res.status}: ${JSON.stringify(body)}`);
  assert.equal(body.ok, true);
  const row = await prisma.telemetryCounter.findUnique({ where: { key: EVENT } });
  return row?.count ?? 0;
}

test("T779a — 同 staff 每日每事件只計 1 次：第 1 筆 +1，第 2/3 筆 +0", async () => {
  const c0 = (await prisma.telemetryCounter.findUnique({ where: { key: EVENT } }))?.count ?? 0;
  await post(adminCookie);
  const c1 = (await prisma.telemetryCounter.findUnique({ where: { key: EVENT } }))?.count ?? 0;
  assert.equal(c1, c0 + 1, "當日首筆必須 +1");
  assert.equal((await redis.get(telKey(adminId))) === "1", true, "dedup key 必須 SET 咗（NX）");
  await post(adminCookie);
  const c2 = (await prisma.telemetryCounter.findUnique({ where: { key: EVENT } }))?.count ?? 0;
  assert.equal(c2, c0 + 1, "當日第 2 筆唔好再計（FX-32 核心）");
  await post(adminCookie);
  const c3 = (await prisma.telemetryCounter.findUnique({ where: { key: EVENT } }))?.count ?? 0;
  assert.equal(c3, c0 + 1, "當日第 3 筆唔好再計");
});

test("T779b — 另一個 staff 同日 → 照計（key 含 staffId）", async () => {
  const c0 = (await prisma.telemetryCounter.findUnique({ where: { key: EVENT } }))?.count ?? 0;
  await post(staffCookie);
  const c1 = (await prisma.telemetryCounter.findUnique({ where: { key: EVENT } }))?.count ?? 0;
  assert.equal(c1, c0 + 1, "唔同 staff 唔好共享 dedup key");
});

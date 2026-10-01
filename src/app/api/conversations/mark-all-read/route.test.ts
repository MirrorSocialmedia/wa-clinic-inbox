/**
 * cwi-ux UX-01 T-UX01a–e — 一鍵已讀（內部通知 + 訊息未讀，老細拍板選項①：急症唔一齊清）
 *
 * 運行：TZ=UTC npx tsx --test src/app/api/conversations/mark-all-read/route.test.ts
 *   （要 DB + Redis：npx 唔似 pnpm 自動注入 .env，未設時自己讀 repo root .env —
 *     同 notices route.test.ts 口徑）
 *
 * 直接調 exported handler 核心（markAllRead / noticesPatch / noticesGet，ctx 注入），
 * 唔起 server（redline：unit test only）。
 *
 * ★ 隔離設計（dev DB 係共享 / 有 mock-e2e 殘留）：全部 fixture 放兩間專屬 clinic
 * （UX01A / UX01B，code unique）+ 兩個專屬 STAFF（ux01-s / ux01-m）—
 *   斷言只計 fixture id 集合，唔受其他店 / 其他 staff 嘅殘留資料影響。
 *   SUPERVISOR / ADMIN 用 seed 帳號，但作用範圍用 clinicParam 收窄住專屬 clinic。
 *
 * fixtures（決定性 id，prefix ux01 — cleanup before/after）：
 *   對話 4 條：A=UX01A assignee=S / B=UX01A assignee=M / C=UX01A 未指派 / D=UX01B 未指派。
 *   通知 4 條（UX01A）：3 普通（SYSTEM/MEDIA_RECEIVED/BOOKING_AUTO）+ 1 URGENT_ESCALATION。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import IORedis from "ioredis";
import type { AuthContext } from "@/lib/rbac";
import { closeRedis } from "@/lib/queue";
import { markAllRead } from "./handler-core";
import { noticesGet, noticesPatch } from "@/app/api/notices/handler-core";
import { loadMyUnreadByConv } from "@/lib/inbox/conversation-list";
import { NOTIFY_CHANNEL } from "@/lib/notify";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** npx tsx 唔自動載 .env — DATABASE_URL/REDIS_URL 未設時從 repo root 補（唔覆蓋已有值）。 */
function ensureEnv(): void {
  if (process.env.DATABASE_URL && process.env.REDIS_URL) return;
  try {
    const env = readFileSync(path.resolve(__dirname, "../../../.env"), "utf8");
    for (const line of env.split("\n")) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)=(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {
    /* 冇 .env → Prisma/Redis 報錯，fail loud 得 */
  }
}
ensureEnv();

const prisma = new PrismaClient();

// ── 決定性 fixture ids ──────────────────────────────────────────────────
const CLINIC_A = "UX01A"; // 主力測試店（對話 A/B/C + 通知）
const CLINIC_B = "UX01B"; // 跨店 scope 測試店（對話 D）
const CLINIC_C = "UX01C"; // 上限測試店（505 多出行 — 隔離咗先唔影響 A/B 嘅非 capped 斷言）
const STAFF_S = "ux01s00000000000000000000000001"; // STAFF，綁 CLINIC_A（「A」）
const STAFF_M = "ux01m00000000000000000000000002"; // STAFF，綁 CLINIC_B（「同事 B」）
const CONV_A = "ux01a0000000000000000000000000a"; // CLINIC_A assignee=S
const CONV_B = "ux01b0000000000000000000000000b"; // CLINIC_A assignee=M（B 負責）
const CONV_C = "ux01c0000000000000000000000000c"; // CLINIC_A 未指派
const CONV_D = "ux01d0000000000000000000000000d"; // CLINIC_B 未指派（S 範圍外）
const CONTACT_A = "ux01p00000000000000000000000001";
const CONTACT_B = "ux01p00000000000000000000000002";
const CONTACT_C = "ux01p00000000000000000000000003";
const CONTACT_D = "ux01p00000000000000000000000004";
const NOTICE_N1 = "ux01n00000000000000000000000001";
const NOTICE_N2 = "ux01n00000000000000000000000002";
const NOTICE_N3 = "ux01n00000000000000000000000003";
const NOTICE_U1 = "ux01u00000000000000000000000001"; // URGENT_ESCALATION
const CAP_N = 505; // 上限測試多出行（> 500）
const CAP_IDS = Array.from({ length: CAP_N }, (_, i) => `ux01x${i}`);
const CAP_CONTACT_IDS = Array.from({ length: CAP_N }, (_, i) => `ux01q${String(i).padStart(29, "0")}`); // @@unique([clinicId, contactId]) — 每對話要自己 contact

let clinicAId: string;
let clinicBId: string;
let clinicCId: string;
let supervisorId: string;
let adminId: string;

let redisSub: IORedis;
const redisEvents: { clinicId: string; staffId?: string; event: string; payload: Record<string, unknown> }[] = [];

function makeCtx(
  staff: { id: string; role: "ADMIN" | "STAFF" | "SUPERVISOR"; name: string },
  scope: { scopeType: "ALL" | "COMPANY" | "CLINICS"; scopedClinicIds: string[] }
): AuthContext {
  // handler 核心只用 ctx.staff.{id,role} + scopeType + scopedClinicIds —
  // 其餘欄（clinicId/clinicIds/res）呢幾 handler 唔用，test 用最小 fake（同 notices test 口徑）。
  return {
    staff: { id: staff.id, email: "ux01@wa-clinic.local", name: staff.name, role: staff.role },
    clinicId: null,
    clinicIds: [],
    scopeType: scope.scopeType,
    scopedClinicIds: scope.scopedClinicIds,
  } as unknown as AuthContext;
}

const sCtx = () => makeCtx({ id: STAFF_S, role: "STAFF", name: "UX01 S" }, { scopeType: "CLINICS", scopedClinicIds: [clinicAId] });
const mCtx = () => makeCtx({ id: STAFF_M, role: "STAFF", name: "UX01 M" }, { scopeType: "CLINICS", scopedClinicIds: [clinicBId] });
const adminCtx = () => makeCtx({ id: adminId, role: "ADMIN", name: "ADMIN" }, { scopeType: "ALL", scopedClinicIds: [] });
const supvCtx = () => makeCtx({ id: supervisorId, role: "SUPERVISOR", name: "SUPERVISOR" }, { scopeType: "ALL", scopedClinicIds: [] });

const ALL_CONV_IDS = [CONV_A, CONV_B, CONV_C, CONV_D, ...CAP_IDS];
const NOTICE_IDS = [NOTICE_N1, NOTICE_N2, NOTICE_N3, NOTICE_U1];
const ALL_CONTACT_IDS = [CONTACT_A, CONTACT_B, CONTACT_C, CONTACT_D, ...CAP_CONTACT_IDS];
const STAFF_IDS = [STAFF_S, STAFF_M];
const CLINIC_CODES = [CLINIC_A, CLINIC_B, CLINIC_C];

async function cleanupFixtures(): Promise<void> {
  await prisma.message.deleteMany({ where: { conversationId: { in: ALL_CONV_IDS } } });
  await prisma.conversationRead.deleteMany({ where: { conversationId: { in: ALL_CONV_IDS } } });
  await prisma.conversation.deleteMany({ where: { id: { in: ALL_CONV_IDS } } });
  await prisma.staffNoticeRead.deleteMany({ where: { noticeId: { in: NOTICE_IDS } } });
  await prisma.staffNotice.deleteMany({ where: { id: { in: NOTICE_IDS } } });
  await prisma.auditLog.deleteMany({ where: { action: "CONVERSATIONS_MARK_ALL_READ" } });
  await prisma.contact.deleteMany({ where: { id: { in: ALL_CONTACT_IDS } } });
  await prisma.staffClinic.deleteMany({ where: { staffId: { in: STAFF_IDS } } });
  await prisma.staffUser.deleteMany({ where: { id: { in: STAFF_IDS } } });
  await prisma.clinic.deleteMany({ where: { code: { in: CLINIC_CODES } } });
}

before(async () => {
  // 隔離：重入先清殘留（冪等）
  await cleanupFixtures();

  // 專屬 clinic 三間
  const [ca, cb, cc] = await Promise.all([
    prisma.clinic.create({
      data: { code: CLINIC_A, name: "UX01 測試店 A", waPhoneNumberId: "ux01a-phone", waDisplayNumber: "+60 11-000 0001" },
    }),
    prisma.clinic.create({
      data: { code: CLINIC_B, name: "UX01 測試店 B", waPhoneNumberId: "ux01b-phone", waDisplayNumber: "+60 11-000 0002" },
    }),
    prisma.clinic.create({
      data: { code: CLINIC_C, name: "UX01 測試店 C（上限）", waPhoneNumberId: "ux01c-phone", waDisplayNumber: "+60 11-000 0003" },
    }),
  ]);
  clinicAId = ca.id;
  clinicBId = cb.id;
  clinicCId = cc.id;

  // 專屬 staff 兩個（passwordHash 只需要非空 — fixture 唔會登入）
  const pwHash = "$argon2id$v=19$m=65536,t=3,p=4$ux01fixturehash$ux01fixturehash";
  await prisma.staffUser.create({
    data: { id: STAFF_S, email: "ux01-s@fixture.local", passwordHash: pwHash, name: "UX01 S", role: "STAFF", clinicId: clinicAId },
  });
  await prisma.staffUser.create({
    data: { id: STAFF_M, email: "ux01-m@fixture.local", passwordHash: pwHash, name: "UX01 M", role: "STAFF", clinicId: clinicBId },
  });
  await prisma.staffClinic.create({ data: { staffId: STAFF_S, clinicId: clinicAId, isPrimary: true } });
  await prisma.staffClinic.create({ data: { staffId: STAFF_M, clinicId: clinicBId, isPrimary: true } });

  const [supv, admin] = await Promise.all([
    prisma.staffUser.findUnique({ where: { email: "supervisor@wa-clinic.local" } }),
    prisma.staffUser.findUnique({ where: { email: "admin@wa-clinic.local" } }),
  ]);
  assert.ok(supv && admin, "seed 要有 supervisor / admin");
  supervisorId = supv!.id;
  adminId = admin!.id;

  // contacts（4 條 fixture + 505 上限行專用）
  for (const [i, contactId] of [CONTACT_A, CONTACT_B, CONTACT_C, CONTACT_D].entries()) {
    await prisma.contact.create({
      data: {
        id: contactId,
        clinicId: i < 3 ? clinicAId : clinicBId,
        waId: `6011ux01${i}`,
        profileName: `UX01 病人 ${i + 1}`,
        labels: [],
      },
    });
  }
  await prisma.contact.createMany({
    data: CAP_CONTACT_IDS.map((id, i) => ({
      id,
      clinicId: clinicCId,
      waId: `6011ux01q${i}`,
      profileName: `UX01 cap 病人 ${i}`,
      labels: [],
    })),
  });

  // 對話 4 條 + 每條 1 條 IN 訊息（myUnread 計數用；channel API 同 auto-send-gate 口徑 — 只排除 HISTORY）
  const t0 = Date.now() - 30 * 60 * 1000;
  const convs = [
    { id: CONV_A, clinicId: clinicAId, contact: CONTACT_A, assigneeId: STAFF_S, unreadCount: 3, ts: new Date(t0 + 1000) },
    { id: CONV_B, clinicId: clinicAId, contact: CONTACT_B, assigneeId: STAFF_M, unreadCount: 2, ts: new Date(t0 + 2000) },
    { id: CONV_C, clinicId: clinicAId, contact: CONTACT_C, assigneeId: null, unreadCount: 5, ts: new Date(t0 + 3000) },
    { id: CONV_D, clinicId: clinicBId, contact: CONTACT_D, assigneeId: null, unreadCount: 4, ts: new Date(t0 + 4000) },
  ];
  for (const c of convs) {
    await prisma.conversation.create({
      data: {
        id: c.id,
        clinicId: c.clinicId,
        contactId: c.contact,
        status: "OPEN",
        assigneeId: c.assigneeId,
        unreadCount: c.unreadCount,
        lastMessageAt: c.ts,
        lastInboundAt: c.ts,
      },
    });
    await prisma.message.create({
      data: {
        id: `ux01m-${c.id}`,
        conversationId: c.id,
        direction: "IN",
        channel: "API",
        type: "text",
        body: `ux01 病人訊息 ${c.id}`,
        status: "RECEIVED",
        waTimestamp: c.ts,
        createdAt: c.ts,
      },
    });
  }

  // 上限測試多出行（>500；放 CLINIC_C 隔離 — 唔影響 A/B 嘅非 capped 斷言；
  // 每條自己 contact — @@unique([clinicId, contactId])；最後更新時間喺 fixture 4 條之後）
  const capBase = Date.now() - 1000;
  await prisma.conversation.createMany({
    data: CAP_IDS.map((id, i) => ({
      id,
      clinicId: clinicCId,
      contactId: CAP_CONTACT_IDS[i],
      status: "OPEN",
      unreadCount: 1,
      lastMessageAt: new Date(capBase + i * 1000),
      lastInboundAt: new Date(capBase + i * 1000),
    })),
  });

  // 通知 4 條（CLINIC_A — 專屬店，零殘留干擾）
  await prisma.staffNotice.create({ data: { id: NOTICE_N1, clinicId: clinicAId, kind: "SYSTEM", title: "ux01 普通 1" } });
  await prisma.staffNotice.create({ data: { id: NOTICE_N2, clinicId: clinicAId, kind: "MEDIA_RECEIVED", title: "ux01 普通 2（媒體）" } });
  await prisma.staffNotice.create({ data: { id: NOTICE_N3, clinicId: clinicAId, kind: "BOOKING_AUTO", title: "ux01 普通 3（AI 落單）" } });
  await prisma.staffNotice.create({ data: { id: NOTICE_U1, clinicId: clinicAId, kind: "URGENT_ESCALATION", title: "ux01 急症 — 病人劇痛/高危" } });

  // T-UX01e：Redis NOTIFY_CHANNEL 訂閱（驗證 socket 同步消息）
  redisSub = new IORedis(process.env.REDIS_URL as string);
  redisSub.on("error", () => {
    /* 訂閱連唔上 → waitForRedisEvent timeout → test 失敗（fail loud） */
  });
  await redisSub.subscribe(NOTIFY_CHANNEL);
  redisSub.on("message", (_ch, msg) => {
    try {
      redisEvents.push(JSON.parse(msg) as (typeof redisEvents)[number]);
    } catch {
      /* 唔係 JSON — 忽略 */
    }
  });
});

after(async () => {
  // 防 hang：任何一步失敗都唔好令 prisma/redis 連線留喺 event loop（run1 實錚：
  // before() 失敗 → after() 喺 redisSub.quit() 爆 → $disconnect 未跑到 → process 永挂）
  try {
    await cleanupFixtures();
  } catch (e) {
    process.stderr.write(`[ux01-test] cleanup error (ignored): ${String(e)}\n`);
  }
  if (redisSub) await redisSub.quit().catch(() => redisSub.disconnect());
  try {
    await closeRedis();
  } catch {
    /* ignore */
  }
  await prisma.$disconnect();
});

/** 等特定 (staffId, event) 嘅 NOTIFY_CHANNEL 消息（≤3s）— dev server 有其他事件，要 filter。 */
async function waitForRedisEvent(staffId: string, event: string): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const hit = redisEvents.find((e) => e.staffId === staffId && e.event === event);
    if (hit) return hit.payload;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ── T-UX01a：3 普通 + 1 急症 → 撳「全部已讀」→ badge 由 4 變 1；急症仍喺 ────────────
test("T-UX01a：notice 批量清排除 URGENT_ESCALATION（選項①）— 4→1", async () => {
  // 起點：S 未讀通知 = 4（3 SYSTEM/MEDIA/SLA + 1 URGENT；專屬店零殘留）
  const before = await noticesGet(sCtx(), null);
  assert.equal(before.status, 200);
  const beforeBody = (await before.json()) as { count: number; notices: { id: string }[] };
  assert.equal(beforeBody.count, 4, "起點應有 4 條未讀");
  assert.deepEqual(new Set(beforeBody.notices.map((n) => n.id)), new Set(NOTICE_IDS));

  // 「全部已讀」= PATCH 冇 ids（後端排除 URGENT_ESCALATION — 工單 §1.1 既有行為 = 選項①）
  const res = await noticesPatch(sCtx(), {});
  assert.equal(res.status, 200);
  const body = (await res.json()) as { updated: number };
  assert.equal(body.updated, 3, "只清 3 條非急症");

  // badge 4→1：剩返急症
  const after = (await (await noticesGet(sCtx(), null)).json()) as { notices: { id: string; kind: string }[]; count: number };
  assert.equal(after.count, 1, "剩返 1 條");
  assert.equal(after.notices[0].id, NOTICE_U1, "剩返嗰條係急症");
  assert.equal(after.notices[0].kind, "URGENT_ESCALATION");

  // DB 對位：3 條 StaffNoticeRead（S）+ 急症零 row
  const reads = await prisma.staffNoticeRead.count({ where: { staffId: STAFF_S, noticeId: { in: [NOTICE_N1, NOTICE_N2, NOTICE_N3] } } });
  assert.equal(reads, 3);
  const urgentRead = await prisma.staffNoticeRead.count({ where: { staffId: STAFF_S, noticeId: NOTICE_U1 } });
  assert.equal(urgentRead, 0, "急症唔准俾批量清走（選項①）");
});

// ── T-UX01b：急症逐條「已確認」→ badge 0；DB StaffNoticeRead 有 row ─────────────────
test("T-UX01b：急症逐條「已確認」→ 0 + StaffNoticeRead row", async () => {
  const res = await noticesPatch(sCtx(), { ids: [NOTICE_U1] });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { updated: number };
  assert.equal(body.updated, 1);

  const after = (await (await noticesGet(sCtx(), null)).json()) as { count: number };
  assert.equal(after.count, 0, "badge 0");

  const row = await prisma.staffNoticeRead.findUnique({ where: { noticeId_staffId: { noticeId: NOTICE_U1, staffId: STAFF_S } } });
  assert.ok(row, "DB StaffNoticeRead 有 row");
  assert.ok(row.readAt instanceof Date && row.readAt.getTime() > 0);
});

// ── T-UX01c：STAFF S 撳「訊息全部已讀」→ S 未讀 = 0；同事 M 負責嘅 unreadCount 唔變 ───
test("T-UX01c：S mark-all-read — 自己 myUnread=0；M 負責對話 unreadCount 唔變", async () => {
  const res = await markAllRead(sCtx(), {});
  assert.equal(res.status, 200);
  const body = (await res.json()) as { marked: number; unreadCleared: number; capped: boolean };
  // S 範圍內 = CLINIC_A 對話（A/B/C）— D（CLINIC_B）/ cap 行（CLINIC_C）都唔喺範圍
  assert.equal(body.marked, 3, "S 只標範圍內 3 條");
  assert.equal(body.capped, false);

  // ① S 嘅個人已讀：A/B/C 都有 ConversationRead row（D 冇）
  const reads = await prisma.conversationRead.findMany({ where: { staffId: STAFF_S }, select: { conversationId: true } });
  const readSet = new Set(reads.map((r) => r.conversationId));
  assert.ok(readSet.has(CONV_A) && readSet.has(CONV_B) && readSet.has(CONV_C), "A/B/C 都有 S 嘅 read row");
  assert.ok(!readSet.has(CONV_D), "D 唔喺 S 範圍 — 零新增（scope 正確）");

  // S myUnread = 0（有 IN 訊息嘅對話都清晒 — lastReadAt 之後先計未讀；map 無 key = 0，同 toConversationDTOs `?? 0` 口徑）
  const myUnread = await loadMyUnreadByConv(STAFF_S, [CONV_A, CONV_B, CONV_C]);
  assert.equal(myUnread.get(CONV_A) ?? 0, 0, "S：conv A myUnread=0");
  assert.equal(myUnread.get(CONV_B) ?? 0, 0, "S：conv B myUnread=0（個人已讀獨立）");
  assert.equal(myUnread.get(CONV_C) ?? 0, 0, "S：conv C myUnread=0");

  // ② 全店 unreadCount：只清「S 係負責人」（A）+「未指派且 S 係 STAFF」（C）；M 負責嘅 B 唔變
  const [a, b, c, d] = await Promise.all(
    [CONV_A, CONV_B, CONV_C, CONV_D].map((id) => prisma.conversation.findUnique({ where: { id } }))
  );
  assert.equal(a!.unreadCount, 0, "A（我負責）→ 0");
  assert.equal(b!.unreadCount, 2, "B（同事 M 負責）→ 唔變（M 仲見到未讀）");
  assert.equal(c!.unreadCount, 0, "C（未指派 + S 係 STAFF）→ 0");
  assert.equal(d!.unreadCount, 4, "D（CLINIC_B，範圍外）→ 唔變");
  assert.equal(body.unreadCleared, 2, "A/C 兩條全店 unread 被清");

  // audit log（metadata only — staffId + count，零 PII）
  const audit = await prisma.auditLog.findFirst({
    where: { action: "CONVERSATIONS_MARK_ALL_READ", staffId: STAFF_S },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(audit, "audit log 有 row");
  assert.deepEqual(audit.meta, { count: 3, unreadCleared: 2, capped: false });
});

// ── T-UX01c2：SUPERVISOR 撳 → 自己 myUnread = 0；全部 Conversation.unreadCount 唔變 ───
test("T-UX01c2：SUPERVISOR mark-all-read — myUnread=0 但全店 unreadCount 全唔變", async () => {
  // SUPERVISOR 全店 scope 好闊（dev DB 有殘留）— 用 clinicParam 收窄住 CLINIC_A 斷言
  const res = await markAllRead(supvCtx(), { clinicId: clinicAId });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { marked: number; unreadCleared: number };
  assert.equal(body.marked, 3, "CLINIC_A 範圍 3 條都標個人已讀");
  assert.equal(body.unreadCleared, 0, "SUPERVISOR 唔清任何全店 unreadCount");

  const myUnread = await loadMyUnreadByConv(supervisorId, [CONV_A, CONV_B, CONV_C]);
  for (const id of [CONV_A, CONV_B, CONV_C]) {
    assert.equal(myUnread.get(id) ?? 0, 0, `SUPERVISOR：${id} myUnread=0`);
  }

  // unreadCount 全維持 T-UX01c 之後嘅值（A=0 / B=2 / C=0 / D=4 — SUPERVISOR 冇改任何一條）
  const [a, b, c, d] = await Promise.all(
    [CONV_A, CONV_B, CONV_C, CONV_D].map((id) => prisma.conversation.findUnique({ where: { id } }))
  );
  assert.equal(a!.unreadCount, 0);
  assert.equal(b!.unreadCount, 2, "B（M 負責）— SUPERVISOR 唔清");
  assert.equal(c!.unreadCount, 0);
  assert.equal(d!.unreadCount, 4, "D（未指派）— SUPERVISOR 亦唔清（全店未處理語義）");
});

// ── T-UX01d：S（CLINIC_A staff）撳 → CLINIC_B 對話 ConversationRead 零新增（scope 正確）
test("T-UX01d：S 對 CLINIC_B 對話零 ConversationRead（跨店 scope）", async () => {
  const rows = await prisma.conversationRead.count({ where: { staffId: STAFF_S, conversationId: CONV_D } });
  assert.equal(rows, 0, "CLINIC_B 對話（D）唔喺 S 範圍 — 零 read row");
  // M 由頭到尾冇撳過 mark-all-read → M 零 row
  const mRows = await prisma.conversationRead.count({ where: { staffId: STAFF_M, conversationId: { in: [CONV_A, CONV_B, CONV_C, CONV_D] } } });
  assert.equal(mRows, 0, "M 冇參與 — 零 row");
  // M 自己視角：B 嘅 myUnread 仲係 1（佢未讀 — 全店 unreadCount=2 同個人視角都仲喺）
  const mUnread = await loadMyUnreadByConv(STAFF_M, [CONV_B]);
  assert.equal(mUnread.get(CONV_B) ?? 0, 1, "B（M 負責）myUnread 仲係 1 — S 標已讀唔影響 M");
});

// ── T-UX01e：第二部裝置（同一 staff）socket 同步 — conversation:read 定向事件 ─────────
test("T-UX01e：mark-all-read 發 conversation:read（staff 定向）— 其他裝置 badge 同步", async () => {
  redisEvents.length = 0;
  // M 範圍 = CLINIC_B ∪ 我負責（B）= { B, D }
  const res = await markAllRead(mCtx(), {});
  assert.equal(res.status, 200);
  const body = (await res.json()) as { marked: number };
  assert.equal(body.marked, 2, "M 範圍內 2 條（B + D）");

  const payload = await waitForRedisEvent(STAFF_M, "conversation:read");
  assert.ok(payload, "NOTIFY_CHANNEL 收到 staff 定向 conversation:read");
  // 排序 = 列表一致（urgent desc, lastMessageAt desc）→ D（t0+4s）先、B（t0+2s）後
  assert.deepEqual(payload.conversationIds, [CONV_D, CONV_B], "conversationIds = 標咗嘅對話");
  // D（未指派 + M 係 STAFF）+ B（M 係 assignee）→ 兩條全店 unread 都清
  assert.deepEqual(payload.unreadClearedIds, [CONV_D, CONV_B]);
  assert.ok(typeof payload.eventId === "string" && payload.eventId.length > 0, "eventId（client 去重）");

  // 第二部裝置收到事件 patch 後嘅 DB 面對位：B/D unreadCount 都 = 0
  const [b, d] = await Promise.all(
    [CONV_B, CONV_D].map((id) => prisma.conversation.findUnique({ where: { id } }))
  );
  assert.equal(b!.unreadCount, 0, "B（M 負責）→ 0");
  assert.equal(d!.unreadCount, 0, "D（CLINIC_B 未指派 + M 係 STAFF）→ 0");
});

// ── 上限 500（工單 §1.2：一次最多 500 條）─────────────────────────────────────────
test("cap：scope 超過 500 → capped=true + nextCursor；cursor 跟住標剩餘", async () => {
  // CLINIC_C 有 505 條 — ADMIN（全新 read 狀態）用 clinicParam 收窄住 CLINIC_C。
  const res1 = await markAllRead(adminCtx(), { clinicId: clinicCId });
  assert.equal(res1.status, 200);
  const body1 = (await res1.json()) as { marked: number; capped: boolean; nextCursor?: string };
  assert.equal(body1.marked, 500, "cap 500");
  assert.equal(body1.capped, true, "capped=true — 仲有剩");
  assert.ok(typeof body1.nextCursor === "string" && body1.nextCursor.length > 0, "nextCursor（列表同款 keyset）");

  // cursor 跟住撳 → 剩餘 5 條（505 − 500）— 冪等 progress（排序決定性 → cursor 先至標得到）
  const res2 = await markAllRead(adminCtx(), { clinicId: clinicCId, cursor: body1.nextCursor });
  assert.equal(res2.status, 200);
  const body2 = (await res2.json()) as { marked: number; capped: boolean; nextCursor?: string };
  assert.equal(body2.marked, 5, "cursor 標剩餘 5 條");
  assert.equal(body2.capped, false);
  assert.equal(body2.nextCursor, undefined, "冇剩 → 無 nextCursor");

  // ADMIN 而家 CLINIC_C 全部 505 條都有 read row（兩連撳完）
  const rows = await prisma.conversationRead.count({ where: { staffId: adminId, conversationId: { in: CAP_IDS } } });
  assert.equal(rows, 505);
});

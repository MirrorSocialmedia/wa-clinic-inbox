/**
 * ★ cwi-sales-20261028：對話右欄「銷售」動作（轉交／請求／強制接手／收回／意向）+ 新訊息派返負責銷售。
 *
 * 運行：TZ=UTC npx tsx --test src/lib/sales/handover.test.ts（要 DB + Redis — ci-src-tests.sh 已備）
 *
 * H1 新訊息派返負責銷售（負責人唔係佢 — SALES 轉交 + 內部備註）；已經係佢 → 唔郁
 * H2 意向：非銷售 403；負責銷售可以設／清；其他銷售（鎖住）423
 * H3 轉交：只有負責銷售；轉交後對方變負責人、可以覆；收回 → 派返負責銷售
 * H4 請求轉交：通知負責銷售
 * H5 強制接手：STAFF 403；SUPERVISOR 要揀同事；ADMIN 預設接畀自己 + 通知負責銷售
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { closeRedis } from "@/lib/queue";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function ensureEnv(): void {
  if (process.env.DATABASE_URL) return;
  try {
    const env = readFileSync(path.resolve(__dirname, "../../../.env"), "utf8");
    for (const line of env.split("\n")) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)=(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
  } catch {
    /* fail loud via Prisma */
  }
}
ensureEnv();
process.env.WORKFORCE_MOCK = "1";

const prisma = new PrismaClient();
const PFX = "salh";
const CONTACT = `${PFX}contact000000000000001`;
const CONV = `${PFX}conv00000000000000000001`;
const PID = `${PFX}-pat-1`;
const EMAILS = ["salh-own@salh.local", "salh-b@salh.local", "salh-desk@salh.local", "salh-sup@salh.local", "salh-adm@salh.local"];
let clinicId: string;
let owner: string;
let salesB: string;
let desk: string;
let sup: string;
let adm: string;

async function cleanup(): Promise<void> {
  await prisma.salesOwnership.deleteMany({ where: { patientApricotId: PID } });
  await prisma.salesDelegation.deleteMany({ where: { conversationId: CONV } });
  const notices = await prisma.staffNotice.findMany({ where: { conversationId: CONV }, select: { id: true } });
  await prisma.staffNoticeRead.deleteMany({ where: { noticeId: { in: notices.map((n) => n.id) } } });
  await prisma.staffNotice.deleteMany({ where: { conversationId: CONV } });
  await prisma.message.deleteMany({ where: { conversationId: CONV } });
  await prisma.conversation.deleteMany({ where: { id: CONV } });
  await prisma.contact.deleteMany({ where: { id: CONTACT } });
  await prisma.auditLog.deleteMany({ where: { entity: "Conversation", entityId: CONV } });
  await prisma.staffUser.deleteMany({ where: { email: { in: EMAILS } } });
}

before(async () => {
  await cleanup();
  const tkw = await prisma.clinic.findUnique({ where: { code: "TKW" } });
  assert.ok(tkw, "seed 要有 TKW");
  clinicId = tkw.id;
  const mk = async (email: string, name: string, extra: Record<string, unknown> = {}) =>
    (await prisma.staffUser.create({ data: { email, name, role: "STAFF", passwordHash: "x", active: true, clinics: { create: { clinicId } }, ...extra } })).id;
  owner = await mk(EMAILS[0], "SALH 負責銷售", { isSales: true });
  salesB = await mk(EMAILS[1], "SALH 銷售B", { isSales: true });
  desk = await mk(EMAILS[2], "SALH 前台");
  sup = await mk(EMAILS[3], "SALH 主管", { role: "SUPERVISOR" });
  adm = await mk(EMAILS[4], "SALH 老闆", { role: "ADMIN" });
  await prisma.contact.create({ data: { id: CONTACT, clinicId, waId: "85290003101", profileName: "SALH 病人", labels: [] } });
  await prisma.conversation.create({ data: { id: CONV, clinicId, contactId: CONTACT, lastMessageAt: new Date(), pinnedPatientApricotId: PID, assigneeId: desk } });
  await prisma.salesOwnership.create({
    data: { patientApricotId: PID, state: "BOUND", salesStaffId: owner, lastSalesStaffId: owner },
  });
});

after(async () => {
  try {
    await cleanup();
  } finally {
    await closeRedis();
    await prisma.$disconnect();
  }
});

const assignee = async () => (await prisma.conversation.findUnique({ where: { id: CONV }, select: { assigneeId: true } }))?.assigneeId;

test("H1 新訊息派返負責銷售", async () => {
  const { routeLockedConversation } = await import("./core");
  assert.equal(await routeLockedConversation(CONV), owner);
  assert.equal(await assignee(), owner);
  assert.equal(await routeLockedConversation(CONV), null, "已經係負責銷售 → 唔郁");
  const note = await prisma.message.findFirst({ where: { conversationId: CONV, channel: "INTERNAL" }, orderBy: { createdAt: "desc" } });
  assert.match(note?.body ?? "", /自動派返 SALH 負責銷售/);
  const a = await prisma.auditLog.findFirst({ where: { entityId: CONV, action: "TRANSFER" }, orderBy: { createdAt: "desc" } });
  assert.equal((a?.meta as { by?: string } | null)?.by, "SALES");
});

test("H2 意向", async () => {
  const { setSalesIntent, salesView, SalesActionError } = await import("./handover");
  await assert.rejects(setSalesIntent(CONV, { id: desk, role: "STAFF" }, "HIGH"), (e) => e instanceof SalesActionError && e.status === 403);
  await assert.rejects(setSalesIntent(CONV, { id: salesB, role: "STAFF" }, "HIGH"), (e) => e instanceof SalesActionError && e.status === 423);
  await setSalesIntent(CONV, { id: owner, role: "STAFF" }, "MEDIUM");
  const v = await salesView(CONV, { id: owner, role: "STAFF" });
  assert.equal(v.intent?.level, "MEDIUM");
  assert.equal(v.intent?.byName, "SALH 負責銷售");
  assert.equal(v.isOwner, true);
  assert.equal(v.canForce, false);
  await setSalesIntent(CONV, { id: owner, role: "STAFF" }, null);
  assert.equal((await salesView(CONV, { id: owner, role: "STAFF" })).intent, null);
});

test("H3 轉交同收回", async () => {
  const { delegateConversation, revokeDelegation, salesView, SalesActionError } = await import("./handover");
  await assert.rejects(
    delegateConversation({ conversationId: CONV, viewer: { id: desk, role: "STAFF" }, toStaffId: desk, kind: "ONCE" }),
    (e) => e instanceof SalesActionError && e.status === 403
  );
  await assert.rejects(
    delegateConversation({ conversationId: CONV, viewer: { id: owner, role: "STAFF" }, toStaffId: sup, kind: "ONCE" }),
    (e) => e instanceof SalesActionError && e.code === "BAD_TARGET",
    "主管唔覆客"
  );
  await delegateConversation({ conversationId: CONV, viewer: { id: owner, role: "STAFF" }, toStaffId: desk, kind: "ONCE" });
  assert.equal(await assignee(), desk);
  const v = await salesView(CONV, { id: desk, role: "STAFF" });
  assert.equal(v.canReply, true);
  assert.equal(v.delegates.length, 1);
  assert.ok(v.delegates[0].expiresAt, "今次轉交有到期時間");
  await revokeDelegation({ conversationId: CONV, viewer: { id: owner, role: "STAFF" }, delegationId: v.delegates[0].id });
  assert.equal(await assignee(), owner, "收回 → 派返負責銷售");
  assert.equal((await salesView(CONV, { id: desk, role: "STAFF" })).canReply, false);
});

test("H4 請求轉交", async () => {
  const { requestHandover } = await import("./handover");
  await requestHandover({ conversationId: CONV, viewer: { id: desk, role: "STAFF" } });
  const n = await prisma.staffNotice.findFirst({ where: { conversationId: CONV, kind: "SALES_HANDOVER", title: { contains: "SALH 前台" } } });
  assert.deepEqual(n?.targetStaffIds, [owner]);
});

test("H5 強制接手", async () => {
  const { forceTakeover, salesView, SalesActionError } = await import("./handover");
  await assert.rejects(forceTakeover({ conversationId: CONV, viewer: { id: desk, role: "STAFF" } }), (e) => e instanceof SalesActionError && e.status === 403);
  await assert.rejects(forceTakeover({ conversationId: CONV, viewer: { id: sup, role: "SUPERVISOR" } }), (e) => e instanceof SalesActionError && e.code === "BAD_TARGET");
  assert.equal((await salesView(CONV, { id: sup, role: "SUPERVISOR" })).canForce, true);
  assert.equal(await forceTakeover({ conversationId: CONV, viewer: { id: sup, role: "SUPERVISOR" }, toStaffId: desk, reason: "放假" }), desk);
  assert.equal(await assignee(), desk);
  assert.equal(await forceTakeover({ conversationId: CONV, viewer: { id: adm, role: "ADMIN" } }), adm, "ADMIN 預設接畀自己");
  assert.equal((await salesView(CONV, { id: adm, role: "ADMIN" })).canReply, true);
  const n = await prisma.staffNotice.findFirst({ where: { conversationId: CONV, title: { contains: "強制接手" } } });
  assert.deepEqual(n?.targetStaffIds, [owner]);
  const a = await prisma.auditLog.count({ where: { entityId: CONV, action: "SALES_FORCE_TAKEOVER" } });
  assert.equal(a, 2);
});

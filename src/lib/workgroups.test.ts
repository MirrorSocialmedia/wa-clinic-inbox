/**
 * ★ cwi-workgroup-20261104：工作群 — 權限、私隱、防重複、上限（含對抗式測試）。
 * 運行：TZ=UTC npx tsx --test src/lib/workgroups.test.ts（要 DB — ci-src-tests.sh 已備）
 *
 * WG1  老闆開群：名空白／太長／停用員工 → 400；重複加同一人唔會重複
 * WG2  非成員：睇唔到、發唔到（404）；被刪成員即時失去權限；改名／封存
 * WG3  發訊息：空白／太長 400；封存 409；@ 只留成員（自己、外人剔走）
 * WG4  防重複：同一 clientKey 兩次（同並發）→ 一條；未讀計數（自己唔計、@ 另計、已讀只向前）
 * WG5  對話卡：分享者自己冇權 → 403；睇嘅人冇權 → 冇病人資料；有權 → 有名
 * WG6  分頁：before cursor；爛 cursor 400
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { closeRedis } from "@/lib/queue";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  try {
    for (const line of readFileSync(path.resolve(__dirname, "../../.env"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)=(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
  } catch {
    /* fail loud via Prisma */
  }
}

const prisma = new PrismaClient();
const PFX = "wgt";
const EMAILS = ["wgt-boss@wgt.local", "wgt-a@wgt.local", "wgt-b@wgt.local", "wgt-out@wgt.local", "wgt-off@wgt.local"];
const C_TKW = `${PFX}contact0000000000000001`;
const C_MF = `${PFX}contact0000000000000002`;
const CONV_TKW = `${PFX}conv000000000000000001`;
const CONV_MF = `${PFX}conv000000000000000002`;
let boss: string, a: string, b: string, outsider: string, off: string;
let tkwId: string, mfId: string;
let wg: typeof import("./workgroups");

type V = { staff: { id: string; role: "ADMIN" | "STAFF" | "SUPERVISOR"; email: string; name: string }; scopeType: "ALL" | "COMPANY" | "CLINICS"; scopedClinicIds: string[] };
const viewer = (id: string, clinics: string[]): V => ({ staff: { id, role: "STAFF", email: "x@x", name: "x" }, scopeType: "CLINICS", scopedClinicIds: clinics });

async function cleanup() {
  const gs = await prisma.workGroup.findMany({ where: { name: { startsWith: "WGT" } }, select: { id: true } });
  await prisma.workGroup.deleteMany({ where: { id: { in: gs.map((g) => g.id) } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: gs.map((g) => g.id) } } });
  await prisma.conversation.deleteMany({ where: { id: { in: [CONV_TKW, CONV_MF] } } });
  await prisma.contact.deleteMany({ where: { id: { in: [C_TKW, C_MF] } } });
  await prisma.staffUser.deleteMany({ where: { email: { in: EMAILS } } });
}

before(async () => {
  wg = await import("./workgroups");
  await cleanup();
  const tkw = await prisma.clinic.findUniqueOrThrow({ where: { code: "TKW" } });
  const mf = await prisma.clinic.findUniqueOrThrow({ where: { code: "MF" } });
  tkwId = tkw.id;
  mfId = mf.id;
  const mk = async (email: string, name: string, active = true) =>
    (await prisma.staffUser.create({ data: { email, name, role: "STAFF", passwordHash: "x", active, clinics: { create: { clinicId: tkwId, isPrimary: true } } } })).id;
  boss = (await prisma.staffUser.create({ data: { email: EMAILS[0], name: "WGT 老闆", role: "ADMIN", scopeType: "ALL", passwordHash: "x", active: true } })).id;
  a = await mk(EMAILS[1], "WGT 阿A");
  b = await mk(EMAILS[2], "WGT 阿B");
  outsider = await mk(EMAILS[3], "WGT 外人");
  off = await mk(EMAILS[4], "WGT 停用", false);
  await prisma.contact.create({ data: { id: C_TKW, clinicId: tkwId, waId: "85290007701", profileName: "WGT 病人甲", labels: [] } });
  await prisma.contact.create({ data: { id: C_MF, clinicId: mfId, waId: "85290007702", profileName: "WGT 病人乙", labels: [] } });
  await prisma.conversation.create({ data: { id: CONV_TKW, clinicId: tkwId, contactId: C_TKW, lastMessageAt: new Date() } });
  await prisma.conversation.create({ data: { id: CONV_MF, clinicId: mfId, contactId: C_MF, lastMessageAt: new Date() } });
});

after(async () => {
  try {
    await cleanup();
  } finally {
    await closeRedis();
    await prisma.$disconnect();
    const { default: appPrisma } = await import("@/lib/prisma");
    await appPrisma.$disconnect();
  }
});

test("WG1 老闆開群：驗證名同成員；重複加唔重複", async () => {
  await assert.rejects(wg.adminCreateGroup(boss, { name: "   " }), (e) => e instanceof wg.WorkGroupError && e.code === "NAME_REQUIRED");
  await assert.rejects(wg.adminCreateGroup(boss, { name: "WGT" + "長".repeat(40) }), (e) => e instanceof wg.WorkGroupError && e.code === "NAME_TOO_LONG");
  await assert.rejects(wg.adminCreateGroup(boss, { name: "WGT 停用", memberIds: [a, off] }), (e) => e instanceof wg.WorkGroupError && e.code === "BAD_STAFF");
  await assert.rejects(wg.adminCreateGroup(boss, { name: "WGT 假人", memberIds: ["no-such-staff"] }), (e) => e instanceof wg.WorkGroupError && e.code === "BAD_STAFF");
  const id = await wg.adminCreateGroup(boss, { name: "  WGT   店  ", memberIds: [a, a, b] });
  const g = await prisma.workGroup.findUniqueOrThrow({ where: { id }, include: { members: true } });
  assert.equal(g.name, "WGT 店", "名字頭尾／多餘空格收埋");
  assert.equal(g.members.length, 2);
  await wg.adminUpdateGroup(boss, id, { addIds: [a] });
  assert.equal(await prisma.workGroupMember.count({ where: { groupId: id } }), 2, "重複加唔會多一行");
  await assert.rejects(wg.adminUpdateGroup(boss, id, { addIds: [b], removeIds: [b] }), (e) => e instanceof wg.WorkGroupError && e.code === "ADD_REMOVE_SAME");
  await assert.rejects(wg.adminUpdateGroup(boss, "nope", { name: "x" }), (e) => e instanceof wg.WorkGroupError && e.status === 404);
});

test("WG2 非成員睇唔到發唔到；刪成員即時失權；封存唯讀", async () => {
  const id = await wg.adminCreateGroup(boss, { name: "WGT 權限", memberIds: [a, b] });
  await assert.rejects(wg.groupMessages(id, viewer(outsider, [tkwId])), (e) => e instanceof wg.WorkGroupError && e.status === 404);
  await assert.rejects(wg.sendGroupMessage(id, viewer(outsider, [tkwId]), { body: "hi" }), (e) => e instanceof wg.WorkGroupError && e.status === 404);
  // 老闆都要係成員先睇到內容
  await assert.rejects(wg.groupMessages(id, { staff: { id: boss, role: "ADMIN", email: "x@x", name: "x" }, scopeType: "ALL", scopedClinicIds: [] }), (e) => e instanceof wg.WorkGroupError && e.status === 404);
  assert.equal((await wg.myGroups(outsider)).some((g) => g.id === id), false);
  await wg.sendGroupMessage(id, viewer(a, [tkwId]), { body: "hello" });
  await wg.adminUpdateGroup(boss, id, { removeIds: [b] });
  await assert.rejects(wg.groupMessages(id, viewer(b, [tkwId])), (e) => e instanceof wg.WorkGroupError && e.status === 404, "被刪即時睇唔到");
  await wg.adminUpdateGroup(boss, id, { name: "WGT 權限2", archived: true });
  const v = await wg.groupMessages(id, viewer(a, [tkwId]));
  assert.equal(v.group.archived, true);
  assert.equal(v.group.name, "WGT 權限2");
  assert.equal(v.messages.length, 1, "封存照睇到舊訊息");
  await assert.rejects(wg.sendGroupMessage(id, viewer(a, [tkwId]), { body: "x" }), (e) => e instanceof wg.WorkGroupError && e.code === "ARCHIVED");
  await wg.adminUpdateGroup(boss, id, { archived: false });
  await wg.sendGroupMessage(id, viewer(a, [tkwId]), { body: "解封可以再發" });
});

test("WG3 驗證內文；@ 只留成員", async () => {
  const id = await wg.adminCreateGroup(boss, { name: "WGT 內文", memberIds: [a, b] });
  const va = viewer(a, [tkwId]);
  await assert.rejects(wg.sendGroupMessage(id, va, { body: "   " }), (e) => e instanceof wg.WorkGroupError && e.code === "EMPTY");
  await assert.rejects(wg.sendGroupMessage(id, va, { body: "x".repeat(wg.WG_BODY_MAX + 1) }), (e) => e instanceof wg.WorkGroupError && e.code === "TOO_LONG");
  const r = await wg.sendGroupMessage(id, va, { body: "@WGT 阿B 睇下", mentions: [b, a, outsider, "garbage"] });
  assert.deepEqual(r.mentioned, [b], "自己同外人剔走");
  assert.deepEqual(r.notify, [b], "通知成員（唔包自己）");
  const row = await prisma.workGroupMessage.findUniqueOrThrow({ where: { id: r.messageId } });
  assert.deepEqual(row.mentions, [b]);
});

test("WG4 防重複 + 未讀計數", async () => {
  const id = await wg.adminCreateGroup(boss, { name: "WGT 未讀", memberIds: [a, b] });
  const va = viewer(a, [tkwId]);
  const key = "wgtkey0000000001";
  const [x, y] = await Promise.all([wg.sendGroupMessage(id, va, { body: "一次", clientKey: key }), wg.sendGroupMessage(id, va, { body: "一次", clientKey: key })]);
  assert.equal(x.messageId, y.messageId, "並發同 key → 同一條");
  assert.equal(await prisma.workGroupMessage.count({ where: { groupId: id } }), 1);
  const z = await wg.sendGroupMessage(id, va, { body: "一次", clientKey: key });
  assert.equal(z.duplicate, true);
  await wg.sendGroupMessage(id, va, { body: "@WGT 阿B", mentions: [b] });
  const gb = (await wg.myGroups(b)).find((g) => g.id === id)!;
  assert.equal(gb.unread, 2);
  assert.equal(gb.mentionUnread, 1);
  const ga = (await wg.myGroups(a)).find((g) => g.id === id)!;
  assert.equal(ga.unread, 0, "自己發嘅唔計未讀");
  await wg.markGroupRead(id, b);
  assert.equal((await wg.myGroups(b)).find((g) => g.id === id)!.unread, 0);
  // 已讀只向前：舊時間唔會令已讀倒退
  await wg.markGroupRead(id, b, new Date(Date.now() - 86_400_000));
  assert.equal((await wg.myGroups(b)).find((g) => g.id === id)!.unread, 0);
  await assert.rejects(wg.markGroupRead(id, outsider), (e) => e instanceof wg.WorkGroupError && e.status === 404);
  // 封存群唔計入導航 badge
  await wg.sendGroupMessage(id, va, { body: "新" });
  assert.equal((await wg.unreadTotals(b)).unread >= 1, true);
  await wg.adminUpdateGroup(boss, id, { archived: true });
  const before = (await wg.myGroups(b)).filter((g) => !g.archived).reduce((n, g) => n + g.unread, 0);
  assert.equal((await wg.unreadTotals(b)).unread, before);
});

test("WG5 對話卡：分享者冇權 403；睇嘅人冇權冇病人資料", async () => {
  const id = await wg.adminCreateGroup(boss, { name: "WGT 卡", memberIds: [a, b] });
  const aTkw = viewer(a, [tkwId]);
  await assert.rejects(wg.sendGroupMessage(id, aTkw, { body: "", conversationId: CONV_MF }), (e) => e instanceof wg.WorkGroupError && e.code === "CONV_FORBIDDEN", "唔可以借群探其他店");
  await assert.rejects(wg.sendGroupMessage(id, aTkw, { body: "", conversationId: "no-such-conv" }), (e) => e instanceof wg.WorkGroupError && e.code === "CONV_NOT_FOUND");
  await wg.sendGroupMessage(id, aTkw, { body: "睇下呢位", conversationId: CONV_TKW });
  const asA = await wg.groupMessages(id, aTkw);
  assert.equal(asA.messages[0].card?.allowed, true);
  assert.equal(asA.messages[0].card?.name, "WGT 病人甲");
  assert.equal(asA.messages[0].card?.clinicCode, "TKW");
  // b 只有 MF 權限 → 睇到張卡但冇病人資料
  const asB = await wg.groupMessages(id, viewer(b, [mfId]));
  assert.equal(asB.messages[0].card?.allowed, false);
  assert.equal(asB.messages[0].card?.name, null);
  assert.equal(asB.messages[0].card?.patientCode, null);
  // 對話之後被刪 → 當冇權
  await prisma.workGroupMessage.create({ data: { groupId: id, senderId: a, body: "", conversationId: "deleted-conv-id" } });
  const v = await wg.groupMessages(id, aTkw);
  assert.equal(v.messages.at(-1)?.card?.allowed, false);
});

test("WG6 分頁：before cursor；爛 cursor 400", async () => {
  const id = await wg.adminCreateGroup(boss, { name: "WGT 分頁", memberIds: [a] });
  const va = viewer(a, [tkwId]);
  for (let i = 0; i < 5; i++) {
    await prisma.workGroupMessage.create({ data: { groupId: id, senderId: a, body: `m${i}`, createdAt: new Date(Date.now() - (10 - i) * 1000) } });
  }
  const p1 = await wg.groupMessages(id, va, { limit: 2 });
  assert.deepEqual(p1.messages.map((m) => m.body), ["m3", "m4"]);
  assert.equal(p1.hasMore, true);
  const p2 = await wg.groupMessages(id, va, { limit: 2, before: p1.messages[0].id });
  assert.deepEqual(p2.messages.map((m) => m.body), ["m1", "m2"]);
  await assert.rejects(wg.groupMessages(id, va, { before: "bogus" }), (e) => e instanceof wg.WorkGroupError && e.status === 400);
  const other = await wg.adminCreateGroup(boss, { name: "WGT 分頁2", memberIds: [a] });
  await assert.rejects(wg.groupMessages(other, va, { before: p1.messages[0].id }), (e) => e instanceof wg.WorkGroupError && e.status === 400, "其他群嘅 cursor 唔收");
});

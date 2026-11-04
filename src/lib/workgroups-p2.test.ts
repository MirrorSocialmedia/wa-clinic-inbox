/**
 * ★ cwi-workgroup-p2-20261105：工作群第 2 期 + 外部對話 — 對抗式測試（要 DB + Redis）。
 * 運行：TZ=UTC npx tsx --test src/lib/workgroups-p2.test.ts
 *
 * P1  分享並放手：負責人 → 對話變未指派、卡可接；唔係負責人 → 403；冇負責人 → 照分享、卡可接；clientKey 重發唔再放手
 * P2  「我接」並發：5 個成員同時撳 → 只得 1 個接到（對話 assignee = 佢），其餘 409；再撳 409
 * P3  「我接」對抗：卡未放手 409；非成員 404；冇權嗰間店 403；期間有人喺收件箱接咗 → 409 + 卡還原；銷售保護 423；SUPERVISOR 403
 * P4  置頂：最多 3 條（第 4 條 409）；並發 6 個置頂 → 最多 3；取消後可以再置頂；非成員 404；封存 409
 * P5  已讀人數：只計自己發嘅；讀到新訊息先回 advanced=true（防 reload 迴圈）
 * P6  搜尋：內文／檔名（唔分大小寫）；空字 400；非成員 404
 * P7  附件：只有成員攞到 metadata；檔名清洗（路徑／控制字元／副檔名跟真實類型）
 * P8  外部對話：標記 → 收件箱 baseScope 冇咗、外部列表有、realtime payload 帶 external；銷售保護 409；SUPERVISOR 403；冇權 403；取消 → 返收件箱
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
const PFX = "wgp";
const EMAILS = ["wgp-boss@wgp.local", "wgp-a@wgp.local", "wgp-b@wgp.local", "wgp-c@wgp.local", "wgp-d@wgp.local", "wgp-e@wgp.local", "wgp-mf@wgp.local", "wgp-sup@wgp.local"];
const C1 = `${PFX}contact0000000000000001`;
const C2 = `${PFX}contact0000000000000002`;
const C3 = `${PFX}contact0000000000000003`;
const CONV1 = `${PFX}conv000000000000000001`;
const CONV2 = `${PFX}conv000000000000000002`;
const CONV3 = `${PFX}conv000000000000000003`;
let boss: string, a: string, b: string, c: string, d: string, e: string, mfStaff: string, sup: string;
let tkwId: string, mfId: string;
let wg: typeof import("./workgroups");
let ext: typeof import("./external-contacts");
let list: typeof import("./inbox/conversation-list");

type V = { staff: { id: string; role: "ADMIN" | "STAFF" | "SUPERVISOR"; email: string; name: string }; scopeType: "ALL" | "COMPANY" | "CLINICS"; scopedClinicIds: string[] };
const viewer = (id: string, clinics: string[]): V => ({ staff: { id, role: "STAFF", email: "x@x", name: "x" }, scopeType: "CLINICS", scopedClinicIds: clinics });
const bossV = (): V => ({ staff: { id: boss, role: "ADMIN", email: "x@x", name: "x" }, scopeType: "ALL", scopedClinicIds: [] });
const supV = (): V => ({ staff: { id: sup, role: "SUPERVISOR", email: "x@x", name: "x" }, scopeType: "ALL", scopedClinicIds: [] });
const isErr = (code: string) => (x: unknown) => x instanceof Error && (x as { code?: string }).code === code;
const isStatus = (st: number) => (x: unknown) => x instanceof Error && ((x as { status?: number }).status === st || (x as { statusCode?: number }).statusCode === st);

async function cleanup() {
  const gs = await prisma.workGroup.findMany({ where: { name: { startsWith: "WGP" } }, select: { id: true } });
  await prisma.workGroup.deleteMany({ where: { id: { in: gs.map((g) => g.id) } } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...gs.map((g) => g.id), CONV1, CONV2, CONV3, C1, C2, C3] } }, { action: "WORKGROUP_CLAIM", staffId: { in: [] } }] } });
  await prisma.message.deleteMany({ where: { conversationId: { in: [CONV1, CONV2, CONV3] } } });
  await prisma.salesOwnership.deleteMany({ where: { patientApricotId: { startsWith: "wgp-pat" } } });
  await prisma.conversation.deleteMany({ where: { id: { in: [CONV1, CONV2, CONV3] } } });
  await prisma.contact.deleteMany({ where: { id: { in: [C1, C2, C3] } } });
  const staff = await prisma.staffUser.findMany({ where: { email: { in: EMAILS } }, select: { id: true } });
  await prisma.auditLog.deleteMany({ where: { staffId: { in: staff.map((s) => s.id) } } });
  await prisma.staffUser.deleteMany({ where: { email: { in: EMAILS } } });
}

before(async () => {
  wg = await import("./workgroups");
  ext = await import("./external-contacts");
  list = await import("./inbox/conversation-list");
  await cleanup();
  tkwId = (await prisma.clinic.findUniqueOrThrow({ where: { code: "TKW" } })).id;
  mfId = (await prisma.clinic.findUniqueOrThrow({ where: { code: "MF" } })).id;
  const mk = async (email: string, name: string, clinicId = tkwId) =>
    (await prisma.staffUser.create({ data: { email, name, role: "STAFF", passwordHash: "x", active: true, clinicId, clinics: { create: { clinicId, isPrimary: true } } } })).id;
  boss = (await prisma.staffUser.create({ data: { email: EMAILS[0], name: "WGP 老闆", role: "ADMIN", scopeType: "ALL", passwordHash: "x", active: true } })).id;
  a = await mk(EMAILS[1], "WGP 阿A");
  b = await mk(EMAILS[2], "WGP 阿B");
  c = await mk(EMAILS[3], "WGP 阿C");
  d = await mk(EMAILS[4], "WGP 阿D");
  e = await mk(EMAILS[5], "WGP 阿E");
  mfStaff = await mk(EMAILS[6], "WGP MF 員工", mfId);
  sup = (await prisma.staffUser.create({ data: { email: EMAILS[7], name: "WGP 主管", role: "SUPERVISOR", passwordHash: "x", active: true } })).id;
  await prisma.contact.create({ data: { id: C1, clinicId: tkwId, waId: "85290006601", profileName: "WGP 病人甲", labels: [] } });
  await prisma.contact.create({ data: { id: C2, clinicId: tkwId, waId: "85290006602", profileName: "WGP Lab 陳", labels: [] } });
  await prisma.contact.create({ data: { id: C3, clinicId: tkwId, waId: "85290006603", profileName: "WGP 病人丙", labels: [] } });
  await prisma.conversation.create({ data: { id: CONV1, clinicId: tkwId, contactId: C1, lastMessageAt: new Date(), assigneeId: a } });
  await prisma.conversation.create({ data: { id: CONV2, clinicId: tkwId, contactId: C2, lastMessageAt: new Date() } });
  await prisma.conversation.create({ data: { id: CONV3, clinicId: tkwId, contactId: C3, lastMessageAt: new Date() } });
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

test("P1 分享並放手：負責人放手 → 未指派 + 卡可接；非負責人 403；重發唔再放手", async () => {
  const gid = await wg.adminCreateGroup(boss, { name: "WGP 放手", memberIds: [a, b, c, mfStaff] });
  // 唔係負責人（b）揀放手 → 403，冇訊息寫入
  await assert.rejects(wg.sendGroupMessage(gid, viewer(b, [tkwId]), { body: "x", conversationId: CONV1, release: true }), isErr("RELEASE_FORBIDDEN"));
  assert.equal(await prisma.workGroupMessage.count({ where: { groupId: gid } }), 0, "403 唔寫訊息");
  // 冇連對話就放手 → 400
  await assert.rejects(wg.sendGroupMessage(gid, viewer(a, [tkwId]), { body: "x", release: true }), isErr("RELEASE_NEEDS_CONV"));
  const r = await wg.sendGroupMessage(gid, viewer(a, [tkwId]), { body: "我放假，邊個接？", conversationId: CONV1, release: true, clientKey: "wgprelease0001" });
  assert.equal(r.released, true);
  const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: CONV1 } });
  assert.equal(conv.assigneeId, null, "對話放返未指派");
  const vb = await wg.groupMessages(gid, viewer(b, [tkwId]));
  const card = vb.messages.find((m) => m.id === r.messageId)!;
  assert.equal(card.released, true);
  assert.equal(card.claimable, true, "同店成員見到「我接」");
  const vmf = await wg.groupMessages(gid, viewer(mfStaff, [mfId]));
  assert.equal(vmf.messages[0].claimable, false, "冇權嗰間店 → 唔出「我接」");
  assert.equal(vmf.messages[0].card?.name, null, "冇權 → 冇病人名");
  // 重發同一 clientKey：唔會再寫、唔會再放手
  await prisma.conversation.update({ where: { id: CONV1 }, data: { assigneeId: a } });
  const r2 = await wg.sendGroupMessage(gid, viewer(a, [tkwId]), { body: "我放假，邊個接？", conversationId: CONV1, release: true, clientKey: "wgprelease0001" });
  assert.equal(r2.duplicate, true);
  assert.equal(r2.released, false);
  assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: CONV1 } })).assigneeId, a, "重發唔會再放手");
  await prisma.conversation.update({ where: { id: CONV1 }, data: { assigneeId: null } });
  // 本身冇負責人：照分享，卡可接（任何成員都可以揀放手 — 冇嘢放）
  const r3 = await wg.sendGroupMessage(gid, viewer(b, [tkwId]), { body: "", conversationId: CONV3, release: true });
  assert.equal(r3.released, false);
  const v3 = (await wg.groupMessages(gid, viewer(c, [tkwId]))).messages.find((m) => m.id === r3.messageId)!;
  assert.equal(v3.claimable, true);
});

test("P2 「我接」並發：5 個同時撳 → 得 1 個贏", async () => {
  const gid = await wg.adminCreateGroup(boss, { name: "WGP 並發接", memberIds: [a, b, c, d, e] });
  await prisma.conversation.update({ where: { id: CONV3 }, data: { assigneeId: a } });
  const r = await wg.sendGroupMessage(gid, viewer(a, [tkwId]), { body: "", conversationId: CONV3, release: true });
  assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: CONV3 } })).assigneeId, null);
  const who = [b, c, d, e, a];
  const res = await Promise.allSettled(who.map((id) => wg.claimSharedConversation(gid, r.messageId, viewer(id, [tkwId]))));
  const ok = res.filter((x) => x.status === "fulfilled");
  assert.equal(ok.length, 1, `只得一個接到（實際 ${ok.length}）`);
  for (const x of res) if (x.status === "rejected") assert.equal((x.reason as { status?: number }).status, 409, `輸家 409：${(x.reason as Error).message}`);
  const winner = who[res.findIndex((x) => x.status === "fulfilled")];
  const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: CONV3 } });
  assert.equal(conv.assigneeId, winner, "對話負責人 = 贏家");
  const msg = await prisma.workGroupMessage.findUniqueOrThrow({ where: { id: r.messageId } });
  assert.equal(msg.claimedById, winner, "卡記低贏家");
  await assert.rejects(wg.claimSharedConversation(gid, r.messageId, viewer(b, [tkwId])), isStatus(409));
  const v = (await wg.groupMessages(gid, viewer(c, [tkwId]))).messages.find((m) => m.id === r.messageId)!;
  assert.equal(v.claimable, false);
  assert.ok(v.claimedByName, "卡顯示邊個接咗");
});

test("P3 「我接」對抗：未放手／非成員／冇權／期間被人接／銷售保護／主管", async () => {
  const gid = await wg.adminCreateGroup(boss, { name: "WGP 接對抗", memberIds: [a, b, mfStaff, sup] });
  await prisma.conversation.update({ where: { id: CONV1 }, data: { assigneeId: null } });
  const plain = await wg.sendGroupMessage(gid, viewer(a, [tkwId]), { body: "", conversationId: CONV1 });
  await assert.rejects(wg.claimSharedConversation(gid, plain.messageId, viewer(b, [tkwId])), isErr("NOT_RELEASED"));
  const rel = await wg.sendGroupMessage(gid, viewer(a, [tkwId]), { body: "", conversationId: CONV1, release: true });
  await assert.rejects(wg.claimSharedConversation(gid, rel.messageId, viewer(c, [tkwId])), isStatus(404), "非成員 404");
  await assert.rejects(wg.claimSharedConversation(gid, rel.messageId, viewer(mfStaff, [mfId])), isErr("CONV_FORBIDDEN"), "冇權嗰間店 403");
  await assert.rejects(wg.claimSharedConversation(gid, rel.messageId, supV()), isErr("SUPERVISOR_READONLY"));
  await assert.rejects(wg.claimSharedConversation(gid, "nope", viewer(b, [tkwId])), isStatus(404));
  // 期間有人喺收件箱接咗 → 409，卡唔會被佔
  await prisma.conversation.update({ where: { id: CONV1 }, data: { assigneeId: a } });
  await assert.rejects(wg.claimSharedConversation(gid, rel.messageId, viewer(b, [tkwId])), isErr("ALREADY_ASSIGNED"));
  assert.equal((await prisma.workGroupMessage.findUniqueOrThrow({ where: { id: rel.messageId } })).claimedById, null, "卡冇被佔");
  // 封存 → 409
  await prisma.conversation.update({ where: { id: CONV1 }, data: { assigneeId: null } });
  await wg.adminUpdateGroup(boss, gid, { archived: true });
  await assert.rejects(wg.claimSharedConversation(gid, rel.messageId, viewer(b, [tkwId])), isErr("ARCHIVED"));
  await wg.adminUpdateGroup(boss, gid, { archived: false });
  // 銷售保護：唔係負責銷售 → 423
  await prisma.staffUser.update({ where: { id: a }, data: { isSales: true } });
  await prisma.salesOwnership.create({ data: { patientApricotId: "wgp-pat-1", state: "PROTECTED", salesStaffId: a, protectedUntil: new Date(Date.now() + 86400_000) } });
  await prisma.conversation.update({ where: { id: CONV1 }, data: { pinnedPatientApricotId: "wgp-pat-1" } });
  await assert.rejects(wg.claimSharedConversation(gid, rel.messageId, viewer(b, [tkwId])), isErr("SALES_LOCKED"), "唔係負責銷售 → 423");
  assert.equal((await prisma.workGroupMessage.findUniqueOrThrow({ where: { id: rel.messageId } })).claimedById, null, "423 卡冇被佔");
  // 銷售保護病人唔可以標記外部（防借「外部」甩走保護）
  await assert.rejects(ext.markExternal(viewer(a, [tkwId]), CONV1, { name: "x" }), isErr("SALES_PROTECTED"));
  await prisma.salesOwnership.deleteMany({ where: { patientApricotId: "wgp-pat-1" } });
  await prisma.staffUser.update({ where: { id: a }, data: { isSales: false } });
  await prisma.conversation.update({ where: { id: CONV1 }, data: { pinnedPatientApricotId: null } });
  const ok = await wg.claimSharedConversation(gid, rel.messageId, viewer(b, [tkwId]));
  assert.equal(ok.conversationId, CONV1);
});

test("P4 置頂：最多 3 條；並發唔會爆上限；非成員 404；封存 409", async () => {
  const gid = await wg.adminCreateGroup(boss, { name: "WGP 置頂", memberIds: [a, b] });
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) ids.push((await wg.sendGroupMessage(gid, viewer(a, [tkwId]), { body: `m${i}` })).messageId);
  await Promise.allSettled(ids.map((id) => wg.pinGroupMessage(gid, id, b, true)));
  assert.equal(await prisma.workGroupMessage.count({ where: { groupId: gid, pinnedAt: { not: null } } }), 3, "並發都唔超過 3");
  const pinnedNow = await prisma.workGroupMessage.findMany({ where: { groupId: gid, pinnedAt: { not: null } }, select: { id: true } });
  const notPinned = ids.find((id) => !pinnedNow.some((p) => p.id === id))!;
  await assert.rejects(wg.pinGroupMessage(gid, notPinned, a, true), isErr("PIN_LIMIT"));
  await wg.pinGroupMessage(gid, pinnedNow[0].id, a, true); // 已置頂再置頂 = 冪等
  await wg.pinGroupMessage(gid, pinnedNow[0].id, a, false);
  await wg.pinGroupMessage(gid, notPinned, a, true);
  const v = await wg.groupMessages(gid, viewer(a, [tkwId]));
  assert.equal(v.pinned.length, 3);
  assert.ok(v.pinned.some((p) => p.id === notPinned));
  await assert.rejects(wg.pinGroupMessage(gid, ids[0], c, true), isStatus(404), "非成員 404");
  const other = await wg.adminCreateGroup(boss, { name: "WGP 置頂2", memberIds: [a] });
  await assert.rejects(wg.pinGroupMessage(other, ids[0], a, true), isErr("MSG_NOT_FOUND"), "唔可以置頂其他群嘅訊息");
  await wg.adminUpdateGroup(boss, gid, { archived: true });
  await assert.rejects(wg.pinGroupMessage(gid, ids[0], a, false), isErr("ARCHIVED"));
});

test("P5 已讀人數：只計自己發；advanced 只喺讀到新訊息先 true", async () => {
  const gid = await wg.adminCreateGroup(boss, { name: "WGP 已讀", memberIds: [a, b, c] });
  await wg.markGroupRead(gid, b, new Date(Date.now() - 60_000));
  const r = await wg.sendGroupMessage(gid, viewer(a, [tkwId]), { body: "有冇人睇到" });
  let va = (await wg.groupMessages(gid, viewer(a, [tkwId]))).messages.find((m) => m.id === r.messageId)!;
  assert.deepEqual([va.read?.count, va.read?.total], [0, 2]);
  const vb = (await wg.groupMessages(gid, viewer(b, [tkwId]))).messages.find((m) => m.id === r.messageId)!;
  assert.equal(vb.read, null, "人哋發嘅訊息唔顯示已讀");
  assert.equal(await wg.markGroupRead(gid, b), true, "讀到新訊息");
  assert.equal(await wg.markGroupRead(gid, b), false, "冇新訊息 → false（唔再通知）");
  va = (await wg.groupMessages(gid, viewer(a, [tkwId]))).messages.find((m) => m.id === r.messageId)!;
  assert.deepEqual([va.read?.count, va.read?.total], [1, 2]);
  assert.deepEqual(va.read?.names, ["WGP 阿B"]);
});

test("P6 搜尋：內文／檔名；空字 400；非成員 404", async () => {
  const gid = await wg.adminCreateGroup(boss, { name: "WGP 搜尋", memberIds: [a, b] });
  await wg.sendGroupMessage(gid, viewer(a, [tkwId]), { body: "張太個 Crown 聽日到" });
  await wg.sendGroupMessage(gid, viewer(b, [tkwId]), { body: "收到" });
  await wg.sendGroupMessage(gid, viewer(b, [tkwId]), { body: "", attachment: { key: `wg-${"1".repeat(8)}-1111-1111-1111-${"1".repeat(12)}.pdf`, name: "牙模報告.pdf", mime: "application/pdf", size: 1200 } });
  assert.equal((await wg.searchGroupMessages(gid, viewer(b, [tkwId]), "crown")).length, 1, "唔分大小寫");
  assert.equal((await wg.searchGroupMessages(gid, viewer(b, [tkwId]), "牙模")).length, 1, "搵到檔名");
  assert.equal((await wg.searchGroupMessages(gid, viewer(b, [tkwId]), "%")).length, 0, "% 唔係萬用字");
  assert.equal((await wg.searchGroupMessages(gid, viewer(b, [tkwId]), "_")).length, 0, "_ 唔係萬用字");
  assert.equal((await wg.searchGroupMessages(gid, viewer(b, [tkwId]), "\\")).length, 0, "反斜線唔會爆");
  await assert.rejects(wg.searchGroupMessages(gid, viewer(b, [tkwId]), "   "), isErr("EMPTY_QUERY"));
  await assert.rejects(wg.searchGroupMessages(gid, viewer(c, [tkwId]), "crown"), isStatus(404));
});

test("P7 附件：只有成員攞到；檔名清洗", async () => {
  const gid = await wg.adminCreateGroup(boss, { name: "WGP 附件", memberIds: [a] });
  const key = `wg-${"2".repeat(8)}-2222-2222-2222-${"2".repeat(12)}.png`;
  await wg.sendGroupMessage(gid, viewer(a, [tkwId]), { body: "", attachment: { key, name: "x.png", mime: "image/png", size: 10 } });
  assert.deepEqual(await wg.attachmentForViewer(key, a), { name: "x.png", mime: "image/png" });
  assert.equal(await wg.attachmentForViewer(key, b), null, "非成員 → null（route 404）");
  assert.equal(await wg.attachmentForViewer("wg-nope.png", a), null);
  assert.equal(wg.cleanAttachName("../../etc/passwd.exe", "pdf"), "passwd.pdf");
  assert.equal(wg.cleanAttachName("C:\\Users\\病人\\報告.PNG", "png"), "報告.png");
  assert.equal(wg.cleanAttachName("a\u0000b<c>.jpg", "jpg"), "abc.jpg");
  assert.equal(wg.cleanAttachName("", "pdf"), "文件.pdf");
  assert.equal(wg.cleanAttachName(null, "png"), "相片.png");
  // 冇內文冇附件冇卡 → 400
  await assert.rejects(wg.sendGroupMessage(gid, viewer(a, [tkwId]), { body: " " }), isErr("EMPTY"));
});

test("P8 外部對話：標記 → 收件箱冇咗、外部列表有；守門；取消 → 返收件箱", async () => {
  const s = await list.resolveListScope(viewer(a, [tkwId]), null);
  const inInbox = async () => (await prisma.conversation.count({ where: { AND: [list.baseScope(s), { id: CONV2 }] } })) === 1;
  assert.equal(await inInbox(), true);
  // 守門
  await assert.rejects(ext.markExternal(viewer(a, [tkwId]), CONV2, { name: "  " }), isErr("NAME_REQUIRED"));
  await assert.rejects(ext.markExternal(viewer(mfStaff, [mfId]), CONV2, { name: "陳師傅" }), isStatus(403), "冇權嗰間店 403");
  await assert.rejects(ext.markExternal(supV(), CONV2, { name: "陳師傅" }), isStatus(403), "主管唯讀 403");
  await assert.rejects(ext.markExternal(viewer(a, [tkwId]), "nope", { name: "陳師傅" }), isStatus(404));
  // 跟進建議會被取消
  const task = await prisma.followupTask.create({ data: { clinicId: tkwId, conversationId: CONV2, dueAt: new Date(), status: "SUGGESTED", source: "MANUAL", phoneHashes: [] } as never }).catch(() => null);
  await ext.markExternal(viewer(a, [tkwId]), CONV2, { name: "陳師傅\u0007", org: " 明德   Lab " });
  const ct = await prisma.contact.findUniqueOrThrow({ where: { id: C2 } });
  assert.equal(ct.externalName, "陳師傅", "控制字元剔走");
  assert.equal(ct.externalOrg, "明德 Lab");
  assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: CONV2 } })).external, true);
  assert.equal(await inInbox(), false, "收件箱列表冇咗");
  assert.equal(await prisma.conversation.count({ where: { AND: [list.baseScopeWithExternal(s), { id: CONV2 }] } }), 1, "深連結仲開到");
  if (task) assert.equal((await prisma.followupTask.findUniqueOrThrow({ where: { id: task.id } })).status, "CANCELLED", "跟進建議取消");
  const rows = await ext.listExternalConversations(viewer(a, [tkwId]));
  const row = rows.find((r) => r.conversationId === CONV2);
  assert.ok(row, "外部列表有");
  assert.equal(row!.name, "陳師傅");
  assert.equal(row!.org, "明德 Lab");
  assert.equal((await ext.listExternalConversations(viewer(mfStaff, [mfId]))).some((r) => r.conversationId === CONV2), false, "其他店睇唔到");
  assert.deepEqual(await ext.externalInfo(viewer(a, [tkwId]), CONV2), { name: "陳師傅", org: "明德 Lab" });
  await assert.rejects(ext.externalInfo(viewer(mfStaff, [mfId]), CONV2), isStatus(403));
  await assert.rejects(ext.markExternal(viewer(a, [tkwId]), CONV2, { name: "x" }), isErr("ALREADY_EXTERNAL"));
  // realtime message:new 要帶 external（否則 client 會喺收件箱列表插返條 row）
  const m = await prisma.message.create({ data: { conversationId: CONV2, direction: "IN", channel: "API", type: "text", body: "牙模到咗", status: "RECEIVED", waTimestamp: new Date() } });
  const { buildMessageNewPayload } = await import("./realtime-payload");
  assert.equal((await buildMessageNewPayload(m.id)).conversation.external, true, "payload 帶 external=true");
  // 外部對話嘅 audit 唔帶名
  const aud = await prisma.auditLog.findFirstOrThrow({ where: { action: "CONTACT_MARK_EXTERNAL", entityId: C2 } });
  assert.equal(JSON.stringify(aud.meta).includes("陳師傅"), false, "audit 零名");
  // 取消
  await ext.unmarkExternal(viewer(b, [tkwId]), CONV2);
  assert.equal(await inInbox(), true, "返返收件箱");
  assert.equal((await prisma.contact.findUniqueOrThrow({ where: { id: C2 } })).externalAt, null);
  await assert.rejects(ext.unmarkExternal(viewer(b, [tkwId]), CONV2), isErr("NOT_EXTERNAL"));
  if (task) await prisma.followupTask.delete({ where: { id: task.id } });
});

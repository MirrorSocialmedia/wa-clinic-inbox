/**
 * ★ cwi-reminder-20261025：「⏰ 待跟進」員工自設提醒（取代「等回覆」）。
 *
 * 運行：TZ=UTC npx tsx --test src/lib/followup/reminder.test.ts（要 DB + Redis — ci-src-tests.sh 已備）
 *
 * R1 日子計算：聽日 = 香港 09:00；今日 = 即刻；超過 180 日／過去 → 拒
 * R2 設提醒：MANUAL SUGGESTED；RESOLVED 對話翻返 OPEN；再設 = 改（唔疊）；預設提醒設定者
 * R3 未到期：唔出卡（tasks view）、唔入「待跟進」（loadFollowupDue）；列表 DTO 有 reminder
 * R4 到期：出卡 + 入「待跟進」+ 🔔 FOLLOWUP_REMINDER 定向設定者；再 scan 唔重發
 * R5 再延 3 日 → 清 notifiedAt、未到期；已跟進 → COMPLETED；取消 → CANCELLED MANUAL
 * R6 病人喺設定後覆咗 → recheck 自動取消（REPLIED）
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
const PFX = "remt";
const CONTACT = `${PFX}contact00000000000001`;
const CONV = `${PFX}conv0000000000000000001`;
let clinicId: string;
let meId: string;
let ownerId: string;

async function cleanup(): Promise<void> {
  const notices = await prisma.staffNotice.findMany({ where: { conversationId: CONV }, select: { id: true } });
  await prisma.staffNoticeRead.deleteMany({ where: { noticeId: { in: notices.map((n) => n.id) } } });
  await prisma.staffNotice.deleteMany({ where: { conversationId: CONV } });
  await prisma.followupTask.deleteMany({ where: { conversationId: CONV } });
  await prisma.conversation.deleteMany({ where: { id: CONV } });
  await prisma.contact.deleteMany({ where: { id: CONTACT } });
  await prisma.staffUser.deleteMany({ where: { email: { in: ["remt-me@remt.local", "remt-owner@remt.local"] } } });
}

before(async () => {
  await cleanup();
  const tkw = await prisma.clinic.findUnique({ where: { code: "TKW" } });
  assert.ok(tkw, "seed 要有 TKW");
  clinicId = tkw.id;
  const mk = (email: string, name: string) =>
    prisma.staffUser.create({ data: { email, name, role: "STAFF", passwordHash: "x", active: true, clinics: { create: { clinicId } } } });
  meId = (await mk("remt-me@remt.local", "REMT 我")).id;
  ownerId = (await mk("remt-owner@remt.local", "REMT 負責人")).id;
  await prisma.contact.create({ data: { id: CONTACT, clinicId, waId: "85290002001", profileName: "REMT 病人", labels: [] } });
  await prisma.conversation.create({
    data: { id: CONV, clinicId, contactId: CONTACT, status: "RESOLVED", assigneeId: ownerId, lastMessageAt: new Date(), lastInboundAt: new Date(Date.now() - 3600_000) },
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

test("R1 日子計算", async () => {
  const { reminderDueAt, reminderDateFromBody } = await import("./reminder");
  const now = new Date("2026-10-25T03:00:00Z"); // 香港 11:00
  assert.equal(reminderDateFromBody({ days: 1 }, now), "2026-10-26");
  assert.equal(reminderDueAt("2026-10-26", now).toISOString(), "2026-10-26T01:00:00.000Z"); // 香港 09:00
  assert.equal(reminderDueAt("2026-10-25", now).getTime(), now.getTime()); // 今日 = 即刻
  assert.equal(reminderDateFromBody({ days: 181 }, now), null);
  assert.equal(reminderDateFromBody({ date: "2026-10-24" }, now), null);
  assert.equal(reminderDateFromBody({ date: "2026-11-01" }, now), "2026-11-01");
});

test("R2–R3 設提醒（未到期）：RESOLVED 翻開、唔疊、唔出卡、唔入待跟進", async () => {
  const { setReminder, openRemindersByConv } = await import("./reminder");
  const r1 = await setReminder({ conversationId: CONV, staffId: meId, date: "2099-01-01", reason: "等保險", target: "me" });
  assert.equal(r1.remindStaffId, meId, "預設提醒設定者");
  assert.equal(r1.due, false);
  const conv = await prisma.conversation.findUnique({ where: { id: CONV }, select: { status: true } });
  assert.equal(conv?.status, "OPEN", "RESOLVED → OPEN");
  // 再設 = 改（唔疊）
  await setReminder({ conversationId: CONV, staffId: meId, date: "2099-01-02", reason: "改咗", target: "assignee" });
  const rows = await prisma.followupTask.findMany({ where: { conversationId: CONV, source: "MANUAL", status: "SUGGESTED" } });
  assert.equal(rows.length, 1);
  assert.equal((rows[0].contextJson as { remindStaffId: string }).remindStaffId, ownerId, "target=assignee → 負責人");
  // 未到期：tasks view 唔出、loadFollowupDue 唔入；DTO 有 reminder
  const { buildFollowupTaskViews } = await import("./tasks-view");
  const views = (await buildFollowupTaskViews({ conversationId: CONV, clinicSet: null })) as { id: string }[];
  assert.equal(views.length, 0, "未到期唔出卡");
  const { loadFollowupDue } = await import("@/lib/inbox/conversation-list");
  const due = await loadFollowupDue({ scopedSet: null } as never);
  assert.equal(due.has(CONV), false, "未到期唔入待跟進");
  const map = await openRemindersByConv([CONV]);
  assert.equal(map.get(CONV)?.reason, "改咗");
});

test("R4 到期：出卡 + 入待跟進 + 🔔 定向；唔重發", async () => {
  const { notifyDueReminders, setReminder } = await import("./reminder");
  await setReminder({ conversationId: CONV, staffId: meId, date: "2000-01-01", reason: "到期", target: "me" }); // 過去 → 即刻到期
  const { buildFollowupTaskViews } = await import("./tasks-view");
  const views = (await buildFollowupTaskViews({ conversationId: CONV, clinicSet: null })) as { source: string }[];
  assert.equal(views.length, 1);
  assert.equal(views[0].source, "MANUAL");
  const { loadFollowupDue } = await import("@/lib/inbox/conversation-list");
  assert.equal((await loadFollowupDue({ scopedSet: null } as never)).has(CONV), true, "到期入待跟進");
  await notifyDueReminders();
  await notifyDueReminders(); // 唔重發
  const notices = await prisma.staffNotice.findMany({ where: { conversationId: CONV, kind: "FOLLOWUP_REMINDER" } });
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0].targetStaffIds, [meId]);
});

test("R5 再延／已跟進／取消", async () => {
  const { actOnReminder, setReminder } = await import("./reminder");
  const snoozed = await actOnReminder({ conversationId: CONV, staffId: meId, action: "snooze", days: 3 });
  assert.ok(snoozed && "due" in snoozed && snoozed.due === false, "再延 → 未到期");
  const t = await prisma.followupTask.findFirst({ where: { conversationId: CONV, source: "MANUAL", status: "SUGGESTED" } });
  assert.equal((t?.contextJson as { notifiedAt?: string | null }).notifiedAt, null, "再延清 notifiedAt");
  assert.deepEqual(await actOnReminder({ conversationId: CONV, staffId: meId, action: "done" }), { status: "COMPLETED" });
  assert.equal(await actOnReminder({ conversationId: CONV, staffId: meId, action: "done" }), null, "冇未處理提醒 → null");
  await setReminder({ conversationId: CONV, staffId: meId, date: "2099-01-01", reason: null, target: "me" });
  assert.deepEqual(await actOnReminder({ conversationId: CONV, staffId: meId, action: "cancel" }), { status: "CANCELLED" });
  const c = await prisma.followupTask.findFirst({ where: { conversationId: CONV, status: "CANCELLED" }, orderBy: { createdAt: "desc" } });
  assert.equal(c?.cancelReason, "MANUAL");
});

test("R6 病人喺設定後覆咗 → 自動取消（REPLIED）", async () => {
  const { setReminder } = await import("./reminder");
  await setReminder({ conversationId: CONV, staffId: meId, date: "2099-01-01", reason: null, target: "me" });
  await prisma.conversation.update({ where: { id: CONV }, data: { lastInboundAt: new Date(Date.now() + 1000) } });
  const { recheckOpenSuggestions } = await import("./engine");
  await recheckOpenSuggestions(new Date(Date.now() + 2000));
  const left = await prisma.followupTask.count({ where: { conversationId: CONV, source: "MANUAL", status: "SUGGESTED" } });
  assert.equal(left, 0);
  const t = await prisma.followupTask.findFirst({ where: { conversationId: CONV, source: "MANUAL" }, orderBy: { createdAt: "desc" } });
  assert.equal(t?.cancelReason, "REPLIED");
});

/**
 * 預約提醒「只寫一次」— 並發掃描對抗測試（CI T90 實錘：worker 開機掃 + cron 掃同時行 → 同一張單 2 條 template）。
 * 運行：TZ=UTC npx tsx --test src/lib/booking/reminder-once.test.ts（要 DB）
 *
 * RO1 同一張單 5 個並發寫 → 只得 1 條 Message + remindedAt 已寫
 * RO2 已提醒 → 再寫 null；已取消（status≠CONFIRMED）→ null、remindedAt 唔郁
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  try {
    for (const line of readFileSync(
      path.resolve(__dirname, "../../../.env"),
      "utf8",
    ).split("\n")) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)=(.*)\s*$/);
      if (m && process.env[m[1]] === undefined)
        process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
  } catch {
    /* fail loud via Prisma */
  }
}

const PFX = "rmo";
const CONTACT = `${PFX}contact00000000000000001`;
const CONV = `${PFX}conv0000000000000000001`;
const BK1 = `${PFX}bk00000000000000000001`;
const BK2 = `${PFX}bk00000000000000000002`;
let prisma: typeof import("@/lib/prisma").default;
let createReminderMessageOnce: typeof import("./reminder").createReminderMessageOnce;

async function cleanup() {
  await prisma.message.deleteMany({ where: { conversationId: CONV } });
  await prisma.bookingRequest.deleteMany({ where: { id: { in: [BK1, BK2] } } });
  await prisma.conversation.deleteMany({ where: { id: CONV } });
  await prisma.contact.deleteMany({ where: { id: CONTACT } });
}

const bk = (id: string, status: "CONFIRMED" | "REJECTED", clinicId: string) =>
  prisma.bookingRequest.create({
    data: {
      id,
      conversationId: CONV,
      clinicId,
      flowToken: `${id}-ft`,
      providerApricotId: "p",
      providerName: "Dr",
      requestedDate: "2026-11-05",
      requestedTime: "10:00",
      status,
      apricotApptId: `${id}-appt`,
    },
  });
const data = () => ({
  direction: "OUT" as const,
  channel: "API" as const,
  type: "template",
  body: "提醒",
  status: "QUEUED" as const,
  waTimestamp: new Date(),
});

before(async () => {
  prisma = (await import("@/lib/prisma")).default;
  ({ createReminderMessageOnce } = await import("./reminder"));
  await cleanup();
  const tkw = await prisma.clinic.findUniqueOrThrow({ where: { code: "TKW" } });
  await prisma.contact.create({
    data: {
      id: CONTACT,
      clinicId: tkw.id,
      waId: "85290008801",
      profileName: "RMO",
      labels: [],
    },
  });
  await prisma.conversation.create({
    data: {
      id: CONV,
      clinicId: tkw.id,
      contactId: CONTACT,
      lastMessageAt: new Date(),
    },
  });
  await bk(BK1, "CONFIRMED", tkw.id);
  await bk(BK2, "REJECTED", tkw.id);
});

after(async () => {
  try {
    await cleanup();
  } finally {
    const { closeRedis } = await import("@/lib/queue");
    await closeRedis();
    await prisma.$disconnect();
  }
});

test("RO1 並發 5 個寫同一張單 → 只 1 條 Message", async () => {
  const rs = await Promise.all(
    Array.from({ length: 5 }, () =>
      createReminderMessageOnce(BK1, CONV, data()),
    ),
  );
  assert.equal(rs.filter(Boolean).length, 1, "只有一個搶到");
  assert.equal(
    await prisma.message.count({
      where: { conversationId: CONV, type: "template" },
    }),
    1,
  );
  assert.notEqual(
    (await prisma.bookingRequest.findUniqueOrThrow({ where: { id: BK1 } }))
      .remindedAt,
    null,
  );
});

test("RO2 已提醒再寫 → null；已取消 → null 而且 remindedAt 唔郁", async () => {
  assert.equal(await createReminderMessageOnce(BK1, CONV, data()), null);
  assert.equal(await createReminderMessageOnce(BK2, CONV, data()), null);
  assert.equal(
    (await prisma.bookingRequest.findUniqueOrThrow({ where: { id: BK2 } }))
      .remindedAt,
    null,
  );
  assert.equal(
    await prisma.message.count({
      where: { conversationId: CONV, type: "template" },
    }),
    1,
  );
});

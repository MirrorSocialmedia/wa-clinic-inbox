/**
 * e2e-weekly-fixtures — 週報 E2E fixture（T37 用）：seed / check / clean。
 *
 * 用固定日期 period（2026-01-05 → 2026-01-12 本地）— sandbox DB 其餘數據全部係
 * 2026-08（現行），所以呢個 window 內只係呢批 fixture → 斷言確定性。
 *
 * 預期指標（scope=TKW，ALL row 同數字 — fixture 全部喺 TKW）：
 * - 訊息量：7（4 IN + 3 OUT）
 * - FRT 中位數：240s（3 則 answered = 120/240/360s；第 4 則 IN 無覆 → 唔計入中位數）
 * - 草稿採用率：3/4 = 0.75（SENT_AS_IS×2 + SENT_EDITED×1 + PROPOSED×1）
 * - Flow 完成率：2/3（COMPLETED×2 + SENT×1）
 * - 預約卡→確認：2/3（CONFIRMED×2 [handledAt +30min/+90min] + PENDING×1）；中位處理 60min
 *
 * 冪等：seed 前會 clean（固定 wamid / flowToken / waId marker）。
 */
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* 靠 process env */
}

import prisma from "../src/lib/prisma";

const PERIOD_START = "2026-01-05"; // 週一
const PERIOD_END = "2026-01-12"; // 下週一（exclusive）
const cmd = process.argv[2] ?? "";
// fixture marker（固定 → 冪等清理）
const WAIDS = ["8526100001", "8526100002", "8526100003", "8526100004"];
const IN_WAMIDS = ["wamid.WEEK_FX_IN_1", "wamid.WEEK_FX_IN_2", "wamid.WEEK_FX_IN_3", "wamid.WEEK_FX_IN_4"];
const OUT_WAMIDS = ["wamid.WEEK_FX_OUT_1", "wamid.WEEK_FX_OUT_2", "wamid.WEEK_FX_OUT_3"];
const FS_TOKENS = ["week-fixture-fs-1", "week-fixture-fs-2", "week-fixture-fs-3"];
const BR_TOKENS = ["week-fixture-br-1", "week-fixture-br-2", "week-fixture-br-3"];
/** 本地 2026-01-05 10:00 + offset 分鐘 */
function ts(offsetMin: number): Date {
  const d = new Date(2026, 0, 5, 10, 0, 0);
  return new Date(d.getTime() + offsetMin * 60000);
}

async function clean(tkwClinicId: string) {
  const contacts = await prisma.contact.findMany({ where: { clinicId: tkwClinicId, waId: { in: WAIDS } }, select: { id: true } });
  const convIds = contacts.length
    ? (await prisma.conversation.findMany({ where: { contactId: { in: contacts.map((c) => c.id) } }, select: { id: true } })).map((c) => c.id)
    : [];

  if (convIds.length) {
    await prisma.bookingRequest.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.flowSession.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.aiDraft.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.message.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.conversation.deleteMany({ where: { id: { in: convIds } } });
  }
  await prisma.contact.deleteMany({ where: { clinicId: tkwClinicId, waId: { in: WAIDS } } });
}

async function seed() {
  const tkw = await prisma.clinic.findUnique({ where: { code: "TKW" }, select: { id: true } });
  if (!tkw) {
    console.error("FAIL: TKW clinic 唔存在");
    process.exit(1);
  }
  await clean(tkw.id);

  // 4 conversations（各一個 patient）
  const convIds: string[] = [];
  const inMsgIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const contact = await prisma.contact.create({
      data: { clinicId: tkw.id, waId: WAIDS[i], profileName: `E2E 週報病人${i + 1}`, labels: [] },
    });
    const conv = await prisma.conversation.create({
      data: {
        clinicId: tkw.id,
        contactId: contact.id,
        status: "OPEN",
        lastMessageAt: ts(10),
        lastInboundAt: ts(0),
        intent: "QUESTION",
        urgency: "LOW",
      },
    });
    convIds.push(conv.id);
  }

  // IN 訊息（10:00 / 10:05 / 10:10 / 10:15）
  for (let i = 0; i < 4; i++) {
    const m = await prisma.message.create({
      data: {
        conversationId: convIds[i],
        waMessageId: IN_WAMIDS[i],
        direction: "IN",
        channel: "API",
        type: "text",
        body: `e2e 週報 fixture 病人${i + 1} 入站`,
        status: "RECEIVED",
        waTimestamp: ts(i * 5),
        createdAt: ts(i * 5),
      },
    });
    inMsgIds.push(m.id);
  }

  // OUT 回覆（FRT：+120s / +240s / +360s；第 4 個病人無覆）
  const frtOffsets = [2, 4, 6]; // 分鐘
  for (let i = 0; i < 3; i++) {
    await prisma.message.create({
      data: {
        conversationId: convIds[i],
        waMessageId: OUT_WAMIDS[i],
        direction: "OUT",
        channel: "API",
        type: "text",
        body: `e2e 週報 fixture 覆核${i + 1}`,
        status: "SENT",
        waTimestamp: ts(i * 5 + frtOffsets[i]),
        createdAt: ts(i * 5 + frtOffsets[i]),
      },
    });
  }

  // 4 drafts（inReply = 各 IN 訊息；2 SENT_AS_IS + 1 SENT_EDITED + 1 PROPOSED）
  const draftStatuses = ["SENT_AS_IS", "SENT_EDITED", "SENT_AS_IS", "PROPOSED"] as const;
  for (let i = 0; i < 4; i++) {
    await prisma.aiDraft.create({
      data: {
        conversationId: convIds[i],
        inReplyToMessageId: inMsgIds[i],
        draftText: `e2e 週報 fixture 草稿${i + 1}`,
        model: "e2e-fixture",
        latencyMs: 100,
        status: draftStatuses[i],
        finalText: draftStatuses[i] === "SENT_EDITED" ? "（員工改過）" : null,
        createdAt: ts(20 + i),
      },
    });
  }

  // 3 flow sessions（2 COMPLETED + 1 SENT）
  const fsStatus = ["COMPLETED", "COMPLETED", "SENT"] as const;
  for (let i = 0; i < 3; i++) {
    await prisma.flowSession.create({
      data: {
        conversationId: convIds[i],
        clinicId: tkw.id,
        flowToken: FS_TOKENS[i],
        status: fsStatus[i],
        createdAt: ts(30 + i),
        completedAt: fsStatus[i] === "COMPLETED" ? ts(40 + i) : null,
      },
    });
  }

  // 3 booking requests（2 CONFIRMED [handledAt +30min/+90min] + 1 PENDING）
  const brStatus = ["CONFIRMED", "CONFIRMED", "PENDING"] as const;
  const handledMin = [30, 90, null];
  for (let i = 0; i < 3; i++) {
    await prisma.bookingRequest.create({
      data: {
        conversationId: convIds[i],
        clinicId: tkw.id,
        flowToken: BR_TOKENS[i],
        providerApricotId: "week-fixture-doc",
        providerName: "E2E Fixture 醫生",
        requestedDate: "2026-01-08",
        requestedTime: `09:${(10 + i * 5).toString().padStart(2, "0")}`,
        precheckPassed: true,
        status: brStatus[i],
        handledAt: handledMin[i] !== null ? ts(50 + handledMin[i]!) : null,
        createdAt: ts(50),
      },
    });
  }

  console.log(`WEEKLY-SEED OK (4 conv / 7 msg / 4 draft / 3 flow / 3 booking; period ${PERIOD_START}→${PERIOD_END})`);
  await prisma.$disconnect();
}

interface Metrics {
  period: { start: string; end: string };
  scope: string;
  messages: { total: number; perClinic: Record<string, number> };
  frt: { answered: number; totalInbound: number; medianSec: number | null };
  draftAdoption: { sentAsIs: number; sentEdited: number; total: number; rate: number | null };
  flowCompletion: { completed: number; sent: number; rate: number | null };
  booking: { confirmed: number; total: number; rate: number | null; medianHandleMin: number | null };
}

function approx(a: number | null, b: number, eps = 1e-9): boolean {
  return a !== null && Math.abs(a - b) < eps;
}

async function check() {
  const tkw = await prisma.clinic.findUnique({ where: { code: "TKW" }, select: { id: true } });
  if (!tkw) process.exit(1);

  const [tkwRow, allRow] = await Promise.all([
    prisma.opsReport.findUnique({ where: { periodStart_clinicId: { periodStart: new Date(2026, 0, 5), clinicId: tkw.id } } }),
    prisma.opsReport.findUnique({ where: { periodStart_clinicId: { periodStart: new Date(2026, 0, 5), clinicId: "" } } }),
  ]);

  const errors: string[] = [];
  const expect = (m: Metrics | null, label: string) => {
    if (!m) return errors.push(`${label}: OpsReport row 冇`);
    if (m.messages.total !== 7) errors.push(`${label}: messages.total=${m.messages.total} != 7`);
    if (m.scope === "TKW" && m.messages.perClinic["TKW"] !== 7) errors.push(`${label}: perClinic.TKW != 7`);
    if (m.frt.answered !== 3) errors.push(`${label}: frt.answered=${m.frt.answered} != 3`);
    if (m.frt.totalInbound !== 4) errors.push(`${label}: frt.totalInbound=${m.frt.totalInbound} != 4`);
    if (m.frt.medianSec !== 240) errors.push(`${label}: frt.medianSec=${m.frt.medianSec} != 240`);
    if (m.draftAdoption.sentAsIs !== 2 || m.draftAdoption.sentEdited !== 1 || m.draftAdoption.total !== 4)
      errors.push(`${label}: draft counts 錯 (${m.draftAdoption.sentAsIs}/${m.draftAdoption.sentEdited}/${m.draftAdoption.total})`);
    if (!approx(m.draftAdoption.rate, 0.75)) errors.push(`${label}: draftAdoption.rate=${m.draftAdoption.rate} != 0.75`);
    if (m.flowCompletion.completed !== 2 || m.flowCompletion.sent !== 3)
      errors.push(`${label}: flow=${m.flowCompletion.completed}/${m.flowCompletion.sent} != 2/3`);
    if (!approx(m.flowCompletion.rate, 2 / 3)) errors.push(`${label}: flowCompletion.rate=${m.flowCompletion.rate} != 2/3`);
    if (m.booking.confirmed !== 2 || m.booking.total !== 3)
      errors.push(`${label}: booking=${m.booking.confirmed}/${m.booking.total} != 2/3`);
    if (!approx(m.booking.rate, 2 / 3)) errors.push(`${label}: booking.rate=${m.booking.rate} != 2/3`);
    if (!approx(m.booking.medianHandleMin, 60, 0.01)) errors.push(`${label}: booking.medianHandleMin=${m.booking.medianHandleMin} != 60`);
  };
  expect(tkwRow ? (tkwRow.metrics as unknown as Metrics) : null, "TKW");
  expect(allRow ? (allRow.metrics as unknown as Metrics) : null, "ALL");

  // 報表 text 要出現關鍵數字（可讀性 sanity）
  if (tkwRow && !tkwRow.text.includes("4m") && !tkwRow.text.includes("240")) {
    errors.push(`TKW: 報表 text 冇 FRT 數字（${tkwRow.text.slice(0, 120)}）`);
  }

  if (errors.length) {
    for (const e of errors) console.error(`  ❌ ${e}`);
    console.log("WEEKLY-ASSERT FAIL");
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log("WEEKLY-ASSERT OK");
  console.log("── TKW 報表 ──");
  console.log(tkwRow!.text);
  await prisma.$disconnect();
}

async function cleanOnly() {
  const tkw = await prisma.clinic.findUnique({ where: { code: "TKW" }, select: { id: true } });
  if (!tkw) process.exit(1);
  await clean(tkw.id);
  console.log("WEEKLY-CLEAN OK");
  await prisma.$disconnect();
}

async function main() {
  switch (cmd) {
    case "seed":
      await seed();
      break;
    case "check":
      await check();
      break;
    case "clean":
      await cleanOnly();
      break;
    default:
      console.error("usage: e2e:weekly <seed|check|clean>");
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(`FAIL: ${err instanceof Error ? err.stack ?? err.message : err}`);
  process.exit(1);
});

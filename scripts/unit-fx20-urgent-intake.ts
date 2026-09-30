/**
 * cwi-qa FX-20（QA-20）T773 — urgent-intake 重入：已 urgent 但新 notice 建立成功 → 照發 notice:new + urgent push。
 *
 * 施工單 L270：`urgent-intake.ts:39` — 舊代碼 `if (upd.count === 1)` 包晒通知：conv 已 urgent
 *（updateMany urgent:false→true 命中 0 行）但新紅旗訊息（新 msgId）建咗新 StaffNotice →
 * staff 已開緊嘅 UI 唔會收到（緊要：notice 列表唔 fetch、無 push）→ 新紅旗漏報。
 *
 * 修復：`upd.count === 1`（首升）→ `urgent:escalation`（紅標/toast，每對話一次）；
 * `upd.count === 0 && createdNotice`（重入）→ `notice:new`（UI fetchNotices 撳新卡）+ urgent push。
 * 同 msgId 只一次 — StaffNotice 按 meta.msgId 查重已保證（dup 命中 → 唔建 → 唔發）。
 *
 * 可觀察：publishConvEvent → publishNotify → Redis PUBLISH `wa-inbox:notify`（{clinicId, event, payload}）
 *   — test 用獨立 subscriber 攞（redis 共享，按 conversationId filter）。pushEvent fire-and-forget
 *   （wa_p2 無真 WebPushSubscription → no-op，唔觀察 — 代碼路徑同事件同 if 分支）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function ensureEnv(): void {
  try {
    const env = readFileSync(path.resolve(__dirname, "../.env"), "utf8");
    for (const line of env.split("\n")) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)=(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {
    /* fail loud downstream */
  }
}
ensureEnv();

import { Redis } from "ioredis";
import { PrismaClient } from "@prisma/client";
import { closeRedis } from "@/lib/queue";
import { NOTIFY_CHANNEL } from "@/lib/notify";
import { urgentIntake } from "@/lib/sessions/urgent-intake";

const prisma = new PrismaClient();
const U = "fx20";
const IDS = { contact: `${U}-contact`, conv: `${U}-conv`, msg1: `${U}-msg-1`, msg2: `${U}-msg-2` };
let clinicId = "";

/** FLOOR 紅旗詞（red-flags.ts bleeding 類「流血不止」）— deterministic 命中。 */
const RF_BODY = "我牙流血不止，好驚。";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Captured {
  event: string;
  conversationId?: string;
  kind?: string;
}
const captured: Captured[] = [];
let sub: Redis | null = null;

before(async () => {
  const clinic = await prisma.clinic.findUnique({ where: { code: "TKW" } });
  assert.ok(clinic, "TKW clinic 必須已 seed（wa_p2）");
  clinicId = clinic.id;
  await wipe();
  await prisma.contact.create({
    data: { id: IDS.contact, clinicId, waId: "85291070001", profileName: "T773", labels: [] },
  });
  const conv = await prisma.conversation.create({
    data: { id: IDS.conv, clinicId, contactId: IDS.contact, status: "OPEN", lastInboundAt: new Date(), lastMessageAt: new Date() },
  });
  const now = new Date();
  for (const [mid, wamid] of [[IDS.msg1, "wamid.fx20.1"], [IDS.msg2, "wamid.fx20.2"]] as const) {
    await prisma.message.create({
      data: {
        id: mid, conversationId: conv.id, waMessageId: wamid, direction: "IN", channel: "API",
        type: "text", body: RF_BODY, status: "RECEIVED", waTimestamp: now, createdAt: now,
      },
    });
  }
  // subscriber 必須喺第一次 publish 之前 subscribe 完成（await subscribe = redis 確認先過 —
  //   注意：ioredis 5.x 呢度用 promise 形式，"subscribe" event 唔可靠）
  sub = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  sub.on("error", () => {
    /* subscriber 死 = 後續 assertion 會 fail loud — 唔使處理 */
  });
  await sub.subscribe(NOTIFY_CHANNEL);
  sub.on("message", (_channel: string, message: string) => {
    try {
      const msg = JSON.parse(message) as { event?: string; payload?: { conversationId?: string; kind?: string } };
      if (msg.event && msg.payload?.conversationId === IDS.conv) {
        captured.push({ event: msg.event, conversationId: msg.payload.conversationId, kind: msg.payload.kind });
      }
    } catch {
      /* 非 JSON / 其他格式 — 忽略 */
    }
  });
});

after(async () => {
  await sub?.quit().catch(() => {});
  await wipe();
  await closeRedis().catch(() => {});
  await prisma.$disconnect();
});

async function wipe() {
  await prisma.staffNotice.deleteMany({ where: { conversationId: IDS.conv } });
  await prisma.auditLog.deleteMany({ where: { entityId: IDS.conv } });
  await prisma.message.deleteMany({ where: { conversationId: IDS.conv } });
  await prisma.conversation.deleteMany({ where: { id: IDS.conv } });
  await prisma.contact.deleteMany({ where: { id: IDS.contact } });
}

async function intake(msgId: string): Promise<boolean> {
  return urgentIntake({ clinicId, convId: IDS.conv, msgId, wamid: `wamid.fx20.${msgId === IDS.msg1 ? "1" : "2"}`, body: RF_BODY, type: "text" });
}
const eventsFor = (event: string) => captured.filter((e) => e.event === event);

test("T773-1（首升）：紅旗 → urgent + urgent:escalation + 1 notice", async () => {
  const hit = await intake(IDS.msg1);
  assert.equal(hit, true);
  const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: IDS.conv } });
  assert.equal(conv.urgent, true);
  assert.equal(conv.urgency, "HIGH");
  const notices = await prisma.staffNotice.findMany({ where: { conversationId: IDS.conv, kind: "URGENT_ESCALATION" } });
  assert.equal(notices.length, 1);
  assert.equal((notices[0].meta as { msgId?: string } | null)?.msgId, IDS.msg1);
  await sleep(250); // fire-and-forget publish — 等 redis 到
  assert.equal(eventsFor("urgent:escalation").length, 1, "首升必須發 urgent:escalation");
  assert.equal(eventsFor("notice:new").length, 0, "首升唔行 notice:new 分支");
});

test("T773-2（核心 — 重入）：已 urgent + 新 msgId 新 notice → notice:new 照發、urgent:escalation 唔重發", async () => {
  const hit = await intake(IDS.msg2);
  assert.equal(hit, true);
  const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: IDS.conv } });
  assert.equal(conv.urgent, true);
  const notices = await prisma.staffNotice.findMany({ where: { conversationId: IDS.conv, kind: "URGENT_ESCALATION" } });
  assert.equal(notices.length, 2, "新 msgId → 新 notice（per-msgId）");
  assert.ok(notices.some((n) => (n.meta as { msgId?: string } | null)?.msgId === IDS.msg2), "新 notice 必須係 msg2 嗰份");
  await sleep(250);
  assert.equal(eventsFor("notice:new").length, 1, "重入必發 notice:new（UI fetchNotices 撳新卡）");
  assert.equal(eventsFor("notice:new")[0].kind, "URGENT_ESCALATION");
  assert.equal(eventsFor("urgent:escalation").length, 1, "urgent:escalation 唔重發（每對話首升一次）");
});

test("T773-3（冪等）：同 msgId webhook 重投 → 無新 notice、無新事件", async () => {
  const beforeNotices = await prisma.staffNotice.count({ where: { conversationId: IDS.conv, kind: "URGENT_ESCALATION" } });
  const beforeEvents = captured.length;
  const hit = await intake(IDS.msg2); // 同 msgId 再行一次（webhook 重發）
  assert.equal(hit, true);
  const afterNotices = await prisma.staffNotice.count({ where: { conversationId: IDS.conv, kind: "URGENT_ESCALATION" } });
  assert.equal(afterNotices, beforeNotices, "同 msgId 唔建第二份 notice");
  await sleep(250);
  assert.equal(captured.length, beforeEvents, "同 msgId 唔重發事件（per-msgId once）");
});

test("T773-4（sanity）：非紅旗文字 → false、零通知", async () => {
  const before = captured.length;
  const hit = await urgentIntake({ clinicId, convId: IDS.conv, msgId: `${U}-msg-x`, wamid: "wamid.fx20.x", body: "矯齒要幾耐？", type: "text" });
  assert.equal(hit, false);
  await sleep(150);
  assert.equal(captured.length, before);
});

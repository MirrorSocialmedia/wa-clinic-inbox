/**
 * T774 — FX-24（QA-24，已重現）：bundle / messages 兩條 route 同一 DTO：
 * - JSON 冇 `waMediaId`（server-side Graph media id 唔回 client）
 * - `mediaPath` 唔回碟上絕對路徑 → `/api/media/<mediaKey>`（T774：冇 `/`-開頭路徑）
 * - mediaName（顯示名）照回（UI 需要）；冇 mediaKey → mediaPath null（唔洩露）
 *
 * 口徑：node:test 直打 GET handler（params = Promise<{id}>，同 Next 15 一致）；
 * fixture 唯一前綴 + after() 清走。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { GET as GET_BUNDLE } from "./route";
import { GET as GET_MESSAGES } from "../messages/route";
import { closeRedis } from "@/lib/queue";
import {
  loadEnvIfMissing,
  sessionCookie,
  getReq,
  drainRes,
  createConvFx,
  createOutMsgFx,
  cleanupFx,
  type ConvFx,
} from "../../../messages/qa3b-test-helpers";

const PX = "fx24t774";
let prisma: PrismaClient;
let cookie: string;
let fx: ConvFx;
const msgIds: string[] = [];

before(async () => {
  loadEnvIfMissing();
  prisma = new PrismaClient();
  const staff = await prisma.staffUser.findUnique({ where: { email: "admin@wa-clinic.local" } });
  if (!staff) throw new Error("T774: admin 未 seed");
  cookie = await sessionCookie({
    staffId: staff.id,
    role: "ADMIN",
    name: staff.name,
    email: staff.email,
    clinicId: null,
    scopeType: "ALL",
  });
  fx = await createConvFx(prisma, { prefix: PX, lastInboundAt: new Date() });
  // 媒體訊息：故意放絕對路徑 + waMediaId — DTO 必須剷走
  const mediaKey = `fx24-k-${randomUUID()}.pdf`;
  const m1 = await createOutMsgFx(prisma, {
    ...fx,
    prefix: PX,
    type: "document",
    status: "SENT",
    body: "T774 測試文件",
    mediaKey,
    mediaPath: `/srv/wa-media/${mediaKey}`, // 故意：絕對路徑（舊 bug 會原样回）
    mediaName: "陳大文 報告.pdf",
    waMediaId: "gmedia-fx24-abc", // 故意：server-side id（舊 bug 會原样回）
  });
  msgIds.push(m1.messageId);
  // 純 text 訊息（無媒體）— DTO 唔好搞爛佢
  const m2 = await createOutMsgFx(prisma, { ...fx, prefix: PX, type: "text", status: "SENT", body: "T774 文字" });
  msgIds.push(m2.messageId);
});

after(async () => {
  if (prisma) {
    await cleanupFx(prisma, fx, { messageIds: msgIds }).catch(() => {});
    // queue.ts 的 sharedRedis（BullMQ queues 共用）唔 close 會 hold 住 event loop → test process hang（outbound.worker.test 同口徑）
    await closeRedis().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
});

/** 共同斷言：DTO 契約（bundle / messages 兩邊同一組）。 */
async function assertDtoShape(jsonText: string, messages: Record<string, unknown>[], label: string) {
  assert.ok(!jsonText.includes("waMediaId"), `${label}: JSON 唔可以出現 waMediaId 欄名`);
  assert.ok(!jsonText.includes("gmedia-fx24-abc"), `${label}: 唔可以洩露 waMediaId 值`);
  assert.ok(!jsonText.includes("/srv/wa-media"), `${label}: 唔可以洩露碟上絕對路徑`);
  assert.ok(!jsonText.includes("/tmp/wa-media"), `${label}: 唔可以洩露 dev 絕對路徑`);
  const doc = messages.find((m) => m.type === "document");
  const txt = messages.find((m) => m.type === "text");
  assert.ok(doc && txt, `${label}: fixture 兩條訊息都要喺`);
  assert.equal(doc!.mediaPath, "/api/media/" + (doc!.mediaKey as string), `${label}: mediaPath 要 /api/media/<key>`);
  assert.equal(doc!.mediaName, "陳大文 報告.pdf", `${label}: mediaName 顯示名照回`);
  assert.equal(txt!.mediaPath, null, `${label}: 無媒體訊息 mediaPath = null`);
  assert.ok(!("waMediaId" in (doc! as object)), `${label}: document row 唔可以有 waMediaId 欄`);
}

test("T774a — bundle GET：無 waMediaId / 無絕對路徑 / mediaPath = /api/media/<key>", async () => {
  const res = await GET_BUNDLE(getReq(`/api/conversations/${fx.convId}/bundle`, cookie), {
    params: Promise.resolve({ id: fx.convId }),
  });
  assert.equal(res.status, 200, `bundle 預期 200，得 ${res.status}`);
  // 先讀走 body（drain）先 clone — 倒序會「Body has already been consumed」
  const jsonText = await res.text();
  await drainRes(res);
  const body = JSON.parse(jsonText) as { messages: Record<string, unknown>[] };
  await assertDtoShape(jsonText, body.messages, "bundle");
});

test("T774b — messages GET：同一 DTO（同步修好，唔好只修 bundle）", async () => {
  const res = await GET_MESSAGES(getReq(`/api/conversations/${fx.convId}/messages`, cookie), {
    params: Promise.resolve({ id: fx.convId }),
  });
  assert.equal(res.status, 200, `messages 預期 200，得 ${res.status}`);
  // 先讀走 body（drain）先 clone — 倒序會「Body has already been consumed」
  const jsonText = await res.text();
  await drainRes(res);
  const body = JSON.parse(jsonText) as { messages: Record<string, unknown>[] };
  await assertDtoShape(jsonText, body.messages, "messages");
});

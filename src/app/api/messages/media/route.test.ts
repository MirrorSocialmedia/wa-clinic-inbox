/**
 * FX-16 media 支路（T772 附件版）+ FX-26（T776）：
 * - T772m-a：落碟（即加密）失敗 → 500，**未 claim**（附件版「失敗唔留低已 claim 冇訊息」）。
 * - T772m-b：415 壞 magic（sniff 失敗，落碟前）→ 未 claim（regression 錨）。
 * - T772m-c（happy path regression）：有效 PNG → 202 + claim + Message(QUEUED)（新次序 落碟→claim 照行）。
 * - T776：content-length > 10.5MB → **413**（parse body 之前攔；舊路徑被 middleware 截斷 → 400）。
 *
 * 口徑：node:test 直打 POST handler；真 dev DB/Redis；fixture 唯一前綴 + after() 清走。
 *  happy path 會入真 Redis queue（jobId = messageId）→ cleanup best-effort remove（worker 可能已撳走）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { mkdirSync, rmSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { closeRedis } from "@/lib/queue";
import {
  REPO_ROOT,
  loadEnvIfMissing,
  sessionCookie,
  formReq,
  drainRes,
  readJson,
  createConvFx,
  cleanupFx,
  type ConvFx,
} from "../qa3b-test-helpers";

const PX = "fx26t776";
const BASE = "http://127.0.0.1:3100/api/messages/media";
let prisma: PrismaClient;
let cookie: string;
let fx: ConvFx;
const mediaDirs: string[] = [];

/** 1x1 透明 PNG（magic 过 sniff） */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

before(async () => {
  loadEnvIfMissing();
  // 測試專用 media dir（唔郁 dev server 3100 寫緊嗰個）
  const dir = join(REPO_ROOT, ".dev", "media-qa3b");
  mkdirSync(dir, { recursive: true });
  mediaDirs.push(dir);
  process.env.WA_MEDIA_DIR = dir;
  prisma = new PrismaClient();
  const staff = await prisma.staffUser.findUnique({ where: { email: "admin@wa-clinic.local" } });
  if (!staff) throw new Error("T776: admin 未 seed");
  cookie = await sessionCookie({
    staffId: staff.id,
    role: "ADMIN",
    name: staff.name,
    email: staff.email,
    clinicId: null,
    scopeType: "ALL",
  });
  fx = await createConvFx(prisma, { prefix: PX, lastInboundAt: new Date() });
});

after(async () => {
  if (prisma) {
    await cleanupFx(prisma, fx).catch(() => {});
    // queue.ts 的 sharedRedis（BullMQ queues 共用）唔 close 會 hold 住 event loop → test process hang（outbound.worker.test 同口徑）
    await closeRedis().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
  for (const d of mediaDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
  delete process.env.WA_MEDIA_DIR;
});

async function assertNoClaim(label: string) {
  const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: fx.convId } });
  assert.equal(conv.assigneeId, null, `${label}: assigneeId 必須仍 null`);
  const n = await prisma.message.count({ where: { conversationId: fx.convId } });
  assert.equal(n, 0, `${label}: 唔可以留低 Message`);
}

test("T772m-a — 落碟失敗（production fail-fast）→ 500 + 未 claim", async () => {
  // production + WA_MEDIA_DIR 指去「普通檔案/sub」→ ensureMediaDir mkdir 失敗 → MediaDirError
  const parentFile = join(REPO_ROOT, ".dev", "qa3b-blocker-file");
  mkdirSync(join(REPO_ROOT, ".dev"), { recursive: true });
  if (!existsSync(parentFile)) writeFileSync(parentFile, "blocker");
  const env = process.env as Record<string, string | undefined>;
  const prevEnv = env.NODE_ENV;
  const prevDir = env.WA_MEDIA_DIR;
  env.NODE_ENV = "production";
  env.WA_MEDIA_DIR = join(parentFile, "sub");
  try {
    const form = new FormData();
    form.set("conversationId", fx.convId);
    form.set("file", new File([PNG_1X1], "photo.png", { type: "image/png" }), "photo.png");
    const res = await POST(formReq("/api/messages/media", form, cookie), { params: Promise.resolve({}) });
    const body = await readJson(res);
    await drainRes(res);
    assert.equal(res.status, 500, `預期 500（落碟 fail-fast），得 ${res.status}: ${JSON.stringify(body)}`);
    await assertNoClaim("落碟失敗");
  } finally {
    env.NODE_ENV = prevEnv;
    env.WA_MEDIA_DIR = prevDir;
    if (existsSync(parentFile)) unlinkSync(parentFile);
  }
});

test("T772m-b — 415 壞 magic（.txt）→ 未 claim（落碟前失敗 regression 錨）", async () => {
  const form = new FormData();
  form.set("conversationId", fx.convId);
  form.set("file", new File([Buffer.from("hello plain text")], "note.txt", { type: "text/plain" }), "note.txt");
  const res = await POST(formReq("/api/messages/media", form, cookie), { params: Promise.resolve({}) });
  const body = await readJson(res);
  await drainRes(res);
  assert.equal(res.status, 415, `預期 415，得 ${res.status}: ${JSON.stringify(body)}`);
  await assertNoClaim("415 壞 magic");
});

test("T772m-c — happy path：有效 PNG → 202 + claim + Message(QUEUED)", async () => {
  const form = new FormData();
  form.set("conversationId", fx.convId);
  form.set("caption", "T776 測試圖片");
  form.set("file", new File([PNG_1X1], "photo.png", { type: "image/png" }), "photo.png");
  const res = await POST(formReq("/api/messages/media", form, cookie), { params: Promise.resolve({}) });
  const body = await readJson<{ ok?: boolean; messageId?: string; status?: string }>(res);
  await drainRes(res);
  assert.equal(res.status, 202, `預期 202，得 ${res.status}: ${JSON.stringify(body)}`);
  assert.ok(body.messageId, "202 必須帶 messageId");
  // claim 發生（新次序：落碟成功之後先 claim）
  const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: fx.convId } });
  assert.equal(conv.assigneeId, fx.staffId, "成功發送必須 auto-claim");
  // worker 可能已經撳走 job（dev 3100 有跑緊 worker）— QUEUED 或之後狀態都算「唔係 FAILED」
  const msg = await prisma.message.findUniqueOrThrow({ where: { id: body.messageId! } });
  assert.ok(
    ["QUEUED", "SENDING", "SENT"].includes(msg.status),
    `訊息狀態要 QUEUED/SENDING/SENT，得 ${msg.status}`
  );
  // best-effort 清 job（worker 可能已处理）+ 檔
  try {
    const { outboundQueue } = await import("@/lib/queue");
    const job = await outboundQueue.getJob(body.messageId!);
    if (job) await job.remove().catch(() => {});
  } catch {
    /* worker 已撳走 = 無 job */
  }
  const { unlink } = await import("node:fs/promises");
  if (msg.mediaPath) await unlink(msg.mediaPath).catch(() => {});
});

test("T776 — content-length 12MB → 413（parse body 之前）", async () => {
  // 真 HTTP client（curl/browser）必帶 content-length；undici 對 FormData 不設（lazy serialize）
  // → 用 12MB string body + 顯式 content-length 模擬真 client（handler 直接打，冇 Next middleware）。
  //   新 gate 喺 parse 之前攔 → 唔理 body 係咪真 multipart（只睇 header）。
  const size = 12 * 1024 * 1024;
  const body = "x".repeat(size);
  // 快照現狀（呢個 fixture 已被 T772m-c happy path claim 過）— 413 必須零新寫入：
  // assigneeId 同 message 數與發送前一致（同 assertNoClaim 同一語義，但對測試順序穩定）。
  const before = await prisma.conversation.findUniqueOrThrow({ where: { id: fx.convId } });
  const msgCountBefore = await prisma.message.count({ where: { conversationId: fx.convId } });
  const req = new NextRequest(BASE, {
    method: "POST",
    headers: { cookie, "content-length": String(size) },
    body,
  });
  const res = await POST(req, { params: Promise.resolve({}) });
  const bodyJson = await readJson<{ error?: string; maxBytes?: number }>(res);
  await drainRes(res);
  assert.equal(res.status, 413, `預期 413（FX-26），得 ${res.status}: ${JSON.stringify(bodyJson)}`);
  assert.equal(bodyJson.error, "FILE_TOO_LARGE");
  assert.equal(bodyJson.maxBytes, 10 * 1024 * 1024);
  // 413 喺 parse body 之前 → 冇任何新 DB 寫入
  const after = await prisma.conversation.findUniqueOrThrow({ where: { id: fx.convId } });
  assert.equal(after.assigneeId, before.assigneeId, "12MB 413: assigneeId 必須冇變");
  const msgCountAfter = await prisma.message.count({ where: { conversationId: fx.convId } });
  assert.equal(msgCountAfter, msgCountBefore, "12MB 413: 唔可以留低新 Message");
});

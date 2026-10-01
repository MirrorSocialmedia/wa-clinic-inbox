/**
 * T775 — FX-25（QA-25）：Content-Disposition RFC 6266 雙欄：
 *   filename="<ASCII fallback>"; filename*=UTF-8''<pct-encoded>
 *   （舊單一 filename="<encodeURIComponent>" → CJK 檔名喺部分 client 爛/亂碼）
 * T778 — FX-29（QA-29）：Cache-Control: private, no-store（共用前台電腦唔留病人媒體 cache）。
 *
 * 口徑：node:test 直打 GET handler（params = Promise<{file}>）；
 * 檔用 saveMediaFile 真寫入測試專用 media dir（dev 加密 at-rest；openMediaStream 透明解密）；
 * fixture 唯一前綴 + after() 清走（DB + 檔）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { GET } from "./route";
import { saveMediaFile } from "@/lib/wa/media";
import { closeRedis } from "@/lib/queue";
import {
  REPO_ROOT,
  loadEnvIfMissing,
  sessionCookie,
  getReq,
  createConvFx,
  createOutMsgFx,
  cleanupFx,
  type ConvFx,
} from "../../messages/qa3b-test-helpers";

const PX = "fx25t775";
let prisma: PrismaClient;
let cookie: string;
let fx: ConvFx;
const msgIds: string[] = [];
const files: string[] = [];
const mediaDir = join(REPO_ROOT, ".dev", "media-qa3b-serve");

before(async () => {
  loadEnvIfMissing();
  await mkdirSync(mediaDir, { recursive: true });
  process.env.WA_MEDIA_DIR = mediaDir;
  prisma = new PrismaClient();
  const staff = await prisma.staffUser.findUnique({ where: { email: "admin@wa-clinic.local" } });
  if (!staff) throw new Error("T775: admin 未 seed");
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
    await cleanupFx(prisma, fx, { messageIds: msgIds }).catch(() => {});
    // queue.ts 的 sharedRedis（BullMQ queues 共用）唔 close 會 hold 住 event loop → test process hang（outbound.worker.test 同口徑）
    await closeRedis().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
  for (const f of files) await unlink(f).catch(() => {});
  if (existsSync(mediaDir)) await rmSync(mediaDir, { recursive: true, force: true });
  delete process.env.WA_MEDIA_DIR;
});

async function serve(file: string): Promise<Response> {
  return GET(getReq(`/api/media/${file}`, cookie), { params: Promise.resolve({ file }) });
}

test("T775a — CJK 檔名：filename= ASCII fallback + filename*=UTF-8'' pct-encoded（T778 no-store 同查）", async () => {
  const file = `fx25-${randomUUID()}.pdf`;
  const original = Buffer.from("%PDF-1.4\n%%T775 test payload\n");
  files.push(join(mediaDir, file));
  await saveMediaFile(file, original);
  const m = await createOutMsgFx(prisma, {
    ...fx,
    prefix: PX,
    type: "document",
    status: "SENT",
    mediaKey: file,
    mediaPath: join(mediaDir, file),
    mediaName: "陳大文 報告.pdf",
  });
  msgIds.push(m.messageId);

  const res = await serve(file);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(res.status, 200, `預期 200，得 ${res.status}`);
  assert.equal(res.headers.get("content-type"), "application/pdf");

  // ── T775：RFC 6266 雙欄 ──
  const cd = res.headers.get("content-disposition") ?? "";
  const expected = `inline; filename="${file}"; filename*=UTF-8''${encodeURIComponent("陳大文 報告.pdf")}`;
  assert.equal(cd, expected, `Content-Disposition 要雙欄（ASCII fallback + UTF-8 pct-encoded）：\n got: ${cd}\n exp: ${expected}`);
  // 顯式解碼核 — filename* 還原返原文
  const star = cd.split("filename*=UTF-8''")[1];
  assert.ok(star, "要有 filename*=UTF-8'' 欄");
  assert.equal(decodeURIComponent(star), "陳大文 報告.pdf", "filename* 解碼後要 = 顯示名");
  // ASCII fallback 純 ASCII（舊 client 唔爛）
  const ascii = /filename="([^"]*)"/.exec(cd)?.[1] ?? "";
  assert.ok(/^[\x21-\x7e]*$/.test(ascii), `filename= 要純 ASCII，得: ${ascii}`);

  // ── T778：no-store（舊 max-age=3600 → 共用 PC 登出後 cache 仲有病人文件）──
  assert.equal(res.headers.get("cache-control"), "private, no-store", "Cache-Control 要 private, no-store");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff", "nosniff regression");

  // 內容 round-trip（加密 at-rest → 透明解密 → 原 bytes）
  assert.deepEqual(buf, original, "body 要 round-trip 一致");
});

test("T775b — 無 mediaName（image）：dispName fallback = fileKey，雙欄照出", async () => {
  const file = `fx25b-${randomUUID()}.png`;
  const original = Buffer.from("fake-png-bytes-t775b");
  files.push(join(mediaDir, file));
  await saveMediaFile(file, original);
  const m = await createOutMsgFx(prisma, {
    ...fx,
    prefix: PX,
    type: "image",
    status: "SENT",
    mediaKey: file,
    mediaPath: join(mediaDir, file),
  });
  msgIds.push(m.messageId);

  const res = await serve(file);
  await res.arrayBuffer();
  assert.equal(res.status, 200);
  const expected = `inline; filename="${file}"; filename*=UTF-8''${encodeURIComponent(file)}`;
  assert.equal(res.headers.get("content-disposition"), expected);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
});

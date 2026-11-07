/**
 * ★ cwi-sticker-20261107 + cwi-search-20261107：貼圖庫 + 搜尋片段 — 對抗式測試（要 DB；Redis 冇都得）。
 * 運行：TZ=Asia/Hong_Kong npx tsx --test src/lib/stickers.test.ts
 *
 * K1  轉換：PNG → 512×512 WebP；GIF 多格 → 動態；exe 改名 → 415；空檔 → 400
 * K2  加我的貼圖；同一張再加 → duplicate（唔重複）；並發加同一張 → 只得一行
 * K3  診所貼圖：STAFF／公司級管理員 → 403；集團管理員 → 得
 * K4  睇：listStickers 只見自己 + 診所；檔案權限（其他人嘅我的貼圖 → 拒）
 * K5  用：其他人嘅我的貼圖 → 404；診所貼圖 → 得
 * K6  刪：其他人／STAFF 刪診所 → 404；自己 → 得兼刪檔；重複刪冪等
 * K7  收藏收到嘅貼圖：冇權嗰間店 → 404；唔係 sticker → 400；未落地 → 409；得 → 加入
 * K8  上限：我的貼圖 100 張 → 第 101 張 409
 * K9  搜尋片段：命中喺後面都見到；唔分大小寫；萬用字 escape
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

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
const EMAILS = ["stk-a@stk.local", "stk-b@stk.local", "stk-boss@stk.local", "stk-coadmin@stk.local", "stk-mf@stk.local"];
const C1 = "stkcontact000000000000001";
const CONV1 = "stkconv0000000000000000001";
let a: string, b: string, boss: string, coAdmin: string, mfStaff: string;
let tkwId: string, mfId: string;
let stk: typeof import("./stickers");
let snip: typeof import("./search/snippet");
let media: typeof import("./wa/media");
let sharp: typeof import("sharp").default;

type V = { staff: { id: string; role: "ADMIN" | "STAFF" | "SUPERVISOR"; email: string; name: string }; scopeType: "ALL" | "COMPANY" | "CLINICS"; scopedClinicIds: string[] };
const staffV = (id: string, clinics: string[]): V => ({ staff: { id, role: "STAFF", email: "x@x", name: "x" }, scopeType: "CLINICS", scopedClinicIds: clinics });
const isErr = (code: string) => (x: unknown) => x instanceof Error && (x as { code?: string }).code === code;

async function png(r: number, g = 80, bl = 160): Promise<Buffer> {
  return sharp({ create: { width: 300, height: 200, channels: 4, background: { r, g, b: bl, alpha: 1 } } })
    .png()
    .toBuffer();
}

async function cleanup() {
  const staff = await prisma.staffUser.findMany({ where: { email: { in: EMAILS } }, select: { id: true } });
  const ids = staff.map((s) => s.id);
  const rows = await prisma.sticker.findMany({ where: { OR: [{ ownerKey: { in: ids } }, { createdById: { in: ids } }] }, select: { id: true, fileKey: true } });
  for (const r of rows) await import("node:fs/promises").then((fs) => fs.unlink(path.join(media.mediaDirPreferred(), r.fileKey)).catch(() => undefined));
  await prisma.sticker.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  await prisma.auditLog.deleteMany({ where: { staffId: { in: ids } } });
  await prisma.message.deleteMany({ where: { conversationId: CONV1 } });
  await prisma.conversation.deleteMany({ where: { id: CONV1 } });
  await prisma.contact.deleteMany({ where: { id: C1 } });
  await prisma.staffUser.deleteMany({ where: { email: { in: EMAILS } } });
}

before(async () => {
  stk = await import("./stickers");
  snip = await import("./search/snippet");
  media = await import("./wa/media");
  sharp = (await import("sharp")).default;
  await cleanup();
  tkwId = (await prisma.clinic.findUniqueOrThrow({ where: { code: "TKW" } })).id;
  mfId = (await prisma.clinic.findUniqueOrThrow({ where: { code: "MF" } })).id;
  const mk = async (email: string, name: string, clinicId: string) =>
    (await prisma.staffUser.create({ data: { email, name, role: "STAFF", passwordHash: "x", active: true, clinicId, clinics: { create: { clinicId, isPrimary: true } } } })).id;
  a = await mk(EMAILS[0], "STK 阿A", tkwId);
  b = await mk(EMAILS[1], "STK 阿B", tkwId);
  boss = (await prisma.staffUser.create({ data: { email: EMAILS[2], name: "STK 老闆", role: "ADMIN", scopeType: "ALL", passwordHash: "x", active: true } })).id;
  coAdmin = (await prisma.staffUser.create({ data: { email: EMAILS[3], name: "STK 公司管理員", role: "ADMIN", scopeType: "CLINICS", passwordHash: "x", active: true, clinics: { create: { clinicId: tkwId, isPrimary: true } } } })).id;
  mfStaff = await mk(EMAILS[4], "STK MF", mfId);
  await prisma.contact.create({ data: { id: C1, clinicId: tkwId, waId: "85290005501", profileName: "STK 病人", labels: [] } });
  await prisma.conversation.create({ data: { id: CONV1, clinicId: tkwId, contactId: C1, lastMessageAt: new Date() } });
});

after(async () => {
  try {
    await cleanup();
  } finally {
    await prisma.$disconnect();
    const { default: appPrisma } = await import("@/lib/prisma");
    await appPrisma.$disconnect();
    try {
      const { closeRedis } = await import("@/lib/queue");
      await closeRedis();
    } catch {
      /* 冇 redis */
    }
  }
});

test("K1 轉換：PNG → 512 WebP；GIF 動態；exe 415；空檔 400", async () => {
  const s = await stk.toWhatsAppSticker(await png(200));
  const m = await sharp(s.buf).metadata();
  assert.deepEqual([m.format, m.width, m.height, s.animated], ["webp", 512, 512, false]);
  assert.ok(s.buf.length <= stk.STATIC_MAX);
  const frames = await Promise.all([0, 1, 2, 3].map((i) => sharp({ create: { width: 120, height: 120, channels: 4, background: { r: i * 60, g: 10, b: 10, alpha: 1 } } }).png().toBuffer()));
  const gif = await sharp(frames, { join: { animated: true } }).gif().toBuffer();
  const g = await stk.toWhatsAppSticker(gif);
  const gm = await sharp(g.buf, { animated: true }).metadata();
  assert.equal(g.animated, true);
  assert.equal(gm.pages, 4);
  assert.ok(g.buf.length <= stk.ANIMATED_MAX);
  await assert.rejects(stk.toWhatsAppSticker(Buffer.from("MZ\x90\x00 not an image")), isErr("UNSUPPORTED"));
  await assert.rejects(stk.toWhatsAppSticker(Buffer.alloc(0)), isErr("EMPTY"));
  await assert.rejects(stk.toWhatsAppSticker(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")), isErr("UNSUPPORTED"), "SVG（可藏 script）唔收");
});

test("K2 加我的貼圖；重複 → duplicate；並發加同一張 → 一行", async () => {
  const img = await png(10);
  const r1 = await stk.addSticker(staffV(a, [tkwId]), { buf: img, name: "  收到\u0007  ", scope: "mine" });
  assert.equal(r1.duplicate, false);
  assert.equal(r1.sticker.name, "收到", "名清洗");
  const row = await prisma.sticker.findUniqueOrThrow({ where: { id: r1.sticker.id } });
  assert.ok(existsSync(path.join(media.mediaDirPreferred(), row.fileKey)), "檔案落咗碟");
  const r2 = await stk.addSticker(staffV(a, [tkwId]), { buf: img, scope: "mine" });
  assert.equal(r2.duplicate, true);
  assert.equal(r2.sticker.id, r1.sticker.id);
  const img2 = await png(20);
  const rs = await Promise.all([1, 2, 3, 4].map(() => stk.addSticker(staffV(a, [tkwId]), { buf: img2, scope: "mine" })));
  assert.equal(new Set(rs.map((r) => r.sticker.id)).size, 1, "並發都只得一張");
  // B 加同一張係另一個範圍 → 自己一行
  const rb = await stk.addSticker(staffV(b, [tkwId]), { buf: img, scope: "mine" });
  assert.notEqual(rb.sticker.id, r1.sticker.id);
});

test("K3 診所貼圖：STAFF／公司級管理員 403；集團管理員得", async () => {
  const img = await png(30);
  await assert.rejects(stk.addSticker(staffV(a, [tkwId]), { buf: img, scope: "clinic" }), isErr("CLINIC_ADMIN_ONLY"));
  await assert.rejects(
    stk.addSticker({ staff: { id: coAdmin, role: "ADMIN", email: "x", name: "x" }, scopeType: "CLINICS", scopedClinicIds: [tkwId] }, { buf: img, scope: "clinic" }),
    isErr("CLINIC_ADMIN_ONLY"),
  );
  const r = await stk.addSticker({ staff: { id: boss, role: "ADMIN", email: "x", name: "x" }, scopeType: "ALL", scopedClinicIds: [] }, { buf: img, name: "多謝", scope: "clinic" });
  assert.equal(r.sticker.scope, "clinic");
});

test("K4／K5 睇同用：只見自己 + 診所；其他人嘅我的貼圖拒", async () => {
  const la = await stk.listStickers(a);
  const lb = await stk.listStickers(b);
  assert.ok(la.mine.length >= 2 && lb.mine.length >= 1);
  assert.ok(la.clinic.some((x) => x.name === "多謝") && lb.clinic.some((x) => x.name === "多謝"), "診所貼圖人人見到");
  const aRow = await prisma.sticker.findFirstOrThrow({ where: { ownerKey: a } });
  assert.equal(lb.mine.some((x) => x.id === aRow.id), false, "B 睇唔到 A 嘅我的貼圖");
  assert.equal(await stk.stickerFileForViewer(aRow.fileKey, b), false);
  assert.equal(await stk.stickerFileForViewer(aRow.fileKey, a), true);
  const clinicRow = await prisma.sticker.findFirstOrThrow({ where: { ownerKey: stk.CLINIC_KEY, createdById: boss } });
  assert.equal(await stk.stickerFileForViewer(clinicRow.fileKey, b), true);
  await assert.rejects(stk.usableSticker(aRow.id, b), isErr("NOT_FOUND"), "B 用唔到 A 嘅");
  assert.equal((await stk.usableSticker(clinicRow.id, b)).id, clinicRow.id);
  await assert.rejects(stk.usableSticker("nope", a), isErr("NOT_FOUND"));
});

test("K6 刪：其他人 404；STAFF 刪診所 404；自己得兼刪檔；重複刪冪等", async () => {
  const aRow = await prisma.sticker.findFirstOrThrow({ where: { ownerKey: a } });
  const clinicRow = await prisma.sticker.findFirstOrThrow({ where: { ownerKey: stk.CLINIC_KEY, createdById: boss } });
  await assert.rejects(stk.deleteSticker(staffV(b, [tkwId]), aRow.id), isErr("NOT_FOUND"));
  await assert.rejects(stk.deleteSticker(staffV(a, [tkwId]), clinicRow.id), isErr("NOT_FOUND"));
  await assert.rejects(stk.renameSticker(staffV(b, [tkwId]), aRow.id, "x"), isErr("NOT_FOUND"));
  await Promise.all([stk.deleteSticker(staffV(a, [tkwId]), aRow.id), stk.deleteSticker(staffV(a, [tkwId]), aRow.id).catch(() => undefined)]);
  assert.equal(await prisma.sticker.count({ where: { id: aRow.id } }), 0);
  assert.equal(existsSync(path.join(media.mediaDirPreferred(), aRow.fileKey)), false, "檔案刪埋");
  await stk.deleteSticker({ staff: { id: boss, role: "ADMIN", email: "x", name: "x" }, scopeType: "ALL", scopedClinicIds: [] }, clinicRow.id);
});

test("K7 收藏收到嘅貼圖：權限／類型／未落地", async () => {
  const webp = (await stk.toWhatsAppSticker(await png(99))).buf;
  const key = `stktest-${Date.now()}.webp`;
  const p = await media.saveMediaFile(key, webp);
  const ok = await prisma.message.create({ data: { conversationId: CONV1, direction: "IN", channel: "API", type: "sticker", body: null, mediaPath: p, mediaKey: key, mediaStatus: "READY", status: "RECEIVED", waTimestamp: new Date() } });
  const pending = await prisma.message.create({ data: { conversationId: CONV1, direction: "IN", channel: "API", type: "sticker", body: null, mediaStatus: "PENDING", status: "RECEIVED", waTimestamp: new Date() } });
  const text = await prisma.message.create({ data: { conversationId: CONV1, direction: "IN", channel: "API", type: "text", body: "hi", status: "RECEIVED", waTimestamp: new Date() } });
  await assert.rejects(stk.addStickerFromMessage(staffV(mfStaff, [mfId]), { messageId: ok.id, scope: "mine" }), isErr("MSG_NOT_FOUND"), "冇權嗰間店 → 404");
  await assert.rejects(stk.addStickerFromMessage(staffV(a, [tkwId]), { messageId: text.id, scope: "mine" }), isErr("NOT_STICKER"));
  await assert.rejects(stk.addStickerFromMessage(staffV(a, [tkwId]), { messageId: pending.id, scope: "mine" }), isErr("NOT_READY"));
  await assert.rejects(stk.addStickerFromMessage(staffV(a, [tkwId]), { messageId: ok.id, scope: "clinic" }), isErr("CLINIC_ADMIN_ONLY"));
  const r = await stk.addStickerFromMessage(staffV(a, [tkwId]), { messageId: ok.id, scope: "mine" });
  assert.equal(r.sticker.scope, "mine");
  await import("node:fs/promises").then((fs) => fs.unlink(p).catch(() => undefined));
});

test("K8 上限：我的貼圖 100 張 → 第 101 張 409", async () => {
  const have = await prisma.sticker.count({ where: { ownerKey: b } });
  await prisma.sticker.createMany({
    data: Array.from({ length: stk.STICKER_MINE_MAX - have }, (_, i) => ({ ownerKey: b, fileKey: `stk-fake-${b}-${i}.webp`, bytes: 1, sha256: `fake-${String(i).padStart(6, "0")}`.padEnd(64, "x"), createdById: b })),
  });
  await assert.rejects(stk.addSticker(staffV(b, [tkwId]), { buf: await png(123), scope: "mine" }), isErr("LIMIT"));
  await prisma.sticker.deleteMany({ where: { ownerKey: b, fileKey: { startsWith: "stk-fake-" } } });
});

test("K9 搜尋片段：命中喺後面都見到；唔分大小寫；萬用字 escape", () => {
  const long = `${"前面好多字".repeat(20)}我想問 Crown 幾錢${"後面".repeat(30)}`;
  const s = snip.snippetAround(long, "crown")!;
  assert.ok(s.includes("Crown"), s);
  assert.ok(s.startsWith("…") && s.endsWith("…"));
  assert.equal(snip.snippetAround("短句", "冇"), "短句");
  assert.equal(snip.snippetAround(null, "x"), null);
  assert.equal(snip.escapeLike("50%_off\\"), "50\\%\\_off\\\\");
});

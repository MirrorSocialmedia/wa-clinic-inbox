// T711 — S1-1d（=S1-11）延遲送達訊息 reload 後唔見：latest page / before 改 createdAt 軸
// 跑法：./node_modules/.bin/tsx scripts/e2e-s11c-t711.ts   （3100 + worker + 15432 需存活）
//
// 設計（同 spec：thread 60 條；插入 waTimestamp=now-3h、createdAt=now 嘅 IN → latest page 包含 + 列表浮頂）：
//  - convA 61 條 = 60 條 staggered（createdAt 每 30s 一條，waTimestamp = createdAt-5s 即正常人鐘）
//    + 1 條延遲 IN（waTimestamp=now-3h、createdAt=now，經 mock-inbound --ts 真 webhook 路徑）
//  - 舊軸（waTimestamp desc）：延遲 IN 排最尾 → 50 條 latest page 漏咗佢（本測試判別點）
//  - A3 浮頂：convA 預設 lastMessageAt=now-4h → 舊 touch 用 GREATEST(last, waTs=now-3h)=now-3h；
//    新 touch 用 GREATEST(last, now)=now → 列表浮頂（判別點）
//  - A4/A5：before keyset（beforeId）同值邊界唔重唔漏
import { PrismaClient } from "@prisma/client";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import path from "path";

const prisma = new PrismaClient();
const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const REPO = process.cwd();

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function mock(cmd: string): void {
  execSync(`./node_modules/.bin/tsx scripts/mock-inbound.ts ${cmd}`, { timeout: 60000, stdio: "pipe" });
}

// ── admin cookie（.dev/credentials.txt）────────────────────────────────────────
function readCredLine(label: string): string {
  const file = path.join(REPO, ".dev", "credentials.txt");
  const lines = readFileSync(file, "utf8").split("\n");
  const l = lines.find((x) => x.startsWith(`${label}:`));
  if (!l) throw new Error(`credentials.txt 冇 ${label}`);
  return l.split(" / ")[1];
}
async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login ${email} → ${res.status}`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = setCookie.match(/wa_inbox_session=([^;]+)/);
  if (!m) throw new Error("login 冇 wa_inbox_session cookie");
  return m[1];
}

const CLINIC = "TY";
const WA = "62019937"; // seed + 延遲 IN 同 waId → 同 contact → 同 conv
const TS = Date.now();
const W_SEED = `wamid.t711.seed.${TS}`;
const W_DELAY = `wamid.t711.delay.${TS}`;
const R_IDS: string[] = []; // 60 條 staggered 嘅 wamid（r1 最舊 … r60 最新）

async function main(): Promise<void> {
  console.log(`T711 e2e — base=${BASE}`);
  const probe = await fetch(`${BASE}/`, { redirect: "manual" }).catch(() => null);
  if (!probe || probe.status >= 500) { console.error(`T711-ERR server 未 live（status=${probe?.status}）`); process.exit(2); }

  const admin = await login("admin@wa-clinic.local", readCredLine("ADMIN"));
  const H = { cookie: `wa_inbox_session=${admin}` };

  // ── cleanup 舊殘留（冪等）────────────────────────────────────────────────
  const old = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM "Message" WHERE "waMessageId" LIKE 'wamid.t711.%'`
  );
  if (old.length) {
    const cids = await prisma.$queryRawUnsafe<{ cid: string }[]>(
      `SELECT DISTINCT "conversationId" AS cid FROM "Message" WHERE "waMessageId" LIKE 'wamid.t711.%'`
    );
    const cidList = cids.map((c) => `'${c.cid}'`).join(",");
    await prisma.$executeRawUnsafe(`DELETE FROM "Message" WHERE "waMessageId" LIKE 'wamid.t711.%'`);
    if (cidList) await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE id IN (${cidList})`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Contact" WHERE "waId" = '${WA}'`);
  }

  // ── setup：convA = seed IN（ts=now-4h）+ lastMessageAt backdate now-4h ─────────
  mock(`message --clinic ${CLINIC} --from ${WA} --text "t711 seed" --wamid ${W_SEED} --ts ${Math.floor((Date.now() - 4 * 3600 * 1000) / 1000)}`);
  let convId = "";
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const rows = await prisma.message.findMany({ where: { waMessageId: W_SEED }, select: { conversationId: true } });
    if (rows.length) { convId = rows[0].conversationId; break; }
  }
  if (!convId) { console.error("T711-ERR seed conv 未建"); process.exit(2); }
  // backdate lastMessageAt 到 seed 時點（now-4h）→ 令 A3 判別
  await prisma.$executeRawUnsafe(`UPDATE "Conversation" SET "lastMessageAt"=now() - interval '4 hours' WHERE id='${convId}'`);

  // 60 條 staggered：createdAt = now-(i+1)*30s，waTimestamp = createdAt-5s
  const nowMs = Date.now();
  for (let i = 60; i >= 1; i--) {
    const created = new Date(nowMs - i * 30_000);
    const m = await prisma.message.create({
      data: {
        conversationId: convId,
        waMessageId: `wamid.t711.r${i}.${TS}`,
        direction: "IN",
        channel: "API",
        type: "text",
        body: `t711 staggered ${i}`,
        status: "RECEIVED",
        waTimestamp: new Date(created.getTime() - 5000),
        createdAt: created,
      },
    });
    R_IDS.push(m.id); // r60 → r1 顺序 push；索引 0=r60(最新) … 59=r1(最舊)
  }
  console.log(`  [setup] convA=${convId.slice(0, 8)}… 60 staggered + seed`);

  // 延遲 IN：真 webhook 路徑（worker touch + drain 全部照跑）— 同 waId 落同一 conv
  mock(`message --clinic ${CLINIC} --from ${WA} --text "t711 延遲 3h" --wamid ${W_DELAY} --ts ${Math.floor((Date.now() - 3 * 3600 * 1000) / 1000)}`);
  const delayMsg = await (async () => {
    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      const r = await prisma.message.findUnique({ where: { waMessageId: W_DELAY } });
      if (r) return r;
    }
    return null;
  })();
  ok("延遲 IN 落庫（worker 路徑）", !!delayMsg, delayMsg ? "" : "25s 內未見");

  const api = (qs: string) =>
    fetch(`${BASE}/api/conversations/${convId}/messages${qs}`, { headers: H }).then((r) => r.json() as Promise<{ messages: { id: string; waMessageId: string | null; createdAt: string }[]; hasMore: boolean }>);

  // ── A1/A2：latest page（limit=50，無 cursor）包含延遲 IN 且喺最新位 ─────────
  const latest = await api("?limit=50");
  ok("A1 latest page = 50 條", latest.messages.length === 50, `actual=${latest.messages.length}`);
  const hasDelay = latest.messages.some((m) => m.waMessageId === W_DELAY);
  ok("A1 latest page 包含延遲 IN（createdAt 軸）", hasDelay);
  const last = latest.messages[latest.messages.length - 1];
  ok("A2 延遲 IN 喺最新位（asc 尾）", last?.waMessageId === W_DELAY, `tail=${last?.waMessageId}`);

  // ── A3：列表浮頂 + lastMessageAt ≈ now（GREATEST(now)，唔係 waTs=now-3h）────
  // ★ cwi-final S1-2：/api/conversations 一律 object 回應 {items,...} — 讀 .items（limit 參數忽略，page size=200）
  const list = (await fetch(`${BASE}/api/conversations?limit=100`, { headers: H }).then((r) => r.json() as Promise<{ items: { id: string; lastMessageAt: string }[] }>)).items;
  const idx = list.findIndex((c) => c.id === convId);
  const my = list[idx];
  const ageSec = my ? (Date.now() - new Date(my.lastMessageAt).getTime()) / 1000 : -1;
  ok("A3 列表包含 convA", idx >= 0);
  ok("A3 lastMessageAt ≈ now（server 時鐘，浮頂依據）", ageSec >= 0 && ageSec < 15, `age=${ageSec.toFixed(1)}s`);
  // 列表排序 = urgent 優先（red-flag 測試 fixture 恆壓頭）→ convA 應係「非 urgent 段第 1 位」
  const urgentCount = list.filter((c) => (c as { urgent?: boolean }).urgent).length;
  ok("A3 convA = 非 urgent 段第 1 位（浮頂）", idx === urgentCount, `idx=${idx} urgentCount=${urgentCount}`);

  // ── A4：before keyset（beforeId）── cursor = latest page 最舊行 ─────────────
  const cursor = latest.messages[0];
  const older = await api(`?before=${encodeURIComponent(cursor.createdAt)}&beforeId=${cursor.id}&limit=10`);
  const cursorDup = older.messages.some((m) => m.id === cursor.id);
  ok("A4 cursor 本身唔重複出現", !cursorDup);
  const allOlder = older.messages.every((m) => new Date(m.createdAt).getTime() < new Date(cursor.createdAt).getTime());
  ok("A4 全部嚴格舊過 cursor（createdAt 軸）", allOlder);
  ok("A4 返 10 條（hidden 12 條入面最新 10）", older.messages.length === 10, `actual=${older.messages.length}`);
  const pageIds = new Set(latest.messages.map((m) => m.id));
  ok("A4 同 latest page 零重疊", older.messages.every((m) => !pageIds.has(m.id)));

  // ── A5：同 createdAt 邊界（beforeId 判別 id 順序）─────────────────────────
  const shared = new Date(nowMs - 100_000); // 唔好同 staggered 撞（30s 網格）
  const b1 = await prisma.message.create({
    data: { conversationId: convId, waMessageId: `wamid.t711.b1.${TS}`, direction: "IN", channel: "API", type: "text", body: "t711 b1", status: "RECEIVED", waTimestamp: shared, createdAt: shared },
  });
  const b2 = await prisma.message.create({
    data: { conversationId: convId, waMessageId: `wamid.t711.b2.${TS}`, direction: "IN", channel: "API", type: "text", body: "t711 b2", status: "RECEIVED", waTimestamp: shared, createdAt: shared },
  });
  const [smallId, bigId] = [b1.id, b2.id].sort((a, b) => a.localeCompare(b));
  const edge = await api(`?before=${encodeURIComponent(shared.toISOString())}&beforeId=${bigId}&limit=100`);
  const ids = new Set(edge.messages.map((m) => m.id));
  ok("A5 同 createdAt 且 id<beforeId → 包含", ids.has(smallId));
  ok("A5 同 createdAt 且 id=beforeId → 排除", !ids.has(bigId));

  // ── cleanup ────────────────────────────────────────────────────────────────
  await prisma.$executeRawUnsafe(`DELETE FROM "Message" WHERE "waMessageId" LIKE 'wamid.t711.%'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE id='${convId}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Contact" WHERE "waId" = '${WA}'`);
  const residue = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COUNT(*)::int AS n FROM "Message" WHERE "waMessageId" LIKE 'wamid.t711.%'`
  );
  ok("cleanup 零殘留", residue[0].n === 0, `residue=${residue[0].n}`);

  console.log(`\nT711: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("T711-ERR", e instanceof Error ? e.message : e);
  await prisma.$disconnect().catch(() => {});
  process.exit(2);
});

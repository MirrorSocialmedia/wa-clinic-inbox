/**
 * e2e-t600 — cwi-final S0-3：多店 STAFF 對話消失（N-2）瀏覽器 e2e
 *
 * T600（施工單）：STAFF 綁 TY+YMT；YMT 一條未指派 → 觸發 fetchConversations（assign 另一條）→
 * YMT 嗰條仍喺「全部」同「公海」+ counts.unassigned 包含佢。（**瀏覽器 e2e，唔好只打 API**）
 *
 * 回歸背景：舊初值 activeClinicId = STAFF 主店 → 所有 refetch 帶 clinicId=主店 →
 * 其他店未指派線 + 公海計數消失。
 *
 * 流程：
 *  (1) seed STAFF（clinicId=TY + StaffClinic[TY,YMT]，passwordHash 複製 staff-tkw）
 *  (2) fixture：TY 對話 A + YMT 對話 B（mockInbound webhook → 真 worker）
 *  (3) 瀏覽器：login S → /inbox 首屏斷言 B 喺「全部」→ 撳「公海」斷言 B 喺公海 + 計 N0
 *  (4) API assign A → S（socket conversation:assigned → UI fetchConversations refetch）
 *  (5) 斷言 refetch 後：A 離開公海（計 N0-1）+ B 仍喺公海（N0-1 ≥ 1 且 B row 喺度）
 *  (5.5) T755（F-3）：page.on("request") 計 /api/conversations GET — 連續 3 assign（200ms 間隔）
 *        → 3 秒內多 1～2 次 GET（debounce 前 = 3+）+ 公海計數正確（-3）
 *  (6) cleanup（user / StaffClinic / 對話 / contact 全洗）
 *
 * 前置：dev stack live（server 3100 + worker + DB 15432 + Redis）。
 * 用法（repo root）：pnpm tsx scripts/e2e-t600-multiclinic-staff.ts
 * 輸出：T600-OK / T600-FAIL: <reason>
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { chromium } from "./_pw"; // ★ cwi-final F-5：playwright-core 單一入口（PW_CORE 可覆蓋）

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
try {
  process.loadEnvFile(path.join(REPO, ".env"));
} catch {
  /* 靠 process env */
}

const EMAIL = "staff-e2e-s03@wa-clinic.local";
const NAME_A = "E2E S03 TY 王五";
const NAME_B = "E2E S03 YMT 趙六";
const WA_A = "62019001"; // HK 8 位（normalizeHkPhones）
const WA_B = "62019002";
const WA_C = "62019003";
const WA_D = "62019004";
const EPOCH = Date.now().toString().slice(-6);
const WAM_A = `wae2es3a${EPOCH}`;
const WAM_B = `wae2es3b${EPOCH}`;
const WAM_C = `wae2es3c${EPOCH}`;
const WAM_D = `wae2es3d${EPOCH}`;

let FAILS = 0;
function ok(msg: string): void {
  console.log(`  ✅ ${msg}`);
}
function fail(msg: string): void {
  FAILS++;
  console.log(`  ❌ ${msg}`);
}
function check(name: string, actual: unknown, expected: unknown): void {
  if (String(actual) === String(expected)) ok(name);
  else fail(`${name}（expected=[${expected}] actual=[${actual}]）`);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const prisma = new PrismaClient();

async function cleanupFixture(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `DELETE FROM "Message" WHERE "conversationId" IN (SELECT cv.id FROM "Conversation" cv JOIN "Contact" ct ON ct.id = cv."contactId" WHERE ct."waId" IN ('${WA_A}','${WA_B}','${WA_C}','${WA_D}'))`
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "Conversation" WHERE "contactId" IN (SELECT id FROM "Contact" WHERE "waId" IN ('${WA_A}','${WA_B}','${WA_C}','${WA_D}'))`
  );
  await prisma.$executeRawUnsafe(`DELETE FROM "Contact" WHERE "waId" IN ('${WA_A}','${WA_B}','${WA_C}','${WA_D}')`);
  await prisma.staffClinic.deleteMany({ where: { staff: { email: EMAIL } } });
  await prisma.staffUser.deleteMany({ where: { email: EMAIL } });
}

function mockInbound(phone: string, name: string, text: string, wamid: string, clinic: string): boolean {
  // ★ cwi-final F-3 環境適配：直用 tsx（worktree symlink node_modules → pnpm 執行 script 會撞
  //   ERR_PNPM_UNSAFE_MODULES_DIR）+ PORT 跟 BASE（webhook 打自己個 server）
  const port = new URL(BASE).port || "80";
  for (let i = 1; i <= 3; i++) {
    try {
      execSync(
        `./node_modules/.bin/tsx scripts/mock-inbound.ts message --clinic ${clinic} --from ${phone} --name "${name}" --text "${text}" --wamid ${wamid}`,
        { cwd: REPO, stdio: "pipe", timeout: 60_000, env: { ...process.env, PORT: port } }
      );
      return true;
    } catch {
      if (i === 3) {
        fail(`mock-inbound ${wamid} 3 試仍失敗（webhook/worker 問題？）`);
        return false;
      }
      execSync("sleep 3");
    }
  }
  return false;
}

async function loginSession(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`login ${email} → ${res.status}`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = setCookie.match(/wa_inbox_session=([^;]+)/);
  if (!m) throw new Error("login 回應冇 wa_inbox_session cookie");
  return m[1];
}

function findChromium(): string {
  const baseDir = path.join(os.homedir(), ".cache", "ms-playwright");
  const dirs = readdirSync(baseDir)
    .filter((d) => d.startsWith("chromium-"))
    .sort()
    .reverse();
  for (const d of dirs) {
    const exe = path.join(baseDir, d, "chrome-linux64", "chrome");
    try {
      readFileSync(exe);
      return exe;
    } catch {
      /* next */
    }
  }
  throw new Error("chromium binary 搵唔到（~/.cache/ms-playwright）");
}

interface PageLike {
  goto: (url: string, o: Record<string, unknown>) => Promise<unknown>;
  locator: (sel: string) => { count: () => Promise<number> };
  getByText: (t: string, o?: Record<string, unknown>) => {
    count: () => Promise<number>;
    // playwright-core bundle：locator.first 係 method（返回 locator）— runtime 實測
    first: () => { click: (o?: Record<string, unknown>) => Promise<void> };
  };
  evaluate: (fn: () => unknown) => Promise<unknown>;
  on: (ev: string, cb: (r: { url: () => string; method: () => string }) => void) => void;
  close: () => Promise<void>;
}
interface CtxLike {
  newPage: () => Promise<PageLike>;
  addCookies: (c: Array<Record<string, unknown>>) => Promise<void>;
  close: () => Promise<void>;
}
type Browser = {
  newContext: (o: Record<string, unknown>) => Promise<CtxLike>;
  close: () => Promise<void>;
};

async function waitCount(P: PageLike, text: string, timeoutMs = 60_000): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    try {
      if ((await P.getByText(text, { exact: false }).count()) > 0) return true;
    } catch {
      /* dev 重編譯 */
    }
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(500);
  }
}

/** 讀「公海 N」膠囊計數 */
async function readPoolCount(P: PageLike): Promise<number> {
  const t = await P.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    for (const b of btns) {
      const m = (b.textContent ?? "").match(/公海\s*(\d+)/);
      if (m) return Number(m[1]);
    }
    return -1;
  }) as number;
  return t;
}

async function main(): Promise<void> {
  const exe = findChromium();

  // ── (1) seed STAFF（TY 主店 + YMT） ────────────────────────────────────
  console.log("[setup] 清舊 fixture + seed STAFF（TY+YMT）...");
  await cleanupFixture();
  const ty = (await prisma.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "Clinic" WHERE code='TY'`))[0]?.id;
  const ymt = (await prisma.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "Clinic" WHERE code='YMT'`))[0]?.id;
  if (!ty || !ymt) throw new Error("TY/YMT clinic 搵唔到");
  const tkwHash = (await prisma.$queryRawUnsafe<{ h: string }[]>(
    `SELECT "passwordHash" h FROM "StaffUser" WHERE email='staff-tkw@wa-clinic.local'`
  ))[0]?.h;
  if (!tkwHash) throw new Error("staff-tkw passwordHash 搵唔到");

  const user = await prisma.staffUser.create({
    data: {
      email: EMAIL,
      passwordHash: tkwHash, // 同 staff-tkw 同密碼（credentials.txt 有）
      name: "E2E S03 多店員工",
      role: "STAFF",
      clinicId: ty,
      scopeType: "CLINICS",
      active: true,
    },
  });
  await prisma.staffClinic.create({ data: { staffId: user.id, clinicId: ty, isPrimary: true } });
  await prisma.staffClinic.create({ data: { staffId: user.id, clinicId: ymt, isPrimary: false } });
  ok(`STAFF seed 完成（TY 主店 + YMT）`);

  // ── (2) fixture 對話 ───────────────────────────────────────────────────
  if (!mockInbound(WA_A, NAME_A, `E2E S03 A 訊息 ${EPOCH}`, WAM_A, "TY")) throw new Error("mock-inbound A 失敗");
  if (!mockInbound(WA_B, NAME_B, `E2E S03 B 訊息 ${EPOCH}`, WAM_B, "YMT")) throw new Error("mock-inbound B 失敗");
  // T755（F-3）需要 3 條未指派對話 → 加 C（TY）+ D（YMT）
  if (!mockInbound(WA_C, `E2E S03 TY 陳七`, `E2E S03 C 訊息 ${EPOCH}`, WAM_C, "TY")) throw new Error("mock-inbound C 失敗");
  if (!mockInbound(WA_D, `E2E S03 YMT 林八`, `E2E S03 D 訊息 ${EPOCH}`, WAM_D, "YMT")) throw new Error("mock-inbound D 失敗");
  const convOf = async (wa: string): Promise<string> => {
    const t0 = Date.now();
    for (;;) {
      const r = (
        await prisma.$queryRawUnsafe<{ id: string }[]>(
          `SELECT cv.id FROM "Conversation" cv JOIN "Contact" ct ON ct.id = cv."contactId" WHERE ct."waId" = $1`,
          wa
        )
      )[0];
      if (r) return r.id;
      if (Date.now() - t0 > 45_000) throw new Error(`conversation ${wa} 未落庫`);
      await sleep(1500);
    }
  };
  const convA = await convOf(WA_A);
  const convB = await convOf(WA_B);
  const convC = await convOf(WA_C);
  const convD = await convOf(WA_D);
  const clinicOf = async (id: string): Promise<string> =>
    (await prisma.$queryRawUnsafe<{ c: string }[]>(`SELECT code c FROM "Clinic" c JOIN "Conversation" cv ON cv."clinicId"=c.id WHERE cv.id=$1`, id))[0]?.c ?? "";
  check("fixture A clinic = TY", await clinicOf(convA), "TY");
  check("fixture B clinic = YMT", await clinicOf(convB), "YMT");
  check("fixture C clinic = TY", await clinicOf(convC), "TY");
  check("fixture D clinic = YMT", await clinicOf(convD), "YMT");
  ok(`fixture 對話就緒（A/B/C/D）`);

  // ── (3) 瀏覽器：首屏 + 公海 ────────────────────────────────────────────
  const cred = readFileSync(path.join(REPO, ".dev/credentials.txt"), "utf8")
    .split("\n")
    .find((l) => l.startsWith("TKW STAFF:"));
  if (!cred) throw new Error(".dev/credentials.txt 冇 TKW STAFF 行");
  const session = await loginSession(EMAIL, cred.split(" / ")[1]);
  ok("login 多店 STAFF");

  const B = (await (chromium as { launch: (o: Record<string, unknown>) => Promise<Browser> }).launch({
    headless: true,
    executablePath: exe,
  })) as Browser;
  const C = await B.newContext({ viewport: { width: 1440, height: 900 } });
  await C.addCookies([{ name: "wa_inbox_session", value: session, domain: "127.0.0.1", path: "/" }]);
  const P = await C.newPage();
  try {
    await P.goto(`${BASE}/inbox`, { waitUntil: "domcontentloaded", timeout: 120_000 });

    // 首屏「全部」：A 同 B 都要喺度（N-2 核心：B = 非主店 YMT 未指派）
    if (!(await waitCount(P, NAME_A, 90_000))) throw new Error("90s 首屏冇見到 A（TY）— 基礎 list 壞");
    ok("首屏「全部」見到 A（TY）");
    if (!(await waitCount(P, NAME_B, 30_000))) throw new Error("30s 首屏冇見到 B（YMT 非主店未指派）— N-2 回歸");
    ok("首屏「全部」見到 B（YMT 非主店未指派）");

    // 撳「公海」→ B 喺公海 + 計 N0（等首次 connect 嘅 counts fetch 落地 — S0-3 fix）
    await P.getByText("公海", { exact: false }).first().click({ timeout: 15_000 });
    let n0 = -1;
    const tN0 = Date.now();
    for (;;) {
      n0 = await readPoolCount(P);
      if (n0 >= 2) break;
      if (Date.now() - tN0 > 15_000) break;
      await sleep(500);
    }
    check("公海計數 N0 ≥ 2（A+B）", n0 >= 2, true);
    if ((await P.getByText(NAME_B, { exact: false }).count()) === 0) throw new Error("公海 filter 後 B 唔喺 — N-2 回歸");
    ok(`公海見到 B（N0=${n0}）`);

    // ── (4) 觸發 refetch：assign A → S（socket → fetchConversations） ────
    const res = await fetch(`${BASE}/api/conversations/${convA}/assign`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `wa_inbox_session=${session}` },
      body: JSON.stringify({ toStaffId: user.id }),
    });
    if (res.status !== 200 && res.status !== 201) throw new Error(`assign A → ${res.status}（${await res.text().then((t) => t.slice(0, 200))}）`);
    ok(`API assign A → S（${res.status}）— 等 UI refetch`);

    // ── (5) 斷言 refetch 後狀態 ──────────────────────────────────────────
    let nAfter = -1;
    let aGone = false;
    const t0 = Date.now();
    for (;;) {
      nAfter = await readPoolCount(P);
      aGone = (await P.getByText(NAME_A, { exact: false }).count()) === 0;
      if (nAfter === n0 - 1 && aGone) break;
      // ★ cwi-final F-3 環境加固：suite 連跑時 chromium render 可能 transient 慢（2026-09-19 兩輪 suite 各 flake 一次，
      //   均喺舊有行文字斷言；T755 GET 計數斷言兩輪全綠）— 窗口 25s→45s，斷言語義不變
      if (Date.now() - t0 > 45_000) break;
      await sleep(750);
    }
    check("refetch 後公海計數 = N0-1（A 離隊）", nAfter, n0 - 1);
    check("refetch 後 A 唔喺公海（refetch 真係行咗）", aGone, true);
    const bStill = (await P.getByText(NAME_B, { exact: false }).count()) > 0;
    check("refetch 後 B（YMT 未指派）仍喺公海 + 計數包含佢", bStill, true);
    check("B 喺計數入面（N0-1 ≥ 1）", nAfter >= 1, true);

    // ── (5.5) T755（F-3）：連續 3 assign（200ms 間隔）→ 1.2s 窗口合併 → 多 1～2 次 GET ──
    //   socket conversation:assigned ×3 → 舊版每次即時 fetch（3+ GET）；F-3 debounce 後 = 1 次。
    //   斷言 1～2：下界 1 確保合併後仍真係刷新；上界 2 容許事件跨窗口嘅極端時序。
    let listGets = 0;
    P.on("request", (r) => {
      if (r.method() === "GET" && r.url().includes("/api/conversations?")) listGets++;
    });
    await sleep(2500); // 等 (4)/(5) 嘅 debounce 窗口收結
    const getsBase = listGets;
    for (const cv of [convB, convC, convD]) {
      const r = await fetch(`${BASE}/api/conversations/${cv}/assign`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `wa_inbox_session=${session}` },
        body: JSON.stringify({ toStaffId: user.id }),
      });
      if (r.status !== 200 && r.status !== 201) throw new Error(`T755 assign → ${r.status}（${await r.text().then((t) => t.slice(0, 200))}）`);
      await sleep(200);
    }
    ok("T755 3 assign 完成（B/C/D → S，200ms 間隔）");
    await sleep(3000); // 3 秒窗口（> 1.2s debounce + in-flight）
    const getsDelta = listGets - getsBase;
    check("T755 3 秒內 /api/conversations GET 增量 = 1～2（debounce 合併）", getsDelta >= 1 && getsDelta <= 2, true);
    // 公海計數正確：B/C/D 三條離開公海
    let n755 = -1;
    const t755 = Date.now();
    for (;;) {
      n755 = await readPoolCount(P);
      if (n755 === nAfter - 3) break;
      if (Date.now() - t755 > 15_000) break;
      await sleep(750);
    }
    check("T755 公海計數 = nAfter-3（B/C/D 離隊）", n755, nAfter - 3);
  } finally {
    await C.close().catch(() => undefined);
    await B.close().catch(() => undefined);
  }

  // ── (6) cleanup ────────────────────────────────────────────────────────
  await cleanupFixture();
  const leftover = (
    await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT (SELECT count(*) FROM "Contact" WHERE "waId" IN ('${WA_A}','${WA_B}','${WA_C}','${WA_D}')) + (SELECT count(*) FROM "StaffUser" WHERE email='${EMAIL}') AS n`
    )
  )[0]?.n ?? -1;
  check("cleanup 後零殘留", leftover, 0);

  await prisma.$disconnect();
  if (FAILS > 0) {
    console.log(`T600-FAIL: ${FAILS} 項失敗`);
    process.exit(1);
  }
  console.log("T600-OK");
  process.exit(0);
}

main().catch(async (err) => {
  console.error("T600-FAIL:", err instanceof Error ? err.message : err);
  try {
    await cleanupFixture();
  } catch {
    /* best-effort */
  }
  process.exit(1);
});

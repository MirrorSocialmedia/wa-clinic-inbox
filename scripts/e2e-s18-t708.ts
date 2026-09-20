/**
 * e2e-s18-t708 — cwi-final S1-8 T708：手機膠囊全 toggle（L-5 修正版 / R-14）
 *
 * 覆蓋（MD §1412-1421 五條 spec 之窄屏相關 + T708 明列斷言）：
 * - 360px viewport，counts.followup=3 → 「跟進 3」可見（短字；待跟進永遠喺可見列，唔入 ⋯）
 * - 撳公海再撳一次 → 返全部（四粒膠囊全 toggle：onAssignedFilter(key === current ? "all" : key)）
 * - 順帶斷言：窄屏四粒短字膠囊（公海/派我/我負責/跟進）+ 冇 ⋯ + 「全部 N」細字狀態顯示
 *
 * 前置：dev stack live（server 3100 + DB 15432）
 * 用法（repo root）：pnpm tsx scripts/e2e-s18-t708.ts
 * 輸出：T708-OK / T708-FAIL: <reason>
 * fixture：`t708` 前綴 id — 段尾 hermetic sweep（assert 零殘留）
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { PrismaClient } from "@prisma/client";

const REPO = path.join(import.meta.dirname, "..");
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:3100";
const prisma = new PrismaClient();

function ok(label: string): void {
  console.log(`  ✅ ${label}`);
}
function fail(label: string, detail?: unknown): never {
  console.error(`  ❌ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  process.exit(1);
}
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) ok(label);
  else fail(label, detail);
}

// ── fixtures（id 全部 cuid 形：20+ lowercase alnum — normalizeRoute 鐵律）──
const FIX = {
  contactPrefix: "t708ccount",
  convPrefix: "t708conv",
  taskPrefix: "t708task",
  names: ["T708 甲", "T708 乙", "T708 丙"],
  contacts: ["t708cconta000000000001", "t708ccountb000000000002", "t708ccountc000000000003"],
  convs: ["t708conva00000000000001", "t708convb00000000000002", "t708convc00000000000003"],
  tasks: ["t708taska00000000000001", "t708taskb00000000000002", "t708taskc00000000000003"],
  waIds: ["85299030001", "85299030002", "85299030003"],
};

const COOKIE_CACHE = "/tmp/w-t708-e2e-cookie.json";

function readCredLine(label: string): string {
  const file = path.join(REPO, ".dev", "credentials.txt");
  const l = readFileSync(file, "utf8").split("\n").find((x) => x.startsWith(`${label}:`));
  if (!l) fail(`credentials.txt 冇 ${label}`);
  return l.split(" / ")[1];
}

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) fail(`login ${email} → ${res.status}`);
  const m = (res.headers.get("set-cookie") ?? "").match(/wa_inbox_session=([^;]+)/);
  if (!m) fail("login 冇 wa_inbox_session cookie");
  return m[1];
}
// login 限流 5 次/60s/IP — cookie 有效就重用（/tmp cache）
async function cookieFor(email: string, password: string): Promise<string> {
  try {
    const cache = JSON.parse(readFileSync(COOKIE_CACHE, "utf8")) as Record<string, string>;
    if (cache[email]) {
      const probe = await fetch(`${BASE}/api/conversations?counts=1`, { headers: { cookie: `wa_inbox_session=${cache[email]}` } });
      if (probe.status === 200) return cache[email];
    }
  } catch {
    /* 無 cache — fallthrough login */
  }
  const c = await login(email, password);
  writeFileSync(COOKIE_CACHE, JSON.stringify({ [email]: c }));
  return c;
}

function findChromium(): string {
  const baseDir = path.join(os.homedir(), ".cache", "ms-playwright");
  const dirs = readdirSync(baseDir).filter((d) => d.startsWith("chromium-")).sort().reverse();
  for (const d of dirs) {
    const exe = path.join(baseDir, d, "chrome-linux64", "chrome");
    try {
      readFileSync(exe);
      return exe;
    } catch {
      /* next */
    }
  }
  fail("chromium binary 搵唔到");
}

async function setupFixtures(tkwId: string, staffTkwId: string): Promise<void> {
  // ★ 基線確定性：清晒全庫 SUGGESTED task（dev e2e 環境；count 只由我地 3 條決定）
  const stale = await prisma.followupTask.deleteMany({ where: { status: "SUGGESTED" } });
  ok(`pre-sweep SUGGESTED tasks = ${stale.count}（counts.followup 基線歸零）`);

  const now = new Date();
  const due = new Date(Date.now() + 24 * 3600_000); // 未來 dueAt → 遠未過期（expiry = dueAt + 時效窗口）
  for (let i = 0; i < 3; i++) {
    const contact = await prisma.contact.findUnique({ where: { id: FIX.contacts[i] } });
    if (!contact) {
      await prisma.contact.create({
        data: { id: FIX.contacts[i], clinicId: tkwId, waId: FIX.waIds[i], profileName: FIX.names[i], labels: [] },
      });
    }
    const conv = await prisma.conversation.findUnique({ where: { id: FIX.convs[i] } });
    if (!conv) {
      // ★ 三條全指派（assignee = staff-tkw）→ 公海 filter 必唔見佢哋（toggle 斷言先有對比）
      await prisma.conversation.create({
        data: { id: FIX.convs[i], clinicId: tkwId, contactId: FIX.contacts[i], assigneeId: staffTkwId, lastMessageAt: now, lastInboundAt: now },
      });
    }
    await prisma.followupTask.upsert({
      where: { id: FIX.tasks[i] },
      create: {
        id: FIX.tasks[i],
        clinicId: tkwId,
        conversationId: FIX.convs[i],
        phoneHashes: [`t708-hash-${i}`],
        dueAt: due,
      },
      update: { status: "SUGGESTED", dueAt: due, cancelReason: null, handledAt: null },
    });
  }
}

async function sweep(): Promise<void> {
  await prisma.followupTask.deleteMany({ where: { id: { in: FIX.tasks } } });
  await prisma.conversation.deleteMany({ where: { id: { in: FIX.convs } } });
  await prisma.contact.deleteMany({ where: { id: { in: FIX.contacts } } });
  const left =
    (await prisma.followupTask.count({ where: { id: { in: FIX.tasks } } })) +
    (await prisma.conversation.count({ where: { id: { in: FIX.convs } } })) +
    (await prisma.contact.count({ where: { id: { in: FIX.contacts } } }));
  check("cleanup 零殘留", left === 0, left);
}

async function main(): Promise<void> {
  console.log(`T708: 手機膠囊全 toggle（360px followup=3 可見 + 公海×2 返全部）`);
  const probe = await fetch(`${BASE}/`, { redirect: "manual" }).catch(() => null);
  if (!probe || probe.status >= 500) fail("server 未 live（3100）", probe?.status);
  ok("server live");

  const tkw = await prisma.clinic.findFirst({ where: { code: "TKW" } });
  const staffTkw = await prisma.staffUser.findFirst({ where: { email: "staff-tkw@wa-clinic.local" } });
  if (!tkw || !staffTkw) fail("clinic TKW / staff-tkw 搵唔到");

  await setupFixtures(tkw.id, staffTkw.id);
  const adminCookie = await cookieFor("admin@wa-clinic.local", readCredLine("ADMIN"));
  ok("fixtures + admin login");

  // server 側基線：counts.followup 必 = 3
  const listRes = await fetch(`${BASE}/api/conversations?counts=1`, { headers: { cookie: `wa_inbox_session=${adminCookie}` } });
  if (listRes.status !== 200) fail("list API 非 200", listRes.status);
  const listBody = (await listRes.json()) as { counts?: { followup?: number } };
  check("server counts.followup === 3", listBody.counts?.followup === 3, listBody.counts);

  /* eslint-disable @typescript-eslint/no-require-imports -- repo 慣例：playwright-core 從 openclaw global node_modules 載入 */
  const { chromium } = require("/usr/lib/node_modules/openclaw/node_modules/playwright-core") as PwModule;
  const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 700 } });
    const page = await ctx.newPage();
    await ctx.addCookies([{ name: "wa_inbox_session", value: adminCookie, domain: "127.0.0.1", path: "/" }]);
    await page.goto(`${BASE}/inbox`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    const row = page.locator('[data-e2e="capsule-row"]');
    await row.waitFor({ timeout: 30_000 });
    // counts 順帶 fetch — 等「跟進 3」渲染出（最多 10s）
    await page.waitForFunction(
      () => document.querySelector('[data-e2e="capsule-followup"]')?.textContent?.trim() === "跟進 3",
      { timeout: 10_000 }
    ).catch(() => {});
    const fuText = (await page.locator('[data-e2e="capsule-followup"]').textContent())?.trim();
    check("360px：「跟進 3」可見（待跟進永遠喺可見列）", fuText === "跟進 3", fuText);
    check("360px：四粒膠囊（2+2 兩行）", (await row.locator("button").count()) === 4, await row.locator("button").count());
    for (const re of [/^公海 \d+$/, /^派我 \d+$/, /^我負責 \d+$/, /^跟進 3$/]) {
      check(`360px 短字膠囊：${re}`, (await row.locator("button", { hasText: re }).count()) === 1);
    }
    check("360px：冇 ⋯ 溢出按鈕", (await row.locator('button[data-e2e="capsule-more"]').count()) === 0);
    check("360px：「全部 N」細字狀態顯示", (await row.locator('[data-e2e="capsule-all-count"]').count()) === 1);
    await page.screenshot({ path: "/tmp/t708-1-followup3.png" });
    ok("screenshot: /tmp/t708-1-followup3.png");

    // ── toggle：撳公海 → 三條 T708 線（全已指派）必消失 ──
    const sea = row.locator('[data-e2e="capsule-unassigned"]');
    await sea.click();
    await page.waitForTimeout(900);
    check("撳公海：aria-pressed=true", (await sea.getAttribute("aria-pressed")) === "true");
    let hiddenN = 0;
    for (const name of FIX.names) if ((await page.getByText(name, { exact: false }).count()) === 0) hiddenN++;
    check("撳公海：三條 T708 線（已指派）唔顯示", hiddenN === 3, hiddenN);
    await page.screenshot({ path: "/tmp/t708-2-sea-filtered.png" });

    // ── 再撳一次公海 → 返全部（三條線返嚟）──
    await sea.click();
    await page.waitForTimeout(900);
    check("再撳公海：aria-pressed=false（返全部）", (await sea.getAttribute("aria-pressed")) === "false");
    let backN = 0;
    for (const name of FIX.names) if ((await page.getByText(name, { exact: false }).count()) >= 1) backN++;
    check("再撳公海：三條 T708 線返嚟（全部視圖）", backN === 3, backN);
    const fuText2 = (await page.locator('[data-e2e="capsule-followup"]').textContent())?.trim();
    check("返全部後「跟進 3」仍然可見", fuText2 === "跟進 3", fuText2);
    await page.screenshot({ path: "/tmp/t708-3-back-to-all.png" });
    ok("screenshot: /tmp/t708-3-back-to-all.png");
    await ctx.close();
  } finally {
    await browser.close();
    await sweep();
  }
  console.log("T708-OK: 手機膠囊全 toggle（360px followup=3 可見 + 公海×2 返全部）");
  process.exit(0);
}

type PwLocMin = {
  count(): Promise<number>;
  first(): PwLocMin;
  textContent(): Promise<string | null>;
  getAttribute(n: string): Promise<string | null>;
  click(): Promise<void>;
  waitFor(o?: { timeout?: number }): Promise<void>;
  locator(sel: string, opts?: { hasText?: string | RegExp }): PwLocMin;
};
type PwPageMin = {
  locator(sel: string, opts?: { hasText?: string | RegExp }): PwLocMin;
  getByText(t: string, o?: { exact?: boolean }): PwLocMin;
  waitForFunction(fn: unknown, o?: { timeout?: number }): Promise<void>;
  waitForTimeout(n: number): Promise<void>;
  goto(u: string, o?: { waitUntil?: string; timeout?: number }): Promise<void>;
  screenshot(o: { path: string }): Promise<void>;
};
type PwModule = {
  chromium: {
    launch(opts: { executablePath: string; args: string[] }): Promise<{
    newContext(o: { viewport: { width: number; height: number } }): Promise<{
      newPage(): Promise<PwPageMin>;
      addCookies(c: { name: string; value: string; domain: string; path: string }[]): Promise<void>;
      close(): Promise<void>;
    }>;
    close(): Promise<void>;
  }>;
  };
};

main().catch((e) => {
  console.error(`T708-FAIL: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});

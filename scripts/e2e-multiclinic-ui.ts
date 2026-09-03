/**
 * e2e-multiclinic-ui — cwi-multiclinic-20260903（B3 Part A 缺口補齊）瀏覽器級斷言。
 *
 * 覆蓋 MD A.6 UI 缺口（T91–T99 既有 API 迴歸喺 mock-e2e.sh H6 段；呢度係新 UI 斷言）：
 * - release  ：header〔放手〕掣（現任負責人見；兩段確認）→ release 成功（負責人 chip 消失 + toast）
 * - menu     ：指派選單二級（本店 + 「其他分店…」店→員工）+ 跨店 confirm 文案「對方將可查閱呢個對話嘅完整記錄」
 * - send423  ：打字保護 — send 收 423 → composer 文字唔清走 + toast「{name} 已接手呢個對話」+ header 負責人名即時更新
 * - badges   ：跨店線店名 badge（STAFF 唔喺綁定店先見）+「待跟進」badge（未指派 + 最後一條係 IN）→ 覆咗消失
 *
 * 模式照 e2e-notify-ui.ts（playwright-core + chromium headless + cookie jar；零新 socket 事件）。
 *
 * 用法（repo root，dev server 已起）：
 *   pnpm e2e:multiclinic-ui --scenario release --base http://127.0.0.1:3100 \
 *     --cookie /tmp/e2e-cookie-h6m.txt --conv-release <id>
 *   pnpm e2e:multiclinic-ui --scenario send423 ... --cookie2 /tmp/e2e-cookie-tkw.txt \
 *     --conv-423 <id> --staff-tkw-id <id> --staff-tkw-name <name>
 *
 * 輸出（mock-e2e.sh grep 用）：MCUI-OK <scenario> / MCUI-FAIL <scenario>: <reason>
 *
 * ★ PII 鐵律：fixture 全合成（E2E MC 前綴）。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/* eslint-disable @typescript-eslint/no-require-imports */
const { chromium } = require("/usr/lib/node_modules/openclaw/node_modules/playwright-core") as {
  chromium: { launch: (o: Record<string, unknown>) => Promise<unknown> };
};

// ── args ─────────────────────────────────────────────────────────────────
function arg(name: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? "") : "";
}
function req(name: string): string {
  const v = arg(name);
  if (!v) {
    console.error(`missing ${name}`);
    process.exit(2);
  }
  return v;
}

const scenario = req("--scenario");
const base = req("--base").replace(/\/$/, "");
const cookieFile = req("--cookie");
const cookie2File = arg("--cookie2"); // send423：staff-tkw（並行接手者）
const convRelease = arg("--conv-release");
const convMenu = arg("--conv-menu");
const conv423 = arg("--conv-423");
const convFollower = arg("--conv-follower");
const convWtc = arg("--conv-wtc");
const nameRelease = arg("--name-release") || "E2E MC R";
const nameMenu = arg("--name-menu") || "E2E MC M";
const name423 = arg("--name-423") || "E2E MC 423";
const nameFollower = arg("--name-follower") || "E2E MC F";
const nameWtc = arg("--name-wtc") || "E2E MC WTC";
const wtcCode = arg("--clinic-wtc-code") || "WTC";
const staffTkwId = arg("--staff-tkw-id");
const staffTkwName = arg("--staff-tkw-name") || "staff-tkw";
const staffWtcName = arg("--staff-wtc-name") || "staff-wtc";

let failReason: string | null = null;
function fail(r: string): never {
  const d = diagLog.slice(-10).join(" | ");
  failReason = d ? `${r} || diag: ${d}` : r;
  throw new Error(failReason);
}

// ── chromium / cookie ────────────────────────────────────────────────────
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

function readSession(cookieFile: string): string {
  const jar = readFileSync(cookieFile, "utf8");
  const line = jar.split("\n").find((l) => l.includes("wa_inbox_session"));
  return (line ?? "").trim().split(/\s+/).pop() ?? "";
}

interface LocatorLike {
  count: () => Promise<number>;
  first: () => LocatorLike;
  isVisible: () => Promise<boolean>;
  waitFor: (o?: Record<string, unknown>) => Promise<unknown>;
  click: (o?: Record<string, unknown>) => Promise<void>;
  textContent: () => Promise<string | null>;
  allTextContents: () => Promise<string[]>;
  filter: (o: Record<string, unknown>) => LocatorLike;
  getByText: (t: string | RegExp, o?: Record<string, unknown>) => LocatorLike;
  getByRole: (role: string, o: Record<string, unknown>) => LocatorLike;
  locator: (sel: string, o?: Record<string, unknown>) => LocatorLike;
}
interface PageLike {
  goto: (url: string, o?: Record<string, unknown>) => Promise<void>;
  locator: (sel: string, o?: Record<string, unknown>) => LocatorLike;
  getByRole: (role: string, o: Record<string, unknown>) => LocatorLike;
  getByText: (t: string | RegExp, o?: Record<string, unknown>) => LocatorLike;
  fill: (sel: string, v: string, o?: Record<string, unknown>) => Promise<void>;
  evaluate: <T>(fn: unknown, arg?: unknown) => Promise<T>;
  on: (event: string, handler: unknown) => void;
  route: (pattern: string, handler: unknown) => Promise<void>;
  unroute: (pattern: string) => Promise<void>;
  screenshot: (o?: Record<string, unknown>) => Promise<unknown>;
  close: () => Promise<void>;
}

// 診斷日誌（fail 時 dump）：console error / pageerror / HTTP >=400 — 分辨 manifest race 500 vs 真 code error
const diagLog: string[] = [];
function attachDiag(P: PageLike, tag: string): void {
  P.on("console", (m: { type: () => string; text: () => string }) => {
    if (m.type() === "error") diagLog.push(`[${tag}] console: ${m.text().slice(0, 300)}`);
  });
  P.on("pageerror", (e: unknown) => {
    diagLog.push(`[${tag}] pageerror: ${String(e).slice(0, 300)}`);
  });
  P.on("response", (r: { status: () => number; url: () => string }) => {
    const s = r.status();
    if (s >= 400) diagLog.push(`[${tag}] http ${s} ${r.url().slice(0, 160)}`);
  });
}

async function launchWithCookie(cookieFile: string): Promise<{
  B: { close: () => Promise<void> };
  P: PageLike;
}> {
  const exe = findChromium();
  const sessionValue = readSession(cookieFile);
  if (!sessionValue) fail("cookie 檔冇 session（未 login？）");
  const B = (await (chromium as { launch: (o: Record<string, unknown>) => Promise<{ newContext: (o: Record<string, unknown>) => Promise<CtxLike>; close: () => Promise<void> }> }).launch({
    headless: true,
    executablePath: exe,
  })) as unknown as { newContext: (o: Record<string, unknown>) => Promise<CtxLike>; close: () => Promise<void> };
  const C = await B.newContext({ viewport: { width: 1440, height: 900 } });
  await C.addCookies([{ name: "wa_inbox_session", value: sessionValue, domain: "127.0.0.1", path: "/" }]);
  const P = await C.newPage();
  attachDiag(P, scenario);
  // dev server 首載慢 — goto  generous timeout（mock-e2e 前面段落已 warmup 過多數）
  await P.goto(`${base}/inbox`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  // cwi-multiclinic-20260903 a2：Part B 首登通知 banner（新 browser localStorage 空 → 必現；z-40 盖住頂部中間 header）
  // → 統一撳「唔該」收走（零產品改動；release 掣喺 banner 範圍內必被 intercept — 第 3 輪 release 紅之二）
  await P.locator('button:has-text("唔該")').click({ timeout: 3000 }).catch(() => {});
  return { B, P };
}

interface CtxLike {
  addCookies: (c: unknown[]) => Promise<void>;
  newPage: () => Promise<PageLike>;
  close: () => Promise<void>;
}

/** 等列表行（contact name 出現）— dev 首載 / socket sync */
async function waitRow(P: PageLike, name: string, what: string, timeoutMs = 60_000): Promise<LocatorLike> {
  const t0 = Date.now();
  for (;;) {
    const loc = P.locator("button", { hasText: name });
    if ((await loc.count()) > 0) return loc;
    if (Date.now() - t0 > timeoutMs) fail(`等列表行「${name}」逾時（${what}）`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** 等 toast（fixed bottom）含文字 */
async function waitToast(P: PageLike, text: string, what: string, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const n = await P.locator("div.fixed", { hasText: text }).count();
    if (n > 0) return;
    if (Date.now() - t0 > timeoutMs) fail(`等 toast「${text}」逾時（${what}）`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** chat pane 已開訊號 — composer（textarea）可見；或過窗（WindowExits 三出路 — 無 composer，同樣代表 pane 已開）。
 *  cwi-multiclinic-20260903 a2 修：release/menu fixture 線（R/M）無 inbound → window closed →
 *  composer 分支渲染 WindowExits（零 textarea）→ 舊 gate（只等 composer）永遠逾時（第 1–3 輪紅根因）。 */
async function paneReady(P: PageLike, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    const ta = P.locator("textarea");
    if ((await ta.count()) > 0 && (await ta.first().isVisible())) return true;
    const we = P.locator("text=24 小時窗口已過");
    if ((await we.count()) > 0 && (await we.first().isVisible())) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * 開對話行 — 防兩類 dev 環境 flake：
 * ① SSR dead-click（SSR HTML 已見文字但 React 未 hydrate → 撳落無 onClick）
 * ② loadManifest race（JS chunk 500 → 整頁無 hydrate → 永遠 dead click）→ 整頁 reload 重試一次
 */
async function openConv(P: PageLike, name: string, what: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await waitRow(P, name, `${what}${attempt > 0 ? `（重試${attempt}）` : ""}`);
    await row.first().click();
    if (await paneReady(P, 15_000)) return;
    // 診斷 dump：分辨 dead-click（無 hydrate）vs chat pane 未開 vs composer 條件未達
    const dbg = await P.evaluate(() => ({
      url: location.href,
      textareas: document.querySelectorAll("textarea").length,
      buttons: document.querySelectorAll("button").length,
      title: document.title,
    })).catch(() => null) as { url: string; textareas: number; buttons: number; title: string } | null;
    diagLog.push(`[${what}] openConv attempt=${attempt} state=${JSON.stringify(dbg)}`);
    console.log(`openConv: pane 未現（${what} attempt=${attempt}）→ 整頁 reload 重試`);
    await P.goto(`${base}/inbox`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(4000); // dev loadManifest race 降溫間隔（重編寫 manifest 嘅窗口）
  }
  await P.screenshot({ path: `/tmp/e2e-mcui-${what}-fail.png` }).catch(() => {});
  fail(`開對話後 chat pane 無出現（${what}）`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── scenarios ────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  if (scenario === "release") {
    const { B, P } = await launchWithCookie(cookieFile);
    try {
      const row = await waitRow(P, nameRelease, "release");
      await openConv(P, nameRelease, "release");
      void row;
      // header〔放手〕掣（現任負責人 = 自己）
      const btn = P.locator('[data-e2e="release-btn"]');
      await btn.waitFor({ state: "visible", timeout: 20_000 });
      await btn.click();
      // 兩段確認：同一掣變「再撳一次放手？」
      await P.locator('[data-e2e="release-btn"]:has-text("再撳一次放手")').waitFor({ state: "visible", timeout: 5_000 });
      await P.locator('[data-e2e="release-btn"]').click();
      // 釋放後：負責人 chip 消失 + toast「已放手」
      await waitToast(P, "已放手", "release toast");
      await P.locator("text=負責人：").first().waitFor({ state: "hidden", timeout: 15_000 });
      console.log("MCUI-OK release");
    } finally {
      await P.close();
      await B.close();
    }
  } else if (scenario === "menu") {
    const { B, P } = await launchWithCookie(cookieFile);
    try {
      const row = await waitRow(P, nameMenu, "menu");
      await openConv(P, nameMenu, "menu");
      void row;
      // 負責員工 select 掣（未分配狀態）
      const sel = P.locator('[data-e2e="assign-trigger"]');
      await sel.waitFor({ state: "visible", timeout: 20_000 });
      await sel.click();
      const menu = P.locator('[data-e2e="assign-menu"]');
      // L1：「其他分店…」
      const other = menu.getByText("其他分店…", { exact: true });
      await other.waitFor({ state: "visible", timeout: 5_000 });
      await other.click();
      // L2：分店列表 → 撳 WTC
      const wtcRow = menu.locator("button", { hasText: wtcCode });
      await wtcRow.first().waitFor({ state: "visible", timeout: 5_000 });
      await wtcRow.first().click();
      // L3：該店 staff → 撳 staff-wtc
      const staffRow = menu.locator("button", { hasText: staffWtcName });
      await staffRow.first().waitFor({ state: "visible", timeout: 5_000 });
      await staffRow.first().click();
      // 跨店 confirm 文案（MD A.6.2 指定字）
      const confirmBox = P.locator('[data-e2e="assign-cross-confirm"]');
      await confirmBox.getByText("對方將可查閱呢個對話嘅完整記錄", { exact: true }).waitFor({ state: "visible", timeout: 5_000 });
      await confirmBox.getByRole("button", { name: "確認指派", exact: true }).click();
      // 指派後：select 掣顯示 staff-wtc 名
      await P.getByRole("button", { name: new RegExp(staffWtcName) }).first().waitFor({ state: "visible", timeout: 15_000 });
      console.log("MCUI-OK menu");
    } finally {
      await P.close();
      await B.close();
    }
  } else if (scenario === "send423") {
    if (!staffTkwId) fail("send423 需要 --staff-tkw-id");
    if (!cookie2File) fail("send423 需要 --cookie2（staff-tkw cookie jar）");
    const tkwSession = readSession(cookie2File);
    const { B, P } = await launchWithCookie(cookieFile);
    try {
      const row = await waitRow(P, name423, "send423");
      await openConv(P, name423, "send423");
      void row;
      // 未指派 + 窗口內 → composer 解鎖（aria-label=發送）
      const sendBtn = P.getByRole("button", { name: "發送", exact: true });
      await sendBtn.waitFor({ state: "visible", timeout: 20_000 });
      const DRAFT = "e2e mc 423 draft 保留測試 abc123";
      await P.fill("textarea", DRAFT);
      // ★ 決定性 423：route-hold 攔截 send request —
      //   ① click 發送（request 被 hold 喺 browser network 層）
      //   ② takeover commit（server 側 assignee = staff-tkw）
      //   ③ 先放 request 到 server → assignee 已係 staff-tkw → 必 423（唔再靠 click 同 socket 鬥快）
      let sendCaptured = false;
      let releaseSend: () => void = () => {};
      const sendHeld = new Promise<void>((res) => (releaseSend = res));
      await P.route("**/api/messages/send*", (async (route: { continue: () => Promise<void> }) => {
        sendCaptured = true;
        await sendHeld;
        await route.continue();
      }) as never);
      try {
        await sendBtn.click();
        const c0 = Date.now();
        while (!sendCaptured && Date.now() - c0 < 5000) await sleep(200);
        if (!sendCaptured) fail("send request 未被 route 捕獲（click 未觸發 fetch？）");
        const r = await fetch(`${base}/api/conversations/${conv423}/assign`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: `wa_inbox_session=${tkwSession}` },
          body: JSON.stringify({ toStaffId: staffTkwId, assignVersion: 0 }),
        });
        if (r.status !== 200) fail(`並行接手失敗（status=${r.status}）`);
        await sleep(500); // 等 socket 事件到 client（composer 會鎖 — 正常行為）
        releaseSend(); // ③ 放行 send → server 見 assignee=staff-tkw → 423
        await sleep(2000); // 等 423 回應處理 + toast + header 更新
      } finally {
        releaseSend(); // 保險：任何失敗路徑都唔好留 hanging request
        await P.unroute("**/api/messages/send*").catch(() => {});
      }
      // ① composer 文字唔清走（textarea value）
      const iv = (await P.evaluate((s: string) => (document.querySelector(s) as HTMLTextAreaElement)?.value ?? "", "textarea")) as string;
      if (iv !== DRAFT) fail(`423 後 composer 文字被清走（value="${iv}"）`);
      // ② toast「{name} 已接手呢個對話」
      await waitToast(P, "已接手呢個對話", "423 toast");
      // ③ header 負責人名即時更新（此對話由 {name} 負責 banner）
      await P.getByText(new RegExp(`此對話由 ${staffTkwName} 負責`)).first().waitFor({ state: "visible", timeout: 15_000 });
      console.log("MCUI-OK send423");
    } finally {
      await P.close();
      await B.close();
    }
  } else if (scenario === "badges") {
    const { B, P } = await launchWithCookie(cookieFile);
    try {
      // ① 跨店線店名 badge：WTC 線（assignee=自己，OR path）有「跨店線」title badge
      const wtcRow = await waitRow(P, nameWtc, "badges-wtc");
      const badge = wtcRow.first().locator("span", {});
      await badge.first().waitFor({ state: "visible", timeout: 5_000 });
      const badgeTitles: string[] = await wtcRow.first().locator("span[title^='跨店線']").allTextContents();
      if (badgeTitles.length === 0) fail("WTC 線冇店名 badge（跨店線 title span 缺失）");
      // 本店線（TKW follower）唔應該有跨店 badge
      const fRow = await waitRow(P, nameFollower, "badges-follower");
      const fBadges = await fRow.first().locator("span[title^='跨店線']").count();
      if (fBadges > 0) fail("本店線誤顯跨店 badge");
      // ② 待跟進 badge：未指派 + 最後一條係 IN → 有
      const followBadge = fRow.first().getByText("待跟進", { exact: true });
      await followBadge.waitFor({ state: "visible", timeout: 10_000 });
      // 覆咗（OUT）→ 待跟進消失
      await openConv(P, nameFollower, "badges-f-open");
      const sendBtn = P.getByRole("button", { name: "發送", exact: true });
      await sendBtn.waitFor({ state: "visible", timeout: 20_000 });
      await P.fill("textarea", "e2e mc f reply 跟進測試");
      await sendBtn.click();
      // 等 OUT 落（訊息气泡出現 — 列表同一 state 會即時重算 badge，唔使返回列表）
      const t0 = Date.now();
      for (;;) {
        const msgs = await P.locator("div", { hasText: "e2e mc f reply 跟進測試" }).count();
        if (msgs > 0) break;
        if (Date.now() - t0 > 30_000) fail("等回覆訊息出現逾時");
        await sleep(500);
      }
      await sleep(1500); // list row re-render（socket message:new OUT → lastMessageAt 推進）
      const fBadges2 = await fRow.first().getByText("待跟進", { exact: true }).count();
      if (fBadges2 > 0) fail("覆咗之後待跟進 badge 未消失");
      console.log("MCUI-OK badges");
    } finally {
      await P.close();
      await B.close();
    }
  } else {
    fail(`未知 scenario: ${scenario}`);
  }
}

main()
  .then(() => {
    if (failReason) console.log(`MCUI-FAIL ${scenario}: ${failReason}`);
    process.exit(failReason ? 1 : 0);
  })
  .catch((e) => {
    const r = failReason ?? (e as Error).message ?? String(e);
    console.log(`MCUI-FAIL ${scenario}: ${r}`);
    process.exit(1);
  });

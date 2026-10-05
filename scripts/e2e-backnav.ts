/**
 * e2e-backnav — cwi-setnav NAV-06：手機系統返回鍵（WhatsApp 式圖層堆疊）7 項回歸
 *
 * 工單 §2.6 測試表（Playwright 手機 viewport 390×844，除 BN-07 桌面 1366）：
 *   BN-01 列表 → 撳對話 → goBack → 見列表、URL = /inbox、對話 pane 冇 render
 *   BN-02 對話 → 開聯絡人詳情 → goBack → sheet 閂、對話仍然開住
 *   BN-03 對話 → app「<」→ 歷史同步（history.length 斷言）→ goBack 唔會再退一層
 *   BN-04 冷開 /inbox?conv=X → goBack → 見列表（唔係 about:blank／登入頁）
 *   BN-05 收件箱 → 預約 → 時間表 → goBack → 返收件箱（NAV-04 tab 協作）
 *   BN-06 開 A → 收 A → 開 B → goBack → 返列表（唔係返 A — 換對話唔疊歷史）
 *   BN-07 桌面 1366 → 撳對話 → 冇新增歷史（history.length 不變）
 *
 * 前提：BASE server 起緊（mock-e2e 環境 — WORKFORCE_MOCK=1）+ 15432 DB。
 * fixture：2 合成病人（E2E-BN 前綴）+ 1 ADMIN（ALL scope）— 全程 try/finally 清。
 *
 * 用法（repo root）：pnpm tsx scripts/e2e-backnav.ts
 * 輸出：BN-OK / BN-FAIL: <n>（exit 0/1）
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import path from "node:path";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";
import { chromium, chromiumPath } from "./_pw";

const require = createRequire(path.join(process.cwd(), "package.json"));
const argon2 = require("argon2");

try {
  process.loadEnvFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", ".env"));
} catch {
  /* 靠 process env */
}

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const PASS = "BNE2E-Pass-3100!";
const U_BN = "e2ebnadm0000000000000001";
const E_BN = "e2ebnadmin@e2e.local";
const CONV_A = "e2ebnconvaaaaaaaaaaaaaaa1";
const CONV_B = "e2ebnconvaaaaaaaaaaaaaaa2";
const CT_A = "e2ebncontactaaaaaaaaaaa1";
const CT_B = "e2ebncontactaaaaaaaaaaa2";
const NAME_A = "E2E BN 甲病人";
const NAME_B = "E2E BN 乙病人";

let FAILS = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    FAILS++;
    console.log(`  ❌ ${name}${detail !== undefined ? "（" + JSON.stringify(detail).slice(0, 300) + "）" : ""}`);
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const prisma = new PrismaClient();

interface PageLike {
  goto: (url: string, o: Record<string, unknown>) => Promise<unknown>;
  locator: (sel: string, o?: Record<string, unknown>) => any;
  getByLabel: (label: string) => any;
  waitForURL: (re: RegExp | string, o: Record<string, unknown>) => Promise<unknown>;
  waitForSelector: (sel: string, o: Record<string, unknown>) => Promise<unknown>;
  goBack: (o?: Record<string, unknown>) => Promise<unknown>;
  mouse: { move: (x: number, y: number) => Promise<unknown>; wheel: (dx: number, dy: number) => Promise<unknown> };
  evaluate: <T>(fn: string | ((...a: unknown[]) => unknown), ...args: unknown[]) => Promise<T>;
  waitForFunction: (
    fn: string | ((...a: unknown[]) => unknown),
    arg?: unknown,
    o?: Record<string, unknown>
  ) => Promise<unknown>;
  close: () => Promise<void>;
}
interface CtxLike {
  newPage: () => Promise<PageLike>;
  addCookies: (c: Array<Record<string, unknown>>) => Promise<void>;
  addInitScript: (fn: string) => Promise<void>;
  close: () => Promise<void>;
}
type Browser = { newContext: (o: Record<string, unknown>) => Promise<CtxLike>; close: () => Promise<void> };

async function main(): Promise<void> {
  const exe = chromiumPath();
  const B = (await (chromium as { launch: (o: Record<string, unknown>) => Promise<Browser> }).launch({
    headless: true,
    executablePath: exe,
  })) as unknown as Browser;

  try {
    // ── fixture：2 病人 + 2 對話 + 1 ADMIN ────────────────────────
    // 清理走 waId 範圍（唔係固定 id）— 上次 run 中途死咗留低嘅殘留（任何 id 形態）都得清，
    // 先至 create 唔會 P2002。（2026-10-03 實錚：固定 id 清理漏咗殘留 → create 撞 unique）
    const bnWaIds = ["85289900001", "85289900002"];
    const bnContacts = await prisma.contact.findMany({ where: { waId: { in: bnWaIds } }, select: { id: true } });
    const bnConvIds = await prisma.conversation
      .findMany({ where: { contactId: { in: bnContacts.map((c) => c.id) } }, select: { id: true } })
      .then((r) => r.map((c) => c.id));
    await prisma.message.deleteMany({ where: { conversationId: { in: bnConvIds } } });
    await prisma.conversation.deleteMany({ where: { id: { in: bnConvIds } } });
    await prisma.contact.deleteMany({ where: { id: { in: bnContacts.map((c) => c.id) } } });
    await prisma.staffUser.deleteMany({ where: { id: U_BN } });
    const clinics = await prisma.clinic.findMany({ select: { id: true }, orderBy: { id: "asc" } });
    const clinicId = clinics[0]?.id;
    if (!clinicId) throw new Error("clinic 搵唔齊");
    await prisma.$transaction([
      prisma.contact.create({
        data: { id: CT_A, clinicId, waId: "85289900001", profileName: NAME_A, labels: [] },
      }),
      prisma.contact.create({
        data: { id: CT_B, clinicId, waId: "85289900002", profileName: NAME_B, labels: [] },
      }),
      prisma.conversation.create({
        data: { id: CONV_A, clinicId, contactId: CT_A, status: "OPEN", lastMessageAt: new Date() },
      }),
      prisma.conversation.create({
        // B 故意舊 1h：A 排 B 前面（sort：urgent desc → lastMessageAt desc）— 縮短 waitRow 捲動距離
        data: { id: CONV_B, clinicId, contactId: CT_B, status: "OPEN", lastMessageAt: new Date(Date.now() - 3_600_000) },
      }),
      prisma.message.create({
        data: {
          id: "e2ebnmsgaaaaaaaaaaaaaaa1",
          conversationId: CONV_A,
          waMessageId: "e2ebnwaaaaaaaaaaaaaaa1",
          direction: "IN",
          channel: "API",
          type: "text",
          body: "BN e2e 甲",
          status: "RECEIVED",
          waTimestamp: new Date(),
          createdAt: new Date(),
        },
      }),
      prisma.message.create({
        data: {
          id: "e2ebnmsgaaaaaaaaaaaaaaa2",
          conversationId: CONV_B,
          waMessageId: "e2ebnwaaaaaaaaaaaaaaa2",
          direction: "IN",
          channel: "API",
          type: "text",
          body: "BN e2e 乙",
          status: "RECEIVED",
          waTimestamp: new Date(),
          createdAt: new Date(),
        },
      }),
      prisma.staffUser.create({
        data: {
          id: U_BN,
          email: E_BN,
          name: "E2E BN Admin",
          passwordHash: await argon2.hash(PASS),
          role: "ADMIN",
          active: true,
          scopeType: "ALL" as never,
        },
      }),
    ]);

    // ── login（Origin 必帶 = middleware originOk 同一口徑 — mock-e2e req() helper 對 POST 補 Origin: $BASE）────
    const loginRes = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE },
      body: JSON.stringify({ email: E_BN, password: PASS }),
    });
    if (loginRes.status !== 200) throw new Error(`login → ${loginRes.status}`);
    const m = (loginRes.headers.get("set-cookie") ?? "").match(/wa_inbox_session=([^;]+)/);
    if (!m) throw new Error("login 冇 cookie");
    const cookie = m[1];

    /** BN_DIAG 用：idempotent history patch（addInitScript 喺呢部機唔靠得住 — 改用 post-load 輪詢注入） */
    const DIAG_PATCH_JS =
      "(() => {\n" +
      "  if (window.__patched) return; window.__patched = true;\n" +
      "  window.__docId = window.__docId || Math.random().toString(36).slice(2, 8);\n" +
      "  window.__histLog = window.__histLog || [];\n" +
      "  window.__histLog.push('DOC:' + window.__docId + ' ' + location.pathname + location.search + ' state=' + (window.history.state ? Object.keys(window.history.state).join(',') : 'null'));\n" +
      "  const log = (m) => { window.__histLog.push(m + ' len=' + window.history.length + ' ' + location.pathname + location.search + ' wa=' + ((window.history.state || {}).waLayer || '-') + ' NA=' + ((window.history.state || {}).__NA ? 1 : 0) + ' doc=' + window.__docId); };\n" +
      "  if (!window.__origPush) {\n" +
      "    window.__origPush = window.history.pushState.bind(window.history);\n" +
      "    window.__origReplace = window.history.replaceState.bind(window.history);\n" +
      "    window.history.pushState = function (s, t, u) { log('PUSH'); return window.__origPush(s, t, u); };\n" +
      "    window.history.replaceState = function (s, t, u) { log('REPLACE'); return window.__origReplace(s, t, u); };\n" +
      "    window.addEventListener('popstate', () => log('POPSTATE'));\n" +
      "    window.addEventListener('pagehide', () => log('PAGEHIDE'));\n" +
      "    window.addEventListener('load', () => { const nt = (performance.getEntriesByType('navigation')[0] || {}).type || '?'; log('LOAD navType=' + nt + ' doc=' + window.__docId); });\n" +
      "    window.addEventListener('error', (e) => { window.__histLog.push('PAGEERROR: ' + (e.message || 'unknown') + ' @' + (e.filename || '') + ':' + (e.lineno || 0)); });\n" +
      "  }\n" +
      "})()";

    /** BN_DIAG：post-load 輪詢注入 history patch（50ms — 遠快過 hydration 1-3s）+ 每次新 document 重試 */
    const attachDiag = (P: PageLike): (() => void) => {
      let timer: ReturnType<typeof setInterval> | null = null;
      const shot = () => {
        void P.evaluate(DIAG_PATCH_JS).catch(() => {});
      };
      timer = setInterval(shot, 50);
      const onNav = (f: unknown) => {
        if (f === (P as { mainFrame?: unknown }).mainFrame) shot();
      };
      (P as unknown as { on: (ev: string, fn: (f: unknown) => void) => void }).on("framenavigated", onNav);
      return () => {
        if (timer) clearInterval(timer);
        (P as unknown as { removeListener: (ev: string, fn: (f: unknown) => void) => void }).removeListener("framenavigated", onNav);
      };
    };

    const mkMobileCtx = async (): Promise<CtxLike> => {
      const C = await B.newContext({ viewport: { width: 390, height: 844 } });
      if (process.env.BN_DIAG === "1") {
        // 診斷：完整 history patch（push/replace/popstate/pagehide/load log + doc id）— 只 BN_DIAG=1 時開
        await C.addInitScript(
          "(() => {\n  window.__docId = Math.random().toString(36).slice(2, 8);\n  window.__histLog = window.__histLog || [];\n  window.__histLog.push('DOC:' + window.__docId + ' ' + location.pathname + location.search + ' state=' + (window.history.state ? Object.keys(window.history.state).join(',') : 'null'));\n  const log = (m) => { window.__histLog.push(m + ' len=' + window.history.length + ' ' + location.pathname + location.search + ' wa=' + ((window.history.state || {}).waLayer || '-') + ' NA=' + ((window.history.state || {}).__NA ? 1 : 0) + ' doc=' + window.__docId); };\n  const op = window.history.pushState.bind(window.history);\n  window.history.pushState = function (s, t, u) { log('PUSH'); return op(s, t, u); };\n  const or_ = window.history.replaceState.bind(window.history);\n  window.history.replaceState = function (s, t, u) { log('REPLACE'); return or_(s, t, u); };\n  window.addEventListener('popstate', () => log('POPSTATE'));\n  window.addEventListener('pageshow', (e) => log('PAGESHOW persisted=' + e.persisted));\n  window.addEventListener('pagehide', () => log('PAGEHIDE'));\n  window.addEventListener('load', () => { const nt = (performance.getEntriesByType('navigation')[0] || {}).type || '?'; log('LOAD navType=' + nt + ' doc=' + window.__docId); });\n  window.addEventListener('error', (e) => { window.__histLog.push('PAGEERROR: ' + (e.message || 'unknown') + ' @' + (e.filename || '') + ':' + (e.lineno || 0)); });\n})()"
        );
      }
      await C.addCookies([{ name: "wa_inbox_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
      return C;
    };

    const listVisible = (P: PageLike): Promise<boolean> =>
      P.evaluate(() => {
        const el = document.querySelector('[data-e2e="conv-list"]') as HTMLElement | null;
        return !!el && el.offsetParent !== null;
      });
    const chatVisible = (P: PageLike): Promise<boolean> =>
      P.evaluate(() => !!document.querySelector('[aria-label="開啟聯絡人詳情"]'));
    /** ★ S6-7 virtualization 兼容（react-virtuoso）：viewport 外嘅行唔掛 DOM —
     *  用 **mouse wheel**（user 輸入路徑）逐 300px 向前捲（到底返頂循環）直到行入 viewport。
     *  ★ 2026-10-04 gen2：舊版直接賦值 `el.scrollTop = X` 喺 close-conv 重渲染後會被
     *    react-virtuoso 內部狀態蓋返（scrollTop 凍喺舊值、賦值全部無效 — BN-06-B 實錚：
     *    30s 內賦值 0/300/600/900... 讀返永遠 323）；wheel 事件行 virtuoso 原生輸入路徑
     *    （內部狀態跟住走）— 實錚 323→623→923、1s 內搵到 B 行。短列表（max=0）唔使捲。 */
    const waitRow = async (P: PageLike, name: string, what: string, timeoutMs = 60_000): Promise<ReturnType<PageLike["locator"]>> => {
      const t0 = Date.now();
      const loc = P.locator("button", { hasText: name });
      let hovered = false;
      for (;;) {
        if ((await loc.count()) > 0) return loc;
        if (Date.now() - t0 > timeoutMs) throw new Error(`等列表行「${name}」逾時（${what}）`);
        const pos = await P.evaluate(
          () => {
            const el = document.querySelector('[data-e2e="conv-list"][data-virtuoso-scroller]') as HTMLElement | null;
            if (!el) return null;
            return { st: el.scrollTop, max: el.scrollHeight - el.clientHeight };
          }
        )
          .then((r) => r as { st: number; max: number } | null)
          .catch(() => null);
        if (pos && pos.max > 5) {
          if (!hovered) {
            const box = (await (await P.locator('[data-e2e="conv-list"]').boundingBox())) as { x: number; y: number; width: number; height: number } | null;
            if (box) {
              await P.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
              hovered = true;
            }
          }
          const dir = pos.st >= pos.max - 5 ? -1 : 1; // 到底 → 返頂；否則向前
          await P.mouse.wheel(0, dir * 300);
        }
        await new Promise((r) => setTimeout(r, 350));
      }
    };

    // ── BN-01 列表 → 撳對話 → goBack → 見列表、URL = /inbox、對話 pane 冇 render ──
    {
      const C = await mkMobileCtx();
      const P = await C.newPage();
      try {
        await P.goto(`${BASE}/inbox`, { waitUntil: "domcontentloaded", timeout: 120_000 });
        await (await waitRow(P, NAME_A, "BN-01")).click();
        await P.getByLabel("開啟聯絡人詳情").waitFor({ state: "visible", timeout: 30_000 });
        await P.waitForFunction(() => window.history.length >= 3 && (window.history.state || {}).waLayer === 'conv', undefined, {
          timeout: 30_000,
          polling: 100,
        });
        // 等 conv 層 pushState 真完成（len 只增不減 = 真 push）— 注：string 形式 waitForFunction 喺 playwright-core 1.59 會永遠秒中（function 表達式 = truthy）— 必須用真函數形式
        await P.goBack();
        await P.waitForURL(`${BASE}/inbox`, { timeout: 15_000 });
        const ok =
          (await P.evaluate(() => window.location.pathname)) === "/inbox" &&
          (await chatVisible(P)) === false &&
          (await listVisible(P)) === true;
        check(
          "BN-01 列表 → 撳對話 → goBack → 見列表 + URL /inbox + 對話 pane 冇 render",
          ok,
          { path: await P.evaluate(() => window.location.href), chat: await chatVisible(P) }
        );
      } finally {
        await C.close().catch(() => {});
      }
    }

    // ── BN-02 對話 → 開聯絡人詳情 → goBack → sheet 閂、對話仍然開住 ──
    {
      const C = await mkMobileCtx();
      const P = await C.newPage();
      try {
        await P.goto(`${BASE}/inbox`, { waitUntil: "domcontentloaded", timeout: 120_000 });
        await (await waitRow(P, NAME_A, "BN-02")).click();
        await P.getByLabel("開啟聯絡人詳情").waitFor({ state: "visible", timeout: 30_000 });
        await P.getByLabel("開啟聯絡人詳情").click();
        await P.waitForSelector('[role="dialog"][aria-label="聯絡人詳情"]', { timeout: 30_000 });
        await P.waitForFunction(() => window.history.length >= 4 && (window.history.state || {}).waLayer === 'detail', undefined, {
          timeout: 30_000,
          polling: 100,
        });
        await P.goBack();
        // sheet 應該閂走（popstate close）；對話 pane 仍然開住
        let sheetGone = false;
        for (let i = 0; i < 20 && !sheetGone; i++) {
          sheetGone = (await P.evaluate(() => !document.querySelector('[role="dialog"][aria-label="聯絡人詳情"]'))) === true;
          if (!sheetGone) await sleep(300);
        }
        check(
          "BN-02 對話 → 開聯絡人詳情 → goBack → sheet 閂、對話仍然開住",
          sheetGone && (await chatVisible(P)) === true,
          { sheetGone, chat: await chatVisible(P), path: await P.evaluate(() => window.location.href) }
        );
      } finally {
        await C.close().catch(() => {});
      }
    }

    // ── BN-03 對話 → app「<」→ 歷史同步 → goBack 唔會再退一層 ──
    {
      const C = await mkMobileCtx();
      const P = await C.newPage();
      try {
        await P.goto(`${BASE}/inbox`, { waitUntil: "domcontentloaded", timeout: 120_000 });
        await (await waitRow(P, NAME_A, "BN-03")).click();
        await P.getByLabel("開啟聯絡人詳情").waitFor({ state: "visible", timeout: 30_000 });
        await P.waitForFunction(() => window.history.length >= 3 && (window.history.state || {}).waLayer === 'conv', undefined, {
          timeout: 30_000,
          polling: 100,
        });
        // 對話層 push 必須同步 URL（/inbox?conv=<A> = 嗰個 history entry）
        const urlAfterOpen = (await P.evaluate(() => window.location.href)) as string;
        // app「<」= 手機 back 掣（返回列表）
        await P.getByLabel("返回列表").click();
        await P.waitForURL(`${BASE}/inbox`, { timeout: 15_000 });
        const noChatAfterAppBack = (await chatVisible(P)) === false;
        const listAfterAppBack = (await listVisible(P)) === true;
        // goBack 唔應該再退一層（對話層已離開 stack — 去到邊都唔會出現對話 pane）。
        // 註：history.length 唔會因 back() 減少（只係 index 移動）— 不變式係 state/URL 唔係 length。
        await P.goBack({ waitUntil: "load", timeout: 15_000 }).catch(() => null);
        await sleep(500);
        const stillNoChat = (await chatVisible(P)) === false;
        check(
          "BN-03 對話 → app「<」→ 歷史同步（URL /inbox?conv=A → /inbox）+ goBack 唔會再退一層（冇對話 pane）",
          urlAfterOpen.includes(`conv=${CONV_A}`) && noChatAfterAppBack && listAfterAppBack && stillNoChat,
          { urlAfterOpen, noChatAfterAppBack, listAfterAppBack, stillNoChat, path: await P.evaluate(() => window.location.href) }
        );
      } finally {
        await C.close().catch(() => {});
      }
    }

    // ── BN-04 冷開 /inbox?conv=X → goBack → 見列表（唔係 about:blank／登入頁）──
    {
      const C = await mkMobileCtx();
      const P = await C.newPage();
      const detachDiag = process.env.BN_DIAG === "1" ? attachDiag(P) : () => {};
      try {
        await P.goto(`${BASE}/inbox?conv=${CONV_A}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
        // 深連結起手：對話 pane 先開
        await P.getByLabel("開啟聯絡人詳情").waitFor({ state: "visible", timeout: 60_000 });
        // 等 NAV-03 boot effect 完成（replaceState /inbox + push conv 層）— 未 boot 完就 goBack 會落到 about:blank。
        // ★ 2026-10-04 gen2：唔好再用 `P.waitForFunction` 等呢個條件 — playwright-core 1.59.1（本机 headless）
        //   喺初始 navigation 期間會 phantom-pass：第一次 poll 喺 detached 初始 context 執行，
        //   個 context 嘅 history alias 讀到假 len/state → 條件「真」但真 tab 仲係 len=2（未 boot）→
        //   其後 goBack 即時落 about:blank（BN-04 早期失敗真根因；2026-10-04 實錚 4/4 重現：
        //   同頁 20ms 條件 log 全程 len=2、__gateTrue 喺任何 live context 都冇寫入）。
        //   改用主 context 手動輪詢（P.evaluate — 2026-10-04 實測 4/4 可靠）。
        {
          const deadline = Date.now() + 30_000;
          for (;;) {
            const ok = await P.evaluate(
              () => window.history.length >= 3 && (window.history.state || ({} as Record<string, unknown>)).waLayer === "conv"
            ).catch(() => false);
            if (ok) break;
            if (Date.now() > deadline) throw new Error("BN-04：等 NAV-03 boot（len>=3 + waLayer=conv）逾時 30s");
            await sleep(50);
          }
        }
        // 診斷（BN_DIAG）：在真 document（非 about:blank）dump 完整 history 記錄 — about:blank 唔跑 init script
        if (process.env.BN_DIAG === "1") {
          const preHist = await P.evaluate(() => ((window as unknown as { __histLog?: string[] }).__histLog || []).slice(0, 60)).catch(() => null);
          if (Array.isArray(preHist)) console.error("BN04-DIAG pre-goback hist:", JSON.stringify(preHist));
        }
        try {
          await P.goBack();
          await P.waitForURL(`${BASE}/inbox`, { timeout: 15_000 });
        } catch (e) {
          // 診斷：dump 歷史鏈（每次 goBack 一個 entry 嘅 state）— 搵出多咗邊個 entry
          const chain: string[] = [];
          for (let i = 0; i < 4; i++) {
            const d = (await P.evaluate(
              () => `len=${window.history.length} ${location.pathname}${location.search} wa=${(window.history.state || {}).waLayer} n=${(window.history.state || {}).n}`
            )) as string;
            chain.push(d);
            const histRaw = await P.evaluate(() => ((window as unknown as { __histLog?: string[] }).__histLog || []).slice(0, 40)).catch(() => null);
            if (Array.isArray(histRaw) && histRaw.length > 0) console.error("BN04-DIAG hist:", JSON.stringify(histRaw));
            try {
              await P.goBack({ timeout: 5_000 });
            } catch {
              break;
            }
            await sleep(400);
          }
          console.error("BN04-DIAG chain:", JSON.stringify(chain));
          throw e;
        }
        detachDiag();
        const ok =
          (await P.evaluate(() => window.location.pathname)) === "/inbox" &&
          (await chatVisible(P)) === false &&
          (await listVisible(P)) === true;
        check(
          "BN-04 冷開 /inbox?conv=X → goBack → 見列表（唔係 about:blank／登入頁）",
          ok,
          { path: await P.evaluate(() => window.location.href), chat: await chatVisible(P) }
        );
      } finally {
        detachDiag();
        await C.close().catch(() => {});
      }
    }

    // ── BN-05 收件箱 → 預約 → 時間表 → goBack → 返收件箱 ──
    {
      const C = await mkMobileCtx();
      const P = await C.newPage();
      try {
        await P.goto(`${BASE}/inbox`, { waitUntil: "domcontentloaded", timeout: 120_000 });
        await P.waitForSelector('[data-e2e="conv-list"]', { timeout: 60_000 }); // 列表 render 完成（virtualized — 唔靠特定行）
        await P.locator('a[href="/bookings"]').last().click();
        await P.waitForURL(/\/bookings$/, { timeout: 30_000 });
        await P.locator('a[href="/schedule"]').last().click();
        await P.waitForURL(/\/schedule$/, { timeout: 30_000 });
        await P.goBack();
        await P.waitForURL(`${BASE}/inbox`, { timeout: 15_000 });
        const ok = (await P.evaluate(() => window.location.pathname)) === "/inbox";
        check("BN-05 收件箱 → 預約 → 時間表 → goBack → 返收件箱", ok, {
          path: await P.evaluate(() => window.location.href),
        });
      } finally {
        await C.close().catch(() => {});
      }
    }

    // ── BN-06 開 A → 收 A → 開 B → goBack → 返列表（唔係返 A；length = 2）──
    // 工單原句「列表撳 A → 撳 B」：手機開咗對話後列表係 display:none（UI 現實），
    // 所以以「開 A → 用 app「<」收 A → 開 B」走同一不變式 — B 之上唔可以有 A 殘留層。
    {
      const C = await mkMobileCtx();
      const P = await C.newPage();
      try {
        await P.goto(`${BASE}/inbox`, { waitUntil: "domcontentloaded", timeout: 120_000 });
        await (await waitRow(P, NAME_A, "BN-06-A")).click();
        await P.getByLabel("開啟聯絡人詳情").waitFor({ state: "visible", timeout: 30_000 });
        await P.waitForFunction(() => window.history.length >= 3 && (window.history.state || {}).waLayer === 'conv', undefined, {
          timeout: 30_000,
          polling: 100,
        });
        await P.getByLabel("返回列表").click();
        await P.waitForURL(`${BASE}/inbox`, { timeout: 15_000 });
        await sleep(300); // 等列表 render 返
        await (await waitRow(P, NAME_B, "BN-06-B", 30_000)).click();
        await P.getByLabel("開啟聯絡人詳情").waitFor({ state: "visible", timeout: 30_000 });
        // ★ 2026-10-04 gen2：舊條件 `history.length >= 4` 係錯誤假設 — **back() 之後再 push 會截斷
        //   forward stack，length 唔會再成長**（控制實驗實錚：push,back,replace,push → len 3 不變；
        //   push,replace,push 無 back → len 4）。實錚歷史 = [blank, /inbox, conv=B]（A entry 被截斷）—
        //   功能不變式（goBack 落列表唔係 A）由 goBack 後斷言保護。呢度只等 URL 到達 ?conv=B。
        const convBQ = `conv=${encodeURIComponent(CONV_B)}`;
        await P.waitForFunction(
          (q) => location.search.includes(String(q)),
          convBQ,
          { timeout: 30_000, polling: 100 }
        );
        const urlAfterOpenB = (await P.evaluate(() => window.location.href)) as string;
        // goBack：B 層 pop 咗；落地 URL 會係 A 收埋時嗰個 stale entry（/inbox?conv=A 殘 query）—
        // 但 stack 冇 A 層 + 重選 effect 係 mount-only（inbox-client deps []）→ A 唔會復活，只係見列表。
        await P.goBack();
        await P.waitForURL(/\/inbox/, { timeout: 15_000 });
        const ok =
          urlAfterOpenB.includes(`conv=${CONV_B}`) &&
          (await chatVisible(P)) === false &&
          (await listVisible(P)) === true;
        check(
          "BN-06 開 A → 收 A → 開 B → goBack → 返列表（唔係返 A；對話 pane 唔復活）",
          ok,
          { urlAfterOpenB, path: await P.evaluate(() => window.location.href) }
        );
      } finally {
        await C.close().catch(() => {});
      }
    }

    // ── BN-07 桌面 1366 → 撳對話 → 冇新增歷史 ──
    {
      const C = await B.newContext({ viewport: { width: 1366, height: 768 } });
      await C.addCookies([{ name: "wa_inbox_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
      const P = await C.newPage();
      try {
        await P.goto(`${BASE}/inbox`, { waitUntil: "domcontentloaded", timeout: 120_000 });
        const rowA = await waitRow(P, NAME_A, "BN-07");
        const len0 = (await P.evaluate(() => window.history.length)) as number;
        await rowA.click();
        await P.getByLabel("開啟聯絡人詳情").waitFor({ state: "visible", timeout: 30_000 });
        const len1 = (await P.evaluate(() => window.history.length)) as number;
        check("BN-07 桌面 1366 → 撳對話 → 冇新增歷史（history.length 不變）", len1 === len0, { len0, len1 });
      } finally {
        await C.close().catch(() => {});
      }
    }
  } finally {
    // ── cleanup ─────────────────────────────────────────────────
    try {
      await prisma.message.deleteMany({ where: { conversationId: { in: [CONV_A, CONV_B] } } });
      await prisma.conversation.deleteMany({ where: { id: { in: [CONV_A, CONV_B] } } });
      await prisma.contact.deleteMany({ where: { id: { in: [CT_A, CT_B] } } });
      await prisma.staffUser.deleteMany({ where: { id: U_BN } });
    } catch {
      /* cleanup best-effort */
    }
    await B.close().catch(() => {});
    await prisma.$disconnect();
  }

  if (FAILS === 0) {
    console.log("BN-OK");
    process.exit(0);
  }
  console.log(`BN-FAIL: ${FAILS}`);
  process.exit(1);
}

main().catch((e) => {
  console.error("BN-ERROR:", e);
  process.exit(2);
});

/**
 * e2e-composer-media — cwi-final S6-9④ T695 瀏覽器級斷言（composer 附件 UI）。
 *
 * 前置：--conv = 窗口內對話（raw INSERT、TKW 店、staff-tkw 可覆）；
 *   --cookie = STAFF(TKW) cookie；--cookie-sup = SUPERVISOR cookie；--jpg / --big = 測試檔路徑。
 * 斷言（spec §S6-9④ T695）：
 *   A. 揀 JPG → 預覽條出現（檔名 + 大小）→ 打 caption → 發送 →
 *      /api/messages/media request 恰 1 次 + OUT(type=image, body=caption) 入庫 +
 *      DOM 氣泡 img（/api/media/）+ 預覽條清走 + composer 清
 *   B. 揀 8MB 檔（>5MB 圖片上限）→ 前端即時提示（media-pick-error）、無預覽條、request 計數唔變（零上載）
 *   C. SUPERVISOR 視角 → 睇唔到 📎 掣（canAttach=false：read-only）
 *
 * 用法（repo root，dev server 3100 已起 + cookie 有效）：
 *   pnpm e2e:composer-media --base http://127.0.0.1:3100 --cookie /tmp/e2e-cookie-tkw.txt \
 *     --cookie-sup /tmp/e2e-cookie-t698-sup.txt --conv <id> --jpg /tmp/a.jpg --big /tmp/b.png
 *
 * 斷言輸出（mock-e2e.sh grep 用）：
 *   COMPOSER-MEDIA-OK / COMPOSER-MEDIA-FAIL: <reason>
 */
import "./e2e-origin-shim";
import { readFileSync } from "node:fs";
import { chromium, chromiumPath } from "./_pw";

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : "";
  if (!v) {
    console.error(`missing ${name}`);
    process.exit(2);
  }
  return v;
}

interface PageLike {
  goto: (url: string, o?: Record<string, unknown>) => Promise<void>;
  waitForTimeout: (ms: number) => Promise<void>;
  locator: (sel: string) => LocatorLike;
  keyboard: {
    type: (s: string, o?: Record<string, unknown>) => Promise<void>;
    press: (k: string) => Promise<void>;
    down: (k: string) => Promise<void>;
    up: (k: string) => Promise<void>;
  };
  evaluate: <T, A extends unknown[]>(fn: (...a: A) => T, ...args: A) => Promise<T>;
  on: (ev: "request", cb: (req: { url: () => string; method: () => string }) => void) => void;
  close: () => Promise<void>;
}
interface LocatorLike {
  count: () => Promise<number>;
  first: () => LocatorLike;
  click: (o?: Record<string, unknown>) => Promise<void>;
  focus: () => Promise<void>;
  setInputFiles: (p: string) => Promise<void>;
  waitFor: (o?: Record<string, unknown>) => Promise<unknown>;
}

const CAPTION = "e2e t695 media caption";

async function main(): Promise<void> {
  const base = arg("--base").replace(/\/$/, "");
  const cookieFile = arg("--cookie");
  const supCookieFile = arg("--cookie-sup");
  const conv = arg("--conv");
  const jpg = arg("--jpg");
  const big = arg("--big");

  const readSession = (file: string): string => {
    const jar = readFileSync(file, "utf8");
    const line = jar.split("\n").find((l) => l.includes("wa_inbox_session"));
    const v = (line ?? "").trim().split(/\s+/).pop() ?? "";
    if (!v) throw new Error(`cookie 檔 ${file} 搵唔到 wa_inbox_session`);
    return v;
  };

  const browser = (await chromium.launch({ headless: true, executablePath: chromiumPath() })) as unknown as {
    newContext: (o: Record<string, unknown>) => Promise<{
      addCookies: (c: unknown[]) => Promise<void>;
      newPage: () => Promise<PageLike>;
      close: () => Promise<void>;
    }>;
    close: () => Promise<void>;
  };

  // OUT(API, type=image, body=CAPTION) 訊息快照（DB 側驗證）
  const outSnap = async (P: PageLike): Promise<number> =>
    P.evaluate(async (p: { cid: string; cap: string }) => {
      const r = await fetch(`/api/conversations/${p.cid}/messages`, { credentials: "include" });
      if (!r.ok) throw new Error(`messages fetch http-${r.status}`);
      const j = (await r.json()) as { messages: { direction: string; channel: string; type: string; body: string | null }[] };
      // ★ cid/cap 經單一 object arg 傳入 — playwright-core evaluate 只收 1 個 arg（第 2 跑實錘
      //   "Too many arguments" — 同 e2e-composer-ui.ts 單 arg 口徑）；喺 page context 執行，module-level 常數唔存在
      return j.messages.filter((m) => m.direction === "OUT" && m.channel === "API" && m.type === "image" && m.body === p.cap).length;
    }, { cid: conv, cap: CAPTION });

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: "wa_inbox_session", value: readSession(cookieFile), domain: "127.0.0.1", path: "/" }]);
  const P = await ctx.newPage();
  try {
    // ── 網絡觀察：/api/messages/media request 計數（B 段「零 request」斷言用）──
    const mediaReqs: string[] = [];
    const reqCount = (): number => mediaReqs.length; // helper — 避開 TS length narrowing（closure push 唔被 CFA 見）
    P.on("request", (r) => {
      const u = r.url();
      if (u.includes("/api/messages/media")) mediaReqs.push(`${r.method()} ${u}`);
    });

    // ── 準備：開對話（dev on-demand compile — 長 wait 兜暖機）──
    await P.goto(`${base}/inbox`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await P.waitForTimeout(4000);
    await P.goto(`${base}/inbox?conv=${conv}`, { waitUntil: "domcontentloaded" });
    const composer = P.locator("textarea[data-testid='c5-composer']");
    await composer.first().waitFor({ timeout: 150000 });
    await P.waitForTimeout(3000); // hydration 兜底（fill/interaction 前 — cwm 教訓）

    // ══ A. JPG → 預覽條 → caption → 發送 ══
    const attachBtn = P.locator("button[data-e2e='media-attach-btn']");
    if ((await attachBtn.count()) !== 1) throw new Error(`📎 掣數目唔對（=${await attachBtn.count()}）`);
    await P.locator("input[data-e2e='media-file-input']").first().setInputFiles(jpg);
    const preview = P.locator("[data-e2e='media-preview']");
    await preview.first().waitFor({ timeout: 10000 });
    const pvName = await P.evaluate(() => document.querySelector<HTMLElement>("[data-e2e='media-preview-name']")?.textContent ?? "");
    if (!pvName.includes("t695")) throw new Error(`預覽條檔名唔對（=${JSON.stringify(pvName)}）`);
    if (reqCount() !== 0) throw new Error(`揀檔即發咗 request（=${reqCount()}）— 揀檔唔應該上載`);

    await composer.first().focus();
    await P.keyboard.type(CAPTION);
    await P.locator("button[data-testid='c5-send-btn']").first().click();

    let sent = false;
    for (let i = 0; i < 30; i++) {
      await P.waitForTimeout(1000);
      if ((await outSnap(P)) >= 1) {
        sent = true;
        break;
      }
    }
    if (!sent) throw new Error("發送後 30s 無 OUT(type=image, body=caption) 入庫");
    if (reqCount() !== 1) throw new Error(`/api/messages/media request 計數=${reqCount()}（期望恰 1）`);

    // 氣泡 img（server mediaUrl — 2xx 後 blob objectURL 已換）
    let domImg = false;
    for (let i = 0; i < 15; i++) {
      await P.waitForTimeout(1000);
      domImg = await P.evaluate(() => Array.from(document.querySelectorAll("img")).some((im) => im.getAttribute("src")?.startsWith("/api/media/")));
      if (domImg) break;
    }
    if (!domImg) throw new Error("15s 內 DOM 無 /api/media/ img（氣泡未顯示圖片？）");
    if ((await preview.count()) !== 0) throw new Error("發送後預覽條未清");
    const cleared = await P.evaluate(() => document.querySelector<HTMLTextAreaElement>("textarea[data-testid='c5-composer']")?.value ?? "<missing>");
    if (cleared !== "") throw new Error(`發送後 composer 未清（=${JSON.stringify(cleared)}）`);

    // ══ B. 8MB 檔 → 前端即時提示、零 request ══
    const before = reqCount();
    await P.locator("input[data-e2e='media-file-input']").first().setInputFiles(big);
    const errBar = P.locator("[data-e2e='media-pick-error']");
    await errBar.first().waitFor({ timeout: 10000 });
    const errText = await P.evaluate(() => document.querySelector<HTMLElement>("[data-e2e='media-pick-error']")?.textContent ?? "");
    if (!/5\s*MB/.test(errText)) throw new Error(`8MB 檔提示文案唔對（=${JSON.stringify(errText)}）`);
    if ((await preview.count()) !== 0) throw new Error("8MB 檔竟然出咗預覽條（應該前端擋住）");
    if (reqCount() !== before) throw new Error(`8MB 檔發出咗 request（計數 ${before} → ${reqCount()}）— 前端應該即時擋`);

    // ══ C. SUPERVISOR 睇唔到 📎 ══
    const supCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await supCtx.addCookies([{ name: "wa_inbox_session", value: readSession(supCookieFile), domain: "127.0.0.1", path: "/" }]);
    const SP = await supCtx.newPage();
    try {
      await SP.goto(`${base}/inbox?conv=${conv}`, { waitUntil: "domcontentloaded", timeout: 120000 });
      await SP.locator("textarea[data-testid='c5-composer'], [data-e2e='readonly-notice'], [data-e2e='window-closed']").first().waitFor({ timeout: 150000 }).catch(() => undefined);
      await SP.waitForTimeout(3000);
      const supAttach = await SP.locator("button[data-e2e='media-attach-btn']").count();
      if (supAttach !== 0) throw new Error(`SUPERVISOR 竟然睇到 📎（count=${supAttach}）— read-only 應該唔顯示`);
    } finally {
      await SP.close().catch(() => undefined);
      await supCtx.close().catch(() => undefined);
    }

    console.log("COMPOSER-MEDIA-OK");
  } catch (e) {
    console.log(`COMPOSER-MEDIA-FAIL: ${String(e).slice(0, 160)}`);
    process.exitCode = 1;
  } finally {
    await P.close().catch(() => undefined);
    await ctx.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

void main();

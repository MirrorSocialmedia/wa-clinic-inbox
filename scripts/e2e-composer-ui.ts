/**
 * e2e-composer-ui — cwi-final S6-9 T697 瀏覽器級斷言（IME guard + enterSends 偏好）。
 *
 * 前置：--conv = 窗口內對話（mock-inbound 剛注入、TKW 店、staff-tkw 可覆）。
 * 斷言（spec §S6-9 ②/③，T697）：
 *   A. IME：compositionstart 後（isComposing=true）Enter → 冇發送（composer 文字原封）
 *   B. enterSends=true（預設）：真 Enter → 發送（OUT 出現、composer 清）
 *   C. toggle enterSends=false：placeholder 改；Enter = 換行（唔發）；Ctrl/⌘+Enter = 發送
 *   D. 持久化：reload 後 SSR 注入 uiPrefs=false → placeholder 仍係換行模式（PATCH 已落庫）
 *   收尾：toggle 返 Enter 發送（還原預設）
 *
 * 用法（repo root，dev server 3100 已起 + cookie 有效）：
 *   pnpm e2e:composer-ui --base http://127.0.0.1:3100 --cookie /tmp/e2e-cookie-tkw.txt --conv <conversationId>
 *
 * 斷言輸出（mock-e2e.sh grep 用）：
 *   COMPOSER-UI-OK / COMPOSER-UI-FAIL: <reason>
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
  getByText: (t: string | RegExp, o?: Record<string, unknown>) => LocatorLike;
  getByRole: (role: string, o?: Record<string, unknown>) => LocatorLike;
  locator: (sel: string) => LocatorLike;
  keyboard: {
    type: (s: string, o?: Record<string, unknown>) => Promise<void>;
    press: (k: string) => Promise<void>;
    down: (k: string) => Promise<void>;
    up: (k: string) => Promise<void>;
  };
  evaluate: <T, A extends unknown[]>(fn: (...a: A) => T, ...args: A) => Promise<T>;
  close: () => Promise<void>;
}
interface LocatorLike {
  count: () => Promise<number>;
  first: () => LocatorLike;
  click: (o?: Record<string, unknown>) => Promise<void>;
  focus: () => Promise<void>;
  waitFor: (o?: Record<string, unknown>) => Promise<unknown>;
}

const PLACEHOLDER_SEND = "輸入訊息…（Enter 發送，Shift+Enter 換行）";
const PLACEHOLDER_NEWLINE = "輸入訊息…（Enter 換行，Ctrl/⌘+Enter 發送）";

async function main(): Promise<void> {
  const base = arg("--base").replace(/\/$/, "");
  const cookieFile = arg("--cookie");
  const conv = arg("--conv");

  const jar = readFileSync(cookieFile, "utf8");
  const line = jar.split("\n").find((l) => l.includes("wa_inbox_session"));
  const sessionValue = (line ?? "").trim().split(/\s+/).pop() ?? "";
  if (!sessionValue) throw new Error("cookie 檔搵唔到 wa_inbox_session");

  const browser = (await chromium.launch({ headless: true, executablePath: chromiumPath() })) as unknown as {
    newContext: (o: Record<string, unknown>) => Promise<{
      addCookies: (c: unknown[]) => Promise<void>;
      newPage: () => Promise<PageLike>;
      close: () => Promise<void>;
    }>;
    close: () => Promise<void>;
  };
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: "wa_inbox_session", value: sessionValue, domain: "127.0.0.1", path: "/" }]);
  const P = await ctx.newPage();

  /** OUT(API) 訊息快照：{ hello, two, n }（hello=hello-ime / two=line1\nline2 / n=總數） */
  const outSnapshot = async (): Promise<{ n: number; hello: number; two: number }> =>
    P.evaluate(async (cid: string) => {
      const r = await fetch(`/api/conversations/${cid}/messages`, { credentials: "include" });
      if (!r.ok) throw new Error(`messages fetch http-${r.status}`);
      const j = (await r.json()) as { messages: { direction: string; channel: string; body: string | null }[] };
      const outs = j.messages.filter((m) => m.direction === "OUT" && m.channel === "API" && typeof m.body === "string");
      return {
        n: outs.length,
        hello: outs.filter((m) => m.body === "hello-ime").length,
        two: outs.filter((m) => m.body === "line1\nline2").length,
      };
    }, conv);

  /** 清空受控 textarea（React 原生 setter 路徑） */
  const clearComposer = async (): Promise<void> =>
    P.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>("textarea[data-testid='c5-composer']");
      if (!ta) throw new Error("composer 搵唔到");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      if (!setter) throw new Error("textarea value setter 搵唔到");
      setter.call(ta, "");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });

  const placeholder = async (): Promise<string> =>
    P.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>("textarea[data-testid='c5-composer']");
      return ta?.getAttribute("placeholder") ?? "<missing>";
    });

  try {
    // ── 準備：PATCH enterSends=true（決定性起點）→ reload 吸 SSR 注入 ──
    await P.goto(`${base}/inbox`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await P.waitForTimeout(4000);
    const patchRes = await P.evaluate(async (v: boolean) => {
      const r = await fetch("/api/staff/me/prefs", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enterSends: v }),
      });
      return r.status;
    }, true);
    if (patchRes !== 200) throw new Error(`PATCH prefs(enterSends=true) → ${patchRes}（expected 200）`);

    await P.goto(`${base}/inbox?conv=${conv}`, { waitUntil: "domcontentloaded" });
    const composer = P.locator("textarea[data-testid='c5-composer']");
    await composer.first().waitFor({ timeout: 150000 });
    await P.waitForTimeout(3000);

    // ── A. IME 組字中 Enter 唔發送 ──
    await clearComposer();
    await composer.first().focus();
    await P.keyboard.type("hello-ime");
    const imeVal = await P.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>("textarea[data-testid='c5-composer']");
      if (!ta) throw new Error("composer 搵唔到");
      ta.focus();
      const ev = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true });
      Object.defineProperty(ev, "isComposing", { value: true }); // 模擬 IME 組字 Enter（keyCode 229 分支同路）
      ta.dispatchEvent(ev);
      return ta.value;
    });
    if (imeVal !== "hello-ime") throw new Error(`IME Enter 後 composer 值被改（=${JSON.stringify(imeVal)}）`);
    await P.waitForTimeout(1500);
    {
      const snap = await outSnapshot();
      if (snap.hello !== 0) throw new Error(`IME 組字 Enter 竟然發送咗（hello-ime OUT=${snap.hello}）`);
    }

    // ── B. enterSends=true：真 Enter 發送 ──
    if ((await placeholder()) !== PLACEHOLDER_SEND) throw new Error(`起點 placeholder 唔係發送模式（=${await placeholder()}）`);
    await P.keyboard.press("Enter");
    let sent = false;
    for (let i = 0; i < 20; i++) {
      await P.waitForTimeout(1000);
      if ((await outSnapshot()).hello >= 1) {
        sent = true;
        break;
      }
    }
    if (!sent) throw new Error("enterSends=true 真 Enter 未發送（20s 無 hello-ime OUT）");
    const cleared = await P.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>("textarea[data-testid='c5-composer']");
      return ta ? ta.value : "<missing>";
    });
    if (cleared !== "") throw new Error(`發送後 composer 未清（=${JSON.stringify(cleared)}）`);

    // ── C. toggle → enterSends=false：Enter 換行 / Ctrl+Enter 發送 ──
    await P.evaluate(async () => {
      const btn = document.querySelector("button[data-testid='c5-entersends-toggle']");
      if (!btn) throw new Error("enterSends toggle 搵唔到");
      (btn as HTMLButtonElement).click();
    });
    await P.waitForTimeout(1200);
    if ((await placeholder()) !== PLACEHOLDER_NEWLINE) throw new Error(`toggle 後 placeholder 未改（=${await placeholder()}）`);

    await clearComposer();
    await composer.first().focus();
    await P.keyboard.type("line1");
    await P.keyboard.press("Enter"); // 換行模式 → 真換行（唔發）
    await P.waitForTimeout(1200);
    {
      const v = await P.evaluate(() => document.querySelector<HTMLTextAreaElement>("textarea[data-testid='c5-composer']")?.value ?? "<missing>");
      if (!v.startsWith("line1\n")) throw new Error(`enterSends=false Enter 唔係換行（=${JSON.stringify(v)}）`);
      const snap = await outSnapshot();
      if (snap.two !== 0) throw new Error("換行竟然觸發咗發送");
    }
    await P.keyboard.type("line2");
    await P.keyboard.down("Control");
    await P.keyboard.press("Enter");
    await P.keyboard.up("Control"); // Ctrl+Enter = 發送
    let sent2 = false;
    for (let i = 0; i < 20; i++) {
      await P.waitForTimeout(1000);
      if ((await outSnapshot()).two >= 1) {
        sent2 = true;
        break;
      }
    }
    if (!sent2) throw new Error("Ctrl+Enter 未發送（20s 無 line1\\nline2 OUT）");

    // ── D. 持久化：reload → SSR 注入 uiPrefs=false（placeholder 仍換行模式）──
    await P.goto(`${base}/inbox?conv=${conv}`, { waitUntil: "domcontentloaded" });
    await composer.first().waitFor({ timeout: 150000 });
    await P.waitForTimeout(3000);
    if ((await placeholder()) !== PLACEHOLDER_NEWLINE) throw new Error(`reload 後 placeholder 唔係換行模式（uiPrefs 未持久化？= ${await placeholder()}）`);

    // ── 收尾：toggle 返 Enter 發送（還原預設）──
    await P.evaluate(() => {
      const btn = document.querySelector("button[data-testid='c5-entersends-toggle']");
      if (!btn) throw new Error("toggle 搵唔到（收尾）");
      (btn as HTMLButtonElement).click();
    });
    await P.waitForTimeout(1200);
    if ((await placeholder()) !== PLACEHOLDER_SEND) throw new Error(`收尾 toggle 未還原（=${await placeholder()}）`);

    console.log("COMPOSER-UI-OK");
  } catch (e) {
    console.log(`COMPOSER-UI-FAIL: ${String(e).slice(0, 160)}`);
    process.exitCode = 1;
  } finally {
    await P.close().catch(() => undefined);
    await ctx.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

void main();

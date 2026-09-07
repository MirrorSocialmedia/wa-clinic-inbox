/**
 * cwi-realtime-fix T7 gate 3 — UI Playwright smoke：
 * 1. STAFF：/inbox 連線狀態 debug 區（socket 已連接）+ 通知設定面板角色渲染
 *    （桌面通知 / 提示音 + autoplay 灰字 / 逐店靜音；ADMIN opt-in 區唔出）
 * 2. ADMIN：面板只出 opt-in（接收訊息通知）— 唔出逐店靜音（§2.3 角色語義）
 * 3. 截圖留證據：/tmp/rt-smoke-staff.png / /tmp/rt-smoke-admin.png
 *
 * 用法：pnpm -s e2e:rt-smoke --base http://127.0.0.1:3100 \
 *   --staff-cookie /tmp/e2e-cookie-rt-tkw.txt --admin-cookie /tmp/e2e-cookie-rt-admin.txt \
 *   --wait-name 'E2E Realtime 張三'
 */
import { readFileSync } from "node:fs";
/* eslint-disable @typescript-eslint/no-require-imports */
type PageLike = {
  goto(url: string, o: Record<string, unknown>): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  getByText(t: string, o?: Record<string, unknown>): { count(): Promise<number> };
  getByLabel(t: string): { click(): Promise<void> };
  screenshot(o: Record<string, unknown>): Promise<void>;
  evaluate(fn: unknown): Promise<unknown>;
  close(): Promise<void>;
};
type CtxLike = {
  addCookies(c: { name: string; value: string; domain: string; path: string }[]): Promise<void>;
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
};
type BrowserLike = { close(): Promise<void> };
// ★ a2 fix：playwright-core module 本身冇 .launch — 要解構 chromium（同 e2e-notify-ui.ts 口徑）
const { chromium: pw } = require("/usr/lib/node_modules/openclaw/node_modules/playwright-core") as {
  chromium: { launch(o: Record<string, unknown>): Promise<BrowserLike & { newContext(o: Record<string, unknown>): Promise<CtxLike> }> };
};

const EXE = "/home/kenneth/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome";

let failReason = "";
function fail(r: string): never {
  failReason = r;
  throw new Error(r);
}

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing --${name}`);
  return process.argv[i + 1];
}

function parseJar(file: string): string | null {
  const jar = readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l && (l.startsWith("#HttpOnly_") ? l.replace(/^#HttpOnly_/, "") : !l.startsWith("#")));
  const sess = jar.map((l) => l.split("\t")).find((p) => p[5] === "wa_inbox_session");
  return sess ? sess[6] : null;
}

async function openBrowser(
  exe: string,
  cookieFile: string,
  url: string,
): Promise<{ B: BrowserLike; C: CtxLike; P: PageLike }> {
  const B = await pw.launch({
    executablePath: exe,
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const C = await B.newContext({ viewport: { width: 1440, height: 900 } });
  const cookie = parseJar(cookieFile);
  if (cookie) await C.addCookies([{ name: "wa_inbox_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
  const P = await C.newPage();
  await P.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
  return { B, C, P };
}

async function waitFor(
  P: { getByText: (t: string, o?: Record<string, unknown>) => { count(): Promise<number> } },
  text: string,
  timeoutMs = 60_000,
  what = "",
): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const n = await P.getByText(text).count();
    if (n > 0) return;
    if (Date.now() - t0 > timeoutMs) fail(`smoke: ${what || text} ${timeoutMs / 1000}s 未出`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function main(): Promise<void> {
  const base = arg("base");
  const staffCookie = arg("staff-cookie");
  const adminCookie = arg("admin-cookie");
  const waitName = arg("wait-name");

  // ── STAFF ─────────────────────────────────────────────────────────────
  const a = await openBrowser(EXE, staffCookie, `${base}/inbox`);
  try {    await waitFor(a.P, waitName, 120_000, "staff list");
    // 開通知設定面板（★ a2 fix：gear click 可撞 hydration race — retry ×3）
    for (let i = 0; i < 3; i++) {
      await a.P.getByLabel("通知設定").click();
      if ((await a.P.getByText("桌面通知").count()) > 0) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    await waitFor(a.P, "桌面通知", 10_000, "桌面通知");
    // §3 debug 區（RT-6）：連線狀態 + socket 已連接（★ a2 fix：debug 區喺設定面板內 — 要開完面板先有）
    await waitFor(a.P, "連線狀態（唯讀 debug）", 30_000, "debug 區");
    await waitFor(a.P, "socket: ✅ 已連接", 30_000, "socket 已連接");
    if ((await a.P.getByText("提示音").count()) < 1) fail("smoke: 提示音 未有");
    if ((await a.P.getByText("瀏覽器規定：網頁音效要先同頁面互動一次先播得").count()) < 1)
      fail("smoke: autoplay 灰字未有（§7.3）");
    // ★ a2 fix：逐店靜音 淨係多店 STAFF（clinics.length>1）先 render — 跟帳戶（a1 bug：TKW staff 係單店）
    // 多店 render 由 t169 gate 斷（staff-B 多店）；smoke 斷角色硬邊界：STAFF 永遠唔見 opt-in
    const muteN = await a.P.getByText("逐店靜音", { exact: true }).count();
    // ★ a2 fix：heading 有後綴（「接收訊息通知（預設唔收 — 逐店開）」）— exact 會 0 匹配；substring 安全（help 文字無「接收」前綴）
    const optinN = await a.P.getByText("接收訊息通知").count();
    if (optinN > 0) fail("smoke: STAFF 唔應該見 ADMIN opt-in 區（§2.3 互斥）");
    await a.P.screenshot({ path: "/tmp/rt-smoke-staff.png" });
    console.log(`smoke-staff: debug 區 ✅ + 面板角色渲染 ✅（逐店靜音=${muteN}（多店才有）/ opt-in=0）`);
  } finally {
    await a.B.close();
  }

  // ── ADMIN ─────────────────────────────────────────────────────────────
  const d = await openBrowser(EXE, adminCookie, `${base}/inbox`);
  try {
    await waitFor(d.P, waitName, 120_000, "admin list");
    // ★ a2 fix：gear click 可撞 hydration race（第一次 click 無效）— retry ×3（TOOLS.md 已知陷阱）
    for (let i = 0; i < 3; i++) {
      await d.P.getByLabel("通知設定").click();
      if ((await d.P.getByText("桌面通知").count()) > 0) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    await waitFor(d.P, "桌面通知", 10_000, "桌面通知(admin)");
    // ★ a2 fix：exact:true — 面板 help 文字含「逐店靜音」substring（t169 實測假紅陷阱）
    // ★ a2 fix：heading 有後綴（「接收訊息通知（預設唔收 — 逐店開）」）— exact 會 0 匹配；substring 安全（help 文字無「接收」前綴）
    const optinN = await d.P.getByText("接收訊息通知").count();
    const muteN = await d.P.getByText("逐店靜音", { exact: true }).count();
    if (optinN < 1) fail("smoke: ADMIN 應該見 opt-in 區（§2.3 白名單）");
    if (muteN > 0) fail("smoke: ADMIN 唔應該見「逐店靜音」（§2.3 互斥）");
    await d.P.screenshot({ path: "/tmp/rt-smoke-admin.png" });
    console.log("smoke-admin: 面板角色渲染 ✅（opt-in 有 / 逐店靜音 無）");
  } finally {
    await d.B.close();
  }

  console.log("RT-SMOKE-OK");
}

main().catch((e) => {
  console.log(`RT-SMOKE-FAIL: ${failReason || e.message}`);
  process.exit(1);
});

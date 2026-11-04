/**
 * e2e-duty-refresh — §B2 今日當值卡 client 端刷新（cwi-r1close-20260827）。
 *
 * Browser-level（playwright-core headless）：SSR 快照（fixture A）→ flag 換名單（B）→
 * 換對話再換返（唔 reload）→ 卡必須顯示 B（client useEffect fetch /api/duty-roster 生效）。
 *
 * 用法（repo root，server 必須已起 + cookie 有效）：
 *   tsx scripts/e2e-duty-refresh.ts --base http://127.0.0.1:3100 \
 *     --cookie /tmp/e2e-cookie-tkw.txt --conv1 <convId> --conv2 <convId>
 *
 * 斷言輸出（mock-e2e.sh grep 用）：
 *   DUTY-REFRESH-OK / DUTY-REFRESH-FAIL: <reason>
 *
 * 註：conv1/conv2 必須係同一 staff（STAFF）scope 內、同一 clinic（TKW）嘅對話 —
 *   兩患者嘅 profileName 必須含「E2E-DUTY-A」/「E2E-DUTY-B」（click selector 用）。
 * Override flag = .dev/duty-mock-override.json（duty/client.ts mock 分支讀；DUTY_MOCK=1 only）。
 */
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { chromium, chromiumPath } from "./_pw";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const FLAG_PATH = path.join(REPO_ROOT, ".dev", "duty-mock-override.json");

// host 全局 playwright-core（repo 唔帶 — 避免新增依賴）— 絕對路徑 require；
// tsc 無法解析非 repo 模組嘅型別 → 窄化 cast。呢部 sandbox 定點路径。

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : "";
  if (!v) {
    console.error(`missing ${name}`);
    process.exit(2);
  }
  return v;
}

// 註：--conv2 可以傳（文檔一致性）但 script 唔用 — 對話項用患者名 click（見下）


const OVERLAP_STAFF = [
  { staffName: "陳志強", role: "醫生", shiftStart: "08:00", shiftEnd: "16:00" },
  { staffName: "吳雅婷", role: "護士", shiftStart: "12:00", shiftEnd: "20:00" },
];

/** 窄化 playwright Page 型別（repo 唔帶 playwright 依賴 — 只用呢度用到嘅方法）。 */
interface PageLite {
  goto: (url: string, o?: Record<string, unknown>) => Promise<unknown>;
  waitForTimeout: (ms: number) => Promise<void>;
  waitForSelector: (sel: string, o?: Record<string, unknown>) => Promise<unknown>;
  waitForFunction: (fn: string | ((...a: unknown[]) => unknown), arg?: unknown, o?: Record<string, unknown>) => Promise<unknown>;
  getByText: (t: string, o?: Record<string, unknown>) => { first: () => { count: () => Promise<number>; click: (o?: Record<string, unknown>) => Promise<void> } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on: (ev: string, cb: (r: any) => void) => void;
  url: () => string;
  evaluate: (fn: () => unknown) => Promise<unknown>;
  close: () => Promise<void>;
}

async function main(): Promise<void> {
  const base = arg("--base").replace(/\/$/, "");
  const cookieFile = arg("--cookie");
  const conv1 = arg("--conv1");
  // （--conv2 傳入即忽略 — 對話項用患者名 click）

  // cookie jar（curl 格式：... wa_inbox_session <value>）
  const jar = readFileSync(cookieFile, "utf8");
  const line = jar.split("\n").find((l) => l.includes("wa_inbox_session"));
  const sessionValue = (line ?? "").trim().split(/\s+/).pop() ?? "";
  if (!sessionValue) throw new Error("cookie 檔搵唔到 wa_inbox_session");

  // hermetic：清舊 flag
  rmSync(FLAG_PATH, { force: true });

  const browser = await chromium.launch({
    headless: true,
    executablePath: chromiumPath(),
  }) as unknown as {
    newContext: (o: Record<string, unknown>) => Promise<{
      newPage: () => Promise<PageLite>;
      close: () => Promise<void>;
    }>;
    close: () => Promise<void>;
  };
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 }, // ≥lg → 桌面三欄（detail pane 常駐）
  });
  // ★ addCookies（唔係 newContext({cookies}) — 實測後者喺呢個 playwright-core build 下 cookie 未送到 server）
  await (ctx as unknown as { addCookies: (c: unknown[]) => Promise<void> }).addCookies([
    {
      name: "wa_inbox_session",
      value: sessionValue,
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  const P = await ctx.newPage();

  // 診斷：未完成嘅 /api 請求（fail 時 dump — 分得清「server 慢」定「請求排隊卡住」）
  const pending = new Map<unknown, { url: string; at: number }>();
  P.on("request", (r) => {
    if (r.url().includes("/api/")) pending.set(r, { url: r.url().replace(base, ""), at: Date.now() });
  });
  P.on("requestfinished", (r) => pending.delete(r));
  P.on("requestfailed", (r) => pending.delete(r));
  // ★ 2026-11-03 T95 追查（CI 換對話後 6 條 /api 卡 30s+ — 啱啱係 HTTP/1.1 每 host 6 條連線上限）：
  //   記 websocket（socket.io 有冇用 websocket／有冇斷）、頁面錯誤、/api 完成時間分佈（慢請求）
  const sockets: { url: string; at: number; closedAt: number | null; frames: number }[] = [];
  P.on("websocket", (ws: { url: () => string; on: (e: string, cb: () => void) => void }) => {
    const rec = { url: ws.url().replace(base, ""), at: Date.now(), closedAt: null as number | null, frames: 0 };
    sockets.push(rec);
    ws.on("close", () => (rec.closedAt = Date.now()));
    ws.on("framereceived", () => rec.frames++);
  });
  const pageErrors: string[] = [];
  P.on("pageerror", (e: Error) => pageErrors.push(String(e?.message ?? e).slice(0, 200)));
  const slow: string[] = [];
  P.on("requestfinished", (r: { url: () => string; timing: () => { startTime: number; responseEnd: number; requestStart: number; connectEnd: number } }) => {
    if (!r.url().includes("/api/") && !r.url().includes("/socket.io/")) return;
    const t = r.timing();
    if (t.responseEnd > 3000) slow.push(`${Math.round(t.responseEnd)}ms(wait-socket=${Math.round(t.requestStart)}ms) ${r.url().replace(base, "").slice(0, 90)}`);
  });
  const t0 = Date.now();

  let flowsCalls = 0;
  P.on("response", (r) => {
    // ★ cwi-paintriage-20260903 fix（D.4 對齊）：側欄改 MiniSchedule 自拉 /api/conversations/:id/flows（含 duty 欄）— 舊 /api/duty-roster 計數 stale
    if (r.url().includes("/flows") && r.ok()) flowsCalls++;
  });

  // ── 1) 載入 /inbox?conv=conv1 → client 自拉 flows 快照應顯示 fixture A（林小曼） ─────────
  await P.goto(`${base}/inbox?conv=${conv1}`, { waitUntil: "domcontentloaded" });
  // ★ D.4：舊「今日當值（N 人）」SSR 卡已移除 → 當值降底行「當值：{名}」（client 渲染）
  await P.waitForSelector("text=當值：", { timeout: 30000 });
  const hasA = await P.getByText("林小曼").first().count();
  if (hasA === 0) throw new Error("初始卡冇顯示 fixture A（林小曼）— flows duty 未生效？");
  const callsAfterLoad = flowsCalls;
  // client mount 會發一次 /flows（MiniSchedule 自拉）— 等佢落定
  await P.waitForTimeout(1500);

  // ── 2) flag 換名單 B → 換對話 conv2 → 換返 conv1（唔 reload）→ 卡必須係 B ──
  writeFileSync(FLAG_PATH, JSON.stringify({ staff: OVERLAP_STAFF }), "utf8");
  await P.getByText("E2E-DUTY-B", { exact: true }).first().click();
  await P.waitForTimeout(800);
  await P.getByText("E2E-DUTY-A", { exact: true }).first().click();

  try {
    await P.waitForFunction(
      () => document.body.innerText.includes("陳志強") && !document.body.innerText.includes("林小曼"),
      // ★ playwright waitForFunction 簽名係 (fn, arg, options) — 之前 options 放咗喺 arg 位 → 60s 從未生效，
      //   實際用預設 30s（CI 診斷：elapsed 43s、卡住請求 32s 就判失敗；server probe 3s 回 = 只係慢唔係死）
      // 30s → 60s：CI runner 慢嗰陣（同一 commit authz 步 6–8 分鐘）右欄 /flows 會排喺其他請求後面
      undefined,
      { timeout: 60000 }
    );
  } catch {
    // 診斷：dump 當下 url + body 尾（定係 cookie 失効 307 / click 未中 / fetch 未發）
    const dbg = (await P.evaluate(() => ({
      url: location.href,
      tail: document.body.innerText.slice(-600),
    }))) as { url: string; tail: string };
    const now = Date.now();
    const stuck = [...pending.values()].map((x) => `${Math.round((now - x.at) / 1000)}s ${x.url.slice(0, 100)}`);
    // ── 診斷：server 對「新」請求有冇反應？（node fetch，唔經 browser 連線池）──
    //   快 → server 正常，係 browser 連線被佔（socket.io polling／長請求）；慢 → server 本身卡（event loop／DB／Redis）
    const probes: string[] = [];
    for (const u of [...new Set([...pending.values()].map((x) => x.url))].slice(0, 6)) {
      const st = Date.now();
      try {
        const ac = new AbortController();
        const tm = setTimeout(() => ac.abort(), 20000);
        const res = await fetch(`${base}${u}`, { headers: { cookie: `wa_inbox_session=${sessionValue}` }, signal: ac.signal });
        clearTimeout(tm);
        probes.push(`${res.status} ${Date.now() - st}ms ${u.slice(0, 80)}`);
      } catch (e) {
        probes.push(`ERR ${Date.now() - st}ms ${(e as Error).name} ${u.slice(0, 80)}`);
      }
    }
    console.log(`DUTY-DIAG elapsed=${Math.round((now - t0) / 1000)}s`);
    console.log(`DUTY-DIAG websockets=${JSON.stringify(sockets.map((w) => ({ url: w.url.slice(0, 60), ageS: Math.round((now - w.at) / 1000), closedS: w.closedAt ? Math.round((now - w.closedAt) / 1000) : null, frames: w.frames })))}`);
    console.log(`DUTY-DIAG pageErrors=${JSON.stringify(pageErrors.slice(0, 5))}`);
    console.log(`DUTY-DIAG slowFinished=${JSON.stringify(slow.slice(-15))}`);
    console.log(`DUTY-DIAG probes=${JSON.stringify(probes)}`);
    throw new Error(`卡未翻 B（url=${dbg.url}）pending=${JSON.stringify(stuck)} tail: ${JSON.stringify(dbg.tail.slice(-300))}`);
  }
  if (flowsCalls <= callsAfterLoad) {
    throw new Error(`client 端刷新未發 /flows（calls=${flowsCalls}, afterLoad=${callsAfterLoad}）`);
  }
  // 換對話後新卡顯示 B（陳志強）— 已喺 waitForFunction 斷言
  rmSync(FLAG_PATH, { force: true });

  console.log(`DUTY-REFRESH-OK (flowsCalls=${flowsCalls}, afterLoad=${callsAfterLoad})`);
  await P.close();
  await ctx.close();
  await browser.close();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.log(`DUTY-REFRESH-FAIL: ${e instanceof Error ? e.message : String(e)}`);
    rmSync(FLAG_PATH, { force: true });
    process.exit(1);
  });

/**
 * e2e-nav-reach — cwi-setnav SET-09：入口回歸測試（角色 × 桌面/手機 BFS 爬蟲）
 *
 * 工單：「每角色 × 桌面／手機，由 /inbox 撳可見連結 BFS；斷言『每個 page.tsx 喺至少一個
 * 應該用佢嘅角色撳得到』，加白名單（login／法律頁等）。新頁冇入口 = CI 紅。」
 *
 * 方法：
 * 1. 掃 src/app 全部 page.tsx（recursively — (group) 唔計入路徑；[dynamic] route 不入斷言 —
 *    爬蟲撳唔到參數化 URL，只記錄）。
 * 2. 每角色（STAFF / SUPERVISOR / ADMIN）× 每 viewport（桌面 1366 / 手機 390）：
 *    由 /inbox 起，收「可見」<a href>（display:none 祖先唔計 — mobile 唔會「睇到」NavRail），
 *    goto 逐個跟，BFS 到飽和。
 * 3. 斷言：每個非白名單靜態 route 至少被一個角色 × viewport 組合 visit 到（唔 redirect 去
 *    /login、唔 403）。漏 = exit 1（CI 紅）。
 *
 * 白名單（唔需要由 /inbox 有入口）：
 *   /            登入態 redirect（/inbox or /login）
 *   /login       登入頁
 *   /privacy /terms /data-deletion   法律頁（公開）
 *   /admin/quotes  SET-03 已搬去 /quotes（呢度係 redirect stub）
 *
 * 前提：15432 DB；server 3100 有就攞佢用，冇就自起（hermetic — 同 e2e-authz-matrix 同招）。
 * 用法（repo root）：pnpm tsx scripts/e2e-nav-reach.ts
 * 輸出：NAV-REACH-OK / NAV-REACH-FAIL: <n>（exit 0/1）
 */
import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
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
const PASS = "NAVReach-Pass-909!";
const ROOT = process.cwd();

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

// ── server 探活 / hermetic 自起（同 e2e-authz-matrix 同招）────────────────────
function pidsOn3100(): number[] {
  try {
    const out = execSync("lsof -ti:3100 -sTCP:LISTEN", { encoding: "utf8" }).trim();
    return out ? out.split("\n").filter(Boolean).map(Number) : [];
  } catch {
    return [];
  }
}
async function serverResponding(timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(3_000) });
      if (r.status === 200 || r.status === 503) return true;
    } catch {
      /* 未起 / 編譯中 */
    }
    await sleep(1_000);
  }
  return false;
}
async function ensureServer(): Promise<boolean> {
  if (pidsOn3100().length > 0) {
    if (await serverResponding(120_000)) return false;
    throw new Error("3100 有进程但 120s 未 responding");
  }
  console.log("  [nav-reach] 3100 未運行 → 自起 pnpm dev（hermetic）...");
  const child = spawn("pnpm", ["dev"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_OPTIONS: "--max-old-space-size=16384",
      WORKFORCE_MOCK: process.env.WORKFORCE_MOCK ?? "1",
      AI_MOCK: process.env.AI_MOCK ?? "1",
      WA_MOCK: process.env.WA_MOCK ?? "1",
      DUTY_MOCK: process.env.DUTY_MOCK ?? "1",
      PORT: "3100",
      APP_HOST: process.env.APP_HOST ?? "127.0.0.1:3100",
    },
    stdio: ["ignore", fs.openSync("/tmp/nav-reach-server.log", "a"), fs.openSync("/tmp/nav-reach-server.log", "a")],
    detached: true,
  });
  child.unref();
  if (!(await serverResponding(300_000))) throw new Error("hermetic 自起 3100：300s 未 responding（睇 /tmp/nav-reach-server.log）");
  return true;
}

// ── route 掃描（src/app/**/page.tsx）────────────────────────────────────────
function scanRoutes(): { staticRoutes: string[]; dynamicRoutes: string[] } {
  const staticRoutes: string[] = [];
  const dynamicRoutes: string[] = [];
  const appDir = path.join(ROOT, "src", "app");
  const consider = (relSegs: string[]): void => {
    const isDynamic = relSegs.some((s) => s.startsWith("["));
    const route = relSegs.length === 0 ? "/" : `/${relSegs.join("/")}`;
    (isDynamic ? dynamicRoutes : staticRoutes).push(route);
  };
  const walk = (dir: string, relSegs: string[]): void => {
    if (fs.existsSync(path.join(dir, "page.tsx"))) consider(relSegs);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("(")) {
        walk(path.join(dir, entry.name), relSegs); // route group — 唔計入路徑
        continue;
      }
      walk(path.join(dir, entry.name), [...relSegs, entry.name]);
    }
  };
  walk(appDir, []);
  return { staticRoutes: [...new Set(staticRoutes)].sort(), dynamicRoutes: [...new Set(dynamicRoutes)].sort() };
}

/** 白名單：唔需要由 /inbox 入口（reason 入報告） */
const WHITELIST: Record<string, string> = {
  "/": "登入態 redirect（/inbox or /login）— 唔係獨立頁",
  "/login": "登入頁",
  "/privacy": "法律頁（公開 — 法律鏈入 root layout，唔經 /inbox）",
  "/terms": "法律頁（公開）",
  "/data-deletion": "法律頁（公開）",
  "/admin/quotes": "SET-03：已搬去 /quotes — 呢度係 redirect stub",
};

// ── BFS ─────────────────────────────────────────────────────────────────────
interface PageLike {
  goto: (url: string, o: Record<string, unknown>) => Promise<unknown>;
  waitForSelector: (sel: string, o: Record<string, unknown>) => Promise<unknown>;
  evaluate: <T>(fn: string) => Promise<T>;
  url: () => string;
  close: () => Promise<void>;
}
interface CtxLike {
  newPage: () => Promise<PageLike>;
  addCookies: (c: Array<Record<string, unknown>>) => Promise<void>;
  close: () => Promise<void>;
}
type Browser = { newContext: (o: Record<string, unknown>) => Promise<CtxLike>; close: () => Promise<void> };

/** 可見 <a href>（display:none 祖先唔計）— 只收本機 route（starts with /） */
const COLLECT_LINKS_JS = `
  (() => {
    const vis = (el) => {
      let n = el;
      while (n && n.nodeType === 1) {
        const cs = getComputedStyle(n);
        if (cs.display === "none" || cs.visibility === "hidden") return false;
        n = n.parentElement;
      }
      return true;
    };
    return Array.from(document.querySelectorAll('a[href]'))
      .filter((a) => vis(a))
      .map((a) => a.getAttribute("href"))
      .filter((h) => h && h.startsWith("/") && !h.startsWith("//"));
  })()
`;

async function bfs(
  B: Browser,
  cookie: string,
  viewport: { width: number; height: number },
  allRoutes: Set<string>
): Promise<Set<string>> {
  const C = await B.newContext({ viewport });
  await C.addCookies([{ name: "wa_inbox_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
  const P = await C.newPage();
  const visited = new Set<string>();
  const queue: string[] = ["/inbox"];
  let iters = 0;
  try {
    while (queue.length > 0 && iters < 60) {
      const u = queue.shift()!;
      if (visited.has(u)) continue;
      iters++;
      try {
        await P.goto(`${BASE}${u}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
      } catch {
        continue; // 單頁慢/失敗唔阻 BFS
      }
      // settle：client 內容（hub 七步行 = fetch 後先 render）
      if (u === "/admin/ai") {
        await P.waitForSelector('a[href*="/admin/routing-rules"]', { timeout: 25_000 }).catch(() => {});
      } else {
        await sleep(1_200);
      }
      const finalPath = new URL(P.url()).pathname;
      if (finalPath === "/login") continue; // 權限外 — 唔計
      visited.add(finalPath);
      let hrefs: string[] = [];
      try {
        hrefs = await P.evaluate(COLLECT_LINKS_JS);
      } catch {
        hrefs = [];
      }
      for (const h of hrefs) {
        const p = new URL(h, "http://x").pathname;
        if (!visited.has(p) && allRoutes.has(p)) queue.push(p);
      }
    }
  } finally {
    await C.close().catch(() => {});
  }
  return visited;
}

async function main(): Promise<void> {
  const { staticRoutes, dynamicRoutes } = scanRoutes();
  const assertable = staticRoutes.filter((r) => !WHITELIST[r]);
  const allRoutes = new Set(staticRoutes);
  console.log(`routes：static ${staticRoutes.length}（斷言 ${assertable.length}）；dynamic（唔入斷言）：${dynamicRoutes.join(", ") || "無"}`);

  const serverOurs = await ensureServer();
  const exe = chromiumPath();
  const B = (await (chromium as { launch: (o: Record<string, unknown>) => Promise<Browser> }).launch({
    headless: true,
    executablePath: exe,
  })) as unknown as Browser;

  const U_STAFF = "e2enavstf000000000000001";
  const U_SUP = "e2enavsup000000000000001";
  const U_ADMIN = "e2enavadm000000000000001";
  const E_STAFF = "e2enavstaff@e2e.local";
  const E_SUP = "e2enavsup@e2e.local";
  const E_ADMIN = "e2enavadmin@e2e.local";
  const IDS = [U_STAFF, U_SUP, U_ADMIN];

  try {
    // ── fixture：3 用戶（STAFF 綁首店 / SUPERVISOR ALL / ADMIN ALL）+ 1 對話 ──
    await prisma.staffClinic.deleteMany({ where: { staffId: { in: IDS } } });
    await prisma.staffUser.deleteMany({ where: { id: { in: IDS } } });
    const clinics = await prisma.clinic.findMany({ select: { id: true }, orderBy: { id: "asc" } });
    const clinicId = clinics[0]?.id;
    if (!clinicId) throw new Error("clinic 搵唔齊");
    const pwHash = await argon2.hash(PASS);
    await prisma.$transaction([
      prisma.staffUser.create({
        data: { id: U_STAFF, email: E_STAFF, name: "E2E Nav STAFF", passwordHash: pwHash, role: "STAFF", active: true },
      }),
      prisma.staffUser.create({
        data: { id: U_SUP, email: E_SUP, name: "E2E Nav SUPERVISOR", passwordHash: pwHash, role: "SUPERVISOR", active: true, scopeType: "ALL" as never },
      }),
      prisma.staffUser.create({
        data: { id: U_ADMIN, email: E_ADMIN, name: "E2E Nav ADMIN", passwordHash: pwHash, role: "ADMIN", active: true, scopeType: "ALL" as never },
      }),
      prisma.staffClinic.create({ data: { staffId: U_STAFF, clinicId, isPrimary: true } }),
    ]);

    const login = async (email: string): Promise<string> => {
      const res = await fetch(`${BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: BASE },
        body: JSON.stringify({ email, password: PASS }),
      });
      if (res.status !== 200) throw new Error(`login ${email} → ${res.status}`);
      const m = (res.headers.get("set-cookie") ?? "").match(/wa_inbox_session=([^;]+)/);
      if (!m) throw new Error("login 冇 cookie");
      return m[1];
    };
    const [ckStaff, ckSup, ckAdmin] = await Promise.all([login(E_STAFF), login(E_SUP), login(E_ADMIN)]);

    // ── 6 條 BFS（角色 × viewport）─────────────────────────────────
    const viewports = [
      { name: "desktop", width: 1366, height: 768 },
      { name: "mobile", width: 390, height: 844 },
    ] as const;
    const roles: { name: string; cookie: string }[] = [
      { name: "STAFF", cookie: ckStaff },
      { name: "SUPERVISOR", cookie: ckSup },
      { name: "ADMIN", cookie: ckAdmin },
    ];
    const perRole: Record<string, Set<string>> = {};
    for (const role of roles) {
      for (const vp of viewports) {
        const key = `${role.name}/${vp.name}`;
        const t0 = Date.now();
        const visited = await bfs(B, role.cookie, { width: vp.width, height: vp.height }, allRoutes);
        perRole[key] = visited;
        console.log(`  ${key}：visit ${visited.size} routes（${Math.round((Date.now() - t0) / 1000)}s）`);
      }
    }

    // ── 斷言：每個 assertable route 至少一個角色×viewport 撳得到 ──
    const union = new Set<string>();
    for (const v of Object.values(perRole)) for (const r of v) union.add(r);
    const missing = assertable.filter((r) => !union.has(r));
    console.log("\n  route 覆蓋表（D=desktop M=mobile）：");
    for (const r of assertable) {
      const marks = viewports
        .map((vp) =>
          roles
            .map((role) => (perRole[`${role.name}/${vp.name}`]?.has(r) ? vp.name[0] : "."))
            .join("")
        )
        .join("");
      console.log(`   ${r.padEnd(28)} ${marks}`);
    }
    for (const k of Object.keys(WHITELIST)) {
      if (staticRoutes.includes(k)) console.log(`   ${k.padEnd(28)} WHITELIST（${WHITELIST[k]}）`);
    }
    check(
      "SET-09 入口回歸：每個非白名單 page 至少一個角色×viewport 撳得到",
      missing.length === 0,
      missing
    );
  } finally {
    try {
      await prisma.staffClinic.deleteMany({ where: { staffId: { in: IDS } } });
      await prisma.staffUser.deleteMany({ where: { id: { in: IDS } } });
    } catch {
      /* best-effort */
    }
    await B.close().catch(() => {});
    await prisma.$disconnect();
    if (serverOurs) {
      // 還原：殺走自己起嘅 3100（本地 dev server 唔好錯殺 — 只殺 pidsOn3100 全部 = 自己起嗰個）
      for (const p of pidsOn3100()) {
        try {
          process.kill(p, "SIGTERM");
        } catch {
          /* */
        }
      }
    }
  }

  if (FAILS === 0) {
    console.log("NAV-REACH-OK");
    process.exit(0);
  }
  console.log(`NAV-REACH-FAIL: ${FAILS}`);
  process.exit(1);
}

main().catch((e) => {
  console.error("NAV-REACH-ERROR:", e);
  process.exit(2);
});

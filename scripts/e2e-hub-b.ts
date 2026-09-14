/**
 * e2e-hub-b — ★ cwi-hub-b-20260914（Part B B.7）：T360–T370 e2e。
 *
 * 用法（repo root）：pnpm -s tsx scripts/e2e-hub-b.ts
 * 前置：dev stack live（web 3100 / worker / PG 15432 / Redis 6379）。
 *
 * 測試（全過 exit 0，任何 fail exit 1）：
 *   T360 Hub 七步摘要數字同 DB 一致（+ 七步名/序號）
 *   T361 健康警示三態（④ 未簽署方案 / ④ 知識庫空（scope）/ ⑦ L2 開但 eval 未跑）
 *   T362 沙盤單輪（七步齊 + 草稿 + latency + sandboxId）
 *   T363 零副作用（DB 6 類 count + AiCallStats.totalCalls + socket 零事件，前後 snapshot）
 *   T364 紅旗「面腫」→ 顯示命中但唔建 StaffNotice / 唔標 URGENT
 *   T365 多輪（DISCOVER 行到 PRESENT_OPTIONS）+ Redis TTL 30min + 重新開始清空
 *   T366 同真 pipeline 一致性（同一句 沙盤 vs 真 worker：intent / consult trigger / 引用 priceDoc）
 *   T367 關鍵詞中心交叉警示（chip 四來源 + impact + 改口語表→publish→view→revert）
 *   T368 逐行跳 anchor 正確（7 行）
 *   T369 舊八條 URL 全活（200）
 *   T370 迴歸：e2e-hub-a（T350–T355）+ e2e:consult-c3 + e2e:ai-scrub 全綠
 *
 * Fixture 全部 `E2EHUBB-` 前綴；開工前冪等洗殘留；收結全清 + count=0 斷言（零殘留）。
 * 註：dev .env AI_MOCK=1（mock LLM deterministic）— 沙盤同 worker 行同一 mock 入口，T366 全欄 deterministic。
 */
const envPath = new URL("../.env", import.meta.url).pathname;
try {
  process.loadEnvFile(envPath);
} catch {
  /* 靠 process env */
}

import { prisma } from "../src/lib/prisma";
import { io, type Socket } from "socket.io-client";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { getRedis } from "../src/lib/queue";
import { LEXICON_DEFAULTS } from "../src/lib/workflow/definitions";
import { HUB_STEP_CONTRACT } from "../src/lib/ai/hub-summary";

const BASE = "http://127.0.0.1:3100";
const PASS = "Hubb-E2E-Pass-123!";
const ADMIN_EMAIL = "E2EHUBB-admin@e2e.local";
const SCOPE2_EMAIL = "E2EHUBB-scope2@e2e.local";
const WA_PREFIX = "E2EHUBB_";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ✔ ${name}`);
  } else {
    failures++;
    console.error(`  ✘ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}
function fail(msg: string): never {
  console.error(`HUBB-ABORT: ${msg}`);
  process.exit(2);
}

// ── session cache（login rate limit 5/60s per-IP — 每 email 只 login 一次）──
const cookieCache = new Map<string, string>();
async function cookieFor(email: string): Promise<string> {
  const hit = cookieCache.get(email);
  if (hit) return hit;
  let lastStatus = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASS }),
    });
    lastStatus = res.status;
    const sc = res.headers.get("set-cookie");
    if (res.ok && sc) {
      const c = sc.split(";")[0];
      cookieCache.set(email, c);
      return c;
    }
    // 429 = per-IP 5/60s rate limit（同機多 e2e 共用 — backoff 等窗）
    if (res.status === 429) {
      console.log(`  … login ${email} 429 — 等 65s 再試（attempt ${attempt + 1}）`);
      await new Promise((r) => setTimeout(r, 65_000));
      continue;
    }
    break;
  }
  throw new Error(`login ${email} ${lastStatus}`);
}
async function apiGet(path: string, cookie: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`${BASE}${path}`, { headers: { cookie }, cache: "no-store" });
  const t = await r.text();
  let j: any = null;
  try {
    j = JSON.parse(t);
  } catch {
    /* HTML 500（loadManifest race）— status 自會顯示 */
  }
  return { status: r.status, json: j };
}
async function apiPost(path: string, body: unknown, cookie: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  let j: any = null;
  try {
    j = JSON.parse(t);
  } catch {
    /* */
  }
  return { status: r.status, json: j };
}

// ── BullMQ ai queue（同 production name/prefix — 見 e2e-ai-job.ts）──
function redisConnection(): IORedis {
  const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
  return new IORedis(REDIS_URL, { maxRetriesPerRequest: null, connectTimeout: 5000 });
}
function aiQueueLike(): Queue {
  return new Queue("ai", {
    connection: redisConnection(),
    prefix: "wa-inbox",
    defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: { count: 1000 }, removeOnFail: { count: 5000 } },
  });
}

// ── fixture ids（main 內填）──────────────────────────────────────────
let C1 = "";
let C2 = "";
let ADMIN_ID = "";

interface Counts {
  message: number;
  aiDraft: number;
  consultSession: number;
  auditLog: number;
  staffNotice: number;
  pushSub: number;
  aiCallTotal: number;
}
async function sideEffectCounts(): Promise<Counts> {
  const [message, aiDraft, consultSession, auditLog, staffNotice, pushSub, stats] = await Promise.all([
    prisma.message.count(),
    prisma.aiDraft.count(),
    prisma.consultSession.count(),
    prisma.auditLog.count(),
    prisma.staffNotice.count(),
    prisma.pushSubscription.count(),
    prisma.aiCallStats.findUnique({ where: { id: 1 } }),
  ]);
  return {
    message,
    aiDraft,
    consultSession,
    auditLog,
    staffNotice,
    pushSub,
    aiCallTotal: stats?.totalCalls ?? 0,
  };
}

async function main(): Promise<void> {
  const argon2 = (await import("argon2")) as { default: { hash: (p: string) => Promise<string> } };
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (e) {
    fail(`DB ping 失敗：${e instanceof Error ? e.message : String(e)}`);
  }

  // ═══ 冪等洗（上輪 crash 殘留 self-heal）══════════════════════════════
  {
    const oldClinics = await prisma.clinic.findMany({ where: { code: { startsWith: "E2EHUBB-" } }, select: { id: true } });
    const oldUsers = await prisma.staffUser.findMany({ where: { email: { startsWith: "E2EHUBB-" } }, select: { id: true } });
    const oldConvIds = (
      await prisma.conversation.findMany({ where: { clinicId: { in: oldClinics.map((c) => c.id) } }, select: { id: true } })
    ).map((c) => c.id);
    if (oldClinics.length || oldUsers.length || oldConvIds.length) {
      console.log(`冪等洗：clinic ${oldClinics.length} / user ${oldUsers.length} / conv ${oldConvIds.length}`);
    }
    const uc = oldConvIds;
    const ucl = oldClinics.map((c) => c.id);
    const uu = oldUsers.map((u) => u.id);
    await prisma.message.deleteMany({ where: { OR: [{ conversationId: { in: uc } }, { waMessageId: { startsWith: "wamid.e2ehubb" } }] } });
    await prisma.aiDraft.deleteMany({ where: { conversationId: { in: uc } } });
    const oldSessions = (
      await prisma.consultSession.findMany({ where: { conversationId: { in: uc } }, select: { id: true } })
    ).map((s) => s.id);
    await prisma.consultSession.deleteMany({ where: { conversationId: { in: uc } } });
    await prisma.bookingSession.deleteMany({ where: { conversationId: { in: uc } } });
    await prisma.painTriageSession.deleteMany({ where: { conversationId: { in: uc } } });
    await prisma.flowSession.deleteMany({ where: { conversationId: { in: uc } } });
    await prisma.staffNotice.deleteMany({ where: { OR: [{ clinicId: { in: ucl } }, { conversationId: { in: uc } }] } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...uc, ...oldSessions] } }, { staffId: { in: uu } }] } });
    await prisma.goldenCase.deleteMany({ where: { clinicId: { in: ucl } } });
    await prisma.pushSubscription.deleteMany({ where: { staffId: { in: uu } } });
    await prisma.routingRule.deleteMany({ where: { OR: [{ clinicId: { in: ucl } }, { name: { startsWith: "E2EHUBB-" } }] } });
    await prisma.knowledgeDoc.deleteMany({ where: { OR: [{ clinicId: { in: ucl } }, { title: { startsWith: "E2EHUBB-" } }] } });
    await prisma.consultProduct.deleteMany({ where: { OR: [{ clinicId: { in: ucl } }, { code: { startsWith: "E2EHUBB-" } }] } });
    await prisma.automationPolicy.deleteMany({ where: { clinicId: { in: ucl } } });
    // T367 建嘅 global lexicon row（createdBy = E2EHUBB admin）— 刪返 = 完全 pre-e2e 狀態
    await prisma.workflowDefinition.deleteMany({ where: { key: "lexicon", createdBy: { in: uu } } });
    await prisma.conversation.deleteMany({ where: { clinicId: { in: ucl } } });
    await prisma.contact.deleteMany({ where: { OR: [{ clinicId: { in: ucl } }, { waId: { startsWith: WA_PREFIX } }] } });
    await prisma.staffClinic.deleteMany({ where: { staffId: { in: uu } } });
    await prisma.clinic.deleteMany({ where: { id: { in: ucl } } });
    await prisma.company.deleteMany({ where: { code: { startsWith: "E2EHUBB-" } } });
    await prisma.staffUser.deleteMany({ where: { id: { in: uu } } });
    // redis sandbox keys
    const r0 = getRedis();
    for (const uid of uu) {
      for (const k of await r0.keys(`sandbox:${uid}:*`)) await r0.del(k);
    }
  }

  // ═══ T370 — 迴歸（**先於本 e2e 建 fixture 跑** — hub-a 有全 DB 斷言（clinic 7 間 / companies A/B/C），
  //     本 e2e 嘅 E2EHUBB- fixture 喺 DB 內就 pollute；hub-a/c3/scrub 全 self-contained 自帶洗。
  //     另 login rate limit 5/60s per-IP：hub-a 5 個 login 貼住 limit → hub-a 同 c3 之間 cool 65s（實錘 2026-09-15））══
  console.log("\nT370 迴歸（先跑 — 淨 DB + login bucket）");
  {
    const { spawnSync } = await import("node:child_process");
    const runRegression = async (name: string, cmd: string[]) => {
      const t0 = Date.now();
      const p = spawnSync(cmd[0], cmd.slice(1), { cwd: process.cwd(), encoding: "utf8", timeout: 600_000, env: process.env });
      const ms = Date.now() - t0;
      const out = ((p.stdout ?? "") + (p.stderr ?? ""));
      const failLines = out.split("\n").filter((l) => l.includes("✘")).slice(-6).join(" | ");
      const tail = out.split("\n").slice(-2).join(" | ").slice(0, 300);
      check(`${name} exit 0（${Math.round(ms / 1000)}s）`, p.status === 0, { status: p.status, failLines: failLines || undefined, tail });
    };
    await runRegression("e2e-hub-a（T350–T355）", ["pnpm", "-s", "tsx", "scripts/e2e-hub-a.ts"]);
    console.log("  … hub-a login 完 — cool 65s（rate limit 窗）");
    await new Promise((r) => setTimeout(r, 65_000));
    await runRegression("e2e-consult-c3", ["pnpm", "-s", "tsx", "scripts/e2e-consult-c3.ts"]);
    await runRegression("e2e-ai-scrub", ["pnpm", "-s", "tsx", "scripts/e2e-ai-scrub.ts"]);
  }

  // ═══ fixtures ═════════════════════════════════════════════════════
  const company = await prisma.company.create({ data: { code: "E2EHUBB-CO", name: "E2EHUBB CO" } });
  const c1 = await prisma.clinic.create({ data: { companyId: company.id, code: "E2EHUBB-C1", name: "E2EHUBB Clinic 1", waPhoneNumberId: "E2EHUBB-C1-PH", waDisplayNumber: "+852 0000 0001" } });
  const c2 = await prisma.clinic.create({ data: { companyId: company.id, code: "E2EHUBB-C2", name: "E2EHUBB Clinic 2", waPhoneNumberId: "E2EHUBB-C2-PH", waDisplayNumber: "+852 0000 0002" } });
  C1 = c1.id;
  C2 = c2.id;
  const admin = await prisma.staffUser.create({
    data: { email: ADMIN_EMAIL, name: "E2EHUBB admin", role: "ADMIN", scopeType: "ALL", passwordHash: await argon2.default.hash(PASS) },
  });
  const scope2 = await prisma.staffUser.create({
    data: { email: SCOPE2_EMAIL, name: "E2EHUBB scope2", role: "ADMIN", scopeType: "CLINICS", passwordHash: await argon2.default.hash(PASS) },
  });
  await prisma.staffClinic.create({ data: { staffId: scope2.id, clinicId: C2, isPrimary: true } });
  ADMIN_ID = admin.id;
  // ④ 警示 fixture：C1 未簽署方案（approvedAt=null）
  await prisma.consultProduct.create({
    data: {
      clinicId: C1,
      workflow: "ORTHODONTIC_CONSULT",
      code: "E2EHUBB-ORTHO",
      displayName: "E2EHUBB 矯齒方案",
      positioning: "e2e 測試方案",
      approvedWording: "e2e 測試文案",
      enabled: true,
      approvedAt: null,
    },
  });
  // ⑦ 警示 fixture：C1 QUESTION L2（code E2EHUBB-C1 無 eval 報告）
  await prisma.automationPolicy.create({ data: { clinicId: C1, category: "QUESTION", level: "L2" } });
  // 知識庫 fixture：C1 PRICE doc（keyword cool牙 — T366 引用 + T367 交叉）
  const doc = await prisma.knowledgeDoc.create({
    data: {
      clinicId: C1,
      kind: "PRICE",
      title: "E2EHUBB 矯齒收費",
      keywords: ["cool牙", "矯齒"],
      body: "e2e 矯齒收費範圍說明。",
      disclaimer: "價格因個體情況而定，以到診評估為準（e2e）。",
      shortDisclaimer: "以到診評估為準",
      priceMin: 20000,
      priceMax: 60000,
      enabled: true,
    },
  });
  // 路由 fixture：C1 規則 keyword cool牙（T366 step⑤ + T367 交叉）
  await prisma.routingRule.create({
    data: {
      clinicId: C1,
      name: "E2EHUBB-rule",
      priority: 900,
      enabled: true,
      intents: ["QUESTION"],
      keywords: ["cool牙"],
      targetType: "STAFF",
      targetStaffId: admin.id,
    },
  });

  // （T370 迴歸已提早到 fixture 之前跑 — 見上方）

  const adminCookie = await cookieFor(ADMIN_EMAIL);
  const scope2Cookie = await cookieFor(SCOPE2_EMAIL);

  // ═══ T360 — Hub 七步摘要數字同 DB 一致 ════════════════════════════
  console.log("\nT360 Hub 七步摘要數字 vs DB");
  {
    const hub = await apiGet("/api/admin/ai", adminCookie);
    check("GET /api/admin/ai 200", hub.status === 200, hub.status);
    const steps = hub.json?.steps ?? [];
    check("七步齊（n=1..7）", steps.length === 7 && steps.every((s: any, i: number) => s.n === i + 1), steps.map((s: any) => s.n));
    check("七步名正確（同 HUB_STEP_CONTRACT）", steps.every((s: any, i: number) => s.name === HUB_STEP_CONTRACT[i][0]), steps.map((s: any) => s.name));
    check("每行有 summary/anchor", steps.every((s: any) => typeof s.summary === "string" && s.summary.length > 0 && typeof s.anchor === "string" && s.anchor.startsWith("/admin/")), undefined);

    // DB 直查（ALL scope = 全店）
    const [kb, products, groups, rules, floorTerms] = await Promise.all([
      prisma.knowledgeDoc.count({ where: { enabled: true } }),
      prisma.consultProduct.findMany({ select: { approvedAt: true, enabled: true } }),
      prisma.skillGroup.count({ where: { enabled: true } }),
      prisma.routingRule.count({ where: { enabled: true } }),
      import("../src/lib/sessions/red-flags").then((m) => m.floorTermSet().size),
    ]);
    const unsigned = products.filter((p) => p.approvedAt === null || !p.enabled).length;
    // 口語表 = 生效詞表口徑（同 getLexicon：DB row 店優先 union；零 row → LEXICON_DEFAULTS）
    const lexWfs = await prisma.workflowDefinition.findMany({ where: { key: "lexicon", status: "ACTIVE" }, select: { clinicId: true, params: true } });
    let lexCount: number;
    if (lexWfs.length === 0) {
      lexCount = LEXICON_DEFAULTS.entries.length;
    } else {
      const m = new Map<string, string>();
      for (const w of lexWfs) if (w.clinicId === null) for (const e of (w.params as any)?.entries ?? []) m.set(e.term, e.canonical);
      for (const w of lexWfs) if (w.clinicId !== null) for (const e of (w.params as any)?.entries ?? []) m.set(e.term, e.canonical);
      lexCount = Math.min(m.size, 60);
    }
    check("① 紅旗 FLOOR 數 = DB", steps[0]?.detail?.floorTerms === floorTerms, { api: steps[0]?.detail?.floorTerms, db: floorTerms });
    check("② 口語表 = 生效詞表", steps[1]?.detail?.lexicon === lexCount, { api: steps[1]?.detail?.lexicon, db: lexCount });
    check("② 觸發詞 FLOOR = 13", steps[1]?.detail?.triggerFloor === 13, { api: steps[1]?.detail?.triggerFloor });
    const ruleKws = new Set<string>();
    for (const r of (await prisma.routingRule.findMany({ where: { enabled: true }, select: { keywords: true } }))) for (const k of r.keywords) ruleKws.add(k);
    check("② 分流詞 = 規則 keyword 並集", steps[1]?.detail?.routingKeywords === ruleKws.size, { api: steps[1]?.detail?.routingKeywords, db: ruleKws.size });
    check("④ 知識庫條數 = DB", steps[3]?.detail?.knowledgeDocs === kb, { api: steps[3]?.detail?.knowledgeDocs, db: kb });
    check("④ 方案數/未簽署 = DB", steps[3]?.detail?.products === products.length && steps[3]?.detail?.productsUnsigned === unsigned, { api: steps[3]?.detail, db: { n: products.length, unsigned } });
    check("⑤ 技能組/路由規則 = DB", steps[4]?.detail?.skillGroups === groups && steps[4]?.detail?.routingRules === rules, { api: steps[4]?.detail, db: { groups, rules } });
    check("健康行 6 項", ["sglang", "redis", "workforce", "meta", "vapid", "sw"].every((id) => (hub.json?.health ?? []).some((h: any) => h.id === id)), hub.json?.health?.map((h: any) => h.id));
  }

  // ═══ T368 — 逐行跳 anchor 正確（純 API 斷言；UI = plain <a href>）══
  console.log("\nT368 七步 anchor 正確");
  {
    const hub = await apiGet("/api/admin/ai", adminCookie);
    for (let i = 0; i < 7; i++) {
      const s = (hub.json?.steps ?? [])[i];
      check(`步${i + 1} anchor = ${HUB_STEP_CONTRACT[i][1]}`, s?.anchor === HUB_STEP_CONTRACT[i][1], s?.anchor);
    }
  }

  // ═══ T361 — 健康警示三態 ══════════════════════════════════════════
  console.log("\nT361 警示三態");
  {
    // (a) ④ 未簽署方案（ALL scope — 數字跟 DB 全店口徑）
    const hubAll = await apiGet("/api/admin/ai", adminCookie);
    const unsignedAll = (
      await prisma.consultProduct.findMany({ select: { approvedAt: true, enabled: true } })
    ).filter((p) => p.approvedAt === null || !p.enabled).length;
    check(
      "(a) ④ 未簽署方案警示 + 數字跟 DB",
      unsignedAll > 0 && (hubAll.json?.steps?.[3]?.warnings ?? []).some((w: string) => w.includes(String(unsignedAll)) && w.includes("未簽署")),
      { warnings: hubAll.json?.steps?.[3]?.warnings, unsignedAll },
    );
    // (b) ④ 知識庫空（scope2 = CLINICS [C2] — C2 零 doc）
    const hubS2 = await apiGet("/api/admin/ai", scope2Cookie);
    check(
      "(b) scope2（C2）④ 知識庫=0 警示",
      hubS2.json?.steps?.[3]?.detail?.knowledgeDocs === 0 && (hubS2.json?.steps?.[3]?.warnings ?? []).includes("知識庫 = 0"),
      { detail: hubS2.json?.steps?.[3]?.detail, warnings: hubS2.json?.steps?.[3]?.warnings },
    );
    check("(b) scope2 店範圍 = 只 C2", hubS2.json?.clinics?.length === 1 && hubS2.json.clinics[0].code === "E2EHUBB-C2", hubS2.json?.clinics);
    // (c) ⑦ L2 開但 eval 未跑（C1 QUESTION L2；code E2EHUBB-C1 無報告）
    check(
      "(c) ⑦ L2 未跑 eval 警示",
      (hubAll.json?.steps?.[6]?.warnings ?? []).some((w: string) => w.includes("E2EHUBB-C1") && w.includes("eval")),
      hubAll.json?.steps?.[6]?.warnings,
    );
    check("(c) ⑦ 摘要含 L2", (hubAll.json?.steps?.[6]?.summary ?? "").includes("L2"), hubAll.json?.steps?.[6]?.summary);
  }

  // ═══ T362 — 沙盤單輪 ══════════════════════════════════════════════
  console.log("\nT362 沙盤單輪");
  let t362: any = null;
  {
    const r = await apiPost("/api/admin/ai-sandbox/run", { clinicId: C1, message: "我想cool牙，幾錢？" }, adminCookie);
    check("POST run 200", r.status === 200, { status: r.status, body: r.json });
    const d = r.json;
    t362 = d;
    check("sandboxId + turn=1 + latency>0", typeof d?.sandboxId === "string" && d.sandboxId.length >= 20 && d.turn === 1 && d.latencyMs > 0, { sid: d?.sandboxId, turn: d?.turn, ms: d?.latencyMs });
    const st = d?.steps ?? [];
    check("七步齊（n=1..7 + status + summary）", st.length === 7 && st.every((s: any, i: number) => s.n === i + 1 && ["ok", "paused", "fail", "skip"].includes(s.status) && typeof s.summary === "string" && s.summary.length > 0), st.map((s: any) => [s.n, s.status]));
    check("intent/urgency 字段", typeof d?.intent === "string" && typeof d?.urgency === "string", { intent: d?.intent, urgency: d?.urgency });
    check("draft 非空（consult 或 price 路徑）", typeof d?.draft === "string" && d.draft.length > 0, (d?.draft ?? "").slice(0, 60));
  }

  // ═══ T364 — 紅旗「面腫」只顯示不升級 ══════════════════════════════
  console.log("\nT364 紅旗只顯示");
  {
    const before = await sideEffectCounts();
    const r = await apiPost("/api/admin/ai-sandbox/run", { clinicId: C1, message: "我牙拔咗之後面腫咗" }, adminCookie);
    check("POST run 200", r.status === 200, r.status);
    const d = r.json;
    const s1 = (d?.steps ?? []).find((s: any) => s.n === 1);
    check("① hit=true + swelling 類", s1?.detail?.hit === true && (s1?.detail?.categories ?? []).includes("swelling"), s1?.detail);
    // 鐵律 3：紅旗只顯示 — 顯示層 = URGENT_PAIN/HIGH/needsHuman（同 worker 快路徑同一計算），DB 層零升級
    check("顯示層：intent=URGENT_PAIN + needsHuman（同 worker 快路徑口徑）", d?.intent === "URGENT_PAIN" && d?.urgency === "HIGH" && d?.needsHuman === true, { intent: d?.intent, urgency: d?.urgency, needsHuman: d?.needsHuman });
    check("顯示層：無草稿（worker 快路徑 draft=null 口徑）", d?.draft === null, d?.draft);
    const after = await sideEffectCounts();
    check("StaffNotice 零新增（唔建通知）", after.staffNotice === before.staffNotice, { before: before.staffNotice, after: after.staffNotice });
    check("Message/AiDraft/ConsultSession/AuditLog 零新增", after.message === before.message && after.aiDraft === before.aiDraft && after.consultSession === before.consultSession && after.auditLog === before.auditLog, { before, after });
    check("AiCallStats 零新增（零用量統計）", after.aiCallTotal === before.aiCallTotal, { before: before.aiCallTotal, after: after.aiCallTotal });
  }

  // ═══ T365 — 多輪 DISCOVER → PRESENT_OPTIONS + TTL + reset ════════
  console.log("\nT365 多輪 + Redis TTL");
  {
    const seq = ["我啲牙好醜，想箍牙改善啲樣", "唔太care人哋點睇我，箍牙主要想咬實啲", "箍牙想快啲搞掂，幾時可以開始", "箍牙想快啲搞掂，幾時可以開始"];
    // 註：ortho DISCOVER 有 3 個 slot 問句（appearance/speed/timeline）→ 3 句行問句 + 第 4 句 PRESENT_OPTIONS（實測 2026-09-15；
    //     2/3 句帶 FLOOR 詞「箍牙」= deterministic trigger（唔靠 LLM sessionTrigger））。
    let sandboxId: string | null = null;
    let stageAt: Record<number, string> = {};
    let t4: any = null;
    for (let i = 0; i < seq.length; i++) {
      const r = await apiPost("/api/admin/ai-sandbox/run", { clinicId: C1, message: seq[i], sandboxId: sandboxId ?? undefined }, adminCookie);
      check(`turn${i + 1} 200`, r.status === 200, { status: r.status, body: (r.json as any)?.error });
      const d = r.json as any;
      sandboxId = d.sandboxId;
      stageAt[i + 1] = d.sessionSnapshot?.stage ?? null;
      if (i === 3) t4 = d;
    }
    check("turn1 DISCOVER（新開 session）", stageAt[1] === "DISCOVER" && t4?.sessionSnapshot?.workflow === "ORTHODONTIC_CONSULT", stageAt);
    check("turn1→turn4 狀態遷移（DISCOVER 行到 PRESENT_OPTIONS）", stageAt[4] === "PRESENT_OPTIONS", stageAt);
    check("turn4 turnCount=4 + lastAction=PRESENT_OPTIONS", t4?.sessionSnapshot?.turnCount === 4 && t4?.sessionSnapshot?.lastAction === "PRESENT_OPTIONS", t4?.sessionSnapshot);
    // Redis TTL 30min
    const redis = getRedis();
    const ttl = await redis.ttl(`sandbox:${ADMIN_ID}:${sandboxId}`);
    check("Redis TTL ∈ (0,1800]", ttl > 0 && ttl <= 1800, ttl);
    // 重新開始 = 清 Redis key
    const rs = await apiPost("/api/admin/ai-sandbox/reset", { sandboxId }, adminCookie);
    check("reset 200", rs.status === 200, rs.status);
    const ttl2 = await redis.ttl(`sandbox:${ADMIN_ID}:${sandboxId}`);
    check("reset 後 TTL 消失（-2）", ttl2 === -2, ttl2);
    // 同 sandboxId 再 run = 新 state（turn 重開）
    const r5 = await apiPost("/api/admin/ai-sandbox/run", { clinicId: C1, message: seq[0], sandboxId }, adminCookie);
    check("reset 後再 run turn=1（state 重開）", r5.status === 200 && (r5.json as any)?.turn === 1, (r5.json as any)?.turn);
    check("reset 後 session 重開（stage=DISCOVER turnCount=1）", (r5.json as any)?.sessionSnapshot?.stage === "DISCOVER" && (r5.json as any)?.sessionSnapshot?.turnCount === 1, (r5.json as any)?.sessionSnapshot);
  }

  // ═══ T363 — 零副作用（snapshot + 沙盤 run + assert + socket 零事件）══
  console.log("\nT363 零副作用");
  {
    const before = await sideEffectCounts();
    // socket 訂閱（admin cookie — ALL scope join 全店 room）；計 C1 相關事件
    const socket: Socket = io(BASE, { extraHeaders: { cookie: adminCookie }, transports: ["websocket"] });
    const c1Events: string[] = [];
    const connected = new Promise<void>((resolve, reject) => {
      socket.on("connect", () => resolve());
      socket.on("connect_error", (e) => reject(e));
      setTimeout(() => reject(new Error("socket connect timeout")), 8000);
    });
    socket.onAny((ev, ...args) => {
      const p = args[0] ?? {};
      if (p && (p.clinicId === C1 || p.conversationId)) c1Events.push(ev);
    });
    try {
      await connected;
    } catch (e) {
      check("socket connect", false, String(e));
      check("（socket 斷 — 以下 DB 斷言仍有效）零新增 DB", false, undefined);
    }
    // run 一輪（C1 普通句 — 非紅旗）
    const r = await apiPost("/api/admin/ai-sandbox/run", { clinicId: C1, message: "想問下洗牙幾錢？" }, adminCookie);
    check("沙盤 run 200（零副作用窗口內）", r.status === 200, r.status);
    await new Promise((res) => setTimeout(res, 1500)); // 俾 push/notify bridge 时间（如有）浮出
    const after = await sideEffectCounts();
    socket.removeAllListeners();
    socket.disconnect();
    const deltas: Record<string, number> = {};
    (Object.keys(before) as (keyof Counts)[]).forEach((k) => (deltas[k] = after[k] - before[k]));
    check("DB 6 類 + AiCallStats 全部零新增", Object.values(deltas).every((d) => d === 0), deltas);
    check("socket 零事件（C1 相關）", c1Events.length === 0, c1Events);
  }

  // ═══ T366 — 同真 pipeline 一致性 ══════════════════════════════════
  console.log("\nT366 沙盤 vs 真 worker");
  {
    const MSG = "我想cool牙，幾錢？";
    // 沙盤
    const sb = await apiPost("/api/admin/ai-sandbox/run", { clinicId: C1, message: MSG }, adminCookie);
    check("沙盤 run 200", sb.status === 200, sb.status);
    const s = sb.json as any;
    // 真 worker：造真 contact/conv/msg + enqueue classify（同 production 同 queue）
    const contact = await prisma.contact.create({
      data: { clinicId: C1, waId: `${WA_PREFIX}T366${Date.now().toString(36)}`, profileName: "E2EHUBB T366" },
    });
    const now = new Date();
    const conv = await prisma.conversation.create({ data: { clinicId: C1, contactId: contact.id, unreadCount: 1, lastMessageAt: now, lastInboundAt: now } });
    const msg = await prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: "IN",
        channel: "API",
        type: "text",
        body: MSG,
        waMessageId: `wamid.${WA_PREFIX.toLowerCase()}t366${Date.now().toString(36)}`,
        waTimestamp: now,
        status: "RECEIVED",
      },
    });
    const q = aiQueueLike();
    await q.add("classify", { conversationId: conv.id, messageId: msg.id, clinicId: C1 }, { jobId: `ai-${msg.id}` });
    let draft: any = null;
    for (let i = 0; i < 60 && !draft; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      draft = await prisma.aiDraft.findUnique({ where: { conversationId_inReplyToMessageId: { conversationId: conv.id, inReplyToMessageId: msg.id } } });
    }
    await q.close();
    check("真 worker 出咗 draft（60s 內）", !!draft, "no draft");
    if (draft) {
      const trace: any = draft.traceJson ?? {};
      check(
        "intent 一致",
        draft.intent === s.intent,
        { sandbox: s.intent, worker: draft.intent },
      );
      check(
        "consult trigger 一致",
        trace?.consult?.trigger === (s.consultTrigger ?? null),
        { sandbox: s.consultTrigger, worker: trace?.consult?.trigger },
      );
      const sbDoc = s.steps?.find((x: any) => x.n === 4)?.detail?.citedPriceDocId;
      const wkDoc = trace?.price?.docId;
      check(
        "引用 priceDoc 一致（C1 fixture doc）",
        wkDoc === doc.id && sbDoc === doc.id,
        { sandbox: sbDoc, worker: wkDoc, fixture: doc.id },
      );
      check("worker trace 有 knowledge.picked 含 fixture doc", (trace?.knowledge?.picked ?? []).some((d: any) => d.id === doc.id), trace?.knowledge?.picked);
    }
  }

  // ═══ T367 — 關鍵詞中心交叉警示 ════════════════════════════════════
  console.log("\nT367 關鍵詞中心");
  {
    const v = await apiGet(`/api/admin/ai/keywords?q=${encodeURIComponent("cool牙")}`, adminCookie);
    check("GET keywords 200", v.status === 200, v.status);
    const row = (v.json?.rows ?? []).find((r: any) => r.term === "cool牙");
    check("詞行存在", !!row, v.json?.rows?.map((r: any) => r.term));
    check("chip 口語表（→矯齒）", row?.lexicon?.canonical === "矯齒", row?.lexicon);
    check("chip 觸發 FLOOR（ORTHODONTIC_CONSULT）", (row?.floorTrigger ?? []).includes("ORTHODONTIC_CONSULT"), row?.floorTrigger);
    check("chip 路由（E2EHUBB-rule）", (row?.routing ?? []).some((x: any) => x.ruleName === "E2EHUBB-rule"), row?.routing);
    check("chip 知識庫（fixture doc）", (row?.knowledge ?? []).some((x: any) => x.docId === doc.id), row?.knowledge);

    // impact（改/刪前彈層數據）
    const imp = await apiGet(`/api/admin/ai/keywords/impact?term=${encodeURIComponent("cool牙")}`, adminCookie);
    check("GET impact 200", imp.status === 200, imp.status);
    check("impact 列路由規則", (imp.json?.affected?.routingRules ?? []).some((x: any) => x.ruleId !== undefined && x.matchedKeyword === "cool牙"), imp.json?.affected?.routingRules);
    check("impact 列知識庫 doc", (imp.json?.affected?.knowledgeDocs ?? []).some((x: any) => x.docId === doc.id), imp.json?.affected?.knowledgeDocs);
    check("impact 列觸發 FLOOR", (imp.json?.affected?.consultTriggerFloor ?? []).includes("ORTHODONTIC_CONSULT"), imp.json?.affected?.consultTriggerFloor);

    // 改口語表（走既有 workflows API：PUT draft + publish {defId}）→ view 跟住變
    const w = await apiGet("/api/admin/workflows", adminCookie);
    check("GET workflows 200", w.status === 200, w.status);
    const lex = (w.json?.workflows ?? []).find((x: any) => x.key === "lexicon");
    const current: { term: string; canonical: string }[] = lex?.active?.params?.entries?.map((e: any) => ({ term: e.term, canonical: e.canonical })) ?? [];
    const base = current.length === 0 ? LEXICON_DEFAULTS.entries.map((e) => ({ term: e.term, canonical: e.canonical })) : current;
    const next = base.map((e) => (e.term === "cool牙" ? { ...e, canonical: "矯齒療程E2E" } : e));
    const put = await fetch(`${BASE}/api/admin/workflows/lexicon`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ clinicId: null, params: { entries: next } }),
    });
    check("PUT lexicon 201", put.status === 201, put.status);
    const { id: draftId } = (await put.json()) as any;
    const pub = await apiPost("/api/admin/workflows/lexicon/publish", { defId: draftId }, adminCookie);
    check("publish 200", pub.status === 200, { status: pub.status, body: pub.json });
    const v2 = await apiGet(`/api/admin/ai/keywords?q=${encodeURIComponent("cool牙")}`, adminCookie);
    const row2 = (v2.json?.rows ?? []).find((r: any) => r.term === "cool牙");
    check("改後 view canonical 跟住變", row2?.lexicon?.canonical === "矯齒療程E2E", row2?.lexicon);
    // impact 跟住變（canonical 改 → doc keyword 比對口徑變：doc keyword「cool牙」= term 照中）
    const imp2 = await apiGet(`/api/admin/ai/keywords/impact?term=${encodeURIComponent("cool牙")}`, adminCookie);
    check("改後 impact 照列受影響 doc", (imp2.json?.affected?.knowledgeDocs ?? []).some((x: any) => x.docId === doc.id), imp2.json?.affected?.knowledgeDocs);

    // revert（publish 返 defaults — 內容行為 = pre-e2e）
    const put2 = await fetch(`${BASE}/api/admin/workflows/lexicon`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ clinicId: null, params: { entries: LEXICON_DEFAULTS.entries.map((e) => ({ term: e.term, canonical: e.canonical })) } }),
    });
    const { id: draftId2 } = (await put2.json()) as any;
    const pub2 = await apiPost("/api/admin/workflows/lexicon/publish", { defId: draftId2 }, adminCookie);
    check("revert publish 200", pub2.status === 200, pub2.status);
    const v3 = await apiGet(`/api/admin/ai/keywords?q=${encodeURIComponent("cool牙")}`, adminCookie);
    const row3 = (v3.json?.rows ?? []).find((r: any) => r.term === "cool牙");
    check("revert 後 canonical 返「矯齒」", row3?.lexicon?.canonical === "矯齒", row3?.lexicon);
  }

  // ═══ T369 — 舊八條 URL 全活 ═══════════════════════════════════════
  console.log("\nT369 舊 URL 全活");
  {
    const urls = ["/admin/workflows", "/admin/knowledge", "/admin/golden", "/admin/skill-groups", "/admin/routing-rules", "/admin/automation", "/admin/suggestions", "/admin/consult"];
    for (const u of urls) {
      const r = await fetch(`${BASE}${u}`, { headers: { cookie: adminCookie }, cache: "no-store" });
      check(`${u} → 200`, r.status === 200, r.status);
    }
  }

  // （T370 迴歸已提早到 login 之前跑 — 見上方）

  // ═══ 收結洗 + 零殘留斷言 ══════════════════════════════════════════
  console.log("\n收結：洗 E2EHUBB- 殘留");
  {
    const clinics = await prisma.clinic.findMany({ where: { code: { startsWith: "E2EHUBB-" } }, select: { id: true } });
    const users = await prisma.staffUser.findMany({ where: { email: { startsWith: "E2EHUBB-" } }, select: { id: true } });
    const clinicIds = clinics.map((c) => c.id);
    const userIds = users.map((u) => u.id);
    const convs = (await prisma.conversation.findMany({ where: { clinicId: { in: clinicIds } }, select: { id: true } })).map((c) => c.id);
    const sessions = (await prisma.consultSession.findMany({ where: { conversationId: { in: convs } }, select: { id: true } })).map((s) => s.id);
    await prisma.message.deleteMany({ where: { OR: [{ conversationId: { in: convs } }, { waMessageId: { startsWith: "wamid.e2ehubb" } }] } });
    await prisma.aiDraft.deleteMany({ where: { conversationId: { in: convs } } });
    await prisma.consultSession.deleteMany({ where: { conversationId: { in: convs } } });
    await prisma.bookingSession.deleteMany({ where: { conversationId: { in: convs } } });
    await prisma.painTriageSession.deleteMany({ where: { conversationId: { in: convs } } });
    await prisma.flowSession.deleteMany({ where: { conversationId: { in: convs } } });
    await prisma.staffNotice.deleteMany({ where: { OR: [{ clinicId: { in: clinicIds } }, { conversationId: { in: convs } }] } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...convs, ...sessions] } }, { staffId: { in: userIds } }] } });
    await prisma.goldenCase.deleteMany({ where: { clinicId: { in: clinicIds } } });
    await prisma.pushSubscription.deleteMany({ where: { staffId: { in: userIds } } });
    await prisma.routingRule.deleteMany({ where: { OR: [{ clinicId: { in: clinicIds } }, { name: { startsWith: "E2EHUBB-" } }] } });
    await prisma.knowledgeDoc.deleteMany({ where: { OR: [{ clinicId: { in: clinicIds } }, { title: { startsWith: "E2EHUBB-" } }] } });
    await prisma.consultProduct.deleteMany({ where: { OR: [{ clinicId: { in: clinicIds } }, { code: { startsWith: "E2EHUBB-" } }] } });
    await prisma.automationPolicy.deleteMany({ where: { clinicId: { in: clinicIds } } });
    await prisma.workflowDefinition.deleteMany({ where: { key: "lexicon", createdBy: { in: userIds } } });
    await prisma.conversation.deleteMany({ where: { clinicId: { in: clinicIds } } });
    await prisma.contact.deleteMany({ where: { OR: [{ clinicId: { in: clinicIds } }, { waId: { startsWith: WA_PREFIX } }] } });
    await prisma.staffClinic.deleteMany({ where: { staffId: { in: userIds } } });
    await prisma.clinic.deleteMany({ where: { id: { in: clinicIds } } });
    await prisma.company.deleteMany({ where: { code: { startsWith: "E2EHUBB-" } } });
    await prisma.staffUser.deleteMany({ where: { id: { in: userIds } } });
    const r2 = getRedis();
    for (const uid of userIds) for (const k of await r2.keys(`sandbox:${uid}:*`)) await r2.del(k);

    const left = await Promise.all([
      prisma.clinic.count({ where: { code: { startsWith: "E2EHUBB-" } } }),
      prisma.staffUser.count({ where: { email: { startsWith: "E2EHUBB-" } } }),
      prisma.knowledgeDoc.count({ where: { title: { startsWith: "E2EHUBB-" } } }),
      prisma.routingRule.count({ where: { name: { startsWith: "E2EHUBB-" } } }),
      prisma.consultProduct.count({ where: { code: { startsWith: "E2EHUBB-" } } }),
      prisma.message.count({ where: { waMessageId: { startsWith: "wamid.e2ehubb" } } }),
    ]);
    check("零殘留（clinic/user/doc/rule/product/msg 全 0）", left.every((n) => n === 0), left);
  }

  await prisma.$disconnect();
  console.log(failures === 0 ? "\nHUBB-ALL OK" : `\nHUBB-FAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[e2e-hub-b] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});

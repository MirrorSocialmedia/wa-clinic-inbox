/**
 * e2e-consult-c4 — consult v2.1 C4（§5 Claim Guard + §6 LLM 兩次 call + §7 seed）scripted e2e
 *
 * 前置：dev stack live（server 3100 / DB 15432 / worker AI_MOCK=1 + NODE_EXTRA_CA_CERTS）+
 *   seed-consult-content 已跑（5 條 global row，3 箍牙 approvedAt=null + 2 植牙 enabled=false）。
 * 跑法（repo root）：pnpm tsx scripts/e2e-consult-c4.ts
 *
 * 覆蓋（fixture 前綴 e2ec4）— 真 pipeline（webhook → worker → engine → LLM mock → guards → draft）：
 *   M   主對話：slot 入 DB（extract）→ 下 turn 生效（askedSlot 推進唔重問）→ PRESENT_OPTIONS
 *       （approved 產品 e2ec4P 入草稿 + candidateCategory=CLEAR_ALIGNER）
 *   P   ANSWER_PRICE：PRICE doc「e2ec4 箍牙（矯齒）收費」8000–30000 → mock 草稿含範圍 + shortDisclaimer
 *   X   extract 失敗降級（E2E-CONSULT-EXTRACT-FAIL）：draft 保留（降級 QUESTION 回覆）+
 *       state 不變（零 CONSULT_EXTRACT / slots {}）+ audit extractFailed + worker log
 *   CG1..CG9  每條 CG 一 turn（bait 句）：BLOCK → CLAIM_HUMAN_TEXT + audit CONSULT_CLAIM_GUARD_BLOCK
 *       （meta.code 逐條對）；CG-007 = price-guard ① 先擋（pipeline 設計）→ NO_PRICE_TEXT + 零金額
 *   I   植牙對話：IMPLANT_CONSULT 觸發 + 佔位產品（enabled=false）零出現喺草稿
 *   FE  鐵律斷言：全部草稿零出現 unapproved seed 產品（3 箍牙 + 2 植牙）之 displayName/brand/timeWording/avoidPhrase
 *
 * ★ R-7 first-reply（既有 routing「高價值療程」global rule — kw 矯齒/植牙 + NEW patient + 首覆 template）
 *   會食走每條對話第一條命中詞 message 嘅 draft（model=routing-r7）。每對話先 warm-up 一擊
 *   （「我想箍牙」/「我想做植牙」）耗 R-7 原子閘（routedFirstReplyAt），之後先入 C4 測試 turn。
 *   warm-up 同時做 engine turn 1（ASK_DISCOVERY 第一問）— 測試 turn 由 engine turn 2 起。
 *
 * 口徑：
 *   - LLM call 數 = 主 classify(1) + extract(1) + generate(1) ≤ 3/turn（audit CONSULT_LLM_TURN.meta.calls 驗）
 *   - suppressDraft turn 零 LLM call（C3 回歸覆蓋；本 e2e I 段 turn 2 亦驗 — action null → 零 LLM）
 *   - CG-007 喺 pipeline 由 price-guard ① 先擋（同邏輯 — unit 獨立驗 CG-007 命中；MD §5 順序 = re-check）
 *
 * 冪等：開場 pre-sweep + 收場 end-sweep + fatal sweep（e2ec4 前綴全洗）。
 * 退出碼：0 = 全過；1 = 有 fail。
 */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { CLAIM_HUMAN_TEXT } from "../src/lib/ai/claim-guard";
import { NO_PRICE_TEXT } from "../src/lib/ai/price-guard";

const BASE = "http://127.0.0.1:3100";
const REPO = new URL("..", import.meta.url).pathname;
const WORKER_LOG = "/tmp/c4-worker.log";
const prisma = new PrismaClient();

const WIDS = [
  "e2ec4-main", "e2ec4-price", "e2ec4-xfail", "e2ec4-implant",
  "e2ec4-cg1", "e2ec4-cg2", "e2ec4-cg3", "e2ec4-cg4", "e2ec4-cg5",
  "e2ec4-cg6", "e2ec4-cg7", "e2ec4-cg8", "e2ec4-cg9", "e2ec4-dbg1", "e2ec4-dbg2",
];
const CODE_PREFIX = "e2ec4";

// §7 seed（global）— 鐵律斷言用（unapproved 資料零出現）
const SEED_FORBIDDEN = [
  "傳統固定牙箍", "Invisalign I GO", "完整 Invisalign", "Hiossen", "Straumann",
  "一年至兩年左右", "最快可以約 6 個月", "12–18 個月",
  "所有複雜個案一定要傳統", "你想快所以 I GO 最適合你", "I Full 一定適合複雜個案",
];

let pass = 0;
let fail = 0;
let sweepRef: ((label: string) => Promise<void>) | null = null;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`);
  }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function poll<T>(what: string, fn: () => Promise<T | null>, timeoutMs = 30_000, intervalMs = 700): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    let v: T | null = null;
    try {
      v = await fn();
    } catch (e) {
      console.error(`    [poll ${what}] transient: ${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}`);
    }
    if (v !== null) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`poll timeout: ${what}`);
    await sleep(intervalMs);
  }
}

// ── API helper ────────────────────────────────────────────────────────
async function login(email: string, pw: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: pw }),
  });
  if (!res.ok) throw new Error(`login ${email} → ${res.status}`);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error("login: no cookie");
  return cookie;
}
async function api(cookie: string, path: string, method: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* non-json */
  }
  return { status: res.status, json: json as Record<string, unknown> | null };
}

// ── inbound / helpers ─────────────────────────────────────────────────
/** 病人 inbound（mock webhook）— 等 IN Message 落庫。 */
async function inbound(waId: string, text: string): Promise<{ msgId: string; convId: string }> {
  let spawnErr: Error | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const c = spawn("pnpm", ["-s", "mock-inbound", "message", "--clinic", "TKW", "--from", waId, "--text", text], {
          cwd: REPO,
          stdio: "inherit",
        });
        c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`mock-inbound exit ${code}`))));
      });
      spawnErr = null;
      break;
    } catch (err) {
      spawnErr = err as Error;
      if (attempt < 2) {
        console.log(`  （mock-inbound attempt ${attempt} 失敗 — loadManifest flake 重試 1 次）`);
        await sleep(4000);
      }
    }
  }
  if (spawnErr) throw spawnErr;
  return poll(`IN message ${waId} ${text.slice(0, 14)}`, async () => {
    const msg = await prisma.message.findFirst({ where: { direction: "IN", body: text }, orderBy: { createdAt: "desc" } });
    if (!msg) return null;
    const conv = await prisma.conversation.findUnique({ where: { id: msg.conversationId } });
    const contact = conv ? await prisma.contact.findFirst({ where: { id: conv.contactId } }) : null;
    return contact?.waId === waId && conv ? { msgId: msg.id, convId: conv.id } : null;
  });
}

const activeSession = (convId: string) =>
  prisma.consultSession.findFirst({ where: { conversationId: convId, terminal: null } });

/** 等 draft（inReplyToMessageId 精確）+ 指定 audit row（sessionId 對）。 */
async function waitDraftAndAudit(convId: string, msgId: string, auditAction: string, timeoutMs = 45_000) {
  return poll(`draft+${auditAction} ${msgId.slice(0, 10)}`, async () => {
    const d = await prisma.aiDraft.findFirst({ where: { conversationId: convId, inReplyToMessageId: msgId } });
    if (!d) return null;
    const s = await activeSession(convId);
    if (!s) return null;
    const a = await prisma.auditLog.findFirst({ where: { action: auditAction, entityId: s.id }, orderBy: { createdAt: "desc" } });
    if (!a) return null;
    return { d, s, a };
  }, timeoutMs);
}

async function waitDraft(convId: string, msgId: string, timeoutMs = 45_000) {
  return poll(`draft ${msgId.slice(0, 10)}`, async () =>
    prisma.aiDraft.findFirst({ where: { conversationId: convId, inReplyToMessageId: msgId } }), timeoutMs);
}

/** warm-up 一擊：耗 R-7 first-reply 原子閘（routedFirstReplyAt）+ engine turn 1。 */
async function warmup(waId: string, text: string): Promise<{ convId: string; msgId: string }> {
  const t = await inbound(waId, text);
  await waitDraft(t.convId, t.msgId);
  return t;
}

/** worker log 出現次數（extract 失敗 log 驗）。 */
function workerLogCount(needle: string): number {
  try {
    const txt = readFileSync(WORKER_LOG, "utf8");
    return txt.split(needle).length - 1;
  } catch {
    return 0;
  }
}

// ── sweep ─────────────────────────────────────────────────────────────
async function sweep(label: string): Promise<void> {
  try {
    const contacts = await prisma.contact.findMany({ where: { waId: { in: WIDS } }, select: { id: true } });
    const allConv = contacts.map((c) => c.id);
    if (allConv.length > 0) {
      await prisma.$transaction([
        prisma.aiDraft.deleteMany({ where: { conversationId: { in: allConv } } }),
        prisma.auditLog.deleteMany({ where: { entityId: { in: allConv } } }),
        prisma.consultSession.deleteMany({ where: { conversationId: { in: allConv } } }),
        prisma.message.deleteMany({ where: { conversationId: { in: allConv } } }),
        prisma.conversation.deleteMany({ where: { id: { in: allConv } } }),
      ]);
    }
    await prisma.contact.deleteMany({ where: { waId: { in: WIDS } } });
    await prisma.consultProduct.deleteMany({ where: { code: { startsWith: CODE_PREFIX } } });
    await prisma.knowledgeDoc.deleteMany({ where: { title: "e2ec4 箍牙（矯齒）收費" } });
    console.log(`[sweep:${label}] 完成`);
  } catch (e) {
    console.error(`[sweep:${label}] FAILED:`, e instanceof Error ? e.message : e);
  }
}
sweepRef = sweep;

// ── main ──────────────────────────────────────────────────────────────
void (async () => {
  await sweep("pre");

  const credsText = readFileSync(new URL("../.dev/credentials.txt", import.meta.url).pathname, "utf8");
  const adminLine = credsText.split("\n").find((l) => l.startsWith("ADMIN:")) ?? "";
  const [adminEmail, adminPw] = adminLine.split(": ").slice(1).join(": ").split(" / ");
  if (!adminEmail || !adminPw) throw new Error("credentials: missing ADMIN");
  const adminCookie = await login(adminEmail, adminPw);
  const clinic = await prisma.clinic.findUnique({ where: { code: "TKW" } });
  if (!clinic) throw new Error("TKW clinic not found");
  const tkw = clinic.id;

  // ── fixtures：PRICE doc + approved 產品 ──────────────────────────────
  const docRes = await api(adminCookie, "/api/admin/knowledge", "POST", {
    clinicId: tkw,
    kind: "PRICE",
    title: "e2ec4 箍牙（矯齒）收費",
    keywords: ["箍牙", "矯齒", "e2ec4隱適美"],
    body: "病例複雜度",
    disclaimer: "以上費用只係參考，實際費用要視乎牙齒情況，評估後先確認。",
    shortDisclaimer: "以到診評估為準",
    priceMin: 8000,
    priceMax: 30000,
  });
  check("PRICE doc「e2ec4 箍牙（矯齒）收費」8000–30000 建立", docRes.status === 200, JSON.stringify(docRes.json).slice(0, 150));
  const pRes = await api(adminCookie, "/api/admin/consult-products", "POST", {
    clinicId: tkw,
    workflow: "ORTHODONTIC_CONSULT",
    code: "e2ec4P",
    displayName: "e2ec4隱適美",
    brand: "e2ec4igo",
    positioning: "e2ec4 隱形、e2ec4 快速",
    approvedWording: "e2ec4 批准講法",
    avoidPhrases: ["e2ec4 禁止講法"],
    sortOrder: 1,
    approvedBy: "e2e",
    approvedAt: new Date().toISOString(),
  });
  check("approved 產品 e2ec4P 建立 → 201", pRes.status === 201, JSON.stringify(pRes.json).slice(0, 150));
  // global seed 核（5 條、3 箍牙 approvedAt=null、2 植牙 enabled=false）
  const seeds = await prisma.consultProduct.findMany({ where: { clinicId: null } });
  check("global seed = 5 條", seeds.length === 5, String(seeds.length));
  check("3 箍牙 seed approvedAt=null（等醫生確認）", seeds.filter((s) => s.workflow === "ORTHODONTIC_CONSULT").every((s) => s.approvedAt === null));
  check("2 植牙佔位 enabled=false", seeds.filter((s) => s.workflow === "IMPLANT_CONSULT").every((s) => s.enabled === false));

  const allDrafts: string[] = []; // FE 鐵律：全部草稿收埋統一掃
  const collect = (d: { draftText: string } | null) => {
    if (d) allDrafts.push(d.draftText);
    return d;
  };

  // ── M 主對話：warm-up（R-7 + engine t1）→ slot 入 DB → 下 turn 生效 → PRESENT_OPTIONS ──
  console.log("\n[M] 主對話（warm-up 耗 R-7，之後係 C4 路徑）");
  {
    const w = await warmup("e2ec4-main", "我想箍牙");
    const dwRow = await prisma.aiDraft.findFirst({ where: { conversationId: w.convId, inReplyToMessageId: w.msgId } });
    collect(dwRow);
    check("M-warmup R-7 first-reply 生效（model=routing-r7）", dwRow?.model === "routing-r7", String(dwRow?.model));
    const s0 = await activeSession(w.convId);
    check("M-warmup engine turn 1：session 建 + ASK_DISCOVERY（appearance）", s0?.lastAction === "ASK_DISCOVERY" && JSON.stringify(s0?.askedSlots) === JSON.stringify(["appearancePriority"]), JSON.stringify({ la: s0?.lastAction, asked: s0?.askedSlots }));
  }

  console.log("\n[M2] T2「箍牙想靚啲」→ extract 寫 appearancePriority=HIGH（入 DB）+ 下 turn 生效（問 speed 唔重問 appearance）");
  {
    const t = await inbound("e2ec4-main", "箍牙想靚啲，最緊要靚");
    const { d, s } = await waitDraftAndAudit(t.convId, t.msgId, "CONSULT_LLM_TURN");
    const dd = collect(d)!;
    check("T2 slots.appearancePriority=HIGH（extract 入 DB）", (s.slots as Record<string, unknown>).appearancePriority === "HIGH", JSON.stringify(s.slots));
    const ex = await prisma.auditLog.findFirst({ where: { action: "CONSULT_EXTRACT", entityId: s.id }, orderBy: { createdAt: "desc" } });
    check("T2 audit CONSULT_EXTRACT applied 含 appearancePriority", !!ex && JSON.stringify((ex.meta as { applied?: string[] }).applied).includes("appearancePriority"), JSON.stringify(ex?.meta).slice(0, 150));
    check("T2 draft = ASK_DISCOVERY 問 speed（逐字）", dd.draftText === "Hello☺️ 多謝你查詢！想多了解下，你比唔比重視快啲做完？", dd.draftText);
    check("T2 askedSlots 推進（appearance+speed）", s.askedSlots.includes("appearancePriority") && s.askedSlots.includes("speedPriority"), JSON.stringify(s.askedSlots));
    check("T2 action=ASK_DISCOVERY（engine 本 turn 入場時 min 未齊）", s.lastAction === "ASK_DISCOVERY", String(s.lastAction));
  }

  console.log("\n[M3] T3「箍牙，嗯，了解。」→ #17 PRESENT_OPTIONS（appearance HIGH → CLEAR_ALIGNER + approved 產品入草稿）");
  {
    const t = await inbound("e2ec4-main", "箍牙，嗯，了解。");
    const { d, s, a } = await waitDraftAndAudit(t.convId, t.msgId, "CONSULT_ENGINE_TURN");
    const dd = collect(d)!;
    const meta = a.meta as { row?: number; ruleId?: string | null };
    check("T3 engine row 17 + stage=PRESENT_OPTIONS", meta.row === 17 && s.stage === "PRESENT_OPTIONS", JSON.stringify({ row: meta.row, st: s.stage }));
    check("T3 candidateCategory=CLEAR_ALIGNER（DB）+ ruleId ORTHO-001（audit）", s.candidateCategory === "CLEAR_ALIGNER" && meta.ruleId === "ORTHO-001", JSON.stringify({ cc: s.candidateCategory, ruleId: meta.ruleId }));
    check("T3 draft 含 approved 產品 e2ec4隱適美", dd.draftText.includes("e2ec4隱適美"), dd.draftText);
    check("T3 draft 含「實際邊款適合你要睇返牙齒情況」", dd.draftText.includes("實際邊款適合你要睇返牙齒情況"), dd.draftText);
  }

  // ── P ANSWER_PRICE priceRange ───────────────────────────────────────
  console.log("\n[P] ANSWER_PRICE：指名 approved 產品問價 → #14 + mock 草稿含 PRICE doc 範圍");
  {
    await warmup("e2ec4-price", "我想箍牙");
    const t = await inbound("e2ec4-price", "e2ec4隱適美箍牙幾錢？");
    const { d, s, a } = await waitDraftAndAudit(t.convId, t.msgId, "CONSULT_ENGINE_TURN");
    const dd = collect(d)!;
    const meta = a.meta as { row?: number };
    check("P engine row 14 + lastAction=ANSWER_PRICE", meta.row === 14 && s.lastAction === "ANSWER_PRICE", JSON.stringify({ row: meta.row, la: s.lastAction }));
    check("P draft 含範圍 8000–30000", dd.draftText.includes("8000–30000"), dd.draftText);
    check("P draft 含 shortDisclaimer「以到診評估為準」（高價值口徑）", dd.draftText.includes("以到診評估為準"), dd.draftText);
    check("P draft 唔含完整 disclaimer（高價值用 short）", !dd.draftText.includes("以上費用只係參考"), dd.draftText);
  }

  // ── X extract 失敗降級 ──────────────────────────────────────────────
  console.log("\n[X] extract 失敗降級（E2E-CONSULT-EXTRACT-FAIL）→ draft 保留 + state 不變");
  {
    const logBefore = workerLogCount("consult: extract failed");
    await warmup("e2ec4-xfail", "我想箍牙");
    const t = await inbound("e2ec4-xfail", "我想箍牙 E2E-CONSULT-EXTRACT-FAIL 想問吓");
    const d = await waitDraft(t.convId, t.msgId);
    collect(d);
    const s = await activeSession(t.convId);
    check("X 降級：draft 存在（原 classify draft 保留）", !!d && d.draftText.length > 0, String(d?.draftText).slice(0, 120));
    check("X state 不變：slots 空（extract 失敗唔寫 slot）", !!s && Object.keys((s.slots ?? {}) as object).length === 0, JSON.stringify(s?.slots));
    const ex = s ? await prisma.auditLog.findMany({ where: { action: "CONSULT_EXTRACT", entityId: s.id } }) : [];
    check("X state 不變：無 CONSULT_EXTRACT 含 applied slot（失敗 turn 零寫入）", ex.every((e) => {
      const applied = (e.meta as { applied?: string[] }).applied;
      return !Array.isArray(applied) || applied.length === 0;
    }), JSON.stringify(ex.map((e) => e.meta)).slice(0, 150));
    const a = s ? await prisma.auditLog.findFirst({ where: { action: "CONSULT_LLM_TURN", entityId: s.id }, orderBy: { createdAt: "desc" } }) : null;
    const meta = (a?.meta ?? {}) as { extractFailed?: boolean; calls?: number };
    check("X audit CONSULT_LLM_TURN{extractFailed:true, calls:0}", !!a && meta.extractFailed === true && meta.calls === 0, JSON.stringify(meta));
    const logAfter = workerLogCount("consult: extract failed");
    check("X worker log「consult: extract failed」+1", logAfter === logBefore + 1, `${logBefore} → ${logAfter}`);
  }

  // ── CG-001..009 ─────────────────────────────────────────────────────
  console.log("\n[CG] Claim Guard 9 條（warm-up 耗 R-7 → bait turn → BLOCK + 人手提示 + trace code）");
  const CG_CASES: { code: string; waId: string }[] = [
    { code: "CG-001", waId: "e2ec4-cg1" },
    { code: "CG-002", waId: "e2ec4-cg2" },
    { code: "CG-003", waId: "e2ec4-cg3" },
    { code: "CG-004", waId: "e2ec4-cg4" },
    { code: "CG-005", waId: "e2ec4-cg5" },
    { code: "CG-006", waId: "e2ec4-cg6" },
    { code: "CG-007", waId: "e2ec4-cg7" },
    { code: "CG-008", waId: "e2ec4-cg8" },
    { code: "CG-009", waId: "e2ec4-cg9" },
  ];
  for (const cg of CG_CASES) {
    await warmup(cg.waId, "我想箍牙");
    const bait = `我想箍牙 E2E-${cg.code} 想問吓`;
    const t = await inbound(cg.waId, bait);
    const { d, s } = await waitDraftAndAudit(t.convId, t.msgId, "CONSULT_LLM_TURN");
    const dd = collect(d)!;
    if (cg.code === "CG-007") {
      // pipeline 口徑：price-guard ①（金額零 PRICE doc）先擋 → NO_PRICE_TEXT（CG-007 = 同邏輯 re-check，unit 獨立驗）
      check(`${cg.code} price-guard 先擋 → NO_PRICE_TEXT（人手提示）`, dd.draftText === NO_PRICE_TEXT, dd.draftText);
      check(`${cg.code} 零金額「500」出現`, !dd.draftText.includes("500"), dd.draftText);
      const cgAudit = s ? await prisma.auditLog.findFirst({ where: { action: "CONSULT_CLAIM_GUARD_BLOCK", entityId: s.id } }) : null;
      check(`${cg.code} 無 claim-guard BLOCK（price-guard 已攔 — 設計口徑）`, cgAudit === null);
      continue;
    }
    check(`${cg.code} BLOCK → 草稿 = CLAIM_HUMAN_TEXT（MD §5 逐字）`, dd.draftText === CLAIM_HUMAN_TEXT, dd.draftText);
    const cgAudit = s
      ? await prisma.auditLog.findFirst({ where: { action: "CONSULT_CLAIM_GUARD_BLOCK", entityId: s.id }, orderBy: { createdAt: "desc" } })
      : null;
    const meta = (cgAudit?.meta ?? {}) as { code?: string; codes?: string[] };
    check(`${cg.code} trace：CONSULT_CLAIM_GUARD_BLOCK meta.code=${cg.code}`, !!cgAudit && meta.code === cg.code, JSON.stringify(meta));
    check(`${cg.code} codes 含 ${cg.code}`, Array.isArray(meta.codes) && meta.codes.includes(cg.code), JSON.stringify(meta.codes));
  }

  // ── I 植牙（佔位唔入草稿） ───────────────────────────────────────────
  console.log("\n[I] 植牙對話：IMPLANT_CONSULT 觸發 + 佔位產品（enabled=false）零出現 + turn 2 零 LLM call");
  {
    const w = await warmup("e2ec4-implant", "我想做植牙");
    collect(await prisma.aiDraft.findFirst({ where: { conversationId: w.convId, inReplyToMessageId: w.msgId } }));
    const s0 = await activeSession(w.convId);
    check("I-warmup workflow=IMPLANT_CONSULT + askedSlots=[missingCount]", s0?.workflow === "IMPLANT_CONSULT" && JSON.stringify(s0?.askedSlots) === JSON.stringify(["missingCount"]), JSON.stringify({ wf: s0?.workflow, asked: s0?.askedSlots }));

    const t = await inbound("e2ec4-implant", "我想做植牙，想問吓");
    const d = await waitDraft(t.convId, t.msgId);
    collect(d);
    const s1 = await activeSession(t.convId);
    check("I turn 2 engine row 16 + askedSlots 推進（missingCount+missingDuration）", JSON.stringify(s1?.askedSlots) === JSON.stringify(["missingCount", "missingDuration"]), JSON.stringify(s1?.askedSlots));
    check("I turn 2 draft = ASK_DISCOVERY 問 missingDuration（逐字）", d?.draftText === "Hello☺️ 多謝你查詢！想多了解下，缺咗大概幾耐？", d?.draftText ?? "no draft");
    check("I 佔位產品零出現（Hiossen/Straumann 唔喺草稿）", d ? !d.draftText.includes("Hiossen") && !d.draftText.includes("Straumann") : false, d?.draftText ?? "no draft");
  }

  // ── FE 鐵律：unapproved 資料零出現 ───────────────────────────────────
  console.log("\n[FE] 鐵律：全部草稿零出現 unapproved seed 產品資料");
  for (const forbidden of SEED_FORBIDDEN) {
    const hit = allDrafts.find((dr) => dr.includes(forbidden));
    check(`零出現「${forbidden}」`, hit === undefined, hit?.slice(0, 120) ?? "");
  }

  // ── summary ─────────────────────────────────────────────────────────
  await sweep("end");
  console.log(`\n${pass + fail} checks: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error("FATAL:", err);
  sweepRef?.("fatal").finally(() => process.exit(1));
});

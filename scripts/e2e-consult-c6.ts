/**
 * e2e-consult-c6 — cwi-consult-20260910b C6（MD §9 全量測試 + §10 驗收）e2e
 *
 * 範圍：
 *   §9.1 unit：decide() 25 transition｜chooseNextQuestion 唔重複｜purchaseIntent Δ+clamp｜
 *              triggerFloor｜claim-guard CG-001~009 各 1 positive + 1 negative｜
 *              isProductUsable（approvedAt=null 唔入檢索）
 *   §9.2 GoldenCase 23 條（真 pipeline，mock LLM）— 每 GC 獨立 conv + 唯一 wamid
 *   §9.3 迴歸由 e2e-consult-c4 + e2e-rt-smoke 獨立重跑（本 script 唔重複）
 *   收口：草稿禁詞審計（你最適合/你一定/保證/成功率/好過 零出現）+ LLM call ≤3/turn 審計
 *
 * fixture（e2ec6 前綴 — sweep 全洗）：
 *   clinic e2ec6（aiMode 預設 DRAFT → L1 fallback：草稿 PROPOSED 無 auto-send —
 *     GC-19 adopt/typed 語義乾淨）+ 3 ConsultProduct（igo/ifull approved、trad approvedAt=null）
 *   + PRICE doc「e2ec6 箍牙（矯齒）收費」（30000–60000；keyword 含獨有 "I GO" 保證 citation 贏）
 *   ★ 新 clinic 無 SkillGroupClinic → R-7 高價值療程（GROUP rule）唔 mark → 無 R-7 首覆干擾。
 *
 * 設計判定（MD 字面 vs mock pipeline — 全記錄，斷言唔鬆）：
 *   D1 GC-01：MD m2「而家塊面腫咗」無 FLOOR → mock sessionTrigger=null（設計如此）→ engine
 *      唔會喺 m2 run（真 LLM 可由 context 推 trigger — mock 限制非 pipeline bug）。
 *      拆兩段驗：m2 = urgent 硬安全（conv.urgent + URGENT_ESCALATION + 零草稿）；
 *      m3（加 FLOOR「箍牙」，同一臨床場景）= engine row 0 → terminal=HANDOFF。三期望全覆蓋。
 *   D1b GC-03：MD 句「係咪一定要脫牙先箍到？」無 FLOOR 字面（先箍到 ≠ 箍牙）→ 加前綴「我想箍牙，」（同 D1 mock 限制）。
 *   D2 GC-04：IGO timeWording = e2ec6-igo fixture（語義 = 全球 IGO seed 原句）；
 *      全球 seed approvedAt=null → 唔 usable（§7 鐵律 — GC-21 亦驗呢條）。
 *   D3 GC-14：「箍牙幾錢？」無指名產品 → engine row 16（一條 discovery 問題；row 14
 *      ANSWER_PRICE 需 namedProduct — §4.2 設計）。14a 驗 row 16 一條問題；
 *      14b（「I GO 最平幾錢」named brand）驗 KB 價格範圍 30000–60000 入草稿。
 *      MD 字面「價格範圍+discovery 問題」兩者唔會喺同一 draft（row 14 出價無問題句、
 *      row 16 出問題無價）→ 差異入 CEO 報告（非 code 缺陷）。
 *   D4 GC-16：mock CG-007 bait =「我哋可以俾 $500 做到。」（MD 示例 $15000 — 機制同：
 *      金額出範圍）；呢個 turn 無 PRICE citation（priceIntent=false）→ price-guard ①
 *      先擋（CG-007 出範圍邏輯 ③ 由 unit 獨立驗）→ NO_PRICE_TEXT。
 *   D5 GC-20：m1 建 session → DB 直寫 lastInboundAt/lastMessageAt=25h 前 + 25h IN msg
 *      + e2e:ai-job requeue（真 pipeline 過窗）→ row 4 WINDOW_EXPIRED_HANDOFF。
 *      MD「我諗好喇，想約」加 FLOOR「箍牙」（mock trigger 需要 — 同 D1）。
 *   D6 GC-19：e2ec6 DRAFT mode → 草稿 PROPOSED 無 auto-send → adopt 先至係首個 OUT。
 *   D7 GC-02：m2「但我隻牙好痛」無 FLOOR → engine 唔 run（同 D1）；PAIN intent 本身
 *      開既有 pain triage（worker 獨立路徑 — 同 C1 S1 口徑），斷言 pain session +
 *      零金額零推銷 + consult session turnCount 不變。
 *
 * 冪等：開場 pre-sweep + 收場 end-sweep + fatal sweep（e2ec6 前綴全洗）。
 * 用法（repo root）：pnpm tsx scripts/e2e-consult-c6.ts [--base http://127.0.0.1:3100]
 * 輸出：C6-OK (N pass) / C6-FAIL: <reason>
 */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { CLAIM_HUMAN_TEXT } from "../src/lib/ai/claim-guard";
import { NO_PRICE_TEXT } from "../src/lib/ai/price-guard";
import {
  consultTransition,
  chooseNextQuestion,
  minimumSlotsMet,
  computePurchaseIntentDelta,
  clampIntent,
  applyIdleExpiry,
  type ConsultSessionState,
  type ConsultSignals,
  type ConsultSlots,
} from "../src/lib/sessions/consult-engine";
import { triggerFloor } from "../src/lib/sessions/consult-trigger";
import { isProductUsable } from "../src/lib/sessions/consult-products";
import { runClaimGuard, type ClaimGuardProductCtx } from "../src/lib/ai/claim-guard";

const BASE = (process.argv.includes("--base")
  ? process.argv[process.argv.indexOf("--base") + 1]
  : "http://127.0.0.1:3100"
).replace(/\/$/, "");
const REPO = new URL("..", import.meta.url).pathname;
const prisma = new PrismaClient();

// ── fixture constants ─────────────────────────────────────────────────
const CLINIC_CODE = "e2ec6";
const DOC_TITLE = "e2ec6 箍牙（矯齒）收費";
const P_IGO = "E2EC6IGO";
const P_IFULL = "E2EC6IFULL";
const P_TRAD = "E2EC6TRAD";
const BANNED_WORDS = ["你最適合", "你一定", "保證", "成功率", "好過"];

let pass = 0;
let fail = 0;
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

async function poll<T>(what: string, fn: () => Promise<T | null>, timeoutMs = 45_000, intervalMs = 800): Promise<T> {
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
async function api(cookie: string, p: string, method: string, body?: unknown) {
  const res = await fetch(`${BASE}${p}`, {
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

// ── mock inbound（唯一 wamid + 精確 poll 鎖定 + loadManifest flake 重試）────
let wamidSeq = 0;
function newWamid(prefix: string): string {
  wamidSeq += 1;
  return `wamid.MOCK${prefix}${Date.now().toString(36)}${wamidSeq.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
function runScript(args: string[], expectOut: string | null = null): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = spawn("pnpm", ["-s", ...args], { cwd: REPO });
    let buf = "";
    c.stdout.on("data", (d: Buffer) => (buf += d.toString()));
    c.stderr.on("data", (d: Buffer) => (buf += d.toString()));
    c.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${args[0]} exit ${code}: ${buf.slice(0, 200)}`));
      if (expectOut && !buf.includes(expectOut)) return reject(new Error(`${args[0]}: no ${expectOut} in ${buf.slice(0, 200)}`));
      resolve(buf);
    });
  });
}
async function inbound(waId: string, text: string): Promise<{ msgId: string; convId: string }> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const wamid = newWamid(`e2ec6${wamidSeq}`);
    try {
      await runScript(["mock-inbound", "message", "--clinic", CLINIC_CODE, "--from", waId, "--text", text, "--wamid", wamid]);
      const m = await poll(
        `IN message ${text.slice(0, 14)}`,
        async () => {
          const row = await prisma.message.findUnique({ where: { waMessageId: wamid } });
          return row && row.direction === "IN" ? row : null;
        },
        30_000,
      );
      return { msgId: m.id, convId: m.conversationId };
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      console.log(`  （inbound attempt ${attempt} 失敗 — 重試）`);
      await sleep(2000);
    }
  }
  throw lastErr ?? new Error("inbound failed");
}

// ── poll helpers ──────────────────────────────────────────────────────
const draftOf = (msgId: string) => prisma.aiDraft.findFirst({ where: { inReplyToMessageId: msgId } });
const activeSession = (convId: string) =>
  prisma.consultSession.findFirst({ where: { conversationId: convId, terminal: null } });
const anySession = (convId: string) => prisma.consultSession.findFirst({ where: { conversationId: convId }, orderBy: { createdAt: "desc" } });
const engineAudit = (sessionId: string, row: number) =>
  prisma.auditLog.findFirst({
    where: { action: "CONSULT_ENGINE_TURN", entityId: sessionId, meta: { path: ["row"], equals: row } },
    orderBy: { createdAt: "desc" },
  });

/** 等 session turnCount>=min + 指定 audit row（engine turn 落定）。 */
async function waitTurn(convId: string, minTurns: number, auditRow: number, timeoutMs = 40_000) {
  return poll(
    `turn>=${minTurns} + row=${auditRow} conv=${convId.slice(0, 8)}`,
    async () => {
      const s = await activeSession(convId);
      if (!s || s.turnCount < minTurns) return null;
      const a = await engineAudit(s.id, auditRow);
      return a ? { s, a } : null;
    },
    timeoutMs,
  );
}
/** 等 processed:false 嘅 audit row（#4/#6 — turnCount 唔增）。 */
async function waitUnprocessed(convId: string, auditRow: number, timeoutMs = 40_000) {
  return poll(
    `unprocessed row=${auditRow} conv=${convId.slice(0, 8)}`,
    async () => {
      const s = await anySession(convId);
      if (!s) return null;
      const rows = await prisma.auditLog.findMany({
        where: { action: "CONSULT_ENGINE_TURN", entityId: s.id },
        orderBy: { createdAt: "desc" },
        take: 10,
      });
      const a = rows.find((x) => (x.meta as Record<string, unknown>)?.row === auditRow && (x.meta as Record<string, unknown>)?.processed === false);
      return a ? { s, a } : null;
    },
    timeoutMs,
  );
}
async function waitTerminal(convId: string, wantTerminal: string, timeoutMs = 40_000) {
  return poll(
    `terminal=${wantTerminal} conv=${convId.slice(0, 8)}`,
    async () => (await prisma.consultSession.findFirst({ where: { conversationId: convId, terminal: wantTerminal }, orderBy: { createdAt: "desc" } })) ?? null,
    timeoutMs,
  );
}
async function waitNotice(convId: string, kind: "HANDOFF_REQUEST" | "URGENT_ESCALATION" = "HANDOFF_REQUEST", timeoutMs = 30_000) {
  return poll(
    `notice kind=${kind} conv=${convId.slice(0, 8)}`,
    async () => (await prisma.staffNotice.findFirst({ where: { conversationId: convId, kind }, orderBy: { createdAt: "desc" } })) ?? null,
    timeoutMs,
  );
}
/** staff 發送（source=adopted|typed → sentVia + humanTookOver 語義）。 */
async function staffSend(cookie: string, convId: string, body: string, source: "adopted" | "typed"): Promise<number> {
  const r = await api(cookie, "/api/messages/send", "POST", { conversationId: convId, body, source });
  return r.status;
}

// ── sweep / residue ───────────────────────────────────────────────────
let sweepRef: (() => Promise<void>) | null = null;
async function sweep(): Promise<void> {
  const clinic = await prisma.clinic.findUnique({ where: { code: CLINIC_CODE } });
  const clinicId = clinic?.id ?? null;
  if (clinicId) {
    const convs = (await prisma.conversation.findMany({ where: { clinicId }, select: { id: true } })).map((c) => c.id);
    const cSess = convs.length ? await prisma.consultSession.findMany({ where: { conversationId: { in: convs } }, select: { id: true } }) : [];
    const pSess = convs.length ? await prisma.painTriageSession.findMany({ where: { conversationId: { in: convs } }, select: { id: true } }) : [];
    const bSess = convs.length ? await prisma.bookingSession.findMany({ where: { conversationId: { in: convs } }, select: { id: true } }) : [];
    const sids = [...cSess, ...pSess, ...bSess].map((s) => s.id);
    // audit 洗齊：entityId ∈ (session ids ∪ conv ids ∪ product ids ∪ clinicId) ∪ meta.clinicId
    const productIds = (await prisma.consultProduct.findMany({ where: { clinicId }, select: { id: true } })).map((p) => p.id);
    if (convs.length > 0) {
      await prisma.$transaction([
        prisma.aiDraft.deleteMany({ where: { conversationId: { in: convs } } }),
        prisma.consultSession.deleteMany({ where: { conversationId: { in: convs } } }),
        prisma.painTriageSession.deleteMany({ where: { conversationId: { in: convs } } }),
        prisma.bookingSession.deleteMany({ where: { conversationId: { in: convs } } }),
        prisma.staffNotice.deleteMany({ where: { conversationId: { in: convs } } }),
        prisma.message.deleteMany({ where: { conversationId: { in: convs } } }),
        prisma.conversation.deleteMany({ where: { id: { in: convs } } }),
      ]);
    }
    await prisma.consultSetting.deleteMany({ where: { clinicId } });
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { entityId: { in: [clinicId, ...productIds, ...convs, ...sids] } },
          { meta: { path: ["clinicId"], equals: clinicId } },
        ],
      },
    });
    await prisma.consultProduct.deleteMany({ where: { clinicId } });
    await prisma.knowledgeDoc.deleteMany({ where: { title: DOC_TITLE } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  // 兜底：waId 前綴殘留 contact（clinic 已删先至有呢情況）
  await prisma.contact.deleteMany({ where: { waId: { startsWith: "e2ec6-" } } });
  console.log("[sweep] 完成");
}
sweepRef = sweep;
async function residueCheck(): Promise<number> {
  let total = 0;
  const rows: Array<[string, number]> = [];
  const clinic = await prisma.clinic.findUnique({ where: { code: CLINIC_CODE } });
  rows.push(["clinic", clinic ? 1 : 0]);
  if (clinic) {
    rows.push(["conversation", await prisma.conversation.count({ where: { clinicId: clinic.id } })]);
    rows.push(["consultProduct(clinic)", await prisma.consultProduct.count({ where: { clinicId: clinic.id } })]);
    rows.push(["knowledgeDoc", await prisma.knowledgeDoc.count({ where: { title: DOC_TITLE } })]);
    rows.push(["consultSetting", await prisma.consultSetting.count({ where: { clinicId: clinic.id } })]);
    rows.push(["auditLog", await prisma.auditLog.count({ where: { OR: [{ entityId: clinic.id }, { meta: { path: ["clinicId"], equals: clinic.id } }] } })]);
  }
  rows.push(["contact", await prisma.contact.count({ where: { waId: { startsWith: "e2ec6-" } } })]);
  for (const [n, c] of rows) {
    if (c > 0) {
      total += c;
      console.error(`  [residue] ${n} = ${c}`);
    }
  }
  return total;
}

// ══════════════════════════════════════════════════════════════════════
// S0 — §9.1 unit（純函數 — 零 DB）
// ══════════════════════════════════════════════════════════════════════
const baseState = (over: Partial<ConsultSessionState> = {}): ConsultSessionState => ({
  workflow: "ORTHODONTIC_CONSULT",
  stage: "DISCOVER",
  terminal: null,
  turnCount: 1,
  purchaseIntent: 0.5,
  // B-1：ConsultSlots 而家 Partial + clinicalSuitability 必填 — 反映 toSessionState 真實行為
  slots: { clinicalSuitability: "UNKNOWN" },
  candidateCategory: null,
  comparedProducts: [],
  askedSlots: [],
  objections: [],
  ctaGiven: false,
  humanTookOver: false,
  lastAction: null,
  ...over,
});
// B-1：空 slots 常數（= toSessionState 新 session 形態 — clinicalSuitability 保證 UNKNOWN）；純函數 fixture 用
const US: ConsultSlots = { clinicalSuitability: "UNKNOWN" };
const baseSig = (over: Partial<ConsultSignals> = {}): ConsultSignals => ({
  redFlagHit: false,
  painSignal: false,
  complaint: false,
  humanRequested: false,
  windowExpired: false,
  patientStopped: false,
  highIntent: false,
  newObjection: null,
  asksWhichSuitsMe: false,
  asksDuration: false,
  asksClinicalDetail: false,
  asksPrice: false,
  namedProduct: null,
  askedComparison: false,
  acceptsConsultation: false,
  declinesConsultation: false,
  intentDelta: 0,
  idleExpired: false,
  ...over,
});

async function s0Unit(): Promise<void> {
  console.log("\n[S0] §9.1 unit — 純函數");
  // ── triggerFloor ──
  check("triggerFloor「我想箍牙」→ ORTHODONTIC_CONSULT", triggerFloor("我想箍牙", "我想箍牙") === "ORTHODONTIC_CONSULT");
  check("triggerFloor「想知 IGO 隱適美」→ ORTHODONTIC_CONSULT", triggerFloor("想知 IGO 隱適美", "想知 IGO 隱適美") === "ORTHODONTIC_CONSULT");
  check("triggerFloor「我想做 IMPLANT 植牙」（canonical 命中）→ IMPLANT_CONSULT", triggerFloor("我想做植牙", "我想做植牙") === "IMPLANT_CONSULT");
  check("triggerFloor canonical 矯正（raw 無詞）→ ORTHODONTIC_CONSULT", triggerFloor("我想矯正", "我想矯齒") === "ORTHODONTIC_CONSULT");
  check("triggerFloor「我牙好痛」→ null", triggerFloor("我牙好痛", "我牙好痛") === null);

  // ── decide() 25 條 transition（純）──
  const T: Array<[string, ConsultSessionState, ConsultSignals, (r: ReturnType<typeof consultTransition>) => boolean, string]> = [
    ["#0 紅旗", baseState(), baseSig({ redFlagHit: true }), (r) => r.row === 0 && r.stage === "HANDOFF" && r.terminal === "HANDOFF" && r.action === "HANDOFF_HUMAN", ""],
    ["#1 痛症", baseState(), baseSig({ painSignal: true }), (r) => r.row === 1 && r.terminal === "HANDOFF" && r.action === "PAIN_TRIAGE", ""],
    ["#2 COMPLAINT", baseState(), baseSig({ complaint: true }), (r) => r.row === 2 && r.terminal === "HANDOFF" && r.action === "HANDOFF_HUMAN", ""],
    ["#3 真人要求", baseState(), baseSig({ humanRequested: true }), (r) => r.row === 3 && r.terminal === "HANDOFF" && r.action === "HANDOFF_HUMAN", ""],
    [
      "#4 窗口過期",
      baseState(),
      baseSig({ windowExpired: true }),
      (r) => r.row === 4 && r.action === "WINDOW_EXPIRED_HANDOFF" && r.processed === false && r.stage === "DISCOVER" && r.terminal === null,
      "",
    ],
    ["#5 病人叫停", baseState(), baseSig({ patientStopped: true }), (r) => r.row === 5 && r.stage === "COMPLETED" && r.terminal === "COMPLETED" && r.action === "END_SESSION", ""],
    [
      "#6 humanTookOver",
      baseState({ humanTookOver: true }),
      baseSig(),
      (r) => r.row === 6 && r.action === "NO_DRAFT" && r.processed === false,
      "",
    ],
    ["#7 maxTurns", baseState({ turnCount: 8 }), baseSig(), (r) => r.row === 7 && r.terminal === "HANDOFF" && r.action === "HANDOFF_HUMAN", ""],
    [
      "#8 PRICE x2",
      baseState({ objections: [{ type: "PRICE", status: "OPEN", count: 1, firstAt: "x", lastAt: "x" }] }),
      baseSig({ newObjection: "PRICE" }),
      (r) => r.row === 8 && r.terminal === "HANDOFF" && r.action === "HANDOFF_HUMAN" && r.stage === "DISCOVER" && r.objection?.count === 2 && r.objection?.status === "RECURRED",
      "",
    ],
    ["#9 高意向", baseState(), baseSig({ highIntent: true }), (r) => r.row === 9 && r.stage === "BOOKING" && r.terminal === "COMPLETED" && r.action === "START_BOOKING" && r.booking === true, ""],
    [
      "#10 新 objection FEAR",
      baseState(),
      baseSig({ newObjection: "FEAR" }),
      (r) => r.row === 10 && r.action === "HANDLE_OBJECTION" && r.stage === "DISCOVER" && r.objection?.count === 1,
      "",
    ],
    [
      "#11 邊款最適合我",
      baseState({ slots: { clinicalSuitability: "UNKNOWN" } }),
      baseSig({ asksWhichSuitsMe: true }),
      (r) => r.row === 11 && r.stage === "CONSULTATION" && r.action === "ASK_FOR_CONSULTATION" && r.ruleId === "ORTHO-005",
      "",
    ],
    [
      "#12 療程時間",
      baseState(),
      baseSig({ asksDuration: true }),
      (r) => r.row === 12 && r.action === "EDUCATE_DETAIL" && r.stage === "DISCOVER" && r.ruleId === "ORTHO-007",
      "",
    ],
    [
      "#13 臨床詳情（ortho）",
      baseState(),
      baseSig({ asksClinicalDetail: true }),
      (r) => r.row === 13 && r.stage === "CONSULTATION" && r.action === "ASK_FOR_CONSULTATION" && r.ruleId === "ORTHO-008",
      "",
    ],
    [
      "#13 臨床詳情（implant）",
      baseState({ workflow: "IMPLANT_CONSULT" }),
      baseSig({ asksClinicalDetail: true }),
      (r) => r.row === 13 && r.ruleId === "IMPLANT-004",
      "",
    ],
    [
      "#14 指名產品+問價",
      baseState(),
      baseSig({ asksPrice: true, namedProduct: "E2EC6IGO" }),
      (r) => r.row === 14 && r.action === "ANSWER_PRICE" && r.ruleId === "ORTHO-009",
      "",
    ],
    [
      "#15 要求比較",
      baseState(),
      baseSig({ askedComparison: true }),
      (r) => r.row === 15 && r.stage === "EDUCATE" && r.action === "EDUCATE_COMPARE" && r.ruleId === "ORTHO-003",
      "",
    ],
    [
      "#16 min slots 未齊",
      baseState(),
      baseSig(),
      (r) => r.row === 16 && r.action === "ASK_DISCOVERY" && r.askedSlot === "appearancePriority",
      "",
    ],
    [
      "#17 min slots 齊",
      baseState({ slots: { ...US, appearancePriority: "HIGH" } }),
      baseSig(),
      (r) => r.row === 17 && r.stage === "PRESENT_OPTIONS" && r.action === "PRESENT_OPTIONS" && r.candidateCategory === "CLEAR_ALIGNER" && r.ruleId === "ORTHO-001",
      "",
    ],
    [
      "#18 EDUCATE 比較完成",
      baseState({ stage: "EDUCATE", lastAction: "EDUCATE_COMPARE", slots: { ...US, appearancePriority: "HIGH" } }),
      baseSig(),
      (r) => r.row === 18 && r.stage === "PRESENT_OPTIONS" && r.action === "PRESENT_OPTIONS",
      "",
    ],
    [
      "#19 PRESENT clinical UNKNOWN",
      baseState({ stage: "PRESENT_OPTIONS", slots: { clinicalSuitability: "UNKNOWN" } }),
      baseSig(),
      (r) => r.row === 19 && r.stage === "CONSULTATION" && r.action === "ASK_FOR_CONSULTATION" && r.ruleId === "ORTHO-005",
      "",
    ],
    [
      "#20 PRESENT intent>=0.6",
      baseState({ stage: "PRESENT_OPTIONS", slots: { appearancePriority: "HIGH", clinicalSuitability: "ASSESSED" } }),
      baseSig({ intentDelta: 0.1 }),
      (r) => r.row === 20 && r.stage === "BOOKING" && r.terminal === "COMPLETED" && r.action === "START_BOOKING" && r.ruleId === "ORTHO-010",
      "",
    ],
    [
      "#21 CONSULTATION 接受",
      baseState({ stage: "CONSULTATION" }),
      baseSig({ acceptsConsultation: true }),
      (r) => r.row === 21 && r.stage === "BOOKING" && r.terminal === "COMPLETED" && r.action === "START_BOOKING",
      "",
    ],
    [
      "#22 CONSULTATION 推搪",
      baseState({ stage: "CONSULTATION" }),
      baseSig({ declinesConsultation: true }),
      (r) => r.row === 22 && r.stage === "COMPLETED" && r.terminal === "COMPLETED" && r.action === "END_SESSION" && r.followUp === true,
      "",
    ],
    [
      "#23 idle 48h（state 要過 row 16 — slots 齊 + stage EDUCATE 避 row 18）",
      baseState({ stage: "EDUCATE", lastAction: "EDUCATE_DETAIL", slots: { appearancePriority: "HIGH", clinicalSuitability: "ASSESSED" } }),
      baseSig({ idleExpired: true }),
      (r) => r.row === 23 && r.stage === "EXPIRED" && r.terminal === "EXPIRED" && r.processed === false && r.intentAfter === 0.35 && r.followUp === true,
      "",
    ],
    [
      "#24 CTA turn6（stage PRESENT + slots 齊 + clinical ASSESSED + intent<0.6 先至夠到 row 24）",
      baseState({ stage: "PRESENT_OPTIONS", turnCount: 6, slots: { appearancePriority: "HIGH", clinicalSuitability: "ASSESSED" } }),
      baseSig(),
      (r) => r.row === 24 && r.action === "ASK_FOR_CONSULTATION" && r.ctaGiven === true,
      "",
    ],
    [
      "兜底 stay",
      baseState({ stage: "PRESENT_OPTIONS", slots: { appearancePriority: "HIGH", clinicalSuitability: "ASSESSED" } }),
      baseSig(),
      (r) => r.row === -1 && r.action === null && r.processed === true,
      "",
    ],
  ];
  for (const [name, st, sg, ok, ] of T) {
    const r = consultTransition(st, sg);
    check(`decide ${name}`, ok(r), JSON.stringify({ row: r.row, action: r.action, stage: r.stage, terminal: r.terminal, rule: r.ruleId }).slice(0, 160));
  }

  // ── #23 cron 路徑：applyIdleExpiry（純 — per-turn idleExpired 永遠 false，真實 expire 由 cron sweep 做）──
  const idleSess = baseState();
  const exp49 = applyIdleExpiry(idleSess, new Date(Date.now() - 49 * 3600 * 1000));
  check("applyIdleExpiry 49h → expired + row 23 + Δ -0.15 + followUp", exp49.expired === true && exp49.row === 23 && exp49.delta === -0.15 && exp49.followUp === true, JSON.stringify(exp49));
  const exp1h = applyIdleExpiry(idleSess, new Date(Date.now() - 3600 * 1000));
  check("applyIdleExpiry 1h → 未過期", exp1h.expired === false, JSON.stringify(exp1h));
  const expTerm = applyIdleExpiry(baseState({ terminal: "COMPLETED" }), new Date(Date.now() - 49 * 3600 * 1000));
  check("applyIdleExpiry terminal session → 唔會再 expire", expTerm.expired === false, JSON.stringify(expTerm));

  // ── chooseNextQuestion 唔重複 ──
  check("chooseNextQuestion ortho 空 → appearancePriority（value 最高）", chooseNextQuestion("ORTHODONTIC_CONSULT", US, []) === "appearancePriority");
  check(
    "chooseNextQuestion 已問 appearance + 已填 speed → timeline（唔重問已問）",
    chooseNextQuestion("ORTHODONTIC_CONSULT", { ...US, speedPriority: "HIGH" }, ["appearancePriority"]) === "timeline",
  );
  check(
    "chooseNextQuestion 全部問完 → null（唔重問）",
    chooseNextQuestion("ORTHODONTIC_CONSULT", US, ["appearancePriority", "speedPriority", "timeline", "previousOrtho"]) === null,
  );
  check("chooseNextQuestion skipSlots（C5 設定）→ 跳過", chooseNextQuestion("ORTHODONTIC_CONSULT", US, [], ["appearancePriority"]) === "speedPriority");
  check("chooseNextQuestion implant 空 → missingCount", chooseNextQuestion("IMPLANT_CONSULT", US, []) === "missingCount");
  check("minimumSlotsMet ortho appearance|speed", minimumSlotsMet("ORTHODONTIC_CONSULT", { ...US, appearancePriority: "LOW" }) === true && minimumSlotsMet("ORTHODONTIC_CONSULT", { ...US, speedPriority: "HIGH" }) === true && minimumSlotsMet("ORTHODONTIC_CONSULT", US) === false);
  check("minimumSlotsMet implant = missingCount", minimumSlotsMet("IMPLANT_CONSULT", { ...US, missingCount: "ONE" }) === true && minimumSlotsMet("IMPLANT_CONSULT", US) === false);

  // ── purchaseIntent Δ + clamp ──
  check("Δ 高意向 booking 詞 = +0.4", computePurchaseIntentDelta("幾時有位", "幾時有位", { priceAskCount: 0, asksPrice: false }) === 0.4);
  check("Δ 我想做（決意）= +0.4", computePurchaseIntentDelta("我想做", "我想做", { priceAskCount: 0, asksPrice: false }) === 0.4);
  check("Δ 我想做 + booking 詞 = +0.8", computePurchaseIntentDelta("我想做 I GO，幾時有位", "我想做 I GO，幾時有位", { priceAskCount: 0, asksPrice: false }) === 0.8);
  check("Δ 首次問價 = +0.10", computePurchaseIntentDelta("", "箍牙幾錢", { priceAskCount: 0, asksPrice: true }) === 0.1);
  check("Δ 第二次問價 = +0.15", computePurchaseIntentDelta("", "箍牙幾錢", { priceAskCount: 1, asksPrice: true }) === 0.15);
  check("Δ 太貴 = −0.1", computePurchaseIntentDelta("太貴啦", "太貴啦", { priceAskCount: 0, asksPrice: false }) === -0.1);
  check("clamp 0–1", clampIntent(1.2) === 1 && clampIntent(-0.3) === 0 && clampIntent(0.55) === 0.55);

  // ── claim-guard CG-001~009 各 1 positive + 1 negative ──
  const P: ClaimGuardProductCtx = { code: "E2EC6IGO", displayName: "e2ec6 I GO", brand: "I GO", timeWording: "有啲 I GO 個案最快可以約 6 個月。", avoidPhrases: ["e2ec6 I GO 一定平"] };
  const cg = (draft: string, over: Partial<Parameters<typeof runClaimGuard>[0]> = {}) =>
    runClaimGuard({ draft, products: [P], hasBackendSlot: false, priceDoc: null, ...over });
  const cgPos: Array<[string, string, Partial<Parameters<typeof runClaimGuard>[0]>]> = [
    ["CG-001 診斷", "我睇咗你嘅相，你呢個係牙周病。", {}],
    ["CG-002 保證", "跟住做療程，保證可以排齊。", {}],
    ["CG-003 個人化建議", "我幫你睇過，你最適合做 I GO。", {}],
    ["CG-004 無根據時間", "e2ec6 I GO 療程大概只需要兩個月。", {}],
    ["CG-005 成功率", "我哋嘅成功率有 99%。", {}],
    ["CG-006 品牌優越", "呢個品牌一定好過其他品牌。", {}],
    ["CG-007 金額出範圍", "我哋可以俾 $500 做到。", { priceDoc: { priceMin: 30000, priceMax: 60000 } }],
    ["CG-007 零引用金額", "我哋可以俾 $500 做到。", { priceDoc: null }],
    ["CG-008 杜撰時段", "你可以星期一三點嚟睇下。", { hasBackendSlot: false }],
    ["CG-009 avoidPhrases", "e2ec6 I GO 一定平。", {}],
  ];
  for (const [name, draft, over] of cgPos) {
    const r = cg(draft, over);
    check(`${name} positive → BLOCK`, r.blocked === true && r.code === name.slice(0, 6), JSON.stringify({ blocked: r.blocked, code: r.code, codes: r.codes }));
  }
  check("CG-001 negative（評估語境）", !cg("呢個要由醫生評估先確認，未可以判斷。").blocked);
  check("CG-002 negative（無保證詞）", !cg("療程時間會因個案而唔同，要睇評估。").blocked);
  check("CG-003 negative（中性建議）", !cg("實際邊款適合你要睇返牙齒情況，建議約評估。").blocked);
  check("CG-004 negative（時間 = timeWording 原句）", !cg("e2ec6 I GO 有啲 I GO 個案最快可以約 6 個月。").blocked);
  check("CG-005 negative（無百分數）", !cg("大部分個案效果理想，最終要睇評估。").blocked);
  check("CG-006 negative（客觀講法）", !cg("呢個品牌質素穩定，用咗好多年代。").blocked);
  check("CG-007 negative（範圍內金額）", !cg("收費大約 30000–60000 蚊。", { priceDoc: { priceMin: 30000, priceMax: 60000 } }).blocked);
  check("CG-008 negative（有 backend slot）", !cg("你可以星期一三點嚟睇下。", { hasBackendSlot: true }).blocked);
  check("CG-008 negative（無具體時段）", !cg("你方便嘅話我哋安排時間俾你。").blocked);
  check("CG-009 negative（avoidPhrase 唔喺 draft）", !cg("e2ec6 I GO 透明比較冇咁顯眼，要睇評估。").blocked);
  check("BLOCK 後 draft = 人手提示", cg("你最適合做 I GO。").draft === CLAIM_HUMAN_TEXT);

  // ── isProductUsable（approvedAt=null 唔入檢索）──
  check("isProductUsable approved+enabled → true", isProductUsable({ enabled: true, approvedAt: new Date() }) === true);
  check("isProductUsable approvedAt=null → false（鐵律）", isProductUsable({ enabled: true, approvedAt: null }) === false);
  check("isProductUsable enabled=false → false", isProductUsable({ enabled: false, approvedAt: new Date() }) === false);
}

// ══════════════════════════════════════════════════════════════════════
// S1 — fixture（clinic e2ec6 DRAFT + 3 product + PRICE doc）
// ══════════════════════════════════════════════════════════════════════
let clinicId = "";
let igoId = "";
async function s1Fixture(adminCookie: string): Promise<Ctx> {
  console.log("\n[S1] fixture — clinic e2ec6 + products + PRICE doc");
  const clinic = await prisma.clinic.create({
    data: { code: CLINIC_CODE, name: "e2ec6 Clinic", waPhoneNumberId: "e2ec6-phone-0001", waDisplayNumber: "852-0000-0001" },
  });
  clinicId = clinic.id;
  const now = new Date();
  const igo = await prisma.consultProduct.create({
    data: {
      clinicId,
      workflow: "ORTHODONTIC_CONSULT",
      code: P_IGO,
      displayName: "e2ec6 隱適美 I GO",
      brand: "I GO",
      positioning: "e2ec6 隱形、e2ec6 快速",
      approvedWording: "e2ec6 I GO 主要針對較簡單至中度嘅牙齒移動，透明相對冇咁顯眼。",
      timeWording: "有啲 I GO 個案最快可以約 6 個月。",
      avoidPhrases: ["e2ec6 I GO 一定平"],
      priceDocTitle: DOC_TITLE,
      sortOrder: 1,
      approvedAt: now,
      approvedBy: "e2ec6-e2e",
    },
  });
  igoId = igo.id;
  await prisma.consultProduct.create({
    data: {
      clinicId,
      workflow: "ORTHODONTIC_CONSULT",
      code: P_IFULL,
      displayName: "e2ec6 完整 Invisalign",
      brand: "I Full",
      positioning: "e2ec6 全面、e2ec6 可涵蓋較廣泛",
      approvedWording: "e2ec6 完整 Invisalign 可以處理更廣泛嘅情況，包括整個牙弓同部分咬合修正。",
      timeWording: "e2ec6 療程時間：平均大約 12–18 個月。",
      avoidPhrases: [],
      priceDocTitle: DOC_TITLE,
      sortOrder: 2,
      approvedAt: now,
      approvedBy: "e2ec6-e2e",
    },
  });
  await prisma.consultProduct.create({
    data: {
      clinicId,
      workflow: "ORTHODONTIC_CONSULT",
      code: P_TRAD,
      displayName: "e2ec6 傳統牙箍",
      positioning: "e2ec6 固定式、e2ec6 金屬托槽",
      approvedWording: "e2ec6 傳統固定牙箍可以處理比較廣泛嘅牙齒排列同咬合問題。",
      avoidPhrases: [],
      sortOrder: 3,
      approvedAt: null, // GC-21 fixture：未確認
    },
  });
  await prisma.knowledgeDoc.create({
    data: {
      clinicId,
      kind: "PRICE",
      title: DOC_TITLE,
      keywords: ["箍牙", "矯齒", "I GO"],
      body: "影響因素：方式（傳統/陶瓷/透明托）、療程難度同長期。",
      disclaimer: "最終費用以到診評估為準，具體方案由醫生確定。",
      shortDisclaimer: "以到診評估為準",
      priceMin: 30000,
      priceMax: 60000,
    },
  });
  check("clinic e2ec6 建立（aiMode 預設 DRAFT）", clinic.aiMode === "DRAFT", String(clinic.aiMode));
  const stats = await prisma.aiCallStats.findUnique({ where: { id: 1 } });
  return { adminCookie, statsBefore: stats ? { totalCalls: stats.totalCalls, okCalls: stats.okCalls, updatedAt: stats.updatedAt } : null };
}

// ══════════════════════════════════════════════════════════════════════
// S2 — §9.2 GoldenCase（真 pipeline，mock LLM）
// ══════════════════════════════════════════════════════════════════════
type Ctx = { adminCookie: string; statsBefore: Record<string, unknown> | null };
const slotsOf = (s: { slots: unknown }) => (typeof s.slots === "string" ? JSON.parse(s.slots) : (s.slots as Record<string, unknown>)) ?? {};
// B-1 審計：audit meta（Json|null）type-safe 讀法 — runtime 語義不變（meta 係 object 時返原值；null → {}，斷言自然 fail 唔會 throw）
const ameta = (a: { meta: unknown }): Record<string, unknown> =>
  (typeof a.meta === "string" ? JSON.parse(a.meta) : (a.meta as Record<string, unknown>)) ?? {};
const D = {
  discovery: (q: string) => `Hello☺️ 多謝你查詢！${q}`,
  qAppearance: "想多了解下，你比唔比重視戴咗之後人哋見到？",
  qSpeed: "想多了解下，你比唔比重視快啲做完？",
  qMissingCount: "想多了解下，你係一隻定幾多隻牙缺咗？",
  present2: `Hello☺️ 矯牙有幾種方向：透明方向。 e2ec6 隱適美 I GO（e2ec6 隱形）、e2ec6 完整 Invisalign（e2ec6 全面）。實際邊款適合你要睇返牙齒情況，要唔要約醫生評估一下？🦷`,
  compare2: `Hello☺️ e2ec6 隱適美 I GO 同 e2ec6 完整 Invisalign 各有取向：e2ec6 隱適美 I GO 比較e2ec6 隱形，e2ec6 完整 Invisalign 比較e2ec6 全面。實際邊款適合你要睇返牙齒情況，要唔要約評估傾下？🦷`,
  compare0: `Hello☺️ 呢幾款方案嘅客觀分別，要睇返你嘅牙齒情況先至講得準。要唔要約醫生評估傾下？🦷`,
  detailIgo: `Hello☺️ e2ec6 I GO 主要針對較簡單至中度嘅牙齒移動，透明相對冇咁顯眼。 有啲 I GO 個案最快可以約 6 個月。實際邊款適合你要睇返牙齒情況，建議由醫生評估先。你希望幾時傾下？🦷`,
  answerPrice: `Hello☺️ 收費大約 30000–60000 蚊。以到診評估為準 最終費用要睇返評估先至準確。要唔要我幫你安排評估？☺️`,
  objectionIgo: `Hello☺️ 收到，明白你嘅顧慮🥺 e2ec6 I GO 主要針對較簡單至中度嘅牙齒移動，透明相對冇咁顯眼。每個方案都要睇返實際情況先至決定，建議由醫生評估。你希望幾時傾下？`,
};

async function gc01(): Promise<void> {
  console.log("\n[GC-01] 紅旗急症 → URGENT + HANDOFF（A 安全硬門檻）");
  const wa = "e2ec6-gc01";
  const m1 = await inbound(wa, "我想箍牙");
  const t1 = await waitTurn(m1.convId, 1, 16);
  check("m1 engine row 16（discovery 起步）", ameta(t1.a).row === 16);
  const d1 = await poll("GC01 m1 draft", async () => draftOf(m1.msgId));
  check("m1 draft = appearance discovery（精確）", d1?.draftText === D.discovery(D.qAppearance), d1?.draftText);
  // m2：紅旗（無 FLOOR — mock trigger=null → engine 唔 run；urgent 硬安全路徑獨立生效 — 見 D1）
  const m2 = await inbound(wa, "而家塊面腫咗");
  const urgent = await poll("GC01 conv.urgent", async () => {
    const c = await prisma.conversation.findUnique({ where: { id: m2.convId } });
    return c?.urgent === true ? c : null;
  });
  check("m2 conv.urgent = true（紅旗 fast path）", urgent !== null);
  const n2 = await waitNotice(m2.convId, "URGENT_ESCALATION");
  check("m2 URGENT_ESCALATION 通知", n2 !== null);
  await sleep(1500);
  const d2 = await draftOf(m2.msgId);
  check("m2 零草稿（鐵律：URGENT_PAIN 唔生成）", d2 === null);
  const sAfterM2 = await activeSession(m2.convId);
  check("m2 consult session turnCount 不變（=1）", sAfterM2?.turnCount === 1, String(sAfterM2?.turnCount));
  // m3：同一臨床場景 + FLOOR → engine row 0 → terminal HANDOFF
  const m3 = await inbound(wa, "箍牙，而家塊面腫咗");
  const s3 = await waitTerminal(m3.convId, "HANDOFF");
  check("m3 terminal = HANDOFF", s3.terminal === "HANDOFF");
  check("m3 stage = HANDOFF", s3.stage === "HANDOFF", s3.stage);
  // 設計：URGENT_PAIN job 已發 URGENT_ESCALATION — engine 唔重發 HANDOFF_REQUEST（runner §6 去重）
  const m3msg = await prisma.message.findUnique({ where: { id: m3.msgId } });
  const n3 = await poll(
    "GC01 m3 URGENT_ESCALATION(wamid)",
    async () =>
      (await prisma.staffNotice.findFirst({
        where: { conversationId: m3.convId, kind: "URGENT_ESCALATION", meta: { path: ["wamid"], equals: m3msg?.waMessageId! } },
      })) ?? null,
  );
  check("m3 URGENT_ESCALATION 通知（meta.wamid 精確鎖定）", n3 !== null);
  const handoffs = await prisma.staffNotice.count({ where: { conversationId: m3.convId, kind: "HANDOFF_REQUEST" } });
  check("m3 無重複 HANDOFF_REQUEST（URGENT 已升級 — 設計去重）", handoffs === 0, String(handoffs));
  const a0 = await engineAudit(s3.id, 0);
  check("m3 audit row 0 + action HANDOFF_HUMAN", a0 !== null && (a0.meta as Record<string, unknown>).row === 0 && (a0.meta as Record<string, unknown>).action === "HANDOFF_HUMAN", JSON.stringify(a0?.meta).slice(0, 160));
  const d3 = await draftOf(m3.msgId);
  check("m3 零草稿（URGENT_PAIN 唔入 LLM）", d3 === null);
}

async function gc02(): Promise<void> {
  console.log("\n[GC-02] 痛症 → pain triage，無推銷無報價（A 安全硬門檻）");
  const wa = "e2ec6-gc02";
  const m1 = await inbound(wa, "箍牙幾錢");
  const t1 = await waitTurn(m1.convId, 1, 16);
  const s1 = t1.s;
  check("m1 row 16（問價無指名 → discovery）", ameta(t1.a).row === 16);
  check("m1 purchaseIntent = 0.1（首次問價 +0.10）", s1.purchaseIntent === 0.1, String(s1.purchaseIntent));
  const sl1 = slotsOf(s1);
  check("m1 slots.meta.priceAskCount = 1", (sl1.meta as Record<string, number> | undefined)?.priceAskCount === 1);
  const m2 = await inbound(wa, "但我隻牙好痛");
  const pain = await poll(
    "GC02 pain session",
    async () => (await prisma.painTriageSession.findFirst({ where: { conversationId: m2.convId, status: "ACTIVE" } })) ?? null,
  );
  check("m2 開 PainTriageSession（pain triage 路徑）", pain !== null);
  // pain 問診問句 = session reply 直接 OUT（sendSessionReply — 唔係 AiDraft）
  const out2 = await poll(
    "GC02 m2 pain reply(OUT)",
    async () => (await prisma.message.findFirst({ where: { conversationId: m2.convId, direction: "OUT", body: { contains: "牙" } }, orderBy: { createdAt: "desc" } })) ?? null,
    40_000,
  );
  check("m2 pain 問診問句存在（session reply OUT）", out2 !== null);
  const noSales = out2 && !/\$\s?\d|\d{3,}\s*蚊|幾錢|收費|推薦|最適合|保證/.test(out2.body ?? "");
  check("m2 pain 覆零金額零推銷", !!noSales, out2?.body ?? undefined);
  const s2 = await activeSession(m2.convId);
  check("m2 consult session turnCount 不變（=1）", s2?.turnCount === 1, String(s2?.turnCount));
}

async function gc03(): Promise<void> {
  console.log("\n[GC-03] 臨床詳細 → 轉評估，唔答臨床（A 安全硬門檻）");
  const wa = "e2ec6-gc03";
  const m1 = await inbound(wa, "我想箍牙，我啲牙好亂，係咪一定要脫牙先箍到？");
  const t1 = await waitTurn(m1.convId, 1, 13);
  const s1 = t1.s;
  check("m1 row 13（臨床詳情）", ameta(t1.a).row === 13);
  check("m1 stage = CONSULTATION", s1.stage === "CONSULTATION", s1.stage);
  check("m1 ruleId = ORTHO-008", (t1.a.meta as Record<string, unknown>).ruleId === "ORTHO-008");
  const d1 = await poll("GC03 m1 draft", async () => draftOf(m1.msgId));
  check("m1 draft 推評估（含「要由醫生評估先確認得到」）", (d1?.draftText ?? "").includes("要由醫生評估先確認得到"), d1?.draftText);
  check("m1 draft 無「一定」（病人原句 一定 唔會入草稿）", !(d1?.draftText ?? "").includes("一定"));
  check("m1 draft 唔答臨床（無「脫牙」）", !(d1?.draftText ?? "").includes("脫牙"));
}

async function gc04(): Promise<void> {
  console.log("\n[GC-04] 療程時間 → 中立 approved timeWording（A 安全硬門檻）");
  const wa = "e2ec6-gc04";
  const m1 = await inbound(wa, "我想箍牙，半年做唔做得完？");
  const t1 = await waitTurn(m1.convId, 1, 12);
  const s1 = t1.s;
  check("m1 row 12（療程時間）", ameta(t1.a).row === 12);
  check("m1 ruleId = ORTHO-007", (t1.a.meta as Record<string, unknown>).ruleId === "ORTHO-007");
  check("m1 stage 停留 DISCOVER（row 12 唔 move stage — engine 設計）", s1.stage === "DISCOVER", s1.stage);
  const d1 = await poll("GC04 m1 draft", async () => draftOf(m1.msgId));
  check("m1 draft = approved timeWording 原句（精確）", d1?.draftText === D.detailIgo, d1?.draftText);
  check("m1 draft 含「有啲 I GO 個案最快可以約 6 個月。」", (d1?.draftText ?? "").includes("有啲 I GO 個案最快可以約 6 個月。"));
  check("m1 draft 無「半年」（唔接受病人時間假設）", !(d1?.draftText ?? "").includes("半年"));
  check("m1 draft 無保證/一定", !/(保證|一定)/.test(d1?.draftText ?? ""));
}

async function gc05(): Promise<void> {
  console.log("\n[GC-05] mock LLM 出「你最適合」→ CG-003 BLOCK（A 安全硬門檻）");
  const wa = "e2ec6-gc05";
  const m1 = await inbound(wa, "我想箍牙，想再問吓 E2E-CG-003");
  const t1 = await waitTurn(m1.convId, 1, 16);
  const d1 = await poll("GC05 m1 draft", async () => draftOf(m1.msgId));
  check("m1 draft = 人手提示（CG-003 擋後）", d1?.draftText === CLAIM_HUMAN_TEXT, d1?.draftText);
  // needsHuman=true 只喺 worker result（控制 auto-send 閘）— AiDraft 無呢欄；
  // 可觀察證據 = CLAIM_HUMAN_TEXT + CONSULT_CLAIM_GUARD_BLOCK audit（C1 §5 寫入點）
  const cgAudit = await prisma.auditLog.findFirst({
    where: { action: "CONSULT_CLAIM_GUARD_BLOCK", entityId: t1.s.id },
    orderBy: { createdAt: "desc" },
  });
  const cgMeta = cgAudit?.meta as Record<string, unknown> | null;
  check("m1 claim-guard BLOCK audit（code=CG-003）", cgMeta?.code === "CG-003", JSON.stringify(cgMeta)?.slice(0, 160));
}

async function gc06(): Promise<void> {
  console.log("\n[GC-06] 槽抽取：外貌+速度 HIGH");
  const wa = "e2ec6-gc06";
  const m1 = await inbound(wa, "我想箍牙，想快啲又唔想俾人見到");
  const t1 = await waitTurn(m1.convId, 1, 16);
  const sl = slotsOf(t1.s);
  check("appearancePriority = HIGH", sl.appearancePriority === "HIGH", JSON.stringify(sl));
  check("speedPriority = HIGH", sl.speedPriority === "HIGH", JSON.stringify(sl));
}

async function gc07(): Promise<void> {
  console.log("\n[GC-07] 否定語 + 價格敏感（appearance LOW）");
  const wa = "e2ec6-gc07";
  const m1 = await inbound(wa, "我想箍牙，我唔係好在意人哋見唔見到，最緊要平");
  const t1 = await waitTurn(m1.convId, 1, 16);
  const sl = slotsOf(t1.s);
  check("appearancePriority = LOW（否定先判）", sl.appearancePriority === "LOW", JSON.stringify(sl));
  check("budgetSensitivity = HIGH（病人主動講）", sl.budgetSensitivity === "HIGH", JSON.stringify(sl));
  check("speedPriority 唔填", sl.speedPriority === undefined || sl.speedPriority === null);
}

async function gc08(): Promise<void> {
  console.log("\n[GC-08] 自報預算 30000");
  const wa = "e2ec6-gc08";
  const m1 = await inbound(wa, "我想箍牙，我預算大概三萬");
  const t1 = await waitTurn(m1.convId, 1, 16);
  const sl = slotsOf(t1.s);
  check("statedBudget = 30000", sl.statedBudget === 30000, JSON.stringify(sl));
  check("budgetSensitivity 唔強填（只問價/自報預算唔計）", sl.budgetSensitivity === undefined || sl.budgetSensitivity === null);
}

async function gc09_10(): Promise<void> {
  console.log("\n[GC-09/10] 三輪槽 → PRESENT_OPTIONS 中立兩款 + 「邊款最適合我」→ 轉評估");
  const wa = "e2ec6-gc09";
  const m1 = await inbound(wa, "我想cool牙，咩收費？");
  const t1 = await waitTurn(m1.convId, 1, 16);
  check("m1 row 16 + appearance question", ameta(t1.a).row === 16);
  const m2 = await inbound(wa, "箍牙，唔想俾人見到");
  const t2 = await waitTurn(m2.convId, 2, 16);
  const d2 = await poll("GC09 m2 draft", async () => draftOf(m2.msgId));
  check("m2 draft = speed question（唔重問已問）", d2?.draftText === D.discovery(D.qSpeed), d2?.draftText);
  const m3 = await inbound(wa, "箍牙，係，想快啲");
  const t3 = await waitTurn(m3.convId, 3, 17);
  check("m3 row 17 → PRESENT_OPTIONS", ameta(t3.a).row === 17 && t3.s.stage === "PRESENT_OPTIONS", t3.s.stage);
  check("m3 candidateCategory = CLEAR_ALIGNER（appearance HIGH 規則）", t3.s.candidateCategory === "CLEAR_ALIGNER", String(t3.s.candidateCategory));
  check("m3 ruleId = ORTHO-001", (t3.a.meta as Record<string, unknown>).ruleId === "ORTHO-001");
  const d3 = await poll("GC09 m3 draft", async () => draftOf(m3.msgId));
  check("m3 draft = 中立兩款（精確）", d3?.draftText === D.present2, d3?.draftText);
  check("m3 draft 無單款推薦（無「你最適合」）", !(d3?.draftText ?? "").includes("你最適合"));
  check("m3 draft 無未確認產品（無 e2ec6 傳統牙箍）", !(d3?.draftText ?? "").includes("e2ec6 傳統牙箍"));
  // GC-10：同一 conv 續 — 病人自問「邊款最適合我」→ 轉評估
  const m4 = await inbound(wa, "箍牙，咁邊款最適合我？");
  const t4 = await waitTurn(m4.convId, 4, 11);
  check("GC10 m4 row 11 → CONSULTATION", ameta(t4.a).row === 11 && t4.s.stage === "CONSULTATION", t4.s.stage);
  check("GC10 m4 ruleId = ORTHO-005", (t4.a.meta as Record<string, unknown>).ruleId === "ORTHO-005");
  const d4 = await poll("GC10 m4 draft", async () => draftOf(m4.msgId));
  check("GC10 m4 draft 推評估（唔做臨床推薦）", (d4?.draftText ?? "").includes("要由醫生評估先確認得到"), d4?.draftText);
  check("GC10 m4 draft 無「你最適合」", !(d4?.draftText ?? "").includes("你最適合"));
}

async function gc11(): Promise<void> {
  console.log("\n[GC-11] 要求比較 → 中立比較，無追問");
  const wa = "e2ec6-gc11";
  const m1 = await inbound(wa, "我想箍牙");
  await waitTurn(m1.convId, 1, 16);
  const m2 = await inbound(wa, "箍牙，I GO 同 I Full 差咩？");
  const t2 = await waitTurn(m2.convId, 2, 15);
  check("m2 row 15 → EDUCATE/EDUCATE_COMPARE", ameta(t2.a).row === 15 && t2.s.stage === "EDUCATE", t2.s.stage);
  check("m2 ruleId = ORTHO-003", (t2.a.meta as Record<string, unknown>).ruleId === "ORTHO-003");
  const d2 = await poll("GC11 m2 draft", async () => draftOf(m2.msgId));
  check("m2 draft = 中立比較（精確）", d2?.draftText === D.compare2, d2?.draftText);
  check("m2 draft 無追問（無「想了解」/「想多了解下」）", !/(想了解|想多了解下)/.test(d2?.draftText ?? ""));
}

async function gc12(): Promise<void> {
  console.log("\n[GC-12] 高意向預約 → BOOKING 完成");
  const wa = "e2ec6-gc12";
  const m1 = await inbound(wa, "我想做 I GO，箍牙幾時有位？");
  const s1 = await waitTerminal(m1.convId, "COMPLETED");
  const a9 = await engineAudit(s1.id, 9);
  check("m1 row 9 → BOOKING/COMPLETED", a9 !== null && s1.stage === "BOOKING" && s1.terminal === "COMPLETED", JSON.stringify({ stage: s1.stage, terminal: s1.terminal }));
  check("m1 action = START_BOOKING", (a9?.meta as Record<string, unknown> | undefined)?.action === "START_BOOKING");
  check("m1 purchaseIntent = 0.8（我想做 +0.4 + 幾時有位 +0.4）", s1.purchaseIntent === 0.8, String(s1.purchaseIntent));
  const bk = await prisma.bookingSession.count({ where: { conversationId: m1.convId } });
  check("m1 無 auto BookingSession（legacy 無 policy row → L1/L2 — 同 C3 S9 口徑）", bk === 0, String(bk));
  const llmTurns = await prisma.auditLog.count({ where: { action: "CONSULT_LLM_TURN", entityId: s1.id } });
  check("m1 零 consult LLM call（START_BOOKING 唔喺 8 個 LLM action — 鐵律）", llmTurns === 0, String(llmTurns));
}

async function gc13(): Promise<void> {
  console.log("\n[GC-13] 首句同時設槽 → 下輪 PRESENT_OPTIONS");
  const wa = "e2ec6-gc13";
  const m1 = await inbound(wa, "我想箍牙，最緊要靚");
  const t1 = await waitTurn(m1.convId, 1, 16);
  const sl1 = slotsOf(t1.s);
  check("m1 extract appearance HIGH（slot 已填但該輪問緊 appearance — decide 用 old slots）", sl1.appearancePriority === "HIGH", JSON.stringify(sl1));
  const m2 = await inbound(wa, "箍牙，嗯，了解");
  const t2 = await waitTurn(m2.convId, 2, 17);
  check("m2 row 17 → PRESENT_OPTIONS（min slots 齊）", ameta(t2.a).row === 17 && t2.s.stage === "PRESENT_OPTIONS", t2.s.stage);
  const d2 = await poll("GC13 m2 draft", async () => draftOf(m2.msgId));
  check("m2 draft = 中立兩款（精確）", d2?.draftText === D.present2, d2?.draftText);
}

async function gc14a(): Promise<void> {
  console.log("\n[GC-14a] 普通問價（無指名產品）→ 一條 discovery 問題（row 16）");
  const wa = "e2ec6-gc14a";
  const m1 = await inbound(wa, "我想箍牙");
  await waitTurn(m1.convId, 1, 16);
  const m2 = await inbound(wa, "箍牙幾錢？");
  const t2 = await waitTurn(m2.convId, 2, 16);
  const s2 = t2.s;
  check("m2 row 16（無指名產品 → 唔入 row 14）", ameta(t2.a).row === 16);
  const d2 = await poll("GC14a m2 draft", async () => draftOf(m2.msgId));
  check("m2 draft = 一條 discovery 問題（speed — 精確）", d2?.draftText === D.discovery(D.qSpeed), d2?.draftText);
  const sl = slotsOf(s2);
  check("m2 slots.meta.priceAskCount = 1", (sl.meta as Record<string, number> | undefined)?.priceAskCount === 1);
  check("m2 purchaseIntent = 0.1（首次問價）", s2.purchaseIntent === 0.1, String(s2.purchaseIntent));
}

async function gc14b(): Promise<void> {
  console.log("\n[GC-14b] 指名產品問價（I GO）→ KB 價格範圍");
  const wa = "e2ec6-gc14b";
  const m1 = await inbound(wa, "我想箍牙");
  await waitTurn(m1.convId, 1, 16);
  const m2 = await inbound(wa, "箍牙，I GO 最平幾錢？");
  const t2 = await waitTurn(m2.convId, 2, 14);
  check("m2 row 14 → ANSWER_PRICE（指名產品 + 問價）", ameta(t2.a).row === 14);
  check("m2 ruleId = ORTHO-009", (t2.a.meta as Record<string, unknown>).ruleId === "ORTHO-009");
  const d2 = await poll("GC14b m2 draft", async () => draftOf(m2.msgId));
  check("m2 draft = KB 價格範圍 30000–60000（精確）", d2?.draftText === D.answerPrice, d2?.draftText);
  check("m2 draft 含 disclaimer「以到診評估為準」", (d2?.draftText ?? "").includes("以到診評估為準"));
}

async function gc15(): Promise<void> {
  console.log("\n[GC-15] 指名產品問價 → 無 preference 反問");
  const wa = "e2ec6-gc15";
  const m1 = await inbound(wa, "我想箍牙");
  await waitTurn(m1.convId, 1, 16);
  const m2 = await inbound(wa, "箍牙，I GO 最平幾錢？");
  const t2 = await waitTurn(m2.convId, 2, 14);
  const d2 = await poll("GC15 m2 draft", async () => draftOf(m2.msgId));
  check("m2 draft = 價格範圍（精確）", d2?.draftText === D.answerPrice, d2?.draftText);
  check("m2 draft 無 preference 反問（無「想了解」/「想多了解下」）", !/(想了解|想多了解下)/.test(d2?.draftText ?? ""));
}

async function gc16(): Promise<void> {
  console.log("\n[GC-16] mock LLM 出範圍外金額 → price-guard BLOCK（A 安全級）");
  const wa = "e2ec6-gc16";
  const m1 = await inbound(wa, "我想箍牙，想知多啲 E2E-CG-007");
  const t1 = await waitTurn(m1.convId, 1, 16);
  const d1 = await poll("GC16 m1 draft", async () => draftOf(m1.msgId));
  check("m1 draft = NO_PRICE_TEXT（price-guard 擋）", d1?.draftText === NO_PRICE_TEXT, d1?.draftText);
  check("m1 draft 零金額", !/\$\s?\d|\d{4,}\s*蚊/.test(d1?.draftText ?? ""));
  const tr = d1?.traceJson as { price?: { guard?: { blocked?: boolean } } } | null;
  check("m1 traceJson price guard blocked=true", tr?.price?.guard?.blocked === true, JSON.stringify(tr?.price)?.slice(0, 160));
}

async function gc17(): Promise<void> {
  console.log("\n[GC-17] 植牙品牌比較 → 中立，零 CG-006 越界");
  const wa = "e2ec6-gc17";
  const m1 = await inbound(wa, "我想做植牙");
  const t1 = await waitTurn(m1.convId, 1, 16);
  const d1 = await poll("GC17 m1 draft", async () => draftOf(m1.msgId));
  check("m1 implant discovery = missingCount 問題（精確）", d1?.draftText === D.discovery(D.qMissingCount), d1?.draftText);
  const m2 = await inbound(wa, "植牙，點解 Straumann 同 Hiossen 差咩？");
  const t2 = await waitTurn(m2.convId, 2, 15);
  check("m2 row 15 → EDUCATE/EDUCATE_COMPARE", ameta(t2.a).row === 15 && t2.s.stage === "EDUCATE", t2.s.stage);
  const d2 = await poll("GC17 m2 draft", async () => draftOf(m2.msgId));
  check("m2 draft = 中立比較（無 usable 植牙產品 → 通用句 — 精確）", d2?.draftText === D.compare0, d2?.draftText);
  check("m2 draft 零 CG-006 詞（無 好過/貴啲就/平啲就/唔耐用）", !/(好過|貴啲就|平啲就|唔耐用)/.test(d2?.draftText ?? ""));
  const blocks = await prisma.auditLog.count({ where: { action: "CONSULT_CLAIM_GUARD_BLOCK", entityId: t2.s.id } });
  check("m2 零 claim-guard block（通用句本身合規）", blocks === 0, String(blocks));
}

async function gc18(): Promise<void> {
  console.log("\n[GC-18] 價格 objection ×2 → HANDOFF");
  const wa = "e2ec6-gc18";
  const m1 = await inbound(wa, "我想箍牙，幾錢？");
  const t1 = await waitTurn(m1.convId, 1, 16);
  check("m1 purchaseIntent = 0.1", t1.s.purchaseIntent === 0.1, String(t1.s.purchaseIntent));
  const m2 = await inbound(wa, "箍牙太貴啦");
  const t2 = await waitTurn(m2.convId, 2, 10);
  check("m2 row 10 → HANDLE_OBJECTION（新 PRICE objection）", ameta(t2.a).row === 10 && (t2.a.meta as Record<string, unknown>).action === "HANDLE_OBJECTION", JSON.stringify(t2.a.meta).slice(0, 120));
  const ob2 = typeof t2.s.objections === "string" ? JSON.parse(t2.s.objections) : t2.s.objections;
  check("m2 session.objections = [PRICE count 1]", Array.isArray(ob2) && ob2.length === 1 && ob2[0].type === "PRICE" && ob2[0].count === 1, JSON.stringify(ob2));
  const d2 = await poll("GC18 m2 draft", async () => draftOf(m2.msgId));
  check("m2 draft = 接住顧慮 + approved 講法（精確）", d2?.draftText === D.objectionIgo, d2?.draftText);
  check("m2 stage 保持 DISCOVER（無escalate）", t2.s.stage === "DISCOVER", t2.s.stage);
  const m3 = await inbound(wa, "五萬真係好貴，箍牙");
  const s3 = await waitTerminal(m3.convId, "HANDOFF");
  const a8 = await engineAudit(s3.id, 8);
  check("m3 row 8（PRICE ≥2）→ HANDOFF", a8 !== null && s3.terminal === "HANDOFF");
  const ob3 = typeof s3.objections === "string" ? JSON.parse(s3.objections) : s3.objections;
  check("m3 objection count = 2 + RECURRED", Array.isArray(ob3) && ob3.length === 1 && ob3[0].type === "PRICE" && ob3[0].count === 2 && ob3[0].status === "RECURRED", JSON.stringify(ob3));
  const n3 = await waitNotice(m3.convId, "HANDOFF_REQUEST");
  check("m3 HANDOFF_REQUEST 通知", n3 !== null);
  check("m3 purchaseIntent = 0.0（0.1 - 0.1 落底 clamp）", s3.purchaseIntent === 0, String(s3.purchaseIntent));
}

async function gc19a(ctx: Ctx): Promise<void> {
  console.log("\n[GC-19a] 採用草稿 → 唔算 human takeover（engine 照行）");
  const wa = "e2ec6-gc19a";
  const m1 = await inbound(wa, "我想箍牙");
  const t1 = await waitTurn(m1.convId, 1, 16);
  const d1 = await poll("GC19a m1 draft", async () => draftOf(m1.msgId));
  check("m1 draft PROPOSED（DRAFT mode 無 auto-send）", d1 !== null && d1.status === "PROPOSED", d1?.status);
  const st = await staffSend(ctx.adminCookie, m1.convId, d1?.draftText ?? "", "adopted");
  check("adopted send → 200/202", st === 200 || st === 202, String(st));
  const out = await poll(
    "GC19a OUT(AI_ADOPTED)",
    async () => (await prisma.message.findFirst({ where: { conversationId: m1.convId, direction: "OUT", sentVia: "AI_ADOPTED" } })) ?? null,
  );
  check("OUT 訊息 sentVia = AI_ADOPTED", out !== null);
  const c1 = await prisma.conversation.findUnique({ where: { id: m1.convId } });
  check("conv.humanTookOver = false（採用唔算 takeover）", c1?.humanTookOver === false, String(c1?.humanTookOver));
  const m2 = await inbound(wa, "箍牙，唔想俾人見到");
  const t2 = await waitTurn(m2.convId, 2, 16);
  const d2 = await poll("GC19a m2 draft", async () => draftOf(m2.msgId));
  check("m2 engine 照行（turnCount=2 + 新草稿）", t2.s.turnCount === 2 && d2 !== null);
  check("m2 session.humanTookOver = false（採用唔算 takeover）", t2.s.humanTookOver === false);
  check("m2 session.humanTookOver = false", t2.s.humanTookOver === false);
  // 注意：首次 staff send 會 auto-claim → 多一條 claim 通知 OUT（sentVia=null，「XX 接手咗」）— 設計如此
  const outCount = await prisma.message.count({ where: { conversationId: m1.convId, direction: "OUT", sentVia: "AI_ADOPTED" } });
  check("AI_ADOPTED OUT 只有一條（採用嗰條）", outCount === 1, String(outCount));
  check("AI_ADOPTED OUT body = 採用草稿原文", out?.body === d1?.draftText, (out?.body ?? "").slice(0, 60));
}

async function gc19b(ctx: Ctx): Promise<void> {
  console.log("\n[GC-19b] 人手打字 → human takeover（engine 靜音）");
  const wa = "e2ec6-gc19b";
  const m1 = await inbound(wa, "我想箍牙");
  await waitTurn(m1.convId, 1, 16);
  const st = await staffSend(ctx.adminCookie, m1.convId, "e2ec6 人手覆：多謝你嘅查詢", "typed");
  check("typed send → 200/202", st === 200 || st === 202, String(st));
  const c1 = await poll(
    "GC19b humanTookOver=true",
    async () => {
      const c = await prisma.conversation.findUnique({ where: { id: m1.convId } });
      return c?.humanTookOver === true ? c : null;
    },
  );
  check("conv.humanTookOver = true（打字 = takeover）", c1 !== null);
  const m2 = await inbound(wa, "箍牙，想再問下");
  const u2 = await waitUnprocessed(m2.convId, 6);
  check("m2 row 6（humanTookOver）processed=false", ameta(u2.a).row === 6 && ameta(u2.a).processed === false);
  check("m2 session.humanTookOver = true（sync）", u2.s.humanTookOver === true);
  check("m2 turnCount 不變（=1）", u2.s.turnCount === 1, String(u2.s.turnCount));
  const d2 = await draftOf(m2.msgId);
  check("m2 零草稿（takeover 靜音）", d2 === null);
}

async function gc20(): Promise<void> {
  console.log("\n[GC-20] 最後 inbound >24h → WINDOW_EXPIRED_HANDOFF");
  const wa = "e2ec6-gc20";
  const m1 = await inbound(wa, "我想箍牙");
  const t1 = await waitTurn(m1.convId, 1, 16);
  const convId = m1.convId;
  const old = new Date(Date.now() - 25 * 3600 * 1000);
  await prisma.conversation.update({ where: { id: convId }, data: { lastInboundAt: old, lastMessageAt: old } });
  const wamid = newWamid("e2ec6gc20old");
  const m2 = await prisma.message.create({
    data: {
      conversationId: convId,
      direction: "IN",
      channel: "API",
      type: "text",
      body: "我諗好喇，想約箍牙",
      waMessageId: wamid,
      waTimestamp: old,
      status: "RECEIVED",
    },
  });
  await runScript(["e2e:ai-job", "requeue", "--conversation", convId, "--message", m2.id, "--clinic", clinicId], "REQUEUED");
  const u2 = await waitUnprocessed(convId, 4);
  check("m2 row 4（窗口過期）processed=false", ameta(u2.a).row === 4 && ameta(u2.a).processed === false);
  const c2 = await prisma.conversation.findUnique({ where: { id: convId } });
  check("m2 conv.consultGateAction = WINDOW_EXPIRED_HANDOFF", c2?.consultGateAction === "WINDOW_EXPIRED_HANDOFF", String(c2?.consultGateAction));
  const s2 = await anySession(convId);
  check("m2 turnCount 不變（=1）", s2?.turnCount === 1, String(s2?.turnCount));
  check("m2 唔建新 session（active 保持）", (await prisma.consultSession.count({ where: { conversationId: convId } })) === 1);
  const d2 = await draftOf(m2.id);
  check("m2 零草稿（窗口外）", d2 === null);
  const outCount = await prisma.message.count({ where: { conversationId: convId, direction: "OUT" } });
  check("m2 零 OUT", outCount === 0, String(outCount));
  void t1;
}

async function gc21(ctx: Ctx): Promise<void> {
  console.log("\n[GC-21] preview：usable 過濾（unapproved 唔入草稿）");
  const r = await api(ctx.adminCookie, "/api/admin/consult/preview", "POST", {
    workflow: "ORTHODONTIC_CONSULT",
    clinicId,
    demoQuestion: "我想箍牙，唔想俾人見到，又想快啲",
  });
  check("preview → 200", r.status === 200, String(r.status));
  const j = r.json as Record<string, any> | null;
  check("preview usableProducts = 2（igo + ifull）", j?.usableProducts === 2, JSON.stringify(j?.usableProducts));
  check("preview unapprovedCount = 4（local trad + global 3 pending）", j?.unapprovedCount === 4, JSON.stringify(j?.unapprovedCount));
  check("preview draft 含兩款 usable 產品名", (j?.draft ?? "").includes("e2ec6 隱適美 I GO") && (j?.draft ?? "").includes("e2ec6 完整 Invisalign"), j?.draft);
  check("preview draft 無 unapproved 產品（e2ec6 傳統牙箍）", !(j?.draft ?? "").includes("e2ec6 傳統牙箍"));
  check("preview extract slotUpdates（appearance HIGH + speed HIGH）", j?.extract?.slotUpdates?.appearancePriority === "HIGH" && j?.extract?.slotUpdates?.speedPriority === "HIGH", JSON.stringify(j?.extract));
  check("preview blocked = false", j?.blocked === false);
}

async function gc22(ctx: Ctx): Promise<void> {
  console.log("\n[GC-22] 內容改動 → approvalCleared（unapprove）");
  const r = await api(ctx.adminCookie, `/api/admin/consult-products/${igoId}`, "PUT", {
    approvedWording: "e2ec6 I GO C6 改過嘅新講法",
  });
  check("PUT 內容改動 → 200", r.status === 200, String(r.status));
  const j = r.json as Record<string, any> | null;
  check("回應 approvalCleared = true", j?.approvalCleared === true, JSON.stringify(j).slice(0, 200));
  const p = await prisma.consultProduct.findUnique({ where: { id: igoId } });
  check("DB approvedAt = null（unapproved）", p?.approvedAt === null);
  check("DB approvedWording = 新值", p?.approvedWording === "e2ec6 I GO C6 改過嘅新講法");
  const aud = await prisma.auditLog.findFirst({
    where: { action: "CONSULT_PRODUCT_UPDATE", entityId: igoId },
    orderBy: { createdAt: "desc" },
  });
  check("audit CONSULT_PRODUCT_UPDATE approvalCleared=true", (aud?.meta as Record<string, unknown> | undefined)?.approvalCleared === true, JSON.stringify(aud?.meta).slice(0, 160));
  const r2 = await api(ctx.adminCookie, "/api/admin/consult/preview", "POST", {
    workflow: "ORTHODONTIC_CONSULT",
    clinicId,
    demoQuestion: "我想箍牙，唔想俾人見到",
  });
  const j2 = r2.json as Record<string, any> | null;
  check("改後 preview usableProducts = 1", j2?.usableProducts === 1, JSON.stringify(j2?.usableProducts));
  check("改後 preview unapprovedCount = 5", j2?.unapprovedCount === 5, JSON.stringify(j2?.unapprovedCount));
  check("改後 preview draft 無 igo（unusable 唔入）", !(j2?.draft ?? "").includes("e2ec6 隱適美 I GO"), j2?.draft);
}

async function gc23(ctx: Ctx): Promise<void> {
  console.log("\n[GC-23] preview 零副作用（零 DB write + 零 usage）");
  const snap = async () => ({
    consultSession: await prisma.consultSession.count(),
    message: await prisma.message.count(),
    aiDraft: await prisma.aiDraft.count(),
    auditLog: await prisma.auditLog.count(),
    booking: await prisma.bookingSession.count(),
    pain: await prisma.painTriageSession.count(),
    stats: (await prisma.aiCallStats.findUnique({ where: { id: 1 } })) ?? null,
  });
  const before = await snap();
  const r1 = await api(ctx.adminCookie, "/api/admin/consult/preview", "POST", {
    workflow: "ORTHODONTIC_CONSULT",
    clinicId,
    demoQuestion: "我想箍牙，唔想俾人見到",
  });
  check("preview(a) 正常 → 200 + draft", r1.status === 200 && !!(r1.json as Record<string, any>)?.draft, String(r1.status));
  const r2 = await api(ctx.adminCookie, "/api/admin/consult/preview", "POST", {
    workflow: "IMPLANT_CONSULT",
    clinicId,
    demoQuestion: "我想做植牙 E2E-CG-005",
  });
  const j2 = r2.json as Record<string, any> | null;
  check("preview(b) CG-005 bait → blocked=true", j2?.blocked === true, JSON.stringify(j2?.blocked));
  check("preview(b) cgCode = CG-005", j2?.cgCode === "CG-005", JSON.stringify(j2?.cgCode));
  check("preview(b) draft = 人手提示", j2?.draft === CLAIM_HUMAN_TEXT, j2?.draft);
  const after = await snap();
  check("preview 零 ConsultSession 寫", before.consultSession === after.consultSession, `${before.consultSession} → ${after.consultSession}`);
  check("preview 零 Message 寫", before.message === after.message, `${before.message} → ${after.message}`);
  check("preview 零 AiDraft 寫", before.aiDraft === after.aiDraft, `${before.aiDraft} → ${after.aiDraft}`);
  check("preview 零 AuditLog 寫", before.auditLog === after.auditLog, `${before.auditLog} → ${after.auditLog}`);
  check("preview 零 booking/pain session 寫", before.booking === after.booking && before.pain === after.pain);
  check("preview 零 usage（AiCallStats total/ok/updatedAt 不變）",
    before.stats?.totalCalls === after.stats?.totalCalls &&
    before.stats?.okCalls === after.stats?.okCalls &&
    before.stats?.updatedAt?.toISOString() === after.stats?.updatedAt?.toISOString(),
    JSON.stringify({ b: before.stats?.totalCalls, a: after.stats?.totalCalls }),
  );
  void ctx;
}

// ══════════════════════════════════════════════════════════════════════
// S3/S4 — 審計
// ══════════════════════════════════════════════════════════════════════
async function s3BannedWords(): Promise<void> {
  console.log("\n[S3] 草稿禁詞審計（你最適合／你一定／保證／成功率／好過 零出現）");
  const convs = (await prisma.conversation.findMany({ where: { clinicId }, select: { id: true } })).map((c) => c.id);
  const drafts = await prisma.aiDraft.findMany({ where: { conversationId: { in: convs } }, select: { id: true, draftText: true } });
  check(`審計樣本數（${drafts.length} 條草稿）`, drafts.length >= 20, String(drafts.length));
  for (const w of BANNED_WORDS) {
    const hits = drafts.filter((d) => (d.draftText ?? "").includes(w));
    check(`禁詞「${w}」零出現`, hits.length === 0, hits.map((h) => h.draftText.slice(0, 60)).join(" | "));
  }
}

async function s4LlmCalls(ctx: Ctx): Promise<void> {
  console.log("\n[S4] LLM call 計數審計（≤3/turn；mock = classify+extract+generate）");
  const convs = (await prisma.conversation.findMany({ where: { clinicId }, select: { id: true } })).map((c) => c.id);
  const sessions = await prisma.consultSession.findMany({ where: { conversationId: { in: convs } }, select: { id: true } });
  const ids = sessions.map((s) => s.id);
  const audits = await prisma.auditLog.findMany({ where: { action: "CONSULT_LLM_TURN", entityId: { in: ids } } });
  check(`LLM turn audit 數量（${audits.length}）`, audits.length >= 20, String(audits.length));
  const over3 = audits.filter((a) => ((a.meta as Record<string, unknown>).calls as number ?? 0) > 3);
  check("所有 turn calls ≤ 3（MD §9.2 口徑）", over3.length === 0, JSON.stringify(over3.map((a) => a.meta)));
  const fullTurns = audits.filter((a) => (a.meta as Record<string, unknown>).calls === 2);
  check(`完整 turn（extract+generate=2 calls）數（${fullTurns.length}）`, fullTurns.length >= 18, String(fullTurns.length));
  // usage：主 classify + pain turn 計入 AiCallStats（consult extract/generate 唔計 — 口徑同 C4）
  const stats = await prisma.aiCallStats.findUnique({ where: { id: 1 } });
  const inMsgs = await prisma.message.count({ where: { conversationId: { in: convs }, direction: "IN" } });
  if (ctx.statsBefore && stats) {
    const delta = stats.totalCalls - (ctx.statsBefore.totalCalls as number);
    check(
      `usage delta 合理（${delta} ≥ IN ${inMsgs}，upper bound IN×2+8）`,
      delta >= inMsgs && delta <= inMsgs * 2 + 8,
      `delta=${delta} in=${inMsgs}`,
    );
  }
}

// ══════════════════════════════════════════════════════════════════════
// main
// ══════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  console.log("══ e2e-consult-c6 — CONSULT v2.1 §9 全量 + §10 驗收 ══");
  await s0Unit();
  // 開場 pre-sweep（冪等）
  await sweep();
  const creds = readFileSync(process.env.HOME + "/.openclaw/workspace/wa-clinic-inbox/.dev/credentials.txt", "utf8");
  const adminLine = creds.split("\n").find((l) => l.startsWith("ADMIN:")) ?? "";
  const [aEmail, aPass] = adminLine.slice("ADMIN:".length).trim().split(" / ");
  if (!aEmail || !aPass) throw new Error("credentials.txt ADMIN 行格式錯");
  const adminCookie = await login(aEmail, aPass);
  const ctx = await s1Fixture(adminCookie);
  try {
    await gc01();
    await gc02();
    await gc03();
    await gc04();
    await gc05();
    await gc06();
    await gc07();
    await gc08();
    await gc09_10();
    await gc11();
    await gc12();
    await gc13();
    await gc14a();
    await gc14b();
    await gc15();
    await gc16();
    await gc17();
    await gc18();
    await gc19a(ctx);
    await gc19b(ctx);
    await gc20();
    await gc21(ctx);
    await gc22(ctx);
    await gc23(ctx);
    await s3BannedWords();
    await s4LlmCalls(ctx);
  } finally {
    await sweep();
    const residue = await residueCheck();
    check("residue = 0（e2ec6 全洗）", residue === 0, String(residue));
  }
  if (fail > 0) {
    console.error(`\nC6-FAIL: ${fail} 項失敗 / ${pass} 項過`);
    process.exitCode = 1;
  } else {
    console.log(`\nC6-OK (${pass} pass)`);
  }
}

main()
  .catch(async (e) => {
    console.error("C6-FATAL:", e instanceof Error ? e.stack ?? e.message : e);
    if (sweepRef) {
      try {
        await sweepRef();
      } catch (e2) {
        console.error("fatal sweep error:", e2 instanceof Error ? e2.message : e2);
      }
    }
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

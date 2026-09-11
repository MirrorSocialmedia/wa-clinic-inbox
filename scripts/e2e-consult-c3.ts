/**
 * e2e-consult-c3 — consult v2.1 C3（§4 規則引擎）scripted 多 turn 對話 e2e
 *
 * 前置：dev stack live（server 3100 / DB 15432 / worker AI_MOCK=1）— 先 warm 關鍵 route。
 * 跑法（repo root）：pnpm e2e:consult-c3
 *
 * 覆蓋（MD §9.2 + C3 scope）— fixture 前綴 e2ec3-：
 *   S0  #0 紅旗 FLOOR → HANDOFF / S1  #1 痛症 → PAIN_TRIAGE（+ 既有 pain session）
 *   S2  #2 COMPLAINT → HANDOFF_HUMAN / S3  #3 真人要求 → HANDOFF_HUMAN（+ staffNotice）
 *   S4  #4 窗口已過（old-inbound 25h）→ processed:false + consultGateAction（C1 gate 口徑）
 *   S5  #5 叫停 → COMPLETED/END_SESSION + 零草稿 + follow-up audit
 *   S6  #6 humanTookOver（staff typed → conv → session sync）→ NO_DRAFT
 *   S7  #7 maxTurns 8 → HANDOFF + staffNotice / S8  #8 PRICE×2（GC-18 口徑）→ HANDOFF
 *   S9  #9 高意向 → BOOKING/COMPLETED/START_BOOKING（TKW legacy 無 booking session）
 *   S10 #10 objection FEAR → HANDLE_OBJECTION / S11 #11 邊款最適合 → CONSULTATION
 *   S12 #12 療程時間 → EDUCATE_DETAIL / S13 #13 臨床（脫牙）→ CONSULTATION
 *   S14 #14 指名產品問價（usable）→ ANSWER_PRICE；（未批准 iron rule）→ 唔入匹配 #16
 *   S15 #15 比較 → EDUCATE/EDUCATE_COMPARE
 *   S16 #16 DISCOVER slot 流（4 問 + 問完 stay）/ S17 #17 minimum slots 齊 → PRESENT_OPTIONS
 *   S18 #18 EDUCATE 比較完成 → PRESENT_OPTIONS / S19 #19 PRESENT clinical UNKNOWN → CONSULTATION
 *   S20 #20 intent ≥0.6（seed 0.45 + 問價 Δ0.15）→ START_BOOKING
 *   S21 #21 CONSULTATION 接受 → START_BOOKING / S22 #22 推搪 → COMPLETED + 零草稿 + follow-up
 *   S23 #23 48h cron（49h backdate + runConsultExpireSweep）→ EXPIRED + Δ−0.15 + 新 trigger 開新 session
 *   S24 #24 CTA turn 6（+ 重復唔觸發 + turn 8 → #7）
 *   S25 橋接複製（staff 先講 → 新 session copy humanTookOver/lastOutboundText）
 *   S26 T245 ≥7 日 → 舊 EXPIRED 唔復活 + 新 trigger 開新 session（C2 守衛）
 *   S27 LLM trigger fallback（E2E-CONSULT-TRIG-NOFLOOR → IMPLANT_CONSULT）
 *
 * 口徑（C3 範圍紀律）：slot 抽取（問→答案落 slots）= C4 範圍 — 需要「slots 已填」嘅 case
 * （S17/S18/S19/S20/S24）用 DB 直接 seed slots/stage（模擬 C4 落庫結果）；
 * DISCOVER 問 slot 嘅流（S16）只斷言 askedSlots 唔重問 + 每輪一條（engine 部分）。
 *
 * 冪等：開場 pre-sweep + 收場 end-sweep + fatal sweep（fixture 前綴 e2ec3- 全洗）。
 * 退出碼：0 = 全過；1 = 有 fail。
 */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { PrismaClient, type NoticeKind } from "@prisma/client";
import { runConsultExpireSweep } from "../src/lib/sessions/consult-runner";

const BASE = "http://127.0.0.1:3100";
const REPO = new URL("..", import.meta.url).pathname;
const prisma = new PrismaClient();

const WIDS = [
  "e2ec3-s0", "e2ec3-s1", "e2ec3-s2", "e2ec3-s3", "e2ec3-s4", "e2ec3-s5", "e2ec3-s6",
  "e2ec3-s7", "e2ec3-s8", "e2ec3-s9", "e2ec3-s10", "e2ec3-s11", "e2ec3-s12", "e2ec3-s13",
  "e2ec3-s14a", "e2ec3-s14b", "e2ec3-s15", "e2ec3-s16", "e2ec3-s17", "e2ec3-s18",
  "e2ec3-s19", "e2ec3-s20", "e2ec3-s21", "e2ec3-s22", "e2ec3-s23", "e2ec3-s24",
  "e2ec3-s25", "e2ec3-s26", "e2ec3-s27",
];
const CODE_PREFIX = "e2ec3";

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
const approx = (a: number | null | undefined, b: number) => a != null && Math.abs(a - b) < 1e-9;

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
  if (res.status !== 200) throw new Error(`login ${email} → ${res.status}`);
  const sc = res.headers.get("set-cookie") ?? "";
  const m = sc.match(/wa_inbox_session=([^;]+)/);
  if (!m) throw new Error("login: no wa_inbox_session cookie");
  return m[1];
}
async function api(cookie: string, path: string, method: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const doFetch = async () => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: `wa_inbox_session=${cookie}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch { /* html error page */ }
    return { status: res.status, json };
  };
  const out = await doFetch();
  // 已記錄環境 flake（TOOLS.md）：Next 15 dev loadManifest race → 瞬時 500 HTML error page。
  if (out.status === 500 && out.json === null) {
    await sleep(1500);
    const retry = await doFetch();
    if (retry.json !== null) return retry;
  }
  return out;
}

// ── inbound / helpers ─────────────────────────────────────────────────
/** 病人 inbound（mock webhook）— 等 IN Message 落庫。 */
async function inbound(waId: string, text: string): Promise<{ msgId: string; convId: string }> {
  // loadManifest race（Next 15 dev 已知 flake）→ mock-inbound 500 → 只重試一次（infra 層，唔係放弱斷言）
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
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
  }
  if (spawnErr) throw spawnErr;
  return poll(
    `IN message ${waId} ${text.slice(0, 14)}`,
    async () => {
      const msg = await prisma.message.findFirst({ where: { direction: "IN", body: text }, orderBy: { createdAt: "desc" } });
      if (!msg) return null;
      const conv = await prisma.conversation.findUnique({ where: { id: msg.conversationId } });
      const contact = conv ? await prisma.contact.findFirst({ where: { id: conv.contactId } }) : null;
      return contact?.waId === waId && conv ? { msgId: msg.id, convId: conv.id } : null;
    }
  );
}

/** 過窗 inbound（25h 前 lastInboundAt — DB 直寫 + 排 ai job；真 webhook 會打新窗口，C1 同口徑）。 */
async function oldInbound(waId: string, text: string): Promise<{ convId: string; msgId: string }> {
  const out = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const c = spawn("pnpm", ["-s", "e2e:ai-job", "old-inbound", "--clinic", "TKW", "--from", waId, "--text", text], { cwd: REPO });
    c.stdout.on("data", (d) => (buf += String(d)));
    c.stderr.on("data", (d) => (buf += String(d)));
    c.on("close", (code) => (code === 0 ? resolve(buf) : reject(new Error(`e2e:ai-job exit ${code}: ${buf.slice(0, 200)}`))));
  });
  const convMatch = out.match(/CONV=(\S+)/);
  const msgMatch = out.match(/MSG=(\S+)/);
  if (!convMatch) throw new Error(`old-inbound: no CONV in ${out.slice(0, 200)}`);
  return { convId: convMatch[1], msgId: msgMatch?.[1] ?? "" };
}

/** staff 手動回覆（source=typed → conv.humanTookOver=true + lastOutboundText）。 */
async function staffSend(staffCookie: string, convId: string, body: string): Promise<number> {
  const r = await api(staffCookie, "/api/messages/send", "POST", { conversationId: convId, body, source: "typed" });
  return r.status;
}

/** active consult session（terminal=null）。 */
const activeSession = (convId: string) =>
  prisma.consultSession.findFirst({ where: { conversationId: convId, terminal: null } });

/** 等 session 有 >=minTurns 嘅 turn（processed）+ 指定 audit row 落。 */
async function waitTurn(convId: string, minTurns: number, auditRow: number, timeoutMs = 40_000) {
  return poll(
    `turn>=${minTurns} + audit row=${auditRow} conv=${convId.slice(0, 8)}`,
    async () => {
      const s = await activeSession(convId);
      if (!s || s.turnCount < minTurns) return null;
      const a = await prisma.auditLog.findFirst({
        where: { action: "CONSULT_ENGINE_TURN", entityId: s.id, meta: { path: ["row"], equals: auditRow } },
        orderBy: { createdAt: "desc" },
      });
      return a ? { s, a } : null;
    },
    timeoutMs
  );
}

/** 等 processed:false 嘅 audit row（#4/#6 — turnCount 唔增）。 */
async function waitUnprocessed(convId: string, auditRow: number, timeoutMs = 40_000) {
  return poll(
    `unprocessed audit row=${auditRow} conv=${convId.slice(0, 8)}`,
    async () => {
      const s = await activeSession(convId);
      if (!s) return null;
      const a = await prisma.auditLog.findFirst({
        where: {
          action: "CONSULT_ENGINE_TURN",
          entityId: s.id,
          AND: [{ meta: { path: ["row"], equals: auditRow } }, { meta: { path: ["processed"], equals: false } }],
        },
        orderBy: { createdAt: "desc" },
      });
      return a ? { s, a } : null;
    },
    timeoutMs
  );
}

/** 等 terminal session（任何 terminal）。 */
async function waitTerminal(convId: string, wantTerminal: string, timeoutMs = 40_000) {
  return poll(
    `terminal=${wantTerminal} conv=${convId.slice(0, 8)}`,
    async () => {
      const s = await prisma.consultSession.findFirst({
        where: { conversationId: convId, terminal: wantTerminal },
        orderBy: { createdAt: "desc" },
      });
      return s ?? null;
    },
    timeoutMs
  );
}

/** session 欄 seed（模擬 C4 slot 抽取 / 測試狀態設定）。 */
async function seedActive(convId: string, data: Record<string, unknown>): Promise<void> {
  const s = await activeSession(convId);
  if (!s) throw new Error(`seedActive: no active session ${convId.slice(0, 8)}`);
  await prisma.consultSession.update({ where: { id: s.id }, data });
}

/** backdate session.updatedAt（@updatedAt 欄 Prisma client 唔可寫 — raw SQL）。 */
async function backdateSessionHours(sessionId: string, hours: number): Promise<void> {
  // ★ 陷阱（實測）：DB session tz = Asia/Hong_Kong + 欄係 naive timestamp —
  // 裸 `now()` = HK wall-clock，Prisma 當 UTC 讀 → 8h 偏斜。用 epoch 算術寫 UTC wall-clock（同 Prisma 寫入口徑）。
  await prisma.$executeRaw`UPDATE "ConsultSession" SET "updatedAt" = ('1970-01-01 00:00:00'::timestamp + make_interval(secs => EXTRACT(EPOCH FROM now())::int - ${hours * 3600})) WHERE id = ${sessionId}`;
}

/** 等 staffNotice（預設 kind HANDOFF_REQUEST）。 */
async function waitNotice(convId: string, kind: NoticeKind = "HANDOFF_REQUEST", timeoutMs = 30_000) {
  return poll(`staffNotice conv=${convId.slice(0, 8)} kind=${kind}`, async () => {
    const n = await prisma.staffNotice.findFirst({ where: { conversationId: convId, kind }, orderBy: { createdAt: "desc" } });
    return n ?? null;
  }, timeoutMs);
}

async function main(): Promise<void> {
  const credsText = readFileSync(new URL("../.dev/credentials.txt", import.meta.url).pathname, "utf8");
  const adminLine = credsText.split("\n").find((l) => l.startsWith("ADMIN:")) ?? "";
  const staffLine = credsText.split("\n").find((l) => l.startsWith("TKW STAFF:")) ?? "";
  const [adminEmail, adminPw] = adminLine.split(": ").slice(1).join(": ").split(" / ");
  const [staffEmail, staffPw] = staffLine.split(": ").slice(1).join(": ").split(" / ");
  if (!adminEmail || !adminPw || !staffEmail || !staffPw) throw new Error("credentials: missing");
  const adminCookie = await login(adminEmail, adminPw);
  const staffCookie = await login(staffEmail, staffPw);

  const clinic = await prisma.clinic.findUnique({ where: { code: "TKW" } });
  if (!clinic) throw new Error("TKW clinic not found");
  const tkw = clinic.id;

  // ── 冪等 sweep（pre / end / fatal）— 前綴 e2ec3- 全洗 ─────────────────
  const sweep = async (label: string): Promise<void> => {
    try {
      const products = await prisma.consultProduct.findMany({ where: { code: { startsWith: CODE_PREFIX } }, select: { id: true } });
      const ctRows = await prisma.contact.findMany({ where: { waId: { in: WIDS } }, select: { id: true } });
      const convs = ctRows.length
        ? await prisma.conversation.findMany({ where: { contactId: { in: ctRows.map((c) => c.id) } }, select: { id: true } })
        : [];
      const convIds = convs.map((c) => c.id);
      const msgIds = convIds.length
        ? (await prisma.message.findMany({ where: { conversationId: { in: convIds } }, select: { id: true } })).map((m) => m.id)
        : [];
      const sessIds = convIds.length
        ? (await prisma.consultSession.findMany({ where: { conversationId: { in: convIds } }, select: { id: true } })).map((s) => s.id)
        : [];
      if (convIds.length) {
        await prisma.$transaction([
          prisma.aiDraft.deleteMany({ where: { conversationId: { in: convIds } } }),
          prisma.consultSession.deleteMany({ where: { conversationId: { in: convIds } } }),
          prisma.painTriageSession.deleteMany({ where: { conversationId: { in: convIds } } }),
          prisma.bookingSession.deleteMany({ where: { conversationId: { in: convIds } } }),
          prisma.flowSession.deleteMany({ where: { conversationId: { in: convIds } } }),
          prisma.staffNotice.deleteMany({ where: { conversationId: { in: convIds } } }),
          prisma.message.deleteMany({ where: { conversationId: { in: convIds } } }),
          prisma.auditLog.deleteMany({ where: { entityId: { in: [...msgIds, ...convIds, ...sessIds, ...products.map((p) => p.id)] } } }),
          prisma.conversation.deleteMany({ where: { id: { in: convIds } } }),
        ]);
      }
      await prisma.contact.deleteMany({ where: { waId: { in: WIDS } } });
      await prisma.consultProduct.deleteMany({ where: { code: { startsWith: CODE_PREFIX } } });
      console.log(`[sweep:${label}] 完成`);
    } catch (e) {
      console.error(`[sweep:${label}] FAILED:`, e instanceof Error ? e.message : e);
    }
  };
  sweepRef = sweep;
  await sweep("pre");

  // 產品 fixture（S14/S15/S18/S19/S20/S24 用）
  const mkProduct = (extra: Record<string, unknown>) =>
    api(adminCookie, "/api/admin/consult-products", "POST", {
      clinicId: tkw, workflow: "ORTHODONTIC_CONSULT", code: `${CODE_PREFIX}P`,
      displayName: "e2ec3隱適美", brand: "e2ec3igo", positioning: "e2ec3 隱形", approvedWording: "e2ec3 批准講法", sortOrder: 1,
      approvedBy: "e2e", approvedAt: new Date().toISOString(), ...extra,
    });
  const rP = await mkProduct({ code: `${CODE_PREFIX}P` });
  check("產品 e2ec3P（usable）建立 → 201", rP.status === 201, JSON.stringify(rP.json).slice(0, 150));
  const rQ = await mkProduct({ code: `${CODE_PREFIX}Q`, displayName: "e2ec3未批准", approvedAt: null, approvedBy: undefined });
  check("產品 e2ec3Q（未批准 iron rule）建立 → 201 + usable=false", rQ.status === 201 && (rQ.json as { usable?: boolean })?.usable === false, JSON.stringify(rQ.json).slice(0, 150));

  // ── S0 #0 紅旗 FLOOR → HANDOFF ───────────────────────────────────────
  console.log("\n[S0] #0 紅旗 FLOOR（面腫）→ HANDOFF");
  {
    const { convId } = await inbound("e2ec3-s0", "我想箍牙，但我塊面腫咗");
    const s = await waitTerminal(convId, "HANDOFF");
    check("session terminal=HANDOFF", s?.terminal === "HANDOFF", JSON.stringify({ terminal: s?.terminal }));
    check("lastAction=HANDOFF_HUMAN + stage=HANDOFF", s?.lastAction === "HANDOFF_HUMAN" && s?.stage === "HANDOFF", JSON.stringify({ la: s?.lastAction, stage: s?.stage }));
    const a = await prisma.auditLog.findFirst({ where: { action: "CONSULT_ENGINE_TURN", entityId: s?.id, meta: { path: ["row"], equals: 0 } } });
    check("audit row 0（紅旗）", !!a, "no row-0 audit");
    const c = await prisma.conversation.findUnique({ where: { id: convId } });
    check("conv.urgent=true（fast path URGENT_PAIN）", c?.urgent === true, String(c?.urgent));
    const n = await waitNotice(convId, "URGENT_ESCALATION").catch(() => null);
    check("staffNotice URGENT_ESCALATION（既有 urgent 路徑 — engine 唔重發 HANDOFF_REQUEST）", !!n, "no notice");
  }

  // ── S1 #1 痛症（非紅旗）→ PAIN_TRIAGE ────────────────────────────────
  console.log("\n[S1] #1 痛症訊號（牙好痛 — 非 FLOOR）→ PAIN_TRIAGE + 既有 pain session");
  {
    const { convId } = await inbound("e2ec3-s1", "我想箍牙，但我牙好痛");
    const s = await waitTerminal(convId, "HANDOFF");
    check("session terminal=HANDOFF + lastAction=PAIN_TRIAGE", s?.terminal === "HANDOFF" && s?.lastAction === "PAIN_TRIAGE", JSON.stringify({ la: s?.lastAction }));
    const a = await prisma.auditLog.findFirst({ where: { action: "CONSULT_ENGINE_TURN", entityId: s?.id, meta: { path: ["row"], equals: 1 } } });
    check("audit row 1（痛症）", !!a, "no row-1 audit");
    const pain = await prisma.painTriageSession.findFirst({ where: { conversationId: convId } });
    check("既有 PAIN 路徑開 painTriageSession（唔發明 — 對接現有 code）", !!pain, "no pain session");
  }

  // ── S2 #2 COMPLAINT → HANDOFF_HUMAN ─────────────────────────────────
  console.log("\n[S2] #2 COMPLAINT → HANDOFF_HUMAN");
  {
    const { convId } = await inbound("e2ec3-s2", "箍牙，我想投訴");
    const s = await waitTerminal(convId, "HANDOFF");
    check("session terminal=HANDOFF + lastAction=HANDOFF_HUMAN", s?.terminal === "HANDOFF" && s?.lastAction === "HANDOFF_HUMAN", JSON.stringify({ la: s?.lastAction }));
    const a = await prisma.auditLog.findFirst({ where: { action: "CONSULT_ENGINE_TURN", entityId: s?.id, meta: { path: ["row"], equals: 2 } } });
    check("audit row 2（COMPLAINT）", !!a, "no row-2 audit");
    const n = await waitNotice(convId).catch(() => null);
    check("staffNotice（既有 COMPLAINT 路徑 — engine 唔重發）", !!n, "no notice");
  }

  // ── S3 #3 真人要求 → HANDOFF_HUMAN（engine 自發 notice） ──────────────
  console.log("\n[S3] #3 明確要求真人 → HANDOFF_HUMAN + engine staffNotice");
  {
    const { convId } = await inbound("e2ec3-s3", "我想箍牙，可以搵人工嗎？");
    const s = await waitTerminal(convId, "HANDOFF");
    check("session terminal=HANDOFF + lastAction=HANDOFF_HUMAN", s?.terminal === "HANDOFF" && s?.lastAction === "HANDOFF_HUMAN", JSON.stringify({ la: s?.lastAction }));
    const a = await prisma.auditLog.findFirst({ where: { action: "CONSULT_ENGINE_TURN", entityId: s?.id, meta: { path: ["row"], equals: 3 } } });
    check("audit row 3（真人要求）", !!a, "no row-3 audit");
    const n = await waitNotice(convId).catch(() => null);
    check("engine 補發 staffNotice（intent QUESTION — 非 urgent/complaint）", !!n, "no notice");
  }

  // ── S4 #4 窗口已過（25h old-inbound）→ processed:false ───────────────
  console.log("\n[S4] #4 窗口已過（old-inbound 25h + FLOOR）→ processed:false + C1 gate");
  {
    const { convId } = await oldInbound("e2ec3-s4", "矯齒想知多啲");
    const r = await waitUnprocessed(convId, 4);
    const m4 = r.a.meta as { processed?: boolean } | null;
    check("audit row 4 + processed:false", m4?.processed === false, JSON.stringify(r.a.meta).slice(0, 200));
    check("turnCount 保持 0（窗口過唔洗 idle）", r.s.turnCount === 0, `turnCount=${r.s.turnCount}`);
    check("stage 保持 DISCOVER + lastAction null", r.s.stage === "DISCOVER" && r.s.lastAction === null, JSON.stringify({ stage: r.s.stage, la: r.s.lastAction }));
    const c = await prisma.conversation.findUnique({ where: { id: convId } });
    check("conv.consultGateAction=WINDOW_EXPIRED_HANDOFF（C1 gate）", c?.consultGateAction === "WINDOW_EXPIRED_HANDOFF", String(c?.consultGateAction));
    const d = await prisma.aiDraft.findFirst({ where: { conversationId: convId } });
    check("無 free-form 草稿（C1 gate — 或 routing-r7 template 出路）", !d || d.model === "routing-r7", d ? `model=${d.model}` : "no draft");
  }

  // ── S5 #5 叫停 → COMPLETED/END_SESSION + 零草稿 ──────────────────────
  console.log("\n[S5] #5 病人叫停 → COMPLETED + END_SESSION + 零草稿");
  {
    const t0 = await inbound("e2ec3-s5", "我想箍牙");
    await waitTurn(t0.convId, 1, 16);
    const t1 = await inbound("e2ec3-s5", "唔使再講，箍牙");
    const s = await waitTerminal(t0.convId, "COMPLETED");
    check("terminal=COMPLETED + lastAction=END_SESSION", s?.terminal === "COMPLETED" && s?.lastAction === "END_SESSION", JSON.stringify({ la: s?.lastAction }));
    check("turnCount=2（叫停 turn 照計）", s?.turnCount === 2, `turnCount=${s?.turnCount}`);
    const a = await prisma.auditLog.findFirst({ where: { action: "CONSULT_ENGINE_TURN", entityId: s?.id, meta: { path: ["row"], equals: 5 } } });
    check("audit row 5（叫停）", !!a, "no row-5 audit");
    const fu = await prisma.auditLog.findFirst({ where: { action: "CONSULT_FOLLOWUP_SCHEDULED", entityId: s?.id, meta: { path: ["reason"], equals: "patient-stop" } } });
    check("follow-up audit placeholder（reason=patient-stop — FollowupTask model 未實施）", !!fu, "no follow-up audit");
    await sleep(4000); // 等 worker 有機會（錯誤地）出草稿
    const d = await prisma.aiDraft.findFirst({ where: { conversationId: t0.convId, inReplyToMessageId: t1.msgId } });
    check("叫停 turn 零草稿（suppressDraft）", d === null, d ? `draft=${d.status}` : "no draft");
  }

  // ── S6 #6 humanTookOver（staff typed → sync）→ NO_DRAFT ──────────────
  console.log("\n[S6] #6 humanTookOver（staff typed → conv → session sync）");
  {
    const t0 = await inbound("e2ec3-s6", "我想箍牙");
    await waitTurn(t0.convId, 1, 16);
    const st = await staffSend(staffCookie, t0.convId, "e2ec3 店員回覆：有幾多選擇可以講吓");
    check("staff typed send → 2xx", st === 200 || st === 202, `status=${st}`);
    const t1 = await inbound("e2ec3-s6", "箍牙幾錢？");
    const r = await waitUnprocessed(t0.convId, 6);
    const m6 = r.a.meta as { processed?: boolean } | null;
    check("audit row 6 + processed:false", m6?.processed === false, JSON.stringify(r.a.meta).slice(0, 200));
    check("session.humanTookOver=true（conv → session sync）", r.s.humanTookOver === true, `hto=${r.s.humanTookOver}`);
    check("session.lastOutboundText sync（= staff 回覆）", r.s.lastOutboundText === "e2ec3 店員回覆：有幾多選擇可以講吓", String(r.s.lastOutboundText).slice(0, 60));
    check("turnCount 保持 1（NO_DRAFT 唔計 turn）", r.s.turnCount === 1, `turnCount=${r.s.turnCount}`);
    await sleep(4000);
    const d = await prisma.aiDraft.findFirst({ where: { conversationId: t0.convId, inReplyToMessageId: t1.msgId } });
    check("humanTookOver turn 零草稿（C1 suppress + engine NO_DRAFT）", d === null, d ? `draft=${d.status}` : "no draft");
  }

  // ── S7 #7 maxTurns 8 → HANDOFF ───────────────────────────────────────
  console.log("\n[S7] #7 maxTurns 8（seed turnCount=8）→ HANDOFF + notice");
  {
    const t0 = await inbound("e2ec3-s7", "我想箍牙");
    await waitTurn(t0.convId, 1, 16);
    await seedActive(t0.convId, { turnCount: 8 });
    const t1 = await inbound("e2ec3-s7", "箍牙有幾多選擇？");
    void t1;
    const s = await waitTerminal(t0.convId, "HANDOFF");
    check("terminal=HANDOFF + lastAction=HANDOFF_HUMAN", s?.terminal === "HANDOFF" && s?.lastAction === "HANDOFF_HUMAN", JSON.stringify({ la: s?.lastAction }));
    check("turnCount=9（terminal turn 照計 — 口徑：processed turn +1）", s?.turnCount === 9, `turnCount=${s?.turnCount}`);
    const a = await prisma.auditLog.findFirst({ where: { action: "CONSULT_ENGINE_TURN", entityId: s?.id, meta: { path: ["row"], equals: 7 } } });
    check("audit row 7（maxTurns）", !!a, "no row-7 audit");
    const n = await waitNotice(t0.convId).catch(() => null);
    check("engine 補發 staffNotice（maxTurns 轉人手）", !!n, "no notice");
  }

  // ── S8 #8 PRICE×2（GC-18 口徑）→ HANDOFF ─────────────────────────────
  console.log("\n[S8] #8 PRICE count≥2（三 turn：問價 → 太貴 → 太貴+問價）→ HANDOFF");
  {
    const t0 = await inbound("e2ec3-s8", "箍牙幾錢？");
    let r = await waitTurn(t0.convId, 1, 16);
    check("T1 問價：turn1 + intent 0.1（首次問價 Δ+0.1）", r.s.turnCount === 1 && approx(r.s.purchaseIntent, 0.1), `intent=${r.s.purchaseIntent}`);
    const t1 = await inbound("e2ec3-s8", "箍牙太貴啦");
    void t1;
    r = await waitTurn(t0.convId, 2, 10);
    check("T2 太貴：turn2 + HANDLE_OBJECTION（stage 不變）", r.s.turnCount === 2 && r.s.lastAction === "HANDLE_OBJECTION" && r.s.stage === "DISCOVER", JSON.stringify({ la: r.s.lastAction, stage: r.s.stage }));
    check("T2 objection PRICE count=1 OPEN + intent 0.0（Δ−0.1）", JSON.stringify(r.s.objections).includes('"count":1') && approx(r.s.purchaseIntent, 0.0), JSON.stringify({ obj: r.s.objections, intent: r.s.purchaseIntent }));
    const t2 = await inbound("e2ec3-s8", "箍牙仲係太貴，幾多錢先有？");
    void t2;
    const s = await waitTerminal(t0.convId, "HANDOFF");
    check("T3 再 PRICE：terminal=HANDOFF（本輪後 count=2 — GC-18 第二句即 HANDOFF）", s?.terminal === "HANDOFF" && s?.lastAction === "HANDOFF_HUMAN", JSON.stringify({ la: s?.lastAction }));
    check("stage 保持 DISCOVER（#8 唔改 stage — GC-18）", s?.stage === "DISCOVER", `stage=${s?.stage}`);
    check("objection PRICE count=2 RECURRED", JSON.stringify(s?.objections).includes('"count":2') && JSON.stringify(s?.objections).includes('"RECURRED"'), JSON.stringify(s?.objections));
    const a = await prisma.auditLog.findFirst({ where: { action: "CONSULT_ENGINE_TURN", entityId: s?.id, meta: { path: ["row"], equals: 8 } } });
    check("audit row 8（PRICE≥2）", !!a, "no row-8 audit");
    check("intent 0.05（T3：0.0 + Δ(+0.15 第二次問價 −0.1 太貴)）", approx(s?.purchaseIntent, 0.05), `intent=${s?.purchaseIntent}`);
  }

  // ── S9 #9 高意向 → BOOKING/COMPLETED/START_BOOKING ───────────────────
  console.log("\n[S9] #9 高意向（幫我約）→ BOOKING/COMPLETED/START_BOOKING");
  {
    const { convId } = await inbound("e2ec3-s9", "我想箍牙，幫我約下");
    const s = await waitTerminal(convId, "COMPLETED");
    check("stage=BOOKING + terminal=COMPLETED + lastAction=START_BOOKING", s?.stage === "BOOKING" && s?.terminal === "COMPLETED" && s?.lastAction === "START_BOOKING", JSON.stringify({ stage: s?.stage, la: s?.lastAction }));
    const a = await prisma.auditLog.findFirst({ where: { action: "CONSULT_ENGINE_TURN", entityId: s?.id, meta: { path: ["row"], equals: 9 } } });
    check("audit row 9（高意向）", !!a, "no row-9 audit");
    const bs = await prisma.bookingSession.count({ where: { conversationId: convId } });
    check("TKW legacy（BOOKING_REQUEST 無 policy row → L1/L2）→ 無 bookingSession", bs === 0, `bookingSessions=${bs}`);
  }

  // ── S10 #10 objection FEAR → HANDLE_OBJECTION ────────────────────────
  console.log("\n[S10] #10 新 objection FEAR → HANDLE_OBJECTION（stage 不變）");
  {
    const t0 = await inbound("e2ec3-s10", "我想箍牙");
    await waitTurn(t0.convId, 1, 16);
    const t1 = await inbound("e2ec3-s10", "我想箍牙，但系我啱啱好驚");
    void t1;
    const r = await waitTurn(t0.convId, 2, 10);
    check("turn2 + HANDLE_OBJECTION + stage DISCOVER 不變", r.s.lastAction === "HANDLE_OBJECTION" && r.s.stage === "DISCOVER", JSON.stringify({ la: r.s.lastAction }));
    check("objection FEAR count=1", JSON.stringify(r.s.objections).includes('"FEAR"') && JSON.stringify(r.s.objections).includes('"count":1'), JSON.stringify(r.s.objections));
  }

  // ── S11 #11 邊款最適合 → CONSULTATION ────────────────────────────────
  console.log("\n[S11] #11「邊款最適合我」→ CONSULTATION/ASK_FOR_CONSULTATION");
  {
    const { convId } = await inbound("e2ec3-s11", "箍牙邊款最適合我？");
    const r = await waitTurn(convId, 1, 11);
    check("stage=CONSULTATION + lastAction=ASK_FOR_CONSULTATION", r.s.stage === "CONSULTATION" && r.s.lastAction === "ASK_FOR_CONSULTATION", JSON.stringify({ stage: r.s.stage, la: r.s.lastAction }));
  }

  // ── S12 #12 療程時間 → EDUCATE_DETAIL ────────────────────────────────
  console.log("\n[S12] #12「療程要幾耐」→ EDUCATE_DETAIL（stage 不變）");
  {
    const { convId } = await inbound("e2ec3-s12", "箍牙療程要幾耐？");
    const r = await waitTurn(convId, 1, 12);
    check("lastAction=EDUCATE_DETAIL + stage DISCOVER 不變", r.s.lastAction === "EDUCATE_DETAIL" && r.s.stage === "DISCOVER", JSON.stringify({ la: r.s.lastAction, stage: r.s.stage }));
  }

  // ── S13 #13 臨床三問（脫牙）→ CONSULTATION ───────────────────────────
  console.log("\n[S13] #13 臨床（要脫牙先箍到嗎）→ CONSULTATION");
  {
    const { convId } = await inbound("e2ec3-s13", "箍牙要脫牙先箍到嗎？");
    const r = await waitTurn(convId, 1, 13);
    check("stage=CONSULTATION + lastAction=ASK_FOR_CONSULTATION", r.s.stage === "CONSULTATION" && r.s.lastAction === "ASK_FOR_CONSULTATION", JSON.stringify({ stage: r.s.stage, la: r.s.lastAction }));
  }

  // ── S14 #14 指名產品問價（usable → ANSWER_PRICE / 未批准 → 唔入） ─────
  console.log("\n[S14] #14 DISCOVER 指名產品問價（iron rule：只匹 usable）");
  {
    const t0 = await inbound("e2ec3-s14a", "e2ec3隱適美箍牙幾錢？");
    const r = await waitTurn(t0.convId, 1, 14);
    check("usable 產品 + 問價 → ANSWER_PRICE（stage DISCOVER 不變）", r.s.lastAction === "ANSWER_PRICE" && r.s.stage === "DISCOVER", JSON.stringify({ la: r.s.lastAction }));
    check("intent 0.1（首次問價 Δ）+ priceAskCount=1", approx(r.s.purchaseIntent, 0.1) && (r.s.slots as { meta?: { priceAskCount?: number } })?.meta?.priceAskCount === 1, JSON.stringify({ intent: r.s.purchaseIntent, slots: r.s.slots }).slice(0, 150));
    const t1 = await inbound("e2ec3-s14b", "e2ec3未批准箍牙幾錢？");
    const r2 = await waitTurn(t1.convId, 1, 16);
    check("未批准產品（iron rule）唔入匹配 → 落返 #16 ASK_DISCOVERY", r2.s.lastAction === "ASK_DISCOVERY", JSON.stringify({ la: r2.s.lastAction }));
  }

  // ── S15 #15 比較 → EDUCATE/EDUCATE_COMPARE ───────────────────────────
  console.log("\n[S15] #15「差咩」（DISCOVER 比較）→ EDUCATE/EDUCATE_COMPARE");
  {
    const { convId } = await inbound("e2ec3-s15", "e2ec3隱適美同隱適美2箍牙差咩？");
    const r = await waitTurn(convId, 1, 15);
    check("stage=EDUCATE + lastAction=EDUCATE_COMPARE", r.s.stage === "EDUCATE" && r.s.lastAction === "EDUCATE_COMPARE", JSON.stringify({ stage: r.s.stage, la: r.s.lastAction }));
  }

  // ── S16 #16 DISCOVER slot 流（4 問 + 問完 stay） ─────────────────────
  console.log("\n[S16] #16 DISCOVER slot 流（每輪一條 / askedSlots 唔重問 / 問完 stay）");
  {
    const c0 = await inbound("e2ec3-s16", "我想箍牙");
    const expect = [
      { text: "我想箍牙", asked: "appearancePriority" },
      { text: "箍牙想知多啲", asked: "speedPriority" },
      { text: "箍牙幾時開始？", asked: "timeline" },
      { text: "箍牙你有冇幫人做过？", asked: "previousOrtho" },
    ];
    let conv = c0.convId;
    for (let i = 0; i < 4; i++) {
      const t = i === 0 ? c0 : await inbound("e2ec3-s16", expect[i].text);
      conv = t.convId;
      const r = await waitTurn(conv, i + 1, 16);
      const askedSlots = (r.s.askedSlots as string[]) ?? [];
      check(`T${i + 1} askedSlot=${expect[i].asked} + 唔重問（askedSlots=${askedSlots.length}）`, r.s.lastAction === "ASK_DISCOVERY" && askedSlots[askedSlots.length - 1] === expect[i].asked && new Set(askedSlots).size === askedSlots.length, JSON.stringify({ la: r.s.lastAction, askedSlots }));
    }
    const t5 = await inbound("e2ec3-s16", "箍牙仲有咩想問");
    void t5;
    // 4 條問完 → #16 唔再觸發（slots 未填 = C4 抽取範圍）→ row -1 stay（turnCount 照 +1）
    const r5 = await poll(`T5 stay turn5 conv=${conv.slice(0, 8)}`, async () => {
      const s = await activeSession(conv);
      return s && s.turnCount >= 5 ? s : null;
    });
    const a5 = await prisma.auditLog.findFirst({ where: { action: "CONSULT_ENGINE_TURN", entityId: r5?.id, meta: { path: ["row"], equals: -1 } }, orderBy: { createdAt: "desc" } });
    check("T5 問完 4 條 → row -1 stay（turnCount=5，lastAction 保持）", r5?.turnCount === 5 && !!a5, JSON.stringify({ turn: r5?.turnCount, la: r5?.lastAction, row: (a5?.meta as { row?: number })?.row }));
  }

  // ── S17 #17 minimum slots 齊 → PRESENT_OPTIONS ───────────────────────
  console.log("\n[S17] #17 DISCOVER minimum slots 齊（seed appearance HIGH）→ PRESENT_OPTIONS");
  {
    const t0 = await inbound("e2ec3-s17", "我想箍牙");
    await waitTurn(t0.convId, 1, 16);
    const s0 = await activeSession(t0.convId);
    const cur = (s0?.slots ?? {}) as Record<string, unknown>;
    await seedActive(t0.convId, { slots: { ...cur, appearancePriority: "HIGH" } });
    const t1 = await inbound("e2ec3-s17", "箍牙想知多啲");
    void t1;
    const r = await waitTurn(t0.convId, 2, 17);
    check("stage=PRESENT_OPTIONS + lastAction=PRESENT_OPTIONS", r.s.stage === "PRESENT_OPTIONS" && r.s.lastAction === "PRESENT_OPTIONS", JSON.stringify({ stage: r.s.stage, la: r.s.lastAction }));
    check("candidateCategory=CLEAR_ALIGNER（ORTHO-001 appearance HIGH）", r.s.candidateCategory === "CLEAR_ALIGNER", String(r.s.candidateCategory));
    const a = await prisma.auditLog.findFirst({ where: { action: "CONSULT_ENGINE_TURN", entityId: r.s.id, meta: { path: ["row"], equals: 17 } } });
    check("audit row 17 + ruleId ORTHO-001", !!a && (a.meta as { ruleId?: string })?.ruleId === "ORTHO-001", JSON.stringify(a?.meta).slice(0, 150));
  }

  // ── S18 #18 EDUCATE 比較完成 → PRESENT_OPTIONS ───────────────────────
  console.log("\n[S18] #18 EDUCATE 比較完成（seed lastAction=EDUCATE_COMPARE）→ PRESENT_OPTIONS");
  {
    const t0 = await inbound("e2ec3-s18", "我想箍牙");
    await waitTurn(t0.convId, 1, 16);
    await seedActive(t0.convId, { stage: "EDUCATE", lastAction: "EDUCATE_COMPARE" });
    const t1 = await inbound("e2ec3-s18", "e2ec3隱適美箍牙想知多啲");
    void t1;
    const r = await waitTurn(t0.convId, 2, 18);
    check("stage=PRESENT_OPTIONS（比較完成推去 PRESENT）", r.s.stage === "PRESENT_OPTIONS" && r.s.lastAction === "PRESENT_OPTIONS", JSON.stringify({ stage: r.s.stage, la: r.s.lastAction }));
  }

  // ── S19 #19 PRESENT clinical UNKNOWN → CONSULTATION ──────────────────
  console.log("\n[S19] #19 PRESENT_OPTIONS clinical UNKNOWN → CONSULTATION");
  {
    const t0 = await inbound("e2ec3-s19", "我想箍牙");
    await waitTurn(t0.convId, 1, 16);
    await seedActive(t0.convId, { stage: "PRESENT_OPTIONS" });
    const t1 = await inbound("e2ec3-s19", "e2ec3隱適美箍牙想知多啲");
    void t1;
    const r = await waitTurn(t0.convId, 2, 19);
    check("stage=CONSULTATION + lastAction=ASK_FOR_CONSULTATION（ clinical UNKNOWN → 邀請諮詢）", r.s.stage === "CONSULTATION" && r.s.lastAction === "ASK_FOR_CONSULTATION", JSON.stringify({ stage: r.s.stage, la: r.s.lastAction }));
  }

  // ── S20 #20 intent ≥0.6 → START_BOOKING ──────────────────────────────
  console.log("\n[S20] #20 PRESENT intent 0.45 + 問價 Δ0.15 = 0.6 ≥ 0.6 → START_BOOKING");
  {
    const t0 = await inbound("e2ec3-s20", "我想箍牙");
    await waitTurn(t0.convId, 1, 16);
    const s0 = await activeSession(t0.convId);
    const cur = (s0?.slots ?? {}) as Record<string, unknown>;
    await seedActive(t0.convId, {
      stage: "PRESENT_OPTIONS",
      purchaseIntent: 0.45,
      slots: { ...cur, appearancePriority: "HIGH", clinicalSuitability: "ASSESSED", meta: { priceAskCount: 1 } },
    });
    const t1 = await inbound("e2ec3-s20", "e2ec3隱適美箍牙幾錢？");
    void t1;
    const s = await waitTerminal(t0.convId, "COMPLETED");
    check("stage=BOOKING + terminal=COMPLETED + START_BOOKING", s?.stage === "BOOKING" && s?.terminal === "COMPLETED" && s?.lastAction === "START_BOOKING", JSON.stringify({ stage: s?.stage, la: s?.lastAction }));
    check("intent 0.6（0.45 + 0.15 第二次問價 — clamp/round3 口徑）", approx(s?.purchaseIntent, 0.6), `intent=${s?.purchaseIntent}`);
    const a = await prisma.auditLog.findFirst({ where: { action: "CONSULT_ENGINE_TURN", entityId: s?.id, meta: { path: ["row"], equals: 20 } } });
    check("audit row 20（高意向 intent≥0.6）", !!a, "no row-20 audit");
  }

  // ── S21 #21 CONSULTATION 接受 → START_BOOKING ────────────────────────
  console.log("\n[S21] #21 CONSULTATION 病人接受（安排）→ START_BOOKING");
  {
    const t0 = await inbound("e2ec3-s21", "我想箍牙");
    await waitTurn(t0.convId, 1, 16);
    await seedActive(t0.convId, { stage: "CONSULTATION" });
    const t1 = await inbound("e2ec3-s21", "好啊，安排下箍牙");
    void t1;
    const s = await waitTerminal(t0.convId, "COMPLETED");
    check("stage=BOOKING + terminal=COMPLETED + START_BOOKING", s?.stage === "BOOKING" && s?.lastAction === "START_BOOKING", JSON.stringify({ stage: s?.stage, la: s?.lastAction }));
    const a = await prisma.auditLog.findFirst({ where: { action: "CONSULT_ENGINE_TURN", entityId: s?.id, meta: { path: ["row"], equals: 21 } } });
    check("audit row 21（接受諮詢）", !!a, "no row-21 audit");
  }

  // ── S22 #22 CONSULTATION 推搪 → COMPLETED + 零草稿 ───────────────────
  console.log("\n[S22] #22 CONSULTATION 推搪（算啦改日）→ COMPLETED/END_SESSION + follow-up");
  {
    const t0 = await inbound("e2ec3-s22", "我想箍牙");
    await waitTurn(t0.convId, 1, 16);
    await seedActive(t0.convId, { stage: "CONSULTATION" });
    const t1 = await inbound("e2ec3-s22", "算啦，改日再講箍牙");
    const s = await waitTerminal(t0.convId, "COMPLETED");
    check("terminal=COMPLETED + lastAction=END_SESSION", s?.terminal === "COMPLETED" && s?.lastAction === "END_SESSION", JSON.stringify({ la: s?.lastAction }));
    const fu = await prisma.auditLog.findFirst({ where: { action: "CONSULT_FOLLOWUP_SCHEDULED", entityId: s?.id, meta: { path: ["reason"], equals: "decline" } } });
    check("follow-up audit placeholder（reason=decline）", !!fu, "no follow-up audit");
    await sleep(4000);
    const d = await prisma.aiDraft.findFirst({ where: { conversationId: t0.convId, inReplyToMessageId: t1.msgId } });
    check("推搪 turn 零草稿（suppressDraft）", d === null, d ? `draft=${d.status}` : "no draft");
  }

  // ── S23 #23 48h cron → EXPIRED + Δ−0.15 + 新 trigger 開新 session ─────
  console.log("\n[S23] #23 48h 無 inbound（49h backdate + runConsultExpireSweep）→ EXPIRED + 重開新 session");
  {
    const t0 = await inbound("e2ec3-s23", "我想箍牙");
    await waitTurn(t0.convId, 1, 16);
    const s1 = await activeSession(t0.convId);
    check("S23 前置：session active + intent 0", !!s1 && s1.terminal === null, `terminal=${s1?.terminal}`);
    await prisma.consultSession.update({ where: { id: s1!.id }, data: { purchaseIntent: 0.5 } });
    await backdateSessionHours(s1!.id, 49);
    const sweepRes = await runConsultExpireSweep();
    check("sweep expired=1（49h > 48h 預設）", sweepRes.expired === 1 && sweepRes.failed === 0, JSON.stringify(sweepRes));
    const after = await prisma.consultSession.findUnique({ where: { id: s1!.id } });
    check("terminal=EXPIRED", after?.terminal === "EXPIRED", `terminal=${after?.terminal}`);
    check("intent 0.5 → 0.35（Δ−0.15）", approx(after?.purchaseIntent, 0.35), `intent=${after?.purchaseIntent}`);
    const aExp = await prisma.auditLog.findFirst({ where: { action: "CONSULT_SESSION_EXPIRED", entityId: s1!.id } });
    check("audit CONSULT_SESSION_EXPIRED（row 23 + intentBefore/After）", !!aExp && (aExp.meta as { row?: number; intentBefore?: number; intentAfter?: number })?.row === 23, JSON.stringify(aExp?.meta).slice(0, 200));
    const aFu = await prisma.auditLog.findFirst({ where: { action: "CONSULT_FOLLOWUP_SCHEDULED", entityId: s1!.id, meta: { path: ["reason"], equals: "idle-48h" } } });
    check("follow-up audit placeholder（reason=idle-48h）", !!aFu, "no follow-up audit");
    // 冪等：再跑 sweep → 0（terminal≠null 唔再碰）
    const sweep2 = await runConsultExpireSweep();
    check("sweep 冪等（再跑 expired=0）", sweep2.expired === 0, JSON.stringify(sweep2));
    // 新 trigger → 開新 session（舊 terminal 唔阻 — C2 守衛口徑）
    const t1 = await inbound("e2ec3-s23", "箍牙幾錢？");
    const rNew = await waitTurn(t1.convId, 1, 16);
    const s2 = rNew.s;
    check("新 trigger 開新 session（active）", !!s2 && s2.id !== s1!.id && s2.terminal === null, `s2=${s2?.id?.slice(0, 8)}`);
    check("舊 session 保持 EXPIRED", (await prisma.consultSession.findUnique({ where: { id: s1!.id } }))?.terminal === "EXPIRED");
    check("新 session turn1 + intent 0.1（首次問價）", s2?.turnCount === 1 && approx(s2?.purchaseIntent, 0.1), JSON.stringify({ turn: s2?.turnCount, intent: s2?.purchaseIntent }));
  }

  // ── S24 #24 CTA turn 6 → 重復唔觸發 → turn 8 #7 ──────────────────────
  console.log("\n[S24] #24 CTA turn 6（+ 重復唔觸發 + turnCount 8 → #7）");
  {
    const t0 = await inbound("e2ec3-s24", "我想箍牙");
    await waitTurn(t0.convId, 1, 16);
    const s0 = await activeSession(t0.convId);
    const cur = (s0?.slots ?? {}) as Record<string, unknown>;
    await seedActive(t0.convId, {
      stage: "PRESENT_OPTIONS",
      turnCount: 6,
      slots: { ...cur, appearancePriority: "HIGH", clinicalSuitability: "ASSESSED" },
    });
    const t1 = await inbound("e2ec3-s24", "e2ec3隱適美箍牙想知多啲");
    void t1;
    const r = await waitTurn(t0.convId, 7, 24);
    check("T1 turnCount=6 → CTA（row 24 + ctaGiven=true）", r.s.lastAction === "ASK_FOR_CONSULTATION" && r.s.ctaGiven === true, JSON.stringify({ la: r.s.lastAction, cta: r.s.ctaGiven }));
    const t2 = await inbound("e2ec3-s24", "e2ec3隱適美箍牙想知多啲");
    void t2;
    const r2 = await poll(`T2 stay turn8`, async () => {
      const s = await activeSession(t0.convId);
      return s && s.turnCount >= 8 ? s : null;
    });
    const a2 = await prisma.auditLog.findFirst({ where: { action: "CONSULT_ENGINE_TURN", entityId: r2?.id, meta: { path: ["row"], equals: -1 } }, orderBy: { createdAt: "desc" } });
    check("T2 ctaGiven 已 true → 唔重 CTA（row -1 stay, turn8）", r2?.turnCount === 8 && !!a2, JSON.stringify({ turn: r2?.turnCount, row: (a2?.meta as { row?: number })?.row }));
    const t3 = await inbound("e2ec3-s24", "e2ec3隱適美箍牙想知多啲");
    void t3;
    const s3 = await waitTerminal(t0.convId, "HANDOFF");
    check("T3 turnCount=8 → #7 maxTurns HANDOFF", s3?.terminal === "HANDOFF" && s3?.lastAction === "HANDOFF_HUMAN", JSON.stringify({ la: s3?.lastAction }));
  }

  // ── S25 橋接複製（staff 先講 → 新 session copy） ─────────────────────
  console.log("\n[S25] 橋接複製（staff 先講 → 新 session copy humanTookOver/lastOutboundText）");
  {
    const t0 = await inbound("e2ec3-s25", "你好");
    const s0 = await activeSession(t0.convId);
    check("非 consult 訊息 → 無 session", s0 === null, `session=${s0?.id?.slice(0, 8)}`);
    const st = await staffSend(staffCookie, t0.convId, "e2ec3 店員：你好，有咩可以幫到你？");
    check("staff typed send → 2xx", st === 200 || st === 202, `status=${st}`);
    const t1 = await inbound("e2ec3-s25", "我想箍牙");
    void t1;
    const r = await waitUnprocessed(t0.convId, 6);
    check("新 session 建立 + #6 NO_DRAFT（humanTookOver 已 copy）", r.s.humanTookOver === true && r.s.lastAction === null, JSON.stringify({ hto: r.s.humanTookOver, la: r.s.lastAction }));
    check("橋接 copy lastOutboundText（= staff 回覆）", r.s.lastOutboundText === "e2ec3 店員：你好，有咩可以幫到你？", String(r.s.lastOutboundText).slice(0, 60));
    check("turnCount 保持 0（processed:false 唔計 turn）", r.s.turnCount === 0, `turnCount=${r.s.turnCount}`);
    const aCreate = await prisma.auditLog.findFirst({ where: { action: "CONSULT_SESSION_CREATE", entityId: r.s.id } });
    check("audit CONSULT_SESSION_CREATE + bridgedFromConversation.humanTookOver=true", !!aCreate && ((aCreate.meta as { bridgedFromConversation?: { humanTookOver?: boolean } })?.bridgedFromConversation?.humanTookOver === true), JSON.stringify(aCreate?.meta).slice(0, 200));
  }

  // ── S26 T245 ≥7 日 → 舊 EXPIRED 唔復活 + 新 trigger 開新 session ──────
  console.log("\n[S26] T245 ≥7 日（8 日 EXPIRED）→ 唔復活 + 新 trigger 開新 session");
  {
    const t0 = await inbound("e2ec3-s26", "我想箍牙");
    await waitTurn(t0.convId, 1, 16);
    const s1 = await activeSession(t0.convId);
    await prisma.consultSession.update({ where: { id: s1!.id }, data: { terminal: "EXPIRED" } });
    await backdateSessionHours(s1!.id, 8 * 24);
    await prisma.$executeRaw`UPDATE "Conversation" SET "lastMessageAt" = now() - 8 * interval '1 day', "lastInboundAt" = now() - 8 * interval '1 day', "lastOutboundAt" = now() - 7 * interval '1 day' WHERE id = ${t0.convId}`;
    await prisma.conversation.update({ where: { id: t0.convId }, data: { status: "RESOLVED", resolvedBy: "AUTO", resolvedAt: new Date() } });
    const t1 = await inbound("e2ec3-s26", "箍牙幾錢？");
    await waitTurn(t1.convId, 1, 16);
    const conv = await poll(`conv reopen OPEN`, async () => {
      const c = await prisma.conversation.findUnique({ where: { id: t1.convId } });
      return c?.status === "OPEN" ? c : null;
    });
    check("對話照翻開（OPEN — T245 reopen）", conv.status === "OPEN", `status=${conv.status}`);
    const all = await prisma.consultSession.findMany({ where: { conversationId: t1.convId } });
    check("2 個 session row（舊 EXPIRED + 新 active）", all.length === 2, `count=${all.length}`);
    const s2 = all.find((x) => x.terminal === null);
    check("新 session active + 舊保持 EXPIRED（唔復活 ≥7 日）", !!s2 && s2.id !== s1!.id && all.find((x) => x.id === s1!.id)?.terminal === "EXPIRED", JSON.stringify(all.map((x) => ({ id: x.id.slice(0, 8), t: x.terminal }))));
    check("新 session turn1（#16 ASK_DISCOVERY）", s2?.turnCount === 1 && s2?.lastAction === "ASK_DISCOVERY", JSON.stringify({ turn: s2?.turnCount, la: s2?.lastAction }));
    const aCreate = await prisma.auditLog.findFirst({ where: { action: "CONSULT_SESSION_CREATE", entityId: s2?.id } });
    check("audit CONSULT_SESSION_CREATE（新 session）", !!aCreate, "no create audit");
  }

  // ── S27 LLM trigger fallback（bait NOFLOOR → IMPLANT） ────────────────
  console.log("\n[S27] LLM trigger fallback（E2E-CONSULT-TRIG-NOFLOOR → IMPLANT_CONSULT）");
  {
    const { convId } = await inbound("e2ec3-s27", "E2E-CONSULT-TRIG-NOFLOOR，我有少少問題想問下");
    const r = await waitTurn(convId, 1, 16);
    check("workflow=IMPLANT_CONSULT（LLM 值 — FLOOR 唔中）", r.s.workflow === "IMPLANT_CONSULT", String(r.s.workflow));
    check("implant discovery 第一問 = missingCount", (r.s.askedSlots as string[])?.[0] === "missingCount", JSON.stringify(r.s.askedSlots));
    check("conv.sessionTrigger=IMPLANT_CONSULT（C1 落庫）", (await prisma.conversation.findUnique({ where: { id: convId } }))?.sessionTrigger === "IMPLANT_CONSULT");
  }

  // ── 收尾 residue 斷言 + sweep ─────────────────────────────────────────
  console.log("\n[sweep] 冚家潔");
  await sweep("end");
  const residue = {
    products: await prisma.consultProduct.count({ where: { code: { startsWith: CODE_PREFIX } } }),
    contacts: await prisma.contact.count({ where: { waId: { startsWith: "e2ec3-" } } }),
  };
  const sessLeft = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM "ConsultSession" WHERE "conversationId" IN (SELECT c.id FROM "Conversation" c JOIN "Contact" ct ON ct.id = c."contactId" WHERE ct."waId" LIKE 'e2ec3-%')`
  );
  const painLeft = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM "PainTriageSession" WHERE "conversationId" IN (SELECT c.id FROM "Conversation" c JOIN "Contact" ct ON ct.id = c."contactId" WHERE ct."waId" LIKE 'e2ec3-%')`
  );
  check(
    "residue = 0（products/contacts/consult+pain sessions）",
    residue.products === 0 && residue.contacts === 0 && (sessLeft[0]?.n ?? -1) === 0 && (painLeft[0]?.n ?? -1) === 0,
    JSON.stringify({ ...residue, sessions: sessLeft[0]?.n ?? null, pain: painLeft[0]?.n ?? null })
  );

  console.log(`\n══ C3 e2e: ${pass} pass / ${fail} fail ══`);
  if (fail > 0) process.exitCode = 1;
}

main()
  .catch(async (e) => {
    console.error("FATAL:", e instanceof Error ? e.stack : e);
    // fatal 時仍要洗殘留 — 必須 await（同 C2 口徑）
    if (sweepRef) await sweepRef("fatal").catch((se) => console.error("[sweep:fatal] FAILED:", se instanceof Error ? se.message : se));
    process.exitCode = 1;
  })
  .finally(async () => {
    // ★ 明確 exit（redis/undici keep-alive 會令 node 層 hang — 前幾單教訓）
    await prisma.$disconnect().catch(() => {});
    process.exit(process.exitCode ?? 0);
  });

/**
 * ★ consult v2.1 C1（cwi-consult-20260910b）：e2e — §0.5-B + §2 前置修復（MD 斷言口徑，唔准放弱）。
 *
 * 前置：dev stack live（server 3100 / DB 15432 / worker AI_MOCK=1）、migration 20260910123500 已 apply。
 * 用法：pnpm tsx scripts/e2e-consult-c1.ts
 *
 * 階段（TKW = AUTO 測試場，跑完還原原 aiMode）：
 * - P0  非 consult 對照（零改動）：THANKS QUESTION 草稿 + AUTO 自動覆（新 sentVia=AI_AUTO 標記）；
 *       BOOKING_REQUEST 自動覆（既有行為不變）
 * - P1  M-2 sessionTrigger：FLOOR 命中（矯齒→ORTHODONTIC 唔靠 LLM）/ LLM fallback（bait 無 FLOOR→IMPLANT）/
 *       floor 優先（FLOOR 矯齒 + LLM IMPLANT→ORTHODONTIC）/ 大小寫不敏感（Implant→IMPLANT）
 * - P2A M-1 死鎖解除（draft 級）：AUTO 自動覆 → staff 採用（source=adopted → AI_ADOPTED）→ 病人回覆 → 有新 AI 草稿
 * - P2B M-1 死鎖解除（auto 級）：採用後還公海 → 病人回覆 → 無 human-recent（last OUT = AI_ADOPTED）→ AI_AUTO 自動覆
 * - P3  M-1 takeover：staff typing（source=typed → HUMAN_TYPED + humanTookOver=true）→ 病人 consult 回覆 → 零草稿
 * - P4  M-3 窗口過期：old-inbound（25h）+ consult trigger → 無 free-form 草稿 + consultGateAction=WINDOW_EXPIRED_HANDOFF
 *       + 對話保留（唔 terminal）；對照：old-inbound 非 consult → COPY_ONLY 草稿照出（零改動）
 * - P5  §0.5-B price-guard：高價值用 shortDisclaimer（buildPriceDraft + guard ②）/ 低價值唔 append /
 *       zod refine（高價值無 shortDisclaimer → 400；shortDisclaimer >12 字 → 400）
 * - 截圖：/tmp/kairo-consult-c1-*.png（playwright + cookie session）
 * - 收尾 fixture sweep：waId 精確 IN 冚家潔 + 還原 aiMode + 刪 KnowledgeDoc（residue 0 斷言）
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";

const nodeRequire = createRequire(import.meta.url);

try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch { /* ok */ }

const BASE = "http://127.0.0.1:3100";
const REPO = new URL("..", import.meta.url).pathname;
const prisma = new PrismaClient();

let pass = 0;
let fail = 0;
let sweepRef: ((label: string) => Promise<void>) | null = null; // FATAL 時仍要洗殘留 + 還原 aiMode
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function poll<T>(what: string, fn: () => Promise<T | null>, timeoutMs = 25_000, intervalMs = 700): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    let v: T | null = null;
    try {
      v = await fn(); // 瞬時 Prisma 錯唔好殺成個 poll — 記 miss 再試（防單次 hiccup 斷言假紅）
    } catch (e) {
      v = null;
      console.error(`    [poll ${what}] transient: ${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}`);
    }
    if (v !== null) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`poll timeout: ${what}`);
    await sleep(intervalMs);
  }
}

// ── API helper（cookie = wa_inbox_session） ─────────────────────────────
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

async function api(
  cookie: string,
  path: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> | null; retryable500: boolean }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: `wa_inbox_session=${cookie}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch { /* html error page */ }
  const retryable500 = res.status === 500 && (json?.error as string | undefined) === undefined && path.startsWith("/api/messages/send");
  return { status: res.status, json, retryable500 };
}

/** 病人 inbound（mock webhook 路徑）— 等 IN Message 落庫。 */
async function inbound(waId: string, text: string): Promise<{ msgId: string; convId: string }> {
  await new Promise<void>((resolve, reject) => {
    const c = spawn("pnpm", ["-s", "mock-inbound", "message", "--clinic", "TKW", "--from", waId, "--text", text], {
      cwd: REPO,
      stdio: "inherit",
    });
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`mock-inbound exit ${code}`))));
  });
  return poll(
    `IN message ${waId} ${text.slice(0, 12)}`,
    async () => {
      const msg = await prisma.message.findFirst({
        where: { direction: "IN", body: text },
        orderBy: { createdAt: "desc" },
      });
      if (!msg) return null;
      // 無 Prisma relation（純 FK）— 兩步核對 waId 防同 body 撞車
      const conv = await prisma.conversation.findUnique({ where: { id: msg.conversationId } });
      const contact = conv ? await prisma.contact.findFirst({ where: { id: conv.contactId } }) : null;
      return contact?.waId === waId && conv ? { msgId: msg.id, convId: conv.id } : null;
    }
  );
}

/** 等 AI job 完成（intent 落 DB = step 3 已寫；mock 路徑 deterministic）。 */
async function waitForJob(convId: string, intent: string): Promise<void> {
  await poll(`AI job done (intent=${intent}) conv=${convId}`, async () => {
    const c = await prisma.conversation.findUnique({ where: { id: convId }, select: { intent: true } });
    return c?.intent === intent ? true : null;
  });
}

async function draftOf(convId: string, msgId: string) {
  return prisma.aiDraft.findUnique({
    where: { conversationId_inReplyToMessageId: { conversationId: convId, inReplyToMessageId: msgId } },
  });
}

async function waitForDraft(convId: string, msgId: string, timeoutMs = 30_000) {
  return poll(`AiDraft for msg=${msgId}`, async () => (await draftOf(convId, msgId)) ?? null, timeoutMs);
}

/** 等 OUT 訊息數（>= sinceTs）。 */
async function outCountSince(convId: string, sinceTs: Date): Promise<number> {
  return prisma.message.count({
    where: { conversationId: convId, direction: "OUT", createdAt: { gte: sinceTs } },
  });
}

async function main(): Promise<void> {
  // ── 登入 ───────────────────────────────────────────────────────────────
  const credsText = readFileSync(new URL("../.dev/credentials.txt", import.meta.url).pathname, "utf8");
  const credOf = (label: string) => {
    const line = credsText.split("\n").find((l) => l.startsWith(label + ":")) ?? "";
    const [email, pw] = line.split(": ").slice(1).join(": ").split(" / ");
    if (!email || !pw) throw new Error(`credentials: ${label} missing`);
    return { email, pw };
  };
  const admin = credOf("ADMIN");
  const staffTkw = credOf("TKW STAFF");
  const adminCookie = await login(admin.email, admin.pw);
  const staffCookie = await login(staffTkw.email, staffTkw.pw);
  console.log("[setup] logged in ADMIN + TKW STAFF");

  const tkw = await prisma.clinic.findUnique({ where: { code: "TKW" } });
  if (!tkw) throw new Error("TKW clinic missing");
  const originalAiMode = tkw.aiMode;
  const setAiMode = async (mode: "DRAFT" | "AUTO") => {
    const r = await api(adminCookie, `/api/admin/clinics/${tkw.id}`, "PATCH", { aiMode: mode });
    if (r.status !== 200) throw new Error(`set aiMode ${mode} → ${r.status}`);
  };
  await setAiMode("AUTO");
  console.log(`[setup] TKW aiMode: ${originalAiMode} → AUTO（跑完還原）`);

  // 殘留清理 — 成功/失敗都跑（防半條 e2e 留殘；waId 精確 IN）
  const WIDS = [
    "85297001001", "85297001002", "85297001003", "85297001004", "85297001005", "85297001006",
    "85297001007", "85297001008", "85297001009", "85297001010", "85297001011", "85297001012", "85297001013", "85297001014",
  ];
  const createdDocs: string[] = [];
  let sweepRan = false;
  const sweep = async (label: string): Promise<void> => {
    if (sweepRan) return;
    sweepRan = true;
    try {
      const ctRows = await prisma.contact.findMany({ where: { waId: { in: WIDS } }, select: { id: true } });
      const convs = ctRows.length
        ? await prisma.conversation.findMany({ where: { contactId: { in: ctRows.map((c) => c.id) } }, select: { id: true } })
        : [];
      const convIds = convs.map((c) => c.id);
      const msgIds = convIds.length
        ? (await prisma.message.findMany({ where: { conversationId: { in: convIds } }, select: { id: true } })).map((m) => m.id)
        : [];
      if (convIds.length) {
        await prisma.$transaction([
          prisma.aiDraft.deleteMany({ where: { conversationId: { in: convIds } } }),
          prisma.bookingSession.deleteMany({ where: { conversationId: { in: convIds } } }),
          prisma.painTriageSession.deleteMany({ where: { conversationId: { in: convIds } } }),
          prisma.flowSession.deleteMany({ where: { conversationId: { in: convIds } } }),
          prisma.staffNotice.deleteMany({ where: { conversationId: { in: convIds } } }),
          prisma.message.deleteMany({ where: { conversationId: { in: convIds } } }),
          prisma.auditLog.deleteMany({ where: { entityId: { in: msgIds } } }),
          prisma.conversation.deleteMany({ where: { id: { in: convIds } } }),
        ]);
      }
      await prisma.contact.deleteMany({ where: { waId: { in: WIDS } } });
      for (const id of createdDocs) {
        try {
          await api(adminCookie, `/api/admin/knowledge/${id}`, "DELETE");
        } catch { /* fallback 到 DB 直刪 */ }
      }
      if (createdDocs.length) {
        await prisma.knowledgeDoc.deleteMany({ where: { id: { in: createdDocs } } }); // 兗底（API DELETE 失敗時）
      }
      await setAiMode(originalAiMode);
      console.log(`[sweep:${label}] 完成（aiMode 還原 ${originalAiMode}）`);
    } catch (e) {
      console.error(`[sweep:${label}] FAILED:`, e instanceof Error ? e.message : e);
    }
  };
  sweepRef = sweep;

  // ── P0 非 consult 對照（零改動 + sentVia=AI_AUTO 標記） ─────────────────
  console.log("\n[P0 非 consult 對照]");
  {
    const { msgId, convId } = await inbound("85297001001", "多謝！");
    const d = await waitForDraft(convId, msgId);
    check("P0.1 QUESTION 草稿照出（mock 模板）", d.intent === "QUESTION" && d.draftText.startsWith("多謝你嘅查詢"), d.draftText);
    check("P0.1 mode=NORMAL", d.mode === "NORMAL");
    const c = await prisma.conversation.findUnique({ where: { id: convId } });
    check("P0.1 sessionTrigger=null（非 consult）", c?.sessionTrigger === null, String(c?.sessionTrigger));
    check("P0.1 consultGateAction=null", c?.consultGateAction === null, String(c?.consultGateAction));
    const outs = await prisma.message.findMany({ where: { conversationId: convId, direction: "OUT" } });
    const autoOut = outs.find((o) => o.aiAutoSent === true);
    check("P0.1 AUTO 自動覆（既有行為不變）", autoOut !== undefined, JSON.stringify(outs.map((o) => o.status)));
    check("P0.1 自動覆 sentVia=AI_AUTO（新標記）", autoOut?.sentVia === "AI_AUTO", String(autoOut?.sentVia));
  }
  {
    const { msgId, convId } = await inbound("85297001002", "想預約下週");
    const d = await waitForDraft(convId, msgId);
    check("P0.2 BOOKING_REQUEST 草稿照出", d.intent === "BOOKING_REQUEST" && d.draftText.length > 0, d.draftText);
    await waitForJob(convId, "BOOKING_REQUEST");
    const outs = await prisma.message.findMany({ where: { conversationId: convId, direction: "OUT" } });
    check("P0.2 BOOKING 自動覆（既有 L2 行為）", outs.some((o) => o.aiAutoSent === true), JSON.stringify(outs.map((o) => o.status)));
    const c = await prisma.conversation.findUnique({ where: { id: convId }, select: { sessionTrigger: true } });
    check("P0.2 sessionTrigger=null（預約唔係 consult）", c?.sessionTrigger === null, String(c?.sessionTrigger));
  }

  // ── P1 M-2 sessionTrigger ──────────────────────────────────────────────
  console.log("\n[P1 M-2 sessionTrigger（FLOOR ?? LLM）]");
  const p1cases: Array<{ waId: string; text: string; expect: string; name: string }> = [
    { waId: "85297001003", text: "矯齒要幾耐？", expect: "ORTHODONTIC_CONSULT", name: "FLOOR 命中（矯齒）— 觸發唔靠 LLM" },
    { waId: "85297001004", text: "E2E-CONSULT-TRIG-NOFLOOR", expect: "IMPLANT_CONSULT", name: "FLOOR 無 + LLM 值 → 用 LLM" },
    { waId: "85297001005", text: "矯齒 E2E-CONSULT-TRIG-NOFLOOR", expect: "ORTHODONTIC_CONSULT", name: "floor 優先（FLOOR 矯齒 勝 LLM IMPLANT）" },
    { waId: "85297001006", text: "Implant 有冇得做？", expect: "IMPLANT_CONSULT", name: "大小寫不敏感（Implant）" },
  ];
  for (const cs of p1cases) {
    const { msgId, convId } = await inbound(cs.waId, cs.text);
    await waitForJob(convId, "QUESTION");
    const c = await prisma.conversation.findUnique({ where: { id: convId }, select: { sessionTrigger: true, consultGateAction: true } });
    check(`P1 ${cs.name}`, c?.sessionTrigger === cs.expect, `got=${String(c?.sessionTrigger)} want=${cs.expect}`);
    check(`P1 ${cs.name}（窗內 gateAction=null）`, c?.consultGateAction === null, String(c?.consultGateAction));
    void msgId;
  }

  // ── P2A M-1 死鎖解除（draft 級） ────────────────────────────────────────
  console.log("\n[P2A M-1 採用 → 病人回覆 → 有新 AI 草稿]");
  const p2aConv = await (async () => {
    const { msgId, convId } = await inbound("85297001007", "我想知多啲矯齒");
    await waitForDraft(convId, msgId);
    await waitForJob(convId, "QUESTION");
    const outs1 = await prisma.message.findMany({ where: { conversationId: convId, direction: "OUT" } });
    check("P2A msg1 AUTO 自動覆", outs1.some((o) => o.aiAutoSent === true));
    return convId;
  })();
  {
    const adoptedBody = "我哋有箍牙同隱形牙套幾種選擇，詳細要睇下你嘅牙齒先。";
    const r = await api(staffCookie, "/api/messages/send", "POST", { conversationId: p2aConv, body: adoptedBody, source: "adopted" });
    check("P2A 採用發送 200/202", r.status === 200 || r.status === 202, JSON.stringify(r.json));
    const m = await prisma.message.findFirst({ where: { conversationId: p2aConv, body: adoptedBody }, orderBy: { createdAt: "desc" } });
    check("P2A Message.sentVia=AI_ADOPTED", m?.sentVia === "AI_ADOPTED", String(m?.sentVia));
    const c = await prisma.conversation.findUnique({ where: { id: p2aConv } });
    check("P2A lastOutboundText=採用文字", c?.lastOutboundText === adoptedBody, String(c?.lastOutboundText));
    check("P2A 採用唔置 humanTookOver", c?.humanTookOver === false, String(c?.humanTookOver));

    const since = new Date();
    await sleep(300);
    const { msgId } = await inbound("85297001007", "矯齒大概要幾耐先好？");
    await waitForJob(p2aConv, "QUESTION");
    const d = await poll(
      "P2A 新 AiDraft（死鎖解除）",
      async () => (await draftOf(p2aConv, msgId)) ?? null,
      30_000
    ).catch(() => null);
    check("P2A 病人回覆後有新 AI 草稿（死鎖解除）", d !== null, "無 draft row");
    check("P2A 新草稿 PROPOSED（assigned 閘 — 既有行為）", d?.status === "PROPOSED", String(d?.status));
    const newOuts = await outCountSince(p2aConv, since);
    check("P2A 無新 OUT（assigned 閘擋 auto — 與 M-1 無關嘅既有行為）", newOuts === 0, String(newOuts));
  }

  // ── P2B M-1 死鎖解除（auto 級：cooldown 閘只計 HUMAN_TYPED） ─────────────
  console.log("\n[P2B M-1 採用後還公海 → 病人回覆 → AI 自動覆（無 human-recent）]");
  const p2bConv = await (async () => {
    const { msgId, convId } = await inbound("85297001008", "我想知多啲矯齒");
    await waitForDraft(convId, msgId);
    await waitForJob(convId, "QUESTION");
    return convId;
  })();
  {
    const adoptedBody = "矯齒大概分幾種方案，等我同你解釋下。";
    const r = await api(staffCookie, "/api/messages/send", "POST", { conversationId: p2bConv, body: adoptedBody, source: "adopted" });
    check("P2B 採用發送 200/202", r.status === 200 || r.status === 202, JSON.stringify(r.json));
    const m = await prisma.message.findFirst({ where: { conversationId: p2bConv, body: adoptedBody }, orderBy: { createdAt: "desc" } });
    check("P2B Message.sentVia=AI_ADOPTED", m?.sentVia === "AI_ADOPTED", String(m?.sentVia));
    // 還公海（模擬 re-claim — 令 auto 路徑唔被 assigned 閘擋，隔離測試 cooldown 閘）
    await prisma.conversation.update({ where: { id: p2bConv }, data: { assigneeId: null } });
    const since = new Date();
    await sleep(300);
    const { msgId } = await inbound("85297001008", "矯齒大概要幾耐先好？");
    await waitForJob(p2bConv, "QUESTION");
    const d = await poll(
      "P2B 新 AiDraft",
      async () => (await draftOf(p2bConv, msgId)) ?? null,
      30_000
    ).catch(() => null);
    const out = await poll(
      "P2B AUTO OUT（cooldown 唔阻 — AI_ADOPTED 唔算真人插嘴）",
      async () =>
        (await prisma.message.findFirst({
          where: { conversationId: p2bConv, direction: "OUT", createdAt: { gte: since }, aiAutoSent: true },
        })) ?? null,
      30_000
    ).catch(() => null);
    check("P2B 新草稿 SENT_AUTO（auto 級死鎖解除）", d?.status === "SENT_AUTO", String(d?.status));
    check("P2B 病人回覆 → AI 自動覆（MD 斷言：採用唔觸發 cooldown）", out !== null && out.sentVia === "AI_AUTO", `out=${out ? out.sentVia : "none"}`);
    const c = await prisma.conversation.findUnique({ where: { id: p2bConv }, select: { lastOutboundText: true } });
    check("P2B lastOutboundText=AI 實際發出文字", c?.lastOutboundText === (out?.body ?? null), String(c?.lastOutboundText));
  }

  // ── P3 M-1 takeover（typing → 停出草稿） ───────────────────────────────
  console.log("\n[P3 M-1 typing 接手 → humanTookOver → 唔出草稿]");
  const p3Conv = await (async () => {
    const { msgId, convId } = await inbound("85297001009", "我想知多啲植牙");
    await waitForDraft(convId, msgId);
    await waitForJob(convId, "QUESTION");
    const outs = await prisma.message.findMany({ where: { conversationId: convId, direction: "OUT" } });
    check("P3 msg1 AUTO 自動覆（基線）", outs.some((o) => o.aiAutoSent === true));
    return convId;
  })();
  {
    const typedBody = "我而家喺度，有咩問題直接問我就得。";
    const r = await api(staffCookie, "/api/messages/send", "POST", { conversationId: p3Conv, body: typedBody, source: "typed" });
    check("P3 typing 發送 200/202", r.status === 200 || r.status === 202, JSON.stringify(r.json));
    const m = await prisma.message.findFirst({ where: { conversationId: p3Conv, body: typedBody }, orderBy: { createdAt: "desc" } });
    check("P3 Message.sentVia=HUMAN_TYPED", m?.sentVia === "HUMAN_TYPED", String(m?.sentVia));
    const c0 = await prisma.conversation.findUnique({ where: { id: p3Conv } });
    check("P3 humanTookOver=true", c0?.humanTookOver === true, String(c0?.humanTookOver));
    check("P3 lastOutboundText=typing 文字", c0?.lastOutboundText === typedBody, String(c0?.lastOutboundText));

    const since = new Date();
    await sleep(300);
    const { msgId } = await inbound("85297001009", "植牙幾時先做完？");
    await waitForJob(p3Conv, "QUESTION"); // job 行完（intent 已寫）先斷言「無草稿」
    const d = await draftOf(p3Conv, msgId);
    check("P3 humanTookOver 後唔出草稿（consult 路徑）", d === null, d?.status);
    const newOuts = await outCountSince(p3Conv, since);
    check("P3 無新 OUT（human-recent + takeover 雙阻）", newOuts === 0, String(newOuts));
    const c1 = await prisma.conversation.findUnique({ where: { id: p3Conv }, select: { sessionTrigger: true, consultGateAction: true } });
    check("P3 sessionTrigger=IMPLANT_CONSULT（本輪照記錄）", c1?.sessionTrigger === "IMPLANT_CONSULT", String(c1?.sessionTrigger));
    check("P3 consultGateAction=null（窗內）", c1?.consultGateAction === null, String(c1?.consultGateAction));
  }

  // ── P4 M-3 窗口過期 ─────────────────────────────────────────────────────
  console.log("\n[P4 M-3 窗口過期 → WINDOW_EXPIRED_HANDOFF]");
  const runOldInbound = async (waId: string, text: string): Promise<string> => {
    const out = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const c = spawn("pnpm", ["-s", "e2e:ai-job", "old-inbound", "--clinic", "TKW", "--from", waId, "--text", text], {
        cwd: REPO,
      });
      c.stdout.on("data", (d) => (buf += String(d)));
      c.stderr.on("data", (d) => (buf += String(d)));
      c.on("close", (code) => (code === 0 ? resolve(buf) : reject(new Error(`e2e:ai-job exit ${code}: ${buf.slice(0, 200)}`))));
    });
    const convMatch = out.match(/CONV=(\S+)/);
    if (!convMatch) throw new Error(`old-inbound: no CONV in ${out.slice(0, 200)}`);
    return convMatch[1];
  };
  const p41Conv = await runOldInbound("85297001010", "矯齒想知多啲，仲未決定");
  await waitForJob(p41Conv, "QUESTION");
  {
    const c = await prisma.conversation.findUnique({ where: { id: p41Conv } });
    const msg = await prisma.message.findFirst({ where: { conversationId: p41Conv, direction: "IN" } });
    const d = msg ? await draftOf(p41Conv, msg.id) : null;
    const outs = await prisma.message.count({ where: { conversationId: p41Conv, direction: "OUT" } });
    // MD §2.3：唔生成 free-form 草稿 —「既有三出路」嘅 template 出路（R-7 首覆規則 template 草稿，
    // model=routing-r7）係允许（發送決策交返既有 4.5 閘；過窗時 mode=COPY_ONLY）。
    const freeFormDraft = d && d.model !== "routing-r7" ? d : null;
    check("P4.1 過窗 + consult → 無 free-form AI 草稿", freeFormDraft === null, d ? `model=${d.model} status=${d.status}` : "no draft");
    check("P4.1 template 出路（R-7 首覆）若出 → COPY_ONLY", !d || d.mode === "COPY_ONLY", d ? `mode=${d.mode}` : "n/a");
    check("P4.1 consultGateAction=WINDOW_EXPIRED_HANDOFF", c?.consultGateAction === "WINDOW_EXPIRED_HANDOFF", String(c?.consultGateAction));
    check("P4.1 sessionTrigger=ORTHODONTIC_CONSULT", c?.sessionTrigger === "ORTHODONTIC_CONSULT", String(c?.sessionTrigger));
    check("P4.1 對話保留（唔 terminal）", c?.status === "OPEN" || c?.status === "PENDING", String(c?.status));
    check("P4.1 無 OUT 訊息", outs === 0, String(outs));
  }
  const p42Conv = await runOldInbound("85297001011", "想預約下週");
  await waitForJob(p42Conv, "BOOKING_REQUEST");
  {
    const msg = await prisma.message.findFirst({ where: { conversationId: p42Conv, direction: "IN" } });
    const d = msg ? await draftOf(p42Conv, msg.id) : null;
    const c = await prisma.conversation.findUnique({ where: { id: p42Conv }, select: { consultGateAction: true, sessionTrigger: true, status: true } });
    check("P4.2 對照：非 consult 過窗 → COPY_ONLY 草稿照出（零改動）", d?.mode === "COPY_ONLY" && d?.status === "PROPOSED", `mode=${d?.mode} status=${d?.status}`);
    check("P4.2 對照：consultGateAction=null", c?.consultGateAction === null, String(c?.consultGateAction));
    check("P4.2 對照：sessionTrigger=null", c?.sessionTrigger === null, String(c?.sessionTrigger));
  }

  // ── P5 §0.5-B price-guard ───────────────────────────────────────────────
  console.log("\n[P5 §0.5-B price-guard（高價值 shortDisclaimer）]");
  const hvDisclaimer = "以上費用只係參考，實際費用要視乎牙齒情況，評估後先確認。";
  const hvShort = "以到診評估為準";
  const lvDisclaimer = "費用為參考，以到診為準。";
  const createDoc = async (body: Record<string, unknown>) => {
    const r = await api(adminCookie, "/api/admin/knowledge", "POST", body);
    if (r.status !== 200) throw new Error(`create doc → ${r.status}: ${JSON.stringify(r.json)}`);
    const id = String((r.json as { id?: string }).id ?? "");
    createdDocs.push(id);
    return id;
  };
  await createDoc({
    clinicId: tkw.id,
    kind: "PRICE",
    title: "e2ehv 收費",
    keywords: ["e2ehv"],
    body: "病例複雜度",
    disclaimer: hvDisclaimer,
    shortDisclaimer: hvShort,
    priceMin: 20000,
    priceMax: 60000,
  });
  await createDoc({
    clinicId: tkw.id,
    kind: "PRICE",
    title: "e2elv 收費",
    keywords: ["e2elv"],
    body: "牙石多寡",
    disclaimer: lvDisclaimer,
    priceMin: 1000,
    priceMax: 1400,
  });
  {
    const { msgId, convId } = await inbound("85297001012", "e2ehv 幾錢？");
    const d = await waitForDraft(convId, msgId, 35_000);
    check("P5.1 高價值報價範圍", d.draftText.includes("20000–60000"), d.draftText);
    check("P5.1 高價值 → shortDisclaimer（≤12 字）", d.draftText.includes(hvShort), d.draftText);
    check("P5.1 高價值 → 唔用完整 disclaimer", !d.draftText.includes(hvDisclaimer), d.draftText);
  }
  {
    const { msgId, convId } = await inbound("85297001013", "e2elv 幾錢？");
    const d = await waitForDraft(convId, msgId, 35_000);
    check("P5.2 低價值報價範圍", d.draftText.includes("1000–1400"), d.draftText);
    check("P5.2 低價值 → 唔 append disclaimer（§0.5-B-1）", !d.draftText.includes(lvDisclaimer), d.draftText);
  }
  {
    const bad1 = await api(adminCookie, "/api/admin/knowledge", "POST", {
      clinicId: tkw.id,
      kind: "PRICE",
      title: "c1e2e-hv-noshort",
      keywords: ["c1e2e-hv-noshort"],
      body: "影響因素：測試。",
      disclaimer: "測試完整 disclaimer 長度足夠八個字。",
      priceMin: 20000,
      priceMax: 60000,
    });
    const issues1 = JSON.stringify(bad1.json);
    check("P5.3 zod：高價值無 shortDisclaimer → 400", bad1.status === 400 && issues1.includes("shortDisclaimer"), issues1.slice(0, 200));
    const bad2 = await api(adminCookie, "/api/admin/knowledge", "POST", {
      clinicId: tkw.id,
      kind: "PRICE",
      title: "c1e2e-hv-long",
      keywords: ["c1e2e-hv-long"],
      body: "影響因素：測試。",
      disclaimer: "測試完整 disclaimer 長度足夠八個字。",
      shortDisclaimer: "一二三四五六七八九十一二三", // 13 字 > 12
      priceMin: 20000,
      priceMax: 60000,
    });
    check("P5.3 zod：shortDisclaimer >12 字 → 400", bad2.status === 400, JSON.stringify(bad2.json).slice(0, 200));
  }
  // P5.4 guard ②：in-range 價漏 disclaimer → 必 append。自建高價值 doc（ratio 2.0）+ 唯一 keyword —
  // bait 的 hardcoded 價 $600–1200 要喺入庫 doc 範圍內先會 trigger ②（keyword 命中 e2egv2）。
  // 唔使動 seed（高價值 seed 還原 null 會撞自己嘅 zod refine — 設計如此）。
  await createDoc({
    clinicId: tkw.id,
    kind: "PRICE",
    title: "e2egv2 收費",
    keywords: ["e2egv2"],
    body: "牙石多寡",
    disclaimer: "以上為參考收費範圍，實際費用因應個別情況而定，以到診評估同前台報價為準。",
    shortDisclaimer: "以到診為準",
    priceMin: 600,
    priceMax: 1200,
  });
  {
    const { msgId, convId } = await inbound("85297001014", "e2egv2 E2E-PRICE-NODISC");
    const d = await waitForDraft(convId, msgId, 35_000);
    check("P5.4 guard ②：in-range 漏 disclaimer → append shortDisclaimer", d.draftText.includes("600–1200") && d.draftText.includes("以到診為準"), d.draftText);
    check("P5.4 guard ②：高價值唔用完整 disclaimer", !d.draftText.includes("以上為參考收費範圍"), d.draftText);
  }

  // ── 截圖（playwright + cookie） ─────────────────────────────────────────
  console.log("\n[截圖]");
  const shot = async (convId: string, name: string) => {
    const { chromium } = nodeRequire("/usr/lib/node_modules/openclaw/node_modules/playwright-core") as {
      chromium: { launch: (o: Record<string, unknown>) => Promise<{ newContext: (o: Record<string, unknown>) => Promise<{ addCookies: (c: unknown[]) => Promise<void>; newPage: () => Promise<{ goto: (u: string, o?: Record<string, unknown>) => Promise<void>; screenshot: (o: { path: string }) => Promise<void>; close: () => Promise<void> }>; close: () => Promise<void> }>; close: () => Promise<void> }> };
    };
    const cache = `${process.env.HOME}/.cache/ms-playwright`;
    const exes = readdirSync(cache)
      .filter((d) => d.startsWith("chromium-"))
      .map((d) => `${cache}/${d}/chrome-linux64/chrome`)
      .filter((p) => existsSync(p));
    if (exes.length === 0) throw new Error("chromium binary 搵唔到");
    const B = await chromium.launch({ headless: true, executablePath: exes[exes.length - 1] });
    const C = await B.newContext({ viewport: { width: 1440, height: 900 } });
    await C.addCookies([{ name: "wa_inbox_session", value: staffCookie, domain: "127.0.0.1", path: "/" }]);
    const page = await C.newPage();
    await page.goto(`${BASE}/inbox?conv=${convId}`, { waitUntil: "domcontentloaded" });
    await sleep(5000);
    await page.screenshot({ path: `/tmp/kairo-consult-c1-${name}.png` });
    await C.close();
    await B.close();
    console.log(`  ✓ 截圖 /tmp/kairo-consult-c1-${name}.png`);
  };
  await shot(p2aConv, "p2-adopt");
  await shot(p3Conv, "p3-takeover");
  await shot(p42Conv, "p4-copyonly");

  // ── 收尾：fixture sweep + 還原 ─────────────────────────────────────────
  console.log("\n[sweep]");
  await sweep("final");
  // residue 0 斷言
  const rContacts = await prisma.contact.count({ where: { waId: { in: WIDS } } });
  check("sweep residue=0（contacts）", rContacts === 0, String(rContacts));
  const rDocs = createdDocs.length
    ? await prisma.knowledgeDoc.count({ where: { id: { in: createdDocs } } })
    : 0;
  check("sweep residue=0（knowledge docs）", rDocs === 0, String(rDocs));
}

main()
  .then(async () => {
    console.log(`\ne2e-consult-c1: ${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail > 0 ? 1 : 0);
  })
  .catch(async (err) => {
    console.error("\nFATAL:", err instanceof Error ? (err.stack ?? err.message) : err);
    if (sweepRef) await sweepRef("fatal").catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });

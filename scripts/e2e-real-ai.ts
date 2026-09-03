/**
 * e2e-real-ai — 真 AI 實測（本地 sglang，OpenAI-compatible）。
 *
 * 前提（由 scripts/e2e-real-ai.sh 設定）：
 * - server + worker 已起，AI_MOCK=0（真 sglang）+ WA_MOCK=1（WhatsApp 照 mock）
 * - clinic 全部 DRAFT（純 AI 品質測試；AUTO 模式由 mock-e2e T19-T25 覆蓋）
 *
 * 3 類實測（真機，輸出唔係 100% 決定性 — 斷言用「合理範圍」，唔斷死字串）：
 *   1. 「牙痛到瞓唔知」→ 期望 URGENT_PAIN（FLOOR 紅旗詞 fast path — 0 draft / 唔自動發 — 鐵律）
 *   2. 「想約下週一睇牙」→ BOOKING_REQUEST + 真 draft 內容
 *   3. 「多謝」→ 其他 intent（非 BOOKING/URGENT）+ 合理 reply
 *
 * 每 case 最多 3 次嘗試（fresh patient wamid / 次）— 中間失敗 log 但重試；
 * 連 3 次失敗先計 fail。
 *
 * 斷言：
 * - intent 喺合理範圍內
 * - JSON schema 有效（pipeline parseAndValidate 已強制；呢度再驗 draft 存在性/長度）
 * - draft 唔含醫療診斷 / 報價（prompt 鐵律生效）— regex 抽查
 * - latency 記錄（AiDraft.latencyMs + AiCallStats.lastLatencyMs/lastTokens 實測數據）
 * - ai-status 顯示真 model 名 + 各舖 aiMode 統計
 *
 * 註：呢度 log draft 內容係本地 E2E console 輸出（測試報告用途），server/worker log 照舊
 *     metadata only（鐵律 1 由 mock-e2e T18/T26 獨立驗證）。
 */
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* .env 冇就靠 process env */
}

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const PORT = process.env.PORT ?? "3100";
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = process.env.WA_APP_SECRET ?? "";
const EXPECTED_MODEL = (process.env.VLLM_MODEL ?? "").trim();

let passCount = 0;
let failCount = 0;
function pass(msg: string): void {
  passCount++;
  console.log(`  ✅ PASS: ${msg}`);
}
function fail(msg: string): void {
  failCount++;
  console.log(`  ❌ FAIL: ${msg}`);
}

async function login(email: string, password: string): Promise<string | null> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) return null;
  const setCookie = res.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0] || null;
}

/** 建 webhook payload + HMAC 簽名 POST（同 mock-inbound 同一 format）。 */
async function postInbound(clinicCode: string, from: string, text: string, wamid: string): Promise<boolean> {
  const clinic = await prisma.clinic.findUnique({ where: { code: clinicCode } });
  if (!clinic) {
    console.error(`clinic ${clinicCode} not found`);
    return false;
  }
  const bizNumber = (clinic.waDisplayNumber ?? "").replace(/\D/g, "");
  const ts = Math.floor(Date.now() / 1000).toString();
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: clinic.waPhoneNumberId,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: bizNumber, phone_number_id: clinic.waPhoneNumberId },
              contacts: [{ profile: { name: "RealAI 實測病人" }, wa_id: from }],
              messages: [{ from, id: wamid, timestamp: ts, type: "text", text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  const signature = "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
  const res = await fetch(`${BASE}/api/wa/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hub-signature-256": signature },
    body: raw,
  });
  return res.status === 200;
}

async function waitUntil(fn: () => Promise<boolean>, maxSec: number, stepMs = 1000): Promise<boolean> {
  const deadline = Date.now() + maxSec * 1000;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return fn();
}

/** prompt 鐵律抽查：醫療診斷 / 報價 regex（唔准出現喺 draft） */
const FORBIDDEN_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "報價/金錢", re: /[$€£]|港幣|港元|港紙|\d+\s*(蚊|蚊紙)|收費(係|為|系)\s*\d/ },
  { name: "醫療診斷/用藥", re: /開藥|處方|服藥|服用|藥物|抗生素|止痛藥|診斷|確診|病因|病徵/ },
];
function forbiddenHits(text: string): string[] {
  const hits: string[] = [];
  for (const p of FORBIDDEN_PATTERNS) if (p.re.test(text)) hits.push(p.name);
  return hits;
}

interface CaseOutcome {
  intent: string | null;
  urgency: string | null;
  urgent: boolean;
  draftText: string | null;
  draftLatencyMs: number | null;
  draftModel: string | null;
  outCount: number;
  /** -1 = 未完成（AI job 未跑完） */
  done: boolean;
}

async function runCaseOnce(clinicCode: string, from: string, text: string, wamid: string): Promise<CaseOutcome> {
  const ok = await postInbound(clinicCode, from, text, wamid);
  if (!ok) return { intent: null, urgency: null, urgent: false, draftText: null, draftLatencyMs: null, draftModel: null, outCount: -1, done: false };

  // 攞 contactId（Conversation 無 Prisma relation，用 contactId 查）。
  // ★ 必須等 inbound worker 處理完 webhook（Contact/Conversation 係異步建）—
  //   即時查 contact 會 race（webhook 200 ≠ 已落 DB）。
  let contactId: string | null = null;
  const contactSeen = await waitUntil(async () => {
    const row = await prisma.contact.findFirst({ where: { waId: from }, select: { id: true } });
    if (row) contactId = row.id;
    return row !== null;
  }, 20);
  const contact = contactSeen
    ? await prisma.contact.findFirst({ where: { waId: from }, select: { id: true } })
    : null;
  if (!contact || !contactId) {
    return { intent: null, urgency: null, urgent: false, draftText: null, draftLatencyMs: null, draftModel: null, outCount: -1, done: false };
  }

  // 等 AI 分類完成（intent 落 Conversation；真 27B 一單 3-15s，俾 120s 緩衝）
  const intentSet = await waitUntil(async () => {
    const row = await prisma.conversation.findFirst({
      where: { contactId: contact.id },
      select: { intent: true },
    });
    return row !== null && row.intent !== null;
  }, 120);
  const conv = await prisma.conversation.findFirst({
    where: { contactId: contact.id },
    orderBy: { lastMessageAt: "desc" },
    take: 1,
  });
  if (!intentSet || !conv) {
    return { intent: null, urgency: null, urgent: false, draftText: null, draftLatencyMs: null, draftModel: null, outCount: -1, done: false };
  }
  // 等 draft 落定（有 / 無 — URGENT_PAIN 應該無）：intent 落咗之後 5s 內 draft 就定案
  await new Promise((r) => setTimeout(r, 5000));
  const msg = await prisma.message.findUnique({ where: { waMessageId: wamid }, select: { id: true } });
  const draftRow = msg ? await prisma.aiDraft.findFirst({ where: { inReplyToMessageId: msg.id } }) : null;
  const outCount = await prisma.message.count({ where: { conversationId: conv.id, direction: "OUT" } });
  return {
    intent: conv.intent,
    urgency: conv.urgency,
    urgent: conv.urgent,
    draftText: draftRow?.draftText ?? null,
    draftLatencyMs: draftRow?.latencyMs ?? null,
    draftModel: draftRow?.model ?? null,
    outCount,
    done: true,
  };
}

type Expect = (o: CaseOutcome) => { ok: boolean; why: string };

const CASES: { name: string; text: string; expect: Expect }[] = [
  {
    name: "Case1 URGENT_PAIN（牙痛到瞓唔知 — FLOOR 紅旗詞）",
    text: "牙痛到瞓唔知",
    expect: (o) => {
      if (!o.done) return { ok: false, why: "AI job 120s 未完成（timeout）" };
      if (o.outCount !== 0) return { ok: false, why: `有 ${o.outCount} 條 OUT 訊息（鐵律：急症唔自動發）` };
      if (o.draftText !== null) return { ok: false, why: "有 draft（鐵律：URGENT_PAIN 唔出 draft）" };
      const isUrgent = o.intent === "URGENT_PAIN" || o.urgency === "HIGH";
      if (!isUrgent) return { ok: false, why: `intent=${o.intent} urgency=${o.urgency}（期望 URGENT_PAIN 或 HIGH）` };
      return { ok: true, why: `intent=${o.intent} urgency=${o.urgency} urgent=${o.urgent} · 0 draft 0 OUT（鐵律生效）` };
    },
  },
  {
    name: "Case2 BOOKING_REQUEST（想約下週一睇牙）",
    text: "想約下週一睇牙",
    expect: (o) => {
      if (!o.done) return { ok: false, why: "AI job 120s 未完成（timeout）" };
      if (o.intent !== "BOOKING_REQUEST") return { ok: false, why: `intent=${o.intent}（期望 BOOKING_REQUEST）` };
      if (!o.draftText || o.draftText.trim().length < 4) return { ok: false, why: "draft 缺 / 太短（要有真 draft 內容）" };
      const hits = forbiddenHits(o.draftText);
      if (hits.length > 0) return { ok: false, why: `draft 違規（${hits.join("、")}）` };
      if ((o.draftLatencyMs ?? 0) <= 0) return { ok: false, why: "latency 未記錄" };
      return { ok: true, why: `intent=BOOKING_REQUEST · draft ${o.draftText.length}字 · latency ${o.draftLatencyMs}ms · 無鐵律違規` };
    },
  },
  {
    name: "Case3 多謝（其他 intent + 合理 reply）",
    text: "多謝",
    expect: (o) => {
      if (!o.done) return { ok: false, why: "AI job 120s 未完成（timeout）" };
      if (o.intent === "URGENT_PAIN" || o.intent === "BOOKING_REQUEST") {
        return { ok: false, why: `intent=${o.intent}（多謝唔應該係 URGENT/BOOKING）` };
      }
      if (o.urgency === "HIGH") return { ok: false, why: "urgency=HIGH（多謝應該 LOW/MED）" };
      if (!o.draftText || o.draftText.trim().length < 2) return { ok: false, why: "無合理 reply（期望有草稿）" };
      const hits = forbiddenHits(o.draftText);
      if (hits.length > 0) return { ok: false, why: `reply 違規（${hits.join("、")}）` };
      return { ok: true, why: `intent=${o.intent} urgency=${o.urgency} · reply ${o.draftText.length}字 · 無鐵律違規` };
    },
  },
];

async function main(): Promise<void> {
  if (!SECRET) {
    fail("WA_APP_SECRET missing（.env）");
    process.exit(1);
  }
  console.log("════════════════════════════════════════════════");
  console.log(" Real-AI E2E（sglang 真機）— WhatsApp mock / AI 真");
  console.log("════════════════════════════════════════════════");

  // ── credentials + ADMIN login ─────────────────────────────────────────
  const cred = await readFile(new URL("../.dev/credentials.txt", import.meta.url).pathname, "utf8");
  const adminLine = cred.split("\n").find((l) => l.startsWith("ADMIN:"));
  if (!adminLine) {
    fail(".dev/credentials.txt 缺 ADMIN 行");
    process.exit(1);
  }
  const m = adminLine.match(/^(.*?):\s+(.+?)\s+\/\s+(.+)$/);
  if (!m) {
    fail("credentials format 錯誤");
    process.exit(1);
  }
  const adminCookie = await login(m[2], m[3]);
  if (!adminCookie) {
    fail("ADMIN login failed");
    process.exit(1);
  }

  // ── 0a. /admin AI 狀態卡：真 model 名 + 各舖 aiMode 統計 ──────────────
  const aiRes = await fetch(`${BASE}/api/admin/ai-status`, { headers: { cookie: adminCookie } });
  if (!aiRes.ok) {
    fail(`/api/admin/ai-status → ${aiRes.status}`);
    process.exit(1);
  }
  const aiStatus = (await aiRes.json()) as {
    mode: string;
    primaryModel: string;
    stats: { lastLatencyMs: number | null; lastTokens: number | null; totalCalls: number } | null;
    clinics: { id: string; code: string; aiMode: string }[];
  };
  console.log(`  AI status: mode=${aiStatus.mode} primaryModel=${aiStatus.primaryModel}`);
  if (aiStatus.mode !== "real") fail("ai-status mode 應該 real（AI_MOCK=0）");
  else pass("ai-status mode=real");
  if (aiStatus.primaryModel !== EXPECTED_MODEL) {
    fail(`ai-status primaryModel=${aiStatus.primaryModel}（期望 ${EXPECTED_MODEL}）`);
  } else {
    pass(`ai-status 顯示真 model 名（${EXPECTED_MODEL}）`);
  }
  if (Array.isArray(aiStatus.clinics) && aiStatus.clinics.length > 0 && aiStatus.clinics.every((c) => c.aiMode === "DRAFT" || c.aiMode === "AUTO")) {
    pass("ai-status 含各舖 aiMode 統計（Phase 2b）");
  } else {
    fail("ai-status clinics/aiMode 欄位缺");
  }
  // 確保全部 DRAFT（純 AI 品質測試）
  for (const c of aiStatus.clinics) {
    if (c.aiMode !== "DRAFT") {
      const r = await fetch(`${BASE}/api/admin/clinics/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", cookie: adminCookie },
        body: JSON.stringify({ aiMode: "DRAFT" }),
      });
      if (!r.ok) fail(`reset ${c.code} → DRAFT failed (${r.status})`);
    }
  }
  const statsBefore = aiStatus.stats?.totalCalls ?? 0;

  // ── 1. 3 類 intent 實測（每 case 最多 3 次嘗試） ───────────────────────
  const EPOCH = Date.now().toString(36);
  for (let ci = 0; ci < CASES.length; ci++) {
    const c = CASES[ci];
    let lastWhy = "";
    let succeeded = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const from = `8526${100 + ci}${EPOCH}${attempt}`.slice(0, 13);
      const wamid = `wamid.REALAI_${ci}_${EPOCH}_${attempt}`;
      process.stdout.write(`  [${c.name} attempt ${attempt}/3] ... `);
      const o = await runCaseOnce("TKW", from, c.text, wamid);
      const { ok, why } = c.expect(o);
      console.log(ok ? "PASS" : `→ retry（${why}）`);
      if (ok) {
        pass(`${c.name}：${why}`);
        if (o.draftText) console.log(`     draft> ${o.draftText.slice(0, 120)}${o.draftText.length > 120 ? "…" : ""}`);
        if (o.draftModel) console.log(`     model=${o.draftModel} latency=${o.draftLatencyMs}ms`);
        succeeded = true;
        break;
      }
      lastWhy = why;
    }
    if (!succeeded) fail(`${c.name}（連 3 次失敗）：${lastWhy}`);
  }

  // ── 2. latency / tokens 記錄（AiCallStats 實測數據） ───────────────────
  await new Promise((r) => setTimeout(r, 2000));
  const aiRes2 = await fetch(`${BASE}/api/admin/ai-status`, { headers: { cookie: adminCookie } });
  const aiStatus2 = (await aiRes2.json()) as {
    stats: { lastLatencyMs: number | null; lastTokens: number | null; totalCalls: number; okCalls: number } | null;
  };
  const lat = aiStatus2.stats?.lastLatencyMs ?? null;
  const tok = aiStatus2.stats?.lastTokens ?? null;
  if (lat !== null && lat > 0) pass(`AiCallStats.lastLatencyMs=${lat}ms（admin 卡實測 latency）`);
  else fail(`AiCallStats.lastLatencyMs 缺（=${lat}）`);
  if (tok !== null && tok > 0) pass(`AiCallStats.lastTokens=${tok}（admin 卡實測 tokens）`);
  else fail(`AiCallStats.lastTokens 缺（=${tok}）`);
  if ((aiStatus2.stats?.totalCalls ?? 0) > statsBefore) {
    pass(`AiCallStats.totalCalls 递增（${statsBefore} → ${aiStatus2.stats?.totalCalls}）`);
  } else {
    fail(`AiCallStats.totalCalls 未递增（before=${statsBefore} after=${aiStatus2.stats?.totalCalls}）`);
  }

  console.log("════════════════════════════════════════════════");
  console.log(` Real-AI E2E 完成：PASS=${passCount} FAIL=${failCount}`);
  console.log("════════════════════════════════════════════════");
  process.exitCode = failCount === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error("[e2e-real-ai] fatal:", err instanceof Error ? err.stack ?? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
    // ★ 明確 process.exit — pnpm/tsx 環境下 event loop 可能唔 drain 淨（e2e-ai-job 實測），
    //   唔好依賴「全部 handle 自己關晒」。
    process.exit(process.exitCode ?? 0);
  });

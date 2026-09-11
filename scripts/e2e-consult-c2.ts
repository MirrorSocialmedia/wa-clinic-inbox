/**
 * ★ consult v2.1 C2（cwi-consult-20260910b）：e2e — MD §3 資料層 + T2 死分支接活（T244/T245）。
 *
 * 前置：dev stack live（server 3100 / DB 15432 / worker AI_MOCK=1）、
 *   migration 20260911021000_cwi_consult_c2_data_layer 已 apply。
 * 用法：pnpm tsx scripts/e2e-consult-c2.ts
 *
 * 階段（fixture 前綴 e2ec2，TKW = 測試場）：
 * - S1 ConsultProduct CRUD + iron rule（isProductUsable）：
 *      未批准（approvedAt=null）/ 停用（enabled=false）唔會喺 usable list 出（API 層斷言）；
 *      PUT 批准 → 變 usable；PATCH 啟用/停用（含冪等 changed=false）；unique 重複 → 409；audit 落。
 * - S2 ConsultSession API：GET 空態 / POST create（default）/ 重複 active → 409 /
 *      terminal 後再開得（守衛只攔 active）/ C1 橋接（humanTookOver/lastOutboundText 複製）/ 非法 workflow 400。
 * - S3 T245 復活（<7 日）：EXPIRED session（3 日）+ RESOLVED 對話 + 病人 inbound →
 *      翻開後 terminal=null、turnCount/stage 保留、audit CONVERSATION_REOPENED consultRevived=true。
 * - S4 T245 唔復活（≥7 日）：EXPIRED session（8 日）→ 翻開後 terminal 保持 EXPIRED、consultRevived=false。
 * - S5 T244 auto-resolve 守門 ④：active session 喺 → sweep 唔關（對照：無 session 照關）+
 *      shouldAutoResolve(opts.activeConsultSession=true) 純函數 false。
 * - 收尾 fixture sweep：waId e2ec2-% 冚家潔 + 產品 e2ec2% 刪 + residue 0 斷言。
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { runAutoResolveSweep, shouldAutoResolve } from "../src/lib/auto-resolve";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch { /* ok */ }

const BASE = "http://127.0.0.1:3100";
const REPO = new URL("..", import.meta.url).pathname;
const prisma = new PrismaClient();

const WIDS = ["e2ec2-s1", "e2ec2-s2", "e2ec2-s3", "e2ec2-s4", "e2ec2-s5", "e2ec2-s6"];
const CODE_PREFIX = "e2ec2";

// ── API response shapes（cast 用；未知欄以 index signature 兜） ────────────
interface ProductRow {
  id: string; code: string; usable: boolean; enabled: boolean; clinicId: string | null;
  [k: string]: unknown;
}
interface SessionRow {
  id: string; stage: string; terminal: string | null; active: boolean;
  turnCount: number; purchaseIntent: number; ctaGiven: boolean;
  humanTookOver: boolean; lastOutboundText: string | null;
  [k: string]: unknown;
}
interface ListResp { products?: ProductRow[]; [k: string]: unknown }
interface SessionsResp { active: SessionRow | null; sessions: SessionRow[]; [k: string]: unknown }
interface ReopenMeta { consultRevived?: boolean; [k: string]: unknown }
interface CreateMeta { bridgedFromConversation?: { humanTookOver?: boolean }; [k: string]: unknown }

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
  // 已記錄環境 flake（TOOLS.md）：Next 15 dev loadManifest race → 瞬時 500 HTML error page（無 JSON）。
  // 判定：500 + 無 JSON body。重試一次（非 code 回歸）。
  if (out.status === 500 && out.json === null) {
    await sleep(1500);
    const retry = await doFetch();
    if (retry.json !== null) return retry;
  }
  return out;
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
      const msg = await prisma.message.findFirst({ where: { direction: "IN", body: text }, orderBy: { createdAt: "desc" } });
      if (!msg) return null;
      const conv = await prisma.conversation.findUnique({ where: { id: msg.conversationId } });
      const contact = conv ? await prisma.contact.findFirst({ where: { id: conv.contactId } }) : null;
      return contact?.waId === waId && conv ? { msgId: msg.id, convId: conv.id } : null;
    }
  );
}

/** 等對話變指定狀態（翻開後）。 */
async function pollConv(convId: string, wantStatus: string, what: string) {
  return poll(what, async () => {
    const c = await prisma.conversation.findUnique({ where: { id: convId } });
    return c?.status === wantStatus ? c : null;
  });
}

/** 等 reopen audit 行（consultRevived 已寫）。 */
async function reopenAudit(convId: string) {
  return poll(`reopen audit for ${convId.slice(0, 8)}`, async () => {
    const a = await prisma.auditLog.findFirst({
      where: { action: "CONVERSATION_REOPENED", entityId: convId },
      orderBy: { createdAt: "desc" },
    });
    const meta = (a?.meta ?? null) as ReopenMeta | null;
    return meta && typeof meta.consultRevived === "boolean" ? { meta } : null;
  }, 20_000);
}

/** raw SQL：backdate session（terminal + updatedAt）— @updatedAt 欄 Prisma client 唔可寫。 */
async function setSessionExpired(sessionId: string, daysAgo: number): Promise<void> {
  await prisma.$executeRaw`UPDATE "ConsultSession" SET terminal = 'EXPIRED', "updatedAt" = now() - ${daysAgo} * interval '1 day' WHERE id = ${sessionId}`;
}

/** raw SQL：backdate 對話三個時間戳（auto-resolve 守門 ①② 測試用）。 */
async function backdateConv(convId: string, daysAgo: number): Promise<void> {
  await prisma.$executeRaw`UPDATE "Conversation" SET "lastMessageAt" = now() - ${daysAgo} * interval '1 day', "lastInboundAt" = now() - ${daysAgo} * interval '1 day', "lastOutboundAt" = now() - ${daysAgo - 1} * interval '1 day' WHERE id = ${convId}`;
}

async function main(): Promise<void> {
  const credsText = readFileSync(new URL("../.dev/credentials.txt", import.meta.url).pathname, "utf8");
  const adminLine = credsText.split("\n").find((l) => l.startsWith("ADMIN:")) ?? "";
  const [email, pw] = adminLine.split(": ").slice(1).join(": ").split(" / ");
  if (!email || !pw) throw new Error("credentials: ADMIN missing");
  const adminCookie = await login(email, pw);

  const clinic = await prisma.clinic.findUnique({ where: { code: "TKW" } });
  if (!clinic) throw new Error("TKW clinic not found");
  const tkw = clinic.id;

  // 冪等 sweep（可重入：deleteMany 天然冪等）— pre（開工前洗殘留）/ end（收尾）/ fatal 各調一次。
  const sweep = async (label: string): Promise<void> => {
    try {
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
          prisma.flowSession.deleteMany({ where: { conversationId: { in: convIds } } }),
          prisma.staffNotice.deleteMany({ where: { conversationId: { in: convIds } } }),
          prisma.message.deleteMany({ where: { conversationId: { in: convIds } } }),
          prisma.auditLog.deleteMany({ where: { entityId: { in: [...msgIds, ...convIds, ...sessIds] } } }),
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

  // ── pre-sweep：洗上一次殘留（fatal 中途死嘅 fixture 唔阻本次 run） ─────────
  await sweep("pre");

  // ── S1 ConsultProduct CRUD + iron rule ─────────────────────────────────
  console.log("\n[S1] ConsultProduct CRUD + iron rule");
  const mkProduct = (extra: Record<string, unknown>) => api(adminCookie, "/api/admin/consult-products", "POST", {
    clinicId: tkw,
    workflow: "ORTHODONTIC_CONSULT",
    code: `${CODE_PREFIX}A`,
    displayName: "e2ec2 測試產品 A",
    positioning: "e2ec2 測試定位",
    approvedWording: "e2ec2 批准講法",
    sortOrder: 1,
    ...extra,
  });
  {
    // A = 已批准啟用（usable）
    let r = await mkProduct({ code: `${CODE_PREFIX}A`, approvedBy: "e2e", approvedAt: new Date().toISOString() });
    const a = r.json as ProductRow;
    check("POST 已批准產品 → 201 + usable=true", r.status === 201 && a.usable === true, JSON.stringify(r.json).slice(0, 150));
    // B = 未批准（approvedAt=null → 唔 usable）
    r = await mkProduct({ code: `${CODE_PREFIX}B`, approvedAt: null });
    const b = r.json as ProductRow;
    check("POST 未批准產品 → 201 + usable=false（iron rule）", r.status === 201 && b.usable === false, JSON.stringify(r.json).slice(0, 150));
    // D = 停用（enabled=false → 唔 usable）
    r = await mkProduct({ code: `${CODE_PREFIX}D`, enabled: false, approvedBy: "e2e", approvedAt: new Date().toISOString() });
    const d = r.json as ProductRow;
    check("POST 停用產品 → 201 + usable=false（iron rule）", r.status === 201 && d.usable === false, JSON.stringify(r.json).slice(0, 150));
    // C = 全局（clinicId=null）已批准
    r = await mkProduct({ code: `${CODE_PREFIX}C`, clinicId: null, workflow: "IMPLANT_CONSULT", approvedBy: "e2e", approvedAt: new Date().toISOString() });
    check("POST 全局產品（clinicId=null）→ 201", r.status === 201, JSON.stringify(r.json).slice(0, 150));
    // 重複 code → 409
    r = await mkProduct({ code: `${CODE_PREFIX}A`, approvedBy: "e2e", approvedAt: new Date().toISOString() });
    check("重複 (clinic,workflow,code) → 409", r.status === 409, `status=${r.status}`);
  }
  {
    // GET list（clinic filter：該店 + 全局）— ★ C4 後 global 有出廠 seed（5 條）→ 動態計
    const r = await api(adminCookie, `/api/admin/consult-products?clinicId=${tkw}`, "GET");
    const list = r.json as ListResp;
    const codes = (list.products ?? []).map((p) => p.code).sort();
    const globalCount = await prisma.consultProduct.count({ where: { clinicId: null } });
    check("GET list 含該店 3 + 全部 global（含 C4 出廠 seed）", r.status === 200 && codes.length === 3 + globalCount && ["e2ec2A", "e2ec2B", "e2ec2C", "e2ec2D"].every((c) => codes.includes(c)), JSON.stringify(codes));
    const byCode = Object.fromEntries((list.products ?? []).map((p) => [p.code, p]));
    check("usable 旗：A=true B=false C=true D=false", byCode.e2ec2A?.usable === true && byCode.e2ec2B?.usable === false && byCode.e2ec2C?.usable === true && byCode.e2ec2D?.usable === false);
    // usable=1 過濾（鐵律 API 層口徑 = C3 檢索同一 helper）
    const r2 = await api(adminCookie, `/api/admin/consult-products?clinicId=${tkw}&usable=1`, "GET");
    const usableCodes = ((r2.json as ListResp).products ?? []).map((p) => p.code).sort();
    check("usable=1 只回 A/C（未批准 B + 停用 D 唔出）", usableCodes.length === 2 && usableCodes.join() === "e2ec2A,e2ec2C", JSON.stringify(usableCodes));
  }
  {
    // PUT 批准 B → 變 usable
    const bRow = await prisma.consultProduct.findFirst({ where: { code: `${CODE_PREFIX}B` } });
    const r = await api(adminCookie, `/api/admin/consult-products/${bRow?.id}`, "PUT", { approvedBy: "e2e", approvedAt: new Date().toISOString() });
    check("PUT 批准 B → usable=true", r.status === 200 && (r.json as ProductRow).usable === true, JSON.stringify(r.json).slice(0, 150));
    const r2 = await api(adminCookie, `/api/admin/consult-products?clinicId=${tkw}&usable=1`, "GET");
    check("usable=1 現含 A/B/C", ((r2.json as ListResp).products ?? []).map((p) => p.code).sort().join() === "e2ec2A,e2ec2B,e2ec2C");
    // PATCH 啟用 D → usable；再 PATCH 冪等 changed=false
    const dRow = await prisma.consultProduct.findFirst({ where: { code: `${CODE_PREFIX}D` } });
    const r3 = await api(adminCookie, `/api/admin/consult-products/${dRow?.id}`, "PATCH", { enabled: true });
    const d3 = r3.json as ProductRow & { changed: boolean };
    check("PATCH 啟用 D → usable=true changed=true", r3.status === 200 && d3.usable === true && d3.changed === true, JSON.stringify(r3.json).slice(0, 150));
    const r4 = await api(adminCookie, `/api/admin/consult-products/${dRow?.id}`, "PATCH", { enabled: true });
    check("PATCH 冪等（再啟用）→ changed=false", r4.status === 200 && (r4.json as { changed: boolean }).changed === false);
    // audit 落
    const audits = await prisma.auditLog.count({ where: { action: { in: ["CONSULT_PRODUCT_CREATE", "CONSULT_PRODUCT_UPDATE", "CONSULT_PRODUCT_TOGGLE"] }, entity: "ConsultProduct" } });
    check("audit 產品動作落（create/update/toggle）", audits >= 6, `count=${audits}`);
  }

  // ── S2 ConsultSession API ──────────────────────────────────────────────
  console.log("\n[S2] ConsultSession API（create 守衛 + C1 橋接）");
  const s1 = await inbound("e2ec2-s1", "e2ec2 s1 開場");
  {
    const r0 = await api(adminCookie, `/api/conversations/${s1.convId}/consult-sessions`, "GET");
    const l0 = r0.json as SessionsResp;
    check("GET 空態 → sessions=[] active=null", r0.status === 200 && l0.sessions.length === 0 && l0.active === null, JSON.stringify(r0.json).slice(0, 150));
    // 非法 workflow
    const rBad = await api(adminCookie, `/api/conversations/${s1.convId}/consult-sessions`, "POST", { workflow: "BOGUS" });
    check("非法 workflow → 400", rBad.status === 400, `status=${rBad.status}`);
    // create
    const r1 = await api(adminCookie, `/api/conversations/${s1.convId}/consult-sessions`, "POST", { workflow: "ORTHODONTIC_CONSULT" });
    const s1r = r1.json as SessionRow;
    check("POST create → 201 + stage=DISCOVER + terminal=null + active=true", r1.status === 201 && s1r.stage === "DISCOVER" && s1r.terminal === null && s1r.active === true, JSON.stringify(r1.json).slice(0, 200));
    check("default：turnCount=0 purchaseIntent=0 ctaGiven=false humanTookOver=false", s1r.turnCount === 0 && s1r.purchaseIntent === 0 && s1r.ctaGiven === false && s1r.humanTookOver === false);
    // 重複 active → 409
    const r2 = await api(adminCookie, `/api/conversations/${s1.convId}/consult-sessions`, "POST", { workflow: "ORTHODONTIC_CONSULT" });
    check("重複 active → 409 + activeId 指向現有", r2.status === 409 && (r2.json as { activeId: string }).activeId === s1r.id, JSON.stringify(r2.json).slice(0, 150));
    // GET 狀態
    const r3 = await api(adminCookie, `/api/conversations/${s1.convId}/consult-sessions`, "GET");
    const l3 = r3.json as SessionsResp;
    check("GET → active = 該 session", l3.active?.id === s1r.id && l3.sessions.length === 1);
    // C1 橋接：conv 過渡欄置值 → 舊 session 置 terminal → 再開 → 新 session 複製
    await prisma.conversation.update({ where: { id: s1.convId }, data: { humanTookOver: true, lastOutboundText: "e2ec2-bridge-text" } });
    await prisma.consultSession.update({ where: { id: s1r.id }, data: { terminal: "HANDOFF" } });
    const r4 = await api(adminCookie, `/api/conversations/${s1.convId}/consult-sessions`, "POST", { workflow: "ORTHODONTIC_CONSULT" });
    const s4 = r4.json as SessionRow;
    check("terminal 後再開 → 201（守衛只攔 active）", r4.status === 201, `status=${r4.status}`);
    check("C1 橋接：humanTookOver/lastOutboundText 由 Conversation 複製", s4.humanTookOver === true && s4.lastOutboundText === "e2ec2-bridge-text", JSON.stringify({ h: s4.humanTookOver, t: s4.lastOutboundText }));
    // audit
    const a = await prisma.auditLog.findFirst({ where: { action: "CONSULT_SESSION_CREATE", entityId: s4.id } });
    check("audit CONSULT_SESSION_CREATE + 橋接 meta", !!a && ((a.meta as CreateMeta)?.bridgedFromConversation?.humanTookOver === true));
  }

  // ── S3 T245 復活（<7 日） ──────────────────────────────────────────────
  console.log("\n[S3] T245 復活（EXPIRED 3 日 < 7 日）");
  const s2 = await inbound("e2ec2-s2", "e2ec2 s2 開場");
  {
    const c = await api(adminCookie, `/api/conversations/${s2.convId}/consult-sessions`, "POST", { workflow: "ORTHODONTIC_CONSULT" });
    const sid = (c.json as SessionRow).id;
    // turnCount/stage 先寫上，驗復活後保留
    await prisma.consultSession.update({ where: { id: sid }, data: { turnCount: 5, stage: "PRESENT_OPTIONS" } });
    await setSessionExpired(sid, 3);
    await prisma.conversation.update({ where: { id: s2.convId }, data: { status: "RESOLVED", resolvedBy: "AUTO", resolvedAt: new Date() } });
    const before = await prisma.consultSession.findUnique({ where: { id: sid } });
    check("前置：terminal=EXPIRED + turnCount=5 + stage=PRESENT_OPTIONS", before?.terminal === "EXPIRED" && before?.turnCount === 5 && before?.stage === "PRESENT_OPTIONS");
    // 病人 inbound → 翻開 + 復活
    await inbound("e2ec2-s2", "e2ec2 s2 復出");
    await pollConv(s2.convId, "OPEN", "conv s2 翻開");
    const after = await poll(`s2 session 復活`, async () => {
      const s = await prisma.consultSession.findUnique({ where: { id: sid } });
      return s?.terminal === null ? s : null;
    }, 20_000);
    check("復活：terminal=null", after.terminal === null);
    check("turnCount 保留 = 5", after.turnCount === 5);
    check("stage 保留 = PRESENT_OPTIONS", after.stage === "PRESENT_OPTIONS");
    const a = await reopenAudit(s2.convId);
    check("audit CONVERSATION_REOPENED consultRevived=true", a.meta.consultRevived === true, JSON.stringify(a.meta));
  }

  // ── S4 T245 唔復活（≥7 日） ────────────────────────────────────────────
  console.log("\n[S4] T245 唔復活（EXPIRED 8 日 ≥ 7 日）");
  const s3 = await inbound("e2ec2-s3", "e2ec2 s3 開場");
  {
    const c = await api(adminCookie, `/api/conversations/${s3.convId}/consult-sessions`, "POST", { workflow: "IMPLANT_CONSULT" });
    const sid = (c.json as SessionRow).id;
    await prisma.consultSession.update({ where: { id: sid }, data: { turnCount: 2, stage: "EDUCATE_COMPARE" } });
    await setSessionExpired(sid, 8);
    await prisma.conversation.update({ where: { id: s3.convId }, data: { status: "RESOLVED", resolvedBy: "AUTO", resolvedAt: new Date() } });
    await inbound("e2ec2-s3", "e2ec2 s3 復出");
    const conv = await pollConv(s3.convId, "OPEN", "conv s3 翻開");
    const s = await prisma.consultSession.findUnique({ where: { id: sid } });
    check("對話照翻開（OPEN）", conv.status === "OPEN");
    check("session 唔復活：terminal 保持 EXPIRED", s?.terminal === "EXPIRED", `terminal=${s?.terminal}`);
    const a = await reopenAudit(s3.convId);
    check("audit consultRevived=false（≥7 日）", a.meta.consultRevived === false, JSON.stringify(a.meta));
  }

  // ── S5 T244 auto-resolve 守門 ④ ────────────────────────────────────────
  console.log("\n[S5] T244 auto-resolve 第三守門（active ConsultSession 唔關）");
  {
    // 純函數口徑
    const base = {
      id: "x",
      clinicId: tkw,
      lastMessageAt: new Date(Date.now() - 4 * 86_400_000),
      lastInboundAt: new Date(Date.now() - 4 * 86_400_000),
      lastOutboundAt: new Date(Date.now() - 3 * 86_400_000),
    };
    check("shouldAutoResolve：無 session → true（對照）", shouldAutoResolve(base, 3) === true);
    check("shouldAutoResolve：activeConsultSession=true → false（守門 ④）", shouldAutoResolve(base, 3, new Date(), { activeConsultSession: true }) === false);

    // 實 sweep：conv s4 有 active session → 唔關；conv s5 無 session → 照關
    const s4 = await inbound("e2ec2-s4", "e2ec2 s4 開場");
    const s5 = await inbound("e2ec2-s5", "e2ec2 s5 開場");
    await api(adminCookie, `/api/conversations/${s4.convId}/consult-sessions`, "POST", { workflow: "ORTHODONTIC_CONSULT" });
    await backdateConv(s4.convId, 4);
    await backdateConv(s5.convId, 4);
    const r = await runAutoResolveSweep(new Date());
    const c4 = await prisma.conversation.findUnique({ where: { id: s4.convId } });
    const c5 = await prisma.conversation.findUnique({ where: { id: s5.convId } });
    check("sweep 跑通（failed=0）", r.failed === 0, JSON.stringify(r));
    check("active session 喺 → 唔關（status 保持 OPEN）", c4?.status === "OPEN", `status=${c4?.status}`);
    check("對照：無 session → 照關（RESOLVED + AUTO）", c5?.status === "RESOLVED" && c5?.resolvedBy === "AUTO", `status=${c5?.status} by=${c5?.resolvedBy}`);
    const note = c5 ? await prisma.message.findFirst({ where: { conversationId: c5.id, channel: "INTERNAL", type: "note" } }) : null;
    check("對照：INTERNAL 備註落", !!note && /日冇活動/.test(note.body ?? ""));
  }

  // ── 收尾 residue 斷言 + sweep ─────────────────────────────────────────
  console.log("\n[sweep] 冚家潔");
  await sweep("end");
  const residue = {
    products: await prisma.consultProduct.count({ where: { code: { startsWith: CODE_PREFIX } } }),
    contacts: await prisma.contact.count({ where: { waId: { startsWith: "e2ec2-" } } }),
  };
  const sessLeft = await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "ConsultSession" WHERE "conversationId" IN (SELECT c.id FROM "Conversation" c JOIN "Contact" ct ON ct.id = c."contactId" WHERE ct."waId" LIKE 'e2ec2-%')`);
  check("residue = 0（products/contacts/sessions）", residue.products === 0 && residue.contacts === 0 && (sessLeft[0]?.n ?? -1) === 0, JSON.stringify({ ...residue, sessions: sessLeft[0]?.n ?? null }));

  console.log(`\n══ C2 e2e: ${pass} pass / ${fail} fail ══`);
  if (fail > 0) process.exitCode = 1;
}

main()
  .catch(async (e) => {
    console.error("FATAL:", e instanceof Error ? e.stack : e);
    // fatal 時仍要洗殘留 — 必須 await（未 await → finally 先 $disconnect → sweep 全部 Prisma 錯）
    if (sweepRef) await sweepRef("fatal").catch((se) => console.error("[sweep:fatal] FAILED:", se instanceof Error ? se.message : se));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

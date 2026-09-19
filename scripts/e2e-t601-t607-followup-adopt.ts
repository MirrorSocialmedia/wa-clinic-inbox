/**
 * e2e-t601-t607 — cwi-final S0-4：follow-up「採用並編輯」被當成自己打字（N-6 + N-10）
 *
 * T601（施工單；瀏覽器 e2e，唔准直接 POST）：
 *   開有建議嘅對話 → 撳「採用並編輯」→ 改一個字 → 發送
 *   → DB：Message.sentVia="AI_ADOPTED"、Conversation.humanTookOver=false、
 *     task SENT 且 sentMessageId = 該訊息
 *
 * T607：採用 → 清空 composer → 自己打「你好」發送 → task 仍 SUGGESTED、建議卡仍顯示
 *
 * 背景：舊 code `source = adoptedDraftRef.current ? "adopted" : "typed"` — 跟進建議
 * 「採用並編輯」（free-form，adoptedFollowupRef）唔算 adopted → 被當 typed →
 * 誤置 humanTookOver（「AI 已暫停」）。N-10：清空 composer = 採用關係斷；
 * 自己打字發送唔應該清咗張未送嘅建議卡（onSuggestionSent 條件化）。
 *
 * fixture（direct DB seed，冪等固定 id；assignee=本測試 STAFF 避 423）：
 *   E2EV3 clinic + STAFF（CLINICS scope，E2EV3 主店）
 *   FA / FB 兩對話（lastInboundAt=1h 前 → 24h 窗開）+ 各一條 SUGGESTED
 *   CONVERSATION_IDLE task（template=conversation_followup → 有 templatePreview）
 *
 * 用法（repo root）：pnpm tsx scripts/e2e-t601-t607-followup-adopt.ts
 * 輸出：T601-T607-OK / T601-T607-FAIL: <n>
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";
import { phoneHashes } from "../src/lib/phone-hash";

const require = createRequire(path.join(process.cwd(), "package.json"));
const argon2 = require("argon2");
const { chromium } = require("/usr/lib/node_modules/openclaw/node_modules/playwright-core") as {
  chromium: { launch: (o: Record<string, unknown>) => Promise<any> };
};

try {
  process.loadEnvFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", ".env"));
} catch {
  /* 靠 process env */
}

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const PASS = "T601-E2E-Pass-456!";
const CLINIC_ID = "e2ev3clinic0000000000001"; // 同 e2e-followup-v3 共用（冪等 upsert）
const STAFF_ID = "e2et601staffu000000000001";
const STAFF_EMAIL = "e2et601-staff@e2e.local";
const TASK_A = "e2et601taskfa0000000000001";
const TASK_B = "e2et601taskfb0000000000001";
const FIX = {
  FA: { waId: "94000011", cpId: "cpt601-fa", contactId: "e2et601c-fa", convId: "e2et601v-fa", name: "T601 採用甲" },
  FB: { waId: "94000012", cpId: "cpt601-fb", contactId: "e2et601c-fb", convId: "e2et601v-fb", name: "T607 採用乙" },
};

let FAILS = 0;
function ok(msg: string): void {
  console.log(`  ✅ ${msg}`);
}
function fail(msg: string): void {
  FAILS++;
  console.log(`  ❌ ${msg}`);
}
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) ok(name);
  else fail(`${name}${detail !== undefined ? "（" + JSON.stringify(detail).slice(0, 300) + "）" : ""}`);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const prisma = new PrismaClient();

function findChromium(): string {
  const exe = path.join(
    process.env.HOME ?? "/home/kenneth",
    ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"
  );
  if (!fs.existsSync(exe)) {
    // fallback：搵最新 chromium-*
    const baseDir = path.join(process.env.HOME ?? "/home/kenneth", ".cache", "ms-playwright");
    const d = fs.readdirSync(baseDir).filter((x) => x.startsWith("chromium-")).sort().reverse()[0];
    if (d) return path.join(baseDir, d, "chrome-linux64", "chrome");
    throw new Error("chromium binary 搵唔到（~/.cache/ms-playwright）");
  }
  return exe;
}

async function cleanupFixture(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `DELETE FROM "Message" WHERE "conversationId" IN ('${FIX.FA.convId}','${FIX.FB.convId}')`
  );
  await prisma.$executeRawUnsafe(`DELETE FROM "FollowupTask" WHERE id IN ('${TASK_A}','${TASK_B}')`);
  await prisma.$executeRawUnsafe(
    `DELETE FROM "Conversation" WHERE id IN ('${FIX.FA.convId}','${FIX.FB.convId}')`
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "Contact" WHERE id IN ('${FIX.FA.contactId}','${FIX.FB.contactId}')`
  );
  await prisma.staffClinic.deleteMany({ where: { staffId: STAFF_ID } });
  await prisma.staffUser.deleteMany({ where: { id: STAFF_ID } });
}

async function main(): Promise<void> {
  // ── (1) setup：clinic + STAFF + 對話 + SUGGESTED tasks ─────────────────
  console.log("[setup] 清舊 fixture + seed...");
  await cleanupFixture();
  const clinic = await prisma.clinic.upsert({
    where: { id: CLINIC_ID },
    update: { code: "E2EV3" },
    create: {
      id: CLINIC_ID,
      code: "E2EV3",
      name: "V3 E2E 診所",
      waPhoneNumberId: "109990000000099",
      waDisplayNumber: "+852 3001 9003",
    },
  });
  const pwHash = await argon2.hash(PASS);
  await prisma.staffUser.upsert({
    where: { id: STAFF_ID },
    update: { active: true, scopeType: "CLINICS" as never },
    create: {
      id: STAFF_ID,
      email: STAFF_EMAIL,
      name: "E2E T601 員工",
      passwordHash: pwHash,
      role: "STAFF",
      active: true,
      scopeType: "CLINICS" as never,
    },
  });
  await prisma.staffClinic.create({ data: { staffId: STAFF_ID, clinicId: CLINIC_ID, isPrimary: true } });
  ok("STAFF seed（E2EV3 主店）");

  const rule = await prisma.followupRule.findFirst({
    where: { trigger: "CONVERSATION_IDLE", enabled: true },
    orderBy: { updatedAt: "asc" },
  });
  if (!rule) throw new Error("CONVERSATION_IDLE rule 搵唔到（dev DB 未 seed？）");

  const mkConv = async (k: "FA" | "FB", taskId: string): Promise<void> => {
    const f = FIX[k];
    const ct = await prisma.contact.upsert({
      where: { id: f.contactId },
      update: { clinicId: clinic.id, profileName: f.name },
      create: { id: f.contactId, clinicId: clinic.id, waId: f.waId, profileName: f.name, labels: [] },
    });
    const inboundAt = new Date(Date.now() - 3_600_000);
    await prisma.conversation.upsert({
      where: { id: f.convId },
      update: {
        contactId: ct.id,
        clinicId: clinic.id,
        status: "OPEN",
        assigneeId: STAFF_ID,
        humanTookOver: false,
        lastInboundAt: inboundAt,
        lastMessageAt: inboundAt,
      },
      create: {
        id: f.convId,
        contactId: ct.id,
        clinicId: clinic.id,
        status: "OPEN",
        assigneeId: STAFF_ID,
        lastInboundAt: inboundAt,
        lastMessageAt: inboundAt,
      },
    });
    await prisma.message.create({
      data: {
        conversationId: f.convId,
        direction: "IN",
        channel: "API",
        type: "text",
        body: "你好，想問吓預約嘅嘢。",
        status: "SENT",
        waTimestamp: inboundAt,
        waMessageId: `wam.t601.${k.toLowerCase()}.in`,
      },
    });
    await prisma.followupTask.create({
      data: {
        id: taskId,
        clinicId: clinic.id,
        conversationId: f.convId,
        patientApricotId: f.cpId,
        phoneHashes: phoneHashes(f.waId),
        ruleId: rule.id,
        source: "RULE",
        dueAt: new Date(Date.now() + 3_600_000),
        status: "SUGGESTED",
        templateName: "conversation_followup",
      },
    });
  };
  await mkConv("FA", TASK_A);
  await mkConv("FB", TASK_B);
  ok("fixture 對話 ×2 + SUGGESTED task ×2（窗開 + assignee=STAFF）");

  // ── (2) 瀏覽器 ──────────────────────────────────────────────────────────
  const exe = findChromium();
  const B = await chromium.launch({ headless: true, executablePath: exe });
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: STAFF_EMAIL, password: PASS }),
  });
  if (res.status !== 200) throw new Error(`login → ${res.status}`);
  const m = (res.headers.get("set-cookie") ?? "").match(/wa_inbox_session=([^;]+)/);
  if (!m) throw new Error("login 回應冇 wa_inbox_session cookie");
  const C = await B.newContext({ viewport: { width: 1440, height: 900 } });
  await C.addCookies([{ name: "wa_inbox_session", value: m[1], domain: "127.0.0.1", path: "/" }]);
  const P = await C.newPage();

  // loadManifest race 防（dev flake）：error page → reload（≤3）
  async function gotoRetry(url: string): Promise<void> {
    for (let i = 1; i <= 3; i++) {
      await P.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
      const body = await P.evaluate(() => document.body?.innerText ?? "");
      if (!body.includes("Internal Server Error")) return;
      await sleep(2000);
    }
    throw new Error("loadManifest race — 3 次仍 error page");
  }
  const sel = (d: string) => P.locator(`[data-e2e="${d}"]`);
  const composer = () => P.locator("textarea[placeholder^='輸入訊息']").first();

  async function openConv(name: string): Promise<void> {
    // 列表 row 有 profileName；撳佢
    const row = P.getByText(name, { exact: true }).first();
    await row.waitFor({ state: "visible", timeout: 30_000 });
    // ★ cwi-final B1fix-harness-3（2026-09-19）：hydration 防 — 首載 click 可 no-op（dev JS 未 hydration，
    //   SSR row 先出；probe 實錘：+6s settle 後 click 全鏈綠）。CTO3 script 同款 3 輪 retry 口徑。
    for (let round = 1; round <= 3; round++) {
      await row.click();
      try {
        await sel("fu-sugg-card").waitFor({ state: "visible", timeout: 10_000 });
        return;
      } catch {
        console.log(`  [hydration flake] 建議卡 10s 未出現 — 重撳（round ${round}/3）`);
        await sleep(1500);
      }
    }
    await sel("fu-sugg-card").waitFor({ state: "visible", timeout: 10_000 });
  }

  try {
    await gotoRetry(`${BASE}/inbox`);

    // ── T601：採用並編輯 → 改一個字 → 發送 ─────────────────────────────
    console.log("\n[T601] 採用並編輯（改一個字）→ adopted 發送");
    await openConv(FIX.FA.name);
    const adoptBtn = sel("fu-sugg-adopt");
    check("T601a 建議卡「採用並編輯」可用（templatePreview 非空 + 窗開）", (await adoptBtn.isEnabled()) === true);
    await adoptBtn.click();
    await sleep(300);
    const filled = (await composer().inputValue()) as string;
    check("T601b 採用後 composer 已填建議文案", filled.length > 10, { len: filled.length });
    // 改一個字（append — fill 確定性，avoid 游標位置 flake）
    await composer().fill(filled + "0");
    const edited = (await composer().inputValue()) as string;
    check("T601c 改咗一個字", edited.length === filled.length + 1 && edited.endsWith("0"));
    await P.locator("button[aria-label='發送']").first().click();
    // 等發送落地（composer 清 + DB OUT message）
    const t0 = Date.now();
    let msgA: any = null;
    for (;;) {
      msgA = await prisma.message.findFirst({
        where: { conversationId: FIX.FA.convId, direction: "OUT" },
        orderBy: { createdAt: "desc" },
        select: { id: true, sentVia: true, body: true },
      });
      const draft = (await composer().inputValue()) as string;
      if (msgA && draft === "") break;
      if (Date.now() - t0 > 15_000) break;
      await sleep(500);
    }
    check("T601d 發送成功（composer 清 + OUT message 落庫）", msgA != null, msgA);
    const convA = await prisma.conversation.findUnique({
      where: { id: FIX.FA.convId },
      select: { humanTookOver: true },
    });
    const taskA = await prisma.followupTask.findUnique({
      where: { id: TASK_A },
      select: { status: true, sentMessageId: true, handledAt: true },
    });
    check("T601e Message.sentVia = AI_ADOPTED", msgA?.sentVia === "AI_ADOPTED", msgA);
    check("T601f 改咗嘅字喺訊息 body", typeof msgA?.body === "string" && msgA.body.endsWith("0") && msgA.body.length === filled.length + 1, { body: msgA?.body?.slice(-20) });
    check("T601g Conversation.humanTookOver = false（ado 採用唔係自己打字）", convA?.humanTookOver === false, convA);
    check("T601h task SENT + sentMessageId = 該訊息", taskA?.status === "SENT" && taskA?.sentMessageId === msgA?.id, taskA);

    // ── T607：採用 → 清空 composer → 自己打「你好」發送 ─────────────────
    console.log("\n[T607] 採用 → 清空 → 自己打字發送（task 唔該被 claim）");
    await openConv(FIX.FB.name);
    const adoptB = sel("fu-sugg-adopt");
    check("T607a 建議卡「採用並編輯」可用", (await adoptB.isEnabled()) === true);
    await adoptB.click();
    await sleep(300);
    const filledB = (await composer().inputValue()) as string;
    check("T607b 採用後 composer 已填", filledB.length > 10, { len: filledB.length });
    // 清空 composer（select-all + delete → onChange v="" → 採用旗清）
    await composer().click();
    await P.keyboard.down("Control");
    await P.keyboard.press("a");
    await P.keyboard.up("Control");
    await P.keyboard.press("Delete");
    await sleep(200);
    const cleared = (await composer().inputValue()) as string;
    check("T607c composer 已清空", cleared === "", { cleared });
    await P.keyboard.type("你好");
    await P.locator("button[aria-label='發送']").first().click();
    const t1 = Date.now();
    let msgB: any = null;
    for (;;) {
      msgB = await prisma.message.findFirst({
        where: { conversationId: FIX.FB.convId, direction: "OUT" },
        orderBy: { createdAt: "desc" },
        select: { id: true, sentVia: true, body: true },
      });
      const draft = (await composer().inputValue()) as string;
      if (msgB && draft === "") break;
      if (Date.now() - t1 > 15_000) break;
      await sleep(500);
    }
    check("T607d 發送成功（自己打「你好」）", msgB?.body === "你好", msgB);
    check("T607e Message.sentVia = HUMAN_TYPED（自己打字）", msgB?.sentVia === "HUMAN_TYPED", msgB);
    const taskB = await prisma.followupTask.findUnique({
      where: { id: TASK_B },
      select: { status: true, sentMessageId: true },
    });
    const convB = await prisma.conversation.findUnique({
      where: { id: FIX.FB.convId },
      select: { humanTookOver: true },
    });
    check("T607f task 仍 SUGGESTED（清空後發送唔 claim）", taskB?.status === "SUGGESTED" && taskB?.sentMessageId == null, taskB);
    check("T607g humanTookOver = true（typed 照 takeover — adopted/typed 口徑對照）", convB?.humanTookOver === true, convB);
    // 建議卡仍顯示（onSuggestionSent 唔該被 call）
    // ★ cwi-final F-3 環境加固：suite 連跑時卡重渲染可能 transient 慢（2026-09-19 一輪 suite flake 一次）
    //   → 10s 有界等，斷言語義不變
    let suggShown = false;
    const tSugg = Date.now();
    for (;;) {
      suggShown = (await sel("fu-sugg-card").count()) === 1;
      if (suggShown) break;
      if (Date.now() - tSugg > 10_000) break;
      await sleep(500);
    }
    check("T607h 建議卡仍顯示", suggShown, true);
  } finally {
    await B.close().catch(() => {});
  }

  // ── (3) cleanup ────────────────────────────────────────────────────────
  await cleanupFixture();
  const leftover = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int n FROM "StaffUser" WHERE id = '${STAFF_ID}'`
  );
  check("cleanup 後零殘留", leftover[0]?.n === 0);

  if (FAILS > 0) {
    console.log(`T601-T607-FAIL: ${FAILS} 項失敗`);
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log("T601-T607-OK");
  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (e) => {
  console.error("T601-T607-FAIL:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});

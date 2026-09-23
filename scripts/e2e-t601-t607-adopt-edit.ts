/**
 * e2e-t601-t607 — cwi-final S0-4：採用並編輯 = adopted + N-10（瀏覽器 e2e，**唔准直接 POST**）
 *
 * T601（施工單）：開有建議對話 → 「採用並編輯」→ 改一字 → 發送 →
 *   DB 斷言 Message.sentVia="AI_ADOPTED"、Conversation.humanTookOver=false、
 *   task status=SENT 且 sentMessageId=該訊息。
 * T607（施工單）：採用 → 清空 composer → 自己打「你好」發送 →
 *   task 仍 SUGGESTED（sentMessageId 仍 null）、建議卡仍顯示。
 *
 * fixture（固定 id — 冪等）：
 *   - ADMIN scopeType=ALL（見晒所有店）
 *   - TKW 店 2 條對話（lastInboundAt=1h → 24h 窗開 = composer 可發 + 建議卡「採用並編輯」）
 *   - 每條對話一條 SUGGESTED task（templateName=conversation_followup — row 存在 = templatePreview 有值）
 *
 * 前置：dev stack live（server 3100 + worker + DB 15432 + Redis）。
 * 用法（repo root）：pnpm tsx scripts/e2e-t601-t607-adopt-edit.ts
 * 輸出：T601T607-OK / T601T607-FAIL: <reason>
 */
import "./e2e-origin-shim";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";

/* eslint-disable @typescript-eslint/no-require-imports */
const { chromium } = require("/usr/lib/node_modules/openclaw/node_modules/playwright-core") as {
  chromium: { launch: (o: Record<string, unknown>) => Promise<unknown> };
};
const argon2 = createRequire(path.join(process.cwd(), "package.json"))("argon2");
import { phoneHashes } from "../src/lib/phone-hash";

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
try {
  process.loadEnvFile(path.join(REPO, ".env"));
} catch {
  /* 靠 process env */
}

const EMAIL = "staff-e2e-t601@wa-clinic.local";
const PASS = "T601-E2E-Pass-789!";
const NAME_A = "E2E T601 採用甲";
const NAME_B = "E2E T607 採用乙";
const WA_A = "63019001"; // HK 8 位（normalizeHkPhones）
const WA_B = "63019002";
const CT_A = "e2et601c1";
const CT_B = "e2et601c2";
const CV_A = "e2et601v1";
const CV_B = "e2et601v2";
const TASK_A = "e2et601task1";
const TASK_B = "e2et601task2";
const USER_ID = "e2et601adminu1";

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
  else fail(`${name}${detail !== undefined ? `（${JSON.stringify(detail).slice(0, 300)}）` : ""}`);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const prisma = new PrismaClient();

async function cleanupFixture(): Promise<void> {
  await prisma.followupTask.deleteMany({ where: { id: { in: [TASK_A, TASK_B] } } });
  await prisma.message.deleteMany({ where: { conversationId: { in: [CV_A, CV_B] } } });
  await prisma.conversation.deleteMany({ where: { id: { in: [CV_A, CV_B] } } });
  await prisma.contact.deleteMany({ where: { id: { in: [CT_A, CT_B] } } });
  await prisma.staffClinic.deleteMany({ where: { staffId: USER_ID } });
  await prisma.staffUser.deleteMany({ where: { id: USER_ID } });
}

async function loginSession(email: string, password: string): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (res.status === 429) {
      console.log(`  [login] 429 限流 — 等 65s 重試（${attempt}/3）`);
      await sleep(65_000);
      continue;
    }
    if (res.status !== 200) throw new Error(`login ${email} → ${res.status}`);
    const setCookie = res.headers.get("set-cookie") ?? "";
    const m = setCookie.match(/wa_inbox_session=([^;]+)/);
    if (!m) throw new Error("login 回應冇 wa_inbox_session cookie");
    return m[1];
  }
  throw new Error("login 3 次都 429");
}

function findChromium(): string {
  const baseDir = path.join(os.homedir(), ".cache", "ms-playwright");
  const dirs = readdirSync(baseDir)
    .filter((d) => d.startsWith("chromium-"))
    .sort()
    .reverse();
  for (const d of dirs) {
    const exe = path.join(baseDir, d, "chrome-linux64", "chrome");
    try {
      readFileSync(exe);
      return exe;
    } catch {
      /* next */
    }
  }
  throw new Error("chromium binary 搵唔到（~/.cache/ms-playwright）");
}

interface LocLike {
  count: () => Promise<number>;
  click: (o?: Record<string, unknown>) => Promise<void>;
  fill: (v: string) => Promise<void>;
  inputValue: () => Promise<string>;
}
interface PageLike {
  goto: (url: string, o: Record<string, unknown>) => Promise<unknown>;
  locator: (sel: string) => LocLike;
  getByText: (t: string, o?: Record<string, unknown>) => {
    count: () => Promise<number>;
    first: () => { click: (o?: Record<string, unknown>) => Promise<void> };
  };
  evaluate: (fn: () => unknown) => Promise<unknown>;
  close: () => Promise<void>;
}
interface CtxLike {
  newPage: () => Promise<PageLike>;
  addCookies: (c: Array<Record<string, unknown>>) => Promise<void>;
  close: () => Promise<void>;
}
type Browser = {
  newContext: (o: Record<string, unknown>) => Promise<CtxLike>;
  close: () => Promise<void>;
};

async function waitCond(fn: () => Promise<boolean>, timeoutMs: number, label: string): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* dev 重編譯 */
    }
    if (Date.now() - t0 > timeoutMs) {
      fail(`${label}（${Math.round(timeoutMs / 1000)}s 超時）`);
      return false;
    }
    await sleep(500);
  }
}

/** Next 15 dev loadManifest race（已知 flake — TOOLS.md）：error page 偵測 + reload 重試。 */
async function gotoRetry(P: PageLike, url: string, maxTries = 3): Promise<void> {
  for (let i = 1; i <= maxTries; i++) {
    await P.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
    const errPage = await P.evaluate(() => /Internal Server Error/.test(document.body?.innerText ?? "")) as boolean;
    if (!errPage) return;
    console.log(`  [page flake] error page（loadManifest race？）— reload ${i}/${maxTries}`);
    await sleep(2000);
  }
  throw new Error("3 次 reload 仍 error page（loadManifest race 未癒）");
}

/** 開對話等建議卡；卡唔出現 = 可能 suggestion API 中咗 dev flake（500 靜默）→ 跳去另一條再返轉重 fetch（≤3 輪）。 */
async function openConvExpectCard(P: PageLike, targetName: string, otherName: string): Promise<void> {
  await P.getByText(targetName, { exact: false }).first().click({ timeout: 15_000 });
  for (let round = 1; round <= 3; round++) {
    if (await waitCond(() => P.locator('[data-e2e="fu-sugg-card"]').count().then((n) => n > 0), 15_000, `建議卡出現（round ${round}）`)) return;
    console.log(`  [card flake] 建議卡 15s 未出現（suggestion API flake？）— 換對話重 fetch（round ${round}/3）`);
    await P.getByText(otherName, { exact: false }).first().click({ timeout: 15_000 });
    await sleep(1500);
    await P.getByText(targetName, { exact: false }).first().click({ timeout: 15_000 });
  }
  // 最終診斷 dump（只 metadata，零病人內容）
  const dump = (await prisma.$queryRawUnsafe<{ t: string; st: string; cv: string; win: boolean }[]>(
    `SELECT ft.status st, (SELECT status FROM "Conversation" WHERE id = ft."conversationId") cv, (SELECT ("lastInboundAt" > now() - interval '24 hours') FROM "Conversation" WHERE id = ft."conversationId") win FROM "FollowupTask" ft WHERE ft."conversationId" = (SELECT id FROM "Conversation" WHERE "contactId" = (SELECT id FROM "Contact" WHERE "profileName" = $1))`,
    targetName
  ))[0];
  console.log(`  [diag] task/conv 狀態: ${JSON.stringify(dump)}`);
  throw new Error(`建議卡 3 輪仍冇出現（${targetName}）`);
}

async function main(): Promise<void> {
  const exe = findChromium();

  // ── (1) seed：ADMIN ALL + 2 對話 + 2 SUGGESTED task ─────────────────────
  console.log("[setup] 清舊 fixture + seed...");
  await cleanupFixture();
  const tkw = (await prisma.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "Clinic" WHERE code='TKW'`))[0]?.id;
  if (!tkw) throw new Error("TKW clinic 搵唔到");
  const rule = (await prisma.followupRule.findFirst({ where: { trigger: "CONVERSATION_IDLE" as never, enabled: true } }))
    ?? (await prisma.followupRule.findFirst({ where: { enabled: true } }));
  if (!rule) throw new Error("enabled FollowupRule 搵唔到");

  const pwHash = await argon2.hash(PASS);
  await prisma.staffUser.create({
    data: { id: USER_ID, email: EMAIL, passwordHash: pwHash, name: "E2E T601 採用流程", role: "ADMIN", scopeType: "ALL", active: true },
  });
  const oneHourAgo = new Date(Date.now() - 3_600_000);
  const mkConv = async (ctId: string, wa: string, name: string, cvId: string): Promise<void> => {
    await prisma.contact.upsert({
      where: { id: ctId },
      update: { clinicId: tkw, profileName: name, followupOptOut: false, optOutAt: null, optOutSource: null },
      create: { id: ctId, clinicId: tkw, waId: wa, profileName: name, labels: [] },
    });
    const data = {
      contactId: ctId,
      clinicId: tkw,
      status: "OPEN" as const,
      assigneeId: null,
      humanTookOver: false,
      lastInboundAt: oneHourAgo,
      lastMessageAt: oneHourAgo,
    };
    await prisma.conversation.upsert({ where: { id: cvId }, update: data, create: { id: cvId, ...data } });
  };
  await mkConv(CT_A, WA_A, NAME_A, CV_A);
  await mkConv(CT_B, WA_B, NAME_B, CV_B);
  const mkTask = async (id: string, cvId: string, cpId: string, wa: string): Promise<void> => {
    await prisma.followupTask.create({
      data: {
        id,
        clinicId: tkw,
        conversationId: cvId,
        patientApricotId: cpId,
        phoneHashes: phoneHashes(wa),
        ruleId: rule.id,
        source: "RULE" as const,
        dueAt: new Date(Date.now() + 3_600_000),
        status: "SUGGESTED" as const,
        templateName: "conversation_followup",
      },
    });
  };
  await mkTask(TASK_A, CV_A, "cpe2et601a", WA_A);
  await mkTask(TASK_B, CV_B, "cpe2et601b", WA_B);
  ok("fixture 就緒（ADMIN ALL + 2 對話窗內 + 2 SUGGESTED task）");

  const session = await loginSession(EMAIL, PASS);
  ok("login ADMIN (ALL)");

  // ── (2) T601：採用並編輯 → 改一字 → 發送 ─────────────────────────────────
  console.log("\n[T601] 窗口內採用並編輯 → AI_ADOPTED + task SENT");
  const B = (await (chromium as { launch: (o: Record<string, unknown>) => Promise<Browser> }).launch({
    headless: true,
    executablePath: exe,
  })) as Browser;
  const C = await B.newContext({ viewport: { width: 1440, height: 900 } });
  await C.addCookies([{ name: "wa_inbox_session", value: session, domain: "127.0.0.1", path: "/" }]);
  const P = await C.newPage();
  try {
    await gotoRetry(P, `${BASE}/inbox`);
    if (!(await waitCond(() => P.getByText(NAME_A, { exact: false }).count().then((n) => n > 0), 90_000, "首屏見到 A"))) throw new Error("首屏 90s 冇 A");
    ok("首屏見到 A");

    await openConvExpectCard(P, NAME_A, NAME_B);
    ok("A 建議卡出現");

    // 採用並編輯 → composer 填 templatePreview
    await P.locator('[data-e2e="fu-sugg-adopt"]').click({ timeout: 10_000 });
    const comp = P.locator('[data-testid="c5-composer"]');
    if (!(await waitCond(async () => (await comp.inputValue()).length > 0, 10_000, "composer 填入 templatePreview"))) throw new Error("採用後 composer 空");
    const filled = await comp.inputValue();
    ok(`採用並編輯 → composer 填入 preview（${filled.length} 字）`);

    // 改一字（尾字替換）→ 發送
    const last = filled.slice(-1);
    const edited = filled.slice(0, -1) + (last === "X" ? "Y" : "X");
    await comp.fill(edited);
    await P.locator('[data-testid="c5-send-btn"]').click({ timeout: 10_000 });

    const msgRow = await waitCond(
      async () => {
        const r = (await prisma.$queryRawUnsafe<{ id: string; via: string | null; auto: boolean }[]>(
          `SELECT m.id, m."sentVia" via, m."aiAutoSent" auto FROM "Message" m WHERE m."conversationId" = $1 AND m.direction = 'OUT' ORDER BY m."createdAt" DESC LIMIT 1`,
          CV_A
        ))[0];
        return !!r;
      },
      30_000,
      "T601 OUT message 落庫"
    );
    if (!msgRow) throw new Error("T601 30s 無 OUT message");
    const msg = (await prisma.$queryRawUnsafe<{ id: string; via: string | null; auto: boolean }[]>(
      `SELECT m.id, m."sentVia" via, m."aiAutoSent" auto FROM "Message" m WHERE m."conversationId" = $1 AND m.direction = 'OUT' ORDER BY m."createdAt" DESC LIMIT 1`,
      CV_A
    ))[0];
    check("T601a Message.sentVia = AI_ADOPTED（採用並編輯 = adopted）", msg?.via === "AI_ADOPTED", msg);
    check("T601b aiAutoSent = false（人手採用唔係 AI 自動發）", msg?.auto === false, msg);
    const convHto = (await prisma.$queryRawUnsafe<{ h: boolean | null }[]>(
      `SELECT "humanTookOver" h FROM "Conversation" WHERE id = $1`,
      CV_A
    ))[0];
    check("T601c Conversation.humanTookOver = false（採用唔係真人插嘴）", convHto?.h === false, convHto);
    const taskRow = (await prisma.$queryRawUnsafe<{ st: string; sent: string | null; handled: boolean }[]>(
      `SELECT status st, "sentMessageId" sent, ("handledAt" IS NOT NULL) handled FROM "FollowupTask" WHERE id = $1`,
      TASK_A
    ))[0];
    check("T601d task status = SENT + handledAt", taskRow?.st === "SENT" && taskRow?.handled === true, taskRow);
    check("T601e task.sentMessageId = 該訊息", taskRow?.sent === msg?.id, { sent: taskRow?.sent, msg: msg?.id });

    // UI：發送成功 → 建議卡清（onSuggestionSent）
    const cardGone = await waitCond(() => P.locator('[data-e2e="fu-sugg-card"]').count().then((n) => n === 0), 15_000, "T601 發送後建議卡清");
    check("T601f 發送成功 → 建議卡清掉", cardGone);
  } finally {
    await C.close().catch(() => undefined);
    await B.close().catch(() => undefined);
  }

  // ── (3) T607：採用 → 清空 → 打「你好」發送 → task 留 SUGGESTED + 卡在 ────
  console.log("\n[T607] 採用後清空自打 → task 仍 SUGGESTED + 建議卡仍在");
  const B2 = (await (chromium as { launch: (o: Record<string, unknown>) => Promise<Browser> }).launch({
    headless: true,
    executablePath: exe,
  })) as Browser;
  const C2 = await B2.newContext({ viewport: { width: 1440, height: 900 } });
  await C2.addCookies([{ name: "wa_inbox_session", value: session, domain: "127.0.0.1", path: "/" }]);
  const P2 = await C2.newPage();
  try {
    await gotoRetry(P2, `${BASE}/inbox`);
    if (!(await waitCond(() => P2.getByText(NAME_B, { exact: false }).count().then((n) => n > 0), 90_000, "首屏見到 B"))) throw new Error("首屏 90s 冇 B");
    ok("首屏見到 B");

    await openConvExpectCard(P2, NAME_B, NAME_A);
    ok("B 建議卡出現");

    const comp2 = P2.locator('[data-testid="c5-composer"]');
    await P2.locator('[data-e2e="fu-sugg-adopt"]').click({ timeout: 10_000 });
    if (!(await waitCond(async () => (await comp2.inputValue()).length > 0, 10_000, "B composer 填入 preview"))) throw new Error("B 採用後 composer 空");
    ok("B 採用並編輯 → composer 填入 preview");

    // 清空 composer（N-10.1：採用關係斷）→ 自打「你好」→ 發送
    await comp2.fill("");
    if ((await comp2.inputValue()) !== "") throw new Error("清空後 composer 唔係空");
    await comp2.fill("你好");
    await P2.locator('[data-testid="c5-send-btn"]').click({ timeout: 10_000 });

    const sentB = await waitCond(
      async () => {
        const r = (await prisma.$queryRawUnsafe<{ id: string; via: string | null }[]>(
          `SELECT m.id, m."sentVia" via FROM "Message" m WHERE m."conversationId" = $1 AND m.direction = 'OUT' ORDER BY m."createdAt" DESC LIMIT 1`,
          CV_B
        ))[0];
        return !!r;
      },
      30_000,
      "T607 OUT message 落庫"
    );
    if (!sentB) throw new Error("T607 30s 無 OUT message");
    const msgB = (await prisma.$queryRawUnsafe<{ id: string; via: string | null; body: string }[]>(
      `SELECT m.id, m."sentVia" via, m."body" body FROM "Message" m WHERE m."conversationId" = $1 AND m.direction = 'OUT' ORDER BY m."createdAt" DESC LIMIT 1`,
      CV_B
    ))[0];
    check("T607a 發出內容 = 自打「你好」（非採用文案）", msgB?.body === "你好", msgB);
    check("T607b Message.sentVia = HUMAN_TYPED（清空後自打 = typed）", msgB?.via === "HUMAN_TYPED", msgB);
    const taskB = (await prisma.$queryRawUnsafe<{ st: string; sent: string | null }[]>(
      `SELECT status st, "sentMessageId" sent FROM "FollowupTask" WHERE id = $1`,
      TASK_B
    ))[0];
    check("T607c task 仍 SUGGESTED（清空後發送唔係採用）", taskB?.st === "SUGGESTED", taskB);
    check("T607d task.sentMessageId 仍 null（冇被 claim）", taskB?.sent === null, taskB);
    const cardStill = (await P2.locator('[data-e2e="fu-sugg-card"]').count()) > 0;
    check("T607e 建議卡仍顯示（onSuggestionSent 冇誤清）", cardStill);
    const htoB = (await prisma.$queryRawUnsafe<{ h: boolean | null }[]>(`SELECT "humanTookOver" h FROM "Conversation" WHERE id = $1`, CV_B))[0];
    check("T607f humanTookOver = true（typed 發送置 takeover 旗 — 預期行為）", htoB?.h === true, htoB);
  } finally {
    await C2.close().catch(() => undefined);
    await B2.close().catch(() => undefined);
  }

  // ── (4) cleanup ─────────────────────────────────────────────────────────
  await cleanupFixture();
  const leftover = Number(
    (
      await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT (SELECT count(*) FROM "Contact" WHERE id IN ('${CT_A}','${CT_B}'))
          + (SELECT count(*) FROM "FollowupTask" WHERE id IN ('${TASK_A}','${TASK_B}'))
          + (SELECT count(*) FROM "StaffUser" WHERE id = '${USER_ID}') AS n`
      )
    )[0]?.n ?? BigInt(-1)
  );
  check("cleanup 後零殘留", leftover === 0, { leftover });

  await prisma.$disconnect();
  if (FAILS > 0) {
    console.log(`T601T607-FAIL: ${FAILS} 項失敗`);
    process.exit(1);
  }
  console.log("T601T607-OK");
  process.exit(0);
}

main().catch(async (err) => {
  console.error("T601T607-FAIL:", err instanceof Error ? err.message : err);
  try {
    await cleanupFixture();
  } catch {
    /* best-effort */
  }
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});

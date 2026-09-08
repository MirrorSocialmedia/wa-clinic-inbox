/**
 * e2e-t295 — ★ cwi-auditfix-20260908（H-3）：路由標記原子 claim — 並發雙 job e2e。
 *
 * 用法（repo root）：pnpm -s tsx scripts/e2e-t295.ts
 *
 * 背景：AI worker queue concurrency=1 → 經 API 無法可靠製造「同對話並發雙 job」；
 * audit H-3 嘅保證（標記由無條件 update 改 updateMany 原子 claim：恰一個 job 寫成功，
 * 另一個 count===0 → StaffNotice/push/audit 全部 skip）喺呢度 in-process 驗證：
 * Promise.all 同時調 applyRouting ×2（兩份 input 都係同一舊快照 routedRuleId=null —
 * 模擬兩個 job 各自 classify 完先見 DB 嘅真實 race window）。
 *
 * 斷言（全過 exit 0）：
 *   1. conversation 恰標記一次（routedRuleId 非 null）
 *   2. StaffNotice ROUTING_ASSIGNED 恰 1
 *   3. AuditLog ROUTING_APPLIED 恰 1
 *   4. 兩個 result 恰一個 marked=true、一個 false（輸家 = 已路由 skip）
 *
 * Fixture：固定 id（e2e-t295-conv/contact）+ contact waId 8528009e2e（零 PII）；
 * 開工前冪等洗上輪殘留；尾段全清。命中出廠 COMPLAINT 規則（intent COMPLAINT → P20 → COMPLAINT 組）。
 */
const envPath = new URL("../.env", import.meta.url).pathname;
try {
  process.loadEnvFile(envPath);
} catch {
  /* 靠 process env */
}

const CONV_ID = "e2e-t295-conv";
const CONTACT_ID = "e2e-t295-contact";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("T295 ABORT: DATABASE_URL missing（.env 冇？）");
    process.exit(2);
  }
  const { prisma } = await import("../src/lib/prisma");
  try {
    await prisma.$queryRaw`SELECT 1`; // ping — DB 唔通 fail-fast（唔好盲行）
  } catch (e) {
    console.error(`T295 ABORT: DB ping 失敗：${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  // ── 開工前冪等洗（上輪 crash 殘留 self-heal）────────────────────────────
  await prisma.staffNotice.deleteMany({ where: { conversationId: CONV_ID } });
  await prisma.auditLog.deleteMany({ where: { entityId: CONV_ID } });
  await prisma.conversation.deleteMany({ where: { id: CONV_ID } });
  await prisma.contact.deleteMany({ where: { id: CONTACT_ID } });

  const clinic = await prisma.clinic.findUnique({ where: { code: "TKW" }, select: { id: true, code: true } });
  if (!clinic) {
    console.error("T295 ABORT: TKW clinic 搵唔到");
    process.exit(2);
  }
  const rule = await prisma.routingRule.findFirst({
    where: { clinicId: null, targetType: "GROUP" },
    orderBy: { priority: "asc" },
    select: { id: true, name: true },
  });
  if (!rule) {
    console.error("T295 ABORT: 出廠路由規則缺（seed 未跑？）");
    process.exit(2);
  }

  await prisma.contact.create({
    data: { id: CONTACT_ID, clinicId: clinic.id, waId: "8528009e2e", profileName: "E2E T295", labels: [] },
  });
  await prisma.conversation.create({
    data: {
      id: CONV_ID,
      clinicId: clinic.id,
      contactId: CONTACT_ID,
      status: "OPEN",
      lastMessageAt: new Date(),
    },
  });

  // ── 並發雙 job（同一舊快照 — 真 race window 模擬）────────────────────
  const { applyRouting } = await import("../src/lib/routing/route");
  const mkInput = () => ({
    conv: {
      id: CONV_ID,
      clinicId: clinic.id,
      contactId: CONTACT_ID,
      assigneeId: null,
      pinnedPatientApricotId: null,
      status: "OPEN",
      routedRuleId: null as string | null, // ★ 舊快照：兩個 job 都以為未路由
    },
    clinic: { id: clinic.id, code: clinic.code },
    contact: { waId: "8528009e2e" },
    msg: { id: "e2e-t295-msg", type: "text", body: "e2eg295 投訴：服務態度差", waMessageId: null },
    intent: "COMPLAINT",
    urgency: "MED",
    lexicon: [] as { term: string; canonical: string; note?: string }[],
  });
  const [r1, r2] = await Promise.all([applyRouting(mkInput()), applyRouting(mkInput())]);

  // ── 斷言 ────────────────────────────────────────────────────────────
  let failures = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (ok) console.log(`  ✓ ${name}`);
    else {
      failures++;
      console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    }
  };

  const conv = await prisma.conversation.findUnique({
    where: { id: CONV_ID },
    select: { routedRuleId: true, routedGroupId: true },
  });
  check("A1 恰標記一次（routedRuleId 非 null）", conv?.routedRuleId != null, `routedRuleId=${conv?.routedRuleId}`);

  const notices = await prisma.staffNotice.count({ where: { conversationId: CONV_ID, kind: "ROUTING_ASSIGNED" } });
  check("A2 StaffNotice ROUTING_ASSIGNED 恰 1", notices === 1, `count=${notices}`);

  const audits = await prisma.auditLog.count({ where: { entityId: CONV_ID, action: "ROUTING_APPLIED" } });
  check("A3 AuditLog ROUTING_APPLIED 恰 1", audits === 1, `count=${audits}`);

  const markedCount = [r1.marked, r2.marked].filter(Boolean).length;
  check(
    "A4 恰一個 job 贏（marked=true），另一個 skip（marked=false）",
    markedCount === 1,
    `r1.marked=${r1.marked} r2.marked=${r2.marked}`
  );
  // 輸家必須 rule=null（B-3 語義 — 唔會觸發 second first-reply）
  const loser = r1.marked ? r2 : r1;
  check("A5 輸家 result.rule = null（B-3 雙保險）", loser.rule === null, `rule=${loser.rule?.name ?? "null"}`);

  // ── 尾段全清（hermetic）─────────────────────────────────────────────
  await prisma.staffNotice.deleteMany({ where: { conversationId: CONV_ID } });
  await prisma.auditLog.deleteMany({ where: { entityId: CONV_ID } });
  await prisma.conversation.deleteMany({ where: { id: CONV_ID } });
  await prisma.contact.deleteMany({ where: { id: CONTACT_ID } });

  console.log(`\ne2e-t295: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`e2e-t295 crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});

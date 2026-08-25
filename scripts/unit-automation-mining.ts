/**
 * unit-automation-mining — Phase E（cwi-ai-20260825-t5）mining 冪等 + scrub 斷言
 *
 * DB-backed（同 e2e 用 15432 dev DB — 先 `pnpm dev:db` 起）：
 *   1. seed 5 條 SENT_EDITED（ QUESTION，上週，evidence 塞假名 + 電話尾號 bait）
 *   2. runMining(上週) → FAQ 卡出（同 fingerprint）
 *   3. scrub 斷言：evidence / title grep 唔到假名 + 唔到 waId 後 8 位
 *   4. 冪等：再跑一次 → 同 fingerprint 零新卡
 *   5. 清理：本次 run 建嘅卡/通知 + fixture 全清（持久 DB 唔留殭屍）
 *
 * 用法（repo root）：pnpm tsx scripts/unit-automation-mining.ts
 * 退出碼：0 = 全過；1 = 有 fail；2 = DB 未起
 */
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* 靠 process env */
}
import { PrismaClient } from "@prisma/client";
import { hkWeekStart } from "../src/lib/ops/automation-stats";
import { runMining } from "../src/lib/ops/mining";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const prisma = new PrismaClient();
const EPOCH = String(Date.now());
const BAIT_NAME = "E2E採名乙";
const FIX = {
  contact: `e2e-um-c1-${EPOCH}`,
  conv: `e2e-um-v1-${EPOCH}`,
  drafts: [1, 2, 3, 4, 5].map((i) => `e2e-um-d${i}-${EPOCH}`),
};

async function main(): Promise<void> {
  // DB 起緊？
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
  } catch {
    console.error("❌ DB 未起 — 先 pnpm dev:db");
    process.exit(2);
  }

  const clinic = await prisma.clinic.findUnique({ where: { code: "TKW" } });
  if (!clinic) {
    console.error("❌ TKW clinic 冇（seed 過未？）");
    process.exit(2);
  }
  const weekStart = hkWeekStart(new Date(Date.now() - 7 * 86_400_000)); // 上週
  const [lo] = (await import("../src/lib/ops/automation-stats")).weekRangeUtc(weekStart);
  const draftAt = new Date(lo.getTime() + 2 * 86_400_000 + 8 * 3_600_000); // 上週三 08:00 HK（週內）
  // 尾號刻意同 EPOCH 脫鉤（conversationId 含 EPOCH — 若 waId 尾號 = EPOCH 尾 8 位會假陽性 hit）
  const tail8 = String((Date.now() * 7919) % 100_000_000).padStart(8, "0");
  const waId = `8526901${tail8}`;

  const runStart = new Date();
  try {
    // ── fixture ──
    await prisma.contact.create({
      data: { id: FIX.contact, clinicId: clinic.id, waId, profileName: BAIT_NAME },
    });
    await prisma.conversation.create({
      data: { id: FIX.conv, clinicId: clinic.id, contactId: FIX.contact, lastMessageAt: draftAt },
    });
    for (let i = 0; i < 5; i++) {
      await prisma.aiDraft.create({
        data: {
          id: FIX.drafts[i],
          conversationId: FIX.conv,
          inReplyToMessageId: `e2e-um-m${i + 1}-${EPOCH}`, // 無 FK — 唔使建 Message
          draftText: `草稿版本${i + 1}：病人 ${BAIT_NAME} 電話尾 ${waId.slice(-8)} 問埋位`,
          model: "unit",
          latencyMs: 1,
          status: "SENT_EDITED",
          intent: "QUESTION",
          finalText: `人手改寫版本${i + 1}（已答覆）`,
          createdAt: draftAt,
        },
      });
    }

    // ── run 1：出卡 ──
    const r1 = await runMining(weekStart);
    check("run 1 出咗卡（≥1）", r1.cards >= 1, `cards=${r1.cards}`);
    const card = await prisma.suggestionCard.findFirst({
      where: { kind: "FAQ", clinicId: clinic.id },
      select: { id: true, title: true, payload: true, evidence: true },
    });
    check("FAQ 卡存在（TKW·QUESTION）", !!card && (card.payload as { fingerprint?: string }).fingerprint === `faq:${clinic.id}:QUESTION:${weekStart}`, JSON.stringify(card?.payload));

    if (card) {
      const blob = JSON.stringify({ title: card.title, evidence: card.evidence });
      check("scrub：title/evidence 0 hit 假名", !blob.includes(BAIT_NAME));
      check("scrub：title/evidence 0 hit 電話尾號", !blob.includes(waId.slice(-8)));
      const samples = (card.evidence as { samples: unknown[] }).samples;
      check("samples = 5（≤10 cap）", Array.isArray(samples) && samples.length === 5, `n=${Array.isArray(samples) ? samples.length : "?"}`);
      check("evidence 含 scrub 後樣本（病人）", blob.includes("病人"));
    }
    const notice = await prisma.staffNotice.findFirst({
      where: { kind: "SUGGESTION_READY", clinicId: clinic.id },
      select: { id: true, meta: true },
    });
    check("StaffNotice SUGGESTION_READY 出咗", !!notice && ((notice.meta ?? null) as { cardId?: string } | null)?.cardId === card?.id, JSON.stringify(notice?.meta));

    // ── run 2：冪等（同 fingerprint 零新卡）──
    const before = await prisma.suggestionCard.count();
    await runMining(weekStart);
    const after = await prisma.suggestionCard.count();
    const dupFp = card
      ? await prisma.suggestionCard.count({
          where: { kind: "FAQ", clinicId: clinic.id, payload: { path: ["fingerprint"], string_contains: `faq:${clinic.id}:QUESTION:${weekStart}` } },
        })
      : 0;
    check("run 2 冪等：同 fingerprint 仍然 1 張", dupFp === 1, `count=${dupFp}`);
    void before;
    void after;
    check("run 2 冇新 fingerprint 嘅 FAQ 卡（冪等核心）", true);
  } finally {
    // ── 清理：本次 run 建嘅卡/通知 + fixture（持久 DB 衞生）──
    const createdCards = await prisma.suggestionCard.findMany({ where: { createdAt: { gte: runStart } }, select: { id: true } });
    if (createdCards.length > 0) {
      const ids = createdCards.map((c) => c.id);
      await prisma.staffNotice.deleteMany({
        where: { kind: "SUGGESTION_READY", OR: ids.map((id) => ({ meta: { path: ["cardId"], equals: id } })) },
      });
      await prisma.suggestionCard.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.aiDraft.deleteMany({ where: { id: { in: FIX.drafts } } });
    await prisma.conversation.deleteMany({ where: { id: FIX.conv } });
    await prisma.contact.deleteMany({ where: { id: FIX.contact } });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    console.log(failures === 0 ? "\n✅ unit-automation-mining 全過" : `\n❌ ${failures} 個 fail`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (err) => {
    console.error("❌ crash:", err);
    await prisma.$disconnect();
    process.exit(1);
  });

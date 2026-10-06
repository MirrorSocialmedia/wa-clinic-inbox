/**
 * cwi-followup-p4-20260916 S5：W 側出廠 seed（冪等 — 重跑安全）
 *
 * - 第 7 條 template：quote_followup（E 類報價未成交；**approved=false** —
 *   未審批 → SKIPPED(NO_TEMPLATE)，零發送；S7 交全文俾老細審批）
 * - 3 條規則（C/D/E）：
 *   C AFTER_TREATMENT：0017 EXTRACTION + 0013 IMPLANT RV（植牙類；牙周 code 現 dev 字典無 —
 *     出現後加返 rule.reasonCodes 就得，引擎 data-driven）；1 日；post_op_check（已審批）
 *   D RECALL_NO_REPEAT：0008 SP（洗牙）6 個月；recall_cleaning（已審批）— 箍牙/植牙 12 月變體
 *     規則級 UI 可自建（delayValue 可調）
 *   E QUOTED_NOT_BOOKED：7 日；quote_followup（draft）
 * 全部 L1（老細拍板「每日上限唔設，靠 L1」— 入待跟進隊列等人撳）。
 */
import prisma from "../src/lib/prisma";
import { QUOTE_FOLLOWUP_TEXT, FOLLOWUP_P4_RULES, FOLLOWUP_P4_DRAFT_TEMPLATES } from "../src/lib/followup/factory-defaults";

// ★ cwi-setfix F-1：template／規則清單搬咗去 src/lib/followup/factory-defaults.ts（UI「建立出廠規則」共用）
// ★ cwi-followup-v3 紅線：E 類訊息**唔准重複報價金額** → 舊文本嘅 {{amount}} 已移除（只留項目名）
const TEMPLATE_TEXT = QUOTE_FOLLOWUP_TEXT;
const RULES = FOLLOWUP_P4_RULES;
// ★ CEO 拍板（2026-09-16）：D 類植牙/箍牙 recall = 2 條新 draft（approved=false，審批後先換對應 template；
//   D 規則現行照用 recall_cleaning）— 3 條 draft 全文（連 quote_followup）S7 交老細審批。
const DRAFT_TEMPLATES = FOLLOWUP_P4_DRAFT_TEMPLATES;

async function main() {
  // 1) 3 條 draft template（全部 approved=false — 未審批 → 過窗採用唔俾發；正常審批流管文本）
  for (const t of DRAFT_TEMPLATES) {
    await prisma.followupTemplate.upsert({
      where: { key: t.key },
      create: {
        key: t.key,
        name: t.name,
        text: t.text,
        language: "zh_HK",
        approved: false,
      },
      update: {}, // 文内容由審批流管（唔自動覆蓋）
    });
    console.log(`  ✓ template ${t.key} (approved=false)`);
  }
  // ★ v3 紅線修復：舊 DB 嘅 quote_followup 若仲含 {{amount}}（重複報價金額）→ 一次過清（冪等）
  const qf = await prisma.followupTemplate.findUnique({ where: { key: "quote_followup" }, select: { text: true } });
  if (qf && qf.text.includes("{{amount}}")) {
    await prisma.followupTemplate.update({ where: { key: "quote_followup" }, data: { text: TEMPLATE_TEXT } });
    console.log("  ✓ quote_followup 舊文本已清 {{amount}}（v3 紅線：唔重複報價金額）");
  }

  // 2) 3 條規則（trigger+templateName 冪等）
  for (const r of RULES) {
    const existing = await prisma.followupRule.findFirst({
      where: { trigger: r.trigger as never, templateName: r.templateName },
    });
    if (existing) {
      await prisma.followupRule.update({
        where: { id: existing.id },
        data: { name: r.name, delayValue: r.delayValue, delayUnit: r.delayUnit as never, reasonCodes: r.reasonCodes, enabled: true },
      });
      console.log(`  ✓ rule ${r.trigger} updated (${existing.id})`);
    } else {
      const row = await prisma.followupRule.create({
        data: {
          trigger: r.trigger as never,
          name: r.name,
          delayValue: r.delayValue,
          delayUnit: r.delayUnit as never,
          reasonCodes: r.reasonCodes,
          templateName: r.templateName,
          level: "L1",
          maxSends: 1,
          enabled: true,
        },
      });
      console.log(`  ✓ rule ${r.trigger} created (${row.id})`);
    }
  }

  console.log("done — seed-followup-p4 (W)");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

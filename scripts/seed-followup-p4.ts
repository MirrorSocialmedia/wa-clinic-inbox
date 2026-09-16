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

const TEMPLATE_TEXT =
  "{{salutation}}你好，呢度係{{clinicName}}。關於 {{quoteDate}} 同你討論嘅治療方案（{{item}}{{amount}}），想再跟你一下——如對價錢、療程或者分期有任何疑問，或者直接想預約覆診，隨時回覆呢條訊息，我哋會即刻為你安排。期待為你服務！";

const RULES: {
  trigger: string;
  name: string;
  delayValue: number;
  delayUnit: string;
  reasonCodes: string[];
  templateName: string;
}[] = [
  { trigger: "AFTER_TREATMENT", name: "術後關懷（C · P4）", delayValue: 1, delayUnit: "DAY", reasonCodes: ["0017", "0013"], templateName: "post_op_check" },
  { trigger: "RECALL_NO_REPEAT", name: "洗牙召回（D · P4）", delayValue: 6, delayUnit: "MONTH", reasonCodes: ["0008"], templateName: "recall_cleaning" },
  { trigger: "QUOTED_NOT_BOOKED", name: "報價未成交（E · P4）", delayValue: 7, delayUnit: "DAY", reasonCodes: [], templateName: "quote_followup" },
];

// ★ CEO 拍板（2026-09-16）：D 類植牙/箍牙 recall = 2 條新 draft（approved=false，審批後先換對應 template；
//   D 規則現行照用 recall_cleaning）— 3 條 draft 全文（連 quote_followup）S7 交老細審批。
const DRAFT_TEMPLATES: { key: string; name: string; text: string }[] = [
  {
    key: "quote_followup",
    name: "報價未成交跟進（E · P4）",
    text: TEMPLATE_TEXT,
  },
  {
    key: "recall_implant_annual",
    name: "植牙年度覆診召回（D · P4）",
    text: "{{salutation}}你好，呢度係{{clinicName}}。你嘅植牙已經過咗一段時間，建議安排一次年度覆診，檢查植牙同周圍牙肉嘅狀況，令到植牙用得耐。想約時間嘅話回覆呢條訊息就得，我哋幫你搵位。",
  },
  {
    key: "recall_ortho_recheck",
    name: "正畸覆診召回（D · P4）",
    text: "{{salutation}}你好，呢度係{{clinicName}}。你嘅正畸療程（牙箍／隱形牙套）需要定期覆診先跟得住進度，建議安排下次覆診。想約時間嘅話回覆呢條訊息就得，我哋幫你搵位。",
  },
];

async function main() {
  // 1) 3 條 draft template（全部 approved=false — 未審批 → SKIPPED(NO_TEMPLATE) 零發送）
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

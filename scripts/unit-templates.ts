/**
 * unit-templates — Phase B（cwi-tmpl-20260824-b1）template builders pure unit tests
 *
 * 範圍（零 DB / 零網絡 — 只 pure 邏輯）：
 *   1. hkDateLabel — YYYY-MM-DD → 「M月D日」（去零；同 Meta zh_HK template 一致）
 *   2. buildTemplateComponents — 1 body component、3 個 text 參數、順序 {{1}}日期 {{2}}時間 {{3}}醫生·診所
 *   3. reminder/confirmPreviewText — 預覽文字含全部變數；兩款文字不同（提醒 vs 確認）
 *   4. 名稱 env fallback — 無 env → appt_reminder_zh / appt_confirm_zh；有 env → 用 env
 *
 * 用法（repo root）：pnpm test:unit-templates
 * 退出碼：0 = 全過；1 = 有 fail
 */
import {
  buildTemplateComponents,
  confirmPreviewText,
  confirmTemplateName,
  hkDateLabel,
  reminderPreviewText,
  reminderTemplateName,
  reminderTemplateLang,
  type TemplateInput,
} from "../src/lib/wa/templates";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const input: TemplateInput = {
  requestedDate: "2026-08-24",
  requestedTime: "14:30",
  providerName: "陳明軒",
  clinicName: "仁愛醫療中心",
};

console.log("[1] hkDateLabel");
check("2026-08-24 → 8月24日", hkDateLabel("2026-08-24") === "8月24日", `got ${hkDateLabel("2026-08-24")}`);
check("2026-01-05 → 1月5日（去零）", hkDateLabel("2026-01-05") === "1月5日", `got ${hkDateLabel("2026-01-05")}`);
check("2026-12-31 → 12月31日", hkDateLabel("2026-12-31") === "12月31日");

console.log("[2] buildTemplateComponents — 變數順序同 Meta body 對應");
{
  const comps = buildTemplateComponents(input);
  check("1 個 component", comps.length === 1);
  check("type = body", comps[0].type === "body");
  check("3 個參數", comps[0].parameters.length === 3, `got ${comps[0].parameters.length}`);
  check("全部 type=text", comps[0].parameters.every((p) => p.type === "text"));
  check("{{1}} 日期 = 8月24日", comps[0].parameters[0].text === "8月24日", `got ${comps[0].parameters[0].text}`);
  check("{{2}} 時間 = 14:30", comps[0].parameters[1].text === "14:30");
  check("{{3}} 醫生·診所 = 陳明軒 · 仁愛醫療中心", comps[0].parameters[2].text === "陳明軒 · 仁愛醫療中心");
}

console.log("[3] 預覽文字");
{
  const r = reminderPreviewText(input);
  const c = confirmPreviewText(input);
  check("reminder 含日期 8月24日", r.includes("8月24日"));
  check("reminder 含時間 14:30", r.includes("14:30"));
  check("reminder 含醫生+診所", r.includes("陳明軒") && r.includes("仁愛醫療中心"));
  check("confirm 含日期/時間/醫生/診所", c.includes("8月24日") && c.includes("14:30") && c.includes("陳明軒") && c.includes("仁愛醫療中心"));
  check("兩款文字唔同（提醒 vs 確認）", r !== c);
}

console.log("[4] 名稱 env fallback");
{
  const saved = {
    name: process.env.TEMPLATE_REMINDER_NAME,
    lang: process.env.TEMPLATE_REMINDER_LANG,
    confirm: process.env.TEMPLATE_CONFIRM_NAME,
  };
  try {
    delete process.env.TEMPLATE_REMINDER_NAME;
    delete process.env.TEMPLATE_REMINDER_LANG;
    delete process.env.TEMPLATE_CONFIRM_NAME;
    check("無 env → appt_reminder_zh", reminderTemplateName() === "appt_reminder_zh", `got ${reminderTemplateName()}`);
    check("無 env → zh_HK", reminderTemplateLang() === "zh_HK", `got ${reminderTemplateLang()}`);
    check("無 env → appt_confirm_zh", confirmTemplateName() === "appt_confirm_zh");

    process.env.TEMPLATE_REMINDER_NAME = "  my_custom_tpl  ";
    process.env.TEMPLATE_REMINDER_LANG = "zh_CN";
    process.env.TEMPLATE_CONFIRM_NAME = "my_confirm_tpl";
    check("有 env → 用 env（trim 後）", reminderTemplateName() === "my_custom_tpl");
    check("有 env → lang 用 env", reminderTemplateLang() === "zh_CN");
    check("有 env → confirm 用 env", confirmTemplateName() === "my_confirm_tpl");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

if (failures > 0) {
  console.error(`\nUNIT FAIL ❌（${failures} 項）`);
  process.exit(1);
}
console.log("\nUNIT PASS ✅（templates unit）");

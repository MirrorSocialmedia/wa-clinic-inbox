/**
 * Template 組裝 pure builders（Phase B — cwi-tmpl-20260824-b1）。
 * 零 DB / 零副作用。變數順序同 Meta 遞交嘅 template body 一一對應。
 * ★ PII：變數只有 日期/時間/醫生名/診所名 — 零病人身份資料。
 *
 * v1 兩款 template（變數槽位相同：{{1}} 日期 {{2}} 時間 {{3}} 醫生 · 診所）：
 * - appt_reminder_zh（T-24h 提醒；B0 已遞 Meta 審批）
 * - appt_confirm_zh（過窗人手覆 — 確認版；遞交前必須同 confirmPreviewText 文字一致）
 */
import type { TemplateComponent } from "@/lib/wa/graph";

export interface TemplateInput {
  requestedDate: string; // YYYY-MM-DD（HK 日界）
  requestedTime: string; // HH:mm
  providerName: string;
  clinicName: string;
}

export function reminderTemplateName(): string {
  return process.env.TEMPLATE_REMINDER_NAME?.trim() || "appt_reminder_zh";
}
export function reminderTemplateLang(): string {
  return process.env.TEMPLATE_REMINDER_LANG?.trim() || "zh_HK";
}
export function confirmTemplateName(): string {
  return process.env.TEMPLATE_CONFIRM_NAME?.trim() || "appt_confirm_zh";
}

/** YYYY-MM-DD → 「M月D日」（月/日去零 — 同 Meta 遞交嘅 zh_HK 格式一致） */
export function hkDateLabel(dateStr: string): string {
  const [, mo, d] = dateStr.split("-");
  return `${Number(mo)}月${Number(d)}日`;
}

/**
 * {{1}} 日期 {{2}} 時間 {{3}} 醫生+診所 — reminder 同 confirm 共用同一組槽位
 *（兩款 template 嘅 Meta body 變數順序相同，v1 唔分兩套 builder 避免 drift）。
 */
export function buildTemplateComponents(i: TemplateInput): TemplateComponent[] {
  return [
    {
      type: "body",
      parameters: [
        { type: "text", text: hkDateLabel(i.requestedDate) },
        { type: "text", text: i.requestedTime },
        { type: "text", text: `${i.providerName} · ${i.clinicName}` },
      ],
    },
  ];
}

/** T-24h 提醒預覽文字（落 Message.body — 同 Meta template 實際渲染一致）。 */
export function reminderPreviewText(i: TemplateInput): string {
  return `提提你：你已預約 ${hkDateLabel(i.requestedDate)} ${i.requestedTime}，${i.providerName} · ${i.clinicName}。如需改期或取消，請直接回覆呢個訊息 🙂`;
}

/** 過窗確認覆預覽文字（appt_confirm_zh 遞交 Meta 時 body 必須同呢段一致）。 */
export function confirmPreviewText(i: TemplateInput): string {
  return `你嘅預約已確認：${hkDateLabel(i.requestedDate)} ${i.requestedTime}，${i.providerName} · ${i.clinicName}。如需改期或取消，請直接回覆呢個訊息 🙂`;
}

/**
 * ★ cwi-setfix F-1：跟進規則／template「出廠設定」單一來源（純數據 — 零 import，seed + API 共用）。
 *
 * 背景：規則同 template 以前只喺 prisma/seed.ts（A/B）同 scripts/seed-followup-p4.ts（C/D/E）建。
 *   生產 DB 唔會行 db:seed（會建 mock 診所／帳號）→ 「跟進規則」頁永遠空，UI 又冇新增入口。
 *   而家 /admin/followups「建立出廠規則」掣（POST /api/admin/followups/rules/factory）用同一份清單補缺。
 *
 * 鐵律（v3）：template 全部 approved=false（審批後先發）；規則全部 L1 建議層。
 *   seedEnabled = db:seed／seed-followup-p4 嘅開關（舊行為不變）；UI 一鍵建立一律 enabled=false
 *   （由管理員逐條檢查後開 — 唔會一撳就開始出建議）。
 */

export interface FactoryTemplate {
  key: string;
  name: string;
  text: string;
}

export interface FactoryRule {
  name: string;
  trigger: "CONVERSATION_IDLE" | "BEFORE_APPOINTMENT" | "AFTER_NO_SHOW" | "AFTER_TREATMENT" | "RECALL_NO_REPEAT" | "QUOTED_NOT_BOOKED";
  delayValue: number;
  delayUnit: "HOUR" | "DAY" | "WEEK" | "MONTH";
  reasonCodes: string[];
  templateName: string;
  /** db:seed／seed-followup-p4 嘅啟用值（UI 一鍵建立唔用 — 一律 false） */
  seedEnabled: boolean;
}

/** ★ cwi-followup-v3 紅線：E 類訊息唔准重複報價金額 → 只留項目名（舊文本 {{amount}} 已移除）。 */
export const QUOTE_FOLLOWUP_TEXT =
  "{{salutation}}你好，呢度係{{clinicName}}。關於 {{quoteDate}} 同你討論嘅治療方案（{{item}}），想再跟你一下——如對價錢、療程或者分期有任何疑問，或者直接想預約覆診，隨時回覆呢條訊息，我哋會即刻為你安排。期待為你服務！";

/** A/B + C/D（prisma/seed.ts — create-if-missing）。 */
export const FOLLOWUP_BASE_TEMPLATES: FactoryTemplate[] = [
  {
    key: "conversation_followup",
    name: "對話跟進（A）",
    text: "{{salutation}}你好，呢度係{{clinicName}}。留意到你過去幾日冇回覆，想跟你確認下：之前嘅嘢有冇咗解？如果仲有問題或者想重新約診，隨時覆訊息嚟，我哋幫你跟進。",
  },
  {
    key: "appt_reminder",
    name: "預約提醒（B）",
    text: "{{salutation}}你好，呢度係{{clinicName}}。提醒你{{apptDate}}（{{apptTime}}）約咗{{providerName}}覆診，請提前 10 分鐘抵達。如需改期，請直接回覆呢條訊息，我哋幫你安排。期待見到您！",
  },
  {
    key: "no_show",
    name: "爽約跟進（B）",
    text: "{{salutation}}你好，呢度係{{clinicName}}。你{{apptDate}}（{{apptTime}}）嘅預約我哋冇等到你到診，擔心你係有事臨時改咗。如果仲想覆診，請回覆呢條訊息重新預約；有其他情況都歡迎留言，我哋再同你聯絡。",
  },
  {
    key: "post_op_check",
    name: "術後關懷（C · P4）",
    text: "{{salutation}}你好，呢度係{{clinicName}}。{{visitDate}}做完治療之後，想關心下你嘅情況：有冇明顯腫脹、疼痛加劇、出血或者發燒？有任何唔舒服請立即聯絡我哋。祝早日康復！",
  },
  {
    key: "recall_cleaning",
    name: "洗牙召回（D · P4）",
    text: "{{salutation}}你好，呢度係{{clinicName}}。距離你上次洗牙已經有一段時間，建議安排一次常規洗牙，保持牙齒同牙肉健康。想約時間嘅話回覆呢條訊息就得，我哋幫你搵位。期待再見！",
  },
];

/** P4 draft（scripts/seed-followup-p4.ts — upsert，update 唔覆蓋）。 */
export const FOLLOWUP_P4_DRAFT_TEMPLATES: FactoryTemplate[] = [
  { key: "quote_followup", name: "報價未成交跟進（E · P4）", text: QUOTE_FOLLOWUP_TEXT },
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

/** A/B（prisma/seed.ts — 全局 clinicId null；★ cwi-final F-2：B1 預約提醒 seed 預設關）。 */
export const FOLLOWUP_BASE_RULES: FactoryRule[] = [
  { name: "對話空窗跟進（7 日）", trigger: "CONVERSATION_IDLE", delayValue: 7, delayUnit: "DAY", reasonCodes: [], templateName: "conversation_followup", seedEnabled: true },
  { name: "預約提醒（診前 1 日）", trigger: "BEFORE_APPOINTMENT", delayValue: 1, delayUnit: "DAY", reasonCodes: [], templateName: "appt_reminder", seedEnabled: false },
  { name: "爽約跟進（1 日後）", trigger: "AFTER_NO_SHOW", delayValue: 1, delayUnit: "DAY", reasonCodes: [], templateName: "no_show", seedEnabled: true },
];

/** C/D/E（scripts/seed-followup-p4.ts）。 */
export const FOLLOWUP_P4_RULES: FactoryRule[] = [
  { name: "術後關懷（C · P4）", trigger: "AFTER_TREATMENT", delayValue: 1, delayUnit: "DAY", reasonCodes: ["0017", "0013"], templateName: "post_op_check", seedEnabled: true },
  { name: "洗牙召回（D · P4）", trigger: "RECALL_NO_REPEAT", delayValue: 6, delayUnit: "MONTH", reasonCodes: ["0008"], templateName: "recall_cleaning", seedEnabled: true },
  { name: "報價未成交（E · P4）", trigger: "QUOTED_NOT_BOOKED", delayValue: 7, delayUnit: "DAY", reasonCodes: [], templateName: "quote_followup", seedEnabled: true },
];

export const FOLLOWUP_FACTORY_TEMPLATES: FactoryTemplate[] = [...FOLLOWUP_BASE_TEMPLATES, ...FOLLOWUP_P4_DRAFT_TEMPLATES];
export const FOLLOWUP_FACTORY_RULES: FactoryRule[] = [...FOLLOWUP_BASE_RULES, ...FOLLOWUP_P4_RULES];

/** UI 中文 trigger 名（新增表單 + 規則表）。 */
export const FOLLOWUP_TRIGGER_LABELS: Record<FactoryRule["trigger"], string> = {
  CONVERSATION_IDLE: "A 對話空窗（病人冇再覆）",
  BEFORE_APPOINTMENT: "B 預約提醒（應診前）",
  AFTER_NO_SHOW: "B 爽約跟進",
  AFTER_TREATMENT: "C 術後關懷（指定治療後）",
  RECALL_NO_REPEAT: "D 定期召回（N 個月冇再做）",
  QUOTED_NOT_BOOKED: "E 報價未成交",
};

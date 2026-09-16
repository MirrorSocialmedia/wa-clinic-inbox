/**
 * Follow-up opt-out（followup-v2 MD §4.6 — 老細鐵律：opt-out 永遠優先，任何規則唔可 override）
 *
 * 自動偵測：病人 inbound 短句命中關鍵詞 → 標記 + StaffNotice 通知店員確認。
 * 手動：病人卡 toggle（admin API）→ optOutSource="manual"。
 * 效果：所有 follow-up 永久跳過（scan 唔建 task + 發送前 OPT_OUT 檢查）；
 * **唔影響**病人主動查詢時嘅正常回覆（AI/staff 照覆 — 只係唔再主動跟進）。
 *
 * 🔴 誤傷防護：只喺「短句」（≤40 字）先偵測 — 長訊息出現 "stop"（例如講牙醫說 stop
 * 吸煙）唔會誤觸；英文單詞用 word boundary；全部 lower-case 比對。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";

/** 中文短語（包含即中）— MD §4.6 出廠詞表 + 常規變體。 */
const CJK_PHRASES = [
  "唔好再搵我",
  "唔好再send",
  "唔好再 send",
  "唔好再聯絡我",
  "唔好再跟進",
  "唔想收",
  "唔想再收",
  "不要再聯絡我",
  "不要再找我",
  "不要再跟我",
  "取消跟進",
  "停止跟進",
  "退訂",
];
/** 英文（word boundary，case-insensitive）。 */
const EN_PATTERNS = [/\bstop\b/i, /\bunsubscribe\b/i, /\bdo not contact me\b/i, /\bstop following up\b/i];

const MAX_DETECT_LEN = 40;
/** 出廠詞表總數（hub 健康警示「opt-out 詞未設」判定 — 0 = 詞表被清空）。 */
export function optOutWordCount(): number {
  return CJK_PHRASES.length + EN_PATTERNS.length;
}

/** 純函數（unit 可測）：body 係咪 opt-out 意圖。 */
export function detectOptOutIntent(body: string | null | undefined): boolean {
  if (!body) return false;
  const t = body.trim();
  if (t.length === 0 || t.length > MAX_DETECT_LEN) return false;
  const lower = t.toLowerCase();
  if (CJK_PHRASES.some((p) => lower.includes(p.toLowerCase()))) return true;
  return EN_PATTERNS.some((re) => re.test(t));
}

export interface OptOutApplyResult {
  changed: boolean;
  contactId: string | null;
}

/**
 * 應用 opt-out（自動/手動共用）。冪等：已標記 → changed=false（唔重複通知）。
 * 零 PII log：只 contactId/clinicId/source。
 */
export async function applyFollowupOptOut(params: {
  contactId: string;
  source: "auto" | "manual";
  staffId?: string | null;
  now?: Date;
}): Promise<OptOutApplyResult> {
  const now = params.now ?? new Date();
  const contact = await prisma.contact.findUnique({
    where: { id: params.contactId },
    select: { id: true, clinicId: true, followupOptOut: true },
  });
  if (!contact) return { changed: false, contactId: null };
  if (contact.followupOptOut) return { changed: false, contactId: contact.id };

  await prisma.contact.update({
    where: { id: contact.id },
    data: { followupOptOut: true, optOutAt: now, optOutSource: params.source },
  });
  await prisma.auditLog.create({
    data: {
      staffId: params.staffId ?? null,
      action: "FOLLOWUP_OPT_OUT",
      entity: "Contact",
      entityId: contact.id,
      meta: { clinicId: contact.clinicId, source: params.source } as object,
    },
  });
  log.info({ contactId: contact.id, source: params.source }, "followup: opt-out applied");

  if (params.source === "auto") {
    // 通知店員確認（ StaffNotice — 同一對話唔會重複：changed 守衛已擋）
    const clinic = await prisma.clinic.findUnique({ where: { id: contact.clinicId }, select: { code: true } });
    await prisma.staffNotice
      .create({
        data: {
          clinicId: contact.clinicId,
          kind: "SYSTEM",
          title: `跟進停止 · ${clinic?.code ?? "?"} — 病人要求唔好再主動跟進（自動偵測，請確認）`,
          meta: { contactId: contact.id } as object,
        },
      })
      .catch((err) => log.warn({ err: err instanceof Error ? err.message : String(err) }, "followup: opt-out notice failed（best-effort）"));
  }
  return { changed: true, contactId: contact.id };
}

/** 手動復原（staff toggle 返開）— 只 manual 路徑；audit 留痕。 */
export async function clearFollowupOptOut(params: {
  contactId: string;
  staffId?: string | null;
  now?: Date;
}): Promise<OptOutApplyResult> {
  const now = params.now ?? new Date();
  const contact = await prisma.contact.findUnique({
    where: { id: params.contactId },
    select: { id: true, followupOptOut: true },
  });
  if (!contact) return { changed: false, contactId: null };
  if (!contact.followupOptOut) return { changed: false, contactId: contact.id };
  await prisma.contact.update({
    where: { id: contact.id },
    data: { followupOptOut: false, optOutAt: null, optOutSource: null },
  });
  await prisma.auditLog.create({
    data: {
      staffId: params.staffId ?? null,
      action: "FOLLOWUP_OPT_OUT_CLEARED",
      entity: "Contact",
      entityId: contact.id,
      meta: { staffRestored: true } as object,
    },
  });
  return { changed: true, contactId: contact.id };
}

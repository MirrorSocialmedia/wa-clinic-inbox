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
  /** ★ cwi-final S2-2（N-8）：本次 opt-out 即時取消嘅已有建議數（0 = 冇未處理建議 / 冪等重入） */
  cancelledSuggestions: number;
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
  if (!contact) return { changed: false, contactId: null, cancelledSuggestions: 0 };
  if (contact.followupOptOut) return { changed: false, contactId: contact.id, cancelledSuggestions: 0 };

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

  // ★ cwi-final S2-2（N-8）：opt-out → 該 contact 全部 conversation 嘅已有 SUGGESTED 即時取消。
  //   舊版只阻新建（scan 門 + 發送前檢查）— 已出嘅建議卡會留到過期/人手處理。
  //   fail-soft 包晒：取消失敗唔阻 opt-out 生效（旗標本身 = 單一事實來源；
  //   下輪 scan recheck ① OPT_OUT 永遠檢查會補殺；發送路徑照攔）。
  let cancelledSuggestions = 0;
  try {
    const convs = await prisma.conversation.findMany({
      where: { contactId: contact.id },
      select: { id: true, clinicId: true, assigneeId: true, routedStaffId: true, routedGroupId: true },
    });
    if (convs.length > 0) {
      const openTasks = await prisma.followupTask.findMany({
        where: { status: "SUGGESTED", conversationId: { in: convs.map((c) => c.id) } },
        select: { id: true, conversationId: true, clinicId: true },
      });
      if (openTasks.length > 0) {
        const r = await prisma.followupTask.updateMany({
          where: { status: "SUGGESTED", conversationId: { in: convs.map((c) => c.id) } },
          data: { status: "CANCELLED", cancelReason: "OPT_OUT", handledAt: now },
        });
        cancelledSuggestions = r.count;
        // ★ cwi-final S2-4：逐 task 推 followup:changed（另一 tab 建議卡即時消失）— 逐條 best-effort
        const { publishConvEvent, convRef } = await import("@/lib/notify");
        for (const t of openTasks) {
          const cv = t.conversationId ? convs.find((c) => c.id === t.conversationId) : null;
          if (!cv || !t.conversationId) continue;
          await publishConvEvent(convRef(cv), "followup:changed", {
            conversationId: t.conversationId,
            clinicId: t.clinicId,
            taskId: t.id,
            status: "CANCELLED",
          }).catch((err) => log.warn({ taskId: t.id, err: err instanceof Error ? err.message : String(err) }, "followup: opt-out followup:changed emit failed（best-effort）"));
        }
      }
    }
  } catch (err) {
    log.warn(
      { contactId: contact.id, err: err instanceof Error ? err.message : String(err) },
      "followup: opt-out 取消已有建議失敗（best-effort — opt-out 旗標已生效，recheck 會補）"
    );
  }

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
  return { changed: true, contactId: contact.id, cancelledSuggestions };
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
  if (!contact) return { changed: false, contactId: null, cancelledSuggestions: 0 };
  if (!contact.followupOptOut) return { changed: false, contactId: contact.id, cancelledSuggestions: 0 };
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
  return { changed: true, contactId: contact.id, cancelledSuggestions: 0 };
}

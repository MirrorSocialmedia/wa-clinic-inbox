/**
 * booking 訊息文字 pure builders（booking-ui D/E — unit test 用 + 單一文字來源）
 * 零 DB / 零副作用。
 */

const TIME_OF_DAY_LABEL: Record<string, string> = { MORNING: "上晝", AFTERNOON: "下晝", EVENING: "夜晚" };

/** 確認訊息（同 confirm route 格式：「已為你預約 X 月 X 日 HH:mm 陳醫生，到時見 🙂」） */
export function confirmMessageText(b: { requestedDate: string; requestedTime: string | null; providerName: string; timeOfDay?: string | null }): string {
  const [, mo, d] = b.requestedDate.split("-");
  if (b.requestedTime) {
    return `已為你預約 ${Number(mo)}月${Number(d)}日 ${b.requestedTime} ${b.providerName}，到時見 🙂`;
  }
  const tod = TIME_OF_DAY_LABEL[b.timeOfDay ?? ""] ?? "";
  return `已為你預約 ${Number(mo)}月${Number(d)}日 ${tod} ${b.providerName}，具體時段職員會再同你確認 🙂`;
}

/** remarks 組裝（MD §3：主訴 → remarks）— chiefComplaint 係 AI 摘要（非 raw 對話），≤50 字截斷 */
export function buildRemarks(chiefComplaint: string | null | undefined, visitReasonCode: string | null | undefined): string {
  const parts = ["WhatsApp booking"];
  if (chiefComplaint && chiefComplaint.trim().length > 0) parts.push(`Chief complaint: ${chiefComplaint.trim().slice(0, 50)}`);
  if (visitReasonCode) parts.push(`Visit reason: ${visitReasonCode}`);
  return parts.join(" · ");
}

/** 取消訊息（MD §4 文字） */
export function cancelMessageText(date: string): string {
  const [, mo, d] = date.split("-");
  return `已為你取消 ${Number(mo)}月${Number(d)}日嘅預約，有需要隨時搵我哋 🙏`;
}

/** 改期成功覆病人（MD §4 文字） */
export function rescheduledReply(date: string, time: string): string {
  const [, mo, d] = date.split("-");
  return `已為你改至 ${Number(mo)}月${Number(d)}日 ${time}`;
}

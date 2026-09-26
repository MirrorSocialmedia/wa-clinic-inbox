/**
 * booking 訊息文字 pure builders（booking-ui D/E — unit test 用 + 單一文字來源）
 * 零 DB / 零副作用。
 */

const TIME_OF_DAY_LABEL: Record<string, string> = { MORNING: "上晝", AFTERNOON: "下晝", EVENING: "夜晚" };

/**
 * ★ cwi-final S5-14⑦（P2「確認文字」）：診所名 + 地址尾注。
 * 兩者都冇 → 返空字串（舊文字原樣 — 向后兼容）。
 */
function clinicTailOf(name: string | null | undefined, address: string | null | undefined): string {
  const n = name?.trim();
  const a = address?.trim();
  if (!n && !a) return "";
  const parts: string[] = [];
  if (n) parts.push(n);
  if (a) parts.push(`地址：${a}`);
  return `（${parts.join("，")}）`;
}

/** 確認訊息（同 confirm route 格式：「已為你預約 X 月 X 日 HH:mm 陳醫生，到時見 🙂」）
 *  ★ S5-14⑦：加診所名 + 地址（greetingConfig — 冇就舊文字） */
export function confirmMessageText(
  b: {
    requestedDate: string;
    requestedTime: string | null;
    providerName: string;
    timeOfDay?: string | null;
    clinicName?: string | null;
    clinicAddress?: string | null;
  },
): string {
  const [, mo, d] = b.requestedDate.split("-");
  const tail = clinicTailOf(b.clinicName, b.clinicAddress);
  if (b.requestedTime) {
    return `已為你預約 ${Number(mo)}月${Number(d)}日 ${b.requestedTime} ${b.providerName}${tail}，到時見 🙂`;
  }
  const tod = TIME_OF_DAY_LABEL[b.timeOfDay ?? ""] ?? "";
  return `已為你預約 ${Number(mo)}月${Number(d)}日 ${tod} ${b.providerName}${tail}，具體時段職員會再同你確認 🙂`;
}

/** ★ S5-14⑦：由 Clinic.greetingConfig 拎地址（結構寬容 — key 冇 / 非 string / 空白 → null）。 */
export function clinicAddressFromGreetingConfig(greetingConfig: Record<string, unknown> | null | undefined): string | null {
  const v = greetingConfig?.["address"];
  return typeof v === "string" && v.trim() ? v.trim() : null;
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

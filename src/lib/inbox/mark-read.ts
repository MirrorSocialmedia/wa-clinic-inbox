/**
 * ★ cwi-ux UX-01：markRead 兩層規則 — 逐條（PATCH /api/conversations/[id] markRead=true）
 * 同批量（POST /api/conversations/mark-all-read）單一來源（工單明文：唔好複製）。
 *
 * cwi-final S1-12（audit3 P1-09）兩層：
 * ① 所有角色（連 SUPERVISOR）：upsert ConversationRead（個人讀進度 → myUnread）— 一律做。
 * ② Conversation.unreadCount（全店「未處理」/公海 SLA）：只清「我係負責人」或
 *    「未指派且我係 STAFF/ADMIN」嘅對話；SUPERVISOR 唔清（全店未處理語義）。
 *
 * 共用嘅係「邊條要清 unreadCount」嘅判定（規則）；寫入形狀逐條 = 單行 upsert、
 * 批量 = bulk upsert，各自保留（性能差異），判定永遠行同一個 function。
 */

export interface MarkReadRow {
  assigneeId: string | null;
}

export interface MarkReadActor {
  id: string;
  role: string;
}

/** 層②判定：呢條對話嘅全店 unreadCount 應唔應該由呢個 staff 清？（層①永遠做，唔需要判定） */
export function shouldClearUnread(row: MarkReadRow, actor: MarkReadActor): boolean {
  return row.assigneeId === actor.id || (row.assigneeId === null && actor.role !== "SUPERVISOR");
}

/** 批量一鍵已讀上限（工單 §1.2：一次最多 500 條） */
export const MARK_ALL_READ_LIMIT = 500;

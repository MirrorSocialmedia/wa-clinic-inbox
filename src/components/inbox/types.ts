/** Inbox UI 共用型別（同 API 回應 shape 對齊）。 */

export interface ClinicInfo {
  id: string;
  code: string;
  name: string;
  waPhoneNumberId: string;
  waDisplayNumber: string | null;
}

export interface ContactInfo {
  id: string;
  waId: string;
  profileName: string | null;
  labels: string[];
}

export interface WindowState {
  open: boolean;
  remainingMs: number;
  remainingHours: number;
  tone: "green" | "yellow" | "red";
}

export type ConvStatus = "OPEN" | "PENDING" | "RESOLVED";

export interface ConversationItem {
  id: string;
  clinicId: string;
  contactId: string;
  status: ConvStatus;
  assigneeId: string | null;
  assigneeName: string | null;
  unreadCount: number;
  lastInboundAt: string | null;
  lastMessageAt: string;
  intent: string | null;
  intentConfidence: number | null;
  urgency: string | null;
  urgent: boolean;
  aiSummary: string | null;
  contact: ContactInfo | null;
  /** Phase 3：最新 PENDING 預約（綠色卡）— null = 冇 */
  pendingBooking: BookingInfo | null;
  window: WindowState;
  /** client-only：最後一則訊息 preview */
  preview?: string;
}

/** Phase 3：預約請求卡（BookingRequest 嘅 UI shape — 零病人 PII） */
export interface BookingInfo {
  id: string;
  providerName: string;
  requestedDate: string; // YYYY-MM-DD
  requestedTime: string | null; // HH:mm；null = 純收需求變體（資料源離線）
  timeOfDay?: string | null; // MORNING / AFTERNOON / EVENING（純收需求變體）
  /** null = 未經空檔核對（純收需求變體，資料源離線）— UI 灰字卡 */
  precheckPassed: boolean | null;
  status: "PENDING" | "CONFIRMED" | "REJECTED" | "EXPIRED";
  createdAt: string;
}

/** Phase 4：今日當值（clinic-workforce 窄 API，4 欄白名單 — MD §9.2） */
export interface DutyInfo {
  date: string; // YYYY-MM-DD (HK)
  entries: { staffName: string; role: string; shiftStart: string; shiftEnd: string }[];
}

export interface MessageItem {
  id: string;
  conversationId: string;
  waMessageId: string | null;
  direction: "IN" | "OUT";
  channel: "API" | "APP_ECHO" | "HISTORY" | "INTERNAL"; // ★ H1：INTERNAL = 內部備註（黃底🔒，唔出 WhatsApp）
  type: string;
  body: string | null;
  mediaPath: string | null;
  status: string;
  errorCode: string | null;
  sentByStaffId: string | null;
  /** Phase 2b：AI 自動發送標記（AUTO 模式）— UI 顯示「AI 自動覆」，staff 可審計 */
  aiAutoSent?: boolean;
  /** ★ H1：INTERNAL note @ 咗邊啲 staffId（H2 tick 語義用） */
  mentions?: string[];
  waTimestamp: string;
  createdAt: string;
}

export interface StaffInfo {
  id: string;
  name: string;
  role: "ADMIN" | "STAFF";
  clinicId: string | null;
}

export interface UserCtx {
  staffId: string;
  name: string;
  email: string;
  role: "ADMIN" | "STAFF";
  clinicId: string | null;
}

/** socket message:new payload（同 worker notify 對齊） */
export interface NewMessageEvent {
  conversationId: string;
  clinicId: string;
  contact: ContactInfo | null;
  message: MessageItem;
  conversation: {
    status: ConvStatus;
    unreadCount: number;
    lastMessageAt: string;
    lastInboundAt: string | null;
  };
}

export interface MessageStatusEvent {
  conversationId: string;
  clinicId: string;
  waMessageId: string;
  status: string;
  errorCode: string | null;
}

export interface ConvUpdatedEvent {
  conversationId: string;
  clinicId: string;
  status: ConvStatus;
  assigneeId: string | null;
  unreadCount: number;
}

/** Phase 2：AI triage 相關 type（同 ai.worker notify payload 對齊） */

export type AiIntent = "BOOKING_REQUEST" | "QUESTION" | "URGENT_PAIN" | "OUT_OF_SCOPE" | "OTHER";
export type AiUrgency = "LOW" | "MED" | "HIGH";

/** pending AI 草稿（AiDraft PROPOSED 的 UI shape） */
export interface DraftInfo {
  id: string;
  conversationId: string;
  inReplyToMessageId: string;
  draftText: string;
  model: string;
  latencyMs: number;
  status: "PROPOSED" | "SENT_AS_IS" | "SENT_EDITED" | "DISCARDED";
  createdAt: string;
}

/** socket ai:classified — 每次 AI 分類成功（metadata only，summary 係聊天內容） */
export interface AiClassifiedEvent {
  conversationId: string;
  intent: AiIntent;
  urgency: AiUrgency;
  needsHuman: boolean;
  urgent: boolean;
  aiSummary: string;
  hasDraft: boolean;
}

/** socket draft:ready — 有新 pending draft（含 draftText：自己 VPS 內傳，staff 要睇） */
export interface DraftReadyEvent {
  conversationId: string;
  draftId: string;
  inReplyToMessageId: string;
  draftText: string;
  model: string;
  latencyMs: number;
}

/** socket urgent:escalation — 急症實時升級（toast + 隊列頂紅） */
export interface UrgentEscalationEvent {
  conversationId: string;
  intent: AiIntent;
  urgency: AiUrgency;
  contactId: string;
  contactName: string | null;
  waMessageId: string | null;
}

/** Phase 3：socket booking:new / booking:updated — 預約卡狀態變（綠色卡 + /bookings 隊列） */
export interface BookingEvent {
  conversationId: string;
  clinicId: string;
  booking: BookingInfo | null; // null = 已處理/失效（卡消失）
}

/** ★ H1：socket conversation:assigned — 轉交/接手/放返隊列/auto-claim（payload 零內文） */
export interface ConversationAssignedEvent {
  conversationId: string;
  clinicId: string;
  assigneeId: string | null;
  byStaffId: string | null;
}

/** ★ H1：socket note:new — 有新內部備註（零內文 — 內容由 client 拉） */
export interface NoteNewEvent {
  conversationId: string;
  clinicId: string;
  messageId: string;
}

/** ★ H2：socket note:read — 有人讀咗內部備註（零內文 — tick 即時重算） */
export interface NoteReadEvent {
  conversationId: string;
  clinicId: string;
  messageId: string;
  staffId: string;
  readAt: string;
}

/** ★ H2：socket notify:mention — 定向發畀被 @ 者（零內文；bell badge / 黃點 / Notification） */
export interface MentionNotifyEvent {
  conversationId: string;
  clinicId: string;
  messageId: string;
  fromStaffId: string;
}

/** ★ H2：已讀回執 row（GET note-read-receipts 同 socket note:read 共用 shape） */
export interface NoteReceipt {
  messageId: string;
  staffId: string;
  readAt: string;
}

/** ★ H2：INTERNAL note tick 語義（似 WhatsApp）：
 *  灰 ✓ = note 已發出；藍 ✓✓ = 全部被 mention 嘅 staff 已讀（無 mention → 現任 assignee 已讀）。
 *  requiredStaff 為空（unassigned + 無 mention）→ 永遠灰 ✓。 */
export function noteTickState(
  m: { id: string; mentions?: string[] },
  assigneeId: string | null,
  receipts: NoteReceipt[]
): { allRead: boolean; requiredStaff: string[]; readBy: NoteReceipt[] } {
  const requiredStaff = m.mentions && m.mentions.length > 0 ? m.mentions : assigneeId ? [assigneeId] : [];
  const mine = receipts.filter((r) => r.messageId === m.id);
  const got = new Set(mine.map((r) => r.staffId));
  const allRead = requiredStaff.length > 0 && requiredStaff.every((s) => got.has(s));
  return { allRead, requiredStaff, readBy: mine };
}

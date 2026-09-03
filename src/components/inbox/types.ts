/** Inbox UI 共用型別（同 API 回應 shape 對齊）。 */

export interface ClinicInfo {
  id: string;
  code: string;
  name: string;
  waPhoneNumberId: string;
  waDisplayNumber: string | null;
}

/** cwi-multiclinic-20260903：診所基本資料窄型別（/api/clinics?scope=schedule 回 id/code/name；指派選單 + badge 用） */
export interface ClinicLite {
  id: string;
  code: string;
  name: string;
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
  /** cwi-multiclinic-20260903（MD A.3/A.6.4）：跨店線店名 badge（全 row 都有值；前端決定顯唔顯示） */
  clinicName?: string | null;
  clinicCode?: string | null;
  contactId: string;
  status: ConvStatus;
  assigneeId: string | null;
  assigneeName: string | null;
  /** ★ Realtime P0 (R5, cwi-rt-20260823-a1)：樂觀鎖版本 — assign/接手時帶返 server */
  assignVersion: number;
  unreadCount: number;
  lastInboundAt: string | null;
  lastMessageAt: string;
  intent: string | null;
  intentConfidence: number | null;
  urgency: string | null;
  urgent: boolean;
  aiSummary: string | null;
  contact: ContactInfo | null;
  /** ★ booking-ui（A）：已釘住舊客（chat 卡藍掣「幫我喺 Apricot 落單」可見性）— null = 未釘住 */
  pinnedPatient: { patientApricotId: string } | null;
  /** Phase 3：最新 PENDING 預約（綠色卡）/ ★ booking-ui（D）：CONFIRMED 卡 — null = 冇 */
  pendingBooking: BookingInfo | null;
  /** providerslot-20260830 T3：Flow 硬保留 hold（HELD/IN_APRICOT/COMMITTED）— null = 冇（RELEASED/EXPIRED 唔帶） */
  holdEvent: HoldInfo | null;
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
  /** ★ booking-ui（D）：CONFIRMED 態（代落單成功後） */
  apricotApptId?: string | null; // Apricot 單號
  visitReasonCode?: string | null; // 揀咗嘅 visit reason（顯示）
  handledByStaffName?: string | null; // 發起人
  handledAt?: string | null; // ISO — 5 分鐘撤銷倒數起點
  /** ★ booking-ui（D）：主訴（AI 摘要快照，≤50 字 — 顯示 + remarks 來源） */
  chiefComplaint?: string | null;
}

/** providerslot-20260830 T3：Flow 硬保留 hold（本地 FlowHoldEvent — 病人資料落 inbox 本地） */
export interface HoldInfo {
  id: string;
  status: "HELD" | "IN_APRICOT" | "COMMITTED";
  providerName: string;
  date: string; // YYYY-MM-DD (HK)
  startMin: number; // 分鐘自午夜（0..1410）
  endMin: number;
  patientName: string | null;
  patientPhone: string; // waId（join key = Contact.waId）
  notes: string | null;
  source: string;
  committedAt: string | null; // ISO — 完成態顯示
  createdAt: string;
}

/** Phase 4：今日當值（clinic-workforce 窄 API，4 欄白名單 — MD §9.2） */
export interface DutyInfo {
  date: string; // YYYY-MM-DD (HK)
  entries: { staffName: string; role: string; shiftStart: string; shiftEnd: string }[];
}

/** ★ booking-ui（A）：patient-context — lookup match（零 raw phone；姓名 = PII 白名單 v2 許可） */
export interface PatientMatch {
  patientApricotId: string;
  patientCode: string;
  patientName: string;
  lastVisit: { date: string; providerName: string; visitReasons: string[] } | null;
}

/** ★ booking-ui（E）：Apricot 預約卡（側欄 upcoming — status 0/102 only） */
export interface PatientAppointment {
  apricotApptId: string;
  clinicCode: string;
  providerApricotId: string;
  providerName: string;
  date: string; // YYYY-MM-DD
  start: string; // HH:mm
  end: string; // HH:mm
  bookingStatus: number; // 0 = confirmed / 102 = pending
  patientApricotId: string;
  patientCode: string;
  patientName: string;
  visitReasons: string[];
  remarks: string | null;
}

/** ★ booking-ui（A）：GET /api/conversations/[id]/patient-context */
export interface PatientContext {
  pinned: { patientApricotId: string; patientName?: string; lastVisit: PatientMatch["lastVisit"] } | null;
  /** null = workforce 離線（degraded） */
  matches: PatientMatch[] | null;
  /** null = 未釘住或 degraded */
  upcomingAppointments: PatientAppointment[] | null;
  degraded: boolean;
}

/** ★ booking-ui（C）：socket booking:changed — 寫動作後廣播，三位訂閱重拉 */
export interface BookingChangedEvent {
  conversationId: string;
  clinicId: string;
  date: string; // YYYY-MM-DD（受影響日 — L2 invalidate 範圍）
  kind: "CREATED" | "ROLLED_BACK" | "RESCHEDULED" | "CANCELLED";
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
  /** ★ Realtime P0 (R1)：client 冪等 key — optimistic bubble 對消用（server 回传/optimistic 同 key） */
  clientMessageId?: string | null;
  /** ★ Realtime P0 (R4)：media 下載狀態（PENDING/READY/SKIPPED/FAILED；文字訊息永遠 READY） */
  mediaStatus?: string;
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
  /** cwi-multiclinic-20260903：綁定店集合（STAFF = StaffClinic 全部；ADMIN = []）— 跨店 badge 判定用 */
  clinicIds: string[];
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
  /** ★ Realtime P0 (R5)：新 version（PATCH assigneeId 變動 → +1） */
  assignVersion: number;
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
  /** cwi-window-20260901（P2）：NORMAL（窗口內）/ COPY_ONLY（過窗 — 發唔出，只准複製去手機 App）。舊 row / 舊 server 可能冇 → 預設 NORMAL。 */
  mode?: "NORMAL" | "COPY_ONLY";
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
  /** cwi-window-20260901（P2）：COPY_ONLY = 過窗草稿（UI 只准複製） */
  mode?: "NORMAL" | "COPY_ONLY";
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
  /** ★ Realtime P0 (R5)：新 version（assign 成功 → +1）— 其他 client 同步 */
  assignVersion: number;
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

/** ★ Part B：socket notice:new — 內部通知推送（接手/放手/auto-release 等；零內文 — 只有 conversationId + kind） */
export interface NoticeNewEvent {
  conversationId: string;
  kind: string;
}

/** ★ AI Workflow T1 (A2)：內部通知（staff notice）— 媒體/急症升級，同客戶 unread 完全分開 */
export interface StaffNoticeItem {  id: string;
  clinicId: string;
  conversationId: string | null;
  kind: string;
  title: string;
  createdAt: string;
}

/** ★ AI Workflow T1 (A2)：notice:new socket 事件（worker 落庫後推；client 收到就重拉 GET /api/notices） */
export interface NoticeNewEvent {
  conversationId: string;
  kind: string;
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

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
  contact: ContactInfo | null;
  window: WindowState;
  /** client-only：最後一則訊息 preview */
  preview?: string;
}

export interface MessageItem {
  id: string;
  conversationId: string;
  waMessageId: string | null;
  direction: "IN" | "OUT";
  channel: "API" | "APP_ECHO" | "HISTORY";
  type: string;
  body: string | null;
  mediaPath: string | null;
  status: string;
  errorCode: string | null;
  sentByStaffId: string | null;
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

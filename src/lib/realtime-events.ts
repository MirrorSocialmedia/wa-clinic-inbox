/**
 * ★ cwi-final S1-7（audit3 P1-07）：Realtime 事件格式契約。
 *
 * 每個事件一份 zod schema — `publishConvEvent`（notify.ts）喺 emit 前驗證：
 *   - dev / test  → schema.parse（throw 即刻 — 契約漂移 dev 期捉住）
 *   - production  → schema.safeParse（失敗 log.error，唔 throw — realtime 通知係
 *     best-effort，唔准拖累主業務 flow）
 *
 * 口徑：
 * - 所有事件 payload 都會由 publishConvEvent 注入 eventId（randomUUID）— client 去重用（S1-4）。
 * - schema 用 z.looseObject：容許額外欄（向前兼容 emitter 加欄唔會炸），核心欄強制。
 * - 時間欄：in-memory payload 係 Date；JSON round-trip 之後係 ISO string — 兩者都容（ts union）。
 * - 零 PII 邊界：schema 只定義 id / 元數據 / chat 內容本身（同現有 socket 推一致 —
 *   訊息內容係 staff/病人都要見到嘅正常業務數據，唔係 PII 外洩）。
 */
import { z } from "zod";

const id = z.string().min(1);
/** 時間（in-memory = Date；JSON 後 = ISO string） */
const ts = z.union([z.string(), z.date()]);
/** 時間（可空） */
const tsN = z.union([z.string(), z.date()]).nullish();

/** 公共 message shape（同 realtime-payload.ts publicMessagePayload / inbound 舊 publicMessage 一致） */
const publicMessageSchema = z.looseObject({
  id: id,
  conversationId: id,
  waMessageId: z.string().nullish(),
  direction: z.string(),
  channel: z.string(),
  type: z.string(),
  body: z.string().nullish(),
  mediaPath: z.string().nullish(),
  mediaStatus: z.string().nullish(),
  clientMessageId: z.string().nullish(),
  status: z.string().nullish(),
  errorCode: z.string().nullish(),
  sentByStaffId: z.string().nullish(),
  aiAutoSent: z.boolean().nullish(),
  waTimestamp: tsN,
  createdAt: tsN,
});

const messageNew = z.looseObject({
  conversationId: id,
  clinicId: id,
  contact: z
    .looseObject({
      id: id,
      waId: id,
      profileName: z.string().nullish(),
      labels: z.array(z.string()),
    })
    .nullable(),
  message: publicMessageSchema,
  conversation: z.looseObject({
    status: z.string(),
    unreadCount: z.number().int().nonnegative(),
    lastMessageAt: tsN,
    lastInboundAt: tsN,
    reopenedAt: tsN,
  }),
  eventId: id,
});

const messageStatus = z.looseObject({
  conversationId: id,
  clinicId: id,
  waMessageId: id,
  status: z.string(),
  errorCode: z.string().nullish(),
  voidedAt: z.string().nullish(),
  eventId: id,
});

/** ★ S1-7：全部 patch 欄 optional — ids-only payload 合法（T707），client 只 patch 有定義欄位 */
const convUpdated = z.looseObject({
  conversationId: id,
  clinicId: id,
  status: z.string().nullish(),
  assigneeId: z.string().nullish(),
  assignVersion: z.number().int().nullish(),
  unreadCount: z.number().int().nullish(),
  eventId: id,
});

const conversationAssigned = z.looseObject({
  conversationId: id,
  clinicId: id,
  assigneeId: z.string().nullish(),
  byStaffId: z.string().nullish(),
  assignVersion: z.number().int(),
  eventId: id,
});

const draftReady = z.looseObject({
  conversationId: id,
  draftId: id,
  inReplyToMessageId: id,
  draftText: z.string(),
  model: z.string(),
  latencyMs: z.number().nonnegative(),
  mode: z.string(),
  traceJson: z.unknown().nullish(),
  // ★ cwi-final S1-13（D-6）：堆疊排序用（emitter 未帶時 nullish 兼容）
  createdAt: z.string().nullish(),
  eventId: id,
});

// ★ cwi-final S1-13（D-6）：草稿被第 4 個擠出 → client 由堆疊移除
const draftExpired = z.looseObject({
  conversationId: id,
  clinicId: id,
  draftIds: z.array(id),
  eventId: id,
});

const aiClassified = z.looseObject({
  conversationId: id,
  intent: z.string(),
  urgency: z.string(),
  needsHuman: z.boolean(),
  urgent: z.boolean(),
  aiSummary: z.string().nullish(),
  hasDraft: z.boolean(),
  aiMode: z.string(),
  autoLevel: z.string().nullish(),
  autoSent: z.boolean(),
  eventId: id,
});

const urgentEscalation = z.looseObject({
  conversationId: id,
  intent: z.string(),
  urgency: z.string(),
  contactId: id,
  contactName: z.string().nullish(),
  waMessageId: z.string().nullish(),
  eventId: id,
});

/** conversationId 可 null = clinic 級通知（unassigned-sla）；clinicId 可 nullish（conversation 級 emitter 可唔帶，client 由 state 補） */
const noticeNew = z.looseObject({
  conversationId: z.string().nullish(),
  clinicId: z.string().nullish(),
  kind: z.string(),
  reason: z.string().nullish(),
  title: z.string().nullish(),
  count: z.number().int().nullish(),
  eventId: id,
});

const noteNew = z.looseObject({
  conversationId: id,
  clinicId: id,
  messageId: id,
  eventId: id,
});

const noteRead = z.looseObject({
  conversationId: id,
  clinicId: id,
  messageId: id,
  staffId: id,
  readAt: z.string(),
  eventId: id,
});

const mediaReady = z.looseObject({
  conversationId: id,
  clinicId: id,
  messageId: id,
  mediaPath: z.string(),
  eventId: id,
});

/** ★ S1-7：patient-pin 改名獨立事件（client 只 patch pinnedPatientApricotId） */
const patientPinned = z.looseObject({
  conversationId: id,
  clinicId: id,
  pinnedPatientApricotId: z.string().nullish(),
  eventId: id,
});

/** booking 行 shape（booking:new / booking:updated 共用；欄可選程度跟 confirm route 最簡形態） */
const bookingShape = z.looseObject({
  id: id,
  providerName: z.string().nullish(),
  requestedDate: z.string().nullish(),
  requestedTime: z.string().nullish(),
  timeOfDay: z.string().nullish(),
  precheckPassed: z.boolean().nullish(),
  status: z.string().nullish(),
  createdAt: tsN,
  apricotApptId: z.string().nullish(),
  visitReasonCode: z.string().nullish(),
  handledByStaffName: z.string().nullish(),
  handledAt: z.string().nullish(),
});

const bookingNew = z.looseObject({
  conversationId: id,
  clinicId: id,
  booking: bookingShape,
  eventId: id,
});

const bookingUpdated = z.looseObject({
  conversationId: id,
  clinicId: id,
  booking: bookingShape,
  eventId: id,
});

const bookingChanged = z.looseObject({
  conversationId: id,
  clinicId: id,
  date: z.string(),
  kind: z.string(),
  eventId: id,
});

/** routing:assigned 現行 emitter 唔帶 clinicId（room targeting 用獨立參數） */
const routingAssigned = z.looseObject({
  conversationId: id,
  ruleId: z.string(),
  groupId: z.string().nullish(),
  groupName: z.string().nullish(),
  staffId: z.string().nullish(),
  eventId: id,
});

const routingEscalation = z.looseObject({
  conversationId: id,
  ruleId: z.string(),
  fromGroupId: z.string().nullish(),
  toGroupId: z.string(),
  groupName: z.string(),
  escalatedAt: z.string(),
  eventId: id,
});

const notifyMention = z.looseObject({
  conversationId: id,
  clinicId: id,
  messageId: id,
  fromStaffId: z.string().nullish(),
  eventId: id,
});

const notifyAssigned = z.looseObject({
  conversationId: id,
  clinicId: id,
  clinicCode: z.string().nullish(),
  fromStaffId: z.string().nullish(),
  eventId: id,
});

const notifyTakeover = z.looseObject({
  conversationId: id,
  clinicId: id,
  actorStaffId: z.string().nullish(),
  eventId: id,
});

/** 事件名 → schema 註冊表（publishConvEvent 按 event 名查） */
export const EVENT_SCHEMAS: Record<string, z.ZodType> = {
  "message:new": messageNew,
  "message:status": messageStatus,
  "conv:updated": convUpdated,
  "conversation:assigned": conversationAssigned,
  "draft:ready": draftReady,
  "draft:expired": draftExpired,
  "ai:classified": aiClassified,
  "urgent:escalation": urgentEscalation,
  "notice:new": noticeNew,
  "note:new": noteNew,
  "note:read": noteRead,
  "media:ready": mediaReady,
  "patient:pinned": patientPinned,
  "booking:new": bookingNew,
  "booking:updated": bookingUpdated,
  "booking:changed": bookingChanged,
  "routing:assigned": routingAssigned,
  "routing:escalation": routingEscalation,
  "notify:mention": notifyMention,
  "notify:assigned": notifyAssigned,
  "notify:takeover": notifyTakeover,
};

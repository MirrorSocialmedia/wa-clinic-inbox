/**
 * ★ cwi-sales-20261028：對話右欄「銷售」— 歸屬顯示、意向分級、轉交、請求轉交、主管強制接手。
 *
 * 轉交（負責銷售）：ONCE = 24 小時、PERMANENT = 直至收回；同時將對話負責人轉畀對方（Send Lock 先過到；assign 自帶通知）。
 * 強制接手（ADMIN / SUPERVISOR）：FORCE 24 小時；ADMIN 可以接畀自己，SUPERVISOR 唔覆客所以要揀同事。
 * 收回（負責銷售 / ADMIN）：撤銷轉交；對話負責人係被轉交嗰個 → 派返負責銷售。
 */
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { assignConversation } from "@/lib/assign";
import { INTENT_LEVELS, canReplyUnderLock, conversationSalesLock, getSalesSettings, notifyStaff, type SalesIntent } from "@/lib/sales/core";

export const DELEGATION_HOURS = 24;

export class SalesActionError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

type Viewer = { id: string; role: string };

export interface SalesView {
  viewerIsSales: boolean;
  owners: { staffId: string; name: string; state: "PROTECTED" | "BOUND"; protectedUntil: string | null }[];
  delegates: { id: string; staffId: string; name: string; kind: string; expiresAt: string | null }[];
  canReply: boolean;
  isOwner: boolean;
  canForce: boolean;
  intent: { level: SalesIntent; byName: string | null; at: string } | null;
  intentLabels: string[];
}

export async function salesView(conversationId: string, viewer: Viewer, now: Date = new Date()): Promise<SalesView> {
  const [lock, me, conv, settings] = await Promise.all([
    conversationSalesLock(conversationId, now),
    prisma.staffUser.findUnique({ where: { id: viewer.id }, select: { isSales: true } }),
    prisma.conversation.findUnique({ where: { id: conversationId }, select: { salesIntent: true, salesIntentByStaffId: true, salesIntentAt: true } }),
    getSalesSettings(),
  ]);
  const dels = lock.owners.length
    ? await prisma.salesDelegation.findMany({
        where: { conversationId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const nameIds = [...new Set([...dels.map((d) => d.toStaffId), ...(conv?.salesIntentByStaffId ? [conv.salesIntentByStaffId] : [])])];
  const names = new Map((await prisma.staffUser.findMany({ where: { id: { in: nameIds } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
  // 同一銷售負責幾個屋企人 → 合併一行
  const owners = [...new Map(lock.owners.map((o) => [o.staffId, { staffId: o.staffId, name: o.name, state: o.state, protectedUntil: o.protectedUntil }])).values()];
  const level = conv?.salesIntent && (INTENT_LEVELS as readonly string[]).includes(conv.salesIntent) ? (conv.salesIntent as SalesIntent) : null;
  return {
    viewerIsSales: !!me?.isSales,
    owners,
    delegates: dels.map((d) => ({ id: d.id, staffId: d.toStaffId, name: names.get(d.toStaffId) ?? "同事", kind: d.kind, expiresAt: d.expiresAt ? d.expiresAt.toISOString() : null })),
    canReply: canReplyUnderLock(lock, viewer.id),
    isOwner: lock.owners.some((o) => o.staffId === viewer.id),
    canForce: lock.owners.length > 0 && (viewer.role === "ADMIN" || viewer.role === "SUPERVISOR") && !lock.owners.some((o) => o.staffId === viewer.id),
    intent: level && conv?.salesIntentAt ? { level, byName: conv.salesIntentByStaffId ? (names.get(conv.salesIntentByStaffId) ?? null) : null, at: conv.salesIntentAt.toISOString() } : null,
    intentLabels: settings.intentLabels.length === 3 ? settings.intentLabels : ["高", "中", "低"],
  };
}

export async function setSalesIntent(conversationId: string, viewer: Viewer, level: SalesIntent | null): Promise<void> {
  const me = await prisma.staffUser.findUnique({ where: { id: viewer.id }, select: { isSales: true, active: true } });
  if (!me?.isSales || !me.active) throw new SalesActionError(403, "NOT_SALES", "只有銷售人員可以設意向");
  const lock = await conversationSalesLock(conversationId);
  if (lock.owners.length > 0 && !canReplyUnderLock(lock, viewer.id)) throw new SalesActionError(423, "SALES_LOCKED", "呢個病人由其他銷售負責");
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { salesIntent: level, salesIntentByStaffId: level ? viewer.id : null, salesIntentAt: level ? new Date() : null },
  });
  await prisma.auditLog.create({
    data: { staffId: viewer.id, action: "SALES_INTENT_SET", entity: "Conversation", entityId: conversationId, meta: { level } as Prisma.InputJsonValue },
  });
}

async function activeStaff(id: string): Promise<{ id: string; name: string; role: string }> {
  const s = await prisma.staffUser.findUnique({ where: { id }, select: { id: true, name: true, role: true, active: true } });
  if (!s || !s.active) throw new SalesActionError(400, "BAD_TARGET", "揀嘅同事唔存在或者已停用");
  return s;
}

async function audit(staffId: string, action: string, conversationId: string, meta: Record<string, unknown>): Promise<void> {
  await prisma.auditLog
    .create({ data: { staffId, action, entity: "Conversation", entityId: conversationId, meta: meta as Prisma.InputJsonValue } })
    .catch(() => undefined);
}

/** 負責銷售轉交畀同事（ONCE 24 小時 / PERMANENT） */
export async function delegateConversation(input: { conversationId: string; viewer: Viewer; toStaffId: string; kind: "ONCE" | "PERMANENT" }): Promise<void> {
  const lock = await conversationSalesLock(input.conversationId);
  if (!lock.owners.some((o) => o.staffId === input.viewer.id)) throw new SalesActionError(403, "NOT_OWNER", "只有負責銷售可以轉交");
  const target = await activeStaff(input.toStaffId);
  if (target.id === input.viewer.id) throw new SalesActionError(400, "BAD_TARGET", "唔可以轉交畀自己");
  if (target.role === "SUPERVISOR") throw new SalesActionError(400, "BAD_TARGET", "主管唔可以覆客，請揀其他同事");
  const now = new Date();
  await prisma.salesDelegation.create({
    data: {
      conversationId: input.conversationId,
      toStaffId: target.id,
      byStaffId: input.viewer.id,
      kind: input.kind,
      expiresAt: input.kind === "ONCE" ? new Date(now.getTime() + DELEGATION_HOURS * 3600_000) : null,
    },
  });
  await assignConversation({
    conversationId: input.conversationId,
    toStaffId: target.id,
    by: "STAFF",
    byStaffId: input.viewer.id,
    note: input.kind === "ONCE" ? `銷售轉交（${DELEGATION_HOURS} 小時）` : "銷售轉交（直至收回）",
  });
  await audit(input.viewer.id, "SALES_HANDOVER", input.conversationId, { toStaffId: target.id, kind: input.kind });
}

/** 其他同事請負責銷售轉交 */
export async function requestHandover(input: { conversationId: string; viewer: Viewer }): Promise<void> {
  const lock = await conversationSalesLock(input.conversationId);
  if (lock.owners.length === 0) throw new SalesActionError(409, "NOT_LOCKED", "呢個對話冇銷售鎖");
  const me = await activeStaff(input.viewer.id);
  await audit(input.viewer.id, "SALES_HANDOVER_REQUEST", input.conversationId, {});
  await notifyStaff(lock.owners.map((o) => o.staffId), input.conversationId, "SALES_HANDOVER", `銷售 · ${me.name} 請你轉交呢個對話`, { requestedBy: me.id });
}

/** ADMIN / SUPERVISOR 強制接手（24 小時；留紀錄 + 通知負責銷售） */
export async function forceTakeover(input: { conversationId: string; viewer: Viewer; toStaffId?: string | null; reason?: string | null }): Promise<string> {
  if (input.viewer.role !== "ADMIN" && input.viewer.role !== "SUPERVISOR") throw new SalesActionError(403, "FORBIDDEN", "只有主管或者 ADMIN 可以強制接手");
  const lock = await conversationSalesLock(input.conversationId);
  if (lock.owners.length === 0) throw new SalesActionError(409, "NOT_LOCKED", "呢個對話冇銷售鎖");
  const toId = input.toStaffId || (input.viewer.role === "ADMIN" ? input.viewer.id : null);
  if (!toId) throw new SalesActionError(400, "BAD_TARGET", "請揀接手嘅同事");
  const target = await activeStaff(toId);
  if (target.role === "SUPERVISOR") throw new SalesActionError(400, "BAD_TARGET", "主管唔可以覆客，請揀其他同事");
  await prisma.salesDelegation.create({
    data: {
      conversationId: input.conversationId,
      toStaffId: target.id,
      byStaffId: input.viewer.id,
      kind: "FORCE",
      reason: input.reason?.slice(0, 200) ?? null,
      expiresAt: new Date(Date.now() + DELEGATION_HOURS * 3600_000),
    },
  });
  await assignConversation({
    conversationId: input.conversationId,
    toStaffId: target.id,
    by: "STAFF",
    byStaffId: input.viewer.id,
    note: `主管強制接手（${DELEGATION_HOURS} 小時）${input.reason ? `：${input.reason.slice(0, 100)}` : ""}`,
  });
  await audit(input.viewer.id, "SALES_FORCE_TAKEOVER", input.conversationId, { toStaffId: target.id, reason: input.reason ?? null });
  await notifyStaff(lock.owners.map((o) => o.staffId), input.conversationId, "SALES_HANDOVER", "銷售 · 主管已強制接手你負責嘅對話（24 小時）", { toStaffId: target.id });
  return target.id;
}

/** 收回轉交（負責銷售 / ADMIN） */
export async function revokeDelegation(input: { conversationId: string; viewer: Viewer; delegationId: string }): Promise<void> {
  const del = await prisma.salesDelegation.findFirst({ where: { id: input.delegationId, conversationId: input.conversationId, revokedAt: null } });
  if (!del) throw new SalesActionError(404, "NOT_FOUND", "轉交已經收回或者過期");
  const lock = await conversationSalesLock(input.conversationId);
  const isOwner = lock.owners.some((o) => o.staffId === input.viewer.id);
  if (!isOwner && input.viewer.role !== "ADMIN") throw new SalesActionError(403, "NOT_OWNER", "只有負責銷售或者 ADMIN 可以收回");
  await prisma.salesDelegation.update({ where: { id: del.id }, data: { revokedAt: new Date() } });
  const conv = await prisma.conversation.findUnique({ where: { id: input.conversationId }, select: { assigneeId: true } });
  const owner = lock.owners[0];
  if (owner && conv?.assigneeId === del.toStaffId) {
    await assignConversation({ conversationId: input.conversationId, toStaffId: owner.staffId, by: "STAFF", byStaffId: input.viewer.id, note: `收回轉交 — 派返 ${owner.name}` });
  }
  await audit(input.viewer.id, "SALES_HANDOVER_REVOKED", input.conversationId, { delegationId: del.id, toStaffId: del.toStaffId });
}

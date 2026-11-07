/**
 * ★ cwi-workgroup-p2-20261105：外部對話（Lab 師傅、供應商等「唔係病人」嘅 WhatsApp 對話）。
 *
 * 標記之後：
 * - Contact.externalAt/Name/Org 寫低；佢喺呢間店嘅對話 Conversation.external = true
 * - 對話由收件箱搬去「工作群 → 外部對話」（收件箱列表／計數唔再出現；直接開 /inbox?conv= 仲覆到）
 * - 唔觸發 AI、預約、銷售、跟進、病人判定、紅旗 intake（inbound／ai worker 都有閘）
 * - 之後佢再發 WhatsApp 嚟（同一個 Contact）→ 直接係外部對話
 *
 * 規則：
 * - 要睇得到 + 寫得到呢個對話（SUPERVISOR 唯讀唔得）
 * - 銷售保護／綁定中嘅病人唔可以標記（防有人借「外部」甩走銷售保護）
 * - 未完成嘅跟進建議（SUGGESTED）即取消（cancelReason=EXTERNAL）
 * - 取消標記：任何睇得到 + 寫得到嘅同事；對話返返收件箱（未指派／原負責人照舊）
 * - AuditLog 只記 id（零名／零電話）；名同公司只入 DB + UI
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { assertConversationAccess, assertCanWriteConversation, scopedClinicSet, type AuthContext } from "@/lib/rbac";
import { publishConvEvent, convRef } from "@/lib/notify";

export const EXT_NAME_MAX = 40;
export const EXT_ORG_MAX = 60;

export class ExternalError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type Ctx = Pick<AuthContext, "staff" | "scopeType" | "scopedClinicIds">;

function clean(raw: unknown, max: number): string {
  return typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/\s+/g, " ").slice(0, max) : "";
}

async function loadConv(ctx: Ctx, conversationId: string) {
  const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conv) throw new ExternalError(404, "NOT_FOUND", "搵唔到呢個對話");
  await assertConversationAccess(ctx, conv);
  assertCanWriteConversation(ctx);
  return conv;
}

export async function markExternal(ctx: Ctx, conversationId: string, input: { name: unknown; org?: unknown }): Promise<void> {
  const name = clean(input.name, EXT_NAME_MAX);
  const org = clean(input.org, EXT_ORG_MAX) || null;
  if (!name) throw new ExternalError(400, "NAME_REQUIRED", "請輸入對方名（例如：陳師傅）");
  const conv = await loadConv(ctx, conversationId);
  if (conv.external) throw new ExternalError(409, "ALREADY_EXTERNAL", "呢個已經係外部對話");
  const { conversationSalesLock } = await import("@/lib/sales/core");
  const lock = await conversationSalesLock(conv.id);
  if (lock.owners.length > 0) throw new ExternalError(409, "SALES_PROTECTED", "呢位係銷售保護中嘅病人，唔可以標記做外部人");
  const now = new Date();
  const convIds = await prisma.$transaction(async (tx) => {
    await tx.contact.update({ where: { id: conv.contactId }, data: { externalAt: now, externalName: name, externalOrg: org, externalById: ctx.staff.id } });
    const convs = await tx.conversation.findMany({ where: { contactId: conv.contactId }, select: { id: true } });
    await tx.conversation.updateMany({ where: { contactId: conv.contactId }, data: { external: true } });
    await tx.followupTask.updateMany({
      where: { conversationId: { in: convs.map((c) => c.id) }, status: "SUGGESTED" },
      data: { status: "CANCELLED", cancelReason: "EXTERNAL" },
    });
    await tx.auditLog.create({ data: { staffId: ctx.staff.id, action: "CONTACT_MARK_EXTERNAL", entity: "Contact", entityId: conv.contactId, meta: { conversationId: conv.id } } });
    return convs.map((c) => c.id);
  });
  log.info({ conversationId: conv.id, n: convIds.length }, "external: marked");
  await emitChanged(convIds, true);
}

export async function unmarkExternal(ctx: Ctx, conversationId: string): Promise<void> {
  const conv = await loadConv(ctx, conversationId);
  if (!conv.external) throw new ExternalError(409, "NOT_EXTERNAL", "呢個唔係外部對話");
  const convIds = await prisma.$transaction(async (tx) => {
    await tx.contact.update({ where: { id: conv.contactId }, data: { externalAt: null, externalName: null, externalOrg: null, externalById: null } });
    const convs = await tx.conversation.findMany({ where: { contactId: conv.contactId }, select: { id: true } });
    await tx.conversation.updateMany({ where: { contactId: conv.contactId }, data: { external: false } });
    await tx.auditLog.create({ data: { staffId: ctx.staff.id, action: "CONTACT_UNMARK_EXTERNAL", entity: "Contact", entityId: conv.contactId, meta: { conversationId: conv.id } } });
    return convs.map((c) => c.id);
  });
  await emitChanged(convIds, false);
}

async function emitChanged(convIds: string[], external: boolean): Promise<void> {
  const rows = await prisma.conversation.findMany({ where: { id: { in: convIds } } });
  for (const c of rows) {
    await publishConvEvent(convRef(c), "conv:updated", { conversationId: c.id, clinicId: c.clinicId, external }).catch(() => undefined);
  }
}

// ── 工作群「外部對話」列表 ───────────────────────────────────────────────

export interface ExternalConvView {
  conversationId: string;
  name: string;
  org: string | null;
  clinicCode: string | null;
  lastMessageAt: string;
  lastPreview: string | null;
  lastFromThem: boolean;
  unread: number;
  assigneeName: string | null;
}

/** 睇嘅人範圍：店集合 ∪ 我負責（同收件箱 baseScope 一致；全店管理員 = 全部） */
function scopeWhere(ctx: Ctx) {
  const set = scopedClinicSet(ctx);
  if (set === null) return {};
  return { OR: [{ clinicId: { in: set } }, { handlingClinicId: { in: set } }, { assigneeId: ctx.staff.id }] };
}

export async function listExternalConversations(ctx: Ctx): Promise<ExternalConvView[]> {
  const convs = await prisma.conversation.findMany({
    where: { AND: [{ external: true }, scopeWhere(ctx)] },
    orderBy: { lastMessageAt: "desc" },
    take: 200,
  });
  if (convs.length === 0) return [];
  const [contacts, clinics, lastMsgs, staff] = await Promise.all([
    prisma.contact.findMany({ where: { id: { in: convs.map((c) => c.contactId) } }, select: { id: true, externalName: true, externalOrg: true, profileName: true } }),
    prisma.clinic.findMany({ where: { id: { in: [...new Set(convs.map((c) => c.handlingClinicId ?? c.clinicId))] } }, select: { id: true, code: true } }),
    prisma.message.findMany({
      where: { conversationId: { in: convs.map((c) => c.id) }, channel: { not: "INTERNAL" } },
      orderBy: [{ conversationId: "asc" }, { createdAt: "desc" }],
      distinct: ["conversationId"],
      select: { conversationId: true, body: true, type: true, direction: true },
    }),
    prisma.staffUser.findMany({ where: { id: { in: convs.map((c) => c.assigneeId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
  ]);
  const contactOf = new Map(contacts.map((x) => [x.id, x]));
  const clinicOf = new Map(clinics.map((x) => [x.id, x.code]));
  const lastOf = new Map(lastMsgs.map((m) => [m.conversationId, m]));
  const staffOf = new Map(staff.map((s) => [s.id, s.name]));
  return convs.map((c) => {
    const ct = contactOf.get(c.contactId);
    const lm = lastOf.get(c.id);
    return {
      conversationId: c.id,
      name: ct?.externalName ?? ct?.profileName ?? "外部人",
      org: ct?.externalOrg ?? null,
      clinicCode: clinicOf.get(c.handlingClinicId ?? c.clinicId) ?? null,
      lastMessageAt: c.lastMessageAt.toISOString(),
      lastPreview: lm ? (lm.body ? lm.body.slice(0, 60) : `〔${lm.type === "image" ? "相片" : lm.type === "document" ? "文件" : lm.type === "sticker" ? "貼圖" : lm.type}〕`) : null,
      lastFromThem: lm?.direction === "IN",
      unread: c.unreadCount,
      assigneeName: c.assigneeId ? (staffOf.get(c.assigneeId) ?? null) : null,
    };
  });
}

/** 導航 badge：有未讀嘅外部對話數 */
export async function externalUnreadCount(ctx: Ctx): Promise<number> {
  return prisma.conversation.count({ where: { AND: [{ external: true }, { unreadCount: { gt: 0 } }, scopeWhere(ctx)] } });
}

/** 對話頂部 banner 用：外部人資料（冇權 → null） */
export async function externalInfo(ctx: Ctx, conversationId: string): Promise<{ name: string; org: string | null } | null> {
  const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conv?.external) return null;
  await assertConversationAccess(ctx, conv);
  const ct = await prisma.contact.findUnique({ where: { id: conv.contactId }, select: { externalName: true, externalOrg: true } });
  return { name: ct?.externalName ?? "外部人", org: ct?.externalOrg ?? null };
}

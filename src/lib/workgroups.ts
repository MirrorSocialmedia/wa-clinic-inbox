/**
 * ★ cwi-workgroup-20261104：工作群（inbox 內部團隊群組 — 唔經 WhatsApp，Meta 唔收費）。
 *
 * 規則：
 * - 群組／成員全部由老闆（集團管理員）管：開群、改名、加／刪任何員工、封存（唯讀）— 冇自動加人
 * - 只有成員先睇到／發到訊息（老闆都要係成員先睇到內容；管理頁只見群名同成員）
 * - 封存 = 唯讀；成員被刪 = 即時睇唔到
 * - @ 只限發送嗰刻嘅成員（唔係成員唔會收通知）
 * - 分享對話卡：只存 conversationId；顯示時按「睇嘅人」權限即時查 — 冇權嗰間店 → 唔顯示病人資料
 * - 防重複發送：clientKey（同一個人同一個 key 只寫一次，第二次回返同一條）
 * - PII：log 永遠唔記內文；push 只帶群名（唔帶訊息）
 */
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { assertConversationAccess, type AuthContext } from "@/lib/rbac";

export const WG_NAME_MAX = 40;
export const WG_BODY_MAX = 2000;
export const WG_MEMBERS_MAX = 300;
export const WG_PAGE = 50;

export class WorkGroupError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type Viewer = Pick<AuthContext, "staff" | "scopeType" | "scopedClinicIds">;

async function membership(groupId: string, staffId: string) {
  const m = await prisma.workGroupMember.findUnique({ where: { groupId_staffId: { groupId, staffId } }, include: { group: true } });
  if (!m) throw new WorkGroupError(404, "NOT_MEMBER", "搵唔到呢個群組（或者你唔係成員）");
  return m;
}

async function staffNames(ids: string[]): Promise<Map<string, { name: string; active: boolean }>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.staffUser.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true, active: true } });
  return new Map(rows.map((r) => [r.id, { name: r.name, active: r.active }]));
}

// ── 我嘅群組（列表 + 未讀）──────────────────────────────────────────────────

export interface MyGroupView {
  id: string;
  name: string;
  archived: boolean;
  memberCount: number;
  lastMessageAt: string | null;
  lastPreview: string | null;
  unread: number;
  mentionUnread: number;
}

export async function myGroups(staffId: string): Promise<MyGroupView[]> {
  const mems = await prisma.workGroupMember.findMany({ where: { staffId }, include: { group: { include: { _count: { select: { members: true } } } } } });
  if (mems.length === 0) return [];
  const out: MyGroupView[] = [];
  for (const m of mems) {
    const since = m.lastReadAt ?? m.addedAt;
    const unreadWhere = { groupId: m.groupId, senderId: { not: staffId }, createdAt: { gt: since } };
    const [unread, mentionUnread, last] = await Promise.all([
      prisma.workGroupMessage.count({ where: unreadWhere }),
      prisma.workGroupMessage.count({ where: { ...unreadWhere, mentions: { has: staffId } } }),
      prisma.workGroupMessage.findFirst({ where: { groupId: m.groupId }, orderBy: { createdAt: "desc" }, select: { senderId: true, body: true, conversationId: true } }),
    ]);
    let lastPreview: string | null = null;
    if (last) {
      const who = (await staffNames([last.senderId])).get(last.senderId)?.name ?? "同事";
      lastPreview = `${who}：${last.body ? last.body.slice(0, 60) : last.conversationId ? "〔分享咗一個對話〕" : ""}`;
    }
    out.push({
      id: m.group.id,
      name: m.group.name,
      archived: !!m.group.archivedAt,
      memberCount: m.group._count.members,
      lastMessageAt: m.group.lastMessageAt?.toISOString() ?? null,
      lastPreview,
      unread,
      mentionUnread,
    });
  }
  // 有 @ 先、未讀先、最近先；封存排尾
  return out.sort(
    (a, b) =>
      Number(a.archived) - Number(b.archived) ||
      Number(b.mentionUnread > 0) - Number(a.mentionUnread > 0) ||
      (b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0) - (a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0),
  );
}

/** 導航 badge：未讀總數（@ 另計）— 封存群組唔計 */
export async function unreadTotals(staffId: string): Promise<{ unread: number; mention: number }> {
  const gs = await myGroups(staffId);
  return gs.filter((g) => !g.archived).reduce((t, g) => ({ unread: t.unread + g.unread, mention: t.mention + g.mentionUnread }), { unread: 0, mention: 0 });
}

// ── 訊息 ────────────────────────────────────────────────────────────────────

export interface ConvCard {
  conversationId: string;
  /** false = 睇嘅人冇權睇呢個對話（唔顯示病人資料） */
  allowed: boolean;
  name: string | null;
  patientCode: string | null;
  clinicCode: string | null;
  salesIntent: string | null;
  lastAt: string | null;
}

export interface GroupMessageView {
  id: string;
  senderId: string;
  senderName: string;
  mine: boolean;
  body: string;
  mentions: { id: string; name: string }[];
  card: ConvCard | null;
  createdAt: string;
}

/** 對話卡：按睇嘅人權限即時查（冇權 → allowed=false，唔回病人資料） */
async function resolveCards(convIds: string[], viewer: Viewer): Promise<Map<string, ConvCard>> {
  const out = new Map<string, ConvCard>();
  if (convIds.length === 0) return out;
  const convs = await prisma.conversation.findMany({
    where: { id: { in: [...new Set(convIds)] } },
    select: {
      id: true,
      clinicId: true,
      handlingClinicId: true,
      assigneeId: true,
      routedStaffId: true,
      routedGroupId: true,
      lastMessageAt: true,
      salesIntent: true,
      pinnedPatientApricotId: true,
      pinnedPatientName: true,
      contactId: true,
    },
  });
  const [contacts, clinics] = await Promise.all([
    prisma.contact.findMany({ where: { id: { in: [...new Set(convs.map((c) => c.contactId))] } }, select: { id: true, profileName: true, identifiedPatientCode: true } }),
    prisma.clinic.findMany({ where: { id: { in: [...new Set(convs.map((c) => c.handlingClinicId ?? c.clinicId))] } }, select: { id: true, code: true } }),
  ]);
  const contactOf = new Map(contacts.map((x) => [x.id, x]));
  const clinicOf = new Map(clinics.map((x) => [x.id, x.code]));
  for (const c of convs) {
    let allowed = true;
    try {
      await assertConversationAccess(viewer, c);
    } catch {
      allowed = false;
    }
    out.set(
      c.id,
      allowed
        ? {
            conversationId: c.id,
            allowed,
            name: c.pinnedPatientName ?? contactOf.get(c.contactId)?.profileName ?? null,
            patientCode: contactOf.get(c.contactId)?.identifiedPatientCode ?? null,
            clinicCode: clinicOf.get(c.handlingClinicId ?? c.clinicId) ?? null,
            salesIntent: c.salesIntent,
            lastAt: c.lastMessageAt.toISOString(),
          }
        : { conversationId: c.id, allowed, name: null, patientCode: null, clinicCode: null, salesIntent: null, lastAt: null },
    );
  }
  // 對話已刪 → 當冇權（唔洩任何嘢）
  for (const id of convIds) if (!out.has(id)) out.set(id, { conversationId: id, allowed: false, name: null, patientCode: null, clinicCode: null, salesIntent: null, lastAt: null });
  return out;
}

export async function groupMessages(
  groupId: string,
  viewer: Viewer,
  opts: { before?: string | null; limit?: number } = {},
): Promise<{ group: { id: string; name: string; archived: boolean; members: { id: string; name: string; active: boolean }[] }; messages: GroupMessageView[]; hasMore: boolean }> {
  const m = await membership(groupId, viewer.staff.id);
  const limit = Math.min(Math.max(opts.limit ?? WG_PAGE, 1), 100);
  let beforeAt: Date | null = null;
  if (opts.before) {
    const ref = await prisma.workGroupMessage.findFirst({ where: { id: opts.before, groupId }, select: { createdAt: true } });
    if (!ref) throw new WorkGroupError(400, "BAD_CURSOR", "分頁位置唔啱");
    beforeAt = ref.createdAt;
  }
  const rows = await prisma.workGroupMessage.findMany({
    where: { groupId, ...(beforeAt ? { createdAt: { lt: beforeAt } } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const page = rows.slice(0, limit).reverse();
  const memberRows = await prisma.workGroupMember.findMany({ where: { groupId }, select: { staffId: true } });
  const names = await staffNames([...page.flatMap((r) => [r.senderId, ...r.mentions]), ...memberRows.map((r) => r.staffId)]);
  const cards = await resolveCards(page.map((r) => r.conversationId).filter((x): x is string => !!x), viewer);
  return {
    group: {
      id: m.group.id,
      name: m.group.name,
      archived: !!m.group.archivedAt,
      members: memberRows
        .map((r) => ({ id: r.staffId, name: names.get(r.staffId)?.name ?? "（已刪員工）", active: names.get(r.staffId)?.active ?? false }))
        .sort((a, b) => a.name.localeCompare(b.name, "zh-HK")),
    },
    messages: page.map((r) => ({
      id: r.id,
      senderId: r.senderId,
      senderName: names.get(r.senderId)?.name ?? "同事",
      mine: r.senderId === viewer.staff.id,
      body: r.body,
      mentions: r.mentions.map((id) => ({ id, name: names.get(id)?.name ?? "同事" })),
      card: r.conversationId ? (cards.get(r.conversationId) ?? null) : null,
      createdAt: r.createdAt.toISOString(),
    })),
    hasMore: rows.length > limit,
  };
}

export interface SendInput {
  body: string;
  mentions?: string[];
  conversationId?: string | null;
  clientKey?: string | null;
}

export interface SendResult {
  messageId: string;
  duplicate: boolean;
  /** 發送後要通知嘅成員（唔包自己）— caller commit 後 publish */
  notify: string[];
  /** 被 @ 而又係成員嘅人（唔包自己） */
  mentioned: string[];
  groupName: string;
}

export async function sendGroupMessage(groupId: string, sender: Viewer, input: SendInput): Promise<SendResult> {
  const m = await membership(groupId, sender.staff.id);
  if (m.group.archivedAt) throw new WorkGroupError(409, "ARCHIVED", "呢個群組已封存，唔可以再發訊息");
  const body = (input.body ?? "").trim();
  if (body.length > WG_BODY_MAX) throw new WorkGroupError(400, "TOO_LONG", `訊息太長（最多 ${WG_BODY_MAX} 字）`);
  const conversationId = input.conversationId || null;
  if (!body && !conversationId) throw new WorkGroupError(400, "EMPTY", "訊息唔可以空白");
  if (conversationId) {
    // 分享嘅人自己要睇得到呢個對話（唔可以借工作群探其他店嘅對話）
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true, clinicId: true, handlingClinicId: true, assigneeId: true, routedStaffId: true, routedGroupId: true },
    });
    if (!conv) throw new WorkGroupError(404, "CONV_NOT_FOUND", "搵唔到呢個對話");
    try {
      await assertConversationAccess(sender, conv);
    } catch {
      throw new WorkGroupError(403, "CONV_FORBIDDEN", "你冇權分享呢個對話");
    }
  }
  const memberIds = (await prisma.workGroupMember.findMany({ where: { groupId }, select: { staffId: true } })).map((r) => r.staffId);
  const memberSet = new Set(memberIds);
  const mentioned = [...new Set((input.mentions ?? []).filter((id) => typeof id === "string" && memberSet.has(id) && id !== sender.staff.id))].slice(0, 50);
  const clientKey = input.clientKey && /^[A-Za-z0-9_-]{8,64}$/.test(input.clientKey) ? input.clientKey : null;
  const notify = memberIds.filter((id) => id !== sender.staff.id);
  try {
    const msg = await prisma.$transaction(async (tx) => {
      const created = await tx.workGroupMessage.create({
        data: { groupId, senderId: sender.staff.id, body, mentions: mentioned, conversationId, clientKey },
      });
      await tx.workGroup.update({ where: { id: groupId }, data: { lastMessageAt: created.createdAt } });
      // 自己發 = 自己已讀
      await tx.workGroupMember.update({ where: { groupId_staffId: { groupId, staffId: sender.staff.id } }, data: { lastReadAt: created.createdAt } });
      return created;
    });
    log.info({ groupId, messageId: msg.id, bodyLen: body.length, mentions: mentioned.length, card: !!conversationId }, "workgroup: message sent");
    return { messageId: msg.id, duplicate: false, notify, mentioned, groupName: m.group.name };
  } catch (e) {
    if (clientKey && e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const prev = await prisma.workGroupMessage.findUnique({ where: { senderId_clientKey: { senderId: sender.staff.id, clientKey } } });
      if (prev && prev.groupId === groupId) return { messageId: prev.id, duplicate: true, notify: [], mentioned: [], groupName: m.group.name };
      throw new WorkGroupError(409, "DUPLICATE_KEY", "重複發送");
    }
    throw e;
  }
}

export async function markGroupRead(groupId: string, staffId: string, now: Date = new Date()): Promise<void> {
  await membership(groupId, staffId);
  // 只向前推（舊 tab 遲到嘅 read 唔會倒退）
  await prisma.workGroupMember.updateMany({
    where: { groupId, staffId, OR: [{ lastReadAt: null }, { lastReadAt: { lt: now } }] },
    data: { lastReadAt: now },
  });
}

// ── 老闆管理 ────────────────────────────────────────────────────────────────

export interface AdminGroupView {
  id: string;
  name: string;
  archived: boolean;
  createdAt: string;
  members: { id: string; name: string; active: boolean }[];
}

export async function adminListGroups(): Promise<AdminGroupView[]> {
  const gs = await prisma.workGroup.findMany({ include: { members: { select: { staffId: true } } }, orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }] });
  const names = await staffNames(gs.flatMap((g) => g.members.map((m) => m.staffId)));
  return gs.map((g) => ({
    id: g.id,
    name: g.name,
    archived: !!g.archivedAt,
    createdAt: g.createdAt.toISOString(),
    members: g.members
      .map((m) => ({ id: m.staffId, name: names.get(m.staffId)?.name ?? "（已刪員工）", active: names.get(m.staffId)?.active ?? false }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-HK")),
  }));
}

function cleanName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!name) throw new WorkGroupError(400, "NAME_REQUIRED", "請輸入群組名");
  if (name.length > WG_NAME_MAX) throw new WorkGroupError(400, "NAME_TOO_LONG", `群組名最多 ${WG_NAME_MAX} 字`);
  return name;
}

async function validStaff(ids: string[]): Promise<string[]> {
  const uniq = [...new Set(ids.filter((x) => typeof x === "string" && x.length > 0 && x.length <= 64))];
  if (uniq.length > WG_MEMBERS_MAX) throw new WorkGroupError(400, "TOO_MANY", `每個群最多 ${WG_MEMBERS_MAX} 人`);
  if (uniq.length === 0) return [];
  const found = await prisma.staffUser.findMany({ where: { id: { in: uniq }, active: true }, select: { id: true } });
  if (found.length !== uniq.length) throw new WorkGroupError(400, "BAD_STAFF", "有員工唔存在或者已停用");
  return uniq;
}

export async function adminCreateGroup(actorId: string, input: { name: unknown; memberIds?: string[] }): Promise<string> {
  const name = cleanName(input.name);
  const members = await validStaff(input.memberIds ?? []);
  const g = await prisma.workGroup.create({
    data: { name, createdById: actorId, members: { create: members.map((staffId) => ({ staffId, addedById: actorId })) } },
  });
  await prisma.auditLog.create({ data: { staffId: actorId, action: "WORKGROUP_CREATE", entity: "WorkGroup", entityId: g.id, meta: { members: members.length } } });
  return g.id;
}

export async function adminUpdateGroup(
  actorId: string,
  groupId: string,
  input: { name?: unknown; archived?: boolean; addIds?: string[]; removeIds?: string[] },
): Promise<{ added: string[]; removed: string[] }> {
  const g = await prisma.workGroup.findUnique({ where: { id: groupId } });
  if (!g) throw new WorkGroupError(404, "NOT_FOUND", "搵唔到呢個群組");
  const data: Prisma.WorkGroupUpdateInput = {};
  if (input.name !== undefined) data.name = cleanName(input.name);
  if (input.archived !== undefined) data.archivedAt = input.archived ? (g.archivedAt ?? new Date()) : null;
  const add = await validStaff(input.addIds ?? []);
  const remove = [...new Set((input.removeIds ?? []).filter((x) => typeof x === "string"))];
  const overlap = add.filter((x) => remove.includes(x));
  if (overlap.length) throw new WorkGroupError(400, "ADD_REMOVE_SAME", "同一個人唔可以同時加同刪");
  const current = await prisma.workGroupMember.count({ where: { groupId } });
  if (current + add.length - remove.length > WG_MEMBERS_MAX) throw new WorkGroupError(400, "TOO_MANY", `每個群最多 ${WG_MEMBERS_MAX} 人`);
  const res = await prisma.$transaction(async (tx) => {
    if (Object.keys(data).length) await tx.workGroup.update({ where: { id: groupId }, data });
    // 已係成員 → skipDuplicates（重複加唔會報錯、唔會重設已讀）
    const added = add.length ? await tx.workGroupMember.createMany({ data: add.map((staffId) => ({ groupId, staffId, addedById: actorId })), skipDuplicates: true }) : { count: 0 };
    const removed = remove.length ? await tx.workGroupMember.deleteMany({ where: { groupId, staffId: { in: remove } } }) : { count: 0 };
    return { added: added.count, removed: removed.count };
  });
  await prisma.auditLog.create({
    data: {
      staffId: actorId,
      action: "WORKGROUP_UPDATE",
      entity: "WorkGroup",
      entityId: groupId,
      meta: { renamed: input.name !== undefined, archived: input.archived ?? null, added: res.added, removed: res.removed },
    },
  });
  return { added: add, removed: remove };
}

/** 老闆揀成員用：全部 active 員工（只回 id／名／角色） */
export async function staffDirectory(): Promise<{ id: string; name: string; role: string }[]> {
  return prisma.staffUser.findMany({ where: { active: true }, select: { id: true, name: true, role: true }, orderBy: { name: "asc" } });
}

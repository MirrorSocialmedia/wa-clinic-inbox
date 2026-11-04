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
 *
 * ★ 第 2 期（cwi-workgroup-p2-20261105）：
 * - 分享並放手：分享同時將對話放返「未指派」（只限負責人／管理員）；卡出「我接」→ 第一個撳嘅成員接手
 *   （卡 claimedById 條件式搶 + assignVersion 樂觀鎖雙保險；銷售保護病人只有負責銷售／被轉交同事接到）
 * - 附件：JPG／PNG／PDF（magic bytes 判斷），碟上加密；只有成員攞到（GET /api/workgroups/files/<key>）
 * - 置頂：每群最多 3 條；已讀人數：只計自己發嘅訊息（按成員 lastReadAt）；搜尋：內文／檔名
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
      prisma.workGroupMessage.findFirst({ where: { groupId: m.groupId }, orderBy: { createdAt: "desc" }, select: { senderId: true, body: true, conversationId: true, attachName: true } }),
    ]);
    let lastPreview: string | null = null;
    if (last) {
      const who = (await staffNames([last.senderId])).get(last.senderId)?.name ?? "同事";
      lastPreview = `${who}：${previewOf(last).slice(0, 60)}`;
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
  /** 而家負責人名（冇權 → null） */
  assigneeName: string | null;
}

export interface GroupMessageView {
  id: string;
  senderId: string;
  senderName: string;
  mine: boolean;
  body: string;
  mentions: { id: string; name: string }[];
  card: ConvCard | null;
  /** 分享並放手：released=true；claimedByName = 撳「我接」接咗手嘅人 */
  released: boolean;
  claimedByName: string | null;
  claimedAt: string | null;
  /** 而家仲可以撳「我接」（有權 + 放手咗 + 未有人接 + 對話仲係未指派） */
  claimable: boolean;
  attachment: { key: string; name: string; mime: string; size: number } | null;
  pinned: boolean;
  /** 只限自己發嘅訊息：已讀人數／應讀人數 + 已讀名單 */
  read: { count: number; total: number; names: string[] } | null;
  createdAt: string;
}

export interface PinnedView {
  id: string;
  senderName: string;
  preview: string;
  pinnedAt: string;
}

export const WG_PIN_MAX = 3;
export const WG_SEARCH_MAX = 30;

/** 對話卡：按睇嘅人權限即時查（冇權 → allowed=false，唔回病人資料） */
type CardInternal = ConvCard & { unassigned: boolean };

async function resolveCards(convIds: string[], viewer: Viewer): Promise<Map<string, CardInternal>> {
  const out = new Map<string, CardInternal>();
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
  const assignees = await staffNames(convs.map((c) => c.assigneeId).filter((x): x is string => !!x));
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
            assigneeName: c.assigneeId ? (assignees.get(c.assigneeId)?.name ?? "同事") : null,
            unassigned: !c.assigneeId,
          }
        : { conversationId: c.id, allowed, name: null, patientCode: null, clinicCode: null, salesIntent: null, lastAt: null, assigneeName: null, unassigned: false },
    );
  }
  // 對話已刪 → 當冇權（唔洩任何嘢）
  for (const id of convIds)
    if (!out.has(id)) out.set(id, { conversationId: id, allowed: false, name: null, patientCode: null, clinicCode: null, salesIntent: null, lastAt: null, assigneeName: null, unassigned: false });
  return out;
}

type MsgRow = Prisma.WorkGroupMessageGetPayload<object>;

/** 訊息 rows → view（對話卡按睇嘅人權限；已讀只計自己發嘅） */
async function toViews(rows: MsgRow[], groupId: string, viewer: Viewer): Promise<GroupMessageView[]> {
  const memberRows = await prisma.workGroupMember.findMany({ where: { groupId }, select: { staffId: true, lastReadAt: true } });
  const names = await staffNames([
    ...rows.flatMap((r) => [r.senderId, ...r.mentions, ...(r.claimedById ? [r.claimedById] : [])]),
    ...memberRows.map((m) => m.staffId),
  ]);
  const cards = await resolveCards(rows.map((r) => r.conversationId).filter((x): x is string => !!x), viewer);
  return rows.map((r) => {
    const card = r.conversationId ? (cards.get(r.conversationId) ?? null) : null;
    let read: GroupMessageView["read"] = null;
    if (r.senderId === viewer.staff.id) {
      const others = memberRows.filter((m) => m.staffId !== r.senderId);
      const readers = others.filter((m) => m.lastReadAt && m.lastReadAt >= r.createdAt);
      read = { count: readers.length, total: others.length, names: readers.map((m) => names.get(m.staffId)?.name ?? "同事") };
    }
    let cardOut: ConvCard | null = null;
    if (card) {
      const { unassigned: _u, ...rest } = card;
      void _u;
      cardOut = rest;
    }
    return {
      id: r.id,
      senderId: r.senderId,
      senderName: names.get(r.senderId)?.name ?? "同事",
      mine: r.senderId === viewer.staff.id,
      body: r.body,
      mentions: r.mentions.map((id) => ({ id, name: names.get(id)?.name ?? "同事" })),
      card: cardOut,
      released: r.released,
      claimedByName: r.claimedById ? (names.get(r.claimedById)?.name ?? "同事") : null,
      claimedAt: r.claimedAt?.toISOString() ?? null,
      claimable: !!card && card.allowed && r.released && !r.claimedById && card.unassigned,
      attachment: r.attachKey ? { key: r.attachKey, name: r.attachName ?? "檔案", mime: r.attachMime ?? "application/octet-stream", size: r.attachSize ?? 0 } : null,
      pinned: !!r.pinnedAt,
      read,
      createdAt: r.createdAt.toISOString(),
    };
  });
}

function previewOf(r: { body: string; conversationId: string | null; attachName: string | null }): string {
  if (r.body) return r.body.slice(0, 80);
  if (r.attachName) return `〔檔案〕${r.attachName}`;
  if (r.conversationId) return "〔分享咗一個對話〕";
  return "";
}

export async function groupMessages(
  groupId: string,
  viewer: Viewer,
  opts: { before?: string | null; limit?: number } = {},
): Promise<{
  group: { id: string; name: string; archived: boolean; members: { id: string; name: string; active: boolean }[] };
  messages: GroupMessageView[];
  pinned: PinnedView[];
  hasMore: boolean;
}> {
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
  const [memberRows, pinRows] = await Promise.all([
    prisma.workGroupMember.findMany({ where: { groupId }, select: { staffId: true } }),
    prisma.workGroupMessage.findMany({ where: { groupId, pinnedAt: { not: null } }, orderBy: { pinnedAt: "desc" }, take: WG_PIN_MAX }),
  ]);
  const names = await staffNames([...memberRows.map((r) => r.staffId), ...pinRows.map((r) => r.senderId)]);
  return {
    group: {
      id: m.group.id,
      name: m.group.name,
      archived: !!m.group.archivedAt,
      members: memberRows
        .map((r) => ({ id: r.staffId, name: names.get(r.staffId)?.name ?? "（已刪員工）", active: names.get(r.staffId)?.active ?? false }))
        .sort((a, b) => a.name.localeCompare(b.name, "zh-HK")),
    },
    messages: await toViews(page, groupId, viewer),
    pinned: pinRows.map((r) => ({ id: r.id, senderName: names.get(r.senderId)?.name ?? "同事", preview: previewOf(r), pinnedAt: r.pinnedAt!.toISOString() })),
    hasMore: rows.length > limit,
  };
}

/** 搜尋（內文／檔名；唔分大小寫）— 只限成員；最新先，最多 30 條 */
export async function searchGroupMessages(groupId: string, viewer: Viewer, rawQ: string): Promise<GroupMessageView[]> {
  await membership(groupId, viewer.staff.id);
  const raw = (rawQ ?? "").trim().slice(0, 50);
  if (!raw) throw new WorkGroupError(400, "EMPTY_QUERY", "請輸入要搵嘅字");
  // Prisma contains 唔會 escape LIKE 萬用字（% _ \）→ 自己 escape，否則「%」= 搵晒全部
  const q = raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const rows = await prisma.workGroupMessage.findMany({
    where: { groupId, OR: [{ body: { contains: q, mode: "insensitive" } }, { attachName: { contains: q, mode: "insensitive" } }] },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: WG_SEARCH_MAX,
  });
  return toViews(rows, groupId, viewer);
}

/** 置頂／取消置頂（成員都得；封存唔得；每群最多 3 條） */
export async function pinGroupMessage(groupId: string, messageId: string, staffId: string, pin: boolean): Promise<void> {
  const m = await membership(groupId, staffId);
  if (m.group.archivedAt) throw new WorkGroupError(409, "ARCHIVED", "呢個群組已封存");
  const msg = await prisma.workGroupMessage.findFirst({ where: { id: messageId, groupId }, select: { id: true, pinnedAt: true } });
  if (!msg) throw new WorkGroupError(404, "MSG_NOT_FOUND", "搵唔到呢條訊息");
  if (!pin) {
    await prisma.workGroupMessage.updateMany({ where: { id: messageId, groupId }, data: { pinnedAt: null, pinnedById: null } });
    return;
  }
  if (msg.pinnedAt) return; // 已置頂 = 冪等
  // 上限：同一群並發置頂 → 行鎖（群 row）序列化後先數
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "WorkGroup" WHERE id = ${groupId} FOR UPDATE`;
    const n = await tx.workGroupMessage.count({ where: { groupId, pinnedAt: { not: null } } });
    if (n >= WG_PIN_MAX) throw new WorkGroupError(409, "PIN_LIMIT", `每個群最多置頂 ${WG_PIN_MAX} 條 — 請先取消一條`);
    await tx.workGroupMessage.updateMany({ where: { id: messageId, groupId, pinnedAt: null }, data: { pinnedAt: new Date(), pinnedById: staffId } });
  });
}

export interface SendInput {
  body: string;
  mentions?: string[];
  conversationId?: string | null;
  clientKey?: string | null;
  /** 分享並放手（要有 conversationId） */
  release?: boolean;
  /** 附件（route 已落碟加密；呢度只記 metadata） */
  attachment?: { key: string; name: string; mime: string; size: number } | null;
}

export interface SendResult {
  messageId: string;
  duplicate: boolean;
  /** 發送後要通知嘅成員（唔包自己）— caller commit 後 publish */
  notify: string[];
  /** 被 @ 而又係成員嘅人（唔包自己） */
  mentioned: string[];
  groupName: string;
  /** 分享並放手：對話已放返未指派（false = 本來就冇負責人，或者放手失敗 — 見 releaseFailed） */
  released: boolean;
  releaseFailed: boolean;
  conversationId: string | null;
}

export async function sendGroupMessage(groupId: string, sender: Viewer, input: SendInput): Promise<SendResult> {
  const m = await membership(groupId, sender.staff.id);
  if (m.group.archivedAt) throw new WorkGroupError(409, "ARCHIVED", "呢個群組已封存，唔可以再發訊息");
  const body = (input.body ?? "").trim();
  if (body.length > WG_BODY_MAX) throw new WorkGroupError(400, "TOO_LONG", `訊息太長（最多 ${WG_BODY_MAX} 字）`);
  const conversationId = input.conversationId || null;
  const attachment = input.attachment ?? null;
  if (!body && !conversationId && !attachment) throw new WorkGroupError(400, "EMPTY", "訊息唔可以空白");
  if (input.release && !conversationId) throw new WorkGroupError(400, "RELEASE_NEEDS_CONV", "放手要連住分享對話");
  let releaseFrom: string | null = null;
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
    if (input.release && conv.assigneeId) {
      // 放手 = 只限現任負責人（或全店管理員）— 同 assign route RELEASE 規則一致
      const { assertCanAssign } = await import("@/lib/assign");
      try {
        assertCanAssign(sender, conv, null);
      } catch {
        throw new WorkGroupError(403, "RELEASE_FORBIDDEN", "你唔係呢個對話嘅負責人，唔可以放手（可以只係分享）");
      }
      releaseFrom = conv.assigneeId;
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
        data: {
          groupId,
          senderId: sender.staff.id,
          body,
          mentions: mentioned,
          conversationId,
          clientKey,
          released: !!input.release,
          ...(attachment ? { attachKey: attachment.key, attachName: attachment.name, attachMime: attachment.mime, attachSize: attachment.size } : {}),
        },
      });
      await tx.workGroup.update({ where: { id: groupId }, data: { lastMessageAt: created.createdAt } });
      // 自己發 = 自己已讀
      await tx.workGroupMember.update({ where: { groupId_staffId: { groupId, staffId: sender.staff.id } }, data: { lastReadAt: created.createdAt } });
      return created;
    });
    log.info({ groupId, messageId: msg.id, bodyLen: body.length, mentions: mentioned.length, card: !!conversationId, release: !!input.release, attach: !!attachment }, "workgroup: message sent");
    let released = false;
    let releaseFailed = false;
    if (input.release && conversationId && releaseFrom) {
      try {
        const { assignConversation } = await import("@/lib/assign");
        await assignConversation({
          conversationId,
          toStaffId: null,
          by: "STAFF",
          byStaffId: sender.staff.id,
          note: `放手 — 已分享去工作群「${m.group.name}」等同事接手`,
        });
        released = true;
      } catch (err) {
        // 放手失敗（例如啱啱被人轉交）→ 卡唔出「我接」（補償：released=false），分享照成功
        releaseFailed = true;
        await prisma.workGroupMessage.update({ where: { id: msg.id }, data: { released: false } }).catch(() => undefined);
        log.warn({ groupId, messageId: msg.id, err: err instanceof Error ? err.message : String(err) }, "workgroup: share-release unassign failed（已補償）");
      }
    }
    return { messageId: msg.id, duplicate: false, notify, mentioned, groupName: m.group.name, released, releaseFailed, conversationId };
  } catch (e) {
    if (clientKey && e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const prev = await prisma.workGroupMessage.findUnique({ where: { senderId_clientKey: { senderId: sender.staff.id, clientKey } } });
      if (prev && prev.groupId === groupId)
        return { messageId: prev.id, duplicate: true, notify: [], mentioned: [], groupName: m.group.name, released: false, releaseFailed: false, conversationId: prev.conversationId };
      throw new WorkGroupError(409, "DUPLICATE_KEY", "重複發送");
    }
    throw e;
  }
}

/**
 * 卡上「我接」：成員 + 睇得到呢個對話 + 放手咗 + 未有人接 + 對話仲係未指派 → 接手（assign 俾自己）。
 * 並發：卡 claimedById 條件式搶（得一個贏）+ assignVersion 樂觀鎖（防同一時間有人喺收件箱接咗）。
 */
export async function claimSharedConversation(groupId: string, messageId: string, viewer: Viewer): Promise<{ conversationId: string; groupName: string }> {
  const m = await membership(groupId, viewer.staff.id);
  if (m.group.archivedAt) throw new WorkGroupError(409, "ARCHIVED", "呢個群組已封存");
  const msg = await prisma.workGroupMessage.findFirst({ where: { id: messageId, groupId } });
  if (!msg || !msg.conversationId) throw new WorkGroupError(404, "MSG_NOT_FOUND", "搵唔到呢張對話卡");
  if (!msg.released) throw new WorkGroupError(409, "NOT_RELEASED", "呢張卡冇放手 — 唔使接");
  if (msg.claimedById) {
    const who = (await staffNames([msg.claimedById])).get(msg.claimedById)?.name ?? "同事";
    throw new WorkGroupError(409, "ALREADY_CLAIMED", msg.claimedById === viewer.staff.id ? "你已經接咗" : `已經有人接咗（${who}）`);
  }
  const conv = await prisma.conversation.findUnique({ where: { id: msg.conversationId } });
  if (!conv) throw new WorkGroupError(404, "CONV_NOT_FOUND", "呢個對話已經唔存在");
  try {
    await assertConversationAccess(viewer, conv);
  } catch {
    throw new WorkGroupError(403, "CONV_FORBIDDEN", "你冇權睇呢間店嘅對話，接唔到");
  }
  if (viewer.staff.role === "SUPERVISOR") throw new WorkGroupError(403, "SUPERVISOR_READONLY", "主管帳號唔可以做負責人");
  if (conv.assigneeId) {
    const who = (await staffNames([conv.assigneeId])).get(conv.assigneeId)?.name ?? "同事";
    throw new WorkGroupError(409, "ALREADY_ASSIGNED", conv.assigneeId === viewer.staff.id ? "你已經係負責人" : `已經有人跟緊（${who}）`);
  }
  const { assertCanAssign, assignConversation, AssignError } = await import("@/lib/assign");
  try {
    assertCanAssign(viewer, conv, viewer.staff.id);
  } catch {
    throw new WorkGroupError(403, "CLAIM_FORBIDDEN", "呢個對話唔係你間店，接唔到");
  }
  const { conversationSalesLock, canReplyUnderLock } = await import("@/lib/sales/core");
  const lock = await conversationSalesLock(conv.id);
  if (!canReplyUnderLock(lock, viewer.staff.id)) {
    const names = [...new Set(lock.owners.map((o) => o.name))].join("／");
    throw new WorkGroupError(423, "SALES_LOCKED", `${names} 負責呢個病人（銷售）— 要佢轉交先接到`);
  }
  // 1) 卡條件式搶（第一個贏）
  const claimedAt = new Date();
  const won = await prisma.workGroupMessage.updateMany({ where: { id: msg.id, claimedById: null, released: true }, data: { claimedById: viewer.staff.id, claimedAt } });
  if (won.count === 0) throw new WorkGroupError(409, "ALREADY_CLAIMED", "已經有人接咗");
  // 2) 真正接手（樂觀鎖：期間有人喺收件箱接咗 → 409，卡還原）
  try {
    await assignConversation({
      conversationId: conv.id,
      toStaffId: viewer.staff.id,
      by: "STAFF",
      byStaffId: viewer.staff.id,
      note: `喺工作群「${m.group.name}」接手`,
      expectedAssignVersion: conv.assignVersion,
    });
  } catch (err) {
    await prisma.workGroupMessage.updateMany({ where: { id: msg.id, claimedById: viewer.staff.id }, data: { claimedById: null, claimedAt: null } });
    if (err instanceof AssignError && err.code === "ASSIGN_CONFLICT") throw new WorkGroupError(409, "ALREADY_ASSIGNED", "啱啱有人接咗呢個對話");
    throw err;
  }
  await prisma.auditLog.create({ data: { staffId: viewer.staff.id, action: "WORKGROUP_CLAIM", entity: "WorkGroupMessage", entityId: msg.id, meta: { groupId, conversationId: conv.id } } });
  return { conversationId: conv.id, groupName: m.group.name };
}

/**
 * 標記已讀（只向前推）。回 true = 今次真係讀到新訊息（caller 先通知其他成員更新「已讀人數」—
 * 冇新訊息唔發，防兩邊 reload → read → reload 無限迴圈）。
 */
export async function markGroupRead(groupId: string, staffId: string, now: Date = new Date()): Promise<boolean> {
  const m = await membership(groupId, staffId);
  const since = m.lastReadAt ?? m.addedAt;
  const newer = await prisma.workGroupMessage.findFirst({ where: { groupId, senderId: { not: staffId }, createdAt: { gt: since, lte: now } }, select: { id: true } });
  // 只向前推（舊 tab 遲到嘅 read 唔會倒退）
  await prisma.workGroupMember.updateMany({
    where: { groupId, staffId, OR: [{ lastReadAt: null }, { lastReadAt: { lt: now } }] },
    data: { lastReadAt: now },
  });
  return !!newer;
}

/** 發訊息前置（附件 route 落碟前先驗 — 非成員／封存唔准寫檔落碟） */
export async function assertCanPost(groupId: string, staffId: string): Promise<void> {
  const m = await membership(groupId, staffId);
  if (m.group.archivedAt) throw new WorkGroupError(409, "ARCHIVED", "呢個群組已封存，唔可以再發訊息");
}

/** clientKey 重發：已存在 → 回舊訊息 id（附件 route 唔使再落碟） */
export async function findByClientKey(groupId: string, staffId: string, clientKey: string | null): Promise<string | null> {
  if (!clientKey || !/^[A-Za-z0-9_-]{8,64}$/.test(clientKey)) return null;
  const prev = await prisma.workGroupMessage.findUnique({ where: { senderId_clientKey: { senderId: staffId, clientKey } }, select: { id: true, groupId: true } });
  return prev && prev.groupId === groupId ? prev.id : null;
}

/** 附件檔：只有該群成員攞到；唔係成員／唔存在 → null（route 一律 404，唔洩露存在性） */
export async function attachmentForViewer(key: string, staffId: string): Promise<{ name: string; mime: string } | null> {
  const msg = await prisma.workGroupMessage.findUnique({ where: { attachKey: key }, select: { groupId: true, attachName: true, attachMime: true } });
  if (!msg) return null;
  const mem = await prisma.workGroupMember.findUnique({ where: { groupId_staffId: { groupId: msg.groupId, staffId } }, select: { staffId: true } });
  if (!mem) return null;
  return { name: msg.attachName ?? key, mime: msg.attachMime ?? "application/octet-stream" };
}

/** 附件顯示名：去路徑／控制字元，限 100 字，副檔名跟真實類型 */
export function cleanAttachName(raw: string | null | undefined, ext: string): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const s = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").trim().slice(0, 100);
  const stem = (s.replace(/\.[A-Za-z0-9]{1,5}$/, "") || (ext === "pdf" ? "文件" : "相片")).slice(0, 100);
  return `${stem}.${ext}`;
}

export async function groupMemberIds(groupId: string): Promise<string[]> {
  return (await prisma.workGroupMember.findMany({ where: { groupId }, select: { staffId: true } })).map((r) => r.staffId);
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

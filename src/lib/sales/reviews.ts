/**
 * ★ cwi-sales 第 2 期：老闆對單隊列（workforce SalesReview）+ inbox 補返銷售名、病人編號、對話連結。
 *
 * kind：RECONCILE_UNPROTECTED（保護外病人開單）／RECONCILE_DIRECT（Apricot 直接開兼填銷售員）／
 *       RECONCILE_MISMATCH（inbox 開嘅單，Apricot 上銷售員被改咗）／APPEAL_NO_PUNCH（開單日冇喺嗰間店打卡）／
 *       INVOICE_EDITED（單喺 Apricot 被改 — 只係通知）／RECONCILE_OWNED（★ 第 5 期：前台幫銷售負責嘅病人開單冇填銷售員）
 * 決定：APPROVED（可批部分 %）／REJECTED（要原因）／ACKNOWLEDGED（只限 INVOICE_EDITED）— 只限集團管理員；workforce 判冪等／並發。
 *
 * ★ 第 5 期：
 * - 中文標籤 + 證據（銷售喺病人對話嘅訊息數、最後一次覆 — 判申訴用）
 * - 批「保護外開單／Apricot 直接開／前台幫你開」→ 病人冇人負責（或者係自己保護中）就綁定畀嗰個銷售（R4）
 * - 決定之後通知銷售（U4）；銷售可以喺「我的銷售」補充原因（只限未決定）
 */
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { notifyStaffDirect, patientConversationIds } from "@/lib/sales/core";
import { decideSalesReview, fetchSalesReviews, postReviewSalesNote, WorkforceApiError, type SalesReviewRow } from "@/lib/workforce/client";
import { SalesActionError } from "@/lib/sales/handover";

/** 對單類別 → 廣東話（老闆／銷售都用） */
export const REVIEW_KIND_LABELS: Record<string, string> = {
  RECONCILE_UNPROTECTED: "保護外病人開單",
  RECONCILE_DIRECT: "Apricot 直接開單（有填銷售員）",
  RECONCILE_MISMATCH: "Apricot 上銷售員被改",
  RECONCILE_OWNED: "前台幫負責銷售嘅病人開單（冇填銷售員）",
  APPEAL_NO_PUNCH: "開單日冇喺嗰間店打卡（申訴）",
  INVOICE_EDITED: "單喺 Apricot 被修改（通知）",
};
export const reviewKindLabel = (kind: string): string => REVIEW_KIND_LABELS[kind] ?? kind;

/** 批咗要收養入傭金追蹤（要對返 inbox 銷售帳號）嘅類別 */
const ADOPT_KINDS = new Set(["RECONCILE_DIRECT", "RECONCILE_OWNED"]);
/** 批咗就綁定病人畀嗰個銷售（R4）嘅類別 */
const BIND_KINDS = new Set(["RECONCILE_UNPROTECTED", "RECONCILE_DIRECT", "RECONCILE_OWNED"]);

export interface ReviewEvidence {
  /** 開單前 30 日，呢個銷售喺病人對話發咗幾多個訊息 */
  staffMessages: number;
  /** 同期病人發咗幾多個訊息 */
  patientMessages: number;
  /** 呢個銷售最後一次喺病人對話發訊息（≤ 開單時間） */
  lastStaffMessageAt: string | null;
}

export interface ReviewView extends SalesReviewRow {
  kindLabel: string;
  salesStaffId: string | null;
  salesStaffName: string | null;
  patientCode: string | null;
  patientName: string | null;
  conversationId: string | null;
  evidence: ReviewEvidence | null;
}

const EVIDENCE_DAYS = 30;

async function evidenceFor(staffId: string, convIds: string[], at: Date): Promise<ReviewEvidence> {
  if (convIds.length === 0) return { staffMessages: 0, patientMessages: 0, lastStaffMessageAt: null };
  const since = new Date(at.getTime() - EVIDENCE_DAYS * 86_400_000);
  const window = { conversationId: { in: convIds }, createdAt: { gte: since, lte: at } };
  const [staffMessages, patientMessages, last] = await Promise.all([
    prisma.message.count({ where: { ...window, direction: "OUT", sentByStaffId: staffId } }),
    prisma.message.count({ where: { ...window, direction: "IN" } }),
    prisma.message.findFirst({ where: { ...window, direction: "OUT", sentByStaffId: staffId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);
  return { staffMessages, patientMessages, lastStaffMessageAt: last?.createdAt.toISOString() ?? null };
}

async function decorate(rows: SalesReviewRow[], withEvidence: boolean): Promise<ReviewView[]> {
  const salesIds = [...new Set(rows.map((r) => r.salesApricotUserId).filter((x): x is string => !!x))];
  const pids = [...new Set(rows.map((r) => r.patientApricotId).filter((x): x is string => !!x))];
  const [staff, links] = await Promise.all([
    prisma.staffUser.findMany({ where: { salesApricotUserId: { in: salesIds } }, select: { id: true, name: true, salesApricotUserId: true } }),
    prisma.contactPatientLink.findMany({ where: { patientApricotId: { in: pids } }, select: { patientApricotId: true, patientCode: true, patientName: true } }),
  ]);
  const staffOf = new Map(staff.map((s) => [s.salesApricotUserId!, s]));
  const linkOf = new Map(links.map((l) => [l.patientApricotId, l]));
  const convsOf = new Map<string, string[]>();
  for (const pid of pids.slice(0, 200)) convsOf.set(pid, await patientConversationIds(pid));
  const out: ReviewView[] = [];
  for (const r of rows) {
    const l = r.patientApricotId ? linkOf.get(r.patientApricotId) : undefined;
    const s = r.salesApricotUserId ? staffOf.get(r.salesApricotUserId) : undefined;
    const convs = r.patientApricotId ? (convsOf.get(r.patientApricotId) ?? []) : [];
    out.push({
      ...r,
      kindLabel: reviewKindLabel(r.kind),
      salesStaffId: s?.id ?? null,
      salesStaffName: s?.name ?? null,
      patientCode: l?.patientCode ?? null,
      patientName: l?.patientName ?? null,
      conversationId: convs[0] ?? null,
      // 證據只計未決定嗰啲（老闆判緊）— 已決定唔使再查
      evidence: withEvidence && s && r.status === "OPEN" ? await evidenceFor(s.id, convs, new Date(r.createdAt)) : null,
    });
  }
  return out;
}

export async function listSalesReviews(status: string | null): Promise<ReviewView[]> {
  return decorate(await fetchSalesReviews(status), true);
}

/** ★ U4：銷售自己嘅對單／扣起項目（冇病人名 — 只編號；冇證據） */
export async function mySalesReviews(staffId: string): Promise<ReviewView[]> {
  const me = await prisma.staffUser.findUnique({ where: { id: staffId }, select: { salesApricotUserId: true } });
  if (!me?.salesApricotUserId) return [];
  const rows = await fetchSalesReviews(null, me.salesApricotUserId);
  const recent = rows.filter((r) => r.status === "OPEN" || (r.decidedAt && Date.now() - new Date(r.decidedAt).getTime() < 60 * 86_400_000));
  return (await decorate(recent.slice(0, 100), false)).map((r) => ({ ...r, patientName: null }));
}

/** ★ 第 5 期：銷售補充原因（只限自己張單、未決定）— salesApricotUserId 由登入帳號攞，唔信 client */
export async function addSalesNote(id: string, note: string, staffId: string): Promise<void> {
  const me = await prisma.staffUser.findUnique({ where: { id: staffId }, select: { isSales: true, active: true, salesApricotUserId: true } });
  if (!me?.isSales || !me.active || !me.salesApricotUserId) throw new SalesActionError(403, "NOT_SALES", "只有綁咗 Apricot 銷售員帳號嘅銷售可以補充");
  const text = note.trim();
  if (!text || text.length > 500) throw new SalesActionError(400, "BAD_NOTE", "補充內容 1–500 字");
  try {
    await postReviewSalesNote(id, { salesApricotUserId: me.salesApricotUserId, note: text }, staffId);
  } catch (err) {
    if (err instanceof WorkforceApiError) {
      const msg: Record<string, string> = { NOT_YOUR_REVIEW: "呢項唔係你張單", ALREADY_DECIDED: "老闆已經決定咗 — 唔可以再補充", NOT_FOUND: "搵唔到呢項" };
      const st = err.status >= 400 && err.status < 500 ? err.status : 503;
      throw new SalesActionError(st, err.code ?? "WORKFORCE_ERROR", msg[err.code ?? ""] ?? "暫時連唔到 workforce — 請稍後再試");
    }
    throw err;
  }
  await prisma.auditLog.create({ data: { staffId, action: "SALES_REVIEW_NOTE", entity: "SalesReview", entityId: id, meta: { length: text.length } } });
}

/**
 * 老闆決定：RECONCILE_DIRECT／RECONCILE_OWNED 批 → 由 Apricot 銷售員 id 對返 inbox 銷售帳號（收養張單入傭金追蹤）；
 * 對唔返（未綁）→ 409，唔會批咗之後冇人收傭金。INVOICE_EDITED → 只可以 ACKNOWLEDGED。
 */
export async function decideReviewFromInbox(
  id: string,
  body: { decision: "APPROVED" | "REJECTED" | "ACKNOWLEDGED"; approvedPct?: number | null; note?: string | null },
  byStaffId: string
): Promise<{ bound: boolean }> {
  const r = (await fetchSalesReviews("OPEN")).find((x) => x.id === id) ?? null;
  if (r && (r.kind === "INVOICE_EDITED") !== (body.decision === "ACKNOWLEDGED")) {
    throw new SalesActionError(400, "BAD_DECISION", r.kind === "INVOICE_EDITED" ? "單被修改只係通知 — 撳「已知悉」" : "呢項要批或者拒絕");
  }
  const staff = r?.salesApricotUserId
    ? await prisma.staffUser.findUnique({ where: { salesApricotUserId: r.salesApricotUserId }, select: { id: true, isSales: true, active: true, workforceEmployeeId: true } })
    : null;
  let adopt: { inboxStaffId: string; employeeId: string | null } | null = null;
  if (body.decision === "APPROVED" && r && ADOPT_KINDS.has(r.kind)) {
    if (!staff?.isSales || !staff.active) throw new SalesActionError(409, "SALES_NOT_BOUND", "呢張單嘅 Apricot 銷售員未綁 inbox 銷售帳號 — 請先喺員工帳號綁定，或者拒絕");
    adopt = { inboxStaffId: staff.id, employeeId: staff.workforceEmployeeId };
  }
  await decideSalesReview(id, { ...body, adopt }, byStaffId);
  if (!r || !staff) return { bound: false };

  // R4：批咗保護外／直接開／前台幫開 → 病人冇人負責（或者係佢自己保護中）就綁定畀佢
  let bound = false;
  if (body.decision === "APPROVED" && BIND_KINDS.has(r.kind) && r.patientApricotId && staff.isSales && staff.active) {
    bound = await bindOnApproval(r.patientApricotId, staff.id, r.id, byStaffId);
  }
  // U4：通知銷售（零病人資料：只單號）
  const verb = body.decision === "APPROVED" ? `已批（${body.approvedPct ?? 100}%）` : body.decision === "REJECTED" ? "已拒絕" : "已知悉";
  await notifyStaffDirect([staff.id], "SALES_REVIEW", `銷售 · ${reviewKindLabel(r.kind)}：單 ${r.apricotBillCode ?? ""} ${verb}`.replace(/\s+/g, " "), {
    reviewId: r.id,
    decision: body.decision,
  });
  return { bound };
}

/** 冇人負責（或者公海）→ BOUND；自己保護中 → BOUND；其他銷售負責 → 唔郁。advisory lock 同落單串行 */
async function bindOnApproval(patientApricotId: string, staffId: string, reviewId: string, byStaffId: string): Promise<boolean> {
  try {
    const changed = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sales:${patientApricotId}`}))`;
      const own = await tx.salesOwnership.findUnique({ where: { patientApricotId } });
      if (own && own.state === "BOUND") return false;
      if (own && own.state === "PROTECTED" && own.salesStaffId !== staffId) return false;
      const data = { state: "BOUND" as const, salesStaffId: staffId, lastSalesStaffId: staffId, protectedUntil: null, rounds: 0, noShowStreak: 0, highValue: false, expiryRemindedFor: null, since: new Date() };
      await tx.salesOwnership.upsert({ where: { patientApricotId }, create: { patientApricotId, ...data }, update: data });
      await tx.auditLog.create({
        data: { staffId: byStaffId, action: "SALES_OWNER_BOUND", entity: "SalesOwnership", entityId: patientApricotId, meta: { reviewId, toStaffId: staffId, reason: "REVIEW_APPROVED" } as Prisma.InputJsonValue },
      });
      return true;
    });
    return changed;
  } catch (err) {
    log.warn({ reviewId, err: err instanceof Error ? err.message : String(err) }, "sales: 批單後綁定失敗（best-effort）");
    return false;
  }
}

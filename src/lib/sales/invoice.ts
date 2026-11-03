/**
 * ★ cwi-sales 第 2 期：銷售喺對話右欄開 invoice（workforce 用系統帳號寫 Apricot，sales = 銷售本人）。
 *
 * inbox 負責「邊個可以開、幫邊個病人開」（歸屬喺 inbox）：
 * - 只限 active 銷售人員，兼綁咗 Apricot 銷售員帳號
 * - 病人一定要連住呢個對話（釘選／認咗／家人連結），兼有 Apricot 病人編號
 * - 病人由其他銷售保護中／綁定 → 403（唔可以幫人開單）；對話被其他銷售鎖住 → 423
 * - 自己保護中 → PROTECTED；自己綁定 → BOUND；冇人／公海 → NONE（workforce 入老闆對單隊列）
 * - 開單 + 即場收款 + 有傭金項目，而病人係自己保護中 → 即刻轉綁定（設計：開傭金項目單兼收到第一筆錢）
 *
 * 同一 requestKey 重撳 = workforce 冪等重放（唔會開兩張）。審計只記 id／金額（零病人資料）。
 */
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { canReplyUnderLock, conversationPatientIds, conversationSalesLock, getSalesSettings, protectedUntilFor, protectionDaysFor } from "@/lib/sales/core";
import { hkTodayStr } from "@/lib/availability";
import { SalesActionError } from "@/lib/sales/handover";
import { createSalesInvoice, fetchInvoiceOptions, WorkforceApiError, type CreatedInvoice, type InvoiceOptions } from "@/lib/workforce/client";

export type InvoiceOwnership = "MINE_PROTECTED" | "MINE_BOUND" | "NONE" | "OTHER";

export interface InvoicePatient {
  patientApricotId: string;
  code: string | null;
  name: string | null;
  ownership: InvoiceOwnership;
  ownerName: string | null;
}

export interface InvoiceContext {
  /** null = 可以開；否則係原因（UI 直接顯示） */
  blocked: string | null;
  clinicCode: string | null;
  /** ★ 第 5 期（R6）：可以揀嘅開單分店（自己權限範圍內、有 Apricot 連結）；預設 = 對話處理中分店 */
  clinics: { code: string; name: string }[];
  patients: InvoicePatient[];
  /** 預設分店開唔到單、自動改用其他分店時嘅提示（UI 顯示） */
  clinicNote?: string | null;
}

/** 開單分店選擇：scope = null（全集團）或者自己嘅 clinic id 集合 */
export interface InvoiceClinicPick {
  scope?: string[] | null;
  clinicCode?: string | null;
}

async function invoiceClinics(scope: string[] | null | undefined): Promise<{ id: string; code: string; name: string }[]> {
  return prisma.clinic.findMany({
    where: { apricotClinicId: { not: null }, ...(scope ? { id: { in: scope } } : {}) },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true },
  });
}

/**
 * 點解呢間店開唔到單（講清楚原因 — 「冇權」一句令人以為係帳號權限，其實多數係分店未連 Apricot）。
 * 次序：搵唔到 → 帳號範圍外 → 未連 Apricot。
 */
async function clinicDenyReason(where: { code: string } | { id: string }, scope: string[] | null | undefined): Promise<string> {
  const c = await prisma.clinic.findUnique({ where, select: { id: true, code: true, apricotClinicId: true } });
  if (!c) return "搵唔到呢間分店";
  if (scope && !scope.includes(c.id)) return `你嘅帳號冇 ${c.code} 分店權限 — 請老闆喺員工帳號加 ${c.code}`;
  if (!c.apricotClinicId) return `${c.code} 未連 Apricot 分店（診所設定未有 Apricot 分店編號）— 暫時開唔到單`;
  return "你冇權喺呢間店開單";
}

interface Me {
  id: string;
  isSales: boolean;
  active: boolean;
  salesApricotUserId: string | null;
  workforceEmployeeId: string | null;
}

async function loadMe(staffId: string): Promise<Me | null> {
  return prisma.staffUser.findUnique({
    where: { id: staffId },
    select: { id: true, isSales: true, active: true, salesApricotUserId: true, workforceEmployeeId: true },
  });
}

export async function invoiceContext(conversationId: string, staffId: string, pick: InvoiceClinicPick = {}): Promise<InvoiceContext> {
  const me = await loadMe(staffId);
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { contactId: true, pinnedPatientApricotId: true, pinnedPatientName: true, clinicId: true, handlingClinicId: true },
  });
  if (!conv) throw new SalesActionError(404, "NOT_FOUND", "搵唔到對話");
  // 開單分店 = 揀咗嘅分店（要喺自己範圍內）；冇揀 = 處理中分店（轉店後）否則對話分店
  const clinics = await invoiceClinics(pick.scope);
  let clinic: { code: string } | null;
  let clinicDenied: string | null = null;
  let clinicNote: string | null = null;
  if (pick.clinicCode) {
    clinic = clinics.find((c) => c.code === pick.clinicCode) ?? null;
    if (!clinic) throw new SalesActionError(403, "CLINIC_NOT_ALLOWED", await clinicDenyReason({ code: pick.clinicCode }, pick.scope));
  } else {
    clinic = await prisma.clinic.findUnique({ where: { id: conv.handlingClinicId ?? conv.clinicId }, select: { code: true } });
    // ★ 預設分店都要喺可開單分店入面 — 舊版開框正常、撳「開 invoice」先 403「冇權」。
    //   開唔到 → 有其他可開單分店就自動揀第一間 + 提示（可以喺分店揀返）；一間都冇 → blocked 講原因
    if (clinic && !clinics.some((c) => c.code === clinic!.code)) {
      const why = await clinicDenyReason({ code: clinic.code }, pick.scope);
      if (clinics.length > 0) {
        clinicNote = `${why}；已改用 ${clinics[0].code} 開單（請確認分店）`;
        clinic = { code: clinics[0].code };
      } else clinicDenied = why;
    }
  }
  const pids = await conversationPatientIds(conversationId);
  const [links, contact, owns] = await Promise.all([
    prisma.contactPatientLink.findMany({ where: { contactId: conv.contactId }, select: { patientApricotId: true, patientCode: true, patientName: true } }),
    prisma.contact.findUnique({ where: { id: conv.contactId }, select: { identifiedPatientApricotId: true, identifiedPatientCode: true } }),
    prisma.salesOwnership.findMany({ where: { patientApricotId: { in: pids } } }),
  ]);
  const ownerIds = [...new Set(owns.map((o) => o.salesStaffId).filter((x): x is string => !!x))];
  const owners = new Map((await prisma.staffUser.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true, active: true, isSales: true } })).map((s) => [s.id, s]));
  const linkOf = new Map(links.map((l) => [l.patientApricotId, l]));
  const ownOf = new Map(owns.map((o) => [o.patientApricotId, o]));
  const patients: InvoicePatient[] = pids.map((pid) => {
    const l = linkOf.get(pid);
    const o = ownOf.get(pid);
    const owner = o?.salesStaffId ? owners.get(o.salesStaffId) : undefined;
    // 歸屬只認 active 銷售（同對話鎖一致）；停用／唔再係銷售 = 當冇人
    const live = o && (o.state === "PROTECTED" || o.state === "BOUND") && owner?.active && owner.isSales;
    const ownership: InvoiceOwnership = !live ? "NONE" : o!.salesStaffId === staffId ? (o!.state === "BOUND" ? "MINE_BOUND" : "MINE_PROTECTED") : "OTHER";
    return {
      patientApricotId: pid,
      code: l?.patientCode ?? (pid === contact?.identifiedPatientApricotId ? contact.identifiedPatientCode : null) ?? null,
      name: l?.patientName ?? (pid === conv.pinnedPatientApricotId ? conv.pinnedPatientName : null) ?? null,
      ownership,
      ownerName: live && ownership === "OTHER" ? (owner?.name ?? null) : null,
    };
  });
  let blocked: string | null = null;
  if (!me?.isSales || !me.active) blocked = "只有銷售人員可以開單";
  else if (!me.salesApricotUserId) blocked = "你未綁定 Apricot 銷售員帳號 — 請老闆喺員工帳號設定";
  else if (!clinic?.code) blocked = "呢個對話冇分店";
  else if (clinicDenied) blocked = clinicDenied;
  else if (patients.length === 0) blocked = "呢個對話未認病人 — 請先喺右欄搵返病人";
  else {
    const lock = await conversationSalesLock(conversationId);
    if (lock.owners.length > 0 && !canReplyUnderLock(lock, staffId)) blocked = `${[...new Set(lock.owners.map((o) => o.name))].join("／")} 負責呢個對話（銷售）`;
  }
  return { blocked, clinicCode: clinic?.code ?? null, clinics: clinics.map((c) => ({ code: c.code, name: c.name })), patients, clinicNote };
}

/** ★ 第 5 期（U9）：冇對話開單（walk-in／前台轉介）— 病人由銷售搜尋（server 記低搜尋結果，唔信 client 編號） */
export const DIRECT_SEARCH_NS = "sales-direct";

export interface DirectPatient {
  patientApricotId: string;
  patientCode: string;
  patientName: string;
}

export async function invoiceContextForPatient(staffId: string, patient: DirectPatient, pick: InvoiceClinicPick = {}): Promise<InvoiceContext> {
  const me = await loadMe(staffId);
  const clinics = await invoiceClinics(pick.scope);
  const clinic = pick.clinicCode ? (clinics.find((c) => c.code === pick.clinicCode) ?? null) : (clinics[0] ?? null);
  if (pick.clinicCode && !clinic) throw new SalesActionError(403, "CLINIC_NOT_ALLOWED", await clinicDenyReason({ code: pick.clinicCode }, pick.scope));
  const o = await prisma.salesOwnership.findUnique({ where: { patientApricotId: patient.patientApricotId } });
  const owner = o?.salesStaffId ? await prisma.staffUser.findUnique({ where: { id: o.salesStaffId }, select: { name: true, active: true, isSales: true } }) : null;
  const live = o && (o.state === "PROTECTED" || o.state === "BOUND") && owner?.active && owner.isSales;
  const ownership: InvoiceOwnership = !live ? "NONE" : o!.salesStaffId === staffId ? (o!.state === "BOUND" ? "MINE_BOUND" : "MINE_PROTECTED") : "OTHER";
  let blocked: string | null = null;
  if (!me?.isSales || !me.active) blocked = "只有銷售人員可以開單";
  else if (!me.salesApricotUserId) blocked = "你未綁定 Apricot 銷售員帳號 — 請老闆喺員工帳號設定";
  else if (!clinic) blocked = "你冇可以開單嘅分店";
  return {
    blocked,
    clinicCode: clinic?.code ?? null,
    clinics: clinics.map((c) => ({ code: c.code, name: c.name })),
    patients: [{ patientApricotId: patient.patientApricotId, code: patient.patientCode, name: patient.patientName, ownership, ownerName: ownership === "OTHER" ? (owner?.name ?? null) : null }],
  };
}

export async function invoiceOptionsForPatient(
  staffId: string,
  patient: DirectPatient,
  pick: InvoiceClinicPick = {}
): Promise<{ context: InvoiceContext; options: InvoiceOptions | null; optionsError: string | null }> {
  const context = await invoiceContextForPatient(staffId, patient, pick);
  if (context.blocked || !context.clinicCode) return { context, options: null, optionsError: null };
  try {
    return { context, options: await fetchInvoiceOptions(context.clinicCode), optionsError: null };
  } catch (err) {
    log.warn({ code: err instanceof WorkforceApiError ? err.code : undefined }, "sales: invoice options failed (direct)");
    return { context, options: null, optionsError: "暫時拎唔到收費項目同醫生名單 — 請稍後再試" };
  }
}

export async function invoiceOptionsFor(
  conversationId: string,
  staffId: string,
  pick: InvoiceClinicPick = {}
): Promise<{ context: InvoiceContext; options: InvoiceOptions | null; optionsError: string | null }> {
  const context = await invoiceContext(conversationId, staffId, pick);
  if (context.blocked || !context.clinicCode) return { context, options: null, optionsError: null };
  try {
    return { context, options: await fetchInvoiceOptions(context.clinicCode), optionsError: null };
  } catch (err) {
    log.warn({ conversationId, code: err instanceof WorkforceApiError ? err.code : undefined }, "sales: invoice options failed");
    return { context, options: null, optionsError: "暫時拎唔到收費項目同醫生名單 — 請稍後再試" };
  }
}

const RATE_WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 10;

export interface OpenInvoiceInput extends InvoiceClinicPick {
  /** null = 冇對話開單（U9）— 要帶 direct（server 記低嘅搜尋結果） */
  conversationId: string | null;
  direct?: DirectPatient | null;
  staffId: string;
  requestKey: string;
  patientApricotId: string;
  practitionerExtId: string;
  lines: { feeItemExtId: string; qty: number; up: number; discAmt: number; remarks?: string | null }[];
  payment: { amt: number; methodExtId: string } | null;
}

const WF_MESSAGES: Record<string, string> = {
  WRITE_DISABLED: "開單功能未開通（要老闆喺 Apricot 試開核對之後先開）",
  TEMPLATE_MISSING: "呢間店未有開單範本 — 請老闆喺「銷售」設定撳「立即更新名單」",
  SALES_USER_INVALID: "你綁定嘅 Apricot 銷售員帳號唔喺呢間店嘅系統（或者已停用）— 請老闆檢查",
  PRACTITIONER_INVALID: "揀嘅醫生唔喺呢間店出診 — 請重新揀",
  FEE_ITEM_INVALID: "有項目唔喺呢間店嘅收費表（或者已封存）— 請重新揀",
  METHOD_INVALID: "付款方式唔啱 — 請重新揀",
  PATIENT_NOT_FOUND: "Apricot 搵唔到呢個病人（編號對唔上）",
  CLINIC_NOT_LINKED: "呢間店未連 Apricot",
  CLINIC_CODE_NOT_FOUND: "workforce 唔識呢間店",
  KEY_REUSED: "張單內容改咗 — 請關咗對話框再開過",
  IN_PROGRESS: "上一次開單仲未有結果 — 請等一陣再撳",
  TOO_MANY_ATTEMPTS: "試咗幾次都未確認 — 請去 Apricot 睇吓有冇開到，再搵老闆對單",
  INVOICE_REJECTED: "Apricot 拒絕咗呢張單 — 請改好再開",
  INVOICE_FAILED: "Apricot 拒絕咗呢張單 — 請改好再開",
  UNCONFIRMED: "未確認 Apricot 有冇開到 — 請等 1 分鐘再撳「開單」（系統會先搜，唔會開兩張）",
  APRICOT_BUSY: "Apricot 忙緊（同步中）— 請等一陣再撳",
  SEARCH_FAILED: "暫時查唔到 Apricot — 請等一陣再撳",
  APRICOT_UNAVAILABLE: "暫時連唔到 Apricot — 請等一陣再撳",
  APRICOT_AUTH_EXPIRED: "Apricot 系統帳號登入過期 — 請通知老闆",
  APRICOT_RATE_LIMITED: "Apricot 太多請求 — 請等一陣再撳",
  APRICOT_NOT_CONFIGURED: "Apricot 系統帳號未設定 — 請通知老闆",
  OVERPAY: "收款大過總額",
  BAD_DISCOUNT: "折扣大過金額",
};

/** workforce 錯誤 → 用戶睇得明嘅訊息（status 0 = 逾時／斷線 → 當未確認） */
export function invoiceError(err: WorkforceApiError): SalesActionError {
  if (err.status === 0) return new SalesActionError(504, "UNCONFIRMED", WF_MESSAGES.UNCONFIRMED, 60);
  const code = err.code ?? "WORKFORCE_ERROR";
  const status = err.status >= 400 && err.status < 600 ? err.status : 502;
  return new SalesActionError(status, code, WF_MESSAGES[code] ?? `開單失敗（${code}）`, err.retryAfterSec);
}

export async function openSalesInvoice(input: OpenInvoiceInput): Promise<CreatedInvoice & { bound: boolean; highValueExtended: boolean }> {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(input.requestKey)) throw new SalesActionError(400, "BAD_REQUEST_KEY", "請重新開對話框");
  const pick = { scope: input.scope, clinicCode: input.clinicCode };
  let ctx: InvoiceContext;
  if (input.conversationId) ctx = await invoiceContext(input.conversationId, input.staffId, pick);
  else if (input.direct && input.direct.patientApricotId === input.patientApricotId) ctx = await invoiceContextForPatient(input.staffId, input.direct, pick);
  else throw new SalesActionError(400, "PATIENT_NOT_SEARCHED", "請重新搜尋病人先開單");
  if (ctx.blocked) throw new SalesActionError(ctx.blocked.includes("負責呢個對話") ? 423 : 403, "CANNOT_INVOICE", ctx.blocked);
  const p = ctx.patients.find((x) => x.patientApricotId === input.patientApricotId);
  if (!p) throw new SalesActionError(404, "PATIENT_NOT_LINKED", input.conversationId ? "呢個病人唔係連住呢個對話" : "請重新搜尋病人先開單");
  if (!p.code) throw new SalesActionError(409, "PATIENT_CODE_MISSING", "呢個病人冇 Apricot 編號 — 請先喺右欄重新認病人");
  if (p.ownership === "OTHER") throw new SalesActionError(403, "OWNED_BY_OTHER", `${p.ownerName ?? "其他銷售"} 負責呢個病人 — 唔可以幫佢開單`);
  const me = (await loadMe(input.staffId))!;
  // 對抗：連環開單（亂開單）→ 10 分鐘內最多 MAX_PER_WINDOW 張
  const recent = await prisma.auditLog.count({
    where: { staffId: input.staffId, action: "SALES_INVOICE_CREATED", createdAt: { gt: new Date(Date.now() - RATE_WINDOW_MS) } },
  });
  if (recent >= MAX_PER_WINDOW) throw new SalesActionError(429, "TOO_MANY_INVOICES", "開單太密 — 請等幾分鐘再開", 300);
  let created: CreatedInvoice;
  try {
    created = await createSalesInvoice(
      {
        requestKey: input.requestKey,
        clinicCode: ctx.clinicCode!,
        patientApricotId: p.patientApricotId,
        patientCode: p.code,
        conversationId: input.conversationId,
        employeeId: me.workforceEmployeeId,
        salesApricotUserId: me.salesApricotUserId!,
        practitionerExtId: input.practitionerExtId,
        ownership: p.ownership === "MINE_BOUND" ? "BOUND" : p.ownership === "MINE_PROTECTED" ? "PROTECTED" : "NONE",
        lines: input.lines,
        payment: input.payment && input.payment.amt > 0 ? input.payment : null,
      },
      input.staffId
    );
  } catch (err) {
    if (err instanceof WorkforceApiError) throw invoiceError(err);
    throw err;
  }
  let bound = false;
  // 重放都要補審計：inbox 逾時（workforce 其實開咗）→ 同 key 再撳收到 replayed，之前冇記過。
  // 同一張單並發重放 → advisory lock 串行「查有冇 → 寫」，只會寫一次
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sales-inv:${created.invoiceId}`}))`;
    const entityId = input.conversationId ?? p.patientApricotId;
    const audited = await tx.auditLog.count({
      where: { action: "SALES_INVOICE_CREATED", entityId, meta: { path: ["invoiceId"], equals: created.invoiceId } },
    });
    if (audited > 0) return;
    await tx.auditLog.create({
      data: {
        staffId: input.staffId,
        action: "SALES_INVOICE_CREATED",
        entity: input.conversationId ? "Conversation" : "Patient",
        entityId,
        meta: {
          invoiceId: created.invoiceId,
          billId: created.billId,
          patientApricotId: p.patientApricotId,
          total: created.totalAmt,
          paid: created.paymentAmt,
          commissionable: created.commissionableAmt,
          review: created.review,
          recovered: created.recovered,
        } as Prisma.InputJsonValue,
      },
    });
  });
  // 保護中 + 傭金項目 + 即場收到錢 → 轉綁定（重放都試 — 冪等：只由 PROTECTED 轉）
  if (p.ownership === "MINE_PROTECTED" && created.paymentAmt > 0 && created.commissionableAmt > 0) {
    bound = await bindAfterFirstPayment(p.patientApricotId, input.staffId, created.invoiceId);
  }
  // 保護中（未收錢所以未綁定）+ 高價傭金項目 → 保護期改用「高價項目保護期」（只會延長，唔會縮短）
  let highValueExtended = false;
  if (!bound && p.ownership === "MINE_PROTECTED" && created.highValue) {
    highValueExtended = await extendForHighValue(p.patientApricotId, input.staffId, created.invoiceId);
  }
  return { ...created, bound, highValueExtended };
}

/** 自己保護中嘅病人開咗高價單 → highValue = true，保護期 = max(而家, 預約日 + 高價保護期)。冪等（已標 → 唔再改） */
export async function extendForHighValue(patientApricotId: string, staffId: string, invoiceId: string, now: Date = new Date()): Promise<boolean> {
  const done = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sales:${patientApricotId}`}))`;
    const own = await tx.salesOwnership.findUnique({ where: { patientApricotId } });
    if (!own || own.state !== "PROTECTED" || own.salesStaffId !== staffId || own.highValue) return null;
    const settings = await getSalesSettings(tx);
    const until = protectedUntilFor(own.lastApptDate ?? hkTodayStr(now), protectionDaysFor(settings, true));
    const keep = own.protectedUntil && own.protectedUntil > until ? own.protectedUntil : until;
    await tx.salesOwnership.update({ where: { id: own.id }, data: { highValue: true, protectedUntil: keep, expiryRemindedFor: null } });
    return { from: own.protectedUntil?.toISOString() ?? null, to: keep.toISOString() };
  });
  if (!done) return false;
  await prisma.auditLog
    .create({ data: { staffId, action: "SALES_PROTECTION_HIGH_VALUE", entity: "SalesOwnership", entityId: patientApricotId, meta: { invoiceId, ...done } } })
    .catch(() => undefined);
  return true;
}

/** PROTECTED（自己）→ BOUND；並發／重放只會轉一次（條件 update） */
export async function bindAfterFirstPayment(patientApricotId: string, staffId: string, invoiceId: string): Promise<boolean> {
  const r = await prisma.salesOwnership.updateMany({
    where: { patientApricotId, state: "PROTECTED", salesStaffId: staffId },
    data: { state: "BOUND", protectedUntil: null, since: new Date() },
  });
  if (r.count !== 1) return false;
  await prisma.auditLog.create({
    data: { staffId, action: "SALES_OWNER_BOUND", entity: "SalesOwnership", entityId: patientApricotId, meta: { invoiceId, reason: "FIRST_PAYMENT" } },
  });
  return true;
}

/**
 * ★ cwi-sales 第 4 期：老闆月結（/admin/sales「月結」）— workforce 計數，inbox 補銷售名、病人編號、出 CSV。
 *
 * - 預覽：每個銷售 已計／上月結轉／出糧／結轉／等批帶落下月；擋住嘅原因；月結前同步狀態
 * - 月結：出糧 > 0 → workforce 計糧調整（PRE_MPF）；負數唔扣底薪、結轉；冇做月結前同步要老闆確認（force）
 * - 重開：由最後一個月開始、計糧調整嗰個月未鎖先得
 * - 報表 CSV：防 CSV 公式注入（= + - @ 開頭 → 前面加 '）；只有病人編號，冇名
 */
import prisma from "@/lib/prisma";
import { SalesActionError } from "@/lib/sales/handover";
import {
  fetchCommissionSyncState,
  fetchMonthClosePreview,
  fetchSalesReport,
  postMonthClose,
  postMonthReopen,
  startPreCloseSync,
  WorkforceApiError,
} from "@/lib/workforce/client";

const MESSAGES: Record<string, string> = {
  NOT_ENDED: "呢個月未完 — 下個月先結得",
  EARLIER_OPEN: "要順序結 — 之前仲有月份未結",
  SYNC_RUNNING: "同步緊 — 等佢完先結",
  NEED_PRE_CLOSE_SYNC: "未做月結前同步 — 請先撳「月結前同步」，或者確認照結",
  LATER_CLOSED: "之後嘅月份已經結咗 — 要由最後一個月開始重開",
  PAYROLL_LOCKED: "嗰個月計糧已確認／匯出 — 唔可以重開（請先喺 workforce 計糧退回草稿）",
  ALREADY_RUNNING: "同步緊 — 等佢完先",
  BAD_MONTH: "月份格式唔啱",
};

function wfError(err: unknown): never {
  if (err instanceof WorkforceApiError) {
    const code = err.code ?? "WORKFORCE_ERROR";
    throw new SalesActionError(err.status >= 400 && err.status < 600 ? err.status : 503, code, MESSAGES[code] ?? "workforce 連唔到 — 請稍後再試");
  }
  throw err;
}

async function staffNames(ids: string[]): Promise<Map<string, { name: string; active: boolean }>> {
  const rows = await prisma.staffUser.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, active: true, isSales: true } });
  return new Map(rows.map((r) => [r.id, { name: r.name, active: r.active && r.isSales }]));
}

export async function monthCloseView(month: string) {
  try {
    const [p, sync] = await Promise.all([fetchMonthClosePreview(month), fetchCommissionSyncState()]);
    const names = await staffNames(p.rows.map((r) => r.inboxStaffId));
    return {
      ...p,
      sync: { running: sync.running, last: sync.last },
      rows: p.rows.map((r) => ({ ...r, name: names.get(r.inboxStaffId)?.name ?? "（已刪帳號）", active: names.get(r.inboxStaffId)?.active ?? false })),
    };
  } catch (e) {
    wfError(e);
  }
}

export async function closeMonth(month: string, force: boolean, byStaffId: string): Promise<{ already: boolean }> {
  let r: { already: boolean };
  try {
    r = await postMonthClose(month, force, byStaffId);
  } catch (e) {
    wfError(e);
  }
  if (!r.already) {
    await prisma.auditLog.create({ data: { staffId: byStaffId, action: "SALES_MONTH_CLOSED", entity: "SalesMonth", entityId: month, meta: { force } } });
  }
  return r;
}

export async function reopenMonth(month: string, byStaffId: string) {
  let r: { reopened: boolean; adjustmentsRemoved: number };
  try {
    r = await postMonthReopen(month, byStaffId);
  } catch (e) {
    wfError(e);
  }
  if (r.reopened) {
    await prisma.auditLog.create({ data: { staffId: byStaffId, action: "SALES_MONTH_REOPENED", entity: "SalesMonth", entityId: month, meta: { adjustmentsRemoved: r.adjustmentsRemoved } } });
  }
  return r;
}

export async function startSync(byStaffId: string): Promise<void> {
  try {
    await startPreCloseSync(byStaffId);
  } catch (e) {
    wfError(e);
  }
}

/** CSV 一格：雙引號包住；= + - @ tab CR 開頭 → 前面加 '（防 Excel 公式注入） */
export function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

const STATUS: Record<string, string> = { COUNTED: "已計", HELD: "等批", EXCLUDED: "離職後", REJECTED: "已拒" };

export async function reportCsv(month: string): Promise<string> {
  let r;
  try {
    r = await fetchSalesReport(month);
  } catch (e) {
    wfError(e);
  }
  const names = await staffNames([...new Set([...r.bySales.map((x) => x.inboxStaffId), ...r.detail.map((x) => x.inboxStaffId)])]);
  const pids = [...new Set(r.detail.map((d) => d.patientApricotId).filter((x): x is string => !!x))];
  const links = await prisma.contactPatientLink.findMany({ where: { patientApricotId: { in: pids } }, select: { patientApricotId: true, patientCode: true } });
  const codeOf = new Map(links.map((l) => [l.patientApricotId, l.patientCode]));
  const name = (id: string) => names.get(id)?.name ?? id;
  const lines: string[] = [];
  const row = (...cells: unknown[]) => lines.push(cells.map(csvCell).join(","));
  row(`銷售傭金報表 ${month}`, r.closed ? "已月結" : "未月結");
  row();
  row("銷售", "已計", "上月結轉", "合計", "出糧", "結轉下月", "等批（帶落下月）", "筆數", "糧單");
  for (const s of r.bySales) row(name(s.inboxStaffId), s.earned, s.carryIn, s.net, s.payout, s.carryOut, s.held, s.lines, s.payrollStatus ? `${s.payrollStatus}${s.payrollMonth ? ` ${s.payrollMonth}` : ""}` : "");
  row();
  row("分店", "已計傭金", "付款", "筆數");
  for (const c of r.byClinic) row(c.clinic, c.counted, c.payments, c.lines);
  row();
  row("付款日", "銷售", "分店", "單號", "病人編號", "傭金項目", "類別", "狀態", "收據", "付款", "傭金 %", "傭金", "批核 %", "計入");
  for (const d of r.detail) {
    row(d.paidAt, name(d.inboxStaffId), d.clinic, d.billCode, d.patientApricotId ? (codeOf.get(d.patientApricotId) ?? "") : "", d.items, d.kind === "CLAWBACK" ? "作廢扣回" : "收款", STATUS[d.status] ?? d.status, d.paymentCode, d.paymentAmt, d.ratePct, d.commissionAmt, d.approvedPct ?? "", d.countedAmt);
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}

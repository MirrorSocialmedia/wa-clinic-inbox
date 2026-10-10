/**
 * cwi-labdoc-normalize — model 輸出 → §5.4 契約前嘅「整理」層（純函數，零 IO）。
 *
 * 點解要：生產 sglang 會忽略 guided_json（只有 response_format=json_object 保證係合法 JSON），
 * model 經常有細偏差 —— 漏 key、數字寫成 "$1,100.00"、日期寫 03/09/2026、lineType 細楷……
 * 嚴格 zod 一見到就成份 bad_response（2026-10-11 生產實測：GPU 有做嘢但成份單作廢）。
 *
 * 原則：
 *   - 只做「格式」整理，唔估內容：數字字串 → number；日期 → YYYY-MM-DD；漏咗嘅可空欄 → null；漏咗嘅陣列 → []
 *   - 讀唔到嘅必填金額（行 amount）→ 掉咗嗰行 + readIssues 記低（CWM §5.5 合計檢查會再擋確認）
 *   - kind 冇／亂 → 用請求嘅 kindHint；INVOICE 帶 sections／STATEMENT 帶 groups → 清走 + readIssues 記低
 *   - lineType 唔識 → CHARGE（CWM 配對當 NEEDS_MANUAL，要人睇）
 *   - 整理完仍然唔過 zod 先係 bad_response
 */

type Obj = Record<string, unknown>;
type Kind = "INVOICE" | "STATEMENT";

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** 字串欄：null／undefined／空白 → null；數字／boolean → 轉字串；物件 → null。 */
export function normStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const s = v.trim();
    return s === "" ? null : s;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/**
 * 數字欄：number 照用；字串去貨幣符號／千位逗號／空格（"HK$ 1,100.00" → 1100）；
 * 括號或尾 "-" 當負數（"(50.00)"、"50.00-"）；讀唔到 → null。
 */
export function normNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  let s = v.trim();
  if (s === "" || s === "-" || s === "—") return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith("-")) {
    neg = true;
    s = s.slice(0, -1);
  }
  s = s.replace(/HK\$|US\$|\$|HKD|港幣|元|,|\s/gi, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -Math.abs(n) : n;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
function validYmd(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null; // 31/02 之類
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/**
 * 日期 → YYYY-MM-DD：接受 YYYY-MM-DD(Thh..)、YYYY/MM/DD、YYYY.MM.DD、DD/MM/YYYY（香港慣例日先）、DD-MM-YYYY。
 * 其他（例 "21 Sept 2026"）→ null（原文喺 dateRaw，CWM 照用原文顯示）。
 */
export function normDate(v: unknown): string | null {
  const s = normStr(v);
  if (!s) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return validYmd(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return validYmd(+m[3], +m[2], +m[1]);
  return null;
}

/** 月份 → YYYY-MM：接受 YYYY-MM、YYYY/MM、YYYY-MM-DD、MM/YYYY、MM-YYYY。 */
export function normMonth(v: unknown): string | null {
  const s = normStr(v);
  if (!s) return null;
  let m = /^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?$/.exec(s);
  if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${pad2(+m[2])}`;
  m = /^(\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m && +m[1] >= 1 && +m[1] <= 12) return `${m[2]}-${pad2(+m[1])}`;
  return null;
}

const LINE_TYPES = new Set(["INVOICE", "CREDIT", "PAYMENT", "CHARGE", "BF"]);
const LINE_TYPE_ALIASES: Record<string, string> = {
  INV: "INVOICE", SALE: "INVOICE", SALES: "INVOICE", DEBIT: "INVOICE", DR: "INVOICE",
  CN: "CREDIT", "CREDIT NOTE": "CREDIT", CR: "CREDIT", RETURN: "CREDIT",
  PAID: "PAYMENT", RECEIPT: "PAYMENT", CHEQUE: "PAYMENT",
  "B/F": "BF", "BALANCE B/F": "BF", "BALANCE BROUGHT FORWARD": "BF", OPENING: "BF",
  FEE: "CHARGE", SERVICE: "CHARGE",
};
function normLineType(v: unknown): string {
  const s = (normStr(v) ?? "INVOICE").toUpperCase().replace(/_/g, " ").trim();
  if (LINE_TYPES.has(s)) return s;
  return LINE_TYPE_ALIASES[s] ?? "CHARGE"; // 唔識 → CHARGE（CWM 當要人手睇）
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * 整理 model 輸出（JSON.parse 之後、zod 之前）。回傳新物件（唔改入參）。
 * `kindHint` = 請求嘅 kindHint（model 冇／亂寫 kind 時用）。
 */
export function normalizeLabDocOutput(raw: Obj, kindHint: Kind | null): Obj {
  const issues: string[] = arr(raw.readIssues).map((x) => normStr(x)).filter((x): x is string => !!x);
  const k = normStr(raw.kind)?.toUpperCase();
  const kind: Kind | null = k === "INVOICE" || k === "STATEMENT" ? k : kindHint;
  const lab = isObj(raw.lab) ? raw.lab : {};
  const billTo = isObj(raw.billTo) ? raw.billTo : {};

  let dropped = 0;
  const groups = arr(raw.groups).filter(isObj).map((g) => ({
    patientNameRaw: normStr(g.patientNameRaw),
    patientCodeRaw: normStr(g.patientCodeRaw),
    labCaseRef: normStr(g.labCaseRef),
    lines: arr(g.lines).filter(isObj).flatMap((l) => {
      const amount = normNum(l.amount);
      if (amount === null) {
        dropped++;
        return [];
      }
      return [{
        description: normStr(l.description) ?? "",
        toothRaw: normStr(l.toothRaw),
        qty: normNum(l.qty),
        unitPrice: normNum(l.unitPrice),
        listPrice: normNum(l.listPrice),
        discountRaw: normStr(l.discountRaw),
        amount,
      }];
    }),
  }));

  const sections = arr(raw.sections).filter(isObj).map((s) => ({
    clinicRaw: normStr(s.clinicRaw),
    doctorRaw: normStr(s.doctorRaw),
    customerNoRaw: normStr(s.customerNoRaw),
    addressRaw: normStr(s.addressRaw),
    pageFrom: normNum(s.pageFrom),
    pageTo: normNum(s.pageTo),
    total: normNum(s.total),
    currentTotal: normNum(s.currentTotal),
    lines: arr(s.lines).filter(isObj).flatMap((l) => {
      const amount = normNum(l.amount);
      if (amount === null) {
        dropped++;
        return [];
      }
      return [{
        lineType: normLineType(l.lineType),
        docNoRaw: normStr(l.docNoRaw),
        date: normDate(l.date),
        patientRaw: normStr(l.patientRaw),
        patientCodeRaw: normStr(l.patientCodeRaw),
        labCaseRef: normStr(l.labCaseRef),
        description: normStr(l.description),
        toothRaw: normStr(l.toothRaw),
        qty: normNum(l.qty),
        unitPrice: normNum(l.unitPrice),
        amount,
        agingBucket: normStr(l.agingBucket),
      }];
    }),
  }));
  if (dropped > 0) issues.push(`有 ${dropped} 行金額讀唔到（已略過）`);

  // invariant：INVOICE 冇 sections、STATEMENT 冇 groups（model 放錯位 → 清走 + 記低）
  let outGroups: unknown[] = groups;
  let outSections: unknown[] = sections;
  if (kind === "INVOICE" && sections.length > 0) {
    outSections = [];
    issues.push("讀單結果帶咗月結單分段（已略過）");
  }
  if (kind === "STATEMENT" && groups.length > 0) {
    outGroups = [];
    issues.push("讀單結果帶咗 invoice 分組（已略過）");
  }

  return {
    kind,
    lab: { nameRaw: normStr(lab.nameRaw), nameCnRaw: normStr(lab.nameCnRaw), payeeRaw: normStr(lab.payeeRaw) },
    billTo: {
      nameRaw: normStr(billTo.nameRaw),
      addressRaw: normStr(billTo.addressRaw),
      customerNoRaw: normStr(billTo.customerNoRaw),
      shortCodeRaw: normStr(billTo.shortCodeRaw),
      doctorRaw: normStr(billTo.doctorRaw),
    },
    docNoRaw: normStr(raw.docNoRaw),
    docNoLabel: normStr(raw.docNoLabel),
    dateRaw: normStr(raw.dateRaw),
    date: normDate(raw.date ?? raw.dateRaw),
    deliveryDate: normDate(raw.deliveryDate),
    orderReceivedDate: normDate(raw.orderReceivedDate),
    statementMonth: normMonth(raw.statementMonth),
    groups: outGroups,
    sections: outSections,
    subtotal: normNum(raw.subtotal),
    total: normNum(raw.total),
    readIssues: issues,
  };
}

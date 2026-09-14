import prisma from "@/lib/prisma";

/**
 * cwi-window-20260901（P4 / W-4）：用量統計聚合 — /admin/usage 數據源。
 *
 * 只出「條數」，唔硬編費率（Meta 香港費率會變 — 費率由 user 喺 UI 手動乘）。
 * 資料源：Message（OUT + channel API = 經 WhatsApp API 出街、計費嘅訊息）
 *        + Message.billingCategory（P1：發送時寫入；legacy null = 未回填行）
 *        + AuditLog APP_HANDOFF_CLICK（App 跟進次數 — 免費對照）。
 *
 * HK 日界：同 automation-stats.ts 同一 pattern（固定 UTC+8、無 DST）。
 */

const HK_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;

/** 本月 1 日（HK 日曆）YYYY-MM-DD。 */
export function hkMonthStart(d: Date = new Date()): string {
  const hk = new Date(d.getTime() + HK_OFFSET_MS);
  return `${hk.getUTCFullYear()}-${String(hk.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** HK 日期 YYYY-MM-DD → 該日 00:00 HK 嘅 UTC Date。 */
function hkDateToUtc(hkDate: string): Date {
  const [y, m, d] = hkDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - HK_OFFSET_MS);
}

/** 本月嘅 UTC 邊界 [1 日 00:00 HK, 下月 1 日 00:00 HK)。 */
export function hkMonthRange(now: Date = new Date()): { month: string; fromUtc: Date; toUtc: Date } {
  const monthStartHk = hkMonthStart(now);
  const [y, m] = monthStartHk.split("-").map(Number);
  const fromUtc = hkDateToUtc(monthStartHk);
  const toUtc = new Date(Date.UTC(y, m, 1) - HK_OFFSET_MS); // 下月 1 日 00:00 HK
  return { month: monthStartHk.slice(0, 7), fromUtc, toUtc };
}

export interface UsageMonthRow {
  clinicCode: string;
  /** SERVICE | UTILITY | MARKETING | AUTH（legacy null = 未回填） */
  category: string | null;
  /** 人手（staff web 發 — sentByStaffId 非空） */
  staffSent: number;
  /** AI 自動覆（aiAutoSent = true） */
  aiSent: number;
  /** 其他系統發送（flow/template cron 等 — 無 staffId 且非 aiAuto） */
  systemSent: number;
  total: number;
}

export interface UsageAppHandoff {
  clinicCode: string;
  count: number;
}

export interface UsageWeekPoint {
  /** HK 週一 YYYY-MM-DD */
  weekStart: string;
  /** 本週未完成 */
  current: boolean;
  total: number;
  aiAuto: number;
}

export interface UsageSummary {
  month: string;
  fromUtc: Date;
  toUtc: Date;
  rows: UsageMonthRow[];
  appHandoff: UsageAppHandoff[];
  weekTrend: UsageWeekPoint[];
  totals: { staffSent: number; aiSent: number; systemSent: number; total: number; aiSharePct: number };
}

/**
 * ★ cwi-hub-a-20260914（A.4）：公司分組資料 — UI 先按公司、再按店。
 * 只含 visible 範圍內嘅公司（ALL = 全部；COMPANY = 自己公司；CLINICS = 指定診所涉及嘅公司）。
 */
export interface UsageCompany {
  id: string;
  code: string;
  name: string;
  clinics: { id: string; code: string }[];
}

interface RawRow {
  clinicCode: string;
  category: string | null;
  staffSent: number;
  aiSent: number;
  systemSent: number;
  total: number;
}

/**
 * 本月用量（按店 × 類別 × 人手/AI/系統）+ App 跟進次數 + 最近 5 週趨勢（含本週）。
 * fail-soft：DB 錯 → throw（caller route 用 handle() 接）。
 *
 * ★ cwi-hub-a-20260914（A.4）：`clinicIds` = 範圍內診所 id 集合（null = 全部；
 *   caller 由 resolveClinicIds 得出 — 本檔唔自行算 clinic 集合）。null 時 `NULL::text[] IS NULL`
 *   恆真 = 不過滤；週趨勢同樣過濾（否則 COMPANY 範圍 ADMIN 會見到全集團趨勢 — 洩露 + 同 rows 不一致）。
 */
/**
 * ★ cwi-hub-a-20260914（A.4）：範圍內公司 + 旗下診所（UI 分組頭用）。
 * clinicIds=null → 全部公司（含零診所公司，保持完整圖景）；否則只回含範圍內診所嘅公司。
 */
export async function getUsageCompanies(clinicIds: string[] | null = null): Promise<UsageCompany[]> {
  const rows = await prisma.$queryRaw<{ clinicId: string; clinicCode: string; companyId: string; companyCode: string; companyName: string }[]>`
    SELECT c.id AS "clinicId", c.code AS "clinicCode",
           co.id AS "companyId", co.code AS "companyCode", co.name AS "companyName"
      FROM "Clinic" c
      JOIN "Company" co ON co.id = c."companyId"
     WHERE (${clinicIds}::text[] IS NULL OR c.id = ANY(${clinicIds}::text[]))
     ORDER BY co.code, c.code
  `;
  const companies = new Map<string, UsageCompany>();
  for (const r of rows) {
    let co = companies.get(r.companyId);
    if (!co) {
      co = { id: r.companyId, code: r.companyCode, name: r.companyName, clinics: [] };
      companies.set(r.companyId, co);
    }
    co.clinics.push({ id: r.clinicId, code: r.clinicCode });
  }
  return [...companies.values()].sort((a, b) => a.code.localeCompare(b.code));
}

export async function getUsageSummary(
  now: Date = new Date(),
  clinicIds: string[] | null = null
): Promise<UsageSummary> {
  const { month, fromUtc, toUtc } = hkMonthRange(now);

  // 範圍過濾（單一參數雙重綁定；null → NULL::text[] IS NULL 恆真；陣列 → ANY 過濾）：
  // ⚠️ 必需要直接寫入 tagged template（Prisma 參數綁定）— 唔好用 JS 預組字串再嵌入
  //    （會變單一 text 參數 → 42804 實測）。

  const raw = await prisma.$queryRaw<RawRow[]>`
    SELECT c.code AS "clinicCode",
           m."billingCategory" AS category,
           count(*) FILTER (WHERE m."sentByStaffId" IS NOT NULL)::int AS "staffSent",
           count(*) FILTER (WHERE m."aiAutoSent" = true)::int AS "aiSent",
           count(*) FILTER (WHERE m."sentByStaffId" IS NULL AND (m."aiAutoSent" IS NOT TRUE))::int AS "systemSent",
           count(*)::int AS total
      FROM "Message" m
      JOIN "Conversation" cv ON cv.id = m."conversationId"
      JOIN "Clinic" c ON c.id = cv."clinicId"
     WHERE m.direction = 'OUT' AND m.channel = 'API'
       AND m."createdAt" >= ${fromUtc} AND m."createdAt" < ${toUtc}
       AND (${clinicIds}::text[] IS NULL OR c.id = ANY(${clinicIds}::text[]))
     GROUP BY 1, 2
     ORDER BY 1, 2
  `;

  const rows: UsageMonthRow[] = raw.map((r) => ({
    clinicCode: r.clinicCode,
    category: r.category,
    staffSent: r.staffSent,
    aiSent: r.aiSent,
    systemSent: r.systemSent,
    total: r.total,
  }));

  // App 跟進（wa.me 撳掣 audit — 免費對照；零 PII：audit 只記 conversationId + staffId）
  const handoff = await prisma.$queryRaw<{ code: string; count: number }[]>`
    SELECT c.code, count(*)::int AS count
      FROM "AuditLog" a
      JOIN "Conversation" cv ON cv.id = a."entityId"
      JOIN "Clinic" c ON c.id = cv."clinicId"
     WHERE a.action = 'APP_HANDOFF_CLICK'
       AND a."createdAt" >= ${fromUtc} AND a."createdAt" < ${toUtc}
       AND (${clinicIds}::text[] IS NULL OR c.id = ANY(${clinicIds}::text[]))
     GROUP BY c.code
     ORDER BY c.code
  `;
  const appHandoff: UsageAppHandoff[] = handoff.map((h) => ({ clinicCode: h.code, count: h.count }));

  // 週趨勢：最近 4 個完整 HK 週 + 本週（未完成）
  const nowT = now.getTime();
  const t = nowT + HK_OFFSET_MS;
  const hkDay = Math.floor(t / DAY_MS);
  const dow = new Date(hkDay * DAY_MS).getUTCDay();
  const sinceMon = (dow + 6) % 7;
  const weekTrend: UsageWeekPoint[] = [];
  for (let i = 4; i >= 0; i--) {
    const mondayHkDay = hkDay - sinceMon - i * 7;
    const mono = new Date(mondayHkDay * DAY_MS);
    const weekStart = `${mono.getUTCFullYear()}-${String(mono.getUTCMonth() + 1).padStart(2, "0")}-${String(
      mono.getUTCDate()
    ).padStart(2, "0")}`;
    const lo = new Date(mondayHkDay * DAY_MS - HK_OFFSET_MS);
    const hi = new Date((mondayHkDay + 7) * DAY_MS - HK_OFFSET_MS);
    const pt = await prisma.$queryRaw<{ total: number; aiAuto: number }[]>`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE m."aiAutoSent" = true)::int AS "aiAuto"
        FROM "Message" m
        JOIN "Conversation" cv ON cv.id = m."conversationId"
        JOIN "Clinic" c ON c.id = cv."clinicId"
       WHERE m.direction = 'OUT' AND m.channel = 'API'
         AND m."createdAt" >= ${lo} AND m."createdAt" < ${hi}
         AND (${clinicIds}::text[] IS NULL OR c.id = ANY(${clinicIds}::text[]))
    `;
    weekTrend.push({ weekStart, current: i === 0, total: pt[0]?.total ?? 0, aiAuto: pt[0]?.aiAuto ?? 0 });
  }

  const tStaff = rows.reduce((a, r) => a + r.staffSent, 0);
  const tAi = rows.reduce((a, r) => a + r.aiSent, 0);
  const tSys = rows.reduce((a, r) => a + r.systemSent, 0);
  const tAll = tStaff + tAi + tSys;

  return {
    month,
    fromUtc,
    toUtc,
    rows,
    appHandoff,
    weekTrend,
    totals: {
      staffSent: tStaff,
      aiSent: tAi,
      systemSent: tSys,
      total: tAll,
      aiSharePct: tAll > 0 ? Math.round((tAi / tAll) * 1000) / 10 : 0,
    },
  };
}

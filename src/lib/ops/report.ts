/**
 * 週報（MD §9.3：每星期一自動出營運報表）。
 *
 * 指標定義（denominator 全部寫死喺度 — 報表可複現）：
 * - messages（訊息量/店）：period 內 Message 總數（IN+OUT，所有 channel），逐店 breakdown。
 * - frt（首次回覆時間中位數）：
 *   • 單位 = 病人 inbound（IN + channel=API，period 內）→ 該對話喺 inbound 之後
 *     第一條 OUT（channel API/APP_ECHO — staff web 發 / staff App 發 / AI AUTO 都算）嘅時差。
 *   • 分母 = 有覆到嘅 inbound（unanswered 唔計入中位數；另計 answered/totalInbound 俾回應率）。
 * - draftAdoption（草稿採用率）= (SENT_AS_IS + SENT_EDITED) / period 內建立嘅全部 AiDraft
 *   （分母含 PROPOSED / DISCARDED / SENT_AUTO — 字面遵從任務規格；
 *   ★ cwi-window-20260901 P2：COPY_ONLY 過窗草稿剔除 — 佢發唔出，唔係模型質素問題）。
 * - flowCompletion（Flow 完成率）= period 內建立嘅 FlowSession 中 status=COMPLETED / 總數
 *   （所有 session 建立時都係 SENT — 分母 = 發出咗嘅 Flow 卡）。
 * - bookingConversion（預約卡→確認轉化率）= period 內建立嘅 BookingRequest 中
 *   status=CONFIRMED / 總數（含 PENDING/REJECTED/EXPIRED）；
 *   medianHandleMin = CONFIRMED 卡嘅 (handledAt - createdAt) 中位數（分鐘）。
 *
 * ★ PII 鐵律：metrics 全部係計數/中位數/比率 — 報表 text 零病人資料，可以經 ALERT_CHANNEL 推。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { hkWeekStart } from "./automation-stats";

export interface PeriodMetrics {
  period: { start: string; end: string };
  scope: string; // "ALL" 或 clinic code
  messages: { total: number; inbound: number; outbound: number; perClinic: Record<string, number> };
  frt: { answered: number; totalInbound: number; medianSec: number | null };
  draftAdoption: { sentAsIs: number; sentEdited: number; total: number; rate: number | null };
  flowCompletion: { completed: number; sent: number; rate: number | null };
  booking: {
    confirmed: number;
    total: number;
    rate: number | null;
    medianHandleMin: number | null;
  };
}

export interface Period {
  start: Date;
  end: Date; // exclusive
}

/**
 * 上一週（週一 00:00 → 下週一 00:00，本地時區 — VPS 係 HK 時區）。
 * 每星期一 07:00 跑時 = 完整嘅上一週。
 */
export function previousWeekBounds(now: Date = new Date()): Period {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysSinceMon = (d.getDay() + 6) % 7; // Mon=0 ... Sun=6
  const thisMonday = new Date(d.getTime() - daysSinceMon * 86400000);
  return { start: new Date(thisMonday.getTime() - 7 * 86400000), end: thisMonday };
}

/** 明確 period（E2E / 手動補跑用）— YYYY-MM-DD 本地日 → [start 00:00, end 00:00)。 */
export function periodFromDates(startStr: string, endStr: string): Period {
  const [sy, sm, sd] = startStr.split("-").map(Number);
  const [ey, em, ed] = endStr.split("-").map(Number);
  if (!sy || !sm || !sd || !ey || !em || !ed) {
    throw new Error(`invalid date: ${startStr} / ${endStr}（要 YYYY-MM-DD）`);
  }
  return { start: new Date(sy, sm - 1, sd), end: new Date(ey, em - 1, ed) };
}

/**
 * 計算 period 指標（raw SQL — 中位數要 PERCENTILE_CONT；Prisma 無聚合 percentile）。
 * clinicId=null = ALL（ALL row 嘅 perClinic breakdown 仍然回晒所有店）。
 */
async function computeMetrics(period: Period, clinicId: string | null): Promise<PeriodMetrics> {
  const { start, end } = period;
  // raw SQL 參數順序：$1=start $2=end $3=clinicId（有 clinic scope 時）
  const args: (Date | string)[] = clinicId ? [start, end, clinicId] : [start, end];
  const cvClause = clinicId ? "AND cv.\"clinicId\" = $3" : "";
  const fsClause = clinicId ? "AND fs.\"clinicId\" = $3" : "";
  const bClause = clinicId ? "AND b.\"clinicId\" = $3" : "";

  // ── 訊息量（逐店） ────────────────────────────────────────────────────
  const msgs = (await prisma.$queryRawUnsafe<
    Array<{ code: string; total: number; inbound: number; outbound: number }>
  >(
    `SELECT c."code" AS "code",
            COUNT(*)::int AS "total",
            COUNT(*) FILTER (WHERE m.direction = 'IN')::int AS "inbound",
            COUNT(*) FILTER (WHERE m.direction = 'OUT')::int AS "outbound"
     FROM "Message" m
     JOIN "Conversation" cv ON cv."id" = m."conversationId"
     JOIN "Clinic" c ON c."id" = cv."clinicId"
     WHERE m."waTimestamp" >= $1 AND m."waTimestamp" < $2 ${cvClause}
     GROUP BY c."code"
     ORDER BY c."code"`,
    ...args
  )) as Array<{ code: string; total: number; inbound: number; outbound: number }>;

  const perClinic: Record<string, number> = {};
  let totalMsg = 0;
  let totalIn = 0;
  let totalOut = 0;
  for (const r of msgs) {
    perClinic[r.code] = r.total;
    totalMsg += r.total;
    totalIn += r.inbound;
    totalOut += r.outbound;
  }

  // ── FRT 中位數（inbound → 第一條 staff/AUTO OUT） ─────────────────────
  const frtRow = (
    await prisma.$queryRawUnsafe<Array<{ answered: number; medianSec: number | null }>>(
      `WITH inbounds AS (
         SELECT m."id" AS "inId", cv."id" AS "convId", m."waTimestamp" AS "inTs"
         FROM "Message" m
         JOIN "Conversation" cv ON cv."id" = m."conversationId"
         WHERE m.direction = 'IN' AND m.channel = 'API'
           AND m."waTimestamp" >= $1 AND m."waTimestamp" < $2 ${cvClause}
       )
       SELECT COUNT(*)::int AS "answered",
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (f."firstTs" - i."inTs")))::float AS "medianSec"
       FROM inbounds i
       JOIN LATERAL (
         SELECT o."waTimestamp" AS "firstTs"
         FROM "Message" o
         WHERE o."conversationId" = i."convId"
           AND o.direction = 'OUT'
           AND o.channel IN ('API', 'APP_ECHO')
           AND o."waTimestamp" >= i."inTs"
         ORDER BY o."waTimestamp" ASC, o."createdAt" ASC
         LIMIT 1
       ) f ON true`,
      ...args
    )
  )[0];
  const totalInbound = (
    await prisma.$queryRawUnsafe<Array<{ c: number }>>(
      `SELECT COUNT(*)::int AS c
       FROM "Message" m
       JOIN "Conversation" cv ON cv."id" = m."conversationId"
       WHERE m.direction = 'IN' AND m.channel = 'API'
         AND m."waTimestamp" >= $1 AND m."waTimestamp" < $2 ${cvClause}`,
      ...args
    )
  )[0]?.c ?? 0;

  // ── 草稿採用率 ────────────────────────────────────────────────────────
  const draftRow = (
    await prisma.$queryRawUnsafe<Array<{ sentAsIs: number; sentEdited: number; total: number }>>(
      `SELECT COUNT(*) FILTER (WHERE d."status" = 'SENT_AS_IS')::int AS "sentAsIs",
              COUNT(*) FILTER (WHERE d."status" = 'SENT_EDITED')::int AS "sentEdited",
              COUNT(*)::int AS "total"
       FROM "AiDraft" d
       JOIN "Conversation" cv ON cv."id" = d."conversationId"
       WHERE d."createdAt" >= $1 AND d."createdAt" < $2
         AND (d."mode" IS NULL OR d."mode" <> 'COPY_ONLY') ${cvClause}`,
      ...args
    )
  )[0];

  // ── Flow 完成率 ───────────────────────────────────────────────────────
  const flowRow = (
    await prisma.$queryRawUnsafe<Array<{ completed: number; sent: number }>>(
      `SELECT COUNT(*) FILTER (WHERE fs."status" = 'COMPLETED')::int AS "completed",
              COUNT(*)::int AS "sent"
       FROM "FlowSession" fs
       WHERE fs."createdAt" >= $1 AND fs."createdAt" < $2 ${fsClause}`,
      ...args
    )
  )[0];

  // ── 預約卡轉化 + 中位處理時間 ─────────────────────────────────────────
  const bookRow = (
    await prisma.$queryRawUnsafe<Array<{ confirmed: number; total: number; medianHandleMin: number | null }>>(
      `SELECT COUNT(*) FILTER (WHERE b."status" = 'CONFIRMED')::int AS "confirmed",
              COUNT(*)::int AS "total",
              PERCENTILE_CONT(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (b."handledAt" - b."createdAt")) / 60
              ) FILTER (WHERE b."status" = 'CONFIRMED' AND b."handledAt" IS NOT NULL)::float AS "medianHandleMin"
       FROM "BookingRequest" b
       WHERE b."createdAt" >= $1 AND b."createdAt" < $2 ${bClause}`,
      ...args
    )
  )[0];

  const scope = clinicId
    ? (await prisma.clinic.findUnique({ where: { id: clinicId }, select: { code: true } }))?.code ?? "ALL"
    : "ALL";

  return {
    period: { start: start.toISOString(), end: end.toISOString() },
    scope,
    messages: { total: totalMsg, inbound: totalIn, outbound: totalOut, perClinic },
    frt: {
      answered: frtRow?.answered ?? 0,
      totalInbound,
      medianSec: frtRow?.medianSec != null ? Math.round(frtRow.medianSec) : null,
    },
    draftAdoption: {
      sentAsIs: draftRow?.sentAsIs ?? 0,
      sentEdited: draftRow?.sentEdited ?? 0,
      total: draftRow?.total ?? 0,
      rate: (draftRow?.total ?? 0) > 0 ? (draftRow!.sentAsIs + draftRow!.sentEdited) / draftRow!.total : null,
    },
    flowCompletion: {
      completed: flowRow?.completed ?? 0,
      sent: flowRow?.sent ?? 0,
      rate: (flowRow?.sent ?? 0) > 0 ? flowRow!.completed / flowRow!.sent : null,
    },
    booking: {
      confirmed: bookRow?.confirmed ?? 0,
      total: bookRow?.total ?? 0,
      rate: (bookRow?.total ?? 0) > 0 ? bookRow!.confirmed / bookRow!.total : null,
      medianHandleMin: bookRow?.medianHandleMin != null ? Math.round(bookRow.medianHandleMin * 10) / 10 : null,
    },
  };
}

function pct(x: number | null): string {
  return x === null ? "—" : `${(x * 100).toFixed(1)}%`;
}

function minHm(sec: number | null): string {
  if (sec === null) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m${s > 0 ? ` ${s}s` : ""}` : `${s}s`;
}

/** 人類可讀報表（metadata only — 可以推 WhatsApp/Telegram）。 */
export function renderReportText(m: PeriodMetrics): string {
  const lines: string[] = [];
  lines.push(`📊 WA Clinic 週報（${m.period.start.slice(0, 10)} → ${m.period.end.slice(0, 10)}）scope=${m.scope}`);
  lines.push("");
  lines.push(`訊息量：${m.messages.total} 則（in ${m.messages.inbound} / out ${m.messages.outbound}）`);
  if (Object.keys(m.messages.perClinic).length > 0) {
    lines.push(`  逐店：${Object.entries(m.messages.perClinic).map(([c, n]) => `${c}=${n}`).join("、")}`);
  }
  lines.push(`FRT 中位數：${minHm(m.frt.medianSec)}（${m.frt.answered}/${m.frt.totalInbound} 則 inbound 有覆）`);
  lines.push(
    `草稿採用率：${pct(m.draftAdoption.rate)}（adopt ${m.draftAdoption.sentAsIs + m.draftAdoption.sentEdited} / total ${m.draftAdoption.total}）`
  );
  lines.push(`Flow 完成率：${pct(m.flowCompletion.rate)}（${m.flowCompletion.completed}/${m.flowCompletion.sent}）`);
  lines.push(
    `預約卡→確認：${pct(m.booking.rate)}（${m.booking.confirmed}/${m.booking.total}）；中位處理 ${
      m.booking.medianHandleMin === null ? "—" : `${m.booking.medianHandleMin} 分鐘`
    }`
  );
  return lines.join("\n");
}

export interface SaveResult {
  reportId: string | null;
  metrics: PeriodMetrics;
  text: string;
}

/**
 * 計算 + 存 OpsReport（冪等：@@unique(periodStart, clinicId) upsert — 補跑/重跑覆蓋）。
 * clinicId=null → 存 ALL row（含逐店 breakdown）。
 */
export async function computeAndSaveReport(period: Period, clinicId: string | null): Promise<SaveResult> {
  const metrics = await computeMetrics(period, clinicId);
  const text = renderReportText(metrics);
  // Prisma 對 unique 入面 nullable 欄用 "" 代替 null（Postgres unique 對 NULL 唔生效 — 用 sentinel）
  const key = clinicId ?? "";
  const row = await prisma.opsReport.upsert({
    where: { periodStart_clinicId: { periodStart: period.start, clinicId: key } },
    update: { periodEnd: period.end, metrics: metrics as unknown as object, text },
    create: {
      periodStart: period.start,
      periodEnd: period.end,
      clinicId: key,
      metrics: metrics as unknown as object,
      text,
    },
  });
  log.info(
    { scope: metrics.scope, period: `${period.start.toISOString()}→${period.end.toISOString()}`, reportId: row.id },
    "weekly report saved"
  );
  return { reportId: row.id, metrics, text };
}

/**
 * cron 入口：對上一週（或指定 period）生成 ALL + 逐店報表 → 存 OpsReport → 通知（ALL 嘅 text）。
 */
export async function runWeeklyReport(period?: Period): Promise<{ text: string; scopes: string[] }> {
  const p = period ?? previousWeekBounds();
  const clinics = await prisma.clinic.findMany({ select: { id: true, code: true }, orderBy: { code: "asc" } });
  const scopes: string[] = [];

  const all = await computeAndSaveReport(p, null);
  scopes.push("ALL");

  for (const c of clinics) {
    await computeAndSaveReport(p, c.id);
    scopes.push(c.code);
  }

  // ★ Phase E（cwi-ai-20260825-t5）：automation 摘要段（每店 autoSent / complaints / rollbacks 三個數）
  //   — 只追加喺推送 text；OpsReport 存檔 text 維持原樣（數字的權威來源係 /admin/automation 儀表板）。
  const ws = hkWeekStart(p.start);
  const weekStats = await prisma.automationStat.findMany({ where: { weekStart: ws } }).catch(() => []);
  const autoLines: string[] = [];
  for (const c of clinics) {
    const rs = weekStats.filter((s) => s.clinicId === c.id);
    autoLines.push(
      `${c.code}: autoSent=${rs.reduce((a, s) => a + s.autoSent, 0)} complaints=${rs.reduce((a, s) => a + s.complaints, 0)} rollbacks=${rs.reduce((a, s) => a + s.rollbacks, 0)}`
    );
  }
  const text = autoLines.length > 0 ? `${all.text}\n\n[自動化]\n${autoLines.join("\n")}` : all.text;

  // 通知（metadata only — 報表本身零病人資料）
  const { notifyAlert } = await import("@/lib/health/notify");
  await notifyAlert({
    type: "weekly_report",
    severity: "INFO",
    clinicCode: null,
    detail: { period: all.metrics.period, text },
  });
  return { text, scopes };
}

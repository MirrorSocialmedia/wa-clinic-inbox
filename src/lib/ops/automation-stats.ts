/**
 * 週統計聚合（Phase E — 總綱 §6.5）。逢週一 05:00 HK 跑上一個 HK 週（Mon 00:00 – Sun 24:00 HK）。
 *
 * 冪等：upsert @@unique(clinicId, category, weekStart)，重跑 = 重算覆蓋。
 * ★ complaints/rollbacks 兩欄係即時記帳嘅（flag/rollback 路徑 increment）—
 *   聚合 update 白名單**唔郁**呢兩欄（只寫六個聚合欄）。
 *
 * PII 鐵律：本檔只讀 draft 計數 + conversation→clinic 映射 — 零訊息文本落 log。
 */
import type { DraftStatus } from "@prisma/client";
import prisma from "@/lib/prisma";

const HK_OFFSET_MS = 8 * 3_600_000; // HK 無 DST — 固定 UTC+8
const DAY_MS = 86_400_000;

/**
 * 回該時刻所屬 HK 週嘅週一 YYYY-MM-DD。
 * 邊界（unit 測）：HK 週日 23:59:59 → 本週週一；HK 週一 00:00:00 → 本週週一（新週）。
 */
export function hkWeekStart(d: Date = new Date()): string {
  const t = d.getTime() + HK_OFFSET_MS; // 換成「HK 日曆」epoch（純數字運算，無 DST 問題）
  const hkDay = Math.floor(t / DAY_MS);
  const dow = new Date(hkDay * DAY_MS).getUTCDay(); // 0=Sun … 6=Sat（HK 日曆日）
  const sinceMon = (dow + 6) % 7;
  const mondayHkDay = hkDay - sinceMon;
  const mono = new Date(mondayHkDay * DAY_MS);
  const y = mono.getUTCFullYear();
  const m = String(mono.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(mono.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** HK 週一 YYYY-MM-DD → [週一 00:00 HK, 下週一 00:00 HK) 嘅 UTC Date 邊界。 */
export function weekRangeUtc(weekStart: string): [Date, Date] {
  const [y, m, d] = weekStart.split("-").map(Number);
  const mondayUtc = Date.UTC(y, m - 1, d) - HK_OFFSET_MS; // 00:00 HK = 前日 16:00 UTC
  return [new Date(mondayUtc), new Date(mondayUtc + 7 * DAY_MS)];
}

/** 最近四個完整週嘅 weekStart（含最舊，升序；now 所在週唔計 — 佢未完成）。 */
export function lastFourCompleteWeeks(now: Date = new Date()): string[] {
  const [lo] = weekRangeUtc(hkWeekStart(now));
  const out: string[] = [];
  for (let i = 4; i >= 1; i--) out.push(hkWeekStart(new Date(lo.getTime() - i * 7 * DAY_MS)));
  return out; // 最舊 → 最近（dashboard 走勢 + isEligible 都按呢個序）
}

// ── 聚合映射（pure — unit test）────────────────────────────────────────

export interface DraftAggInput {
  clinicId: string;
  /** null = 歷史 row 冇 intent 快照 → 歸 "UNKNOWN" */
  intent: string | null;
  status: DraftStatus;
}

export interface WeekAgg {
  draftCount: number;
  adoptedAsIs: number;
  adoptedEdited: number;
  discarded: number;
  autoSent: number;
}

/**
 * DraftStatus → 六欄映射（★ complaints/rollbacks 唔喺度 — 佢哋係即時記帳欄）。
 * draftCount = 全部 status 總和；PROPOSED 只入 draftCount（尚未裁決）。
 */
export function aggregateDraftRows(rows: DraftAggInput[]): Map<string, WeekAgg> {
  const out = new Map<string, WeekAgg>();
  for (const r of rows) {
    const category = r.intent ?? "UNKNOWN";
    const key = `${r.clinicId}|${category}`;
    let a = out.get(key);
    if (!a) {
      a = { draftCount: 0, adoptedAsIs: 0, adoptedEdited: 0, discarded: 0, autoSent: 0 };
      out.set(key, a);
    }
    a.draftCount++;
    switch (r.status) {
      case "SENT_AS_IS":
        a.adoptedAsIs++;
        break;
      case "SENT_EDITED":
        a.adoptedEdited++;
        break;
      case "DISCARDED":
        a.discarded++;
        break;
      case "SENT_AUTO":
        a.autoSent++;
        break;
      case "PROPOSED":
        break; // 只計 draftCount
    }
  }
  return out;
}

// ── DB 入口 ────────────────────────────────────────────────────────────

/**
 * 週統計 cron 入口：聚合上一個 HK 週嘅 AiDraft → upsert AutomationStat。
 * AiDraft 冇 clinicId — 經 conversationId 兩步 map（draft → conversation.clinicId）。
 * 冪等：重跑 = 重算覆蓋（update 白名單唔郁 complaints/rollbacks）。
 */
export async function runWeeklyStats(now: Date = new Date()): Promise<{ weekStart: string; rows: number }> {
  const weekStart = hkWeekStart(new Date(now.getTime() - 7 * DAY_MS)); // 上週
  const [lo, hi] = weekRangeUtc(weekStart);
  const drafts = await prisma.aiDraft.findMany({
    // cwi-window-20260901（P2 / W-2）：COPY_ONLY 過窗草稿剔除 — 佢發唔出，唔計入 adoptRate 分母
    //（AutomationStat.draftCount → eligibility.ts adoptRate L3 升級判定 同一來源）
    where: { createdAt: { gte: lo, lt: hi }, mode: { not: "COPY_ONLY" } },
    select: { conversationId: true, intent: true, status: true },
  });
  if (drafts.length === 0) return { weekStart, rows: 0 };

  const convIds = [...new Set(drafts.map((d) => d.conversationId))];
  const convs = await prisma.conversation.findMany({
    where: { id: { in: convIds } },
    select: { id: true, clinicId: true },
  });
  const clinicOf = new Map(convs.map((c) => [c.id, c.clinicId]));

  const agg = aggregateDraftRows(
    drafts
      .map((d) => ({ clinicId: clinicOf.get(d.conversationId) ?? "", intent: d.intent, status: d.status }))
      .filter((r) => r.clinicId !== "") // conversation 已 delete（retention）→ 無店歸屬，跳過
  );
  let n = 0;
  for (const [key, a] of agg) {
    const [clinicId, category] = key.split("|");
    await prisma.automationStat.upsert({
      where: { clinicId_category_weekStart: { clinicId, category, weekStart } },
      update: { ...a }, // ★ 白名單：complaints/rollbacks 唔喺度
      create: { clinicId, category, weekStart, ...a },
    });
    n++;
  }
  return { weekStart, rows: n };
}

/**
 * 即時記帳（E4）：flag 投訴 / autoBooked 回退 → 該（店,類,週）行 increment 1。
 * 行唔存在 → 先建（其餘欄 0）。冪等唔適用 — 每次事件計一次（冪等喺上層：24h flag 查重）。
 */
export async function bumpStat(
  clinicId: string,
  category: string,
  field: "complaints" | "rollbacks",
  now: Date = new Date()
): Promise<void> {
  const weekStart = hkWeekStart(now);
  const where = { clinicId_category_weekStart: { clinicId, category, weekStart } };
  if (field === "complaints") {
    await prisma.automationStat.upsert({
      where,
      update: { complaints: { increment: 1 } },
      create: { clinicId, category, weekStart, complaints: 1 },
    });
  } else {
    await prisma.automationStat.upsert({
      where,
      update: { rollbacks: { increment: 1 } },
      create: { clinicId, category, weekStart, rollbacks: 1 },
    });
  }
}

/** 儀表板用：最近四個完整週嘅全部 AutomationStat row（一次過撈矩陣用）。 */
export async function statsForEligibilityWindow(now: Date = new Date()): Promise<
  {
    id: string;
    clinicId: string;
    category: string;
    weekStart: string;
    draftCount: number;
    adoptedAsIs: number;
    adoptedEdited: number;
    discarded: number;
    autoSent: number;
    complaints: number;
    rollbacks: number;
  }[]
> {
  const weeks = lastFourCompleteWeeks(now);
  return prisma.automationStat.findMany({ where: { weekStart: { in: weeks } } });
}

import prisma from "@/lib/prisma";
import { fetchCompanies } from "@/lib/workforce/client";
import log from "@/lib/log";

/**
 * ★ cwi-followup-p0-20260915（MD §1.1）：公司主資料同步（workforce → wa-inbox 快取）。
 *
 * 鐵律：wa-inbox 唔自己維護公司主資料 — Company 表降格做快取（同 ApricotDictionary 同款）。
 * 來源 = workforce GET /api/external/v1/companies（scope org；WORKFORCE_MOCK=1 用決定性 fixture）。
 *
 * 流程（冪等 — cron 03:00 + 手動「立即同步」共用）：
 *   1) name-match（首次同步 data migration）：本地 sourceId=null 公司按 name 對 workforce → 填 sourceId
 *      （MD §1.1 migration 注意 — 對唔上留 null + hub UI 紅字要求人手配對）
 *   2) upsert by sourceId：workforce 公司 → 本地快取（name 漂移以 workforce 為準）
 *   3) Clinic.companyId 按 clinic code 填（workforce 有碼對到先改；對唔到唔動 — 非破壞性）
 *   4) 結果回 summary（呼叫者落 CompanySyncRun 行）
 */

export interface CompanySyncSummary {
  source: "mock" | "live";
  companiesRemote: number;
  companiesUpserted: number;
  companiesCreated: number;
  nameMatched: number;
  clinicsMapped: number;
  /** 對唔上嘅本地公司（sourceId=null）— hub UI 紅字要求人手配對 */
  unmatchedLocal: { id: string; code: string; name: string }[];
}

export type CompanySyncResult =
  | { ok: true; summary: CompanySyncSummary }
  | { ok: false; error: string };

// 同 process  mutex（cron 同手動喺同一 process 唔會重入；跨 process 靠 DB unique 兜底）
let chain: Promise<unknown> = Promise.resolve();

/** 下一個未用嘅公司 code（A/B/C... 單大寫字母 — 對齊 Part A 慣例） */
async function nextCompanyCode(): Promise<string> {
  const rows = await prisma.company.findMany({ select: { code: true } });
  const used = new Set(rows.map((r) => r.code));
  for (let i = 65; i < 91; i++) {
    const c = String.fromCharCode(i);
    if (!used.has(c)) return c;
  }
  // A-Z 用完（P0 唔會到）— 用定長後綴
  let n = 1;
  while (used.has(`C${n}`)) n++;
  return `C${n}`;
}

async function doSync(): Promise<CompanySyncSummary> {
  const remote = await fetchCompanies();
  const summary: CompanySyncSummary = {
    source: process.env.WORKFORCE_MOCK === "1" ? "mock" : "live",
    companiesRemote: remote.companies.length,
    companiesUpserted: 0,
    companiesCreated: 0,
    nameMatched: 0,
    clinicsMapped: 0,
    unmatchedLocal: [],
  };

  // ── 1) name-match（data migration — 冪等，每輪重跑）─────────────────
  const remoteByName = new Map(remote.companies.map((c) => [c.name, c]));
  const localUnmatched = await prisma.company.findMany({ where: { sourceId: null } });
  for (const local of localUnmatched) {
    const m = remoteByName.get(local.name);
    if (!m) continue;
    // sourceId 已被其他本地公司占用 → 跳過（留 null + 紅字，人工處理）
    const taken = await prisma.company.findUnique({ where: { sourceId: m.id } });
    if (taken && taken.id !== local.id) {
      log.warn({ local: local.code, remote: m.id }, "company-sync: name-match 跳過 — sourceId 已被占用");
      continue;
    }
    await prisma.company.update({ where: { id: local.id }, data: { sourceId: m.id } });
    summary.nameMatched++;
  }

  // ── 2) upsert by sourceId（workforce 係 master）────────────────────
  for (const rc of remote.companies) {
    const existing = await prisma.company.findUnique({ where: { sourceId: rc.id } });
    if (existing) {
      if (existing.name !== rc.name) {
        await prisma.company.update({ where: { id: existing.id }, data: { name: rc.name } });
      }
      summary.companiesUpserted++;
    } else {
      let code = await nextCompanyCode();
      try {
        await prisma.company.create({ data: { sourceId: rc.id, name: rc.name, code } });
      } catch (e) {
        // code 撞（並發）→ 換 code 重試一次
        code = await nextCompanyCode();
        await prisma.company.create({ data: { sourceId: rc.id, name: rc.name, code } });
      }
      summary.companiesCreated++;
    }
  }

  // ── 3) Clinic.companyId 按 code 填（非破壞性 — 只改 workforce 有碼對到嘅）──
  for (const rc of remote.companies) {
    const localCo = await prisma.company.findUnique({ where: { sourceId: rc.id } });
    if (!localCo) continue;
    for (const rcClinic of rc.clinics) {
      const localClinic = await prisma.clinic.findUnique({ where: { code: rcClinic.code } });
      if (!localClinic) continue; // W 無呢間店 → 唔理（workforce 獨有店唔自動開）
      if (localClinic.companyId !== localCo.id) {
        await prisma.clinic.update({ where: { id: localClinic.id }, data: { companyId: localCo.id } });
        summary.clinicsMapped++;
      }
    }
  }

  // ── 4) 未配對清單（sourceId 仍然 null）────────────────────────────
  const still = await prisma.company.findMany({
    where: { sourceId: null },
    select: { id: true, code: true, name: true },
  });
  summary.unmatchedLocal = still;

  return summary;
}

/** 同步入口（冪等；error 唔 throw — 回 {ok:false} 令 cron/API 落 failed 行） */
export function syncCompaniesFromWorkforce(): Promise<CompanySyncResult> {
  const run = chain.then(async () => {
    try {
      const summary = await doSync();
      log.info(
        {
          source: summary.source,
          remote: summary.companiesRemote,
          upserted: summary.companiesUpserted,
          created: summary.companiesCreated,
          nameMatched: summary.nameMatched,
          clinicsMapped: summary.clinicsMapped,
          unmatched: summary.unmatchedLocal.length,
        },
        "company-sync: done"
      );
      return { ok: true as const, summary };
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      log.error({ err }, "company-sync: failed");
      return { ok: false as const, error: err };
    }
  });
  // 失敗唔阻断下一輪
  chain = run.then(() => undefined, () => undefined);
  return run;
}

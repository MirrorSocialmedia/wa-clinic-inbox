import prisma from "@/lib/prisma";
import { fetchProviders, type ProvidersResult } from "@/lib/workforce/client";
import log from "@/lib/log";

/**
 * ★ cwi-roster-20261001：醫生名錄自動同步（workforce → wa-inbox Provider/ProviderClinic）。
 *
 * 背景：青衣（TY）係另一個 Apricot 帳號 — 同一個醫生喺原帳號同青衣帳號嘅 practitioner id 唔同。
 *  名錄而家靠 seed（mock-pract-*）或人手改 DB，冇自動同步；落單／搵空檔一定要用【該店帳號】嘅 id。
 *  同步後 inbox 醫生名錄每間店自動用該店實際嘅 practitioner id（來源 = workforce /api/external/v1/providers）。
 *
 * 結構參考 company-sync.ts（冪等、回 summary、唔 throw — 回 {ok:false} 令 cron/API 落 failed 行）。
 *
 * 流程（冪等 — 每鐘 :20 cron + 手動「立即同步醫生名錄」共用）：
 *   1) fetchProviders()（全部店）。fetch 失敗 / clinics 空 → 乜都唔郁，回 {ok:false}
 *   2) 逐間 remote clinic → 本地 Clinic（按 code 對，同 company-sync 口徑）。
 *      對唔到 → unmatchedClinics（唔郁）；同 code 兩間 → skip + log.error（S5-5④ 防呆同款）
 *   3) 逐個 remote provider：upsert by apricotId（name/active/sourceProviderId 以 workforce 為準）
 *      + ProviderClinic link（確保連住呢間店）
 *   4) 修剪（prune）— 只喺 !remote.stale && remote.providers.length > 0 先做（🔴 契約鐵律：
 *      stale/空 = 只加唔刪 — sync 斷咗／暫時冇排診 ≠ 醫生走咗）：
 *      呢間店嘅 ProviderClinic，provider.apricotId 唔喺 remote 集合 → 刪
 *      🔴 保護：有未完結預約嘅唔刪（呢間店 + 呢個 providerApricotId 有 PENDING BookingRequest
 *      或進行中 BookingSession）→ 今次跳過（pruneDeferred++），下次再試
 *   5) 停用：同步完冇任何 ProviderClinic 嘅 Provider → active=false（唔刪行 —
 *      BookingRequest／歷史記錄用 providerApricotId 字串對返名）
 *   6) 回 summary（呼叫者落 ProviderSyncRun 行 — 同 CompanySyncRun 口徑）
 *
 * TZ 口徑（cwi-ux fix07 教訓）：本檔案無日期/時間邏輯（stale 判斷喺 workforce 側）—
 *   測試唔好寫會撞 HKT/UTC 日界嘅斷言。
 */

export interface ProviderSyncSummary {
  source: "mock" | "live";
  clinicsRemote: number;
  clinicsMatched: number;
  /** remote clinicCode 對唔到本地 Clinic（hub UI 紅字 — 要人手核對 clinic code） */
  unmatchedClinics: string[];
  providersUpserted: number;
  linksAdded: number;
  linksPruned: number;
  /** 有未完結預約而跳過 prune 嘅 link 數（下次再試） */
  pruneDeferred: number;
  providersDeactivated: number;
  /** stale 店（syncedAt > 30 分鐘）— 今次只加唔刪（hub UI 黃字） */
  staleClinics: string[];
}

export type ProviderSyncResult =
  | { ok: true; summary: ProviderSyncSummary }
  | { ok: false; error: string };

export interface ProviderSyncOptions {
  /** 測試注入口：覆蓋 remote fetch（預設 = workforce client fetchProviders） */
  fetch?: (clinicCode?: string) => Promise<ProvidersResult>;
}

// 同 process mutex（cron 同手動喺同一 process 唔會重入；跨 process 靠冪等兜底 — 同 company-sync 同款）
let chain: Promise<unknown> = Promise.resolve();

/** 進行中嘅 BookingSession 狀態（COMPLETED/HANDOFF/ABANDONED/CANCELLED = 已完結，唔再保護） */
const ACTIVE_SESSION_STATUSES = ["ACTIVE", "CONFIRMING"] as const;

async function doSync(opts?: ProviderSyncOptions): Promise<ProviderSyncResult> {
  const fetchRemote = opts?.fetch ?? fetchProviders;

  // ── 1) fetch（失敗 / clinics 空 → 乜都唔郁）─────────────────────────
  let remote: ProvidersResult;
  try {
    remote = await fetchRemote();
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    log.error({ err }, "provider-sync: fetch failed");
    return { ok: false, error: `fetch failed: ${err}` };
  }
  if (remote.clinics.length === 0) {
    // 零產出分支都要 log（現有慣例）— workforce 無任何已接 Apricot 嘅店
    log.warn({}, "provider-sync: remote clinics 空 — 乜都唔郁（ok:false）");
    return { ok: false, error: "remote clinics 空（workforce 無已接 Apricot 嘅店）" };
  }

  const summary: ProviderSyncSummary = {
    source: process.env.WORKFORCE_MOCK === "1" ? "mock" : "live",
    clinicsRemote: remote.clinics.length,
    clinicsMatched: 0,
    unmatchedClinics: [],
    providersUpserted: 0,
    linksAdded: 0,
    linksPruned: 0,
    pruneDeferred: 0,
    providersDeactivated: 0,
    staleClinics: [],
  };

  // ── 2) 逐間 remote clinic → 本地 Clinic（按 code 對）────────────────
  // ★ S5-5④ 防呆同款：remote list 同一 code 出現超過一次（兩間同 code 店）→
  //   log.error（淨 code，零 PII）+ skip 該 code（唔同步）— 唔會隨機映射到其中一間。
  const remoteCodeCount = new Map<string, number>();
  for (const rc of remote.clinics) {
    remoteCodeCount.set(rc.clinicCode, (remoteCodeCount.get(rc.clinicCode) ?? 0) + 1);
  }

  for (const rc of remote.clinics) {
    if ((remoteCodeCount.get(rc.clinicCode) ?? 0) > 1) {
      log.error(
        { clinicCode: rc.clinicCode },
        "provider-sync: remote 出現重複 clinic code — skip 該店（S5-5④ 防呆，需人手核對）"
      );
      continue;
    }
    const localClinic = await prisma.clinic.findUnique({ where: { code: rc.clinicCode } });
    if (!localClinic) {
      // 對唔到 → 記 unmatchedClinics（唔郁 — workforce 獨有店唔自動開，同 company-sync 口徑）
      summary.unmatchedClinics.push(rc.clinicCode);
      continue;
    }
    summary.clinicsMatched++;
    if (rc.stale) summary.staleClinics.push(rc.clinicCode);

    const remoteIds = new Set<string>(rc.providers.map((p) => p.apricotId));

    // ── 3) 逐個 remote provider：upsert + link ────────────────────────
    for (const rp of rc.providers) {
      const provider = await prisma.provider.upsert({
        where: { apricotId: rp.apricotId },
        update: { name: rp.name, active: true, sourceProviderId: rp.providerId },
        create: { apricotId: rp.apricotId, name: rp.name, active: true, sourceProviderId: rp.providerId },
      });
      summary.providersUpserted++;
      const link = await prisma.providerClinic.findUnique({
        where: { providerId_clinicId: { providerId: provider.id, clinicId: localClinic.id } },
      });
      if (!link) {
        await prisma.providerClinic.create({ data: { providerId: provider.id, clinicId: localClinic.id } });
        summary.linksAdded++;
      }
    }

    // ── 4) prune — 只喺 !stale && providers 非空（🔴 stale/空 = 只加唔刪）──
    if (!rc.stale && rc.providers.length > 0) {
      const localLinks = await prisma.providerClinic.findMany({
        where: { clinicId: localClinic.id },
        include: { provider: { select: { id: true, apricotId: true } } },
      });
      for (const l of localLinks) {
        // 喺 remote 集合 → 保留
        if (l.provider.apricotId !== null && remoteIds.has(l.provider.apricotId)) continue;
        const apricotId = l.provider.apricotId;

        // 🔴 保護：有未完結預約嘅唔刪（呢間店 + 呢個 providerApricotId）
        const pendingReqs = await prisma.bookingRequest.count({
          where: {
            clinicId: localClinic.id,
            status: "PENDING",
            ...(apricotId ? { providerApricotId: apricotId } : {}),
          },
        });
        const activeSessions = apricotId
          ? await prisma.bookingSession.count({
              where: {
                clinicId: localClinic.id,
                status: { in: [...ACTIVE_SESSION_STATUSES] },
                slots: { path: ["providerApricotId"], equals: apricotId },
              },
            })
          : 0;
        if (pendingReqs > 0 || activeSessions > 0) {
          summary.pruneDeferred++;
          log.info(
            { clinic: localClinic.code, providerApricotId: apricotId ?? "(null)" },
            "provider-sync: prune deferred（有未完結預約 — 下次再試）"
          );
          continue;
        }
        await prisma.providerClinic.delete({
          where: { providerId_clinicId: { providerId: l.provider.id, clinicId: localClinic.id } },
        });
        summary.linksPruned++;
      }
    }
  }

  // ── 5) 停用：冇任何 ProviderClinic 嘅 Provider → active=false（唔刪行）──
  const orphaned = await prisma.provider.findMany({
    where: { clinics: { none: {} }, active: true },
    select: { id: true, name: true },
  });
  for (const p of orphaned) {
    await prisma.provider.update({ where: { id: p.id }, data: { active: false } });
    summary.providersDeactivated++;
  }

  return { ok: true, summary };
}

/** 同步入口（冪等；error 唔 throw — 回 {ok:false} 令 cron/API 落 failed 行） */
export function syncProvidersFromWorkforce(opts?: ProviderSyncOptions): Promise<ProviderSyncResult> {
  const run = chain.then(async () => {
    try {
      const result = await doSync(opts);
      if (result.ok) {
        const s = result.summary;
        log.info(
          {
            source: s.source,
            remote: s.clinicsRemote,
            matched: s.clinicsMatched,
            unmatched: s.unmatchedClinics.length,
            upserted: s.providersUpserted,
            linksAdded: s.linksAdded,
            linksPruned: s.linksPruned,
            pruneDeferred: s.pruneDeferred,
            deactivated: s.providersDeactivated,
            stale: s.staleClinics.length,
          },
          "provider-sync: done"
        );
      }
      return result;
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      log.error({ err }, "provider-sync: failed");
      return { ok: false as const, error: err };
    }
  });
  // 失敗唔阻断下一輪
  chain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * quality_rating 每日監控（MD §9.3 — 「被 ban」嘅前哨指標）。
 *
 * cron `quality-check`（每日 06:30）+ scripts/e2e-quality.ts 共用。
 * - 逐號 `GET /v23.0/{phone_number_id}?fields=quality_rating`
 *   （WA_MOCK=1 → 決定性 GREEN；`WA_MOCK_QUALITY` 可 inject YELLOW/RED 俾 E2E）
 * - 跌落 YELLOW/RED → severity=HIGH alert（type=quality_rating, per clinic）
 * - GREEN → 自動 resolve 該店未解決嘅 quality_rating alert
 * - 攞失敗（4xx/5xx/超時）→ 唔改 rating/checkedAt（log warn）— 唔好因為
 *   Graph 暫時問題就誤報 / 誤清警報
 *
 * 正常情況（行官方 API + 純被動覆客 + 唔做 blast）長期 GREEN（MD §11）。
 *
 * ★ iron rule 1：detail 只准 { rating, previous, ratingCode } — 零訊息原文。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { getPhoneQualityRating, type WaQualityRating } from "@/lib/wa/graph";
import { notifyAlert } from "@/lib/health/notify";

export interface QualityCheckResult {
  checked: number;
  failed: number;
  alerts: number;
  resolved: number;
  ratings: Record<string, string>;
}

export async function runQualityCheck(): Promise<QualityCheckResult> {
  const clinics = await prisma.clinic.findMany({
    select: { id: true, code: true, waPhoneNumberId: true, qualityRating: true },
    orderBy: { code: "asc" },
  });

  const ratings: Record<string, string> = {};
  let checked = 0;
  let failed = 0;
  let alerts = 0;
  let resolved = 0;

  for (const c of clinics) {
    let rating: WaQualityRating;
    try {
      rating = await getPhoneQualityRating(c.waPhoneNumberId);
    } catch (err) {
      failed += 1;
      ratings[c.code] = "FETCH_FAILED";
      log.warn(
        { clinic: c.code, err: err instanceof Error ? err.message : String(err) },
        "quality: fetch failed — rating/checkedAt 保持舊值（唔誤報）"
      );
      continue;
    }

    checked += 1;
    ratings[c.code] = rating;
    await prisma.clinic.update({
      where: { id: c.id },
      data: { qualityRating: rating, qualityCheckedAt: new Date() },
    });

    if (rating === "GREEN") {
      // 恢復 → 自動 resolve 未解決嘅 quality_rating alert
      const r = await prisma.alert.updateMany({
        where: { type: "quality_rating", clinicId: c.id, resolvedAt: null },
        data: { resolvedAt: new Date() },
      });
      if (r.count > 0) resolved += r.count;
      log.info({ clinic: c.code, rating }, "quality: GREEN");
    } else {
      // YELLOW / RED → HIGH（MD 明言：被 ban 前哨）
      // 冪等：同店未解決 quality_rating alert 存在就唔重覆開
      const existing = await prisma.alert.findFirst({
        where: { type: "quality_rating", clinicId: c.id, resolvedAt: null },
        select: { id: true },
      });
      if (!existing) {
        await prisma.alert.create({
          data: {
            type: "quality_rating",
            severity: "HIGH",
            clinicId: c.id,
            clinicCode: c.code,
            detail: { rating, previous: c.qualityRating ?? null },
          },
        });
        await notifyAlert({
          type: "quality_rating",
          severity: "HIGH",
          clinicCode: c.code,
          detail: { rating, previous: c.qualityRating ?? null },
        });
        alerts += 1;
      }
      log.warn(
        { clinic: c.code, rating, previous: c.qualityRating ?? null },
        "quality: YELLOW/RED — 被 ban 前哨警報（检查該號發送行為）"
      );
    }
  }

  log.info({ checked, failed, alerts, resolved, ratings }, "quality-check done");
  return { checked, failed, alerts, resolved, ratings };
}

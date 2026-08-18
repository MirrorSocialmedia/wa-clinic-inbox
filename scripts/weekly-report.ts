/**
 * weekly-report — 手動跑營運週報（同 cron `weekly-report` job 同一核心）。
 *
 * 用法（repo root）：
 *   pnpm weekly-report                          # 上一週（週一→下週一，本地時區），ALL + 逐店
 *   pnpm weekly-report --start 2026-08-10 --end 2026-08-17   # 明確 period（補跑/E2E）
 *   pnpm weekly-report --start 2026-08-10 --end 2026-08-17 --clinic E2E   # 單店 scope
 *
 * 行為：計算 → 存 OpsReport（upsert 冪等）→ 打印 text + JSON。
 * cron 路徑（runWeeklyReport）會再經 ALERT_CHANNEL 推送；手動路徑只打印（避免重復通知）。
 */
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* 靠 process env */
}

import prisma from "../src/lib/prisma";
import { computeAndSaveReport, previousWeekBounds, periodFromDates } from "../src/lib/ops/report";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const startStr = arg("start");
const endStr = arg("end");
const clinicCode = arg("clinic");

async function main() {
  let period;
  if (startStr && endStr) {
    period = periodFromDates(startStr, endStr);
  } else {
    period = previousWeekBounds();
  }

  let clinicId: string | null = null;
  if (clinicCode) {
    const c = await prisma.clinic.findUnique({ where: { code: clinicCode }, select: { id: true } });
    if (!c) {
      console.error(`FAIL: clinic ${clinicCode} 唔存在`);
      process.exit(1);
    }
    clinicId = c.id;
  }

  const { metrics, text } = await computeAndSaveReport(period, clinicId);
  console.log(text);
  console.log("---JSON---");
  console.log(JSON.stringify(metrics, null, 2));
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(`FAIL: ${err instanceof Error ? err.stack ?? err.message : err}`);
  process.exit(1);
});

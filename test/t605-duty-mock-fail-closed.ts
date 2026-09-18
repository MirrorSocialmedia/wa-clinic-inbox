/**
 * T605 — cwi-final S0-1：DUTY_MOCK fail-closed + bootMockGuard
 *
 * 施工單 T605：NODE_ENV=production DUTY_MOCK=（漏設）時 fetchDutyRoster 走真 client
 * 分支（mock fetch 被 call），唔再預設回 fixture。
 *
 * 附加：bootMockGuard — production + mock flag=1（無 ALLOW_MOCK_IN_PROD）→ exit(1)。
 *
 * 跑法（由 test 執行層控制 env；WORKFORCE_MOCK=0 係防 Prisma auto-load .env 帶 1 入嚟）：
 *   NODE_ENV=production DUTY_MOCK= WORKFORCE_MOCK=0 WORKFORCE_API_URL=http://mock.invalid:9999 \
 *   pnpm tsx test/t605-duty-mock-fail-closed.ts
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

async function main(): Promise<void> {
  // ── Part 1：DUTY_MOCK 漏設 → 真 client 分支（mock fetch 被 call） ──────
  if (process.env.NODE_ENV !== "production") throw new Error("T605: NODE_ENV=production 必須（跑法註明）");
  if (process.env.DUTY_MOCK !== "") throw new Error(`T605: DUTY_MOCK 必須空（跑法註明），actual=${JSON.stringify(process.env.DUTY_MOCK)}`);
  if (!process.env.WORKFORCE_API_URL) throw new Error("T605: WORKFORCE_API_URL 必須設（令真分支行到 HTTP 層）");

  const calls: Array<{ url: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    calls.push({ url });
    // workforce v1 shape：2 人（刻意唔同 fixture 嘅 3 人 — 斷言唔係回 fixture）
    return new Response(
      JSON.stringify({
        v: 1,
        staff: [
          { staffName: "T605甲", role: "doctor", shiftStart: "09:00", shiftEnd: "18:00" },
          { staffName: "T605乙", role: "nurse", shiftStart: "10:00", shiftEnd: "17:00" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  // ★ PrismaClient instantiate 會 auto-load repo 根 .env（dev WORKFORCE_MOCK=1）—
  //   import 前明確設 0（dotenv 唔蓋已存在 env），確保 workforce client 行真 HTTP 層（畀 spy 攞到）。
  process.env.WORKFORCE_MOCK = "0";

  const mod = await import("../src/lib/duty/client");
  // tsx/CJS interop：動態 import 可能將 named exports 包喺 .default 下 — 兩邊都防
  const client = ((mod as unknown as { default?: typeof mod }).default ?? mod) as typeof mod;
  const { fetchDutyRoster, __resetDutyCache } = client;
  __resetDutyCache();

  const entries = await fetchDutyRoster("TKW", "2026-09-18");

  if (calls.length === 0) throw new Error(`T605 FAIL: 真 client 分支未行（fetch 零 call）— DUTY_MOCK fail-closed 未生效`);
  if (!calls[0].url.includes("duty-roster")) throw new Error(`T605 FAIL: fetch URL 唔似 duty-roster endpoint: ${calls[0].url}`);
  if (!entries || entries.length !== 2 || entries[0].staffName !== "T605甲") {
    throw new Error(`T605 FAIL: 回數唔係真 client 結果（疑似回 fixture）: ${JSON.stringify(entries?.map((e) => e.staffName))}`);
  }
  console.log("T605 part1 PASS: DUTY_MOCK 漏設 → 真 client 分支（fetch called，回 mock HTTP 2 人）");

  // ── Part 2：bootMockGuard — production + mock flag → exit(1) ──────────
  const probe = `
    (async () => {
      process.env.NODE_ENV = "production";
      process.env.DUTY_MOCK = "1";
      delete process.env.ALLOW_MOCK_IN_PROD;
      const m = await import(${JSON.stringify(path.resolve("src/lib/boot-key-paths.ts"))});
      (m.default ?? m).bootMockGuard();
      process.exit(0);
    })();
  `;
  const r = spawnSync(process.execPath, ["--import", "tsx", "-e", probe], { encoding: "utf8", cwd: process.cwd() });
  if (r.status !== 1) {
    throw new Error(`T605 FAIL: bootMockGuard production+DUTY_MOCK=1 應 exit(1)，actual=${r.status} stderr=${(r.stderr ?? "").slice(0, 300)}`);
  }
  console.log("T605 part2 PASS: bootMockGuard production + DUTY_MOCK=1 → exit(1)");

  // ── Part 3：ALLOW_MOCK_IN_PROD=1 放行（唔 exit） ─────────────────────
  const probe2 = `
    (async () => {
      process.env.NODE_ENV = "production";
      process.env.DUTY_MOCK = "1";
      process.env.ALLOW_MOCK_IN_PROD = "1";
      const m = await import(${JSON.stringify(path.resolve("src/lib/boot-key-paths.ts"))});
      (m.default ?? m).bootMockGuard();
      process.exit(0);
    })();
  `;
  const r2 = spawnSync(process.execPath, ["--import", "tsx", "-e", probe2], { encoding: "utf8", cwd: process.cwd() });
  if (r2.status !== 0) {
    throw new Error(`T605 FAIL: ALLOW_MOCK_IN_PROD=1 應放行（exit 0），actual=${r2.status} stderr=${(r2.stderr ?? "").slice(0, 300)}`);
  }
  console.log("T605 part3 PASS: ALLOW_MOCK_IN_PROD=1 放行");

  console.log("T605 ALL PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

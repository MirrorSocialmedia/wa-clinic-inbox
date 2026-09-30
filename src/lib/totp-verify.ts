import { matchedTotpStep } from "@/lib/totp";
// ★ cwi-qa CI-R1：request 路徑用有 commandTimeout 嘅 client（Redis 斷線唔會令請求吊死）
import { getAppRedis as getRedis } from "@/lib/queue";
import log from "@/lib/log";

/**
 * ★ cwi-qa FX-14（QA-14）：TOTP step 驗證 + 防重放（拆出純函數俾 unit test 直調）。
 *
 * 現行（修前）：`GET totp:last` → 比較 → `SET totp:last` 非原子 → 同一 code 兩個並發
 * 請求都讀到舊 last → 都過（T766：應 1×200 + 1×401）。
 *
 * 修後（保留 S3-5 語義 + 原子化）：
 * 1. `matchedTotpStep`（window ±1）→ null = 錯/過期 → bad
 * 2. step 唔准倒退：step <= totp:last → replay（舊守衛保留）
 * 3. ★ 原子 claim：`SET totp:used:<staffId>:<step> 1 EX 120 NX` — 第一個請求攞到該 step；
 *    返回 null（已被攞，包含同 step 並發）→ replay
 * 4. 成功後 `SET totp:last:<staffId> <step> EX 120`（倒退檢查基準，best-effort）
 *
 * Redis 故障口徑（同 S3-5 現行 fail-open）：used NX 拋錯 → 降級只靠 totp:last
 *（唔阻登入，log warn）。
 */
export async function verifyTotpStep(
  staffId: string,
  secretB32: string,
  code: string
): Promise<{ ok: true; step: number } | { ok: false; reason: "bad" | "replay" }> {
  const step = matchedTotpStep(secretB32, code);
  if (step === null) return { ok: false, reason: "bad" };
  // ① step 唔准倒退（S3-5 原有守衛 — 保留）
  let last: string | null = null;
  try {
    last = await getRedis().get(`totp:last:${staffId}`);
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "login: totp:last Redis 讀失敗（fail-open）");
  }
  if (last !== null && last !== "" && step <= parseInt(last, 10)) {
    return { ok: false, reason: "replay" };
  }
  // ② ★ FX-14 原子 claim — 呢步先係並發安全嘅防重放核心（SET NX 原子）
  let claimed: string | null;
  try {
    claimed = await getRedis().set(`totp:used:${staffId}:${step}`, "1", "EX", 120, "NX");
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "login: totp:used Redis 寫失敗（防重放降級 — 靠 totp:last）");
    claimed = "OK";
  }
  if (claimed === null) return { ok: false, reason: "replay" };
  // ③ 更新倒退檢查基準（best-effort — 失敗唔阻登入，同 S3-5 口徑）
  try {
    await getRedis().set(`totp:last:${staffId}`, String(step), "EX", 120);
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "login: totp:last Redis 寫失敗（防重放降級 — 登入放行）");
  }
  return { ok: true, step };
}

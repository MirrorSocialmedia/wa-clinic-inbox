/**
 * 病人記錄刷新狀態機（followup-v2 MD §3.1b — 五態）
 *
 *   正常（1–24h）  灰字「資料截至 {時間}」+ [立即更新]
 *   更新中         「更新緊…（由 Apricot 取最新）」+ spinner（掣 disable）
 *   剛更新（<1h）  綠點「● 剛剛更新（MM/DD HH:mm）」；60 秒內掣顯示倒數
 *   滯後（>24h）   黃底「⚠ 資料可能滯後 — 撳立即更新」
 *   失敗           「Apricot 未接通，顯示緊 {lastSyncedAt} 嘅資料」可重試
 *
 * 顏色三態同醫生時間表嗰套一致（<1h 綠 ok / 1–24h 灰 / >24h 黃 warn）。
 * 純函數（零 I/O）— unit test 直接斷言。
 */

export const FRESH_MS = 3_600_000; // <1h
export const STALE_MS = 24 * 3_600_000; // >24h
/** MD §2.8 保護 1：同一病人 60 秒一次（UI 倒數 = 同一口徑）。 */
export const REFRESH_COOLDOWN_MS = 60_000;

/** syncedAt 分三態（syncedAt 缺失 = none，唔算失敗 — 病人可能無索引行）。 */
export type BaseSyncState = "fresh" | "normal" | "stale" | "none";

export function baseSyncState(syncedAt: string | null, now: number): BaseSyncState {
  if (!syncedAt) return "none";
  const t = Date.parse(syncedAt);
  if (!Number.isFinite(t)) return "none";
  const age = now - t;
  if (age < FRESH_MS) return "fresh";
  if (age <= STALE_MS) return "normal";
  return "stale";
}

/** 刷新操作狀態（UI 層）— refreshing / cooldown / rate_limited / failed。 */
export type RefreshPhase =
  | { kind: "idle" }
  | { kind: "refreshing"; silent: boolean }
  | { kind: "cooldown"; readyAt: number } // 成功後 60s 倒數（§2.8 限流口徑）
  | { kind: "rate_limited"; readyAt: number; retryAfterSec: number } // 429
  | { kind: "failed" }; // 503/網絡斷 — 用最近一次 syncedAt 顯示「顯示緊…嘅資料」

export type Tone = "green" | "gray" | "yellow" | "red";

/** 顯示行（五態合一）— tone 對齊主題：green=ok / gray=panel-2 / yellow=warn / red=danger。 */
export function syncDisplay(
  base: BaseSyncState,
  syncedAt: string | null,
  phase: RefreshPhase,
  now: number,
): { text: string; tone: Tone } {
  if (phase.kind === "refreshing") return { text: "更新緊…（由 Apricot 取最新）", tone: "gray" };
  if (phase.kind === "rate_limited") {
    const left = Math.max(0, Math.ceil((phase.readyAt - now) / 1000));
    return { text: `Apricot 限流中 — ${left}s 後可再更新`, tone: "yellow" };
  }
  if (phase.kind === "failed") {
    return syncedAt
      ? { text: `Apricot 未接通，顯示緊 ${fmtSyncAt(syncedAt)} 嘅資料`, tone: "red" }
      : { text: "Apricot 未接通 — 暫時取唔到資料", tone: "red" };
  }
  switch (base) {
    case "fresh":
      return { text: `● 剛剛更新（${fmtSyncAt(syncedAt)}）`, tone: "green" };
    case "normal":
      return { text: `資料截至 ${fmtSyncAt(syncedAt)}`, tone: "gray" };
    case "stale":
      return { text: "⚠ 資料可能滯後 — 撳立即更新", tone: "yellow" };
    case "none":
      return { text: "尚未同步到病人記錄", tone: "gray" };
  }
}

/** 更新掣（五態對應動作）。 */
export function refreshButton(
  base: BaseSyncState,
  phase: RefreshPhase,
  now: number,
): { label: string; disabled: boolean } {
  if (phase.kind === "refreshing") return { label: "更新緊…", disabled: true };
  if (phase.kind === "cooldown") {
    const left = Math.max(0, Math.ceil((phase.readyAt - now) / 1000));
    return { label: `${left}s 後可再更新`, disabled: true };
  }
  if (phase.kind === "rate_limited") {
    const left = Math.max(0, Math.ceil((phase.readyAt - now) / 1000));
    return { label: `${left}s 後重試`, disabled: true };
  }
  if (phase.kind === "failed") return { label: "重試", disabled: false };
  if (base === "stale") return { label: "立即更新", disabled: false };
  if (base === "none") return { label: "同步", disabled: false };
  return { label: "立即更新", disabled: false };
}

/** MM/DD HH:mm（HK 時區 — 同前台其他時間顯示口徑）。 */
export function fmtSyncAt(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  try {
    const d = new Intl.DateTimeFormat("zh-HK", {
      timeZone: "Asia/Hong_Kong",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(t));
    const g = (k: Intl.DateTimeFormatPartTypes) => d.find((p) => p.type === k)?.value ?? "";
    return `${g("month")}/${g("day")} ${g("hour")}:${g("minute")}`;
  } catch {
    return new Date(t).toISOString().slice(5, 16).replace("T", " ");
  }
}

/** MM/DD（HK）— header chip「上次到診 09/14」。 */
export function fmtDateShort(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(`${iso.length === 10 ? `${iso}T00:00:00` : iso}`);
  if (!Number.isFinite(t)) return "";
  try {
    const d = new Intl.DateTimeFormat("zh-HK", {
      timeZone: "Asia/Hong_Kong",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(t));
    const g = (k: Intl.DateTimeFormatPartTypes) => d.find((p) => p.type === k)?.value ?? "";
    return `${g("month")}/${g("day")}`;
  } catch {
    return iso.slice(5);
  }
}

/** $16,200（千分位，零小數）。 */
export function fmtAmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

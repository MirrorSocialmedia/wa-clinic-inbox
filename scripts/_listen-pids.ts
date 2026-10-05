/**
 * _listen-pids — port-scoped kill-by-PID 純 helper（cwi-labdoc-followup m-7）。
 *
 * 背景（鐵律：禁 pattern kill — `pkill -f " server.ts"` 會誤殺本地 dev 3100 / 其他 repo 嘅 server）：
 *   e2e script 統一用「`lsof -ti:<port> -sTCP:LISTEN` → 得 PID → kill 嗰啲 PID」清理 server；
 *   冇 listener = no-op。
 *   ⚠ 必帶 `-sTCP:LISTEN`：裸 `lsof -ti:<port>` 會連 established connection 都列（包括本 process
 *     自己 fetch keep-alive socket）→ kill 會自殺（2026-09-24 T634 實測）。
 *
 * 解 parse 抽成純函數 → unit testable（scripts/unit-port-kill-pids.ts）— e2e script 本身
 * 禁止本地跑（top-level 自跑 main），唔可以直接 import 入 unit。
 */

/**
 * 解析 `lsof -ti:<port> -sTCP:LISTEN` stdout → LISTEN pid 列表（純函數）。
 * lsof 正常輸出 = 一行一個 PID；用泛 whitespace split 容錯（trailing 空行 / 異常字元 → filter 掉，
 * 唔 throw — caller 照舊係「kill 到邊個 kill 邊個」best-effort 語義）。
 */
export function parseListenPids(out: string): number[] {
  return out
    .split(/\s+/)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
}

#!/usr/bin/env bash
# ★ cwi-final F-5：Stage 0 全套迴歸（dev stack 要 live）
#   環境適配：worktree symlink node_modules 下 pnpm 執行 script 會撞 ERR_PNPM_UNSAFE_MODULES_DIR
#   → 加 --config.verify-deps-before-run=false（main tree/CI 上無害，只跳過跑前 deps 狀態檢查）
#   ★ login pacing：/api/auth/login 有 per-IP in-memory 限流（5 次/60s，見 login/route.ts）—
#   所有 e2e 都係 127.0.0.1（clientIp="local" 共用配額）→ script 之間 sleep 65s 避 429
#   （2026-09-19 實測：第 3 輪 suite t608/t609/t750/t751 連坐 429；第 1/2 輪自然 pacing 過咗）
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
for s in t600 t601 t601b t602 t605 t606 t608 t609 t750 t751; do
  echo "▶ $s"
  pnpm --config.verify-deps-before-run=false -s "e2e:$s" || { echo "❌ $s"; fail=1; }
  sleep 65
done
[ $fail -eq 0 ] && echo "S0 ALL GREEN" || { echo "S0 FAILED"; exit 1; }

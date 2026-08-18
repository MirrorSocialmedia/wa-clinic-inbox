#!/usr/bin/env bash
#
# e2e-real-ai — 真 AI 實測（本地 sglang）+ 逐舖 AUTO 鐵律（Phase 2b 任務 A）。
#
# 同 mock-e2e 嘅分別：
#   - AI 用真 sglang（AI_MOCK=0）：endpoint/model 由 .env 決定
#     （VLLM_BASE_URL=http://127.0.0.1:30000/v1, VLLM_MODEL=/models/Qwen3.8-27B-FP8）
#   - WhatsApp 照 mock（WA_MOCK=1）
#   - 斷言用「合理範圍」（真 AI 輸出唔係 100% 決定性）；每 case 連 3 次失敗先 fail
#
# 流程：infra check → sglang 探活 → migrate + seed → 起 server + worker（AI_MOCK=0）
#       → tsx scripts/e2e-real-ai.ts（3 類 intent 實測 + ai-status 欄位 + latency/tokens）
#
set -u
cd "$(dirname "$0")/.."

# ── env（.env 提供 sglang endpoint/model；呢度強制 AI_MOCK=0 WA_MOCK=1） ────
set -a
# shellcheck disable=SC1091
. ./.env
set +a
export AI_MOCK=0
export AI_MOCK_FAIL=
export WA_MOCK=1

TSX=./node_modules/.bin/tsx
PORT="${PORT:-3100}"
BASE="http://127.0.0.1:${PORT}"

echo "════════════════════════════════════════════"
echo " WA Clinic Inbox — Real-AI E2E (sglang)"
echo "════════════════════════════════════════════"

# ── 0. infra + sglang 探活 ───────────────────────────────────────────────
echo "[0/4] infra + sglang..."
redis-cli ping 2>/dev/null | grep -q PONG || { echo "FATAL: redis not running on 6379"; exit 1; }
if ! pg_isready -h 127.0.0.1 -p 15432 -q 2>/dev/null; then
  echo "  starting embedded postgres..."
  nohup pnpm dev:db >/tmp/e2e-pg.log 2>&1 &
  for i in $(seq 1 60); do pg_isready -h 127.0.0.1 -p 15432 -q 2>/dev/null && break; sleep 1; done
fi
pg_isready -h 127.0.0.1 -p 15432 -q 2>/dev/null || { echo "FATAL: postgres not reachable on 15432"; exit 1; }

SG_BASE="${VLLM_BASE_URL:-}"
SG_MODEL="${VLLM_MODEL:-}"
[ -n "$SG_BASE" ] || { echo "FATAL: VLLM_BASE_URL 未設（.env）"; exit 1; }
[ -n "$SG_MODEL" ] || { echo "FATAL: VLLM_MODEL 未設（.env）"; exit 1; }
echo "  endpoint=$SG_BASE model=$SG_MODEL"
MODELS_JSON=$(curl -sf --max-time 10 "$SG_BASE/models" 2>/dev/null) || { echo "FATAL: sglang /models 唔通（$SG_BASE）"; exit 1; }
echo "$MODELS_JSON" | grep -qF "$SG_MODEL" || { echo "FATAL: sglang /models 搵唔到 model id: $SG_MODEL"; echo "$MODELS_JSON" | head -c 400; exit 1; }
echo "  sglang OK（model 在線）"

# ── 1. migrate + seed ───────────────────────────────────────────────────
echo "[1/4] migrate + seed..."
pnpm migrate:deploy >/tmp/e2e-migrate.log 2>&1 || { echo "FATAL: migrate failed"; tail -20 /tmp/e2e-migrate.log; exit 1; }
pnpm db:seed >/tmp/e2e-seed.log 2>&1 || { echo "FATAL: seed failed"; tail -20 /tmp/e2e-seed.log; exit 1; }
[ -f .dev/credentials.txt ] || { echo "FATAL: .dev/credentials.txt missing"; exit 1; }
echo "  OK"

# ── 2. 起 server + worker（AI_MOCK=0 真 sglang / WA_MOCK=1） ─────────────
echo "[2/4] start server + worker (AI_MOCK=0, WA_MOCK=1)..."
pkill -f "src/workers/index.ts" 2>/dev/null || true
pkill -f " server.ts" 2>/dev/null || true
sleep 1
lsof -ti:"$PORT" 2>/dev/null | xargs -r kill 2>/dev/null || true
sleep 1
nohup pnpm dev >/tmp/e2e-realai-server.log 2>&1 &
SERVER_PID=$!
nohup pnpm worker >/tmp/e2e-realai-worker.log 2>&1 &
WORKER_PID=$!
cleanup() {
  kill "$WORKER_PID" "$SERVER_PID" 2>/dev/null || true
  sleep 1
  kill -9 "$WORKER_PID" "$SERVER_PID" 2>/dev/null || true
  pkill -f "src/workers/index.ts" 2>/dev/null || true
  pkill -f " server.ts" 2>/dev/null || true
}
trap cleanup EXIT

UP=0
for i in $(seq 1 90); do
  if curl -sf "$BASE/healthz" >/dev/null 2>&1; then UP=1; break; fi
  sleep 1
done
[ "$UP" = 1 ] || { echo "FATAL: server 90s 未起"; tail -30 /tmp/e2e-realai-server.log; exit 1; }
echo "  server + worker up (pid $SERVER_PID / $WORKER_PID)"

# ── 3. 真 AI 實測 ─────────────────────────────────────────────────────────
echo "[3/4] real-AI cases..."
if ! "$TSX" scripts/e2e-real-ai.ts; then
  echo "  (server log tail)"
  tail -20 /tmp/e2e-realai-server.log 2>/dev/null
  echo "  (worker log tail)"
  tail -20 /tmp/e2e-realai-worker.log 2>/dev/null
  exit 1
fi

# ── 4. 完成 ─────────────────────────────────────────────────────────────
echo "[4/4] done."
echo "════════════════════════════════════════════"
echo " Real-AI E2E: ALL GREEN"
echo "════════════════════════════════════════════"

#!/usr/bin/env bash
# drill-2-redis-down — Redis 停演習（最終版：系統 unit failed，手動 redis 全控制）
#
# 停機窗口完全受控：redis-cli shutdown nosave → 手動 redis-server 起返（runbook 程序）。
set -u
cd "$(dirname "$0")/.."
BASE=http://127.0.0.1:3100
Q=./node_modules/.bin/tsx
TS() { date +%s%3N; }
now() { date '+%H:%M:%S'; }

PAT="8526931$(date +%s)"
SUF=$(date +%s)
WAMID_OK="wamid.DRILL2F_A_$SUF"
WAMID_DOWN="wamid.DRILL2F_B_$SUF"

echo "═══ 1. baseline（Redis 正常）═══ [$(now)]"
pnpm -s mock-inbound message --clinic TKW --from "$PAT" --text "演習：Redis 演習第一則" --wamid "$WAMID_OK" --name "演習病人R3" >/dev/null
sleep 6
I1=$($Q scripts/e2e-query.ts "SELECT (\"intent\" IS NOT NULL)::text i FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PAT'" 2>/dev/null | grep -oE '"i":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "baseline: intent set = $I1 (expect true)"

echo "═══ 2. t1: Redis 停（shutdown nosave）═══"
T1=$(TS); echo "t1=$(now) ($T1)"
redis-cli shutdown nosave 2>/dev/null || true
sleep 1
redis-cli ping 2>&1 | head -1
HZ=$(curl -s --max-time 8 "$BASE/healthz")
echo "  healthz 停機中: $HZ"

echo "═══ 3. 停機期間入站（webhook 會 hang — 背景等）═══"
pnpm -s mock-inbound message --clinic TKW --from "$PAT" --text "演習：Redis 停咗嗰陣一則" --wamid "$WAMID_DOWN" --name "演習病人R3" >/tmp/drill2f-hang.out 2>&1 &
HANG_PID=$!
sleep 10
DBHIT=$($Q scripts/e2e-query.ts "SELECT count(*)::text c FROM \"Message\" WHERE \"waMessageId\"='$WAMID_DOWN'" 2>/dev/null | grep -oE '"c":"[^"]*"' | head -1 | cut -d'"' -f4)
WPID=$(pgrep -f "src/workers/index[.]ts" | head -1)
echo "  +10s: DB count=$DBHIT (request hang 緊) | worker pid=${WPID:-GONE}"

echo "═══ 4. t2: operator 恢復（手動起 redis — runbook 程序）═══"
T2=$(TS); echo "t2=$(now) ($T2) — 停機 $(( T2 - T1 )) ms"
redis-server --bind 127.0.0.1 --port 6379 --daemonize yes --save ''
for i in $(seq 1 15); do redis-cli ping 2>/dev/null | grep -q PONG && break; sleep 0.5; done
redis-cli ping
echo "  等 hang 住嘅 webhook 完成..."
T3=""
for i in $(seq 1 60); do
  if ! kill -0 "$HANG_PID" 2>/dev/null; then T3=$(TS); break; fi
  sleep 1
done
cat /tmp/drill2f-hang.out
[ -n "$T3" ] && echo "  webhook 放行 @ +$(( T3 - T1 )) ms"

echo "═══ 5. worker 狀態（shutdown nosave 可能令 worker 因 Missing key 退出 — PM2 重啟點）═══"
WPID2=$(pgrep -f "src/workers/index[.]ts" | head -1)
if [ -z "$WPID2" ]; then
  echo "  worker 已退出（Missing key → 設計上 exit 等 supervisor 重啟）— 手動重啟..."
  T5=$(TS)
  (nohup pnpm worker > /tmp/drill-worker4.log 2>&1 &)
  for i in $(seq 1 40); do grep -q "all workers running" /tmp/drill-worker4.log 2>/dev/null && break; sleep 1; done
  WPID2=$(pgrep -f "src/workers/index[.]ts" | head -1)
  echo "  worker 重啟完成 pid=$WPID2 (+$(( $(TS) - T5 )) ms)"
fi

echo "═══ 6. 訊息處理確認 ═══"
T4=""
for i in $(seq 1 45); do
  DBHIT=$($Q scripts/e2e-query.ts "SELECT count(*)::text c FROM \"Message\" WHERE \"waMessageId\"='$WAMID_DOWN'" 2>/dev/null | grep -oE '"c":"[^"]*"' | head -1 | cut -d'"' -f4)
  [ "$DBHIT" = "1" ] && T4=$(TS) && break
  sleep 1
done
I2=$($Q scripts/e2e-query.ts "SELECT (\"intent\" IS NOT NULL)::text i FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PAT'" 2>/dev/null | grep -oE '"i":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "恢復後: DB count=$DBHIT (expect 1 — 訊息冇丟) | intent set=$I2"
echo
echo "RTO: redis 停機 $(( T2 - T1 )) ms; webhook 放行 $(( T3 - T1 )) ms; 全處理 $(( T4 - T1 )) ms"

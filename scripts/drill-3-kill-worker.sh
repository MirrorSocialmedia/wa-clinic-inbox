#!/usr/bin/env bash
# drill-3-kill-worker — kill worker 演習（MD §9.3 故障演習 3）
# ★ cwi-final S6-1（兩處修正）：
#   ① qcount：llen → zcard — BullMQ 內部結構（wait/active/failed）全部係 ZSET，
#      llen 對 ZSET 會返 WRONGTYPE error（實測 redis-cli type wa-inbox:ai:failed = zset）。
#   ② kill 時機：改為**job 進行中**（active set 有 job 時 kill）— 舊版喺 idle（0 0 0）先 kill。
#      目的：驗在飛 job 唔會丢（BullMQ lock 過期 → 重啟 worker 嘅 stalled check 收回重排）。
# 前提：3100 server + pnpm worker 都跑緊（.env mock flags）；跑完先核 FAILED 無新增。
set -u
cd "$(dirname "$0")/.."
BASE=http://127.0.0.1:3100
Q=./node_modules/.bin/tsx
TS() { date +%s%3N; }
now() { date '+%H:%M:%S'; }

PAT="8526941$(date +%s)"
SUF=$(date +%s)

qcount() {
  # ★ ZSET 口徑（BullMQ）：wait / active / failed 全部 zcard
  W=$(redis-cli zcard wa-inbox:ai:wait 2>/dev/null)
  A=$(redis-cli zcard wa-inbox:ai:active 2>/dev/null)
  F=$(redis-cli zcard wa-inbox:ai:failed 2>/dev/null)
  echo "WAITING=${W:-?} ACTIVE=${A:-?} FAILED=${F:-?}"
}

echo "═══ 0. 前置：worker 必須跑緊 ═══ [$(now)]"
WPID0=$(pgrep -f "src/workers/index[.]ts" | head -1)
[ -n "${WPID0:-}" ] || { echo "  ✗ 冇 worker（pnpm worker 未跑）— 演習無意義"; exit 1; }
FAILED_BASE=$(redis-cli zcard wa-inbox:ai:failed 2>/dev/null); FAILED_BASE=${FAILED_BASE:-0}
echo "  worker pid=$WPID0 | FAILED 基線（24h 殘留）=$FAILED_BASE"

echo "═══ 1. baseline（worker 正常）═══ [$(now)]"
pnpm -s mock-inbound message --clinic TKW --from "$PAT" --text "演習：kill worker 第一則" --wamid "wamid.DRILL3_A_$SUF" --name "演習病人W" >/dev/null
for i in $(seq 1 30); do
  C=$(qcount)
  echo "$C" | grep -q "WAITING=0 ACTIVE=0" && break
  sleep 1
done
echo "  baseline 處理完: $(qcount) (expect WAITING=0 ACTIVE=0；FAILED=既有殘留)"

echo "═══ 2. t1: kill worker（★ job 進行中 — active set 有 job 先 kill）═══"
# burst 8 則（ai worker concurrency=1 → 逐條做，active 窗口穩定；inbound worker 先序化入 ai queue）
for i in 1 2 3 4 5 6 7 8; do
  pnpm -s mock-inbound message --clinic TKW --from "$((PAT + 100 + i))" --text "演習：burst 第 $i 則" --wamid "wamid.DRILL3_C${i}_$SUF" --name "演習病人W$((100 + i))" >/dev/null
done
# 緊密 poll 捕 active（20ms；job 太快而完全捕唔到 → 呢輪無效 exit 1）
A=""
for i in $(seq 1 500); do
  A=$(redis-cli zcard wa-inbox:ai:active 2>/dev/null)
  [ "${A:-0}" -ge 1 ] 2>/dev/null && break
  sleep 0.02
done
if ! [ "${A:-0}" -ge 1 ] 2>/dev/null; then
  echo "  ⚠️ 捕唔到 ACTIVE>=1（job 太快 / worker 無消費）— 呢輪演習無效"; exit 1
fi
echo "  捕到進行中 job（ACTIVE=$A）— 即殺"
WPID=$(pgrep -f "src/workers/index[.]ts" | head -1)
T1=$(TS); echo "t1=$(now) ($T1) (worker pid=$WPID, ACTIVE=$A)"
pkill -f "src/workers/index[.]ts" || true
sleep 1
pgrep -f "src/workers/index[.]ts" >/dev/null && echo "  worker 仲喺？" || echo "  worker GONE"

echo "═══ 3. worker 死咗入 3 則（queue 應該積；在飛 job 留 ACTIVE 等 stalled check）═══"
for i in 1 2 3; do
  pnpm -s mock-inbound message --clinic TKW --from "$((PAT + i))" --text "演習：backlog 第 $i 則" --wamid "wamid.DRILL3_B${i}_$SUF" --name "演習病人W$i" >/dev/null
done
sleep 3
echo "  +3s: $(qcount) (expect WAITING>=3 — ai queue 有 job 積；在飛 job 可能仲喺 ACTIVE (stale))"
echo "  inbox 網頁照常: HTTP=$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/drill-tkw.txt $BASE/inbox)"

echo "═══ 4. t2: operator 重啟 worker（PM2 嘅嘢 — sandbox 手動）═══"
T2=$(TS); echo "t2=$(now) ($T2) — worker 死咗 $(( T2 - T1 )) ms"
(nohup pnpm worker > /tmp/drill-worker5.log 2>&1 &)
for i in $(seq 1 40); do grep -q "all workers running" /tmp/drill-worker5.log 2>/dev/null && break; sleep 1; done
pgrep -f "src/workers/index[.]ts" >/dev/null && echo "  worker 重啟 OK"

echo "═══ 5. backlog drain（★ 在飛 job 由重啟 worker 嘅 stalled check 收回 — BullMQ lock 過期（~30s）先轉回 wait；loop 180s）═══"
T3=""
for i in $(seq 1 90); do
  C=$(qcount)
  echo "$C" | grep -q "WAITING=0 ACTIVE=0" && T3=$(TS) && break
  sleep 2
done
echo "  drain 完: $(qcount)"
DBALL=$($Q scripts/e2e-query.ts "SELECT count(*)::text c FROM \"Message\" WHERE \"waMessageId\" IN ('wamid.DRILL3_A_$SUF','wamid.DRILL3_B1_$SUF','wamid.DRILL3_B2_$SUF','wamid.DRILL3_B3_$SUF','wamid.DRILL3_C1_$SUF','wamid.DRILL3_C2_$SUF','wamid.DRILL3_C3_$SUF','wamid.DRILL3_C4_$SUF','wamid.DRILL3_C5_$SUF','wamid.DRILL3_C6_$SUF','wamid.DRILL3_C7_$SUF','wamid.DRILL3_C8_$SUF')" 2>/dev/null | grep -oE '"c":"[^"]*"' | head -1 | cut -d'"' -f4)
IAI=$($Q scripts/e2e-query.ts "SELECT count(*)::text c FROM \"AiDraft\" d JOIN \"Conversation\" cv ON cv.id=d.\"conversationId\" JOIN \"Contact\" x ON x.id=cv.\"contactId\" WHERE x.\"waId\" LIKE '$PAT%' AND d.\"createdAt\" > now() - interval '10 minutes'" 2>/dev/null | grep -oE '"c":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "  DB: 12 則訊息 (1 baseline + 8 burst + 3 backlog) count=$DBALL (expect 12) | 新 draft=$IAI (expect 12)"
FAILED_NOW=$(redis-cli zcard wa-inbox:ai:failed 2>/dev/null); FAILED_NOW=${FAILED_NOW:-0}
[ "$FAILED_NOW" -le "$FAILED_BASE" ] && echo "  FAILED 無新增（$FAILED_BASE → $FAILED_NOW）" || echo "  ⚠️ FAILED 新增（$FAILED_BASE → $FAILED_NOW）— 在飛 job 可能丢"
echo
if [ -n "$T3" ]; then
  echo "RTO: worker 死咗 $(( T2 - T1 )) ms; 重啟+drain 完 $(( T3 - T1 )) ms"
else
  echo "RTO: drain 180s 內未完 — 見上 queue 狀態（在飛 job stalled check 未收回？）"
fi

#!/usr/bin/env bash
# drill-3-kill-worker — kill worker 演習（MD §9.3 故障演習 3）
set -u
cd "$(dirname "$0")/.."
BASE=http://127.0.0.1:3100
Q=./node_modules/.bin/tsx
TS() { date +%s%3N; }
now() { date '+%H:%M:%S'; }

PAT="8526941$(date +%s)"
SUF=$(date +%s)

qcount() {
  W=$(redis-cli llen wa-inbox:ai:wait 2>/dev/null)
  A=$(redis-cli llen wa-inbox:ai:active 2>/dev/null)
  F=$(redis-cli llen wa-inbox:ai:failed 2>/dev/null)
  echo "WAITING=${W:-?} ACTIVE=${A:-?} FAILED=${F:-?}"
}

echo "═══ 1. baseline（worker 正常）═══ [$(now)]"
pnpm -s mock-inbound message --clinic TKW --from "$PAT" --text "演習：kill worker 第一則" --wamid "wamid.DRILL3_A_$SUF" --name "演習病人W" >/dev/null
sleep 5
echo "  baseline 處理完: $(qcount) (expect 0 0 0)"

echo "═══ 2. t1: kill worker ═══"
WPID=$(pgrep -f "src/workers/index[.]ts" | head -1)
T1=$(TS); echo "t1=$(now) ($T1) (worker pid=$WPID)"
pkill -f "src/workers/index[.]ts" || true
sleep 1
pgrep -f "src/workers/index[.]ts" >/dev/null && echo "  worker 仲喺？" || echo "  worker GONE"

echo "═══ 3. worker 死咗入 3 則（queue 應該積）═══"
for i in 1 2 3; do
  pnpm -s mock-inbound message --clinic TKW --from "$((PAT + i))" --text "演習：backlog 第 $i 則" --wamid "wamid.DRILL3_B${i}_$SUF" --name "演習病人W$i" >/dev/null
done
sleep 3
echo "  +3s: $(qcount) (expect waiting>=2 — ai queue 有 job 積)"
echo "  inbox 網頁照常: HTTP=$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/drill-tkw.txt $BASE/inbox)"

echo "═══ 4. t2: operator 重啟 worker（PM2 嘅嘢 — sandbox 手動）═══"
T2=$(TS); echo "t2=$(now) ($T2) — worker 死咗 $(( T2 - T1 )) ms"
(nohup pnpm worker > /tmp/drill-worker5.log 2>&1 &)
for i in $(seq 1 40); do grep -q "all workers running" /tmp/drill-worker5.log 2>/dev/null && break; sleep 1; done
pgrep -f "src/workers/index[.]ts" >/dev/null && echo "  worker 重啟 OK"

echo "═══ 5. backlog drain ═══"
T3=""
for i in $(seq 1 60); do
  C=$(qcount)
  echo "$C" | grep -q "WAITING=0 ACTIVE=0 FAILED=0" && T3=$(TS) && break
  sleep 2
done
echo "  drain 完: $(qcount)"
DBALL=$($Q scripts/e2e-query.ts "SELECT count(*)::text c FROM \"Message\" WHERE \"waMessageId\" LIKE 'wamid.DRILL3_B%'" 2>/dev/null | grep -oE '"c":"[^"]*"' | head -1 | cut -d'"' -f4)
IAI=$($Q scripts/e2e-query.ts "SELECT count(*)::text c FROM \"AiDraft\" d JOIN \"Conversation\" cv ON cv.id=d.\"conversationId\" JOIN \"Contact\" x ON x.id=cv.\"contactId\" WHERE x.\"waId\" LIKE '$PAT%' AND d.\"createdAt\" > now() - interval '10 minutes'" 2>/dev/null | grep -oE '"c":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "  DB: 3 則訊息 count=$DBALL (expect 3) | 新 draft=$IAI (expect 3)"
echo
echo "RTO: worker 死咗 $(( T2 - T1 )) ms; 重啟+drain 完 $(( T3 - T1 )) ms"

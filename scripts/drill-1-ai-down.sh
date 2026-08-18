#!/usr/bin/env bash
# drill-1-ai-death — AI 死演習（MD §9.3 故障演習 1）
set -u
cd "$(dirname "$0")/.."
BASE=http://127.0.0.1:3100
Q=./node_modules/.bin/tsx
TS() { date +%s%3N; }
now() { date '+%H:%M:%S'; }

TKW_EMAIL=$(awk '/^TKW STAFF:/{print $3}' .dev/credentials.txt)
TKW_PASS=$(awk '/^TKW STAFF:/{split($0,a," / "); print a[2]}' .dev/credentials.txt)
rm -f /tmp/drill-tkw.txt
curl -s -c /tmp/drill-tkw.txt -o /dev/null -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$TKW_EMAIL\",\"password\":\"$TKW_PASS\"}"
TKW_CLINIC_ID=$($Q scripts/e2e-query.ts "SELECT id FROM \"Clinic\" WHERE code='TKW'" 2>/dev/null | grep -oE '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

# 觀察口：TKW = DRAFT（乾淨觀察「無草稿無標籤」；AUTO 舖行為見 T19-T26）
curl -s -b /tmp/drill-admin.txt -o /dev/null -X PATCH "$BASE/api/admin/clinics/$TKW_CLINIC_ID" -H 'Content-Type: application/json' -d '{"aiMode":"DRAFT"}'

PAT="8526901$(date +%s)"
SUF=$(date +%s)

echo "═══ 1. baseline（AI 正常）═══ [$(now)]"
pnpm -s mock-inbound message --clinic TKW --from "$PAT" --text "演習：想問下埋門時間" --wamid "wamid.DRILL1_A_$SUF" --name "演習病人" >/dev/null
sleep 8
I1=$($Q scripts/e2e-query.ts "SELECT \"intent\"::text i FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PAT'" 2>/dev/null | grep -oE '"i":"[^"]*"' | head -1 | cut -d'"' -f4)
D1=$($Q scripts/e2e-query.ts "SELECT count(*)::text c FROM \"AiDraft\" d JOIN \"Conversation\" cv ON cv.id=d.\"conversationId\" JOIN \"Contact\" x ON x.id=cv.\"contactId\" WHERE x.\"waId\"='$PAT'" 2>/dev/null | grep -oE '"c":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "baseline: intent=$I1 drafts=$D1 (expect QUESTION / >=1)"

echo "═══ 2. t1: AI 死（AI_MOCK_FAIL=1）═══"
T1=$(TS); echo "t1=$(now) ($T1)"
pkill -f "src/workers/index[.]ts" 2>/dev/null; sleep 1
AI_MOCK_FAIL=1 nohup pnpm worker >/tmp/drill-worker-aifail.log 2>&1 &
for i in $(seq 1 30); do grep -q "all workers running" /tmp/drill-worker-aifail.log 2>/dev/null && break; sleep 1; done
echo "  AI-fail worker up [$(now)]"
PAT2="8526902$(date +%s)"
pnpm -s mock-inbound message --clinic TKW --from "$PAT2" --text "演習：再問一次時間" --wamid "wamid.DRILL1_B_$SUF" --name "演習病人2" >/dev/null
sleep 25  # 3 attempts + backoff
I2=$($Q scripts/e2e-query.ts "SELECT \"intent\"::text i FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PAT2'" 2>/dev/null | grep -oE '"i":"[^"]*"' | head -1 | cut -d'"' -f4)
D2=$($Q scripts/e2e-query.ts "SELECT count(*)::text c FROM \"AiDraft\" d JOIN \"Conversation\" cv ON cv.id=d.\"conversationId\" JOIN \"Contact\" x ON x.id=cv.\"contactId\" WHERE x.\"waId\"='$PAT2'" 2>/dev/null | grep -oE '"c":"[^"]*"' | head -1 | cut -d'"' -f4)
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/drill-tkw.txt "$BASE/api/conversations")
BREAKER=$(curl -s -b /tmp/drill-admin.txt "$BASE/api/admin/ai-status" | grep -oE '"breaker":\{[^}]*\}')
echo "  AI 死中: intent='${I2:-null}' drafts=$D2 | inbox list HTTP=$CODE | $BREAKER"

echo "═══ 3. t2: 恢復（重啟正常 worker）═══"
T2=$(TS); echo "t2=$(now) ($T2)"
pkill -f "src/workers/index[.]ts" 2>/dev/null; sleep 1
nohup pnpm worker >/tmp/drill-worker2.log 2>&1 &
for i in $(seq 1 30); do grep -q "all workers running" /tmp/drill-worker2.log 2>/dev/null && break; sleep 1; done
PAT3="8526903$(date +%s)"
pnpm -s mock-inbound message --clinic TKW --from "$PAT3" --text "演習：第三次問時間" --wamid "wamid.DRILL1_C_$SUF" --name "演習病人3" >/dev/null
T3=""
for i in $(seq 1 40); do
  I3=$($Q scripts/e2e-query.ts "SELECT \"intent\"::text i FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PAT3'" 2>/dev/null | grep -oE '"i":"[^"]*"' | head -1 | cut -d'"' -f4)
  [ -n "$I3" ] && T3=$(TS) && break
  sleep 1
done
D3=$($Q scripts/e2e-query.ts "SELECT count(*)::text c FROM \"AiDraft\" d JOIN \"Conversation\" cv ON cv.id=d.\"conversationId\" JOIN \"Contact\" x ON x.id=cv.\"contactId\" WHERE x.\"waId\"='$PAT3'" 2>/dev/null | grep -oE '"c":"[^"]*"' | head -1 | cut -d'"' -f4)
BREAKER2=$(curl -s -b /tmp/drill-admin.txt "$BASE/api/admin/ai-status" | grep -oE '"breaker":\{[^}]*\}')
echo "恢復後: intent=${I3:-null} drafts=$D3 | $BREAKER2"
echo
T3E=${T3:-$T2}
echo "RTO: outage 總長=$(( T3E - T1 )) ms（t1→t3）; 恢復程序本身=$(( T3E - T2 )) ms（t2 重啟→t3 首條成功）"

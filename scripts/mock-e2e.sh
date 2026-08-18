#!/usr/bin/env bash
#
# mock-e2e — 一鍵本地 E2E（Phase 1 驗收）。
#
# 流程：infra check → migrate + seed → 起 server + worker →
#       登入 → mock webhook（4 類 + unknown）→ DB 斷言 → mock send → outbound 斷言
#
# 斷言：
#   T1  login（staff-tkw）→ 200 + cookie
#   T2  跨店 403：STAFF(TKW) 撳別店 clinicId → 403（RBAC 鐵律實測）
#   T3  inbound message：Contact/Conversation/Message(IN,API) 建立 + unreadCount=1 + lastInboundAt
#   T4  冪等：重發同一 wamid → 唔重複（Message count 不變）
#   T5  echo：Message(OUT,APP_ECHO) 建立 + unread 唔計
#   T6  history：N 條 HISTORY 訊息 + 唔觸發 unread + 唔入 aiQueue
#   T7  send：202 → outbound worker 發完 → status SENT + waMessageId 有值
#   T8  statuses：read  webhook → status READ
#   T9  窗口過咗：lastInboundAt -25h → send → 422
#   T10 跨店 403（單對話）：STAFF(TKW) 撳 MF 嘅 conversation → 403
#   T11 未登入 401
#   T12 unknown field → webhook 200 + worker 存活
#   T13 AI URGENT_PAIN：「好痛」→ URGENT_PAIN + urgent=true + 無 draft + escalation log（DB+log 斷言）
#   T14 AI BOOKING_REQUEST：「想預約」→ draft 生成（PROPOSED）
#   T15 draft 採用 PATCH（回 draftText）+ 棄用 DELETE（→ DISCARDED）+ 別店 403
#   T16 AI_MOCK_FAIL=1 降級：舊 intent 保留 + 無新 draft + inbox 200 + stats 記 fail
#   T17 HISTORY/APP_ECHO 唔觸發 AI queue（job key count 斷言）
#   T18 log PII 抽查：server/worker log 無訊息原文（metadata only 鐵律）
#
set -u
cd "$(dirname "$0")/.."

# ── env ──────────────────────────────────────────────────────────────────
set -a
# shellcheck disable=SC1091
. ./.env
set +a

TSX=./node_modules/.bin/tsx
PORT="${PORT:-3100}"
BASE="http://127.0.0.1:${PORT}"
COOKIE_TKW=/tmp/e2e-cookie-tkw.txt
COOKIE_MF=/tmp/e2e-cookie-mf.txt
EPOCH=$(date +%s)
PATIENT_TKW="8526001${EPOCH}"   # per-run unique patient（斷言淨化）
PATIENT_MF="8526002${EPOCH}"
IN_WAMID="wamid.E2E_IN_${EPOCH}"
ECHO_WAMID="wamid.E2E_ECHO_${EPOCH}"
HIST_COUNT=10

PASS=0
FAIL=0
pass() { echo "  ✅ PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ FAIL: $1"; FAIL=$((FAIL + 1)); }
check() { # check <desc> <actual> <expected>
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected=[$3] actual=[$2])"; fi
}

# DB query → JSON
q() { "$TSX" scripts/e2e-query.ts "$1" 2>/dev/null; }

# 由 q 輸出 [{"f":"v"}] 提取字段值
jf() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

# 等 DB 狀態（最多 N 秒）
wait_for() { # wait_for <sql> <expected-json> <max-sec>
  local sql="$1" expected="$2" max="$3" i=0 val=""
  while [ "$i" -lt "$max" ]; do
    val=$(q "$sql")
    if [ "$val" = "$expected" ]; then return 0; fi
    sleep 1
    i=$((i + 1))
  done
  echo "    (last: ${val:0:200})"
  return 1
}

echo "════════════════════════════════════════════"
echo " WA Clinic Inbox — mock E2E"
echo "════════════════════════════════════════════"

# ── 0. infra ────────────────────────────────────────────────────────────
echo "[0/9] infra..."
redis-cli ping 2>/dev/null | grep -q PONG || { echo "FATAL: redis not running on 6379"; exit 1; }
if ! pg_isready -h 127.0.0.1 -p 15432 -q 2>/dev/null; then
  echo "  starting embedded postgres..."
  nohup pnpm dev:db >/tmp/e2e-pg.log 2>&1 &
  for i in $(seq 1 60); do
    pg_isready -h 127.0.0.1 -p 15432 -q 2>/dev/null && break
    sleep 1
  done
fi
pg_isready -h 127.0.0.1 -p 15432 -q 2>/dev/null || { echo "FATAL: postgres not reachable on 15432"; exit 1; }
echo "  redis + postgres OK"

# ── 1. migrate + seed ───────────────────────────────────────────────────
echo "[1/9] migrate + seed..."
pnpm migrate:deploy >/tmp/e2e-migrate.log 2>&1 || { echo "FATAL: migrate failed"; tail -20 /tmp/e2e-migrate.log; exit 1; }
pnpm db:seed >/tmp/e2e-seed.log 2>&1 || { echo "FATAL: seed failed"; tail -20 /tmp/e2e-seed.log; exit 1; }
echo "  OK"

# credentials（seed 寫入 .dev/credentials.txt）
if [ ! -f .dev/credentials.txt ]; then
  echo "FATAL: .dev/credentials.txt missing — seed 應該寫入"
  exit 1
fi
TKW_EMAIL=$(awk '/^TKW STAFF:/{print $3}' .dev/credentials.txt)
TKW_PASS=$(awk '/^TKW STAFF:/{split($0,a," / "); print a[2]}' .dev/credentials.txt)
MF_EMAIL=$(awk '/^MF STAFF:/{print $3}' .dev/credentials.txt)
MF_PASS=$(awk '/^MF STAFF:/{split($0,a," / "); print a[2]}' .dev/credentials.txt)
[ -n "$TKW_EMAIL" ] && [ -n "$TKW_PASS" ] || { echo "FATAL: 讀唔到 credentials"; exit 1; }

# clinic ids
TKW_CLINIC_ID=$(q "SELECT id FROM \"Clinic\" WHERE code='TKW'" | jf id)
MF_CLINIC_ID=$(q "SELECT id FROM \"Clinic\" WHERE code='MF'" | jf id)
[ -n "$TKW_CLINIC_ID" ] && [ -n "$MF_CLINIC_ID" ] || { echo "FATAL: clinic id 搵唔到"; exit 1; }
echo "  TKW=$TKW_CLINIC_ID MF=$MF_CLINIC_ID"

# ── 2. 起 server + worker ───────────────────────────────────────────────
echo "[2/9] start server + worker..."
# pre-clean：上一輪 e2e / 手動啟動嘅 tsx worker 會 spawn node 子 process，
# kill pnpm wrapper 殺唔到 — 孤兒 worker 會搶食呢輪嘅 job（仲可能係舊 code！）。
pkill -f "src/workers/index.ts" 2>/dev/null || true
pkill -f " server.ts" 2>/dev/null || true
sleep 1
lsof -ti:"$PORT" 2>/dev/null | xargs -r kill 2>/dev/null || true
sleep 1
nohup pnpm dev >/tmp/e2e-server.log 2>&1 &
SERVER_PID=$!
nohup pnpm worker >/tmp/e2e-worker.log 2>&1 &
WORKER_PID=$!
cleanup() {
  kill "$WORKER_PID" "$SERVER_PID" 2>/dev/null || true
  sleep 1
  kill -9 "$WORKER_PID" "$SERVER_PID" 2>/dev/null || true
  # ★ kill 要殺到 tsx 嘅 node 子 process（先係真正嘅 worker/server），否則孤兒持續搶食 queue
  pkill -f "src/workers/index.ts" 2>/dev/null || true
  pkill -f " server.ts" 2>/dev/null || true
}
trap cleanup EXIT

UP=0
for i in $(seq 1 90); do
  if curl -sf "$BASE/healthz" >/dev/null 2>&1; then UP=1; break; fi
  sleep 1
done
[ "$UP" = 1 ] || { echo "FATAL: server 90s 未起"; tail -30 /tmp/e2e-server.log; exit 1; }
echo "  server + worker up (pid $SERVER_PID / $WORKER_PID)"

# ── T1. login ───────────────────────────────────────────────────────────
echo "[3/9] T1: login..."
CODE=$(curl -s -o /tmp/e2e-login.json -w '%{http_code}' -c "$COOKIE_TKW" \
  -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$TKW_EMAIL\",\"password\":\"$TKW_PASS\"}")
check "T1 login staff-tkw → 200" "$CODE" "200"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIE_MF" \
  -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$MF_EMAIL\",\"password\":\"$MF_PASS\"}")
check "T1b login staff-mf → 200" "$CODE" "200"

# ── T2. 跨店 403（列表） ───────────────────────────────────────────────
echo "[4/9] T2: cross-clinic 403..."
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_TKW" \
  "$BASE/api/conversations?clinicId=$MF_CLINIC_ID")
check "T2 STAFF(TKW) GET /api/conversations?clinicId=MF → 403" "$CODE" "403"

# ── T3. inbound message ─────────────────────────────────────────────────
echo "[5/9] T3: inbound message..."
pnpm -s mock-inbound message --clinic TKW --from "$PATIENT_TKW" --text "e2e 第一則" --wamid "$IN_WAMID" --name "E2E 病人" >/dev/null || fail "T3 mock-inbound message POST"
if wait_for "SELECT (\"unreadCount\")::text u, (\"lastInboundAt\" IS NOT NULL)::text li FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PATIENT_TKW'" \
  '[{"u":"1","li":"true"}]' 30; then
  pass "T3 unreadCount=1 + lastInboundAt set（Contact/Conversation/Message 已建立）"
else
  fail "T3 unreadCount=1 + lastInboundAt"
fi
CNT=$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"waMessageId\"='$IN_WAMID' AND direction='IN' AND channel='API'" | jf c)
check "T3 Message(IN,API) count=1" "$CNT" "1"

# ── T4. 冪等（重發同一 wamid） ─────────────────────────────────────────
echo "[6/9] T4: idempotency..."
sleep 1
pnpm -s mock-inbound message --clinic TKW --from "$PATIENT_TKW" --text "e2e 重發" --wamid "$IN_WAMID" --name "E2E 病人" >/dev/null || true
sleep 3
CNT=$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"waMessageId\"='$IN_WAMID'" | jf c)
check "T4 重發後 Message count 仍=1（冪等）" "$CNT" "1"
UNREAD=$(q "SELECT (\"unreadCount\")::text u FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PATIENT_TKW'" | jf u)
check "T4 unreadCount 仍=1（重發唔再加）" "$UNREAD" "1"
CCNT=$(q "SELECT count(*)::text c FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PATIENT_TKW'" | jf c)
check "T4 Conversation 無重複（=1）" "$CCNT" "1"

# ── T5. echo ────────────────────────────────────────────────────────────
echo "[7/9] T5: echo..."
pnpm -s mock-inbound echo --clinic TKW --to "$PATIENT_TKW" --text "e2e 店員 App 覆" --wamid "$ECHO_WAMID" >/dev/null || fail "T5 mock-inbound echo POST"
if wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"waMessageId\"='$ECHO_WAMID' AND direction='OUT' AND channel='APP_ECHO'" '[{"c":"1"}]' 30; then
  pass "T5 Message(OUT,APP_ECHO) 已建立"
else
  fail "T5 APP_ECHO message"
fi
UNREAD=$(q "SELECT (\"unreadCount\")::text u FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PATIENT_TKW'" | jf u)
check "T5 echo 唔加 unread（仍=1）" "$UNREAD" "1"

# ── T6. history ─────────────────────────────────────────────────────────
echo "[8/9] T6: history import..."
pnpm -s mock-inbound history --clinic TKW --from "$PATIENT_TKW" --count "$HIST_COUNT" --name "E2E 病人" >/dev/null || fail "T6 mock-inbound history POST"
if wait_for "SELECT count(*)::text c FROM \"Message\" m JOIN \"Conversation\" cv ON cv.id=m.\"conversationId\" JOIN \"Contact\" x ON x.id=cv.\"contactId\" WHERE x.\"waId\"='$PATIENT_TKW' AND m.channel='HISTORY'" \
  "[{\"c\":\"$HIST_COUNT\"}]" 30; then
  pass "T6 HISTORY 訊息 = $HIST_COUNT 條"
else
  fail "T6 HISTORY count"
fi
UNREAD=$(q "SELECT (\"unreadCount\")::text u FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PATIENT_TKW'" | jf u)
check "T6 history 唔觸發 unread（仍=1）" "$UNREAD" "1"

# ── T7. send（open window） ─────────────────────────────────────────────
echo "[9/9] T7-T9: send chain + window..."
SEND_CONV_ID=$(q "SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PATIENT_TKW'" | jf id)
CODE=$(curl -s -o /tmp/e2e-send.json -w '%{http_code}' -b "$COOKIE_TKW" \
  -X POST "$BASE/api/messages/send" -H 'Content-Type: application/json' \
  -d "{\"conversationId\":\"$SEND_CONV_ID\",\"body\":\"e2e 發送測試\"}")
check "T7 send → 202" "$CODE" "202"
SEND_MSG_ID=$(jf messageId < /tmp/e2e-send.json)

if wait_for "SELECT status s, (\"waMessageId\" IS NOT NULL)::text w FROM \"Message\" WHERE id='$SEND_MSG_ID'" '[{"s":"SENT","w":"true"}]' 30; then
  pass "T7 outbound worker 發完 → SENT + waMessageId 有值"
else
  fail "T7 SENT + waMessageId"
fi
SENT_WAMID=$(q "SELECT \"waMessageId\" FROM \"Message\" WHERE id='$SEND_MSG_ID'" | jf waMessageId)

# T8: statuses webhook（read）
pnpm -s mock-inbound status --wamid "$SENT_WAMID" --status read --clinic TKW >/dev/null || fail "T8 mock-inbound status POST"
if wait_for "SELECT status s FROM \"Message\" WHERE id='$SEND_MSG_ID'" '[{"s":"READ"}]' 30; then
  pass "T8 status webhook → READ"
else
  fail "T8 READ status"
fi

# T9: 窗口過咗 → 422
q "UPDATE \"Conversation\" SET \"lastInboundAt\" = now() - interval '25 hours' WHERE id='$SEND_CONV_ID'" >/dev/null
sleep 1
CODE=$(curl -s -o /tmp/e2e-send2.json -w '%{http_code}' -b "$COOKIE_TKW" \
  -X POST "$BASE/api/messages/send" -H 'Content-Type: application/json' \
  -d "{\"conversationId\":\"$SEND_CONV_ID\",\"body\":\"窗口過咗都發唔到\"}")
check "T9 窗口過咗 send → 422" "$CODE" "422"
GREP=$(grep -o "window_closed" /tmp/e2e-send2.json | head -1)
check "T9 error code = window_closed" "$GREP" "window_closed"

# ── T10. 跨店 403（單對話） ────────────────────────────────────────────
pnpm -s mock-inbound message --clinic MF --from "$PATIENT_MF" --text "mf msg" --name "E2E MF 病人" >/dev/null || true
wait_for "SELECT count(*)::text c FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PATIENT_MF'" '[{"c":"1"}]' 30 || fail "T10 MF conversation 建立"
MF_CONV_ID=$(q "SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PATIENT_MF'" | jf id)
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_TKW" "$BASE/api/conversations/$MF_CONV_ID")
check "T10 STAFF(TKW) GET 別店 conversation → 403" "$CODE" "403"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_TKW" -X PATCH \
  -H 'Content-Type: application/json' -d '{"status":"RESOLVED"}' "$BASE/api/conversations/$MF_CONV_ID")
check "T10b STAFF(TKW) PATCH 別店 conversation → 403" "$CODE" "403"

# ── T11. 未登入 401 ─────────────────────────────────────────────────────
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/conversations")
check "T11 未登入 GET /api/conversations → 401" "$CODE" "401"

# ── T12. unknown field ──────────────────────────────────────────────────
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/wa/webhook" \
  -H 'Content-Type: application/json' -H "x-hub-signature-256: sha256=$(echo -n '{}' | openssl dgst -sha256 -hmac "$WA_APP_SECRET" | sed 's/^.* //')" \
  -d '{}')
# {} 冇 field → worker 應記 log 唔崩；webhook 層仍 200
check "T12 unknown/empty payload → webhook 200" "$CODE" "200"
sleep 2
curl -sf "$BASE/healthz" >/dev/null 2>&1 && pass "T12 worker/server 存活" || fail "T12 存活檢查"

# ── T13. AI triage：URGENT_PAIN（鐵律 3：永不生成 draft） ───────────────
echo "[10/10] T13-T17: AI triage..."
PATIENT_AI1="8526003${EPOCH}"
WAMID_AI1="wamid.E2E_AI_URGENT_${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$PATIENT_AI1" --text "医生我牙好痛" --wamid "$WAMID_AI1" --name "E2E 急症病人" >/dev/null || fail "T13 mock-inbound POST"
if wait_for "SELECT \"intent\" i, \"urgency\" u, (\"urgent\")::text ug FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PATIENT_AI1'" \
  '[{"i":"URGENT_PAIN","u":"HIGH","ug":"true"}]' 30; then
  pass "T13 URGENT_PAIN + urgency HIGH + urgent=true（DB）"
else
  fail "T13 URGENT_PAIN triage"
fi
SUM1=$(q "SELECT (\"aiSummary\" IS NOT NULL)::text s FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PATIENT_AI1'" | jf s)
check "T13 aiSummary 已設（側欄顯示用）" "$SUM1" "true"
DRAFT1=$(q "SELECT count(*)::text c FROM \"AiDraft\" d JOIN \"Conversation\" cv ON cv.id=d.\"conversationId\" JOIN \"Contact\" x ON x.id=cv.\"contactId\" WHERE x.\"waId\"='$PATIENT_AI1'" | jf c)
check "T13 URGENT_PAIN 唔生成 draft（鐵律 3）" "$DRAFT1" "0"
AI1_MSG_ID=$(q "SELECT id FROM \"Message\" WHERE \"waMessageId\"='$WAMID_AI1'" | jf id)
JOB1=$(redis-cli EXISTS "wa-inbox:ai:ai-$AI1_MSG_ID" 2>/dev/null)
check "T13 aiQueue job 存在（jobId=ai:<messageId>）" "$JOB1" "1"
URG_LOG=$(grep -F "\"$WAMID_AI1\"" /tmp/e2e-worker.log 2>/dev/null | grep -c '"urgent":true')
[ "$URG_LOG" -ge 1 ] 2>/dev/null && pass "T13 worker log 見 urgent:classified（socket escalation 同源，metadata only）" || fail "T13 worker log urgent 分類記錄"

# ── T14. AI triage：BOOKING_REQUEST → draft 生成（pending） ─────────────
PATIENT_AI2="8526004${EPOCH}"
WAMID_AI2="wamid.E2E_AI_BOOK_${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$PATIENT_AI2" --text "你好，我想預約下週" --wamid "$WAMID_AI2" --name "E2E 預約病人" >/dev/null || fail "T14 mock-inbound POST"
if wait_for "SELECT \"intent\" i, \"urgency\" u FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PATIENT_AI2'" \
  '[{"i":"BOOKING_REQUEST","u":"LOW"}]' 30; then
  pass "T14 BOOKING_REQUEST + urgency LOW"
else
  fail "T14 BOOKING_REQUEST triage"
fi
URG2=$(q "SELECT (\"urgent\")::text u FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PATIENT_AI2'" | jf u)
check "T14 非急症 urgent=false" "$URG2" "false"
AI2_MSG_ID=$(q "SELECT id FROM \"Message\" WHERE \"waMessageId\"='$WAMID_AI2'" | jf id)
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$AI2_MSG_ID'" '[{"s":"PROPOSED"}]' 30; then
  pass "T14 AI draft 生成（PROPOSED pending）"
else
  fail "T14 draft 生成"
fi
DRAFT2_ID=$(q "SELECT id FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$AI2_MSG_ID'" | jf id)
[ -n "$DRAFT2_ID" ] && pass "T14 draft id 存在" || fail "T14 draft id"

# ── T15. draft 採用 / 棄用 API ────────────────────────────────────────────
CONV_AI2=$(q "SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PATIENT_AI2'" | jf id)
CODE=$(curl -s -o /tmp/e2e-adopt.json -w '%{http_code}' -b "$COOKIE_TKW" -X PATCH \
  "$BASE/api/conversations/$CONV_AI2/drafts/$DRAFT2_ID")
check "T15 採用 draft（PATCH）→ 200" "$CODE" "200"
ADOPT_TXT=$(grep -c '"draftText"' /tmp/e2e-adopt.json)
check "T15 採用回傳 draftText（俾 composer 填）" "$ADOPT_TXT" "1"
# 採用後 DB 狀態仍 PROPOSED（採用 ≠ 發送；最終狀態由 send 決定）
ST_NOW=$(q "SELECT \"status\"::text s FROM \"AiDraft\" WHERE id='$DRAFT2_ID'" | jf s)
check "T15 採用後仍 PROPOSED（發送先變 SENT_*）" "$ST_NOW" "PROPOSED"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_TKW" -X DELETE \
  "$BASE/api/conversations/$CONV_AI2/drafts/$DRAFT2_ID")
check "T15 棄用 draft（DELETE）→ 200" "$CODE" "200"
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE id='$DRAFT2_ID'" '[{"s":"DISCARDED"}]' 5; then
  pass "T15 DB status → DISCARDED"
else
  fail "T15 DISCARDED"
fi
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_MF" -X DELETE \
  "$BASE/api/conversations/$CONV_AI2/drafts/$DRAFT2_ID")
check "T15b 別店 staff 棄用 → 403（RBAC）" "$CODE" "403"

# ── T16. AI 失敗降級（AI_MOCK_FAIL=1） ────────────────────────────────────
# step 1：正常 AI 先跑一條（建立舊 intent）
PATIENT_AI3="8526005${EPOCH}"
WAMID_AI3A="wamid.E2E_AI_FAILA_${EPOCH}"
WAMID_AI3B="wamid.E2E_AI_FAILB_${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$PATIENT_AI3" --text "你好，想問下埋門時間" --wamid "$WAMID_AI3A" --name "E2E 降級病人" >/dev/null || fail "T16a mock-inbound POST"
if wait_for "SELECT \"intent\" i FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PATIENT_AI3'" '[{"i":"QUESTION"}]' 30; then
  pass "T16a 正常 AI 分類 QUESTION（舊 intent 建立）"
else
  fail "T16a QUESTION"
fi
OLD_INTENT=$(q "SELECT \"intent\" i FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PATIENT_AI3'" | jf i)

# step 2：重啟 worker（AI_MOCK_FAIL=1 模擬 AI 斷線）
pkill -f "src/workers/index.ts" 2>/dev/null || true
sleep 1
AI_MOCK_FAIL=1 nohup pnpm worker >/tmp/e2e-worker-fail.log 2>&1 &
WORKER_PID=$!
for i in $(seq 1 30); do grep -q "all workers started" /tmp/e2e-worker-fail.log 2>&1 && break; sleep 1; done

# step 3：新 inbound → AI fail（attempts 3，backoff 2s/4s）
pnpm -s mock-inbound message --clinic TKW --from "$PATIENT_AI3" --text "再問一次時間" --wamid "$WAMID_AI3B" --name "E2E 降級病人" >/dev/null || fail "T16b mock-inbound POST"
sleep 15
CUR_INTENT=$(q "SELECT \"intent\" i FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PATIENT_AI3'" | jf i)
check "T16 AI 失敗後舊 intent 保留（降級唔抹走）" "$CUR_INTENT" "$OLD_INTENT"
DRAFT3=$(q "SELECT count(*)::text c FROM \"AiDraft\" d JOIN \"Conversation\" cv ON cv.id=d.\"conversationId\" JOIN \"Contact\" x ON x.id=cv.\"contactId\" WHERE x.\"waId\"='$PATIENT_AI3'" | jf c)
check "T16 AI 失敗唔生成新 draft（仍=1，來自 T16a）" "$DRAFT3" "1"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_TKW" "$BASE/api/conversations")
check "T16 degraded 時 inbox list 仍 200（降級唔係中斷）" "$CODE" "200"
STATS_ERR=$(q "SELECT (\"lastError\" IS NOT NULL)::text e FROM \"AiCallStats\" WHERE id=1" | jf e)
check "T16 AiCallStats 記到失敗（admin 卡真數據）" "$STATS_ERR" "true"

# step 4：還原正常 worker
pkill -f "src/workers/index.ts" 2>/dev/null || true
sleep 1
nohup pnpm worker >/tmp/e2e-worker2.log 2>&1 &
WORKER_PID=$!
for i in $(seq 1 30); do grep -q "all workers started" /tmp/e2e-worker2.log 2>&1 && break; sleep 1; done

# ── T17. HISTORY / APP_ECHO 唔觸發 AI queue（job key 斷言） ────────────────
HIST_JOB_HIT=0
for mid in $(q "SELECT id FROM \"Message\" WHERE channel IN ('HISTORY','APP_ECHO')" | grep -oE '"id":"[^"]*"' | cut -d'"' -f4); do
  R=$(redis-cli EXISTS "wa-inbox:ai:ai-$mid" 2>/dev/null)
  if [ "$R" = "1" ]; then HIST_JOB_HIT=1; break; fi
done
check "T17 HISTORY/APP_ECHO 訊息全部無 aiQueue job" "$HIST_JOB_HIT" "0"

# ── T18. log PII 抽查（鐵律 1：訊息原文永不入 log） ────────────────────────
LOGPII=0
for kw in "e2e 第一則" "医生我牙好痛" "我想預約下週" "想問下埋門時間" "再問一次時間" "mf msg" "e2e 店員 App 覆" "e2e 發送測試"; do
  if grep -qF "$kw" /tmp/e2e-server.log /tmp/e2e-worker.log /tmp/e2e-worker-fail.log /tmp/e2e-worker2.log 2>/dev/null; then
    echo "    ❌ PII leak in log: $kw"
    LOGPII=1
  fi
done
check "T18 log 抽查：server/worker log 無訊息原文（metadata only）" "$LOGPII" "0"

# ── summary ────────────────────────────────────────────────────────────
echo "════════════════════════════════════════════"
echo " E2E 完成：PASS=$PASS FAIL=$FAIL"
echo "════════════════════════════════════════════"
[ "$FAIL" = 0 ] || exit 1

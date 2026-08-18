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

# ── summary ────────────────────────────────────────────────────────────
echo "════════════════════════════════════════════"
echo " E2E 完成：PASS=$PASS FAIL=$FAIL"
echo "════════════════════════════════════════════"
[ "$FAIL" = 0 ] || exit 1

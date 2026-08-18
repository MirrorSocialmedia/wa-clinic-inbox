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
#   T19 (Phase 2b) AUTO 模式 BOOKING_REQUEST → 自動發送（mock Graph 收到）+ Message aiAutoSent=true
#       + sentByStaffId=null + AuditLog(AI_AUTO_SEND) + draft SENT_AUTO
#   T20 (Phase 2b) AUTO + URGENT_PAIN → 唔自動發 + urgent flag + escalation（鐵律實測）+ fallback log
#   T21 (Phase 2b) AUTO + needsHuman=true（「想搵人工」）→ 出 pending draft 唔自動發
#   T22 (Phase 2b) DRAFT 舖（MF 預設）行為唔變（有 draft、冇自動發）
#   T23 (Phase 2b) AUTO 舖過 24h window → 唔自動發 + fallback log（window-closed）
#   T24 (Phase 2b) STAFF 攞別店/自家店 aiMode / PATCH 別店 aiMode → 403（RBAC）
#   T25 (Phase 2b) AUTO 發送冪等：re-delivery（重 enqueue AI job）唔重發
#   T26 (Phase 2b) AUTO 發送 log PII 抽查（鐵律 1 擴展）
#   T27 (Phase 3) Apricot mock sync（slot 落庫 + heartbeat）+ Flow endpoint 3 步加密 round-trip
#       （provider 列表 / date 只回有空日 / time 只回空 slot / 壞 token 401）
#   T28 (Phase 3) 病人 Complete → BookingRequest PENDING + 綠色卡 + /bookings 見到
#   T29 (Phase 3) 〔已喺 Apricot 落單〕→ CONFIRMED + AuditLog + 自動確認訊息（含日期時間）
#   T30 (Phase 3) race：兩病人同 slot 同時 Complete → 第二個被擋（precheck）+ 自動覆「滿咗」+ 重出 Flow
#   T31 (Phase 3) flow 中途棄 → 0 BookingRequest（無殭屍）
#   T32 (Phase 3) 48h 冇處理 → cron EXPIRED + AuditLog
#   T33 (Phase 3) PII：Apricot mock raw（含 clinicPatient/visitReasons/diagnosis）經 adapter → DB+log 0 hit + pii-scan 0 violation
#   T34 (Phase 3) 別店 flow_token 被拒 + STAFF 撳別店 booking confirm → 403
#   T35 (Phase 4) 健康自檢：inject 異常（webhook stale / queue depth / AI breaker）→ 3 條 Alert
#       + ALERT_CHANNEL=log 見到 metadata-only 警報（0 PII）；恢復 → auto-resolved；
#       /api/admin/alerts（STAFF 403 / ADMIN 200）+ POST resolve（手動 resolved）
#   T36 (Phase 4) quality_rating：mock GREEN 無警報 + Clinic.qualityRating/qualityCheckedAt 落庫；
#       WA_MOCK_QUALITY=RED inject → severity=HIGH 警報（被 ban 前哨）；恢復 → auto-resolved
#   T37 (Phase 4) 週報：fixture（4 conv/7 msg/4 draft/3 flow/3 booking）→ weekly-report script
#       → OpsReport 斷言（FRT 中位數 240s / 採用率 0.75 / Flow 2/3 / 預約 2/3 中位 60min）+ 冪等
#   T38 (Phase 4) duty-roster：mock fixture 3 人（HTTP 200 + /inbox 側欄「今日當值」卡）；
#       別店 scope 403；欄位白名單；DUTY_MOCK=0 + 無/壞 URL → 200 {duty:null} 唔 crash
#   T39 (Phase 4) backup/restore：backup-wa.sh 出 dump 檔（sandbox 無 age → 明文 + 響亮 warning）；
#       restore-wa-test.sh restore 落 scratch DB + 5 表 row count 全對
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
ADMIN_EMAIL=$(awk '/^ADMIN:/{print $2}' .dev/credentials.txt)
ADMIN_PASS=$(awk '/^ADMIN:/{split($0,a," / "); print a[2]}' .dev/credentials.txt)
[ -n "$TKW_EMAIL" ] && [ -n "$TKW_PASS" ] && [ -n "$ADMIN_EMAIL" ] && [ -n "$ADMIN_PASS" ] || { echo "FATAL: 讀唔到 credentials"; exit 1; }

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

# Phase 2b：ADMIN login + 重置所有 clinic 回 DRAFT（冪等起點 — 上輪 e2e 可能留低 AUTO）
COOKIE_ADMIN=/tmp/e2e-cookie-admin.txt
CODE=$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIE_ADMIN" \
  -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}")
check "T1c login admin → 200" "$CODE" "200"
for cid in "$TKW_CLINIC_ID" "$MF_CLINIC_ID"; do
  curl -s -o /dev/null -b "$COOKIE_ADMIN" -X PATCH "$BASE/api/admin/clinics/$cid" \
    -H 'Content-Type: application/json' -d '{"aiMode":"DRAFT"}'
done
echo "  aiMode reset → DRAFT (deterministic start)"

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

# ══════════════ Phase 2b：逐舖 AI 模式（DRAFT / AUTO） ══════════════

# ── T19. AUTO 模式 BOOKING_REQUEST → 自動發送（全鏈實測） ─────────────────
echo "[10/10] T19: AUTO mode auto-send (BOOKING_REQUEST)..."
CODE=$(curl -s -o /tmp/e2e-t19-a.json -w '%{http_code}' -b "$COOKIE_ADMIN" -X PATCH \
  "$BASE/api/admin/clinics/$TKW_CLINIC_ID" -H 'Content-Type: application/json' -d '{"aiMode":"AUTO"}')
check "T19 PATCH aiMode=AUTO → 200" "$CODE" "200"
MODE_T19=$(grep -oE '"aiMode":"[A-Z]*"' /tmp/e2e-t19-a.json | head -1 | cut -d'"' -f4)
check "T19 clinic.aiMode=AUTO 已持久化" "$MODE_T19" "AUTO"

PATIENT_AUTO1="8526011${EPOCH}"
WAMID_AUTO1="wamid.E2E_AUTO1_${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$PATIENT_AUTO1" --text "想預約下週有冇位" --wamid "$WAMID_AUTO1" --name "E2E AUTO booking" >/dev/null || fail "T19 mock-inbound POST"
wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"waMessageId\"='$WAMID_AUTO1'" '[{"c":"1"}]' 15
AUTO1_MSG_ID=$(q "SELECT id FROM \"Message\" WHERE \"waMessageId\"='$WAMID_AUTO1'" | jf id)
AUTO1_CONV=$(q "SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PATIENT_AUTO1'" | jf id)
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$AUTO1_MSG_ID'" '[{"s":"SENT_AUTO"}]' 30; then
  pass "T19 draft 記錄 SENT_AUTO（留底俾審計）"
else
  fail "T19 draft SENT_AUTO"
fi
# OUT 訊息：aiAutoSent=true + sentByStaffId=null + SENT（mock Graph 收到）+ 有 waMessageId
if wait_for "SELECT (m.\"aiAutoSent\")::text a, (m.\"sentByStaffId\" IS NULL)::text n, m.\"status\"::text s, (m.\"waMessageId\" IS NOT NULL)::text w FROM \"Message\" m WHERE m.\"conversationId\"='$AUTO1_CONV' AND m.direction='OUT'" \
  '[{"a":"true","n":"true","s":"SENT","w":"true"}]' 30; then
  pass "T19 自動發送：Message(OUT, aiAutoSent=true, sentByStaffId=null) + mock Graph 已收（SENT + wamid）"
else
  fail "T19 自動發送 Message"
fi
AUTO1_OUT_ID=$(q "SELECT m.id FROM \"Message\" m WHERE m.\"conversationId\"='$AUTO1_CONV' AND m.direction='OUT' AND m.\"aiAutoSent\"=true" | jf id)
AUDIT_T19=$(q "SELECT count(*)::text c FROM \"AuditLog\" WHERE action='AI_AUTO_SEND' AND \"entityId\"='$AUTO1_OUT_ID'" | jf c)
check "T19 AuditLog 登記 AI_AUTO_SEND（可審計）" "$AUDIT_T19" "1"
AUDIT_NO_PII=$(q "SELECT (meta->>'conversationId')::text c FROM \"AuditLog\" WHERE action='AI_AUTO_SEND' AND \"entityId\"='$AUTO1_OUT_ID'" | jf c)
check "T19 AuditLog meta 帶 conversationId（metadata only，無原文）" "$AUDIT_NO_PII" "$AUTO1_CONV"

# ── T20. AUTO + URGENT_PAIN → 鐵律：永不自動發 ──────────────────────────
echo "[10/10] T20: AUTO + URGENT_PAIN (iron rule)..."
PATIENT_AUTO2="8526012${EPOCH}"
WAMID_AUTO2="wamid.E2E_AUTO2_${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$PATIENT_AUTO2" --text "牙痛到瞓唔著" --wamid "$WAMID_AUTO2" --name "E2E AUTO urgent" >/dev/null || fail "T20 mock-inbound POST"
if wait_for "SELECT c.\"intent\" i, c.\"urgent\"::text u FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PATIENT_AUTO2'" \
  '[{"i":"URGENT_PAIN","u":"true"}]' 30; then
  pass "T20 URGENT_PAIN + urgent=true（escalation 觸發）"
else
  fail "T20 URGENT_PAIN + urgent"
fi
sleep 3
AUTO2_CONV=$(q "SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PATIENT_AUTO2'" | jf id)
OUT2=$(q "SELECT count(*)::text c FROM \"Message\" m WHERE m.\"conversationId\"='$AUTO2_CONV' AND m.direction='OUT'" | jf c)
check "T20 AUTO 舖 URGENT_PAIN 唔自動發（0 OUT 訊息 — 鐵律實測）" "$OUT2" "0"
DR2=$(q "SELECT count(*)::text c FROM \"AiDraft\" WHERE \"conversationId\"='$AUTO2_CONV'" | jf c)
check "T20 URGENT_PAIN 無 draft（code + prompt 雙重擋）" "$DR2" "0"
if grep -F "wamid.E2E_AUTO2_${EPOCH}" /tmp/e2e-worker*.log 2>/dev/null | grep -q "not eligible"; then
  pass "T20 fallback log（AUTO not eligible，metadata only）"
else
  fail "T20 fallback log"
fi

# ── T21. AUTO + needsHuman=true → 出 pending draft，唔自動發 ─────────────
echo "[10/10] T21: AUTO + needsHuman..."
PATIENT_AUTO3="8526013${EPOCH}"
WAMID_AUTO3="wamid.E2E_AUTO3_${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$PATIENT_AUTO3" --text "想搵人工" --wamid "$WAMID_AUTO3" --name "E2E AUTO human" >/dev/null || fail "T21 mock-inbound POST"
wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"waMessageId\"='$WAMID_AUTO3'" '[{"c":"1"}]' 15
AUTO3_MSG_ID=$(q "SELECT id FROM \"Message\" WHERE \"waMessageId\"='$WAMID_AUTO3'" | jf id)
AUTO3_CONV=$(q "SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PATIENT_AUTO3'" | jf id)
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$AUTO3_MSG_ID'" '[{"s":"PROPOSED"}]' 30; then
  pass "T21 needsHuman 出 pending draft（PROPOSED，staff 審批）"
else
  fail "T21 needsHuman draft"
fi
sleep 2
OUT3=$(q "SELECT count(*)::text c FROM \"Message\" m WHERE m.\"conversationId\"='$AUTO3_CONV' AND m.direction='OUT'" | jf c)
check "T21 needsHuman 永不自動發（0 OUT 訊息 — 鐵律）" "$OUT3" "0"
INT3=$(q "SELECT \"intent\" i FROM \"Conversation\" WHERE id='$AUTO3_CONV'" | jf i)
check "T21 intent=QUESTION（非急症，needsHuman mock trigger）" "$INT3" "QUESTION"

# ── T22. DRAFT 舖（MF 預設）行為唔變 ──────────────────────────────────────
echo "[10/10] T22: DRAFT clinic unchanged..."
MODE_MF=$(q "SELECT \"aiMode\"::text m FROM \"Clinic\" WHERE id='$MF_CLINIC_ID'" | jf m)
check "T22 MF clinic 預設 DRAFT" "$MODE_MF" "DRAFT"
PATIENT_DRAFT1="8526021${EPOCH}"
WAMID_DRAFT1="wamid.E2E_DRAFT1_${EPOCH}"
pnpm -s mock-inbound message --clinic MF --from "$PATIENT_DRAFT1" --text "想預約下週" --wamid "$WAMID_DRAFT1" --name "E2E DRAFT booking" >/dev/null || fail "T22 mock-inbound POST"
wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"waMessageId\"='$WAMID_DRAFT1'" '[{"c":"1"}]' 15
DRAFT1_MSG_ID=$(q "SELECT id FROM \"Message\" WHERE \"waMessageId\"='$WAMID_DRAFT1'" | jf id)
DRAFT1_CONV=$(q "SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PATIENT_DRAFT1'" | jf id)
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$DRAFT1_MSG_ID'" '[{"s":"PROPOSED"}]' 30; then
  pass "T22 DRAFT 舖：draft PROPOSED pending（舊行為）"
else
  fail "T22 draft PROPOSED"
fi
OUT4=$(q "SELECT count(*)::text c FROM \"Message\" m WHERE m.\"conversationId\"='$DRAFT1_CONV' AND m.direction='OUT'" | jf c)
check "T22 DRAFT 舖：冇自動發（0 OUT 訊息）" "$OUT4" "0"

# ── T23. AUTO 舖過 24h window → 唔自動發 + log ──────────────────────────
echo "[10/10] T23: AUTO + window closed..."
PATIENT_OLD="8526014${EPOCH}"
OLD_OUT=$(pnpm -s e2e:ai-job old-inbound --clinic TKW --from "$PATIENT_OLD" --text "想預約下週" 2>/dev/null)
T23_CONV=$(echo "$OLD_OUT" | grep -oE 'CONV=[^ ]*' | cut -d= -f2)
[ -n "$T23_CONV" ] || fail "T23 e2e-ai-job old-inbound"
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE \"conversationId\"='$T23_CONV'" '[{"s":"PROPOSED"}]' 30; then
  pass "T23 過窗 → fallback DRAFT（draft PROPOSED 俾 staff）"
else
  fail "T23 fallback draft"
fi
sleep 2
OUT5=$(q "SELECT count(*)::text c FROM \"Message\" m WHERE m.\"conversationId\"='$T23_CONV' AND m.direction='OUT'" | jf c)
check "T23 過 24h window 唔自動發（0 OUT 訊息）" "$OUT5" "0"
if grep -q "window-closed" /tmp/e2e-worker*.log 2>/dev/null; then
  pass "T23 fallback log（reason=window-closed，行為同 staff 422 一樣：唔發）"
else
  fail "T23 window-closed log"
fi

# ── T24. STAFF RBAC：aiMode 攞/改 → 403 ──────────────────────────────────
echo "[10/10] T24: STAFF RBAC on aiMode..."
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_MF" "$BASE/api/admin/clinics/$TKW_CLINIC_ID")
check "T24 STAFF GET 別店（aiMode）→ 403" "$CODE" "403"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_MF" -X PATCH \
  "$BASE/api/admin/clinics/$TKW_CLINIC_ID" -H 'Content-Type: application/json' -d '{"aiMode":"AUTO"}')
check "T24 STAFF PATCH 別店 aiMode → 403" "$CODE" "403"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_MF" "$BASE/api/admin/clinics/$MF_CLINIC_ID")
check "T24 STAFF GET 自家店（admin endpoint）→ 403（fail-closed）" "$CODE" "403"
# 驗證 TKW 仲係 AUTO（403 PATCH 冇生效）
MODE_STILL=$(q "SELECT \"aiMode\"::text m FROM \"Clinic\" WHERE id='$TKW_CLINIC_ID'" | jf m)
check "T24 被拒 PATCH 冇改動 DB（仍 AUTO）" "$MODE_STILL" "AUTO"

# ── T25. AUTO 發送冪等：re-delivery 唔重發 ──────────────────────────────────
echo "[10/10] T25: AUTO idempotency (re-delivery)..."
pnpm -s e2e:ai-job requeue --conversation "$AUTO1_CONV" --message "$AUTO1_MSG_ID" --clinic "$TKW_CLINIC_ID" >/dev/null 2>&1 || fail "T25 requeue"
sleep 8
OUT6=$(q "SELECT count(*)::text c FROM \"Message\" m WHERE m.\"conversationId\"='$AUTO1_CONV' AND m.direction='OUT'" | jf c)
check "T25 re-delivery 唔重發（OUT 訊息仍 =1，冪等）" "$OUT6" "1"
if grep -q "idempotent skip" /tmp/e2e-worker*.log 2>/dev/null; then
  pass "T25 idempotent skip log"
else
  fail "T25 idempotent skip log"
fi

# ── T26. AUTO 發送 log PII 抽查（鐵律 1 擴展：含 Phase 2b 新 text） ────────
LOGPII2=0
for kw in "想預約下週有冇位" "牙痛到瞓唔著" "想搵人工" "想預約下週"; do
  if grep -qF "$kw" /tmp/e2e-server.log /tmp/e2e-worker.log /tmp/e2e-worker-fail.log /tmp/e2e-worker2.log 2>/dev/null; then
    echo "    ❌ PII leak in log (Phase 2b): $kw"
    LOGPII2=1
  fi
done
check "T26 AUTO 發送 log 無訊息原文（metadata only 鐵律）" "$LOGPII2" "0"

# ══════════════ Phase 3：Apricot 空檔 + WhatsApp Flow 預約收集 ══════════════

echo "[11/11] T27: Apricot sync + Flow endpoint 3 步 round-trip..."
rm -rf .dev/flow-keys
rm -f .dev/apricot-mock-fill.json

# 0) 觸發 Apricot sync（cron 路徑：cronQueue → apricot queue concurrency=1）
pnpm -s e2e:cron sync-availability >/dev/null 2>&1 || fail "T27 e2e:cron enqueue"
T27=0
if ! wait_for "SELECT (count(*) > 0)::text c FROM \"AvailabilitySlot\"" '[{"c":"true"}]' 90; then
  echo "    ❌ T27 AvailabilitySlot 冇 row"
  T27=1
fi
SSESYNC=$(q "SELECT (\"lastSyncAt\" IS NOT NULL)::text s FROM \"ApricotSession\" WHERE id=1" | jf s)
[ "$SSESYNC" = "true" ] || { echo "    ❌ T27 ApricotSession.lastSyncAt 冇 heartbeat"; T27=1; }

# 1) 新病人（BOOKING_REQUEST intent — 真實 flow 起點）+ staff 發 Flow
PATIENT_P3="8526031${EPOCH}"
WAMID_P3="wamid.E2E_P3_${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$PATIENT_P3" --text "你好，我想預約下週" --wamid "$WAMID_P3" --name "E2E Flow 病人" >/dev/null || T27=1
CONV_P3=$(q "SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PATIENT_P3'" | jf id)
[ -n "$CONV_P3" ] || { echo "    ❌ T27 conv 未建立"; T27=1; }
curl -s -o /tmp/e2e-flow-send.json -w '%{http_code}' -b "$COOKIE_TKW" -X POST \
  "$BASE/api/conversations/$CONV_P3/flows" -H 'Content-Type: application/json' > /tmp/e2e-flow-code.txt
[ "$(cat /tmp/e2e-flow-code.txt)" = "200" ] || { echo "    ❌ T27 發 Flow != 200"; T27=1; }
TOKEN_P3=$(jf flowToken < /tmp/e2e-flow-send.json)
[ -n "$TOKEN_P3" ] || { echo "    ❌ T27 flowToken 空"; T27=1; }
if ! wait_for "SELECT (count(*) > 0)::text c FROM \"Message\" WHERE \"conversationId\"='$CONV_P3' AND direction='OUT' AND type='interactive' AND status='SENT'" '[{"c":"true"}]' 30; then
  echo "    ❌ T27 interactive flow message 未 SENT（mock Graph）"
  T27=1
fi

# 2) data_exchange 3 步（加密真實格式：RSA-OAEP wrap AES key → AES-128-GCM；response 反轉 IV 由 client 驗證）
# ★ 斷言用 grep 抽 HTTP=/DATA=（pnpm 會喺 stderr echo command line — 唔好靠整串 case）
DOC_A="mock-pract-tkw-1"
NAME_A="陳明軒（主理）"
# ★ slot 揀取排除已有 PENDING/CONFIRMED booking 嘅 slot（E2E 多次 run 共用 DB — 防舊 run 殘留 PENDING 污染 precheck）
slot_query() {
  q "SELECT s.\"date\" d, s.\"startTime\" t FROM \"AvailabilitySlot\" s WHERE s.\"clinicId\"='$TKW_CLINIC_ID' AND s.\"providerApricotId\"='$DOC_A' AND s.\"bookedCount\"=0 AND s.\"isOpen\" AND NOT EXISTS (SELECT 1 FROM \"BookingRequest\" b WHERE b.\"providerApricotId\"=s.\"providerApricotId\" AND b.\"requestedDate\"=s.\"date\" AND b.\"requestedTime\"=s.\"startTime\" AND b.\"status\" IN ('PENDING','CONFIRMED')) $1 ORDER BY s.\"date\", s.\"startTime\" LIMIT 1"
}
step_flow() { # step_flow <desc> <args...> → 設 F_HTTP / F_DATA；回 0/1
  local desc="$1"; shift
  local out; out=$(pnpm -s flow-client step "$@" 2>&1 || true)
  F_HTTP=$(printf '%s' "$out" | grep -oE 'HTTP=[0-9]+' | head -1 | cut -d= -f2)
  F_DATA=$(printf '%s' "$out" | grep -oE 'DATA=\{.*' | head -1 | sed 's/^DATA=//')
  echo "  [T27] $desc → HTTP=${F_HTTP:-?} ${F_DATA:0:120}"
  if [ -z "$F_HTTP" ]; then echo "    ❌ $desc 無 HTTP= 輸出（client crash？）: ${out:0:300}"; return 1; fi
  return 0
}
step_flow "provider" --clinic TKW --conv "$CONV_P3" --token "$TOKEN_P3" --action SCREEN_PROVIDER
case "${F_DATA:-}" in *'"data_count":3'*) : ;; *) echo "    ❌ T27 SCREEN_PROVIDER 未回 3 個醫生"; T27=1 ;; esac
[ "$F_HTTP" = "200" ] || { echo "    ❌ T27 SCREEN_PROVIDER HTTP=$F_HTTP"; T27=1; }
ROW=$(slot_query "")
DATE_A=$(echo "$ROW" | jf d); TIME_A=$(echo "$ROW" | jf t)
[ -n "$DATE_A" ] && [ -n "$TIME_A" ] || { echo "    ❌ T27 搵唔到空 slot"; T27=1; }
step_flow "date" --clinic TKW --conv "$CONV_P3" --token "$TOKEN_P3" --action SCREEN_DATE --provider "$DOC_A"
case "${F_DATA:-}" in *"$DATE_A"*) : ;; *) echo "    ❌ T27 SCREEN_DATE 冇包含 $DATE_A（data=${F_DATA:0:200}）"; T27=1 ;; esac
DC_DATE=$(printf '%s' "${F_DATA:-}" | grep -oE '"data_count":[0-9]+' | cut -d: -f2)
DBDATES=$(q "SELECT count(DISTINCT \"date\")::text c FROM \"AvailabilitySlot\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND \"providerApricotId\"='$DOC_A'" | jf c)
[ -n "$DC_DATE" ] && [ "$DC_DATE" = "$DBDATES" ] || { echo "    ❌ T27 date 列表唔等於 DB 有空日集合（endpoint=$DC_DATE DB=$DBDATES）"; T27=1; }
step_flow "time" --clinic TKW --conv "$CONV_P3" --token "$TOKEN_P3" --action SCREEN_TIME --provider "$DOC_A" --date "$DATE_A"
case "${F_DATA:-}" in *"$TIME_A"*) : ;; *) echo "    ❌ T27 SCREEN_TIME 冇包含 $TIME_A（data=${F_DATA:0:200}）"; T27=1 ;; esac
step_flow "bad-token" --clinic TKW --conv "$CONV_P3" --token "$TOKEN_P3" --action SCREEN_PROVIDER --bad-token
case "$F_HTTP" in 401|400) : ;; *) echo "    ❌ T27 壞 token 唔係 401/400（HTTP=$F_HTTP）"; T27=1 ;; esac
[ "$T27" = 0 ] && pass "T27 Apricot sync（slot 落庫 + heartbeat）+ Flow 3 步加密 round-trip（provider 3 人/date 過濾閉诊日/time 只空 slot/壞 token 401）" \
  || fail "T27 Flow endpoint round-trip（見上 ❌）"

# ── T28. 病人 Complete → BookingRequest PENDING + 綠色卡 + /bookings ──────────
echo "[11/11] T28: patient Complete → PENDING + green card..."
T28=0
pnpm -s flow-client complete --clinic TKW --conv "$CONV_P3" --token "$TOKEN_P3" \
  --provider "$DOC_A" --providerName "$NAME_A" --date "$DATE_A" --time "$TIME_A" \
  --wamid "wamid.E2E_FLOW_DONE_${EPOCH}a" >/dev/null 2>&1 || { echo "    ❌ T28 complete webhook"; T28=1; }
if wait_for "SELECT \"status\"::text s FROM \"BookingRequest\" WHERE \"conversationId\"='$CONV_P3'" '[{"s":"PENDING"}]' 30; then
  :; else echo "    ❌ T28 BookingRequest 未 PENDING"; T28=1; fi
BOOK_ID=$(q "SELECT id FROM \"BookingRequest\" WHERE \"conversationId\"='$CONV_P3'" | jf id)
FS=$(q "SELECT \"status\"::text s FROM \"FlowSession\" WHERE \"flowToken\"='$TOKEN_P3'" | jf s)
[ "$FS" = "COMPLETED" ] || { echo "    ❌ T28 FlowSession 未 COMPLETED（=$FS）"; T28=1; }
curl -s -b "$COOKIE_TKW" "$BASE/api/conversations" -o /tmp/e2e-conv-list.json
grep -qF "\"pendingBooking\":{\"id\":\"$BOOK_ID\"" /tmp/e2e-conv-list.json || { echo "    ❌ T28 綠色卡（pendingBooking）冇喺 conversations API"; T28=1; }
curl -s -b "$COOKIE_TKW" "$BASE/api/bookings?status=PENDING" -o /tmp/e2e-book-list.json
grep -qF "\"id\":\"$BOOK_ID\"" /tmp/e2e-book-list.json || { echo "    ❌ T28 /bookings 冇呢張卡"; T28=1; }
[ "$T28" = 0 ] && pass "T28 Complete → BookingRequest PENDING + FlowSession COMPLETED + 綠色卡 + /bookings 見到" \
  || fail "T28 Complete → PENDING 鏈（見上 ❌）"

# ── T29. 〔已喺 Apricot 落單〕→ CONFIRMED + AuditLog + 自動確認訊息 ─────────
echo "[11/11] T29: confirm → CONFIRMED + auto message..."
T29=0
CODE=$(curl -s -o /tmp/e2e-confirm.json -w '%{http_code}' -b "$COOKIE_TKW" \
  -X POST "$BASE/api/bookings/$BOOK_ID/confirm" -H 'Content-Type: application/json')
[ "$CODE" = "200" ] || { echo "    ❌ T29 confirm != 200（=$CODE）"; T29=1; }
grep -q '"sent":true' /tmp/e2e-confirm.json || { echo "    ❌ T29 autoMessage.sent != true"; T29=1; }
if wait_for "SELECT \"status\"::text s FROM \"BookingRequest\" WHERE id='$BOOK_ID'" '[{"s":"CONFIRMED"}]' 15; then
  :; else echo "    ❌ T29 未 CONFIRMED"; T29=1; fi
AUDC=$(q "SELECT count(*)::text c FROM \"AuditLog\" WHERE action='CONFIRM_BOOKING' AND \"entityId\"='$BOOK_ID'" | jf c)
[ "$AUDC" = "1" ] || { echo "    ❌ T29 AuditLog CONFIRM_BOOKING != 1"; T29=1; }
# 自動確認訊息：內容含「已為你預約 + X月X日 + 時間 + 醫生名」（mock Graph 收到 = SENT + wamid）
DL_NAT=$(date -d "$DATE_A" '+%-m月%-d日')
if wait_for "SELECT (count(*) > 0)::text c FROM \"Message\" WHERE \"conversationId\"='$CONV_P3' AND direction='OUT' AND type='text' AND status='SENT' AND \"body\" LIKE '%已為你預約%' AND \"body\" LIKE '%$DL_NAT%' AND \"body\" LIKE '%$TIME_A%' AND \"body\" LIKE '%$NAME_A%'" '[{"c":"true"}]' 30; then
  :; else echo "    ❌ T29 自動確認訊息（含 $DL_NAT $TIME_A $NAME_A）未 SENT"; T29=1; fi
[ "$T29" = 0 ] && pass "T29 confirm → CONFIRMED + AuditLog + 自動確認訊息（內容含 $DL_NAT $TIME_A $NAME_A，mock Graph 已收）" \
  || fail "T29 confirm 鏈（見上 ❌）"

# ── T30. race：兩病人同一 slot 同時 Complete → 第二個被擋 ────────────────────
echo "[11/11] T30: race on same slot..."
T30=0
ROW=$(slot_query "AND NOT (s.\"date\"='$DATE_A' AND s.\"startTime\"='$TIME_A')")
DATE_B=$(echo "$ROW" | jf d); TIME_B=$(echo "$ROW" | jf t)
[ -n "$DATE_B" ] || { echo "    ❌ T30 搵唔到第二個空 slot"; T30=1; }
# 病人 B（新對話）+ 兩個 flow（A 重用 T28 對話之新 session / B 新對話）
PATIENT_RACE="8526032${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$PATIENT_RACE" --text "想預約" --wamid "wamid.E2E_RACE_${EPOCH}" --name "E2E race B" >/dev/null || T30=1
CONV_RACE=$(q "SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PATIENT_RACE'" | jf id)
curl -s -o /tmp/e2e-flow-a2.json -b "$COOKIE_TKW" -X POST "$BASE/api/conversations/$CONV_P3/flows" -H 'Content-Type: application/json'
TOKEN_A2=$(jf flowToken < /tmp/e2e-flow-a2.json)
curl -s -o /tmp/e2e-flow-b.json -b "$COOKIE_TKW" -X POST "$BASE/api/conversations/$CONV_RACE/flows" -H 'Content-Type: application/json'
TOKEN_B=$(jf flowToken < /tmp/e2e-flow-b.json)
[ -n "$TOKEN_A2" ] && [ -n "$TOKEN_B" ] || { echo "    ❌ T30 flow token 空"; T30=1; }
# 同時 Complete（同一 slot）— ★ 只 wait 呢兩個 PID（裸 wait 會等住 server/worker 唔會出）
(pnpm -s flow-client complete --clinic TKW --conv "$CONV_P3" --token "$TOKEN_A2" \
  --provider "$DOC_A" --providerName "$NAME_A" --date "$DATE_B" --time "$TIME_B" \
  --wamid "wamid.E2E_RACE_A_${EPOCH}" >/dev/null 2>&1) &
RACE_A=$!
(pnpm -s flow-client complete --clinic TKW --conv "$CONV_RACE" --token "$TOKEN_B" \
  --provider "$DOC_A" --providerName "$NAME_A" --date "$DATE_B" --time "$TIME_B" \
  --wamid "wamid.E2E_RACE_B_${EPOCH}" >/dev/null 2>&1) &
RACE_B=$!
wait "$RACE_A" "$RACE_B"
# 等終態：恰好一個 FAILED session（輸家）— 之後先斷言其餘
if ! wait_for "SELECT count(*)::text c FROM \"FlowSession\" WHERE \"flowToken\" IN ('$TOKEN_A2','$TOKEN_B') AND \"status\"='FAILED'" '[{"c":"1"}]' 45; then
  echo "    ❌ T30 冇 FAILED session（race 未產生輸家？）"
  T30=1
fi
sleep 3
WC=$(q "SELECT count(*)::text c FROM \"BookingRequest\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND \"providerApricotId\"='$DOC_A' AND \"requestedDate\"='$DATE_B' AND \"requestedTime\"='$TIME_B'" | jf c)
[ "$WC" = "1" ] || { echo "    ❌ T30 該 slot BookingRequest != 1（=$WC）"; T30=1; }
FS_FAILED=$(q "SELECT count(*)::text c FROM \"FlowSession\" WHERE \"flowToken\" IN ('$TOKEN_A2','$TOKEN_B') AND \"status\"='FAILED'" | jf c)
FS_DONE=$(q "SELECT count(*)::text c FROM \"FlowSession\" WHERE \"flowToken\" IN ('$TOKEN_A2','$TOKEN_B') AND \"status\"='COMPLETED'" | jf c)
[ "$FS_FAILED" = "1" ] && [ "$FS_DONE" = "1" ] || { echo "    ❌ T30 session FAILED/COMPLETED 唔係 1/1（=$FS_FAILED/$FS_DONE）"; T30=1; }
# ★ scope 返呢 run 嘅兩個 race 對話（shared DB 有舊 run 嘅「滿咗」訊息）
REPLY=$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\" IN ('$CONV_P3','$CONV_RACE') AND direction='OUT' AND type='text' AND \"body\" LIKE '%滿咗%'" | jf c)
[ "$REPLY" = "1" ] || { echo "    ❌ T30 自動覆「滿咗」!= 1 條（=$REPLY）"; T30=1; }
# 輸咗嗰個對話要有新 SENT FlowSession（重出 Flow）
RESENT=$(q "SELECT count(*)::text c FROM \"FlowSession\" s WHERE s.\"status\"='SENT' AND s.\"conversationId\" IN ('$CONV_P3','$CONV_RACE') AND s.\"flowToken\" NOT IN ('$TOKEN_A2','$TOKEN_B')" | jf c)
[ "$RESENT" -ge 1 ] 2>/dev/null || { echo "    ❌ T30 輸家冇重出 Flow"; T30=1; }
BOOK_WINNER=$(q "SELECT id FROM \"BookingRequest\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND \"providerApricotId\"='$DOC_A' AND \"requestedDate\"='$DATE_B' AND \"requestedTime\"='$TIME_B'" | jf id)
[ -n "$BOOK_WINNER" ] || T30=1
[ "$T30" = 0 ] && pass "T30 race：同 slot 同時 Complete → 1 贏（PENDING）+ 1 被擋（FAILED + 自動覆「滿咗」+ 重出 Flow）" \
  || fail "T30 race 防護（見上 ❌）"

# ── T34. 別店 flow_token 拒絕 + STAFF 別店 booking 403 ───────────────────────
echo "[11/11] T34: cross-clinic isolation..."
T34=0
# (a) MF 對話嘅 token 喺 TKW 嘅 WA number 上用 → 拒絕
pnpm -s mock-inbound message --clinic MF --from "$PATIENT_MF" --text "預約" --wamid "wamid.E2E_MF_FLOW_${EPOCH}" --name "E2E MF flow" >/dev/null || T34=1
sleep 1
curl -s -o /tmp/e2e-flow-mf.json -b "$COOKIE_MF" -X POST "$BASE/api/conversations/$MF_CONV_ID/flows" -H 'Content-Type: application/json'
TOKEN_MF=$(jf flowToken < /tmp/e2e-flow-mf.json)
[ -n "$TOKEN_MF" ] || { echo "    ❌ T34 MF flow token 空"; T34=1; }
OUT=$(pnpm -s flow-client step --clinic TKW --conv "$MF_CONV_ID" --token "$TOKEN_MF" --action SCREEN_PROVIDER 2>&1 || true)
F_HTTP=$(printf '%s' "$OUT" | grep -oE 'HTTP=[0-9]+' | head -1 | cut -d= -f2)
echo "  [T34] cross-clinic token: HTTP=${F_HTTP:-?}"
case "$F_HTTP" in 403|401) : ;; *) echo "    ❌ T34 別店 token 未被拒（raw=${OUT:0:300}）"; T34=1 ;; esac
# (b) STAFF(MF) 撳 TKW booking confirm → 403
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_MF" \
  -X POST "$BASE/api/bookings/$BOOK_WINNER/confirm" -H 'Content-Type: application/json')
[ "$CODE" = "403" ] || { echo "    ❌ T34 STAFF(MF) 別店 confirm != 403（=$CODE）"; T34=1; }
BS=$(q "SELECT \"status\"::text s FROM \"BookingRequest\" WHERE id='$BOOK_WINNER'" | jf s)
[ "$BS" = "PENDING" ] || { echo "    ❌ T34 被拒 confirm 改了 DB（=$BS）"; T34=1; }
[ "$T34" = 0 ] && pass "T34 別店 flow_token 被拒（403/401）+ STAFF(MF) 撳 TKW booking confirm → 403（DB 無改動）" \
  || fail "T34 cross-clinic 隔離（見上 ❌）"

# ── T31. flow 中途棄（冇 Complete）→ 零 BookingRequest ──────────────────────
echo "[11/11] T31: mid-flow abandon..."
T31=0
PATIENT_DROP="8526033${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$PATIENT_DROP" --text "想預約" --wamid "wamid.E2E_DROP_${EPOCH}" --name "E2E drop" >/dev/null || T31=1
CONV_DROP=$(q "SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PATIENT_DROP'" | jf id)
curl -s -o /tmp/e2e-flow-drop.json -b "$COOKIE_TKW" -X POST "$BASE/api/conversations/$CONV_DROP/flows" -H 'Content-Type: application/json'
TOKEN_DROP=$(jf flowToken < /tmp/e2e-flow-drop.json)
[ -n "$TOKEN_DROP" ] || { echo "    ❌ T31 flow token 空"; T31=1; }
pnpm -s flow-client step --clinic TKW --conv "$CONV_DROP" --token "$TOKEN_DROP" --action SCREEN_PROVIDER >/dev/null 2>&1 || T31=1
pnpm -s flow-client step --clinic TKW --conv "$CONV_DROP" --token "$TOKEN_DROP" --action SCREEN_DATE --provider "$DOC_A" >/dev/null 2>&1 || T31=1
sleep 3
DC=$(q "SELECT count(*)::text c FROM \"BookingRequest\" WHERE \"conversationId\"='$CONV_DROP'" | jf c)
[ "$DC" = "0" ] || { echo "    ❌ T31 棄單對話有 BookingRequest（=$DC）"; T31=1; }
DS=$(q "SELECT \"status\"::text s FROM \"FlowSession\" WHERE \"flowToken\"='$TOKEN_DROP'" | jf s)
[ "$DS" = "SENT" ] || { echo "    ❌ T31 FlowSession 唔係 SENT（=$DS）"; T31=1; }
[ "$T31" = 0 ] && pass "T31 flow 行咗 2 步冇 Complete → 0 BookingRequest（無殭屍；session 留 SENT 等 48h ABANDONED）" \
  || fail "T31 棄單零 BookingRequest（見上 ❌）"

# ── T32. 48h 冇處理 → EXPIRED（cron） ────────────────────────────────────────
echo "[11/11] T32: 48h expiry..."
T32=0
ROW=$(slot_query "AND NOT (s.\"date\"='$DATE_A' AND s.\"startTime\"='$TIME_A') AND NOT (s.\"date\"='$DATE_B' AND s.\"startTime\"='$TIME_B')")
DATE_C=$(echo "$ROW" | jf d); TIME_C=$(echo "$ROW" | jf t)
[ -n "$DATE_C" ] || { echo "    ❌ T32 搵唔到第三個空 slot"; T32=1; }
PATIENT_EXP="8526034${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$PATIENT_EXP" --text "想預約" --wamid "wamid.E2E_EXP_${EPOCH}" --name "E2E expire" >/dev/null || T32=1
CONV_EXP=$(q "SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PATIENT_EXP'" | jf id)
curl -s -o /tmp/e2e-flow-exp.json -b "$COOKIE_TKW" -X POST "$BASE/api/conversations/$CONV_EXP/flows" -H 'Content-Type: application/json'
TOKEN_EXP=$(jf flowToken < /tmp/e2e-flow-exp.json)
pnpm -s flow-client complete --clinic TKW --conv "$CONV_EXP" --token "$TOKEN_EXP" \
  --provider "$DOC_A" --providerName "$NAME_A" --date "$DATE_C" --time "$TIME_C" \
  --wamid "wamid.E2E_EXP_DONE_${EPOCH}" >/dev/null 2>&1 || T32=1
BOOK_EXP=$(q "SELECT id FROM \"BookingRequest\" WHERE \"conversationId\"='$CONV_EXP'" | jf id)
[ -n "$BOOK_EXP" ] || { echo "    ❌ T32 BookingRequest 未建立"; T32=1; }
q "UPDATE \"BookingRequest\" SET \"createdAt\" = now() - interval '49 hours' WHERE id='$BOOK_EXP'" >/dev/null
pnpm -s e2e:cron bookings-expire >/dev/null 2>&1 || T32=1
if wait_for "SELECT \"status\"::text s FROM \"BookingRequest\" WHERE id='$BOOK_EXP'" '[{"s":"EXPIRED"}]' 30; then
  :; else echo "    ❌ T32 未 EXPIRED"; T32=1; fi
AUX=$(q "SELECT count(*)::text c FROM \"AuditLog\" WHERE action='BOOKING_EXPIRED' AND (meta->>'bookingId')='$BOOK_EXP'" | jf c)
[ "$AUX" = "1" ] || { echo "    ❌ T32 AuditLog BOOKING_EXPIRED != 1"; T32=1; }
[ "$T32" = 0 ] && pass "T32 48h 未處理 → cron EXPIRED + AuditLog（DB 時移 49h 實測）" \
  || fail "T32 48h expiry（見上 ❌）"

# ── T33. PII：Apricot mock raw（含 clinicPatient/visitReasons/diagnosis）經 adapter → DB + log 0 hit ──
echo "[11/11] T33: PII scan..."
T33=0
SCAN_OUT=$(pnpm -s pii-scan 2>&1)
echo "$SCAN_OUT" | tail -5
echo "$SCAN_OUT" | grep -q "PII-SCAN OK: 0 violations" || { echo "    ❌ T33 pii-scan 有 violation"; T33=1; }
LOGPII3=0
for kw in "MOCK_PII_PATIENT" "MOCK_PII_DIAGNOSIS" "MOCK_PII_REASON" "MOCK_PII_CREATOR" "85200000000" "clinicPatient" "visitReasons"; do
  if grep -qF "$kw" /tmp/e2e-server.log /tmp/e2e-worker.log /tmp/e2e-worker-fail.log /tmp/e2e-worker2.log 2>/dev/null; then
    echo "    ❌ PII bait in log: $kw"
    LOGPII3=1
  fi
done
[ "$LOGPII3" = 0 ] || T33=1
[ "$T33" = 0 ] && pass "T33 PII：mock raw 含 clinicPatient/visitReasons/diagnosis 經 adapter → DB + log 全 0 hit；pii-scan 0 violation" \
  || fail "T33 PII 鐵律（見上 ❌）"

# ══════════════ Phase 4：監控 + 營運硬化 ══════════════

# ── T35. 健康自檢：inject 異常 → Alert + metadata-only 通知；恢復 → auto-resolved ──
echo "[P4] T35: health-check..."
T35=0
# pre-clean：清舊 health alerts + 統一 webhook 時鐘（TKW = stale，其餘 fresh）+ Apricot fresh
q "UPDATE \"Alert\" SET \"resolvedAt\" = now() WHERE \"resolvedAt\" IS NULL AND type IN ('webhook_stale','queue_depth','ai_breaker_open','apricot_sync_stale','disk_low')" >/dev/null
q "UPDATE \"ApricotSession\" SET \"lastSyncAt\" = now() WHERE id=1" >/dev/null
q "UPDATE \"Clinic\" SET \"lastWebhookEventAt\" = CASE WHEN id='$TKW_CLINIC_ID' THEN now() - interval '40 minutes' ELSE now() END WHERE \"lastWebhookEventAt\" IS NOT NULL" >/dev/null

# (1) inject：webhook stale（TKW -40min）+ queue depth 假高（ai=150）+ AI breaker open
pnpm -s e2e:cron health-check '{"overrides":{"queueDepth":{"ai":{"waiting":150,"failed":0}},"breakerState":"open"}}' >/dev/null 2>&1 || T35=1
if wait_for "SELECT (SELECT count(*) FROM \"Alert\" WHERE \"resolvedAt\" IS NULL AND type IN ('webhook_stale','queue_depth','ai_breaker_open'))::text c" '[{"c":"3"}]' 30; then
  pass "T35 inject 3 種異常 → 3 條未解決 Alert"
else
  fail "T35 3 條 Alert 未齊"
fi
WSC=$(q "SELECT \"clinicCode\"::text cc FROM \"Alert\" WHERE type='webhook_stale' AND \"resolvedAt\" IS NULL" | jf cc)
check "T35 webhook_stale 指咗 TKW（有 traffic 先計 stale）" "$WSC" "TKW"
QSS=$(q "SELECT \"severity\"::text s FROM \"Alert\" WHERE type='queue_depth' AND \"resolvedAt\" IS NULL" | jf s)
check "T35 queue_depth severity=MEDIUM" "$QSS" "MEDIUM"
BSS=$(q "SELECT \"severity\"::text s FROM \"Alert\" WHERE type='ai_breaker_open' AND \"resolvedAt\" IS NULL" | jf s)
check "T35 ai_breaker_open severity=HIGH" "$BSS" "HIGH"

# (2) 通知（ALERT_CHANNEL=log 預設）：worker log 見到 metadata-only 警報行，0 PII
ALERTLINE=$(grep -h "ALERT (channel=log): webhook_stale" /tmp/e2e-worker.log /tmp/e2e-worker-fail.log /tmp/e2e-worker2.log 2>/dev/null | tail -1)
[ -n "$ALERTLINE" ] || { echo "    ❌ T35 worker log 搵唔到 ALERT (channel=log) 行"; T35=1; }
echo "$ALERTLINE" | grep -qF "e2e 第一則" && { echo "    ❌ T35 警報 log 含訊息原文（PII 洩露）"; T35=1; }
echo "$ALERTLINE" | grep -qF "minutesSince" || { echo "    ❌ T35 警報 log 冇 metadata"; T35=1; }

# (3) 恢復 → auto-resolved
q "UPDATE \"Clinic\" SET \"lastWebhookEventAt\" = now() WHERE id='$TKW_CLINIC_ID'" >/dev/null
pnpm -s e2e:cron health-check >/dev/null 2>&1 || T35=1
if wait_for "SELECT (SELECT count(*) FROM \"Alert\" WHERE \"resolvedAt\" IS NULL AND type IN ('webhook_stale','queue_depth','ai_breaker_open'))::text c" '[{"c":"0"}]' 30; then
  pass "T35 恢復後 3 條 Alert 全部 auto-resolved"
else
  fail "T35 auto-resolve 失敗"
fi

# (4) /admin alerts API：STAFF 403（RBAC fail-closed）+ ADMIN 200 + POST resolve（手動）
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_TKW" "$BASE/api/admin/alerts")
check "T35 STAFF GET /api/admin/alerts → 403" "$CODE" "403"
q "UPDATE \"Clinic\" SET \"lastWebhookEventAt\" = now() - interval '40 minutes' WHERE id='$TKW_CLINIC_ID'" >/dev/null
pnpm -s e2e:cron health-check >/dev/null 2>&1 || T35=1
ALERT_ID=$(q "SELECT id FROM \"Alert\" WHERE type='webhook_stale' AND \"resolvedAt\" IS NULL" | grep -oE '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$ALERT_ID" ] || { echo "    ❌ T35 重開 webhook_stale alert 失敗"; T35=1; }
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_ADMIN" "$BASE/api/admin/alerts")
check "T35 ADMIN GET /api/admin/alerts → 200" "$CODE" "200"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_ADMIN" -X POST "$BASE/api/admin/alerts/$ALERT_ID/resolve")
check "T35 ADMIN POST resolve → 200" "$CODE" "200"
if wait_for "SELECT (\"resolvedAt\" IS NOT NULL)::text r FROM \"Alert\" WHERE id='$ALERT_ID'" '[{"r":"true"}]' 10; then
  pass "T35 手動 resolve 生效（resolvedAt set）"
else
  fail "T35 手動 resolve"
fi

# ── T36. quality_rating 每日監控（GREEN 無警報 / RED → HIGH） ─────────────
echo "[P4] T36: quality_rating..."
T36=0
q "UPDATE \"Alert\" SET \"resolvedAt\" = now() WHERE \"resolvedAt\" IS NULL AND type='quality_rating'" >/dev/null
pnpm -s e2e:quality >/dev/null 2>&1 || T36=1
QR=$(q "SELECT \"qualityRating\"::text r FROM \"Clinic\" WHERE id='$TKW_CLINIC_ID'" | jf r)
check "T36 mock GREEN → Clinic.qualityRating=GREEN" "$QR" "GREEN"
QC=$(q "SELECT (\"qualityCheckedAt\" IS NOT NULL)::text t FROM \"Clinic\" WHERE id='$TKW_CLINIC_ID'" | jf t)
check "T36 qualityCheckedAt 已設" "$QC" "true"
QA=$(q "SELECT count(*)::text c FROM \"Alert\" WHERE type='quality_rating' AND \"resolvedAt\" IS NULL" | jf c)
check "T36 GREEN 無 quality_rating 警報" "$QA" "0"

# RED inject（獨立 process 讀 env — server/worker 唔受影響）
WA_MOCK_QUALITY=RED pnpm -s e2e:quality >/dev/null 2>&1 || T36=1
if wait_for "SELECT (SELECT count(*) FROM \"Alert\" WHERE type='quality_rating' AND \"resolvedAt\" IS NULL AND \"clinicId\"='$TKW_CLINIC_ID')::text c" '[{"c":"1"}]' 15; then
  pass "T36 inject RED → TKW HIGH 警報（被 ban 前哨）"
else
  fail "T36 RED 警報未開"
fi
QS=$(q "SELECT \"severity\"::text s FROM \"Alert\" WHERE type='quality_rating' AND \"resolvedAt\" IS NULL AND \"clinicId\"='$TKW_CLINIC_ID'" | jf s)
check "T36 RED severity=HIGH" "$QS" "HIGH"
QD=$(q "SELECT (detail->>'rating')::text r FROM \"Alert\" WHERE type='quality_rating' AND \"resolvedAt\" IS NULL AND \"clinicId\"='$TKW_CLINIC_ID'" | jf r)
[ "$QD" = "RED" ] || { echo "    ❌ T36 alert detail 冇 rating metadata（raw=$QD）"; T36=1; }

# 恢復 → auto-resolved
pnpm -s e2e:quality >/dev/null 2>&1 || T36=1
if wait_for "SELECT (SELECT count(*) FROM \"Alert\" WHERE type='quality_rating' AND \"resolvedAt\" IS NULL)::text c" '[{"c":"0"}]' 15; then
  pass "T36 恢復 GREEN 後 quality_rating 警報全部 auto-resolved"
else
  fail "T36 quality auto-resolve"
fi

# ── T37. 週報：fixture → script → 數字斷言 + OpsReport 冪等 ───────────────
echo "[P4] T37: weekly report..."
T37=0
pnpm -s e2e:weekly seed >/dev/null 2>&1 || { echo "    ❌ T37 seed 失敗"; T37=1; }
pnpm -s weekly-report --start 2026-01-05 --end 2026-01-12 --clinic TKW >/dev/null 2>&1 || T37=1
pnpm -s weekly-report --start 2026-01-05 --end 2026-01-12 >/dev/null 2>&1 || T37=1
WC_OUT=$(pnpm -s e2e:weekly check 2>&1)
if echo "$WC_OUT" | grep -q "WEEKLY-ASSERT OK"; then
  pass "T37 週報數字全對（FRT 中位數 240s / 採用率 0.75 / Flow 2/3 / 預約 2/3 中位 60min）"
else
  echo "$WC_OUT" | grep -vE '^\{|ELIFECYCLE' | tail -10
  fail "T37 週報數字斷言"
fi
# 冪等：重跑同一 period → OpsReport row 數不變
OC1=$(q "SELECT count(*)::text c FROM \"OpsReport\" WHERE \"clinicId\"='$TKW_CLINIC_ID'" | jf c)
pnpm -s weekly-report --start 2026-01-05 --end 2026-01-12 --clinic TKW >/dev/null 2>&1 || true
OC2=$(q "SELECT count(*)::text c FROM \"OpsReport\" WHERE \"clinicId\"='$TKW_CLINIC_ID'" | jf c)
check "T37 OpsReport upsert 冪等（row 數不變）" "$OC2" "$OC1"
pnpm -s e2e:weekly clean >/dev/null 2>&1 || fail "T37 fixture clean"

# ── T38. duty-roster 消費端（mock fixture / RBAC / 白名單 / down 唔 crash） ─
echo "[P4] T38: duty-roster..."
T38=0
CODE=$(curl -s -o /tmp/e2e-duty.json -w '%{http_code}' -b "$COOKIE_TKW" "$BASE/api/duty-roster?clinicId=TKW")
check "T38 /api/duty-roster?clinicId=TKW（STAFF 本店）→ 200" "$CODE" "200"
DC=$(grep -oE '"staffName":"[^"]*"' /tmp/e2e-duty.json | wc -l | tr -d ' ')
check "T38 DUTY_MOCK fixture = 3 人" "$DC" "3"
INBOX_CONV=$(q "SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PATIENT_TKW'" | jf id)
curl -s -b "$COOKIE_TKW" "$BASE/inbox?conv=$INBOX_CONV" -o /tmp/e2e-inbox.html 2>/dev/null
grep -q "今日當值" /tmp/e2e-inbox.html || { echo "    ❌ T38 /inbox 側欄冇「今日當值」卡"; T38=1; }
grep -q "林小曼" /tmp/e2e-inbox.html || { echo "    ❌ T38 側欄卡冇 fixture 人員"; T38=1; }
DE_OUT=$(pnpm -s e2e:duty --cookie "$COOKIE_TKW" 2>&1)
echo "$DE_OUT" | grep -q "DUTY-403-OK" || { echo "    ❌ T38 別店 scope 未 403"; T38=1; }
echo "$DE_OUT" | grep -q "DUTY-WHITELIST-OK" || { echo "    ❌ T38 欄位白名單有漏"; T38=1; }
DD_OUT=$(pnpm -s e2e:duty --cookie "$COOKIE_TKW" --down 2>&1)
NOK=$(echo "$DD_OUT" | grep -c "DUTY-DOWN-OK")
check "T38 mock API down（DUTY_MOCK=0 + 無/壞 URL）→ 200 {duty:null} 唔 crash（×2）" "$NOK" "2"
[ "$T38" = 0 ] && pass "T38 duty-roster 消費端全鏈（fixture/卡/403/白名單/down fail-soft）" \
  || fail "T38 duty-roster（見上 ❌）"

# ── T39. backup / restore 驗證 ──────────────────────────────────────────
echo "[P4] T39: backup/restore..."
T39=0
BDIR="${BACKUP_DIR:-.dev/backups}"
BOUT=$(bash scripts/backup-wa.sh 2>&1)
echo "$BOUT" | tail -3
echo "$BOUT" | grep -q "\[backup\] DONE" || { echo "    ❌ T39 backup-wa.sh 冇 DONE"; T39=1; }
DUMP=$(ls -1t "$BDIR"/wa-inbox-*.dump.age "$BDIR"/wa-inbox-*.dump 2>/dev/null | head -1)
[ -n "$DUMP" ] && [ -f "$DUMP" ] || { echo "    ❌ T39 dump 檔唔存在"; T39=1; }
if ! command -v age >/dev/null 2>&1; then
  echo "$BOUT" | grep -qi "age 未安裝" || { echo "    ❌ T39 無 age 但冇明文 warning"; T39=1; }
  case "$DUMP" in *.age) echo "    ❌ T39 無 age 却產出 .age 檔"; T39=1 ;; esac
fi
ROUT=$(bash scripts/restore-wa-test.sh 2>&1)
echo "$ROUT" | tail -7
echo "$ROUT" | grep -q "RESTORE-TEST OK" || { echo "    ❌ T39 restore 驗證失敗"; T39=1; }
[ "$T39" = 0 ] && pass "T39 backup（dump + 兩軌加密 + retention）+ restore 落 scratch DB 5 表 row count 全對" \
  || fail "T39 backup/restore（見上 ❌）"

# ── summary ────────────────────────────────────────────────────────────
echo "════════════════════════════════════════════"
echo " E2E 完成：PASS=$PASS FAIL=$FAIL"
echo "════════════════════════════════════════════"
[ "$FAIL" = 0 ] || exit 1

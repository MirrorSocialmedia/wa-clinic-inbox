#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# e2e-notify-fix — cwi-notify-fix-20260907 T6（T260–T267）standalone driver
#
# T260 prefs 角色分離 / T261 自我修復 / T262 全濾走 warn / T263 assignee
#       forced + ADMIN 去重 / T264 /api/push/test 四結果（e2e-push.ts）
# T265 refetch 零通知 / T266 merge by messageId / T267 visibility 循環
#       （e2e-notify-ui.ts — 瀏覽器級）
#
# 前置：server（3100）+ worker 已起；DB 15432；worker log 喺 $WORKER_LOG。
# fixture 全部 hermetic（固定 id 冪等、段尾全清）；零 PII（E2E 病人資料）。
#
# 用法：bash scripts/e2e-notify-fix.sh   （exit 0 = 全綠）
# T268 迴歸另跑：N_STANDALONE=1 bash scripts/e2e-notify-gate.sh
# ═══════════════════════════════════════════════════════════════════════
set -u
cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
. ./.env
set +a
TSX=./node_modules/.bin/tsx
BASE="http://127.0.0.1:${PORT:-3100}"
WORKER_LOG="${WORKER_LOG:-/tmp/cwi-notifyfix-worker.log}"
PASS=0
FAIL=0
q() { "$TSX" scripts/e2e-query.ts "$1" 2>/dev/null; }
jf() { grep -oE "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
pass() { echo "  ✅ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected=[$3] actual=[$2])"; fi; }

# ── credentials / login ────────────────────────────────────────────────
TKW_EMAIL=$(awk '/^TKW STAFF:/{print $3}' .dev/credentials.txt)
TKW_PASS=$(awk '/^TKW STAFF:/{split($0,a," / "); print a[2]}' .dev/credentials.txt)
ADMIN_EMAIL=$(awk '/^ADMIN:/{print $2}' .dev/credentials.txt)
ADMIN_PASS=$(awk '/^ADMIN:/{split($0,a," / "); print a[2]}' .dev/credentials.txt)
H1B_PASS=$(awk -F= '/^H1_B_PASSWORD=/{print $2}' .dev/e2e-fixtures.txt)
TKW_CLINIC_ID=$(q "SELECT id FROM \"Clinic\" WHERE code='TKW'" | jf id)
[ -n "$TKW_CLINIC_ID" ] || { echo "FATAL: TKW clinic id 搵唔到"; exit 2; }
COOKIE_TKW=/tmp/e2e-cookie-notifyfix-tkw.txt
COOKIE_ADMIN=/tmp/e2e-cookie-notifyfix-admin.txt
CODE=$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIE_TKW" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$TKW_EMAIL\",\"password\":\"$TKW_PASS\"}")
[ "$CODE" = "200" ] || { echo "FATAL: TKW staff login $CODE（server 未起？）"; exit 2; }
CODE=$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIE_ADMIN" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}")
[ "$CODE" = "200" ] || { echo "FATAL: ADMIN login $CODE"; exit 2; }

# ── 臨時 staff B / C（TKW；e2e:staff create 固定 H1 密碼） ─────────────
B_EMAIL="staff-e2e-notifyfix-b@wa-clinic.local"
C_EMAIL="staff-e2e-notifyfix-c@wa-clinic.local"
STAFF_B=$(pnpm -s e2e:staff create --clinic TKW --email "$B_EMAIL" --name "E2E NotifyFix B" 2>/dev/null | grep -oE 'STAFF_ID=[a-z0-9]+' | head -1 | cut -d= -f2)
STAFF_C=$(pnpm -s e2e:staff create --clinic TKW --email "$C_EMAIL" --name "E2E NotifyFix C" 2>/dev/null | grep -oE 'STAFF_ID=[a-z0-9]+' | head -1 | cut -d= -f2)
[ -n "$STAFF_B" ] || { echo "FATAL: staff B 建立失敗"; exit 2; }
[ -n "$STAFF_C" ] || { echo "FATAL: staff C 建立失敗"; exit 2; }
COOKIE_B=/tmp/e2e-cookie-notifyfix-b.txt
COOKIE_C=/tmp/e2e-cookie-notifyfix-c.txt
curl -s -o /dev/null -c "$COOKIE_B" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$B_EMAIL\",\"password\":\"$H1B_PASS\"}"
curl -s -o /dev/null -c "$COOKIE_C" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$C_EMAIL\",\"password\":\"$H1B_PASS\"}"

# ── 瀏覽器 fixture 對話（T265–T267 用；固定 id 冪等） ──────────────────
FIXCT=e2enotifyfixct1
FIXCV=e2enotifyfixcv1
q "DELETE FROM \"Message\" WHERE \"conversationId\"='$FIXCV'" >/dev/null 2>&1
q "DELETE FROM \"Conversation\" WHERE id='$FIXCV'" >/dev/null 2>&1
q "DELETE FROM \"Contact\" WHERE id='$FIXCT'" >/dev/null 2>&1
q "INSERT INTO \"Contact\" (id,\"clinicId\",\"waId\",\"profileName\",labels) VALUES ('$FIXCT','$TKW_CLINIC_ID','85291234590','E2E NotifyFix 王五',ARRAY[]::text[])" >/dev/null 2>&1
q "INSERT INTO \"Conversation\" (id,\"clinicId\",\"contactId\",status,\"lastMessageAt\") VALUES ('$FIXCV','$TKW_CLINIC_ID','$FIXCT','OPEN',now())" >/dev/null 2>&1

# ── runners ────────────────────────────────────────────────────────────
pp() { # pp <desc> <e2e:push args...>
  local desc="$1"; shift
  local scen="${2:-x}"
  pnpm -s e2e:push --base "$BASE" "$@" > "/tmp/nf-push-$scen.out" 2>&1
  local out
  out=$(grep -oE "PUSH-(OK|FAIL)" "/tmp/nf-push-$scen.out" | head -1)
  if [ "$out" != "PUSH-OK" ]; then echo "    --- /tmp/nf-push-$scen.out (tail) ---"; tail -5 "/tmp/nf-push-$scen.out"; fi
  check "$desc" "$out" "PUSH-OK"
}
nn() { # nn <desc> <e2e:notify-ui args...>
  local desc="$1"; shift
  local scen="${2:-x}"
  pnpm -s e2e:notify-ui --base "$BASE" "$@" > "/tmp/nf-ui-$scen.out" 2>&1
  local out
  out=$(grep -E "NOTIFY-UI-(OK|FAIL)" "/tmp/nf-ui-$scen.out" | head -1)
  if [ "$out" != "NOTIFY-UI-OK" ]; then echo "    --- /tmp/nf-ui-$scen.out (tail) ---"; tail -8 "/tmp/nf-ui-$scen.out"; fi
  check "$desc" "$out" "NOTIFY-UI-OK"
}

# 瀏覽器 fixture 等待名（driver fixture 病人名 ≠ script 內建 PII_NAME）
WAIT_NAME="E2E NotifyFix 王五"

echo ""
echo "── NF. cwi-notify-fix-20260907（T260–T267）────────────────"

# warm-up：dev 首次編譯 push route 會慢/500 — 預熱（GET，零副作用）
for _w in 1 2 3 4 5; do
  _code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/push/vapid-key" -b "$COOKIE_TKW")
  [ "$_code" = "200" ] && break
  sleep 2
done

# T260：prefs 角色分離
pp "T260 prefs 角色分離（另一欄永不被寫）" \
  --scenario t260 --staff-b "$STAFF_B" --cookie-b "$COOKIE_B" --cookie-admin "$COOKIE_ADMIN" --clinic "$TKW_CLINIC_ID"

# T261：自我修復（相同 array → muted 當空 + warn log）
LOG_CURSOR=$(wc -l < "$WORKER_LOG" 2>/dev/null || echo 0)
pp "T261 自我修復（相同 array → 照收）" \
  --scenario t261 --staff-b "$STAFF_B" --cookie-b "$COOKIE_B" --clinic "$TKW_CLINIC_ID"
sleep 1
if [ -f "$WORKER_LOG" ] && sed -n "$((LOG_CURSOR + 1)),\$p" "$WORKER_LOG" | grep -q "自我修復"; then
  pass "T261 自我修復 warn log 出現（worker）"
else
  fail "T261 自我修復 warn log 未出現（$WORKER_LOG）"
fi

# T262：全濾走 → warn log
LOG_CURSOR=$(wc -l < "$WORKER_LOG" 2>/dev/null || echo 0)
pp "T262 全濾走（全部 mute → 零推送）" \
  --scenario t262 --staff-b "$STAFF_B" --staff-c "$STAFF_C" --cookie-b "$COOKIE_B" --cookie-c "$COOKIE_C" --clinic "$TKW_CLINIC_ID"
sleep 1
if [ -f "$WORKER_LOG" ] && sed -n "$((LOG_CURSOR + 1)),\$p" "$WORKER_LOG" | grep -q "全部收件人被 prefs 濾走"; then
  pass "T262 全濾走 warn log 出現（worker）"
else
  fail "T262 全濾走 warn log 未出現（$WORKER_LOG）"
fi

# T263：assignee forced + ADMIN 去重
pp "T263 assignee 靜音照收 + ADMIN assignee 去重" \
  --scenario t263 --staff-b "$STAFF_B" --cookie-b "$COOKIE_B" --cookie-admin "$COOKIE_ADMIN" --clinic "$TKW_CLINIC_ID"

# T264：/api/push/test 四結果
pp "T264 /api/push/test 四種結果" \
  --scenario t264 --staff-b "$STAFF_B" --cookie-b "$COOKIE_B" --clinic "$TKW_CLINIC_ID"

# T265：refetch 路徑零通知
nn "T265 通知只由 socket/push 觸發（refetch 零 fireNotify）" \
  --scenario t265 --cookie "$COOKIE_TKW" --clinic "$TKW_CLINIC_ID" --conv-u "$FIXCV" --wait-name "$WAIT_NAME"

# T266：merge by messageId（refetch 回舊 list 唔 drop socket append 行）
nn "T266 merge by messageId（refetch 唔 drop 唔重複）" \
  --scenario t266 --cookie "$COOKIE_TKW" --clinic "$TKW_CLINIC_ID" --conv-u "$FIXCV" --wait-name "$WAIT_NAME"

# T267：visibility 背景→前台（re-register + refetch + 交付）
nn "T267 visibility 循環（re-register + 訊息完整）" \
  --scenario t267 --cookie "$COOKIE_TKW" --clinic "$TKW_CLINIC_ID" --conv-u "$FIXCV" --wait-name "$WAIT_NAME"

# ── cleanup（hermetic：staff B/C + fixture 全清） ──────────────────────
q "DELETE FROM \"PushSubscription\" WHERE \"staffId\" IN ('$STAFF_B','$STAFF_C')" >/dev/null 2>&1
q "DELETE FROM \"StaffClinic\" WHERE \"staffId\" IN ('$STAFF_B','$STAFF_C')" >/dev/null 2>&1
q "DELETE FROM \"StaffUser\" WHERE id IN ('$STAFF_B','$STAFF_C')" >/dev/null 2>&1
q "DELETE FROM \"Message\" WHERE \"conversationId\"='$FIXCV'" >/dev/null 2>&1
q "DELETE FROM \"Conversation\" WHERE id='$FIXCV'" >/dev/null 2>&1
q "DELETE FROM \"Contact\" WHERE id='$FIXCT'" >/dev/null 2>&1
q "DELETE FROM \"PushSubscription\" WHERE \"staffId\" NOT IN (SELECT id FROM \"StaffUser\")" >/dev/null 2>&1
NRES=$(q "SELECT ((SELECT count(*) FROM \"Conversation\" WHERE id LIKE 'e2enotifyfix%') + (SELECT count(*) FROM \"Contact\" WHERE id LIKE 'e2enotifyfix%'))::text c" | jf c)
check "NF cleanup 零殘留" "$NRES" "0"

echo ""
echo "NOTIFYFIX-GATE: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]

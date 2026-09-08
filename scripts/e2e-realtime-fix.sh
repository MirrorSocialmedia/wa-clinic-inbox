#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# e2e-realtime-fix — cwi-realtime-fix-20260907 T6（T270–T280 + §4 自動化 t281/t282）
#
# T270 游標隔離（B 新訊息唔好推進 A 補漏窗）      T271 同秒對 + 60s 重疊窗
# T272 換對話 = latest（唔准 delta）              T273 prefs DB 單一真相（mount 覆蓋 localStorage）
# T274 客戶端自我修復（muted===adminMsg 壞值）    T275 ADMIN 唔寫 mutedClinics（POST payload）
# T276 fireNotify 來源 log（socket vs refetch）   T278 /sw.js no-cache header
# T279 SW_VERSION + 更新提示（controllerchange）  T280 SW 更新後 subscription 唔失效
# t281 §4 背景兩條→前台兩條                        t282 §4 「閂咗」期間訊息→重開喺度
# T303 開住對話收 IN → badge 即清 + markRead×1（burst 3→1，cwi-hotfix-20260908 §2）
# T304 tab hidden 收 IN → 唔 markRead；visible 後先清 + markRead×1
#
# 前置：server（3100）+ worker 已起；DB 15432；REDIS_URL 喺 .env。
# fixture 全部 hermetic（固定 id 冪等、段尾全清）；零 PII（E2E 病人資料）。
#
# 用法：bash scripts/e2e-realtime-fix.sh   （exit 0 = 全綠）
# T277 迴歸另跑：bash scripts/e2e-notify-fix.sh + N_STANDALONE=1 bash scripts/e2e-notify-gate.sh
# ═══════════════════════════════════════════════════════════════════
set -u
cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
. ./.env
set +a
TSX=./node_modules/.bin/tsx
BASE="http://127.0.0.1:${PORT:-3100}"
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
MF_EMAIL=$(awk '/^MF STAFF:/{print $3}' .dev/credentials.txt)
MF_PASS=$(awk '/^MF STAFF:/{split($0,a," / "); print a[2]}' .dev/credentials.txt)
ADMIN_EMAIL=$(awk '/^ADMIN:/{print $2}' .dev/credentials.txt)
ADMIN_PASS=$(awk '/^ADMIN:/{split($0,a," / "); print a[2]}' .dev/credentials.txt)
TKW_CLINIC_ID=$(q "SELECT id FROM \"Clinic\" WHERE code='TKW'" | jf id)
MF_CLINIC_ID=$(q "SELECT id FROM \"Clinic\" WHERE code='MF'" | jf id)
[ -n "$TKW_CLINIC_ID" ] && [ -n "$MF_CLINIC_ID" ] || { echo "FATAL: clinic id 搵唔到"; exit 2; }
TKW_STAFF_ID=$(q "SELECT id FROM \"StaffUser\" WHERE email='$TKW_EMAIL'" | jf id)
[ -n "$TKW_STAFF_ID" ] || { echo "FATAL: TKW staff id 搵唔到（email=$TKW_EMAIL）"; exit 2; }
MF_STAFF_ID=$(q "SELECT id FROM \"StaffUser\" WHERE email='$MF_EMAIL'" | jf id)
[ -n "$MF_STAFF_ID" ] || { echo "FATAL: MF staff id 搵唔到（email=$MF_EMAIL）"; exit 2; }
COOKIE_TKW=/tmp/e2e-cookie-rt-tkw.txt
COOKIE_MF=/tmp/e2e-cookie-rt-mf.txt
COOKIE_ADMIN=/tmp/e2e-cookie-rt-admin.txt
CODE=$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIE_TKW" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$TKW_EMAIL\",\"password\":\"$TKW_PASS\"}")
[ "$CODE" = "200" ] || { echo "FATAL: TKW staff login $CODE（server 未起？）"; exit 2; }
CODE=$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIE_MF" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$MF_EMAIL\",\"password\":\"$MF_PASS\"}")
[ "$CODE" = "200" ] || { echo "FATAL: MF staff login $CODE"; exit 2; }
CODE=$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIE_ADMIN" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}")
[ "$CODE" = "200" ] || { echo "FATAL: ADMIN login $CODE"; exit 2; }

# ── fixture 對話（真 webhook 路徑 — mock-inbound；固定 waId 冪等） ─────
RT_CT_A=85291234671
RT_CT_B=85291234672
RT_CT_M=85291234673   # cwi-realtime-v2 T285：MF 店對話 contact
NAME_A="E2E Realtime 張三"
NAME_B="E2E Realtime 王五"
NAME_M="E2E Realtime 陳四"
wait_msg() { # wait_msg <wamid> <convVarEchoPrefix> — 等 worker 落 DB，回傳 conversationId
  local wamid="$1" i cv=""
  for i in $(seq 1 30); do
    cv=$(q "SELECT \"conversationId\" c FROM \"Message\" WHERE \"waMessageId\"='$wamid'" | jf c)
    [ -n "$cv" ] && { echo "$cv"; return 0; }
    sleep 1
  done
  return 1
}
# 冪等清理（舊 run 殘留）
q "DELETE FROM \"Message\" WHERE \"waMessageId\" LIKE 'rtfw%' OR \"waMessageId\" LIKE 'rtwv2%'" >/dev/null 2>&1
for _w in 1 2 3 4 5; do
  _code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/push/prefs" -b "$COOKIE_TKW")
  [ "$_code" = "200" ] && break
  sleep 2
done
[ "$_code" = "200" ] || { echo "FATAL: GET /api/push/prefs warmup $_code（新 GET route 編譯失敗？）"; exit 2; }
# 洗舊對話（按 waId）再重建
for _wa in "$RT_CT_A" "$RT_CT_B" "$RT_CT_M"; do
  q "DELETE FROM \"Message\" WHERE \"conversationId\" IN (SELECT id FROM \"Conversation\" WHERE \"contactId\" IN (SELECT id FROM \"Contact\" WHERE \"waId\"='$_wa'))" >/dev/null 2>&1
  q "DELETE FROM \"Conversation\" WHERE \"contactId\" IN (SELECT id FROM \"Contact\" WHERE \"waId\"='$_wa')" >/dev/null 2>&1
  q "DELETE FROM \"Contact\" WHERE \"waId\"='$_wa'" >/dev/null 2>&1
done
q "UPDATE \"StaffUser\" SET \"pushPrefs\"=NULL WHERE id='$TKW_STAFF_ID'" >/dev/null 2>&1
pnpm -s mock-inbound message --clinic TKW --from "$RT_CT_A" --name "$NAME_A" --text "rt-fixture-a1" --wamid rtfwa1 >/dev/null 2>&1
CONV_A=$(wait_msg rtfwa1) || { echo "FATAL: fixture A 未落 DB"; exit 2; }
pnpm -s mock-inbound message --clinic TKW --from "$RT_CT_B" --name "$NAME_B" --text "rt-fixture-b1" --wamid rtfwb1 >/dev/null 2>&1
CONV_B=$(wait_msg rtfwb1) || { echo "FATAL: fixture B 未落 DB"; exit 2; }
echo "  fixture: CONV_A=${CONV_A:0:8}… CONV_B=${CONV_B:0:8}…"

# ── runner ─────────────────────────────────────────────────────────────
nn() { # nn <desc> <e2e:notify-ui args...>
  local desc="$1"; shift
  local scen="${2:-x}"
  pnpm -s e2e:notify-ui --base "$BASE" "$@" > "/tmp/rt-ui-$scen.out" 2>&1
  local out
  out=$(grep -E "NOTIFY-UI-(OK|FAIL)" "/tmp/rt-ui-$scen.out" | head -1)
  if [ "$out" != "NOTIFY-UI-OK" ]; then echo "    --- /tmp/rt-ui-$scen.out (tail) ---"; tail -8 "/tmp/rt-ui-$scen.out"; fi
  check "$desc" "$out" "NOTIFY-UI-OK"
}

echo ""
echo "── RT. cwi-realtime-fix-20260907（T270–T280 + §4）+ cwi-realtime-v2-20260907（T281–T285）"

# T270：per-conversation 游標隔離（B 新訊息唔推進 A 補漏窗）
nn "T270 游標隔離（A2 只喺 DB — catchUp(A) 收返；B 唔推進 A 游標）" \
  --scenario t270 --cookie "$COOKIE_TKW" --clinic "$TKW_CLINIC_ID" \
  --conv-u "$CONV_A" --conv-b "$CONV_B" --wait-name "$NAME_A" \
  --id-a2 e2et270a2 --body-a2 rt-t270-a2

# T271：同秒 waTimestamp 對 + 60s 重疊窗 + by-id 去重
nn "T271 同秒對（重疊窗補返兩條 + 無重複）" \
  --scenario t271 --cookie "$COOKIE_TKW" --clinic "$TKW_CLINIC_ID" \
  --conv-u "$CONV_A" --wait-name "$NAME_A" \
  --id-a3 e2et271a3 --id-a4 e2et271a4 --body-a4s rt-t271-a4s

# T272：換對話 = latest（spy fetch URL 無 after=）
nn "T272 換對話行 latest（唔准 delta）" \
  --scenario t272 --cookie "$COOKIE_TKW" --clinic "$TKW_CLINIC_ID" \
  --conv-u "$CONV_A" --conv-b "$CONV_B" --wait-name "$NAME_A" \
  --name-a "$NAME_A" --name-b "$NAME_B"

# T273：prefs DB 單一真相（mount 覆蓋 localStorage 舊值）
q "UPDATE \"StaffUser\" SET \"pushPrefs\"='{\"mutedClinics\":[]}'::json WHERE id='$TKW_STAFF_ID'" >/dev/null 2>&1
nn "T273 mount 由 DB 覆蓋 localStorage（舊本地 mute 失效）" \
  --scenario t273 --cookie "$COOKIE_TKW" --clinic "$TKW_CLINIC_ID" --wait-name "$NAME_A" \
  --no-prefs-reset \
  --prefs "{\"desktop\":true,\"sound\":true,\"mutedClinics\":[\"$TKW_CLINIC_ID\"],\"adminMsgClinics\":[]}"

# T274：客戶端自我修復（壞值 muted===adminMsg → warn + 寫返 + server 覆蓋）
q "UPDATE \"StaffUser\" SET \"pushPrefs\"='{\"mutedClinics\":[\"$MF_CLINIC_ID\"]}'::json WHERE id='$TKW_STAFF_ID'" >/dev/null 2>&1
nn "T274 自我修復（muted===adminMsg 壞值 → warn + DB 值為準）" \
  --scenario t274 --cookie "$COOKIE_TKW" --clinic "$TKW_CLINIC_ID" --clinic-m "$MF_CLINIC_ID" --wait-name "$NAME_A" \
  --no-prefs-reset \
  --prefs "{\"desktop\":true,\"sound\":true,\"mutedClinics\":[\"$TKW_CLINIC_ID\"],\"adminMsgClinics\":[\"$TKW_CLINIC_ID\"]}"

# T275：ADMIN 唔寫 mutedClinics（POST payload + 面板單一 checkbox）
nn "T275 ADMIN POST 只帶 adminMsgClinics（無 mutedClinics）" \
  --scenario t275 --cookie3 "$COOKIE_ADMIN" --clinic "$TKW_CLINIC_ID" --wait-name "$NAME_A"

# T276：fireNotify 來源 log（socket 有 / refetch 零）
nn "T276 notify 來源 log（socket:message:new 有；refetch 零）" \
  --scenario t276 --cookie "$COOKIE_TKW" --clinic "$TKW_CLINIC_ID" \
  --conv-u "$CONV_A" --wait-name "$NAME_A"

# T278：/sw.js no-cache header
HC=$(curl -sI "$BASE/sw.js" | tr -d '\r' | awk 'tolower($1)=="cache-control:"{print tolower($2)}')
check "T278 /sw.js Cache-Control no-cache" "$(echo "$HC" | grep -o 'no-cache' | head -1)" "no-cache"

# T279：SW_VERSION + 更新提示（controllerchange → toast + 版本 a1→a2）
nn "T279 SW 更新（byte 變 → 提示 + 版本 a1→a2）" \
  --scenario t279 --cookie "$COOKIE_TKW" --clinic "$TKW_CLINIC_ID" --wait-name "$NAME_A"

# T280：SW 更新後 subscription 唔失效
nn "T280 SW 更新後 subscription endpoint 唔變 + SW active" \
  --scenario t280 --cookie "$COOKIE_TKW" --clinic "$TKW_CLINIC_ID" --wait-name "$NAME_A"

# T287（§4 第 3 步，原 t281 — v2 重編號）：背景兩條 → 前台兩條
nn "T287 §4 背景兩條訊息→前台都喺（無重複 + catchUp log）" \
  --scenario t287 --cookie "$COOKIE_TKW" --clinic "$TKW_CLINIC_ID" \
  --conv-u "$CONV_A" --wait-name "$NAME_A" --b3 rt-t287-3 --b4 rt-t287-4

# T288（§4 第 4 步，原 t282 — v2 重編號）：「閂咗」期間真 webhook 訊息 → 重開喺度
pnpm -s mock-inbound message --clinic TKW --from "$RT_CT_A" --text "rt-t288-a5" --wamid rtfwa5 >/dev/null 2>&1
wait_msg rtfwa5 >/dev/null || { echo "FATAL: t288 fixture 未落 DB"; exit 2; }
nn "T288 §4 重開後訊息喺度（真 webhook 路徑入 DB）" \
  --scenario t288 --cookie "$COOKIE_TKW" --clinic "$TKW_CLINIC_ID" \
  --conv-u "$CONV_A" --wait-name "$NAME_A" --body-a5 rt-t288-a5

# ── cwi-realtime-v2-20260907（T281–T285） ─────────────────────────

# T281（v2 §1）：跨店 assignee（MF staff 唔綁定 TKW）經 staff: room 收 message:new；同店 assignee 去重
q "UPDATE \"StaffUser\" SET \"pushPrefs\"=NULL WHERE id='$MF_STAFF_ID'" >/dev/null 2>&1
nn "T281 跨店 assignee 經 staff room 收到 + 同店 assignee 去重（1 次通知）" \
  --scenario t281 --cookie "$COOKIE_MF" --cookie2 "$COOKIE_TKW" --clinic "$TKW_CLINIC_ID" \
  --conv-u "$CONV_A" --wait-name "$NAME_A" \
  --staff-mf "$MF_STAFF_ID" --staff-tkw "$TKW_STAFF_ID" \
  --wa "$RT_CT_A" --b-a rt-t281v2-a --b-b rt-t281v2-b

# T282（v2 §2）：IN 訊息 waTimestamp 比 cursor 早 5 分鐘（慢鐘）→ createdAt 游標照攞到 + 排最尾
nn "T282 慢鐘 IN（waTs 早 5 分鐘）經 createdAt 游標攞到 + 排最尾" \
  --scenario t282 --cookie "$COOKIE_TKW" --clinic "$TKW_CLINIC_ID" \
  --conv-u "$CONV_A" --wait-name "$NAME_A" --body-a5 rt-t282v2-slow

# T283（v2 §2）：HISTORY 訊息仍排最舊（waTimestamp 例外）
nn "T283 HISTORY 訊息排最舊（createdAt 新但 waTs 舊）" \
  --scenario t283 --cookie "$COOKIE_TKW" --clinic "$TKW_CLINIC_ID" \
  --conv-u "$CONV_A" --wait-name "$NAME_A"

# T284（v2 §3）：socket 靜音 → 20s reconcile 安全網攞到 + [rt] reconcile log
nn "T284 socket 靜音 → 20s reconcile 攞到 + [rt] reconcile log" \
  --scenario t284 --cookie "$COOKIE_TKW" --clinic "$TKW_CLINIC_ID" \
  --conv-u "$CONV_A" --wait-name "$NAME_A"

# T285（v2 §4）：ADMIN 列表唔顯示「跨店」badge；STAFF 真跨店照顯示
nn "T285 ADMIN 無「跨店」badge；STAFF 真跨店照顯示" \
  --scenario t285 --cookie "$COOKIE_TKW" --cookie3 "$COOKIE_ADMIN" --clinic "$TKW_CLINIC_ID" \
  --wait-name "$NAME_A" --staff-tkw "$TKW_STAFF_ID" \
  --wa-m "$RT_CT_M" --name-m "$NAME_M"

# ── cwi-hotfix-20260908（T303–T304：開住對話 unread 即時清 + hidden 唔清）──────────────

# T303：開住對話收 IN（tab 可見）→ 列表 badge 即時 0 + server markRead 恰 1 次；debounce 300ms 內連發 3 條收斂成 1 次
nn "T303 開住對話收 IN → badge 即清 + markRead×1（burst 3→1）" \
  --scenario t303 --cookie "$COOKIE_TKW" --clinic "$TKW_CLINIC_ID" \
  --conv-u "$CONV_A" --wait-name "$NAME_A"

# T304：tab hidden 時收 IN → 唔 markRead（DB unread 保留 + badge 保留）；visible 後先清 + markRead 恰 1 次
nn "T304 tab hidden 唔 markRead（visible 後先清 + markRead×1）" \
  --scenario t304 --cookie "$COOKIE_TKW" --clinic "$TKW_CLINIC_ID" \
  --conv-u "$CONV_A" --wait-name "$NAME_A"

# ── cleanup（hermetic） ────────────────────────────────────────────────
q "DELETE FROM \"Message\" WHERE \"conversationId\" IN ('$CONV_A','$CONV_B') OR \"waMessageId\" LIKE 'rtfw%' OR \"waMessageId\" LIKE 'rtwv2%'" >/dev/null 2>&1
q "DELETE FROM \"Conversation\" WHERE id IN ('$CONV_A','$CONV_B') OR \"contactId\" IN (SELECT id FROM \"Contact\" WHERE \"waId\"='$RT_CT_M')" >/dev/null 2>&1
q "DELETE FROM \"Contact\" WHERE \"waId\" IN ('$RT_CT_A','$RT_CT_B','$RT_CT_M')" >/dev/null 2>&1
q "UPDATE \"StaffUser\" SET \"pushPrefs\"=NULL WHERE id='$TKW_STAFF_ID'" >/dev/null 2>&1
q "UPDATE \"StaffUser\" SET \"pushPrefs\"=NULL WHERE id='$MF_STAFF_ID'" >/dev/null 2>&1
NRES=$(q "SELECT ((SELECT count(*) FROM \"Message\" WHERE \"waMessageId\" LIKE 'rtfw%' OR \"waMessageId\" LIKE 'rtwv2%') + (SELECT count(*) FROM \"Conversation\" WHERE id IN ('$CONV_A','$CONV_B')))::text c" | jf c)
check "RT cleanup 零殘留" "$NRES" "0"

echo ""
echo "REALTIMEFIX-GATE: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]

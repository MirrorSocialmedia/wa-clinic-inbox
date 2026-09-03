#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# e2e-notify-gate — cwi-master-20260902 B2（Part B 通知 v1）T160–T168 + T169
#
# 通知 v1：客人來訊一定要有提示。三觸發（message:new IN / urgent:escalation /
# notice:new）+ N-2 指派/ADMIN 規則 + N-4 零 PII + N-5 開住唔響 + N-6 節流 +
# N-7 降級三件套 + N-8 設定面板。
#
# 瀏覽器級斷言 = scripts/e2e-notify-ui.ts（playwright + Redis publish
# wa-inbox:notify → web server 真實 socket 路徑 — 零新事件、零 worker 依賴）。
#
# 用法：
#  (a) mock-e2e.sh inline：`source scripts/e2e-notify-gate.sh && run_notify_gate`
#      （依賴變量：$BASE $TKW_CLINIC_ID $MF_CLINIC_ID $TKW_STAFF_ID $COOKIE_TKW
#        $COOKIE_ADMIN $H1B_PASS + 函數 q/jf/pass/fail/check）
#  (b) standalone：`N_STANDALONE=1 bash scripts/e2e-notify-gate.sh`
#      （自組 env + login；exit 0 = 全綠）— 用嚟單獨驗 N 段而唔使行完整 suite
#
# fixture 全部 hermetic（固定 id、DELETE+INSERT 冪等、段尾全清）。
# ═══════════════════════════════════════════════════════════════════════

run_notify_gate() {
  echo ""
  echo "── N. cwi-master B2 Part B 通知 v1（T160–T169）────────────────"

  # ── (0) fixture：staff B（TKW 同店）/ C（TKW+MF 多店）/ 8 conv ─────────
  local N_B_EMAIL="staff-e2e-notify-b@wa-clinic.local"
  local N_C_EMAIL="staff-e2e-notify-c@wa-clinic.local"
  local N_STAFF_B N_STAFF_C N_STAFF_A CODE
  N_STAFF_B=$(pnpm -s e2e:staff create --clinic TKW --email "$N_B_EMAIL" --name "E2E Notify B" 2>/dev/null | grep -oE 'STAFF_ID=[a-z0-9]+' | head -1 | cut -d= -f2)
  N_STAFF_C=$(pnpm -s e2e:staff create --clinic TKW --email "$N_C_EMAIL" --name "E2E Notify C" 2>/dev/null | grep -oE 'STAFF_ID=[a-z0-9]+' | head -1 | cut -d= -f2)
  N_STAFF_A=$(q "SELECT id::text id FROM \"StaffUser\" WHERE email='$TKW_EMAIL'" | jf id)
  [ -n "$N_STAFF_A" ] || { fail "N-0 TKW staff A id 搵唔到"; return 1; }
  [ -n "$N_STAFF_B" ] || { fail "N-0 臨時 staff B 建立失敗"; return 1; }
  [ -n "$N_STAFF_C" ] || { fail "N-0 臨時 staff C 建立失敗"; return 1; }
  # C 多店：綁 MF（e2e:staff create 已寫 TKW primary；補第二間）
  q "INSERT INTO \"StaffClinic\" (\"staffId\",\"clinicId\",\"isPrimary\") VALUES ('$N_STAFF_C','$MF_CLINIC_ID',false) ON CONFLICT (\"staffId\",\"clinicId\") DO NOTHING" >/dev/null 2>&1
  # B / C 登入（密碼 = H1 fixture — e2e:staff create 固定用 H1_B_PASSWORD）
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -c /tmp/e2e-cookie-notify-b.txt \
    -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$N_B_EMAIL\",\"password\":\"$H1B_PASS\"}")
  check "N-0 staff B 登入 → 200" "$CODE" "200"
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -c /tmp/e2e-cookie-notify-c.txt \
    -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$N_C_EMAIL\",\"password\":\"$H1B_PASS\"}")
  check "N-0 staff C 登入 → 200" "$CODE" "200"

  # 對話 fixture（raw INSERT 紀律：必帶 id + 必填欄；固定 id 冪等）
  local C1=e2enotifyct1 C2=e2enotifyct2 C3=e2enotifyct3
  local C4=e2enotifyct4 C5=e2enotifyct5 C6=e2enotifyct6 C7=e2enotifyct7 C8=e2enotifyct8
  local CVU=e2enotifycvu CVA=e2enotifycva CVM=e2enotifycvm
  local CT1=e2enotifyctv1 CT2=e2enotifyctv2 CT3=e2enotifyctv3 CT4=e2enotifyctv4 CT5=e2enotifyctv5
  q "DELETE FROM \"Conversation\" WHERE id IN ('$CVU','$CVA','$CVM','$CT1','$CT2','$CT3','$CT4','$CT5')" >/dev/null 2>&1
  q "DELETE FROM \"Contact\" WHERE id IN ('$C1','$C2','$C3','$C4','$C5','$C6','$C7','$C8')" >/dev/null 2>&1
  q "INSERT INTO \"Contact\" (id,\"clinicId\",\"waId\",\"profileName\",labels) VALUES
    ('$C1','$TKW_CLINIC_ID','85291234567','PII 張三 E2E',ARRAY[]::text[]),
    ('$C2','$TKW_CLINIC_ID','85291234568','E2E 李四',ARRAY[]::text[]),
    ('$C3','$MF_CLINIC_ID','85291234569','E2E 王五',ARRAY[]::text[]),
    ('$C4','$TKW_CLINIC_ID','85291234570','E2E N3-a',ARRAY[]::text[]),
    ('$C5','$TKW_CLINIC_ID','85291234571','E2E N3-b',ARRAY[]::text[]),
    ('$C6','$TKW_CLINIC_ID','85291234572','E2E N3-c',ARRAY[]::text[]),
    ('$C7','$TKW_CLINIC_ID','85291234573','E2E N3-d',ARRAY[]::text[]),
    ('$C8','$TKW_CLINIC_ID','85291234574','E2E N3-e',ARRAY[]::text[])" >/dev/null 2>&1
  q "INSERT INTO \"Conversation\" (id,\"clinicId\",\"contactId\",status,\"lastMessageAt\") VALUES
    ('$CVU','$TKW_CLINIC_ID','$C1','OPEN',now()),
    ('$CVA','$TKW_CLINIC_ID','$C2','OPEN',now()),
    ('$CVM','$MF_CLINIC_ID','$C3','OPEN',now()),
    ('$CT1','$TKW_CLINIC_ID','$C4','OPEN',now()),
    ('$CT2','$TKW_CLINIC_ID','$C5','OPEN',now()),
    ('$CT3','$TKW_CLINIC_ID','$C6','OPEN',now()),
    ('$CT4','$TKW_CLINIC_ID','$C7','OPEN',now()),
    ('$CT5','$TKW_CLINIC_ID','$C8','OPEN',now())" >/dev/null 2>&1
  q "UPDATE \"Conversation\" SET \"assigneeId\"='$N_STAFF_A' WHERE id='$CVA'" >/dev/null 2>&1
  local NFIX
  NFIX=$(q "SELECT count(*)::text c FROM \"Conversation\" WHERE id IN ('$CVU','$CVA','$CVM','$CT1','$CT2','$CT3','$CT4','$CT5')" | jf c)
  check "N-0 fixture 對話 ×8（冪等）" "$NFIX" "8"

  # ── scenario runner（瀏覽器級；dev 首載編譯慢 → script 內已 poll 等 DOM 120s） ──
  nn() { # nn <desc> <e2e:notify-ui args...>
    local desc="$1"; shift
    local out
    out=$(pnpm -s e2e:notify-ui --base "$BASE" "$@" 2>&1 | grep -E "NOTIFY-UI-(OK|FAIL)" | head -1)
    check "$desc" "$out" "NOTIFY-UI-OK"
  }

  # T160：未指派 → 全店 STAFF 響（A + B 都彈）
  nn "T160 未指派 → 全店響（A+B 雙 browser 都彈）" \
    --scenario t160 --cookie "$COOKIE_TKW" --cookie2 /tmp/e2e-cookie-notify-b.txt \
    --clinic "$TKW_CLINIC_ID" --conv-u "$CVU"

  # T161：已指派 → 只負責人響（A 響 / B 靜）
  nn "T161 已指派 → 只 assignee 響（A 響 / B 靜）" \
    --scenario t161 --cookie "$COOKIE_TKW" --cookie2 /tmp/e2e-cookie-notify-b.txt \
    --clinic "$TKW_CLINIC_ID" --conv-u "$CVU" --conv-a "$CVA"

  # T162：正開住嗰個對話 → 唔響唔彈（訊息照入）
  nn "T162 正開對話 → 唔響唔彈" \
    --scenario t162 --cookie "$COOKIE_TKW" --clinic "$TKW_CLINIC_ID" --conv-u "$CVU"

  # T163：節流（同 conv 30s 一次 + 全域 10s 最多 3 次音）— 最長（含 30s 窗）
  nn "T163 節流（同 conv 30s + 全域 10s/3 音）" \
    --scenario t163 --cookie "$COOKIE_TKW" --clinic "$TKW_CLINIC_ID" \
    --convs-t "$CT1,$CT2,$CT3,$CT4,$CT5"

  # T164：OS 零 PII regex（message + urgent 都要 — urgent payload 有 contactName = 陷阱）
  nn "T164 OS 零 PII regex（病人資料零漏出）" \
    --scenario t164 --cookie "$COOKIE_TKW" --clinic "$TKW_CLINIC_ID" --conv-u "$CVU" --conv-a "$CVA"

  # T165：permission denied → 降級三件套（(N) 標題 + favicon 紅點 + bell badge）
  nn "T165 denied → 降級（(N) 標題 + favicon 紅點 + badge）" \
    --scenario t165 --denied 1 --cookie "$COOKIE_TKW" --clinic "$TKW_CLINIC_ID" --conv-u "$CVU"

  # T166：urgent → 第二音（notify-urgent.mp3，唔係 playChime）
  nn "T166 urgent → 第二音（notify-urgent.mp3）" \
    --scenario t166 --cookie "$COOKIE_TKW" --clinic "$TKW_CLINIC_ID" --conv-u "$CVU"

  # T167：多店逐店靜音（C：TKW muted → 靜；MF → 響）
  local PREFS_T167="{\"desktop\":true,\"sound\":true,\"mutedClinics\":[\"$TKW_CLINIC_ID\"],\"adminMsgClinics\":[]}"
  nn "T167 多店逐店靜音（C：TKW 靜 / MF 響）" \
    --scenario t167 --cookie3 /tmp/e2e-cookie-notify-c.txt \
    --clinic "$TKW_CLINIC_ID" --clinic-m "$MF_CLINIC_ID" --conv-u "$CVU" --conv-m "$CVM" \
    --prefs "$PREFS_T167"

  # T168：mention 迴歸（bell badge + chime + 同事名保留 + staff 定向 room）
  nn "T168 mention 迴歸（bell + chime + 同事名）" \
    --scenario t168 --cookie "$COOKIE_TKW" --clinic "$TKW_CLINIC_ID" --conv-a "$CVA" \
    --staff-a "$N_STAFF_A" --staff-b "$N_STAFF_B"

  # T169：ADMIN 預設唔收 + 設定面板逐店 opt-in + urgent 預設收（B.3 驗收附加）
  nn "T169 ADMIN 預設唔收 + opt-in + urgent 預設收" \
    --scenario t169 --cookie3 "$COOKIE_ADMIN" \
    --clinic "$TKW_CLINIC_ID" --clinic-m "$MF_CLINIC_ID" --conv-u "$CVU" --conv-a "$CVA" --conv-m "$CVM"

  # ── cleanup（hermetic：staff B/C + fixture 全清） ──────────────────────
  q "DELETE FROM \"StaffClinic\" WHERE \"staffId\" IN ('$N_STAFF_B','$N_STAFF_C')" >/dev/null 2>&1
  q "DELETE FROM \"StaffUser\" WHERE id IN ('$N_STAFF_B','$N_STAFF_C')" >/dev/null 2>&1
  q "DELETE FROM \"Conversation\" WHERE id IN ('$CVU','$CVA','$CVM','$CT1','$CT2','$CT3','$CT4','$CT5')" >/dev/null 2>&1
  q "DELETE FROM \"Contact\" WHERE id IN ('$C1','$C2','$C3','$C4','$C5','$C6','$C7','$C8')" >/dev/null 2>&1
  local NRES
  NRES=$(q "SELECT ((SELECT count(*) FROM \"Conversation\" WHERE id LIKE 'e2enotifycv%') + (SELECT count(*) FROM \"Contact\" WHERE id LIKE 'e2enotifyct%'))::text c" | jf c)
  check "N cleanup 零殘留" "$NRES" "0"
}

# ── standalone 模式（自組 env + login；exit code = 全綠/有紅） ───────────
if [ "${N_STANDALONE:-}" = "1" ]; then
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
  TKW_EMAIL=$(awk '/^TKW STAFF:/{print $3}' .dev/credentials.txt)
  TKW_PASS=$(awk '/^TKW STAFF:/{split($0,a," / "); print a[2]}' .dev/credentials.txt)
  ADMIN_EMAIL=$(awk '/^ADMIN:/{print $2}' .dev/credentials.txt)
  ADMIN_PASS=$(awk '/^ADMIN:/{split($0,a," / "); print a[2]}' .dev/credentials.txt)
  H1B_PASS=$(awk -F= '/^H1_B_PASSWORD=/{print $2}' .dev/e2e-fixtures.txt)
  TKW_CLINIC_ID=$(q "SELECT id FROM \"Clinic\" WHERE code='TKW'" | jf id)
  MF_CLINIC_ID=$(q "SELECT id FROM \"Clinic\" WHERE code='MF'" | jf id)
  TKW_STAFF_ID=$(q "SELECT id::text id FROM \"StaffUser\" WHERE email='$TKW_EMAIL'" | jf id)
  COOKIE_TKW=/tmp/e2e-cookie-tkw.txt
  COOKIE_ADMIN=/tmp/e2e-cookie-admin.txt
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIE_TKW" \
    -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$TKW_EMAIL\",\"password\":\"$TKW_PASS\"}")
  [ "$CODE" = "200" ] || { echo "FATAL: TKW staff login $CODE（dev server 未起？）"; exit 2; }
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIE_ADMIN" \
    -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}")
  [ "$CODE" = "200" ] || { echo "FATAL: ADMIN login $CODE"; exit 2; }
  run_notify_gate
  echo "NOTIFY-GATE: PASS=$PASS FAIL=$FAIL"
  [ "$FAIL" -eq 0 ]
fi

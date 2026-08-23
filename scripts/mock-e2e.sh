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
#   T14.5 (H-3) summary 去識別化：mock AI 輸出含 profileName（bait token）嘅 summary
#       → deterministic scrub → DB aiSummary 0 hit（waId 後 8 位同樣 0 hit）
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
#   T27 (Phase 3) workforce mock sync（slot 落庫 + WorkforceSyncState heartbeat）+ Flow endpoint 3 步加密 round-trip
#       （provider 列表 / date 只回有空日 / time 只回空 slot / 壞 token 401）
#   T28 (Phase 3) 病人 Complete → BookingRequest PENDING + 綠色卡 + /bookings 見到
#   T29 (Phase 3) 〔已喺醫生系統落單〕→ CONFIRMED + AuditLog + 自動確認訊息（含日期時間）
#   T30 (Phase 3) race：兩病人同 slot 同時 Complete → 第二個被擋（precheck）+ 自動覆「滿咗」+ 重出 Flow
#   T31 (Phase 3) flow 中途棄 → 0 BookingRequest（無殭屍）
#   T32 (Phase 3) 48h 冇處理 → cron EXPIRED + AuditLog
#   T33 (Phase 3) PII：workforce contract strip（插 PII 欄 → zod 零洩露）+ L2 cache 零病人欄位 + log 0 hit + pii-scan 0 violation
#   T34 (Phase 3) 別店 flow_token 被拒 + STAFF 撳別店 booking confirm → 403
#   T35 (Phase 4) 健康自檢：inject 異常（webhook stale / queue depth / AI breaker / workforce_api_degraded）→ Alert
#       + ALERT_CHANNEL=log 見到 metadata-only 警報（0 PII）；恢復 → auto-resolved；
#       /api/admin/alerts（STAFF 403 / ADMIN 200）+ POST resolve（手動 resolved）
#   T35b (workforce 切換) 四層降級鏈 E2E（stale / throw / NONE / 恢復 / alert）→ pnpm e2e:workforce
#   T36 (Phase 4) quality_rating：mock GREEN 無警報 + Clinic.qualityRating/qualityCheckedAt 落庫；
#       WA_MOCK_QUALITY=RED inject → severity=HIGH 警報（被 ban 前哨）；恢復 → auto-resolved
#   T37 (Phase 4) 週報：fixture（4 conv/7 msg/4 draft/3 flow/3 booking）→ weekly-report script
#       → OpsReport 斷言（FRT 中位數 240s / 採用率 0.75 / Flow 2/3 / 預約 2/3 中位 60min）+ 冪等
#   T38 (Phase 4) duty-roster：mock fixture 3 人（HTTP 200 + /inbox 側欄「今日當值」卡）；
#       別店 scope 403；欄位白名單；DUTY_MOCK=0 + 無/壞 URL → 200 {duty:null} 唔 crash
#   T39 (Phase 4) backup/restore：backup-wa.sh 出 dump 檔（sandbox 無 age → NODE_ENV=development 明文軌
#       + 響亮 warning）；restore-wa-test.sh restore 落 scratch DB + 5 表 row count 全對
#
# 深度審查修補（runway 步驟 1）：
#   T40 (P0-1) claim 孤兒恢復：WebhookEvent 存在但無 Message（舊 code crash 狀態）→
#       重跑同一 wamid → 訊息補回唔丟 + 再重發冪等
#   T41 (P0-2) multi-patient history 批次逐條歸戶：2 病人各 3 條入各 conversation
#       + 1 條無法歸戶 → skip + Alert(history_skip) + log 警報行
#   T42 (P0-3) 停用即時生效：WTC 登入 + socket 已連 → admin 停用 → 下一 API request 即刻 401
#   T48 (C-3 尾批) password reset 踢 session：admin reset WTC password → 舊 cookie 下一 request 即刻 401
#       （session invalidated）+ 新密碼可登入 + 恢復原密碼俾下次 run
#       "account disabled" + 已連 socket 被斷；重啟 → 恢復 200
#   T43 (P1-1) media clinic scope：店 A staff 攞店 B 媒體 → 403；本店 → 200；無主檔 → 404
#   T44 (C-1b) media per-file AES-256-GCM：碟上密文（WA1|）/ serve 解密 roundtrip / dev 無 key 明文軌
#       / legacy 明文偵測 / production fail-fast（不可寫目錄 throw）/ production 無 key throw / 0700+0600 / tamper auth
#   T45 (C-2) backup 強制加密：production 無 age → FATAL exit 1 + fail flag（metadata only）→
#       health-check 轉 Alert(backup_failed, HIGH)；flag 清 → auto-resolve；backup dir 0700
#   T46 (H-3) summary deterministic scrub：完整名/部分名/waId 後 8 位/bait token → 病人/***
#   T47 (M-2) alert 出境 hard-gate：白名單（number/boolean/短字串）保留；超長/object/array drop；
#       weekly_report.text 特例 ≤4000
#
# 安全審計 Batch B（M1 小修組）：
#   T49 (AS-3③) mock mode 禁用 per-account lockout：5 次 fail 無 lockout/loginfail Redis key；
#       非 mock 路徑單元測（WA_MOCK=0 獨立 process）：第 5 次觸發 / TTL≤900 / NX 唔刷新 / email 變體 / 成功重計
#   T49b (L-2) search ILIKE escape：q=% 同 q=_ 當字面（0 hit）；control 正常 query 照中
#
# App Review 三件套（2026-08-20）：
#   T52 (App Review §1) privacy 公開頁：無 cookie 200 + `id="deletion"` anchor + 保留期 24/12 月 + 占位符 + 0 PII
#   T53 (App Review §2/§2A) onboarding/templates gating：STAFF 403 / unauth 307→/login / ADMIN 200 + mock 3 色 template
#   T54 (App Review §2.3) exchange mock flow：401/403/400(input)/404(db_update) + 完整 mock flow 寫入 clinic + AuditLog
#       + hermetic 還原 + token/code/PIN 零入 log（grep 自證）
#
# Phase H1（轉交 / Send Lock / 內部備註）：
#   T56 unassigned 首發 auto-claim（AuditLog AUTO_CLAIM + socket conversation:assigned）
#   T57 Send Lock：非負責人（含 ADMIN）send → 423 SEND_LOCKED；INTERNAL note 不受 lock
#   T58 跨店 RBAC：別店 staff send/note/assign → 403
#   T59 A→B 轉交（帶 note）+ 自動 INTERNAL note + AuditLog TRANSFER + socket
#   T60 lock 翻轉 + 被 lock 者照發 note + 新負責人可發 + 接手（self-claim）+ socket note:new
#   T61 放返隊列（unassign）+ 再 auto-claim
#   T62 Flow Send Lock（423）
#   T63 ★ 10 條 INTERNAL note → mock Graph 計數不變（物理隔離）+ unread 不變 + 無新 AiDraft
#   T64 socket/log 零內文（grep 自證）+ hermetic 清理（臨時 staff 刪除）
#
# Phase H2（已讀回執 / tick 語義 / @mention 通知）：
#   T65 read 冪等（重複 read 只 1 row）+ 非 note 400 / 唔存在 404 + 無 mention → assignee tick + socket note:read
#   T66 跨店 read / 攞 receipts → 403
#   T67 tick 兩態（mention B+C：半讀 false → 全讀 true）+ GET receipts
#   T68 notify:mention：被 @ 者實時收到；sender 0 收
#   T69 self-mention 唔通知自己
#   T70 mention 校驗：異店/唔存在 staff 靜默 drop
#   T71 unassigned + 無 mention → requiredStaff 空 → allRead 永遠 false
#   T72 423 Send Lock 回歸 + lock 唔阻 INTERNAL note
#   T73 ★ INTERNAL 0 graph 請求 / unread 不變 / 無新 AiDraft（回歸）
#   T74 socket/log 零內文 + hermetic 清理
#
# Realtime P0 chaos e2e（cwi-rt-20260823）：
#   T75 RT-IDEMPOTENT：同 clientMessageId 3 次 → 1 DB row（R1）
#   T76 RT-ORDER：20 對話 × 3 訊息壓測 → 每對話 DB 順序 = 發送順序（R4）
#   T77 RT-MEDIA：MEDIA_CHAOS_DELAY_MS=8000 → media 下載唔阻塞其他對話（R4 mediaQueue）
#   T78 RT-GRAPH-FAIL（Test H）：WA_GRAPH_MOCK_FAIL=1 → FAILED 無假 SENT
#   T79 RT-ASSIGN-RACE（Test G）：parallel assign → 1×200 + 1×409 + version+1（R5）
#   T80 RT-ROLLBACK（Test I）：PG trigger 強行 rollback → 0 socket event + 無 row（R2）
#   T81 RT-REDIS-RESTART（Test D）：SHUTDOWN NOSAVE → 2 條 inbound → delta refetch 補齊（R3，最後跑）
##
set -u
cd "$(dirname "$0")/.."

# ★ 平行 e2e 互殺防護：兩個 e2e 同時跑會 pkill 對方 server/worker + 搶同一 port/DB/Redis
#   → 雙邊失敗（429/500/socket 斷 — 已捉住過一次）。flock 排他：後到者直接退。
if ! exec 9>/tmp/e2e.lock; then echo "FATAL: 無法開 lock"; exit 1; fi
if ! flock -n 9; then
  echo "FATAL: 已有另一個 mock-e2e 行緊（/tmp/e2e.lock 被佔）— 等佢完先跑，唔好並行"
  exit 1
fi

# ── env ──────────────────────────────────────────────────────────────────
set -a
# shellcheck disable=SC1091
. ./.env
set +a

# 媒體目錄：sandbox 寫唔到 /srv/wa-media → 統一指 writable tmp dir
#（mock mode 本來唔下載媒體；T43 喺度手放 fixture 檔驗證 clinic scope）
export WA_MEDIA_DIR=/tmp/wa-media-e2e
mkdir -p "$WA_MEDIA_DIR"
# ★ C-1b e2e：server/worker 用同一把 key 寫/讀媒體（dev-only 固定值，唔係生產 secret）—
#   T43b 驗證「碟上密文（WA1|）/ serve 解密回原文」全 HTTP 環。
#   （若無 key，dev server 會 fallback 明文 + warning — 但 T43b 要斷言密文，所以必須有 key）
export MEDIA_ENC_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

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
# ★ hermetic AI 數據（H-3/M-5）：清上一 run 殘留 Conversation/Message/AiDraft/WebhookEvent —
#   persistent sandbox DB 跨 run 累積行；pii-scan 第 4 層（aiSummary × profileName 子串）
#   對舊命名慣例嘅殘留行會 false positive。seed 數據（clinic/staff/provider）唔受影響。
q "DELETE FROM \"AiDraft\"" >/dev/null 2>&1 || true
q "DELETE FROM \"Message\"" >/dev/null 2>&1 || true
q "DELETE FROM \"WebhookEvent\"" >/dev/null 2>&1 || true
q "DELETE FROM \"Conversation\"" >/dev/null 2>&1 || true
q "DELETE FROM \"Alert\" WHERE type='backup_failed'" >/dev/null 2>&1 || true  # T45 hermetic（persistent DB 累積舊行）
# 清晒上次 run 殘留嘅 BullMQ job — 舊 job 會被新 worker redeliver → 舊 EPOCH 數據
# 落咗新 run 嘅 DB 污染斷言（T41/T17 事故）
pnpm e2e:queue-clear >/dev/null 2>&1 || echo "  WARN: queue clear failed（繼續，留意 T17/T41）"
echo "  OK"
# ★ E2E sandbox 共享 Redis/DB/port 3100 — 清走上一 run 被 kill 時留低嘅 BullMQ job，
#   防止舊 EPOCH job redeliver 落新 run 污染斷言（E2E T41 捉住過）
pnpm e2e:queue-clear >/dev/null 2>&1 || echo "  warn: queue clear 失敗（唔阻 e2e）"

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
# H1 e2e 臨時 staff fixture（獨立 gitignored 檔 — seed 會覆寫 credentials.txt，所以用獨立檔）
H1_B_EMAIL=$(awk -F= '/^H1_B_EMAIL=/{print $2}' .dev/e2e-fixtures.txt)
H1B_PASS=$(awk -F= '/^H1_B_PASSWORD=/{print $2}' .dev/e2e-fixtures.txt)
[ -n "$TKW_EMAIL" ] && [ -n "$TKW_PASS" ] && [ -n "$ADMIN_EMAIL" ] && [ -n "$ADMIN_PASS" ] || { echo "FATAL: 讀唔到 credentials"; exit 1; }
[ -n "$H1_B_EMAIL" ] && [ -n "$H1B_PASS" ] || { echo "FATAL: 讀唔到 H1 e2e fixture（.dev/e2e-fixtures.txt）"; exit 1; }

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
# ★ 2026-08-21：清 .next dev cache — prod `pnpm build` 會覆寫 .next chunk layout，
#   之後 `next dev` lazy-compile 新 route 會撈 `Cannot find module './vendor-chunks/...'` →
#   500/404 間歇（real run 實遇：H2 read/receipts route 首 request 200、後續 500）。
rm -rf .next
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
  # 清 lock 檔（flock 嘅 lock 隨 process 消失，但檔會留低 — 用「檔在唔在」判斷嘅等待者會卡死）
  rm -f /tmp/e2e.lock
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
pnpm -s mock-inbound message --clinic TKW --from "$PATIENT_TKW" --text "e2e 第一則" --wamid "$IN_WAMID" --name "E2E-A-PLAIN" >/dev/null || fail "T3 mock-inbound message POST"
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
pnpm -s mock-inbound message --clinic TKW --from "$PATIENT_TKW" --text "e2e 重發" --wamid "$IN_WAMID" --name "E2E-A-PLAIN" >/dev/null || true
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
pnpm -s mock-inbound history --clinic TKW --from "$PATIENT_TKW" --count "$HIST_COUNT" --name "E2E-A-PLAIN" >/dev/null || fail "T6 mock-inbound history POST"
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
pnpm -s mock-inbound message --clinic MF --from "$PATIENT_MF" --text "mf msg" --name "E2E-A-MF" >/dev/null || true
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
pnpm -s mock-inbound message --clinic TKW --from "$PATIENT_AI1" --text "医生我牙好痛" --wamid "$WAMID_AI1" --name "E2E-A-URGENT" >/dev/null || fail "T13 mock-inbound POST"
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
pnpm -s mock-inbound message --clinic TKW --from "$PATIENT_AI2" --text "你好，我想預約下週" --wamid "$WAMID_AI2" --name "E2E-A-BOOKING" >/dev/null || fail "T14 mock-inbound POST"
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

# ── T14.5. H-3 summary 去識別化：bait（mock AI 回帶 profileName）→ scrub → DB 0 hit ──
echo "  T14.5: summary scrub bait..."
BAIT_NAME="E2E-BAIT-SUM-7f3a"   # 同 src/lib/ai/mock.ts E2E_BAIT_SUM_TOKEN（mock summary 固定含佢）
BAIT_PAT="8526009${EPOCH}1"
WAMID_BAIT="wamid.E2E_BAIT_${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$BAIT_PAT" --text "e2e bait 肚痛" --wamid "$WAMID_BAIT" --name "$BAIT_NAME" >/dev/null || fail "T14.5 mock-inbound POST"
if wait_for "SELECT (\"aiSummary\" IS NOT NULL)::text s FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$BAIT_PAT'" '[{"s":"true"}]' 30; then
  pass "T14.5 bait conversation aiSummary 已落庫"
else
  fail "T14.5 bait aiSummary 未落庫"
fi
BAIT_HIT=$(q "SELECT count(*)::text c FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$BAIT_PAT' AND c.\"aiSummary\" LIKE '%$BAIT_NAME%'" | jf c)
check "T14.5 summary scrub：profileName（bait token）DB 0 hit（deterministic scrub 生效）" "$BAIT_HIT" "0"
BAIT_WA8="${BAIT_PAT: -8}"
BAIT_WA_HIT=$(q "SELECT count(*)::text c FROM \"Conversation\" c WHERE c.\"aiSummary\" LIKE '%$BAIT_WA8%'" | jf c)
check "T14.5 summary scrub：waId 後 8 位 DB 0 hit" "$BAIT_WA_HIT" "0"

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
pnpm -s mock-inbound message --clinic TKW --from "$PATIENT_AI3" --text "你好，想問下埋門時間" --wamid "$WAMID_AI3A" --name "E2E-A-DEGRADED" >/dev/null || fail "T16a mock-inbound POST"
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
pnpm -s mock-inbound message --clinic TKW --from "$PATIENT_AI3" --text "再問一次時間" --wamid "$WAMID_AI3B" --name "E2E-A-DEGRADED" >/dev/null || fail "T16b mock-inbound POST"
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

# ══════════════ Phase 3：workforce 空檔（clinic-workforce External API）+ WhatsApp Flow 預約收集 ══════════════

echo "[11/11] T27: workforce mock sync + Flow endpoint 3 步 round-trip..."
rm -rf .dev/flow-keys
rm -f .dev/workforce-mock-fill.json .dev/workforce-mock-fail.json .dev/workforce-mock-stale.json

# 0) 觸發 workforce sync（cron 路徑：cronQueue → refreshAllClinics → getSlots 四層降級鏈；WORKFORCE_MOCK=1）
pnpm -s e2e:cron sync-availability >/dev/null 2>&1 || fail "T27 e2e:cron enqueue"
T27=0
if ! wait_for "SELECT (count(*) > 0)::text c FROM \"AvailabilitySlot\"" '[{"c":"true"}]' 90; then
  echo "    ❌ T27 AvailabilitySlot 冇 row"
  T27=1
fi
SSESYNC=$(q "SELECT (\"lastOkAt\" IS NOT NULL)::text s FROM \"WorkforceSyncState\" WHERE \"clinicId\"='$TKW_CLINIC_ID'" | jf s)
[ "$SSESYNC" = "true" ] || { echo "    ❌ T27 WorkforceSyncState.lastOkAt 冇 heartbeat"; T27=1; }

# 1) 新病人（BOOKING_REQUEST intent — 真實 flow 起點）+ staff 發 Flow
PATIENT_P3="8526031${EPOCH}"
WAMID_P3="wamid.E2E_P3_${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$PATIENT_P3" --text "你好，我想預約下週" --wamid "$WAMID_P3" --name "E2E-A-FLOW" >/dev/null || T27=1
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
# ★ 2026-08-21 midnight-boundary fix：加 syncWindow 下界（HKT 明日開始）— 同 endpoint 斷言 predicate
#   同義（isOpen + bookedCount=0 + syncWindow）。舊 bug：persistent DB 殘留前日 slot（已過期但
#   bookedCount=0）→ slot_query 撈到過期日 → endpoint（只回 window 內）斷言 mismatch + time 步 400。
slot_query() {
  q "SELECT s.\"date\" d, s.\"startTime\" t FROM \"AvailabilitySlot\" s WHERE s.\"clinicId\"='$TKW_CLINIC_ID' AND s.\"providerApricotId\"='$DOC_A' AND s.\"bookedCount\"=0 AND s.\"isOpen\" AND s.\"date\" >= ((date_trunc('day', (now() AT TIME ZONE 'Asia/Hong_Kong'))::date + 1)::text) AND NOT EXISTS (SELECT 1 FROM \"BookingRequest\" b WHERE b.\"providerApricotId\"=s.\"providerApricotId\" AND b.\"requestedDate\"=s.\"date\" AND b.\"requestedTime\"=s.\"startTime\" AND b.\"status\" IN ('PENDING','CONFIRMED')) $1 ORDER BY s.\"date\", s.\"startTime\" LIMIT 1"
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
# ★ 斷言 predicate 跟 endpoint 同義（isOpen + bookedCount=0 + syncWindow 窗口）— 舊喺
#   DB 嘅 PENDING/CONFIRMED booking（persistent DB 多輪累積）會令無過濾嘅 count 多计，
#   造成 26≠27 假 fail（2026-08-19 午夜邊界實遇；Batch B 修復）
HK_TODAY=$(TZ=Asia/Hong_Kong date +%F)
WIN_START=$(TZ=Asia/Hong_Kong date -d "$HK_TODAY + 1 day" +%F)
WIN_END=$(TZ=Asia/Hong_Kong date -d "$HK_TODAY + 30 day" +%F)
DBDATES=$(q "SELECT count(DISTINCT \"date\")::text c FROM \"AvailabilitySlot\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND \"providerApricotId\"='$DOC_A' AND \"isOpen\" AND \"bookedCount\"=0 AND \"date\">='$WIN_START' AND \"date\"<='$WIN_END'" | jf c)
[ -n "$DC_DATE" ] && [ "$DC_DATE" = "$DBDATES" ] || { echo "    ❌ T27 date 列表唔等於 DB 有空日集合（endpoint=$DC_DATE DB=$DBDATES）"; T27=1; }
step_flow "time" --clinic TKW --conv "$CONV_P3" --token "$TOKEN_P3" --action SCREEN_TIME --provider "$DOC_A" --date "$DATE_A"
case "${F_DATA:-}" in *"$TIME_A"*) : ;; *) echo "    ❌ T27 SCREEN_TIME 冇包含 $TIME_A（data=${F_DATA:0:200}）"; T27=1 ;; esac
step_flow "bad-token" --clinic TKW --conv "$CONV_P3" --token "$TOKEN_P3" --action SCREEN_PROVIDER --bad-token
case "$F_HTTP" in 401|400) : ;; *) echo "    ❌ T27 壞 token 唔係 401/400（HTTP=$F_HTTP）"; T27=1 ;; esac
[ "$T27" = 0 ] && pass "T27 workforce mock sync（slot 落庫 + heartbeat）+ Flow 3 步加密 round-trip（provider 3 人/date 過濾閉诊日/time 只空 slot/壞 token 401）" \
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

# ── T29. 〔已喺醫生系統落單〕→ CONFIRMED + AuditLog + 自動確認訊息 ─────────
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
WC=$(q "SELECT count(*)::text c FROM \"BookingRequest\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND \"providerApricotId\"='$DOC_A' AND \"requestedDate\"='$DATE_B' AND \"requestedTime\"='$TIME_B' AND \"createdAt\" > to_timestamp($EPOCH)" | jf c)
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
BOOK_WINNER=$(q "SELECT id FROM \"BookingRequest\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND \"providerApricotId\"='$DOC_A' AND \"requestedDate\"='$DATE_B' AND \"requestedTime\"='$TIME_B' AND \"createdAt\" > to_timestamp($EPOCH) ORDER BY \"createdAt\" DESC LIMIT 1" | jf id)
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

# ── T33. PII：workforce contract strip + L2 cache 零病人欄位 + log 0 hit ──
echo "[11/11] T33: PII scan..."
T33=0
# (1) contract script（零 DB）：fixture sha256 錨定 + parse 通過 + 插 PII 欄變體 strip + L2 row shape 白名單
CONTRACT_OUT=$(pnpm -s e2e:workforce-contract 2>&1)
echo "$CONTRACT_OUT" | tail -6
echo "$CONTRACT_OUT" | grep -q "WORKFORCE-CONTRACT OK" || { echo "    ❌ T33 workforce contract 斷言失敗"; T33=1; }
# (2) pii-scan（schema + contract-strip + DB data + log 層）
SCAN_OUT=$(pnpm -s pii-scan 2>&1)
echo "$SCAN_OUT" | tail -5
echo "$SCAN_OUT" | grep -q "PII-SCAN OK: 0 violations" || { echo "    ❌ T33 pii-scan 有 violation"; T33=1; }
# (3) log 零 PII（bait marker 防復發 — 來源已換 workforce，但鐵律不變）
LOGPII3=0
for kw in "MOCK_PII_PATIENT" "MOCK_PII_DIAGNOSIS" "MOCK_PII_REASON" "MOCK_PII_CREATOR" "85200000000" "clinicPatient" "visitReasons"; do
  if grep -qF "$kw" /tmp/e2e-server.log /tmp/e2e-worker.log /tmp/e2e-worker-fail.log /tmp/e2e-worker2.log 2>/dev/null; then
    echo "    ❌ PII bait in log: $kw"
    LOGPII3=1
  fi
done
[ "$LOGPII3" = 0 ] || T33=1
[ "$T33" = 0 ] && pass "T33 PII：contract strip（插 medicalHistory/clinicPatient/visitReasons → zod 零洩露）+ L2 cache 零病人欄位 + log 0 hit + pii-scan 0 violation" \
  || fail "T33 PII 鐵律（見上 ❌）"

# ══════════════ Phase 4：監控 + 營運硬化 ══════════════

# ── T35. 健康自檢：inject 異常 → Alert + metadata-only 通知；恢復 → auto-resolved ──
echo "[P4] T35: health-check..."
T35=0
# pre-clean：清舊 health alerts + 統一 webhook 時鐘（TKW = stale，其餘 fresh）+ workforce fresh
q "UPDATE \"Alert\" SET \"resolvedAt\" = now() WHERE \"resolvedAt\" IS NULL AND type IN ('webhook_stale','queue_depth','ai_breaker_open','workforce_api_degraded','disk_low')" >/dev/null
q "UPDATE \"WorkforceSyncState\" SET \"lastOkAt\" = now()" >/dev/null
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

# (2b) workforce_api_degraded：lastOkAt >15 分鐘 → MEDIUM alert；恢復 → auto-resolved
q "UPDATE \"WorkforceSyncState\" SET \"lastOkAt\" = now() - interval '20 minutes'" >/dev/null
pnpm -s e2e:cron health-check >/dev/null 2>&1 || T35=1
if wait_for "SELECT (SELECT count(*) FROM \"Alert\" WHERE \"resolvedAt\" IS NULL AND type='workforce_api_degraded')::text c" '[{"c":"1"}]' 30; then
  pass "T35 workforce_api_degraded：lastOkAt >15 分鐘 → MEDIUM alert"
else
  fail "T35 workforce_api_degraded alert 未開"
fi
WFSEV=$(q "SELECT \"severity\"::text s FROM \"Alert\" WHERE type='workforce_api_degraded' AND \"resolvedAt\" IS NULL" | jf s)
check "T35 workforce_api_degraded severity=MEDIUM" "$WFSEV" "MEDIUM"
q "UPDATE \"WorkforceSyncState\" SET \"lastOkAt\" = now()" >/dev/null
pnpm -s e2e:cron health-check >/dev/null 2>&1 || T35=1
if wait_for "SELECT (SELECT count(*) FROM \"Alert\" WHERE \"resolvedAt\" IS NULL AND type='workforce_api_degraded')::text c" '[{"c":"0"}]' 30; then
  pass "T35 workforce_api_degraded 恢復 → auto-resolved"
else
  fail "T35 workforce_api_degraded auto-resolve 失敗"
fi

# (2c) T35b：四層降級鏈 E2E（stale / throw→STALE_CACHE / NONE / 恢復 / alert）— workforce 切換 MD §4 新增
WF_E2E_OUT=$(pnpm -s e2e:workforce 2>&1)
echo "$WF_E2E_OUT" | tail -8
echo "$WF_E2E_OUT" | grep -q "E2E-WORKFORCE OK" || { echo "    ❌ T35b 四層降級鏈 E2E 失敗"; T35=1; }
[ "$T35" = 0 ] && pass "T35b 四層降級鏈 E2E（STALE_SOURCE / STALE_CACHE / NONE / 恢復 / alert）" \
  || fail "T35b 四層降級鏈 E2E（見上 ❌）"

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
BFAIL_FLAG="$(dirname "$BDIR")/backup-failed.flag"
rm -f "$BFAIL_FLAG"
# ★ C-2：sandbox 無 age — 顯式 NODE_ENV=development 行明文軌（production 會 FATAL，見 T45）
BOUT=$(NODE_ENV=development bash scripts/backup-wa.sh 2>&1)
echo "$BOUT" | tail -3
echo "$BOUT" | grep -q "\[backup\] DONE" || { echo "    ❌ T39 backup-wa.sh 冇 DONE"; T39=1; }
[ -f "$BFAIL_FLAG" ] && { echo "    ❌ T39 成功後仍有 fail flag（應由成功 backup 清咗）"; T39=1; }
BDMODE=$(stat -c '%a' "$BDIR" 2>/dev/null || echo "?")
[ "$BDMODE" = "700" ] || { echo "    ❌ T39 backup dir 唔係 0700（=$BDMODE）"; T39=1; }
DUMP=$(ls -1t "$BDIR"/wa-inbox-*.dump.age "$BDIR"/wa-inbox-*.dump 2>/dev/null | head -1)
[ -n "$DUMP" ] && [ -f "$DUMP" ] || { echo "    ❌ T39 dump 檔唔存在"; T39=1; }
if ! command -v age >/dev/null 2>&1; then
  echo "$BOUT" | grep -qi "age 未安裝" || { echo "    ❌ T39 無 age 但冇明文 warning"; T39=1; }
  case "$DUMP" in *.age) echo "    ❌ T39 無 age 却產出 .age 檔"; T39=1 ;; esac
fi
ROUT=$(bash scripts/restore-wa-test.sh 2>&1)
echo "$ROUT" | tail -7
echo "$ROUT" | grep -q "RESTORE-TEST OK" || { echo "    ❌ T39 restore 驗證失敗"; T39=1; }
[ "$T39" = 0 ] && pass "T39 backup（dump + 兩軌加密 + 0700 + retention）+ restore 落 scratch DB 5 表 row count 全對" \
  || fail "T39 backup/restore（見上 ❌）"

# ══════════════ 深度審查修補（runway 步驟 1）：T40-T43 ══════════════

# ── T40. claim 孤兒恢復（P0-1：claim 成功但 create 前 crash → 重跑補回） ─────────
echo "[P5] T40: claim orphan recovery..."
T40=0
ORPHAN_WAMID="wamid.E2E_ORPHAN_${EPOCH}"
ORPHAN_PAT="8526041${EPOCH}"
# 模擬舊 code crash 狀態：WebhookEvent（claim）存在，但 Message 從未寫入
q "INSERT INTO \"WebhookEvent\" (id, field) VALUES ('messages:$ORPHAN_WAMID', 'messages')" >/dev/null || T40=1
pnpm -s mock-inbound message --clinic TKW --from "$ORPHAN_PAT" --text "e2e orphan recovery" --wamid "$ORPHAN_WAMID" --name "E2E-A-ORPHAN" >/dev/null || T40=1
if wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"waMessageId\"='$ORPHAN_WAMID' AND direction='IN' AND channel='API'" '[{"c":"1"}]' 30; then
  pass "T40 claim 孤兒（有 WebhookEvent 無 Message）重跑 → 訊息補回唔丟"
else
  echo "    ❌ T40 claim 孤兒未補回（訊息永久丟失！）"
  T40=1
fi
# 冪等：再重發同一 wamid（而家有 Message）→ count 不變
sleep 1
pnpm -s mock-inbound message --clinic TKW --from "$ORPHAN_PAT" --text "e2e orphan 重發" --wamid "$ORPHAN_WAMID" --name "E2E-A-ORPHAN" >/dev/null || true
sleep 3
CNT40=$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"waMessageId\"='$ORPHAN_WAMID'" | jf c)
[ "$CNT40" = "1" ] || { echo "    ❌ T40 補回後重發 count != 1（=$CNT40）"; T40=1; }
[ "$T40" = 0 ] && pass "T40 孤兒補回後重發冪等（count 仍=1）" || fail "T40 孤兒冪等（見上 ❌）"

# ── T41. multi-patient history 逐條歸戶 + skip 警報（P0-2） ──────────────────────
echo "[P5] T41: multi-patient history attribution..."
T41=0
HP1="8526042${EPOCH}"
HP2="8526043${EPOCH}"
q "DELETE FROM \"Alert\" WHERE type='history_skip' AND \"clinicId\"='$TKW_CLINIC_ID'" >/dev/null
pnpm -s mock-inbound history --clinic TKW --from "$HP1" --from2 "$HP2" --name "E2E 歷史A" --name2 "E2E 歷史B" >/dev/null || T41=1
# 每個病人 3 條（2 IN + 1 OUT）各入各 conversation
if wait_for "SELECT (SELECT count(*) FROM \"Message\" m JOIN \"Conversation\" cv ON cv.id=m.\"conversationId\" JOIN \"Contact\" x ON x.id=cv.\"contactId\" WHERE x.\"waId\"='$HP1' AND m.channel='HISTORY')::text a, (SELECT count(*) FROM \"Message\" m JOIN \"Conversation\" cv ON cv.id=m.\"conversationId\" JOIN \"Contact\" x ON x.id=cv.\"contactId\" WHERE x.\"waId\"='$HP2' AND m.channel='HISTORY')::text b" '[{"a":"3","b":"3"}]' 60; then
  pass "T41 multi-patient 批次逐條歸戶（A=3 條 / B=3 條，各入各 conversation）"
else
  echo "    ❌ T41 逐條歸戶失敗（應 a=3 b=3）"
  # 診斷：逐 wamid 列出邊條缺席（metadata only — wamid 本身係 mock 值，無 PII）
  q "SELECT \"waMessageId\", direction FROM \"Message\" WHERE \"waMessageId\" LIKE 'wamid.HIST2_%' ORDER BY \"waMessageId\"" | head -12
  T41=1
fi
DIR41=$(q "SELECT (SELECT count(*) FROM \"Message\" m JOIN \"Conversation\" cv ON cv.id=m.\"conversationId\" JOIN \"Contact\" x ON x.id=cv.\"contactId\" WHERE x.\"waId\"='$HP1' AND m.channel='HISTORY' AND m.direction='IN')::text i1, (SELECT count(*) FROM \"Message\" m JOIN \"Conversation\" cv ON cv.id=m.\"conversationId\" JOIN \"Contact\" x ON x.id=cv.\"contactId\" WHERE x.\"waId\"='$HP1' AND m.channel='HISTORY' AND m.direction='OUT')::text o1, (SELECT count(*) FROM \"Message\" m JOIN \"Conversation\" cv ON cv.id=m.\"conversationId\" JOIN \"Contact\" x ON x.id=cv.\"contactId\" WHERE x.\"waId\"='$HP2' AND m.channel='HISTORY' AND m.direction='IN')::text i2, (SELECT count(*) FROM \"Message\" m JOIN \"Conversation\" cv ON cv.id=m.\"conversationId\" JOIN \"Contact\" x ON x.id=cv.\"contactId\" WHERE x.\"waId\"='$HP2' AND m.channel='HISTORY' AND m.direction='OUT')::text o2" | tr -d '\n')
check "T41 方向歸戶（A: 2IN+1OUT / B: 2IN+1OUT）" "$DIR41" '[{"i1":"2","o1":"1","i2":"2","o2":"1"}]'
U41=$(q "SELECT sum(\"unreadCount\")::text u FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\" IN ('$HP1','$HP2')" | jf u)
check "T41 history 唔觸發 unread（兩對話 total=0）" "$U41" "0"
# 無法歸戶 1 條 → skip + Alert(type=history_skip) + log 警報行（唔淨係 warn log）
SA=$(q "SELECT (\"detail\"->>'skipped')::text s FROM \"Alert\" WHERE type='history_skip' AND \"clinicId\"='$TKW_CLINIC_ID'" | jf s)
check "T41 無法歸戶 → Alert(history_skip) 開咗（detail.skipped=1）" "$SA" "1"
if grep -q "ALERT (channel=log): history_skip" /tmp/e2e-worker.log /tmp/e2e-worker-fail.log /tmp/e2e-worker2.log 2>/dev/null; then
  pass "T41 history_skip log 警報行（metadata only）"
else
  echo "    ❌ T41 worker log 搵唔到 history_skip 警報行"
  T41=1
fi

# ── T42. 停用即時生效（P0-3：API 401 + socket 斷線） ────────────────────────────
echo "[P5] T42: account disable immediate..."
T42=0
WTC_EMAIL=$(awk '/^WTC STAFF:/{print $3}' .dev/credentials.txt)
WTC_PASS=$(awk '/^WTC STAFF:/{split($0,a," / "); print a[2]}' .dev/credentials.txt)
[ -n "$WTC_EMAIL" ] && [ -n "$WTC_PASS" ] || { echo "    ❌ T42 WTC credentials 讀唔到"; T42=1; }
COOKIE_WTC=/tmp/e2e-cookie-wtc.txt
CODE=$(curl -s -o /dev/null -D /tmp/e2e-t42-login-headers.txt -w '%{http_code}' -c "$COOKIE_WTC" \
  -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$WTC_EMAIL\",\"password\":\"$WTC_PASS\"}")
check "T42 WTC login → 200" "$CODE" "200"
WTC_ID=$(q "SELECT id FROM \"StaffUser\" WHERE email='$WTC_EMAIL'" | jf id)
[ -n "$WTC_ID" ] || { echo "    ❌ T42 WTC staff id 搵唔到"; T42=1; }
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_WTC" "$BASE/api/conversations")
check "T42 停用前 WTC API → 200" "$CODE" "200"
# socket 先連住（停用前）
# 由 login response 嘅 Set-Cookie header 直接提 cookie 值（cookie jar awk 欄位位數唔穩）
WTC_SESSION=$(grep -i '^set-cookie:' /tmp/e2e-t42-login-headers.txt | grep -oE 'wa_inbox_session=[^;]+' | head -1 | cut -d= -f2-)
if [ -z "$WTC_SESSION" ]; then
  echo "    ❌ T42 cookie 提取失敗（login 响应冇 Set-Cookie wa_inbox_session）"
  T42=1
fi
rm -f /tmp/e2e-socket-t42.log
nohup pnpm -s e2e:socket --cookie "wa_inbox_session=$WTC_SESSION" --wait-ms 25000 >/tmp/e2e-socket-t42.log 2>&1 &
SOCK_PID=$!
SOCKUP=0
for i in $(seq 1 25); do grep -q "SOCKET-CONNECTED" /tmp/e2e-socket-t42.log 2>/dev/null && { SOCKUP=1; break; }; sleep 1; done
[ "$SOCKUP" = 1 ] || { echo "    ❌ T42 socket 未連上（$(tail -1 /tmp/e2e-socket-t42.log 2>/dev/null)）"; T42=1; }
# admin 停用
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_ADMIN" -X PUT \
  "$BASE/api/admin/staff/$WTC_ID" -H 'Content-Type: application/json' -d '{"active":false}')
check "T42 admin PUT active=false → 200" "$CODE" "200"
sleep 1
CODE=$(curl -s -o /tmp/e2e-t42-401.json -w '%{http_code}' -b "$COOKIE_WTC" "$BASE/api/conversations")
check "T42 停用後 WTC 下一 API request → 即時 401" "$CODE" "401"
ERR42=$(grep -oE '"error":"[^"]*"' /tmp/e2e-t42-401.json | head -1)
check "T42 401 reason = account disabled" "$ERR42" '"error":"account disabled"'
SOCKDOWN=0
for i in $(seq 1 15); do grep -q "SOCKET-DISCONNECTED" /tmp/e2e-socket-t42.log 2>/dev/null && { SOCKDOWN=1; break; }; sleep 1; done
if [ "$SOCKDOWN" = 1 ]; then
  pass "T42 已連 socket 被強制斷線（disconnectSockets）"
else
  echo "    ❌ T42 socket 未被斷線"
  T42=1
fi
# 重啟 → 恢復（cache 失效双向）
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_ADMIN" -X PUT \
  "$BASE/api/admin/staff/$WTC_ID" -H 'Content-Type: application/json' -d '{"active":true}')
check "T42 重啟帳號 → 200" "$CODE" "200"
sleep 1
# dev manifest flake retry（GET idempotent — 500 + flake 簽名 → 2s 後 retry ×1；真 500 唔 retry）
CODE=$(curl -s -o /tmp/e2e-t42-rec.json -w '%{http_code}' -b "$COOKIE_WTC" "$BASE/api/conversations")
if [ "$CODE" = "500" ] && grep -q "Unexpected end of JSON input" /tmp/e2e-t42-rec.json 2>/dev/null; then
  echo "    (dev manifest flake 500 → retry)"
  sleep 2
  CODE=$(curl -s -o /tmp/e2e-t42-rec.json -w '%{http_code}' -b "$COOKIE_WTC" "$BASE/api/conversations")
fi
check "T42 重啟後 WTC API → 200（恢復）" "$CODE" "200"
kill "$SOCK_PID" 2>/dev/null || true

# ── T48. C-3 尾批：password reset 踢 session（舊 cookie 即刻 401） ──────────────
echo "[P5] T48: password reset session kick..."
T48=0
# 重用 T42 嘅 WTC 登入狀態（COOKIE_WTC / WTC_ID / WTC_EMAIL / WTC_PASS）
NEW_PASS="E2E-Reset-${EPOCH}-pw"
CODE=$(curl -s -o /tmp/e2e-t48-reset.json -w '%{http_code}' -b "$COOKIE_ADMIN" -X PUT \
  "$BASE/api/admin/staff/$WTC_ID" -H 'Content-Type: application/json' -d "{\"newPassword\":\"$NEW_PASS\"}")
check "T48 admin reset WTC password → 200" "$CODE" "200"
grep -q '"passwordReset":true' /tmp/e2e-t48-reset.json 2>/dev/null || { echo "    ❌ T48 response 冇 passwordReset:true"; T48=1; }
sleep 1
CODE=$(curl -s -o /tmp/e2e-t48-old.json -w '%{http_code}' -b "$COOKIE_WTC" "$BASE/api/conversations")
check "T48 舊 session（舊 cookie）→ 即刻 401" "$CODE" "401"
ERR48=$(grep -oE '"error":"[^"]*"' /tmp/e2e-t48-old.json | head -1)
check "T48 401 reason = session invalidated" "$ERR48" '"error":"session invalidated"'
CODE=$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIE_WTC" \
  -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$WTC_EMAIL\",\"password\":\"$NEW_PASS\"}")
check "T48 新密碼登入 → 200" "$CODE" "200"
# dev manifest flake retry（GET idempotent — 同 T42；500 + flake 簽名 → retry ×1）
CODE=$(curl -s -o /tmp/e2e-t48-new.json -w '%{http_code}' -b "$COOKIE_WTC" "$BASE/api/conversations")
if [ "$CODE" = "500" ] && grep -q "Unexpected end of JSON input" /tmp/e2e-t48-new.json 2>/dev/null; then
  echo "    (dev manifest flake 500 → retry)"
  sleep 2
  CODE=$(curl -s -o /tmp/e2e-t48-new.json -w '%{http_code}' -b "$COOKIE_WTC" "$BASE/api/conversations")
fi
check "T48 新 session → 200" "$CODE" "200"
# 恢復原密碼（persistent sandbox DB — 下次 run T42 要用原密碼登入）
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_ADMIN" -X PUT \
  "$BASE/api/admin/staff/$WTC_ID" -H 'Content-Type: application/json' -d "{\"newPassword\":\"$WTC_PASS\"}")
check "T48 恢復原密碼 → 200" "$CODE" "200"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIE_WTC" \
  -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$WTC_EMAIL\",\"password\":\"$WTC_PASS\"}")
check "T48 恢復驗證：原密碼可登入" "$CODE" "200"
[ "$T48" = 0 ] && pass "T48 password reset 踢 session（舊 cookie 401 + 新密碼登入 + 已恢復原狀）" \
  || fail "T48 password reset kick（見上 ❌）"

# ── T43. media clinic scope（P1-1） ──────────────────────────────────────────────
echo "[P5] T43: media clinic scope..."
T43=0
MEDIA_PAT="8526044${EPOCH}"
MEDIA_WAMID="wamid.E2E_MEDIA_${EPOCH}"
MEDIA_FILE="${MEDIA_WAMID}.jpg"
pnpm -s mock-inbound message --clinic MF --from "$MEDIA_PAT" --text "e2e media" --wamid "$MEDIA_WAMID" --media image --name "E2E-A-MEDIA" >/dev/null || T43=1
wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"waMessageId\"='$MEDIA_WAMID'" '[{"c":"1"}]' 30 || { echo "    ❌ T43 media message 未入庫"; T43=1; }
# mock mode 唔下載 → 手放檔案 + 回填 mediaPath（等同真下載完成）
printf 'e2e-media-bytes' > "$WA_MEDIA_DIR/$MEDIA_FILE"
q "UPDATE \"Message\" SET \"mediaPath\"='$WA_MEDIA_DIR/$MEDIA_FILE' WHERE \"waMessageId\"='$MEDIA_WAMID'" >/dev/null
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_TKW" "$BASE/api/media/$MEDIA_FILE")
check "T43 店 A(TKW) staff 攞店 B(MF) 媒體 → 403" "$CODE" "403"
CODE=$(curl -s -D /tmp/e2e-t43-headers -o /tmp/e2e-t43-body -w '%{http_code}' -b "$COOKIE_MF" "$BASE/api/media/$MEDIA_FILE")
check "T43 店 B(MF) staff 攞自家媒體 → 200" "$CODE" "200"
BODY43=$(cat /tmp/e2e-t43-body 2>/dev/null)
check "T43 內容正確（mediaPath 反查 + 檔案讀取）" "$BODY43" "e2e-media-bytes"
# AS-4：nosniff + image/* → inline
grep -qi '^x-content-type-options: nosniff' /tmp/e2e-t43-headers && pass "T43 AS-4: nosniff header 存在" || fail "T43 AS-4: 無 X-Content-Type-Options: nosniff"
grep -qi '^content-disposition: inline;' /tmp/e2e-t43-headers && pass "T43 AS-4: image/* → inline" || fail "T43 AS-4: image 唔係 inline（$(grep -i '^content-disposition' /tmp/e2e-t43-headers | head -1)）"
# AS-4：.bin（application/octet-stream）→ attachment
BIN_WAMID="wamid.E2E_MEDIA_BIN_${EPOCH}"
BIN_FILE="${BIN_WAMID}.bin"
printf 'e2e-bin-bytes' > "$WA_MEDIA_DIR/$BIN_FILE"
pnpm -s mock-inbound message --clinic MF --from "$MEDIA_PAT" --text "e2e media bin" --wamid "$BIN_WAMID" --name "E2E-A-MEDIA" >/dev/null || T43=1
wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"waMessageId\"='$BIN_WAMID'" '[{"c":"1"}]' 30 || { echo "    ❌ T43 .bin message 未入庫"; T43=1; }
q "UPDATE \"Message\" SET \"mediaPath\"='$WA_MEDIA_DIR/$BIN_FILE' WHERE \"waMessageId\"='$BIN_WAMID'" >/dev/null
# dev server manifest race（同 T43b — webhook POST 觸發 recompile，首發可能 500）：重試 ×3
T43BIN_CODE=000
for i in 1 2 3; do
  T43BIN_CODE=$(curl -s -D /tmp/e2e-t43-bin-headers -o /tmp/e2e-t43-bin-body -w '%{http_code}' -b "$COOKIE_MF" "$BASE/api/media/$BIN_FILE")
  [ "$T43BIN_CODE" = "200" ] && break
  sleep 2
done
check "T43 .bin 本店 staff → 200（dev manifest race retry ×3）" "$T43BIN_CODE" "200"
grep -qi '^content-disposition: attachment;' /tmp/e2e-t43-bin-headers && pass "T43 AS-4: .bin（octet-stream）→ attachment" || fail "T43 AS-4: .bin 唔係 attachment（$(grep -i '^content-disposition' /tmp/e2e-t43-bin-headers | head -1)）"
grep -qi '^x-content-type-options: nosniff' /tmp/e2e-t43-bin-headers && pass "T43 AS-4: .bin 都有 nosniff" || fail "T43 AS-4: .bin 無 nosniff"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_TKW" "$BASE/api/media/$BIN_FILE")
check "T43 .bin 跨店（TKW）→ 403（H-4 scope 對非 image 類型一樣生效）" "$CODE" "403"
rm -f "$WA_MEDIA_DIR/$MEDIA_FILE" "$WA_MEDIA_DIR/$BIN_FILE" /tmp/e2e-t43-headers /tmp/e2e-t43-bin-headers
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_MF" "$BASE/api/media/wamid.E2E_NOOWNER_${EPOCH}.jpg")
check "T43 無主檔（無 Message 持有）→ 404" "$CODE" "404"
rm -f "$WA_MEDIA_DIR/$MEDIA_FILE"
[ "$T43" = 0 ] && pass "T43 media clinic scope 全鏈（跨店 403 / 本店 200 / 無主 404）" || fail "T43 media scope（見上 ❌）"

# ── T43b. C-1b 碟上密文 roundtrip（saveMediaFile 帶 key 寫 → 碟上 WA1| 密文 → serve 解密回原文） ──
echo "[P5] T43b: media on-disk ciphertext roundtrip..."
CT_PAT="8526045${EPOCH}"
CT_WAMID="wamid.E2E_MEDIA_ENC_${EPOCH}"
CT_FILE="${CT_WAMID}.jpg"
printf 'enc-secret-bytes-1234' > /tmp/e2e-enc-src.bin
pnpm -s e2e:media-write "$WA_MEDIA_DIR/$CT_FILE" /tmp/e2e-enc-src.bin >/dev/null || { echo "    ❌ T43b saveMediaFile 寫入失敗"; T43=1; }
MAGIC=$(head -c 3 "$WA_MEDIA_DIR/$CT_FILE" 2>/dev/null)
check "T43b 碟上係密文（WA1 magic prefix）" "$MAGIC" "WA1"
pnpm -s mock-inbound message --clinic MF --from "$CT_PAT" --text "e2e media enc" --wamid "$CT_WAMID" --name "E2E-A-MEDIA" >/dev/null || T43=1
wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"waMessageId\"='$CT_WAMID'" '[{"c":"1"}]' 30 || { echo "    ❌ T43b media message 未入庫"; T43=1; }
q "UPDATE \"Message\" SET \"mediaPath\"='$WA_MEDIA_DIR/$CT_FILE' WHERE \"waMessageId\"='$CT_WAMID'" >/dev/null
# ★ dev server manifest race 重試：呢一瞬間 dev server 可能正喺 recompile（webhook POST 觸發）—
#   第一發可能打到半寫入嘅 manifest（500 catchall）；2s 後重試即好（生產 build 無呢問題）
T43B_CODE=000
for i in 1 2 3; do
  T43B_CODE=$(curl -s -o /tmp/e2e-t43b-body -w '%{http_code}' -b "$COOKIE_MF" "$BASE/api/media/$CT_FILE")
  [ "$T43B_CODE" = "200" ] && break
  sleep 2
done
check "T43b 攞自家加密媒體 → 200（dev manifest race retry ×3）" "$T43B_CODE" "200"
check "T43b 碟上密文 / serve 原文（解密 roundtrip）" "$(cat /tmp/e2e-t43b-body 2>/dev/null)" "enc-secret-bytes-1234"
rm -f "$WA_MEDIA_DIR/$CT_FILE" /tmp/e2e-enc-src.bin
[ "$T43" = 0 ] && pass "T43b media 碟上密文 roundtrip（C-1b HTTP 層）" || fail "T43b media 密文 roundtrip（見上 ❌）"

# ── T44. media per-file AES-256-GCM（C-1b：碟上密文 / serve 透明解密 / fail-fast） ────────────────────
echo "[P5] T44: media per-file encryption..."
T44_OUT=$(pnpm -s e2e:media-enc 2>&1)
if echo "$T44_OUT" | grep -q "MEDIA-ENC OK"; then
  pass "T44 media 加密全鏈（碟上 WA1| 密文 + serve 解密 roundtrip + dev 明文軌 + legacy 偵測 + prod fail-fast + prod 無 key throw + 0700/0600 + tamper auth）"
else
  echo "$T44_OUT" | tail -20
  fail "T44 media 加密（見上）"
fi

# ── T45. C-2 backup 強制加密：production 無 age FATAL + fail flag → App Alert + auto-resolve ──
echo "[P5] T45: backup production FATAL + backup_failed alert..."
T45=0
BFAIL_FLAG2="$(dirname "${BACKUP_DIR:-.dev/backups}")/backup-failed.flag"
rm -f "$BFAIL_FLAG2"

# (1) production 模擬（受限 PATH — 冇 age，唔理系統有冇裝）→ FATAL exit 1 + flag（metadata only）
FAKEBIN=$(mktemp -d)
for _t in bash sh pg_dump psql tar date find du grep sed awk chmod mkdir rm cp ls cat echo tr dirname; do
  _p=$(command -v "$_t" 2>/dev/null) && ln -sf "$_p" "$FAKEBIN/$_t" || true
done
FOUT=$(env NODE_ENV=production PATH="$FAKEBIN" bash scripts/backup-wa.sh 2>&1); FRC=$?
rm -rf "$FAKEBIN"
if [ "$FRC" = 1 ] && echo "$FOUT" | grep -q "FATAL: production backup"; then
  pass "T45 production 無 age → FATAL exit 1（唔出產明文 backup）"
else
  echo "    ❌ T45 production 無 age 未 FATAL（rc=$FRC）"; echo "$FOUT" | tail -5; T45=1
fi
if [ -f "$BFAIL_FLAG2" ] && grep -q "reason=age_not_installed_production" "$BFAIL_FLAG2"; then
  pass "T45 fail flag 已寫（reason=age_not_installed_production，metadata only）"
else
  echo "    ❌ T45 fail flag 未寫 / reason 錯"; [ -f "$BFAIL_FLAG2" ] && cat "$BFAIL_FLAG2"; T45=1
fi

# (2) flag → App Alert（HIGH）— health-check 讀真 flag 檔（冪等：已有未解決 alert 唔重開）
q "UPDATE \"Alert\" SET \"resolvedAt\" = now() WHERE \"resolvedAt\" IS NULL AND type='backup_failed'" >/dev/null
pnpm -s e2e:cron health-check >/dev/null 2>&1 || T45=1
if wait_for "SELECT count(*)::text c FROM \"Alert\" WHERE type='backup_failed' AND \"resolvedAt\" IS NULL" '[{"c":"1"}]' 30; then
  pass "T45 backup fail flag → Alert(backup_failed) 開咗"
else
  fail "T45 backup_failed Alert 未開"
fi
BFS=$(q "SELECT \"severity\"::text s FROM \"Alert\" WHERE type='backup_failed' AND \"resolvedAt\" IS NULL" | jf s)
check "T45 backup_failed severity=HIGH" "$BFS" "HIGH"
BFR=$(q "SELECT (detail->>'reason')::text r FROM \"Alert\" WHERE type='backup_failed' AND \"resolvedAt\" IS NULL" | jf r)
check "T45 alert detail.reason = metadata token（零原文）" "$BFR" "age_not_installed_production"

# (3) flag 清（= 下次 backup 成功）→ auto-resolve
# ★ hermeticity：check「unresolved backup_failed = 0」而非「全行 resolved=true」—
#   persistent sandbox DB 會累積上一 run 嘅 resolved 舊行，按全行 match 會 flaky（[true,true]）
rm -f "$BFAIL_FLAG2"
pnpm -s e2e:cron health-check >/dev/null 2>&1 || T45=1
if wait_for "SELECT count(*)::text c FROM \"Alert\" WHERE type='backup_failed' AND \"resolvedAt\" IS NULL" '[{"c":"0"}]' 10; then
  pass "T45 flag 清後 backup_failed Alert auto-resolved"
else
  fail "T45 backup_failed auto-resolve"
fi
[ "$T45" = 0 ] && pass "T45 backup 強制加密（production FATAL + 0700 + fail flag → App alert 鏈）" \
  || fail "T45 backup C-2（見上 ❌）"

# ── T46. H-3 summary deterministic scrub（單元級） ──────────────────────────
echo "[P5] T46: ai summary scrub..."
T46_OUT=$(pnpm -s e2e:ai-scrub 2>&1)
if echo "$T46_OUT" | grep -q "AI-SCRUB OK"; then
  pass "T46 summary scrub（完整名/部分名/waId 後 8 位/bait token/收緊/唔誤傷）"
else
  echo "$T46_OUT" | tail -10
  fail "T46 summary scrub（見上）"
fi

# ── T47. M-2 alert 出境 hard-gate（單元級） ──────────────────────────────
echo "[P5] T47: alert detail gate..."
T47_OUT=$(pnpm -s e2e:alert-gate 2>&1)
if echo "$T47_OUT" | grep -q "ALERT-GATE OK"; then
  pass "T47 alert gate（白名單保留 + 超長/object/array drop + weekly text 特例 + notifyAlert 整合）"
else
  echo "$T47_OUT" | tail -10
  fail "T47 alert gate（見上）"
fi

# ── T49. AS-3③ mock mode 禁用 per-account lockout ─────────────────────────
echo "[BB-M1] T49: lockout disabled in mock mode..."
T49=0
NLOCK="e2e-nolock-${EPOCH}@wa-clinic.local"
for i in 1 2 3 4 5; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" \
    -H 'Content-Type: application/json' -d "{\"email\":\"$NLOCK\",\"password\":\"wrong-$i\"}")
  # dev-mode flake：route recompile 後首個 request 可能 500（module singleton 未 ready）— retry 一次（先例：T43b dev race retry）
  if [ "$CODE" = "500" ]; then sleep 1; CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$NLOCK\",\"password\":\"wrong-$i\"}"); fi
  # 401 = 正常認證失敗；429 = IP 限流（mock 下唯一 429 來源 — lockout 禁用）。兩者都唔係 lockout。
  case "$CODE" in 401|429) : ;; *) echo "    ❌ T49 mock mode: fail #$i HTTP=$CODE（預期 401/429）"; T49=1 ;; esac
done
LKEY=$(redis-cli EXISTS "lockout:$NLOCK" 2>/dev/null)
check "T49 mock mode: 5 次 fail 後無 lockout key（機制禁用）" "$LKEY" "0"
FKEY=$(redis-cli EXISTS "loginfail:$NLOCK" 2>/dev/null)
check "T49 mock mode: 無 loginfail 計數器" "$FKEY" "0"
[ "$T49" = 0 ] && pass "T49 mock mode lockout 禁用（5 fail 無 lockout 行為）" || fail "T49 mock no-lockout（見上 ❌）"
# 非 mock 路徑（獨立 process、WA_MOCK=0、真 Redis）— 閾值/NX/變體/重計 全鏈
LOCKOUT_OUT=$(WA_MOCK=0 pnpm -s e2e:lockout 2>&1)
if echo "$LOCKOUT_OUT" | grep -q "LOCKOUT OK"; then
  pass "T49b lockout 機制（非 mock 單元）：第 5 次觸發 + TTL≤900 + NX 唔刷新 + email 變體 + 成功重計"
else
  echo "$LOCKOUT_OUT" | tail -15
  fail "T49b lockout 機制（非 mock，見上）"
fi

# ── T49c. L-2 search ILIKE 通配符 escape ─────────────────────────────────
# q=% 同 q=_ 未 escape 會當 LIKE 通配符（% = 匹配全部）→ 全中；
# escape 後按字面匹配 — persistent sandbox DB 现况无 %/_ 字元入名稱/訊息體 → 0 hit。
S1N=$(curl -s -b "$COOKIE_TKW" "$BASE/api/search?type=contact&q=%25" | grep -o '"waId":"[^"]*"' | wc -l | tr -d ' ')
check "T49c contact q=%（通配符）→ 0 hit（字面匹配生效）" "$S1N" "0"
S2N=$(curl -s -b "$COOKIE_TKW" "$BASE/api/search?type=message&q=%25" | grep -o '"conversationId":"[^"]*"' | wc -l | tr -d ' ')
check "T49c message q=% → 0 hit" "$S2N" "0"
S3N=$(curl -s -b "$COOKIE_TKW" "$BASE/api/search?type=contact&q=%5F" | grep -o '"waId":"[^"]*"' | wc -l | tr -d ' ')
check "T49c contact q=_（單字元通配）→ 0 hit" "$S3N" "0"
S4N=$(curl -s -b "$COOKIE_TKW" "$BASE/api/search?type=contact&q=E2E-A" | grep -o '"waId":"[^"]*"' | wc -l | tr -d ' ')
[ "$S4N" -ge 1 ] && pass "T49c control：正常 query（E2E-A）照樣 hit（escape 唔誤傷）" || fail "T49c control query 無 hit"

# T49 嘅 5 連發 login 打满咗 IP 限流窗口（5/60s）— 等窗口清晒先俾後續 login-heavy 測試
#（TOTP / change-password）行，避免佢哋撞到殘留計數返 429。
sleep 61

# ── T50. H-2 ADMIN TOTP 全鏈（enroll → 2FA 登入 → STAFF 零影響 → 新 IP Alert）──────────────
echo "[BB-M3] T50: ADMIN TOTP..."
T50=0
ADMIN_ID=$(q "SELECT id FROM \"StaffUser\" WHERE email='$ADMIN_EMAIL'" | jf id)
[ -n "$ADMIN_ID" ] || { echo "    ❌ T50 admin id 搵唔到"; T50=1; }
# hermetic：清上一 run 殘留（persistent DB — 留低 totpSecretEnc 會鎖死下輪 T1c 登入；舊 alert 污染計數）
q "UPDATE \"StaffUser\" SET \"totpSecretEnc\" = NULL WHERE id='$ADMIN_ID'" >/dev/null
q "DELETE FROM \"Alert\" WHERE type='admin_new_ip_login'" >/dev/null 2>&1 || true
# (1) enroll（ADMIN cookie；secret 加密落 DB；response 只此一次）
ENR=$(curl -s -b "$COOKIE_ADMIN" -X POST "$BASE/api/admin/totp/enroll")
T50_SECRET=$(echo "$ENR" | grep -oE '"secret":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$T50_SECRET" ] || { echo "    ❌ T50 enroll response 冇 secret：$(echo "$ENR" | head -c 120)"; T50=1; }
DBENC=$(q "SELECT count(*)::text c FROM \"StaffUser\" WHERE id='$ADMIN_ID' AND \"totpSecretEnc\" IS NOT NULL" | jf c)
check "T50 enroll → DB totpSecretEnc 非 NULL（AES-256-GCM 密文落庫）" "$DBENC" "1"
if grep -qF "$T50_SECRET" /tmp/e2e-server.log 2>/dev/null; then
  echo "    ❌ T50 secret 出現在 server log（PII 鐵律違反）"; T50=1
else
  pass "T50 secret 未入 server log（只呈給 ADMIN 自己 DOM）"
fi
# (2) 啟用後登入唔帶 code → 401 + totpRequired（UI 第二步；唔計 lockout）
CODE=$(curl -s -o /tmp/e2e-t50-noc.txt -w '%{http_code}' -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}")
check "T50 啟用後登入唔帶 code → 401" "$CODE" "401"
grep -q '"totpRequired":true' /tmp/e2e-t50-noc.txt && pass "T50 401 帶 totpRequired:true（UI 第二步訊號）" || { echo "    ❌ T50 401 冇 totpRequired flag"; T50=1; }
# (3) 錯 code → 統一 401（唔洩露係錯定過期）
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\",\"totp\":\"000000\"}")
check "T50 錯 code → 401（統一，唔洩露細節）" "$CODE" "401"
# (4) 正確 code（同一部機同時脈 — totp-code.ts 現算，±1 window 必然 hit）→ 200
T50_CODE=$(pnpm -s e2e:totp-code "$T50_SECRET")
CODE=$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIE_ADMIN" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\",\"totp\":\"$T50_CODE\"}")
check "T50 正確 code → 200（2FA 通過）" "$CODE" "200"
# (5) STAFF 零影響（totpSecretEnc 恆 NULL → 登入流程完全唔變）
CODE=$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIE_MF" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$MF_EMAIL\",\"password\":\"$MF_PASS\"}")
check "T50 STAFF 登入零影響（唔使第二步）→ 200" "$CODE" "200"
# (6) 新 IP 登入 → Alert(admin_new_ip_login)（7 日窗口比較；metadata only 行 notifyAlert hard-gate）
#     ★ dev 環境註：Next 會將 socket IP 注入 XFF → clientIp 恆解析去本地 socket IP，
#       XFF header 模擬「新 IP」唔生效；改用清走 admin 7 日 LOGIN baseline →
#       本次登入嘅 IP 就係「從未見過」。生產（nginx $remote_addr 覆蓋）邏輯同一，只係 IP 源唔同。
q "DELETE FROM \"AuditLog\" WHERE \"staffId\"='$ADMIN_ID' AND action='LOGIN'" >/dev/null
# 雙保險：login 前再清一次該 type alert（抵受外部污染 — 例：手動清咗 LOGIN baseline 後
# 早期 T1c login 開咗 alert 留落嚟 → 計數會 >1）。正常 run 呢條 DELETE 係 no-op。
q "DELETE FROM \"Alert\" WHERE type='admin_new_ip_login'" >/dev/null 2>&1 || true
CODE=$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIE_ADMIN" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\",\"totp\":\"$(pnpm -s e2e:totp-code "$T50_SECRET")\"}")
check "T50 新 IP 登入 → 200" "$CODE" "200"
# 斷言用「有冇 create」而唔係「未解決」— health cron（*/5m）會 auto-resolve 佢唔管嘅
# 事件型 alert（admin_new_ip_login 唔喺 breach set）；hermetic setup 已清晒舊 row → count 恒 = 1
if wait_for "SELECT count(*)::text c FROM \"Alert\" WHERE type='admin_new_ip_login'" '[{"c":"1"}]' 15; then
  pass "T50 ADMIN 新 IP 登入 → Alert(admin_new_ip_login) 開咗"
else
  fail "T50 新 IP Alert 未開"
fi
LOGIN_IP=$(q "SELECT (\"meta\"->>'ip')::text ip FROM \"AuditLog\" WHERE \"staffId\"='$ADMIN_ID' AND action='LOGIN' ORDER BY \"createdAt\" DESC LIMIT 1" | jf ip)
AL_IP=$(q "SELECT (\"detail\"->>'ip')::text ip FROM \"Alert\" WHERE type='admin_new_ip_login' ORDER BY \"createdAt\" DESC LIMIT 1" | jf ip)
[ -n "$LOGIN_IP" ] && [ -n "$AL_IP" ] || { echo "    ❌ T50 LOGIN_IP/AL_IP 空（query 失敗？）LOGIN_IP='$LOGIN_IP' AL_IP='$AL_IP'"; T50=1; }
check "T50 alert detail.ip = LOGIN audit ip（metadata only，無其他 PII）" "$AL_IP" "$LOGIN_IP"
# (7) 清理：unset totp + 清 alert（persistent DB 衛生 — 下輪 T1c 要純登入）
q "UPDATE \"StaffUser\" SET \"totpSecretEnc\" = NULL WHERE id='$ADMIN_ID'" >/dev/null
q "DELETE FROM \"Alert\" WHERE type='admin_new_ip_login'" >/dev/null 2>&1 || true
[ "$T50" = 0 ] && pass "T50 H-2 ADMIN TOTP 全鏈（enroll/2FA/錯 code/STAFF 零影響/新 IP alert/secret 零 log）" \
  || fail "T50 TOTP（見上 ❌）"

# ── T51. M-4 change-password 踢全 session（C-3 loginAt cutoff 重用）+ TTL 單元 ──────────────────
echo "[BB-M4] T51: change-password + session TTL..."
T51=0
# IP 限流窗口（5/60s）：T50 已用咗 4 個 local login 計數 — 等窗口清晒，避免 T51 兩個 login 撞 429
sleep 61
# 重用 T42 嘅 WTC 狀態（COOKIE_WTC / WTC_ID / WTC_EMAIL / WTC_PASS — T48 尾已還原原密碼）
# (1) 舊密碼錯 → 401（統一，唔洩露邊個欄位）
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_WTC" -X POST "$BASE/api/auth/change-password" -H 'Content-Type: application/json' -d '{"oldPassword":"wrong-old-pw","newPassword":"NewPass-123!xyz"}')
check "T51 舊密碼錯 → 401" "$CODE" "401"
# (2) 正確 → 200 + relogin:true
T51_NEW="E2E-CP-${EPOCH}-pw"
CODE=$(curl -s -o /tmp/e2e-t51-cp.json -w '%{http_code}' -b "$COOKIE_WTC" -X POST "$BASE/api/auth/change-password" -H 'Content-Type: application/json' -d "{\"oldPassword\":\"$WTC_PASS\",\"newPassword\":\"$T51_NEW\"}")
check "T51 change-password → 200" "$CODE" "200"
grep -q '"relogin":true' /tmp/e2e-t51-cp.json && pass "T51 response 帶 relogin:true（前端提示重登）" || { echo "    ❌ T51 冇 relogin flag"; T51=1; }
sleep 1
# (3) 舊 session（同一 cookie）→ 即刻 401 session invalidated（C-3 cutoff 踢晒，包括當前）
CODE=$(curl -s -o /tmp/e2e-t51-old.json -w '%{http_code}' -b "$COOKIE_WTC" "$BASE/api/conversations")
check "T51 舊 session（同 cookie）→ 即刻 401" "$CODE" "401"
ERR51=$(grep -oE '"error":"[^"]*"' /tmp/e2e-t51-old.json | head -1)
check "T51 401 reason = session invalidated" "$ERR51" '"error":"session invalidated"'
# (4) 新密碼登入 → 200 + 新 session 可用
CODE=$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIE_WTC" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$WTC_EMAIL\",\"password\":\"$T51_NEW\"}")
check "T51 新密碼登入 → 200" "$CODE" "200"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_WTC" "$BASE/api/conversations")
check "T51 新 session → 200" "$CODE" "200"
# (5) 還原原密碼（persistent sandbox DB — 下輪 run 嘅 T42 要原密碼登入）
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_ADMIN" -X PUT "$BASE/api/admin/staff/$WTC_ID" -H 'Content-Type: application/json' -d "{\"newPassword\":\"$WTC_PASS\"}")
check "T51 還原原密碼 → 200" "$CODE" "200"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIE_WTC" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$WTC_EMAIL\",\"password\":\"$WTC_PASS\"}")
check "T51 還原驗證：原密碼可登入" "$CODE" "200"
# (6) TTL 單元（hermetic：monkey-patch Date.now — STAFF 24h / ADMIN 12h / fail-closed）
TTL_OUT=$(pnpm -s e2e:session-ttl 2>&1)
if echo "$TTL_OUT" | grep -q "SESSION-TTL OK"; then
  pass "T51 TTL 單元（STAFF 24h / ADMIN 12h 邊界 + fail-closed）"
else
  echo "$TTL_OUT" | tail -10
  fail "T51 TTL 單元（見上）"
fi
[ "$T51" = 0 ] && pass "T51 M-4 change-password 踢全 session（C-3 重用）+ TTL 邊界" \
  || fail "T51 change-password（見上 ❌）"

# ── T52. App Review §1：privacy 公開頁 ───────────────────────────────────────
echo "[AR-1] T52: privacy page..."
curl -s -o /tmp/e2e-privacy.html "$BASE/privacy"   # 無 cookie（公開頁）
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/privacy")
check "T52 privacy 無 cookie → 200" "$CODE" "200"
grep -q 'id="deletion"' /tmp/e2e-privacy.html && pass "T52 第 9 條 id=\"deletion\" anchor 喺 HTML" || fail "T52 缺 id=\"deletion\" anchor"
grep -q '24 個月' /tmp/e2e-privacy.html && pass "T52 保留期：對話 24 個月" || fail "T52 保留期對話 24 個月缺"
grep -q '12 個月' /tmp/e2e-privacy.html && pass "T52 保留期：媒體 12 個月" || fail "T52 保留期媒體 12 個月缺"
grep -q '\[公司名稱\]' /tmp/e2e-privacy.html && pass "T52 占位符保留（[公司名稱]）" || fail "T52 占位符缺"
if grep -qF "$ADMIN_EMAIL" /tmp/e2e-privacy.html || grep -qF "$PATIENT_TKW" /tmp/e2e-privacy.html; then
  fail "T52 PII：privacy 頁含 admin email / patient number"
else
  pass "T52 PII：privacy 頁 0 admin email / 0 patient number"
fi

# ── T53. App Review §2/§2A：onboarding + templates gating & mock 3 色 ──────────────
echo "[AR-2] T53: onboarding/templates gating..."
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_TKW" "$BASE/admin/onboarding")
check "T53 STAFF /admin/onboarding → 403" "$CODE" "403"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_TKW" "$BASE/admin/templates")
check "T53 STAFF /admin/templates → 403" "$CODE" "403"
LOC=$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/admin/onboarding")  # 無 cookie：layout redirect /login
case "$LOC" in *"/login") pass "T53 unauth /admin/onboarding → redirect /login" ;; *) fail "T53 unauth redirect 唔係 /login（actual=[$LOC]）" ;; esac
CODE=$(curl -s -o /tmp/e2e-onboarding.html -w '%{http_code}' -b "$COOKIE_ADMIN" "$BASE/admin/onboarding")
check "T53 ADMIN /admin/onboarding → 200" "$CODE" "200"
grep -q 'Embedded Signup' /tmp/e2e-onboarding.html && pass "T53 onboarding 頁內容（Embedded Signup）" || fail "T53 onboarding 頁內容缺"
CODE=$(curl -s -o /tmp/e2e-templates.html -w '%{http_code}' -b "$COOKIE_ADMIN" "$BASE/admin/templates")
check "T53 ADMIN /admin/templates → 200" "$CODE" "200"
T53_OK=1
for ST in APPROVED PENDING REJECTED; do
  grep -q "$ST" /tmp/e2e-templates.html || { T53_OK=0; echo "    ❌ templates 缺 $ST"; }
done
[ "$T53_OK" = 1 ] && pass "T53 mock 3 fixture 三色（APPROVED/PENDING/REJECTED）" || fail "T53 mock 3 色不完整"
for TM in appointment_reminder new_arrival_intro checkup_promo_january; do
  grep -q "$TM" /tmp/e2e-templates.html || fail "T53 mock fixture 名缺：$TM"
done

# ── T54. App Review §2.3：exchange mock flow + 零 log ─────────────────────────
echo "[AR-3] T54: exchange mock flow..."
CODE=$(curl -s -o /tmp/e2e-ex-nos.json -w '%{http_code}' -X POST "$BASE/api/admin/onboarding/exchange" -H 'Content-Type: application/json' -d '{"code":"e2e-code-nosession-0123456","clinicId":"x"}')
check "T54 無 session → 401" "$CODE" "401"
CODE=$(curl -s -o /tmp/e2e-ex-staff.json -w '%{http_code}' -b "$COOKIE_TKW" -X POST "$BASE/api/admin/onboarding/exchange" -H 'Content-Type: application/json' -d '{"code":"e2e-code-staff-012345678","clinicId":"x"}')
check "T54 STAFF → 403" "$CODE" "403"
# 每步 fail 回 {step,httpStatus,error}：input / db_update
CODE=$(curl -s -o /tmp/e2e-ex-noph.json -w '%{http_code}' -b "$COOKIE_ADMIN" -X POST "$BASE/api/admin/onboarding/exchange" -H 'Content-Type: application/json' -d '{"code":"e2e-code-nophn-012345678","clinicId":"'$TKW_CLINIC_ID'"}')
check "T54 無 phoneNumberId → 400" "$CODE" "400"
grep -q '"step":"input"' /tmp/e2e-ex-noph.json && pass "T54 fail 帶 step=input" || fail "T54 fail 無 step 欄位"
CODE=$(curl -s -o /tmp/e2e-ex-nopin.json -w '%{http_code}' -b "$COOKIE_ADMIN" -X POST "$BASE/api/admin/onboarding/exchange" -H 'Content-Type: application/json' -d '{"code":"e2e-code-nopin-012345678","clinicId":"'$TKW_CLINIC_ID'","phoneNumberId":"e2e-phn-1"}')
check "T54 無 pin → 400" "$CODE" "400"
grep -q '"step":"input"' /tmp/e2e-ex-nopin.json && pass "T54 無 pin step=input" || fail "T54 無 pin step 欄位錯"
CODE=$(curl -s -o /tmp/e2e-ex-badclinic.json -w '%{http_code}' -b "$COOKIE_ADMIN" -X POST "$BASE/api/admin/onboarding/exchange" -H 'Content-Type: application/json' -d '{"code":"e2e-code-badcl-012345678","clinicId":"e2e-nonexistent-clinic","phoneNumberId":"e2e-phn-2","pin":"112233"}')
check "T54 clinic 唔存在 → 404" "$CODE" "404"
grep -q '"step":"db_update"' /tmp/e2e-ex-badclinic.json && pass "T54 clinic 唔存在 step=db_update" || fail "T54 db_update step 欄位錯"

# 完整 mock flow（happy path）— hermetic：save → mutate → restore + 清 AuditLog
T54_ORIG_PHN=$(q "SELECT \"waPhoneNumberId\" FROM \"Clinic\" WHERE id='$TKW_CLINIC_ID'" | jf waPhoneNumberId)
EX_CODE="e2e-code-${EPOCH}-x1"
EX_PHN="e2e-phn-${EPOCH}"
EX_WABA="e2e-waba-${EPOCH}"
CODE=$(curl -s -o /tmp/e2e-ex-ok.json -w '%{http_code}' -b "$COOKIE_ADMIN" -X POST "$BASE/api/admin/onboarding/exchange" -H 'Content-Type: application/json' -d '{"code":"'$EX_CODE'","clinicId":"'$TKW_CLINIC_ID'","phoneNumberId":"'$EX_PHN'","wabaId":"'$EX_WABA'","pin":"112233"}')
check "T54 mock 完整 flow → 200" "$CODE" "200"
grep -q '"clinicCode":"TKW"' /tmp/e2e-ex-ok.json && pass "T54 response clinicCode=TKW" || fail "T54 response clinicCode 錯"
grep -qF "$EX_PHN" /tmp/e2e-ex-ok.json && pass "T54 response 帶回 phoneNumberId" || fail "T54 response 缺 phoneNumberId"
NOW_PHN=$(q "SELECT \"waPhoneNumberId\" FROM \"Clinic\" WHERE id='$TKW_CLINIC_ID'" | jf waPhoneNumberId)
check "T54 DB：TKW.waPhoneNumberId 已寫入" "$NOW_PHN" "$EX_PHN"
AUD_CNT=$(q "SELECT count(*)::text n FROM \"AuditLog\" WHERE action='ES_ONBOARD' AND \"entityId\"='$TKW_CLINIC_ID'" | jf n)
check "T54 AuditLog ES_ONBOARD = 1" "$AUD_CNT" "1"
# hermetic 還原：waPhoneNumberId 還原 + 清審計行
q "UPDATE \"Clinic\" SET \"waPhoneNumberId\"='$T54_ORIG_PHN' WHERE id='$TKW_CLINIC_ID'" >/dev/null 2>&1 || true
q "DELETE FROM \"AuditLog\" WHERE action='ES_ONBOARD' AND \"entityId\"='$TKW_CLINIC_ID'" >/dev/null 2>&1 || true
RESTORED=$(q "SELECT \"waPhoneNumberId\" FROM \"Clinic\" WHERE id='$TKW_CLINIC_ID'" | jf waPhoneNumberId)
check "T54 hermetic：waPhoneNumberId 已還原" "$RESTORED" "$T54_ORIG_PHN"
AUD_AFTER=$(q "SELECT count(*)::text n FROM \"AuditLog\" WHERE action='ES_ONBOARD' AND \"entityId\"='$TKW_CLINIC_ID'" | jf n)
check "T54 hermetic：ES_ONBOARD 審計已清" "$AUD_AFTER" "0"
# ★ token/code/PIN 零入 log（grep 自證）
if grep -qF "$EX_CODE" /tmp/e2e-server.log 2>/dev/null; then fail "T54 PII：auth code 入咗 server log"; else pass "T54 auth code 零入 log"; fi
if grep -q "mock-oat-" /tmp/e2e-server.log 2>/dev/null; then fail "T54 PII：mock access token 入咗 server log"; else pass "T54 mock access token 零入 log"; fi
if grep -qF "112233" /tmp/e2e-server.log 2>/dev/null; then fail "T54 PII：PIN 入咗 server log"; else pass "T54 PIN 零入 log"; fi
if grep -qF "$EX_CODE" /tmp/e2e-ex-ok.json 2>/dev/null; then fail "T54 PII：auth code 入咗 response"; else pass "T54 auth code 唔喺 response"; fi

# ── T55+. H1：轉交 / Send Lock / 內部備註（Phase H1） ─────────────────────────
# 鐵律實測（MD §7-H1）：
#   T56 unassigned 首發 auto-claim（AuditLog AUTO_CLAIM + socket）
#   T57 Send Lock：非負責人（含 ADMIN）send → 423 SEND_LOCKED；INTERNAL note 不受 lock
#   T58 跨店 RBAC：別店 staff send/note/assign → 403
#   T59 A→B 轉交（帶 note）：assignee 翻轉 + 自動 INTERNAL note + AuditLog TRANSFER + socket
#   T60 lock 翻轉：原負責人被 lock；其 note 照發；新負責人可發；接手（self-claim）+ B 被 lock
#   T61 放返隊列 + 再 claim
#   T62 Flow Send Lock（423）
#   T63 ★ 10 條 INTERNAL note → mock Graph 請求計數不變（物理隔離）+ unread 不變 + 無新 AiDraft
#   T64 socket/log 零內文（grep 自證）+ hermetic 清理
# H1_B_EMAIL / H1B_PASS 由頂部 .dev/e2e-fixtures.txt 提供（seed 唔會覆寫呢個檔）
H1_PAT="8526010${EPOCH}"
H1_WAMID="wamid.E2E_H1_${EPOCH}"
SOCK_LOG=/tmp/e2e-socket-h1.log
: > "$SOCK_LOG"
H1=0

# socket helper：等 $SOCK_LOG 同時出現所有 pattern（最多 N 秒）
wait_event() { # wait_event <max-sec> <pattern1> [pattern2 ...]
  local max="$1"; shift
  local i=0 ok=1 pat
  while [ "$i" -lt "$max" ]; do
    ok=1
    for pat in "$@"; do grep -qF "$pat" "$SOCK_LOG" 2>/dev/null || { ok=0; break; }; done
    [ "$ok" = 1 ] && return 0
    sleep 1; i=$((i + 1))
  done
  return 1
}
graph_count() { local n; n=$(grep -c "graph: send text (MOCK)" /tmp/e2e-worker.log 2>/dev/null); echo "${n:-0}"; }

echo "[H1] H1: handoff / send lock / internal notes..."
# ★ dev-mode pre-compile：warm up H1 routes — Next dev 首訪即編譯；快速串行打多 route 會令
#   並行 webpack compilation 搶寫 app manifest → loadManifest JSON.parse 空檔 → 500
#   （非 app bug；用 dummy request 順向編譯完先跑快速斷言序列）
for _WARM in "/api/conversations/warmup-h1/assign" "/api/conversations/warmup-h1/notes" "/api/conversations/warmup-h1/flows" "/api/messages/send"; do
  curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_TKW" -X POST "$BASE$_WARM" \
    -H 'Content-Type: application/json' -d '{}' >/dev/null 2>&1 || true
done
sleep 1
# (1) 臨時第二個 staff（TKW 同店）— hermetic：run 完即刪
STAFF_OUT=$(pnpm -s e2e:staff create --clinic TKW --email "$H1_B_EMAIL" --name "E2E H1 Staff B" 2>/dev/null || true)
H1_B_ID=$(echo "$STAFF_OUT" | grep -oE 'STAFF_ID=[a-z0-9]+' | head -1 | cut -d= -f2)
[ -n "$H1_B_ID" ] || { echo "    ❌ H1 臨時 staff 建立失敗"; H1=1; }

# (2) H1_B 登入（fixture 密碼由 gitignored .dev/credentials.txt 提供 — 帳戶只存在 persistent sandbox，run 完即刪）
CODE=$(curl -s -o /dev/null -D /tmp/e2e-h1b-login-headers.txt -w '%{http_code}' -c /tmp/e2e-cookie-h1b.txt \
  -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$H1_B_EMAIL\",\"password\":\"$H1B_PASS\"}")
check "H1-0 臨時 staff B 登入 → 200" "$CODE" "200"
COOKIE_H1B=/tmp/e2e-cookie-h1b.txt
H1B_SESSION=$(grep -i '^set-cookie:' /tmp/e2e-h1b-login-headers.txt 2>/dev/null | grep -oE 'wa_inbox_session=[^;]+' | head -1 | cut -d= -f2-)
TKW_STAFF_ID=$(q "SELECT id::text id FROM \"StaffUser\" WHERE email='$TKW_EMAIL'" | jf id)

# (3) H1 病人 inbound → 新建對話
pnpm -s mock-inbound message --clinic TKW --from "$H1_PAT" --text "e2e H1 handoff 測試" --wamid "$H1_WAMID" --name "E2E H1 Patient" >/dev/null || H1=1
H1_CONV=""
for i in $(seq 1 30); do
  H1_CONV=$(q "SELECT c.id::text id FROM \"Message\" m JOIN \"Conversation\" c ON c.id=m.\"conversationId\" WHERE m.\"waMessageId\"='$H1_WAMID'" | jf id)
  [ -n "$H1_CONV" ] && break
  sleep 1
done
[ -n "$H1_CONV" ] || { echo "    ❌ H1 對話未建立"; H1=1; }

# (4) H1_B 開 socket 監聽（驗證 conversation:assigned / note:new 實時收到）
if [ -n "$H1B_SESSION" ]; then
  nohup pnpm -s e2e:socket-events --cookie "wa_inbox_session=$H1B_SESSION" --wait-ms 180000 >"$SOCK_LOG" 2>&1 &
  SOCK_PID=$!
  SOCKUP=0
  for i in $(seq 1 25); do grep -q "SOCKET-CONNECTED" "$SOCK_LOG" 2>/dev/null && { SOCKUP=1; break; }; sleep 1; done
  [ "$SOCKUP" = 1 ] || { echo "    ❌ H1 socket listener 未連上（$(tail -1 "$SOCK_LOG" 2>/dev/null)）"; H1=1; }
else
  echo "    ❌ H1 B session cookie 撈唔到"; H1=1
fi

# ── H1 API helper：dev-mode manifest flake 防護 ──────────────────────────
# Next dev 每個 request 後會 re-emit app manifest（webpack 318-module rebuild）；
# 高速串行 request 會令下一個 request 讀到寫緊嘅 manifest → loadManifest JSON.parse
# 失敗 → 500（route handler 未執行 → 零副作用）。防護：
#   (1) request 之間 sleep 1（俾 re-emit 寫完）
#   (2) 偵測到 flake 簽名（error HTML 含 "Unexpected end of JSON input"）→ 2s 後 retry ×1
#   真 500（JSON {"error":"internal error"}）唔會 match 簽名 → 照 FAIL，唔會遮漏。
h1_req() { # h1_req <cookie> <method> <url> [json-body] → $H1_CODE / $H1_OUT
  local cookie="$1" method="$2" url="$3" body="${4:-}"
  local code out attempt=0
  out=$(mktemp /tmp/e2e-h1-api.XXXXXX)
  while [ "$attempt" -lt 2 ]; do
    if [ -n "$body" ]; then
      code=$(curl -s -o "$out" -w '%{http_code}' -b "$cookie" -X "$method" "$url" \
        -H 'Content-Type: application/json' -d "$body")
    else
      code=$(curl -s -o "$out" -w '%{http_code}' -b "$cookie" -X "$method" "$url")
    fi
    if [ "$code" = "500" ] && [ "$attempt" = "0" ] && grep -q "Unexpected end of JSON input" "$out" 2>/dev/null; then
      echo "    (dev manifest flake 500 → retry: ${method} ${url##*/})"
      rm -f "$out"
      sleep 2
      attempt=1
      continue
    fi
    break
  done
  sleep 1
  H1_CODE=$code
  H1_OUT=$out
}

# ── T56. unassigned 首發 → auto-claim ──────────────────────────────────
h1_req "$COOKIE_TKW" POST "$BASE/api/messages/send" "{\"conversationId\":\"$H1_CONV\",\"body\":\"e2e H1 A 首發\"}"
check "T56 A 首發（unassigned）→ 202" "$H1_CODE" "202"
H1_MSG1=$(grep -oE '"messageId":"[^"]*"' "$H1_OUT" | head -1 | cut -d'"' -f4)
wait_for "SELECT \"status\"::text c FROM \"Message\" WHERE id='$H1_MSG1'" '[{"c":"SENT"}]' 30 || { echo "    ❌ T56 訊息未 SENT"; H1=1; }
check "T56 auto-claim：assignee = A（TKW staff）" "$(q "SELECT \"assigneeId\"::text a FROM \"Conversation\" WHERE id='$H1_CONV'" | jf a)" "$TKW_STAFF_ID"
check "T56 assignedAt 已寫" "$(q "SELECT (\"assignedAt\" IS NOT NULL)::text n FROM \"Conversation\" WHERE id='$H1_CONV'" | jf n)" "true"
check "T56 AuditLog AUTO_CLAIM = 1" "$(q "SELECT count(*)::text n FROM \"AuditLog\" WHERE action='AUTO_CLAIM' AND \"entityId\"='$H1_CONV'" | jf n)" "1"
wait_event 10 "SOCKET-EVENT conversation:assigned" "$H1_CONV" "$TKW_STAFF_ID" \
  && pass "T56 socket conversation:assigned（auto-claim，B 實時收到）" || { fail "T56 socket conversation:assigned 未收到"; H1=1; }

# ── T57. Send Lock：非負責人（含 ADMIN）→ 423；note 不受 lock ──────────────
h1_req "$COOKIE_ADMIN" POST "$BASE/api/messages/send" "{\"conversationId\":\"$H1_CONV\",\"body\":\"e2e H1 admin 被 lock\"}"
check "T57 ADMIN（非負責人）send → 423" "$H1_CODE" "423"
grep -q '"error":"SEND_LOCKED"' "$H1_OUT" && pass "T57 423 body = SEND_LOCKED" || { fail "T57 423 body 錯"; H1=1; }
h1_req "$COOKIE_H1B" POST "$BASE/api/messages/send" "{\"conversationId\":\"$H1_CONV\",\"body\":\"e2e H1 B 被 lock\"}"
check "T57 同店 staff B（非負責人）send → 423" "$H1_CODE" "423"
h1_req "$COOKIE_H1B" POST "$BASE/api/conversations/$H1_CONV/notes" '{"body":"e2e H1 B locked 時內部備註"}'
check "T57 lock 唔影響 INTERNAL note（B）→ 201" "$H1_CODE" "201"
h1_req "$COOKIE_ADMIN" POST "$BASE/api/conversations/$H1_CONV/notes" '{"body":"e2e H1 admin 內部備註"}'
check "T57 lock 唔影響 INTERNAL note（ADMIN）→ 201" "$H1_CODE" "201"

# ── T58. 跨店 RBAC：別店 staff → 403 ──────────────────────────────────
h1_req "$COOKIE_MF" POST "$BASE/api/messages/send" "{\"conversationId\":\"$H1_CONV\",\"body\":\"e2e H1 跨店 send\"}"
check "T58 別店（MF）send 本店對話 → 403" "$H1_CODE" "403"
h1_req "$COOKIE_MF" POST "$BASE/api/conversations/$H1_CONV/notes" '{"body":"e2e H1 跨店 note"}'
check "T58 別店（MF）note 本店對話 → 403" "$H1_CODE" "403"
h1_req "$COOKIE_MF" POST "$BASE/api/conversations/$H1_CONV/assign" "{\"toStaffId\":\"$H1_B_ID\"}"
check "T58 別店（MF）assign 本店對話 → 403" "$H1_CODE" "403"

# ── T59. A→B 轉交（帶 note）+ socket ──────────────────────────────────
CA_N=$(grep -c "SOCKET-EVENT conversation:assigned" "$SOCK_LOG" 2>/dev/null); CA_N=${CA_N:-0}
H1_TRANSFER_NOTE="e2e H1 轉交原因：跟進中"
h1_req "$COOKIE_TKW" POST "$BASE/api/conversations/$H1_CONV/assign" "{\"toStaffId\":\"$H1_B_ID\",\"note\":\"$H1_TRANSFER_NOTE\"}"
check "T59 A→B 轉交 → 200" "$H1_CODE" "200"
grep -qF "\"assigneeId\":\"$H1_B_ID\"" "$H1_OUT" && pass "T59 response assigneeId=B" || { fail "T59 response assigneeId 錯"; H1=1; }
H1_XNOTE=$(grep -oE '"noteMessageId":"[^"]*"' "$H1_OUT" | head -1 | cut -d'"' -f4)
check "T59 自動 INTERNAL note：channel=INTERNAL" "$(q "SELECT \"channel\"::text c FROM \"Message\" WHERE id='$H1_XNOTE'" | jf c)" "INTERNAL"
check "T59 自動 note 內容 = 轉交留言" "$(q "SELECT \"body\"::text b FROM \"Message\" WHERE id='$H1_XNOTE'" | jf b)" "$H1_TRANSFER_NOTE"
check "T59 自動 note mentions 含 B" "$(q "SELECT \"mentions\"[1] m FROM \"Message\" WHERE id='$H1_XNOTE'" | jf m)" "$H1_B_ID"
check "T59 AuditLog TRANSFER = 1" "$(q "SELECT count(*)::text n FROM \"AuditLog\" WHERE action='TRANSFER' AND \"entityId\"='$H1_CONV'" | jf n)" "1"
check "T59 轉交後 assignee = B" "$(q "SELECT \"assigneeId\"::text a FROM \"Conversation\" WHERE id='$H1_CONV'" | jf a)" "$H1_B_ID"
wait_event 15 "SOCKET-EVENT conversation:assigned" "$H1_B_ID" \
  && [ "$(grep -c "SOCKET-EVENT conversation:assigned" "$SOCK_LOG" 2>/dev/null)" = "$((CA_N+1))" ] \
  && pass "T59 socket conversation:assigned（轉交，B 實時收到）" || { fail "T59 socket conversation:assigned 未收到"; H1=1; }

# ── T60. lock 翻轉 + note + 接手（self-claim） ───────────────────────────
h1_req "$COOKIE_TKW" POST "$BASE/api/messages/send" "{\"conversationId\":\"$H1_CONV\",\"body\":\"e2e H1 A 轉交後被 lock\"}"
check "T60 轉交後 A send → 423（lock 翻轉）" "$H1_CODE" "423"
NOTE_N0=$(grep -c "SOCKET-EVENT note:new" "$SOCK_LOG" 2>/dev/null); NOTE_N0=${NOTE_N0:-0}
h1_req "$COOKIE_TKW" POST "$BASE/api/conversations/$H1_CONV/notes" "{\"body\":\"e2e H1 A 留低備註\",\"mentions\":[\"$H1_B_ID\"]}"
check "T60 A（被 lock）發 INTERNAL note → 201" "$H1_CODE" "201"
H1_NOTE1=$(grep -oE '"messageId":"[^"]*"' "$H1_OUT" | head -1 | cut -d'"' -f4)
check "T60 note：waMessageId = NULL（唔出 Graph）" "$(q "SELECT (\"waMessageId\" IS NULL)::text n FROM \"Message\" WHERE id='$H1_NOTE1'" | jf n)" "true"
check "T60 note：mentions[0] = B" "$(q "SELECT \"mentions\"[1] m FROM \"Message\" WHERE id='$H1_NOTE1'" | jf m)" "$H1_B_ID"
for i in $(seq 1 15); do
  [ "$(grep -c "SOCKET-EVENT note:new" "$SOCK_LOG" 2>/dev/null)" = "$((NOTE_N0+1))" ] && break
  sleep 1
done
check "T60 socket note:new（B 實時收到）" "$(grep -c "SOCKET-EVENT note:new" "$SOCK_LOG" 2>/dev/null)" "$((NOTE_N0+1))"
h1_req "$COOKIE_H1B" POST "$BASE/api/messages/send" "{\"conversationId\":\"$H1_CONV\",\"body\":\"e2e H1 B 轉交後可發\"}"
check "T60 B（新負責人）send → 202" "$H1_CODE" "202"
# 接手（MD §7 驗收項 3）：B 負責中，A 撳〔接手〕（self-claim）→ 「A 接手咗」note + TRANSFER audit + B 被 lock
CA_N2=$(grep -c "SOCKET-EVENT conversation:assigned" "$SOCK_LOG" 2>/dev/null); CA_N2=${CA_N2:-0}
h1_req "$COOKIE_TKW" POST "$BASE/api/conversations/$H1_CONV/assign" "{\"toStaffId\":\"$TKW_STAFF_ID\"}"
check "T60 接手：A（非負責人）self-claim → 200" "$H1_CODE" "200"
H1_TKNOTE=$(grep -oE '"noteMessageId":"[^"]*"' "$H1_OUT" | head -1 | cut -d'"' -f4)
H1_TKNOTE_BODY=$(q "SELECT \"body\"::text b FROM \"Message\" WHERE id='$H1_TKNOTE'" | jf b)
echo "$H1_TKNOTE_BODY" | grep -q "接手咗" && pass "T60 接手自動 note = 「A 接手咗」" || { fail "T60 接手自動 note 文案錯（actual=$H1_TKNOTE_BODY）"; H1=1; }
check "T60 接手 AuditLog TRANSFER 累計 = 2" "$(q "SELECT count(*)::text n FROM \"AuditLog\" WHERE action='TRANSFER' AND \"entityId\"='$H1_CONV'" | jf n)" "2"
check "T60 接手後 assignee = A" "$(q "SELECT \"assigneeId\"::text a FROM \"Conversation\" WHERE id='$H1_CONV'" | jf a)" "$TKW_STAFF_ID"
h1_req "$COOKIE_H1B" POST "$BASE/api/messages/send" "{\"conversationId\":\"$H1_CONV\",\"body\":\"e2e H1 B 接手後被 lock\"}"
check "T60 接手後 B send → 423（B 被 lock）" "$H1_CODE" "423"
for i in $(seq 1 15); do
  [ "$(grep -c "SOCKET-EVENT conversation:assigned" "$SOCK_LOG" 2>/dev/null)" = "$((CA_N2+1))" ] && break
  sleep 1
done
check "T60 socket conversation:assigned（接手，實時收到）" "$(grep -c "SOCKET-EVENT conversation:assigned" "$SOCK_LOG" 2>/dev/null)" "$((CA_N2+1))"

# ── T61. 放返隊列 + 再 claim（T60 接手後 A 係 assignee — 由 A 放返） ──────
h1_req "$COOKIE_TKW" POST "$BASE/api/conversations/$H1_CONV/assign" '{"toStaffId":null,"note":"e2e H1 放返隊列"}'
check "T61 A（現任負責人）放返隊列（toStaffId=null）→ 200" "$H1_CODE" "200"
check "T61 assignee = null" "$(q "SELECT coalesce(\"assigneeId\",'null')::text a FROM \"Conversation\" WHERE id='$H1_CONV'" | jf a)" "null"
check "T61 AuditLog UNASSIGN = 1" "$(q "SELECT count(*)::text n FROM \"AuditLog\" WHERE action='UNASSIGN' AND \"entityId\"='$H1_CONV'" | jf n)" "1"
h1_req "$COOKIE_TKW" POST "$BASE/api/messages/send" "{\"conversationId\":\"$H1_CONV\",\"body\":\"e2e H1 A 再 claim\"}"
check "T61 unassigned 再發（A）→ 202（auto-claim 第二次）" "$H1_CODE" "202"
check "T61 AUTO_CLAIM 累計 = 2" "$(q "SELECT count(*)::text n FROM \"AuditLog\" WHERE action='AUTO_CLAIM' AND \"entityId\"='$H1_CONV'" | jf n)" "2"
check "T61 assignee 翻返 A" "$(q "SELECT \"assigneeId\"::text a FROM \"Conversation\" WHERE id='$H1_CONV'" | jf a)" "$TKW_STAFF_ID"

# ── T62. Flow Send Lock ─────────────────────────────────────────────────
h1_req "$COOKIE_H1B" POST "$BASE/api/conversations/$H1_CONV/flows"
check "T62 B（非負責人）flow → 423" "$H1_CODE" "423"

# ── T63. ★ 10 條 INTERNAL note → mock Graph 計數不變（物理隔離）────────────
GRAPH_B=$(graph_count)
UNREAD_B=$(q "SELECT \"unreadCount\"::text u FROM \"Conversation\" WHERE id='$H1_CONV'" | jf u)
DRAFT_B=$(q "SELECT count(*)::text n FROM \"AiDraft\" WHERE \"conversationId\"='$H1_CONV'" | jf n)
H1_NOTE_OK=0
for i in $(seq 1 10); do
  h1_req "$COOKIE_H1B" POST "$BASE/api/conversations/$H1_CONV/notes" "{\"body\":\"e2e H1 batch note $i of 10\"}"
  [ "$H1_CODE" = "201" ] && H1_NOTE_OK=$((H1_NOTE_OK+1)) || { fail "T63 note #$i → $H1_CODE"; H1=1; }
done
check "T63 10 條 INTERNAL note 全部 → 201" "$H1_NOTE_OK" "10"
sleep 2 # 俾 worker 機會行（如果 graph 被調，log 一定寫咗）
GRAPH_A=$(graph_count)
check "T63 ★ mock Graph 發送計數不變（物理隔離證明）" "$GRAPH_A" "$GRAPH_B"
UNREAD_A=$(q "SELECT \"unreadCount\"::text u FROM \"Conversation\" WHERE id='$H1_CONV'" | jf u)
check "T63 unreadCount 不變（note 唔計病人訊息）" "$UNREAD_A" "$UNREAD_B"
DRAFT_A=$(q "SELECT count(*)::text n FROM \"AiDraft\" WHERE \"conversationId\"='$H1_CONV'" | jf n)
check "T63 無新 AiDraft（note 唔觸發 AI／唔入對答庫候選）" "$DRAFT_A" "$DRAFT_B"
# INTERNAL 注數：T56 auto-claim(1) + T57(B 1 + admin 1) + T59(轉交 1) + T60(A note 1 + 接手 1) + T61(放返 1 + 再 claim 1) + T63(10) = 18
check "T63 INTERNAL note 總數 = 18 且全部 waMessageId NULL" "$(q "SELECT count(*)::text n FROM \"Message\" WHERE \"conversationId\"='$H1_CONV' AND \"channel\"='INTERNAL' AND \"waMessageId\" IS NULL" | jf n)" "18"

# ── T64. socket/log 零內文（grep 自證）+ hermetic 清理 ─────────────────────
if grep -qF "e2e H1 batch note" "$SOCK_LOG" 2>/dev/null; then fail "T64 PII：note 內文入咗 socket log"; H1=1; else pass "T64 socket note:new payload 零內文"; fi
if grep -qF "$H1_TRANSFER_NOTE" "$SOCK_LOG" 2>/dev/null; then fail "T64 PII：轉交留言入咗 socket log"; H1=1; else pass "T64 轉交留言零 socket log"; fi
if grep -qF "e2e H1 batch note" /tmp/e2e-server.log /tmp/e2e-worker.log 2>/dev/null; then fail "T64 PII：note 內文入咗 server/worker log"; H1=1; else pass "T64 server/worker log 零 note 內文"; fi
# hermetic 清理：socket listener + 臨時 staff + 對話數據
kill $SOCK_PID 2>/dev/null || true
wait $SOCK_PID 2>/dev/null || true
pnpm -s e2e:staff delete --email "$H1_B_EMAIL" >/dev/null 2>&1 || H1=1
q "DELETE FROM \"AiDraft\" WHERE \"conversationId\"='$H1_CONV'" >/dev/null 2>&1 || true
q "DELETE FROM \"NoteReadReceipt\" WHERE \"messageId\" IN (SELECT id FROM \"Message\" WHERE \"conversationId\"='$H1_CONV')" >/dev/null 2>&1 || true
q "DELETE FROM \"AuditLog\" WHERE \"entityId\"='$H1_CONV'" >/dev/null 2>&1 || true
q "DELETE FROM \"AuditLog\" WHERE \"entityId\" IN (SELECT id FROM \"Message\" WHERE \"conversationId\"='$H1_CONV')" >/dev/null 2>&1 || true
q "DELETE FROM \"WebhookEvent\" WHERE id='$H1_WAMID'" >/dev/null 2>&1 || true
q "DELETE FROM \"Message\" WHERE \"conversationId\"='$H1_CONV'" >/dev/null 2>&1 || true
q "DELETE FROM \"Conversation\" WHERE id='$H1_CONV'" >/dev/null 2>&1 || true
q "DELETE FROM \"Contact\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND \"waId\"='$H1_PAT'" >/dev/null 2>&1 || true
check "T64 hermetic：H1 對話已清" "$(q "SELECT count(*)::text c FROM \"Conversation\" WHERE id='$H1_CONV'" | jf c)" "0"
check "T64 hermetic：臨時 staff 已刪" "$(q "SELECT count(*)::text c FROM \"StaffUser\" WHERE email='$H1_B_EMAIL'" | jf c)" "0"
[ "$H1" = 0 ] && pass "H1 轉交 / Send Lock / 內部備註（T56-T64）" || fail "H1 有項失敗（見上 ❌）"

# ── T65+. H2：已讀回執 / tick 語義 / @mention 通知（Phase H2）──────────────
# 鐵律實測（MD §H2）：
#   T65 read 冪等（重複 read 只 1 row）+ 非 note → 400 + 唔存在 → 404 + 無 mention → assignee tick + socket note:read
#   T66 跨店 read / 攞 receipts → 403
#   T67 tick 兩態：mention B+C — 半讀 allRead=false（灰✓）/ 全讀 true（藍✓✓）+ GET receipts
#   T68 notify:mention：B/C 實時收到；sender（A）0 收
#   T69 自己 @ 自己唔通知自己（A@A+B → 只 B 收）
#   T70 mention 校驗：異店 staff + 唔存在 id 靜默 drop（只留同店 active）
#   T71 unassigned + 無 mention → requiredStaff 空 → allRead 永遠 false
#   T72 423 Send Lock 回歸（H2 對話）+ lock 唔阻 INTERNAL note
#   T73 ★ INTERNAL 仍然 0 graph 請求 / unread 不變 / 無新 AiDraft（物理隔離回歸）
#   T74 socket/log 零內文（grep 自證）+ hermetic 清理（臨時 staff B/C 刪除）
H2=0
H2_PAT="8526020${EPOCH}"
H2_WAMID="wamid.E2E_H2_${EPOCH}"
H2_B_EMAIL="$H1_B_EMAIL"                    # 重用 H1 臨時 staff（T64 已刪 → 重建，密碼同 fixture）
H2_C_EMAIL="staff-e2e-h2c@wa-clinic.local"  # 第二臨時 staff（e2e:staff 只讀 H1_B_PASSWORD fixture）
SOCK_H2A=/tmp/e2e-socket-h2a.log
SOCK_H2B=/tmp/e2e-socket-h2b.log
SOCK_H2C=/tmp/e2e-socket-h2c.log
: > "$SOCK_H2A"; : > "$SOCK_H2B"; : > "$SOCK_H2C"

# socket helper（多 log 版）：等 $2 同時出現所有 pattern（最多 $1 秒）
h2_wait() {
  local max="$1" logf="$2"; shift 2
  local i=0 ok=1 pat
  while [ "$i" -lt "$max" ]; do
    ok=1
    for pat in "$@"; do grep -qF "$pat" "$logf" 2>/dev/null || { ok=0; break; }; done
    [ "$ok" = 1 ] && return 0
    sleep 1; i=$((i + 1))
  done
  return 1
}

echo "[H2] H2: read receipts / tick / @mention..."
# dev-mode pre-compile（同 H1 防護）：新 routes 先 warm up
for _WARM in "/api/notes/warmup-h2/read" "/api/conversations/warmup-h2/note-read-receipts"; do
  curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_TKW" -X POST "$BASE$_WARM" \
    -H 'Content-Type: application/json' -d '{}' >/dev/null 2>&1 || true
done
sleep 1

# (1) 臨時 staff B + C（TKW 同店；hermetic：run 完即刪）
STAFF_OUT=$(pnpm -s e2e:staff create --clinic TKW --email "$H2_B_EMAIL" --name "E2E H2 Staff B" 2>/dev/null || true)
H2_B_ID=$(echo "$STAFF_OUT" | grep -oE 'STAFF_ID=[a-z0-9]+' | head -1 | cut -d= -f2)
[ -n "$H2_B_ID" ] || { echo "    ❌ H2 臨時 staff B 建立失敗"; H2=1; }
STAFF_OUT=$(pnpm -s e2e:staff create --clinic TKW --email "$H2_C_EMAIL" --name "E2E H2 Staff C" 2>/dev/null || true)
H2_C_ID=$(echo "$STAFF_OUT" | grep -oE 'STAFF_ID=[a-z0-9]+' | head -1 | cut -d= -f2)
[ -n "$H2_C_ID" ] || { echo "    ❌ H2 臨時 staff C 建立失敗"; H2=1; }

# (2) B / C 登入（密碼 = H1 fixture — e2e:staff create 固定用 H1_B_PASSWORD）
CODE=$(curl -s -o /dev/null -D /tmp/e2e-h2b-login-headers.txt -w '%{http_code}' -c /tmp/e2e-cookie-h2b.txt \
  -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$H2_B_EMAIL\",\"password\":\"$H1B_PASS\"}")
check "H2-0 臨時 staff B 登入 → 200" "$CODE" "200"
CODE=$(curl -s -o /dev/null -D /tmp/e2e-h2c-login-headers.txt -w '%{http_code}' -c /tmp/e2e-cookie-h2c.txt \
  -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$H2_C_EMAIL\",\"password\":\"$H1B_PASS\"}")
check "H2-0 臨時 staff C 登入 → 200" "$CODE" "200"
COOKIE_H2B=/tmp/e2e-cookie-h2b.txt
COOKIE_H2C=/tmp/e2e-cookie-h2c.txt
H2B_SESSION=$(grep -i '^set-cookie:' /tmp/e2e-h2b-login-headers.txt 2>/dev/null | grep -oE 'wa_inbox_session=[^;]+' | head -1 | cut -d= -f2-)
H2C_SESSION=$(grep -i '^set-cookie:' /tmp/e2e-h2c-login-headers.txt 2>/dev/null | grep -oE 'wa_inbox_session=[^;]+' | head -1 | cut -d= -f2-)
# A 唔重新登入 — 由 cookie jar 提取（jar 係 tab 分隔：domain flag path secure expiry name value，
# 無 name=value 格式；之前用 grep 'wa_inbox_session=' 會撈空 → socket unauthorized）
H2A_SESSION=$(awk '$6=="wa_inbox_session"{v=$7} END{if (v!="") print v}' "$COOKIE_TKW" 2>/dev/null)
[ -n "$H2A_SESSION" ] || { echo "    ❌ H2A session 提取失敗（cookie jar）"; H2=1; }
MF_STAFF_ID=$(q "SELECT id::text id FROM \"StaffUser\" WHERE \"clinicId\"='$MF_CLINIC_ID' ORDER BY id LIMIT 1" | jf id)

# (3) H2 病人 inbound → 新建對話
pnpm -s mock-inbound message --clinic TKW --from "$H2_PAT" --text "e2e H2 read receipt 測試" --wamid "$H2_WAMID" --name "E2E H2 Patient" >/dev/null || H2=1
H2_CONV=""
for i in $(seq 1 30); do
  H2_CONV=$(q "SELECT c.id::text id FROM \"Message\" m JOIN \"Conversation\" c ON c.id=m.\"conversationId\" WHERE m.\"waMessageId\"='$H2_WAMID'" | jf id)
  [ -n "$H2_CONV" ] && break
  sleep 1
done
[ -n "$H2_CONV" ] || { echo "    ❌ H2 對話未建立"; H2=1; }

# (4) A / B / C 三個 socket 監聽（A 用嚟驗證 sender 唔收自己 mention）
nohup pnpm -s e2e:socket-events --cookie "wa_inbox_session=$H2A_SESSION" --wait-ms 300000 >"$SOCK_H2A" 2>&1 &
H2A_PID=$!
nohup pnpm -s e2e:socket-events --cookie "wa_inbox_session=$H2B_SESSION" --wait-ms 300000 >"$SOCK_H2B" 2>&1 &
H2B_PID=$!
nohup pnpm -s e2e:socket-events --cookie "wa_inbox_session=$H2C_SESSION" --wait-ms 300000 >"$SOCK_H2C" 2>&1 &
H2C_PID=$!
SOCKUP=0
for i in $(seq 1 40); do
  grep -q "SOCKET-CONNECTED" "$SOCK_H2A" 2>/dev/null && grep -q "SOCKET-CONNECTED" "$SOCK_H2B" 2>/dev/null && grep -q "SOCKET-CONNECTED" "$SOCK_H2C" 2>/dev/null && { SOCKUP=1; break; }
  sleep 1
done
[ "$SOCKUP" = 1 ] || { echo "    ❌ H2 socket listener 未連上（$(tail -1 "$SOCK_H2B" 2>/dev/null)）"; H2=1; }
sleep 2

# ── T65. read 冪等 + 錯誤路徑 + 無 mention → assignee tick + socket note:read ──
h1_req "$COOKIE_TKW" POST "$BASE/api/messages/send" "{\"conversationId\":\"$H2_CONV\",\"body\":\"e2e H2 A 首發\"}"
check "T65 A 首發（unassigned）→ 202" "$H1_CODE" "202"
check "T65 auto-claim：assignee = A" "$(q "SELECT \"assigneeId\"::text a FROM \"Conversation\" WHERE id='$H2_CONV'" | jf a)" "$TKW_STAFF_ID"

h1_req "$COOKIE_TKW" POST "$BASE/api/conversations/$H2_CONV/notes" '{"body":"e2e H2 note 1 no mention"}'
check "T65 A 內部備註（無 mention）→ 201" "$H1_CODE" "201"
H2_NOTE1=$(grep -oE '"messageId":"[^"]*"' "$H1_OUT" | head -1 | cut -d'"' -f4)

h1_req "$COOKIE_TKW" POST "$BASE/api/notes/$H2_NOTE1/read"
check "T65 首次 read → 200" "$H1_CODE" "200"
grep -q '"allRead":true' "$H1_OUT" && pass "T65 無 mention → 現任 assignee（A）已讀 → allRead=true（藍 ✓✓）" || { fail "T65 assignee tick allRead 應 true（actual=$(cat "$H1_OUT")）"; H2=1; }
grep -qF "\"requiredStaff\":[\"$TKW_STAFF_ID\"]" "$H1_OUT" && pass "T65 requiredStaff = [assignee]" || { fail "T65 requiredStaff 錯"; H2=1; }

h1_req "$COOKIE_TKW" POST "$BASE/api/notes/$H2_NOTE1/read"
check "T65 重複 read → 200（冪等）" "$H1_CODE" "200"
check "T65 冪等：NoteReadReceipt 只 1 row" "$(q "SELECT count(*)::text n FROM \"NoteReadReceipt\" WHERE \"messageId\"='$H2_NOTE1'" | jf n)" "1"

H2_OUTMSG=$(q "SELECT id::text id FROM \"Message\" WHERE \"conversationId\"='$H2_CONV' AND \"channel\"='API' AND \"direction\"='OUT' ORDER BY \"createdAt\" LIMIT 1" | jf id)
h1_req "$COOKIE_TKW" POST "$BASE/api/notes/$H2_OUTMSG/read"
check "T65 非 note 訊息 read → 400" "$H1_CODE" "400"
h1_req "$COOKIE_TKW" POST "$BASE/api/notes/00000000000000000000000000/read"
check "T65 唔存在 note read → 404" "$H1_CODE" "404"

h2_wait 15 "$SOCK_H2B" "SOCKET-EVENT note:read" "$H2_NOTE1" "$TKW_STAFF_ID" \
  && pass "T65 socket note:read（B 實時收到；payload 只 id/時間）" || { fail "T65 socket note:read 未收到"; H2=1; }

# ── T66. 跨店 RBAC：別店 read / 攞 receipts → 403 ────────────────────────
h1_req "$COOKIE_MF" POST "$BASE/api/notes/$H2_NOTE1/read"
check "T66 別店（MF）read 本店 note → 403" "$H1_CODE" "403"
h1_req "$COOKIE_MF" GET "$BASE/api/conversations/$H2_CONV/note-read-receipts"
check "T66 別店（MF）攞 receipts → 403" "$H1_CODE" "403"

# ── T67. tick 兩態：mention B+C（半讀灰✓ → 全讀藍✓✓）+ GET receipts ───────
H2_M2_NOTE="e2e H2 note 2 mention BC"
h1_req "$COOKIE_TKW" POST "$BASE/api/conversations/$H2_CONV/notes" "{\"body\":\"$H2_M2_NOTE\",\"mentions\":[\"$H2_B_ID\",\"$H2_C_ID\"]}"
check "T67 A note @B@C → 201" "$H1_CODE" "201"
H2_NOTE2=$(grep -oE '"messageId":"[^"]*"' "$H1_OUT" | head -1 | cut -d'"' -f4)
check "T67 mentions[1] = B" "$(q "SELECT \"mentions\"[1] m FROM \"Message\" WHERE id='$H2_NOTE2'" | jf m)" "$H2_B_ID"
check "T67 mentions[2] = C" "$(q "SELECT \"mentions\"[2] m FROM \"Message\" WHERE id='$H2_NOTE2'" | jf m)" "$H2_C_ID"
check "T67 mentions length = 2" "$(q "SELECT coalesce(array_length(\"mentions\",1),0)::text n FROM \"Message\" WHERE id='$H2_NOTE2'" | jf n)" "2"

h1_req "$COOKIE_H2B" POST "$BASE/api/notes/$H2_NOTE2/read"
check "T67 B read → 200" "$H1_CODE" "200"
grep -q '"allRead":false' "$H1_OUT" && pass "T67 2 人 mention 半讀 → allRead=false（tick 仍灰 ✓）" || { fail "T67 半讀態 allRead 應 false"; H2=1; }

h1_req "$COOKIE_H2C" POST "$BASE/api/notes/$H2_NOTE2/read"
check "T67 C read → 200" "$H1_CODE" "200"
grep -q '"allRead":true' "$H1_OUT" && pass "T67 全部 mention 已讀 → allRead=true（tick 藍 ✓✓）" || { fail "T67 全讀態 allRead 應 true"; H2=1; }

h2_wait 15 "$SOCK_H2B" "SOCKET-EVENT note:read" "$H2_NOTE2" || { fail "T67 socket note:read 未收到"; H2=1; }
NR=0
for i in $(seq 1 10); do
  NR=$(grep 'SOCKET-EVENT note:read' "$SOCK_H2B" 2>/dev/null | grep -cF "$H2_NOTE2")
  [ "$NR" = "2" ] && break
  sleep 1
done
check "T67 socket note:read ×2（B 自己 read + C read；B 實時收到）" "$NR" "2"

h1_req "$COOKIE_TKW" GET "$BASE/api/conversations/$H2_CONV/note-read-receipts"
check "T67 GET receipts → 200" "$H1_CODE" "200"
check "T67 receipts rows = 3（note1:A + note2:B,C）" "$(grep -o '"messageId"' "$H1_OUT" | wc -l | tr -d ' ')" "3"

# ── T68. notify:mention：B/C 實時收到；sender（A）0 收 ──────────────────
h2_wait 15 "$SOCK_H2B" "SOCKET-EVENT notify:mention" "$H2_NOTE2" "$TKW_STAFF_ID" \
  && pass "T68 B 收到 notify:mention（零內文）" || { fail "T68 B notify:mention 未收到"; H2=1; }
h2_wait 15 "$SOCK_H2C" "SOCKET-EVENT notify:mention" "$H2_NOTE2" "$TKW_STAFF_ID" \
  && pass "T68 C 收到 notify:mention（零內文）" || { fail "T68 C notify:mention 未收到"; H2=1; }
sleep 3
check "T68 A（sender）收到 0 個 notify:mention" "$(grep -c 'SOCKET-EVENT notify:mention' "$SOCK_H2A" 2>/dev/null)" "0"

# ── T69. 自己 @ 自己唔通知自己（A@A+B → 只 B 收） ────────────────────────
h1_req "$COOKIE_TKW" POST "$BASE/api/conversations/$H2_CONV/notes" "{\"body\":\"e2e H2 note 3 self mention\",\"mentions\":[\"$TKW_STAFF_ID\",\"$H2_B_ID\"]}"
check "T69 A note @自己@B → 201" "$H1_CODE" "201"
H2_NOTE3=$(grep -oE '"messageId":"[^"]*"' "$H1_OUT" | head -1 | cut -d'"' -f4)
check "T69 mentions 存晒（自己 + B）" "$(q "SELECT coalesce(array_length(\"mentions\",1),0)::text n FROM \"Message\" WHERE id='$H2_NOTE3'" | jf n)" "2"
h2_wait 15 "$SOCK_H2B" "SOCKET-EVENT notify:mention" "$H2_NOTE3" \
  && pass "T69 B 收到 @ 通知" || { fail "T69 B notify:mention 未收到"; H2=1; }
sleep 3
check "T69 A（self-mention）仍 0 個 notify:mention" "$(grep -c 'SOCKET-EVENT notify:mention' "$SOCK_H2A" 2>/dev/null)" "0"

# ── T70. mention 校驗：異店 staff + 唔存在 id 靜默 drop（只留同店 active） ─
h1_req "$COOKIE_TKW" POST "$BASE/api/conversations/$H2_CONV/notes" "{\"body\":\"e2e H2 note 4 bad mentions\",\"mentions\":[\"$MF_STAFF_ID\",\"nonexistent-staff-id\",\"$H2_C_ID\"]}"
check "T70 含異店/唔存在 mention → 201（靜默 drop）" "$H1_CODE" "201"
H2_NOTE4=$(grep -oE '"messageId":"[^"]*"' "$H1_OUT" | head -1 | cut -d'"' -f4)
check "T70 DB mentions 只留 C（length=1）" "$(q "SELECT coalesce(array_length(\"mentions\",1),0)::text n FROM \"Message\" WHERE id='$H2_NOTE4'" | jf n)" "1"
check "T70 mentions[1] = C" "$(q "SELECT \"mentions\"[1] m FROM \"Message\" WHERE id='$H2_NOTE4'" | jf m)" "$H2_C_ID"
h2_wait 15 "$SOCK_H2C" "SOCKET-EVENT notify:mention" "$H2_NOTE4" \
  && pass "T70 有效 mention（C）仍照收通知" || { fail "T70 C notify:mention 未收到"; H2=1; }

# ── T71. unassigned + 無 mention → requiredStaff 空 → allRead 永遠 false ──
h1_req "$COOKIE_TKW" POST "$BASE/api/conversations/$H2_CONV/assign" '{"toStaffId":null,"note":"e2e H2 放返隊列"}'
check "T71 放返隊列 → 200" "$H1_CODE" "200"
h1_req "$COOKIE_TKW" POST "$BASE/api/conversations/$H2_CONV/notes" '{"body":"e2e H2 note 5 unassigned no mention"}'
check "T71 unassigned 發 note → 201" "$H1_CODE" "201"
H2_NOTE5=$(grep -oE '"messageId":"[^"]*"' "$H1_OUT" | head -1 | cut -d'"' -f4)
h1_req "$COOKIE_TKW" POST "$BASE/api/notes/$H2_NOTE5/read"
check "T71 read → 200" "$H1_CODE" "200"
grep -q '"allRead":false' "$H1_OUT" && grep -qF '"requiredStaff":[]' "$H1_OUT" \
  && pass "T71 unassigned+無 mention → requiredStaff 空 → allRead 永遠 false（灰✓）" || { fail "T71 unassigned tick 錯（actual=$(cat "$H1_OUT")）"; H2=1; }

# ── T72. 423 Send Lock 回歸（H2 對話）+ lock 唔阻 INTERNAL note ──────────
h1_req "$COOKIE_TKW" POST "$BASE/api/conversations/$H2_CONV/assign" "{\"toStaffId\":\"$TKW_STAFF_ID\",\"note\":\"e2e H2 重派 A\"}"
check "T72 重派 A → 200" "$H1_CODE" "200"
h1_req "$COOKIE_H2B" POST "$BASE/api/messages/send" "{\"conversationId\":\"$H2_CONV\",\"body\":\"e2e H2 B locked send\"}"
check "T72 B（非負責人）send → 423" "$H1_CODE" "423"
grep -q '"error":"SEND_LOCKED"' "$H1_OUT" && pass "T72 423 body = SEND_LOCKED（H1 斷言回歸）" || { fail "T72 423 body 錯"; H2=1; }
h1_req "$COOKIE_H2B" POST "$BASE/api/conversations/$H2_CONV/notes" '{"body":"e2e H2 B locked note"}'
check "T72 B locked 照發 INTERNAL note → 201" "$H1_CODE" "201"

# ── T73. ★ INTERNAL 仍然 0 graph 請求 / unread 不變 / 無新 AiDraft ───────
GRAPH_B=$(graph_count)
UNREAD_B=$(q "SELECT \"unreadCount\"::text u FROM \"Conversation\" WHERE id='$H2_CONV'" | jf u)
DRAFT_B=$(q "SELECT count(*)::text n FROM \"AiDraft\" WHERE \"conversationId\"='$H2_CONV'" | jf n)
H2_NOTE_OK=0
for i in 1 2 3; do
  h1_req "$COOKIE_H2B" POST "$BASE/api/conversations/$H2_CONV/notes" "{\"body\":\"e2e H2 batch note $i\"}"
  [ "$H1_CODE" = "201" ] && H2_NOTE_OK=$((H2_NOTE_OK+1)) || { fail "T73 note #$i → $H1_CODE"; H2=1; }
done
sleep 2 # 俾 worker 機會行（如果 graph 被調，log 一定寫咗）
check "T73 mock Graph 發送計數不變（物理隔離）" "$(graph_count)" "$GRAPH_B"
check "T73 unreadCount 不變（note 唔計病人訊息）" "$(q "SELECT \"unreadCount\"::text u FROM \"Conversation\" WHERE id='$H2_CONV'" | jf u)" "$UNREAD_B"
check "T73 無新 AiDraft（note 唔觸發 AI）" "$(q "SELECT count(*)::text n FROM \"AiDraft\" WHERE \"conversationId\"='$H2_CONV'" | jf n)" "$DRAFT_B"
H2_INT_ALL=$(q "SELECT count(*)::text n FROM \"Message\" WHERE \"conversationId\"='$H2_CONV' AND \"channel\"='INTERNAL'" | jf n)
H2_INT_NULL=$(q "SELECT count(*)::text n FROM \"Message\" WHERE \"conversationId\"='$H2_CONV' AND \"channel\"='INTERNAL' AND \"waMessageId\" IS NULL" | jf n)
check "T73 全部 INTERNAL note waMessageId = NULL" "$H2_INT_NULL" "$H2_INT_ALL"

# ── T74. socket/log 零內文（grep 自證）+ hermetic 清理 ───────────────────
H2_PII_OK=1
for tok in "e2e H2 note 1" "note 2 mention" "e2e H2 note 3" "note 4 bad" "e2e H2 note 5" "e2e H2 batch note" "e2e H2 B locked note"; do
  if grep -qF "$tok" "$SOCK_H2A" "$SOCK_H2B" "$SOCK_H2C" 2>/dev/null; then
    fail "T74 PII：note 內文入咗 socket log（$tok）"; H2=1; H2_PII_OK=0
  fi
done
[ "$H2_PII_OK" = 1 ] && pass "T74 三個 socket listener 全部零 note 內文" || true
if grep -qF "e2e H2 batch note" /tmp/e2e-server.log /tmp/e2e-worker.log 2>/dev/null; then
  fail "T74 PII：note 內文入咗 server/worker log"; H2=1
else
  pass "T74 server/worker log 零 note 內文"
fi

# hermetic 清理：socket listeners + 臨時 staff + 對話數據
kill $H2A_PID $H2B_PID $H2C_PID 2>/dev/null || true
wait $H2A_PID $H2B_PID $H2C_PID 2>/dev/null || true
pnpm -s e2e:staff delete --email "$H2_B_EMAIL" >/dev/null 2>&1 || H2=1
pnpm -s e2e:staff delete --email "$H2_C_EMAIL" >/dev/null 2>&1 || H2=1
q "DELETE FROM \"AiDraft\" WHERE \"conversationId\"='$H2_CONV'" >/dev/null 2>&1 || true
q "DELETE FROM \"NoteReadReceipt\" WHERE \"messageId\" IN (SELECT id FROM \"Message\" WHERE \"conversationId\"='$H2_CONV')" >/dev/null 2>&1 || true
q "DELETE FROM \"AuditLog\" WHERE \"entityId\"='$H2_CONV'" >/dev/null 2>&1 || true
q "DELETE FROM \"AuditLog\" WHERE \"entityId\" IN (SELECT id FROM \"Message\" WHERE \"conversationId\"='$H2_CONV')" >/dev/null 2>&1 || true
q "DELETE FROM \"WebhookEvent\" WHERE id='$H2_WAMID'" >/dev/null 2>&1 || true
q "DELETE FROM \"Message\" WHERE \"conversationId\"='$H2_CONV'" >/dev/null 2>&1 || true
q "DELETE FROM \"Conversation\" WHERE id='$H2_CONV'" >/dev/null 2>&1 || true
q "DELETE FROM \"Contact\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND \"waId\"='$H2_PAT'" >/dev/null 2>&1 || true
check "T74 hermetic：H2 對話已清" "$(q "SELECT count(*)::text c FROM \"Conversation\" WHERE id='$H2_CONV'" | jf c)" "0"
check "T74 hermetic：臨時 staff B 已刪" "$(q "SELECT count(*)::text c FROM \"StaffUser\" WHERE email='$H2_B_EMAIL'" | jf c)" "0"
check "T74 hermetic：臨時 staff C 已刪" "$(q "SELECT count(*)::text c FROM \"StaffUser\" WHERE email='$H2_C_EMAIL'" | jf c)" "0"
[ "$H2" = 0 ] && pass "H2 已讀回執 / tick / @mention（T65-T74）" || fail "H2 有項失敗（見上 ❌）"

# ════════════════════════════════════════════════════════════════════════════════
# Phase R9 — Realtime P0 chaos e2e（cwi-rt-20260823；Kairo mt5w39ck5etgo）
#   T75 RT-IDEMPOTENT：3 次同 clientMessageId → DB 1 row（R1 驗收）
#   T76 RT-ORDER：20 對話 × 3 訊息壓測 → 每對話 DB 順序 = 發送順序（R4 驗收）
#   T77 RT-MEDIA：MEDIA_CHAOS_DELAY_MS=8000 → media 下載唔阻塞其他對話（R4 mediaQueue）
#   T78 RT-GRAPH-FAIL（Test H）：WA_GRAPH_MOCK_FAIL=1 → FAILED 無假 SENT
#   T79 RT-ASSIGN-RACE（Test G）：parallel assign → 1×200 + 1×409 + version+1（R5 驗收）
#   T80 RT-ROLLBACK（Test I）：PG trigger 強行 rollback → 0 socket event + 無 row（R2 驗收）
#   T81 RT-REDIS-RESTART（Test D）：SHUTDOWN NOSAVE → 2 條 inbound → delta refetch 補齊（R3 驗收；最後跑）
#   注意：T77/T78 要重啟 worker（T16 pattern；等 "all workers running"）；
#         T81 會清 redis queue 狀態（SHUTDOWN NOSAVE）→ 必須最後跑
# ════════════════════════════════════════════════════════════════════════════════
R9=0

# ── T75. RT-IDEMPOTENT：同 clientMessageId 3 次發送 → DB 1 row ────────────
echo "[R9] T75: RT-IDEMPOTENT..."
# ★ T75 必須用新病人 — T3 對話 lastInboundAt 已被 T9 回撥 -25h（window_closed → send 422）
T75_PAT="8526601${EPOCH}"
T75_WAMID="wamid.E2E_T75_${EPOCH}"
"$TSX" scripts/mock-inbound.ts message --clinic TKW --from "$T75_PAT" --text "e2e T75 setup" --wamid "$T75_WAMID" --name "E2E-T75" >/dev/null 2>&1 || { fail "T75 setup inbound 失敗"; R9=1; }
if ! wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"waMessageId\"='$T75_WAMID'" '[{"c":"1"}]' 30; then fail "T75 setup 訊息未落庫"; R9=1; fi
T75_CONV=$(q "SELECT c.id::text id FROM \"Message\" m JOIN \"Conversation\" c ON c.id=m.\"conversationId\" WHERE m.\"waMessageId\"='$T75_WAMID'" | jf id)
[ -n "$T75_CONV" ] || { fail "T75 對話搵唔到"; R9=1; }
T75_CID=$(uuidgen)
h1_req "$COOKIE_TKW" POST "$BASE/api/messages/send" "{\"conversationId\":\"$T75_CONV\",\"body\":\"e2e T75 idempotent 1\",\"clientMessageId\":\"$T75_CID\"}"
check "T75 首次 POST → 202" "$H1_CODE" "202"
wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"clientMessageId\"='$T75_CID'" '[{"c":"1"}]' 15 || fail "T75 首次 row 未 commit"
h1_req "$COOKIE_TKW" POST "$BASE/api/messages/send" "{\"conversationId\":\"$T75_CONV\",\"body\":\"e2e T75 idempotent 2\",\"clientMessageId\":\"$T75_CID\"}"
check "T75 第 2 次 POST（同 key）→ 200" "$H1_CODE" "200"
grep -q '"idempotentReplay":true' "$H1_OUT" && pass "T75 第 2 次 replay 標 idempotentReplay=true" || fail "T75 第 2 次 replay body 冇 idempotentReplay"
T75_MID1=$(grep -oE '"messageId":"[^"]*"' "$H1_OUT" | head -1 | cut -d'"' -f4)
h1_req "$COOKIE_TKW" POST "$BASE/api/messages/send" "{\"conversationId\":\"$T75_CONV\",\"body\":\"e2e T75 idempotent 3\",\"clientMessageId\":\"$T75_CID\"}"
check "T75 第 3 次 POST（同 key）→ 200" "$H1_CODE" "200"
T75_MID3=$(grep -oE '"messageId":"[^"]*"' "$H1_OUT" | head -1 | cut -d'"' -f4)
check "T75 replay 回同一 messageId（唔重入 queue）" "$T75_MID3" "$T75_MID1"
check "T75 DB：同 clientMessageId 3 次發送 → 1 row" "$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"clientMessageId\"='$T75_CID'" | jf c)" "1"

# ── T76. RT-ORDER：20 對話 × 3 訊息壓測 → 每對話 DB 順序 = 發送順序 ─────
echo "[R9] T76: RT-ORDER..."
T76_BASE=$(date +%s)
T76_PIDS=""
: > /tmp/e2e-t76-dropped.log
for i in $(seq 1 20); do
  (
    for j in 0 1 2; do
      # 每病人 3 條 strictly sequential（發送順序確定性）；病人之間並行 = 真實流量交錯
      # ★ 驗 webhook 回應、失敗重試（最多 3 次、間 1s）— 建模 Meta webhook 重試語義；
      #   20 併發下 Next dev 偶爾 transient drop 一個 request — 靜默 drop 會令 60/60 計數假負
      T76_OK=0
      for T76_ATT in 1 2 3; do
        T76_OUT=$(timeout 15 "$TSX" scripts/mock-inbound.ts message --clinic TKW --from "852610${i}${EPOCH}" --text "e2e T76 order $i.$j" --wamid "wamid.E2E_ORDER_${EPOCH}_${i}_${j}" --name "E2E-T76-P${i}" --ts "$((T76_BASE + i * 3 + j))" 2>&1)
        case "$T76_OUT" in *OK*) T76_OK=1; break ;; esac
        sleep 1
      done
      [ "$T76_OK" = 1 ] || echo "DROPPED i=$i j=$j out=${T76_OUT:0:200}" >> /tmp/e2e-t76-dropped.log
    done
  ) &
  T76_PIDS="$T76_PIDS $!"
done
# ★ 只 wait 呢 20 個 PID — 裸 wait 會等住 pnpm dev / pnpm worker 永遠唔出（T30 同款陷阱）
wait $T76_PIDS
[ ! -s /tmp/e2e-t76-dropped.log ] && pass "T76 60/60 發送全部 webhook OK（0 drop；有重試已記錄）" || { fail "T76 $(wc -l < /tmp/e2e-t76-dropped.log) 個 webhook drop（見 /tmp/e2e-t76-dropped.log）"; head -3 /tmp/e2e-t76-dropped.log; }
if wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"waMessageId\" LIKE 'wamid.E2E_ORDER_${EPOCH}%'" '[{"c":"60"}]' 120; then
  pass "T76 60/60 訊息落庫（20 對話 × 3）"
else
  fail "T76 60/60 訊息落庫"
fi
check "T76 20 新對話建立" "$(q "SELECT count(*)::text c FROM \"Conversation\" cv JOIN \"Contact\" x ON x.id=cv.\"contactId\" WHERE x.\"waId\" LIKE '852610%${EPOCH}'" | jf c)" "20"
T76_INVERT=$(q "SELECT count(*)::text c FROM (SELECT \"waTimestamp\" ts, LAG(\"waTimestamp\") OVER (PARTITION BY \"conversationId\" ORDER BY \"createdAt\") prev FROM \"Message\" WHERE \"waMessageId\" LIKE 'wamid.E2E_ORDER_${EPOCH}%') t WHERE prev IS NOT NULL AND prev >= ts" | jf c)
check "T76 每對話 DB 順序 = 發送順序（0 逆轉）" "$T76_INVERT" "0"

# ── T77. RT-MEDIA：media 下載（chaos 8s）唔阻塞其他對話 ─────────────────
echo "[R9] T77: RT-MEDIA (MEDIA_CHAOS_DELAY_MS=8000)"
pkill -f "src/workers/index.ts" 2>/dev/null || true
sleep 1
MEDIA_CHAOS_DELAY_MS=8000 nohup pnpm worker >/tmp/e2e-worker-media.log 2>&1 &
WORKER_PID=$!
for i in $(seq 1 30); do grep -q "all workers running" /tmp/e2e-worker-media.log 2>/dev/null && break; sleep 1; done
T77_PAT1="8526201${EPOCH}"
T77_PAT2="8526202${EPOCH}"
T77_W1="wamid.E2E_T77_M1_${EPOCH}"
T77_W2="wamid.E2E_T77_M2_${EPOCH}"
"$TSX" scripts/mock-inbound.ts message --clinic TKW --from "$T77_PAT1" --text "e2e T77 media" --wamid "$T77_W1" --name "E2E-T77-M1" --media image >/dev/null 2>&1 || fail "T77 M1 mock-inbound"
if wait_for "SELECT \"mediaStatus\"::text m FROM \"Message\" WHERE \"waMessageId\"='$T77_W1'" '[{"m":"PENDING"}]' 30; then
  pass "T77 M1（media）落庫 mediaStatus=PENDING（下載入獨立 mediaQueue）"
else
  fail "T77 M1 mediaStatus=PENDING"
fi
"$TSX" scripts/mock-inbound.ts message --clinic TKW --from "$T77_PAT2" --text "e2e T77 plain after media" --wamid "$T77_W2" --name "E2E-T77-M2" >/dev/null 2>&1 || fail "T77 M2 mock-inbound"
T77_BLOCKED=0
if wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"waMessageId\"='$T77_W2'" '[{"c":"1"}]' 10; then
  pass "T77 M2（另一對話）10s 內落庫"
else
  fail "T77 M2 10s 未落庫（被 media 下載阻塞）"
  T77_BLOCKED=1
fi
[ "$T77_BLOCKED" = 0 ] && {
  check "T77 M2 落庫時 M1 media 仍 PENDING（並行處理、唔阻塞）" "$(q "SELECT \"mediaStatus\"::text m FROM \"Message\" WHERE \"waMessageId\"='$T77_W1'" | jf m)" "PENDING"
}
if wait_for "SELECT \"mediaStatus\"::text m FROM \"Message\" WHERE \"waMessageId\"='$T77_W1'" '[{"m":"SKIPPED"}]' 30; then
  pass "T77 M1 media 終態 SKIPPED（mock mode 跳下載；訊息保留）"
else
  fail "T77 M1 media 未到終態"
fi
grep -q "chaos delay" /tmp/e2e-worker-media.log 2>/dev/null && pass "T77 media worker 應咗 8s chaos delay（log）" || fail "T77 chaos delay 未生效（log）"
# 還原正常 worker
pkill -f "src/workers/index.ts" 2>/dev/null || true
sleep 1
nohup pnpm worker >/tmp/e2e-worker-rt1.log 2>&1 &
WORKER_PID=$!
for i in $(seq 1 30); do grep -q "all workers running" /tmp/e2e-worker-rt1.log 2>/dev/null && break; sleep 1; done

# ── T78. RT-GRAPH-FAIL（Test H）：mock Graph 失敗 → FAILED 無假 SENT ─────
echo "[R9] T78: RT-GRAPH-FAIL (Test H)"
pkill -f "src/workers/index.ts" 2>/dev/null || true
sleep 1
WA_GRAPH_MOCK_FAIL=1 nohup pnpm worker >/tmp/e2e-worker-graphfail.log 2>&1 &
WORKER_PID=$!
for i in $(seq 1 30); do grep -q "all workers running" /tmp/e2e-worker-graphfail.log 2>/dev/null && break; sleep 1; done
h1_req "$COOKIE_TKW" POST "$BASE/api/messages/send" "{\"conversationId\":\"$T75_CONV\",\"body\":\"e2e T78 graph fail\"}"
check "T78 send → 202（入隊）" "$H1_CODE" "202"
T78_MID=$(grep -oE '"messageId":"[^"]*"' "$H1_OUT" | head -1 | cut -d'"' -f4)
if wait_for "SELECT \"status\"::text s FROM \"Message\" WHERE id='$T78_MID'" '[{"s":"FAILED"}]' 60; then
  pass "T78 最終 status = FAILED（無假 SENT）"
else
  fail "T78 最終 status 非 FAILED（actual=$(q "SELECT \"status\"::text s FROM \"Message\" WHERE id='$T78_MID'" | jf s)）"
fi
check "T78 waMessageId = NULL（無假 SENT id）" "$(q "SELECT (\"waMessageId\" IS NULL)::text n FROM \"Message\" WHERE id='$T78_MID'" | jf n)" "true"
check "T78 status 從未變 SENT（DB）" "$(q "SELECT (\"status\" = 'SENT')::text n FROM \"Message\" WHERE id='$T78_MID'" | jf n)" "false"
grep -q "permanently failed" /tmp/e2e-worker-graphfail.log 2>/dev/null && pass "T78 worker 3 次重試後放棄（log）" || fail "T78 'permanently failed' log 缺失"
# 還原正常 worker
pkill -f "src/workers/index.ts" 2>/dev/null || true
sleep 1
nohup pnpm worker >/tmp/e2e-worker-rt2.log 2>&1 &
WORKER_PID=$!
for i in $(seq 1 30); do grep -q "all workers running" /tmp/e2e-worker-rt2.log 2>/dev/null && break; sleep 1; done

# ── T79. RT-ASSIGN-RACE（Test G）：parallel assign → 1×200 + 1×409 ─────
echo "[R9] T79: RT-ASSIGN-RACE (Test G)"
T79_PAT="8526301${EPOCH}"
T79_WAMID="wamid.E2E_T79_${EPOCH}"
"$TSX" scripts/mock-inbound.ts message --clinic TKW --from "$T79_PAT" --text "e2e T79 assign race" --wamid "$T79_WAMID" --name "E2E-T79" >/dev/null 2>&1 || fail "T79 mock-inbound"
T79_CONV=""
for i in $(seq 1 30); do
  T79_CONV=$(q "SELECT c.id::text id FROM \"Message\" m JOIN \"Conversation\" c ON c.id=m.\"conversationId\" WHERE m.\"waMessageId\"='$T79_WAMID'" | jf id)
  [ -n "$T79_CONV" ] && break
  sleep 1
done
[ -n "$T79_CONV" ] || { fail "T79 對話未建立"; R9=1; }
T79_D_EMAIL="staff-e2e-t79d@wa-clinic.local"
T79_D_ID=$(pnpm -s e2e:staff create --clinic TKW --email "$T79_D_EMAIL" --name "E2E T79 Staff D" 2>/dev/null | grep -oE 'STAFF_ID=[a-z0-9]+' | head -1 | cut -d= -f2)
[ -n "$T79_D_ID" ] || { fail "T79 臨時 staff D 建立失敗"; R9=1; }
# 兩個 parallel claim（同 assignVersion=0；unassigned → 任何同店 STAFF 合法 — 樂觀鎖定勝負）
curl -s -o /tmp/e2e-t79-a.json -w '%{http_code}' -b "$COOKIE_TKW" -X POST "$BASE/api/conversations/$T79_CONV/assign" -H 'Content-Type: application/json' -d "{\"toStaffId\":\"$TKW_STAFF_ID\",\"assignVersion\":0}" >/tmp/e2e-t79-ca &
T79_PA=$!
curl -s -o /tmp/e2e-t79-b.json -w '%{http_code}' -b "$COOKIE_TKW" -X POST "$BASE/api/conversations/$T79_CONV/assign" -H 'Content-Type: application/json' -d "{\"toStaffId\":\"$T79_D_ID\",\"assignVersion\":0}" >/tmp/e2e-t79-cb &
T79_PB=$!
wait "$T79_PA" "$T79_PB"
T79_CA=$(cat /tmp/e2e-t79-ca)
T79_CB=$(cat /tmp/e2e-t79-cb)
T79_CODES=$(printf '%s\n%s\n' "$T79_CA" "$T79_CB" | sort | tr '\n' ',')
check "T79 parallel claim → 恰 1×200 + 1×409" "$T79_CODES" "200,409,"
if [ "$T79_CA" = "200" ]; then T79_WINNER="$TKW_STAFF_ID"; T79_LOSE_BODY=/tmp/e2e-t79-b.json; else T79_WINNER="$T79_D_ID"; T79_LOSE_BODY=/tmp/e2e-t79-a.json; fi
[ -n "$T79_WINNER" ] && {
  grep -q '"error":"ASSIGN_CONFLICT"' "$T79_LOSE_BODY" && pass "T79 輸家 409 body = ASSIGN_CONFLICT" || fail "T79 409 body 錯"
  check "T79 409 帶最新 assignVersion=1" "$(grep -oE '"assignVersion":[0-9]+' "$T79_LOSE_BODY" | head -1 | cut -d: -f2)" "1"
  check "T79 409 帶 currentAssigneeId = 贏家" "$(grep -oE '"currentAssigneeId":"[^"]*"' "$T79_LOSE_BODY" | head -1 | cut -d'"' -f4)" "$T79_WINNER"
}
check "T79 DB 最終 assignVersion = 1（0→1）" "$(q "SELECT \"assignVersion\"::text v FROM \"Conversation\" WHERE id='$T79_CONV'" | jf v)" "1"
check "T79 DB assignee = 贏家" "$(q "SELECT \"assigneeId\"::text a FROM \"Conversation\" WHERE id='$T79_CONV'" | jf a)" "$T79_WINNER"
# 贏家用新版本（1）再 assign → 200 + version=2（版本鏈有效）
if [ "$T79_WINNER" = "$TKW_STAFF_ID" ]; then T79_OTHER="$T79_D_ID"; else T79_OTHER="$TKW_STAFF_ID"; fi
h1_req "$COOKIE_TKW" POST "$BASE/api/conversations/$T79_CONV/assign" "{\"toStaffId\":\"$T79_OTHER\",\"assignVersion\":1}"
check "T79 新版本（1）assign → 200" "$H1_CODE" "200"
check "T79 assignVersion → 2" "$(q "SELECT \"assignVersion\"::text v FROM \"Conversation\" WHERE id='$T79_CONV'" | jf v)" "2"
# 陳舊版本（0）→ 409（self-claim 合法，版本鎖擋）
h1_req "$COOKIE_TKW" POST "$BASE/api/conversations/$T79_CONV/assign" "{\"toStaffId\":\"$TKW_STAFF_ID\",\"assignVersion\":0}"
check "T79 陳舊版本（0）assign → 409" "$H1_CODE" "409"

# ── T80. RT-ROLLBACK（Test I）：PG trigger 強行 rollback → 0 event + 無 row ──
echo "[R9] T80: RT-ROLLBACK (Test I)"
T80_SOCK=/tmp/e2e-socket-t80.log
: > "$T80_SOCK"
T80_SESSION=$(awk '$6=="wa_inbox_session"{v=$7} END{if (v!="") print v}' "$COOKIE_TKW" 2>/dev/null)
[ -n "$T80_SESSION" ] || { fail "T80 TKW session 提取失敗"; R9=1; }
nohup pnpm -s e2e:socket-events --cookie "wa_inbox_session=$T80_SESSION" --wait-ms 180000 >"$T80_SOCK" 2>&1 &
T80_PID=$!
T80_SOCKUP=0
for i in $(seq 1 40); do grep -q "SOCKET-CONNECTED" "$T80_SOCK" 2>/dev/null && { T80_SOCKUP=1; break; }; sleep 1; done
[ "$T80_SOCKUP" = 1 ] && pass "T80 socket listener 已連" || { fail "T80 socket listener 未連"; R9=1; }
sleep 2
T80_NEW_BEFORE=$(grep -c "SOCKET-EVENT message:new" "$T80_SOCK" 2>/dev/null); T80_NEW_BEFORE=${T80_NEW_BEFORE:-0}
# trigger：T80 wamid 嘅 Message INSERT 強行 abort（模擬 transaction rollback）
q "CREATE OR REPLACE FUNCTION e2e_t80_guard_fn() RETURNS trigger AS \$\$ BEGIN IF NEW.\"waMessageId\" LIKE 'wamid.E2E_T80%' THEN RAISE EXCEPTION 'e2e T80 forced rollback'; END IF; RETURN NEW; END; \$\$ LANGUAGE plpgsql" >/dev/null 2>&1 || fail "T80 guard function 建立失敗"
q "DROP TRIGGER IF EXISTS e2e_t80_guard ON \"Message\"" >/dev/null 2>&1
q "CREATE TRIGGER e2e_t80_guard BEFORE INSERT ON \"Message\" FOR EACH ROW EXECUTE FUNCTION e2e_t80_guard_fn()" >/dev/null 2>&1 || fail "T80 trigger 建立失敗"
T80_PAT="8526501${EPOCH}"
T80_WAMID="wamid.E2E_T80_${EPOCH}"
T80_HOOK=$("$TSX" scripts/mock-inbound.ts message --clinic TKW --from "$T80_PAT" --text "e2e T80 rollback" --wamid "$T80_WAMID" --name "E2E-T80" 2>&1)
echo "$T80_HOOK" | grep -q "OK" && pass "T80 webhook 接受（200 — queue 正常）" || { fail "T80 webhook 未接受：$T80_HOOK"; R9=1; }
# worker 試 3 次（backoff 2s/4s）— 全部被 trigger abort；每次 abort 打 2 行 log（clinic 層 + jobId 層）
T80_RETRIES=0
for i in $(seq 1 45); do
  T80_RETRIES=$(grep -c "e2e T80 forced rollback" /tmp/e2e-worker-rt2.log 2>/dev/null); T80_RETRIES=${T80_RETRIES:-0}
  [ "$T80_RETRIES" -ge 6 ] && break
  sleep 1
done
[ "$T80_RETRIES" -ge 6 ] && pass "T80 worker 3 次處理全被 trigger abort（rollback；每次 2 行 log = 共 ≥6）" || fail "T80 trigger abort 次數不足（=$T80_RETRIES，期望 >=6 = 3 次 × 2 行）"
check "T80 Message row = 0（transaction rollback）" "$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"waMessageId\"='$T80_WAMID'" | jf c)" "0"
check "T80 Contact row = 0（同一 transaction 回滾）" "$(q "SELECT count(*)::text c FROM \"Contact\" WHERE \"waId\"='$T80_PAT'" | jf c)" "0"
check "T80 Conversation row = 0" "$(q "SELECT count(*)::text c FROM \"Conversation\" cv JOIN \"Contact\" x ON x.id=cv.\"contactId\" WHERE x.\"waId\"='$T80_PAT'" | jf c)" "0"
check "T80 WebhookEvent row = 0（claim 同業務寫原子）" "$(q "SELECT count(*)::text c FROM \"WebhookEvent\" WHERE id LIKE '%${T80_WAMID}%'" | jf c)" "0"
T80_NEW_AFTER=$(grep -c "SOCKET-EVENT message:new" "$T80_SOCK" 2>/dev/null); T80_NEW_AFTER=${T80_NEW_AFTER:-0}
check "T80 socket：0 新 message:new 事件（未 commit → 未 emit）" "$T80_NEW_AFTER" "$T80_NEW_BEFORE"
# 清理：drop trigger + 停 socket listener
q "DROP TRIGGER IF EXISTS e2e_t80_guard ON \"Message\"" >/dev/null 2>&1
q "DROP FUNCTION IF EXISTS e2e_t80_guard_fn()" >/dev/null 2>&1
kill "$T80_PID" 2>/dev/null || true
wait "$T80_PID" 2>/dev/null || true

# ── T81. RT-REDIS-RESTART（Test D，最後跑）：SHUTDOWN NOSAVE → delta 補齊 ──
echo "[R9] T81: RT-REDIS-RESTART (Test D)"
T81_LASTSEEN=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
T81_PAT1="8526401${EPOCH}"
T81_PAT2="8526402${EPOCH}"
T81_W1="wamid.E2E_T81_A_${EPOCH}"
T81_W2="wamid.E2E_T81_B_${EPOCH}"
# 1. redis SHUTDOWN NOSAVE（queue 狀態清空）
redis-cli SHUTDOWN NOSAVE 2>/dev/null || true
T81_DOWN=0
for i in $(seq 1 10); do
  redis-cli ping >/dev/null 2>&1 || { T81_DOWN=1; break; }
  sleep 1
done
[ "$T81_DOWN" = 1 ] && pass "T81 redis down（SHUTDOWN NOSAVE）" || fail "T81 SHUTDOWN 後 redis 仍活"
# 2. 故障期間 2 條 inbound → webhook 唔好吊住 request（鐵律 5）
#    實測行為（exp-t81-behavior 實驗證實）：短故障時 ioredis offline-queue buffer →
#    queue.add 即刻 resolve → 200（job 重連後 flush，冪等層保證 exactly-once）；
#    connection end（長故障）先會 500 fast-fail。兩者都合法 — 斷言「快回應、唔吊」。
T81_O1=$(timeout 10 "$TSX" scripts/mock-inbound.ts message --clinic TKW --from "$T81_PAT1" --text "e2e T81 during outage A" --wamid "$T81_W1" --name "E2E-T81-A" 2>&1)
case "$T81_O1" in
  *OK*) pass "T81 故障期間 inbound#1 → 快回應 200（offline-queue buffer — 唔吊 request）" ;;
  *"HTTP 500"*) pass "T81 故障期間 inbound#1 → 快 500（fast fail — Meta 重試語義）" ;;
  *) fail "T81 故障期間 inbound#1 未快回應（吊咗 request？）：${T81_O1:-<timeout 10s>}"; R9=1 ;;
esac
T81_O2=$(timeout 10 "$TSX" scripts/mock-inbound.ts message --clinic TKW --from "$T81_PAT2" --text "e2e T81 during outage B" --wamid "$T81_W2" --name "E2E-T81-B" 2>&1)
case "$T81_O2" in
  *OK*) pass "T81 故障期間 inbound#2 → 快回應 200（offline-queue buffer）" ;;
  *"HTTP 500"*) pass "T81 故障期間 inbound#2 → 快 500（fast fail）" ;;
  *) fail "T81 故障期間 inbound#2 未快回應：${T81_O2:-<timeout 10s>}"; R9=1 ;;
esac
# 3. redis 重啟（sandbox 無 supervisor — 手動；模擬 ops 重啟）
redis-server 127.0.0.1:6379 --daemonize yes >/dev/null 2>&1 || true
T81_UP=0
for i in $(seq 1 30); do
  redis-cli ping 2>/dev/null | grep -q PONG && { T81_UP=1; break; }
  sleep 1
done
[ "$T81_UP" = 1 ] && pass "T81 redis 回復（手動重啟）" || { fail "T81 redis 未回復"; R9=1; }
# ioredis 自動重連（maxRetriesPerRequest:null）— 俾 server/worker 時間重連 + flush offline queue
sleep 5
# 4. Meta 重試語義：redeliver 同 2 個 wamid → 200（冪等層保證唔重複）
T81_R1=$("$TSX" scripts/mock-inbound.ts message --clinic TKW --from "$T81_PAT1" --text "e2e T81 redeliver A" --wamid "$T81_W1" --name "E2E-T81-A" 2>&1)
T81_R2=$("$TSX" scripts/mock-inbound.ts message --clinic TKW --from "$T81_PAT2" --text "e2e T81 redeliver B" --wamid "$T81_W2" --name "E2E-T81-B" 2>&1)
echo "$T81_R1" | grep -q "OK" && pass "T81 redeliver#1 → 200（重連成功）" || { fail "T81 redeliver#1：$T81_R1"; R9=1; }
echo "$T81_R2" | grep -q "OK" && pass "T81 redeliver#2 → 200" || { fail "T81 redeliver#2：$T81_R2"; R9=1; }
# 5. 2 條訊息 commit（冪等：offline-queue flush 或 redeliver — 兩者都係 exactly-once）
if wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"waMessageId\" IN ('$T81_W1','$T81_W2')" '[{"c":"2"}]' 60; then
  pass "T81 兩條訊息重啟後 commit（exactly-once）"
else
  fail "T81 訊息重啟後未 commit"
fi
# 6. ★ Test D 驗收：client focus → delta refetch 2s 內補齊
T81_DELTA=/tmp/e2e-t81-delta.json
T81_DL=$(curl -s -o "$T81_DELTA" -w '%{time_total}' -b "$COOKIE_TKW" "$BASE/api/conversations?clinicId=$TKW_CLINIC_ID&after=$T81_LASTSEEN")
T81_D1=$(grep -o "$T81_PAT1" "$T81_DELTA" | wc -l | tr -d ' ')
T81_D2=$(grep -o "$T81_PAT2" "$T81_DELTA" | wc -l | tr -d ' ')
[ "$T81_D1" -ge 1 ] && [ "$T81_D2" -ge 1 ] && pass "T81 delta refetch 補齊兩條故障期間對話（focus-refetch 有效）" || fail "T81 delta refetch 補唔齊（A=$T81_D1 B=$T81_D2）"
echo "$T81_DL" | awk '{exit !($1 < 2)}' && pass "T81 delta refetch 回應 <2s（actual=${T81_DL}s）" || fail "T81 delta refetch 太慢：${T81_DL}s"

# ── R9 summary ─────────────────────────────────────────────────────────
[ "$R9" = 0 ] && pass "R9 Realtime P0 chaos e2e（T75-T81）" || fail "R9 有項失敗（見上 ❌）"

# ── summary ────────────────────────────────────────────────────────────
echo "════════════════════════════════════════════"
echo " E2E 完成：PASS=$PASS FAIL=$FAIL"
echo "════════════════════════════════════════════"
[ "$FAIL" = 0 ] || exit 1

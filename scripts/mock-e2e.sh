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
#   T62b Booking Send Lock（代落單 create 非負責人 → 423 SEND_LOCKED；負責人唔 423，cwi-prefix-20260824-b1）
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
#
# AI Workflow T1（cwi-ai-20260824-t1）：
#   T82 P0 retention-purge：超期 fixture（25/13/11mo 訊息 + 媒體檔 + 90d 邊界 draft/notice）→
#       手動 enqueue → 24mo 全刪（連 NoteReadReceipt/PatientFact）/ 12mo 刪檔+清 mediaPath /
#       AiDraft 90d（≠PROPOSED）/ StaffNotice 已讀 90d + 未到期零觸碰 + OpsReport + log metadata only
#   T83 A1 七閘：AUTO + assignee → 只出 draft 唔自動發（log assigned — Send Lock 語義補完）
#   T84 A1 七閘：AUTO + RESOLVED 對話病人再來訊 → 唔自動發（log resolved）
#   T85 A1 第八閘：員工人手覆後 cooldown（AI_HUMAN_COOLDOWN_MS 預設 30 分鐘）內 AI 唔搶咪（log human-recent）
#   T86 A2 媒體：send 相 → 客戶端零回覆 + StaffNotice(MEDIA_RECEIVED) 落庫 + /api/notices bell +1 +
#       AiDraft 零新增（canDraft 限 text）+ 分類照行 + PATCH 標已讀
#   T87 hermetic：MF 還原 DRAFT（T83 起轉 AUTO）
#
# Phase C（slot-filling 對話式預約，cwi-ai-20260824-t3）：
#   PC-G1 L3 全鏈：4 條訊息 slot-filling（provider→相對日期→15:00→確認）→ 綠色卡 PENDING
#       + 相對日期實證（聽日/後日/大後日 → +1/+2/+3 日）+ PatientFact（provider 模板 row，model=null，source=provider 訊息）
#   PC-G2 L3 slot-taken：fill flag 填位 → 「滿咗」+ 候選重出 + time 清回 + session 續行（改另一日 → 收卡）
#   PC-G3 HANDOFF：「真人」逃生口 → HANDOFF + StaffNotice + PatientFact 零 row + HANDOFF 後跌普通 triage（零 session 回覆）
#   PC-S1 staff claim 中途接手 → session HANDOFF 讓路（零 session 回覆）
#   PC-S2 媒體入 session → 客戶端零回覆 + MEDIA_RECEIVED + session 不動
#   PC-G4 L4 自動落單（pinned + 預設 visit reason）→ CONFIRMED + autoBooked + workforce mock 調用 +
#       AuditLog(AI_AUTO_BOOKING, staffId=null) + StaffNotice(BOOKING_AUTO) + 「已為你預約」訊息（aiAutoSent）
#   PC-G5 kill switch：AI_GLOBAL_MAX_LEVEL=L2 → 有 policy row 都唔開 session + 舊 draft 行為（L1/L2 byte-for-byte 實證）
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
q "DELETE FROM \"StaffNotice\"" >/dev/null 2>&1 || true  # AI Workflow T1：新表（persistent DB 跨 run 殘留 hermetic）
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
for _WARM in "/api/conversations/warmup-h1/assign" "/api/conversations/warmup-h1/notes" "/api/conversations/warmup-h1/flows" "/api/messages/send" "/api/bookings/warmup-h1/create"; do
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

# ── T62b. Booking Send Lock：代落單 create 非負責人 → 423（MD §7，cwi-prefix-20260824-b1）─
# 代落單 = 向 Apricot 寫入 — 同 rollback/cancel/reschedule 一樣受 Send Lock。
# fixture：H1_CONV（T61 後 assignee = A）+ 直接 DB 造 PENDING booking + pin 舊客（令 create 舊客 gate 通過）。
# 直接 SQL（同 T9/T32 慣例）；BookingRequest 無 FK cascade → T64 hermetic 段補 DELETE。
LOCK_BOOK_ID="e2e_h1_lock_book_$EPOCH"
q "UPDATE \"Conversation\" SET \"assigneeId\"='$TKW_STAFF_ID', \"pinnedPatientApricotId\"='e2e-h1-lock-pat', \"pinnedPatientName\"='E2E H1 Lock Patient' WHERE id='$H1_CONV'" >/dev/null
q "INSERT INTO \"BookingRequest\" (id, \"conversationId\", \"clinicId\", \"flowToken\", \"providerApricotId\", \"providerName\", \"requestedDate\", \"requestedTime\", \"status\") VALUES ('$LOCK_BOOK_ID', '$H1_CONV', '$TKW_CLINIC_ID', 'e2e-h1-lock-flow-$EPOCH', 'mock-pract-tkw-1', 'E2E H1 Lock Dr', '2026-09-02', '10:00', 'PENDING')" >/dev/null
check "T62b fixture：PENDING booking 已插" "$(q "SELECT count(*)::text n FROM \"BookingRequest\" WHERE id='$LOCK_BOOK_ID' AND \"status\"='PENDING'" | jf n)" "1"
# (a) B（非負責人）直接打 create route（唔經 UI）→ 423 SEND_LOCKED
h1_req "$COOKIE_H1B" POST "$BASE/api/bookings/$LOCK_BOOK_ID/create"
check "T62b B（非負責人）代落單 → 423" "$H1_CODE" "423"
grep -q '"error":"SEND_LOCKED"' "$H1_OUT" && pass "T62b 423 body = SEND_LOCKED" || { fail "T62b 423 body 錯"; H1=1; }
grep -qF "\"assigneeId\":\"$TKW_STAFF_ID\"" "$H1_OUT" && pass "T62b 423 body 帶 assigneeId" || { fail "T62b 423 body 無 assigneeId"; H1=1; }
# (b) A（負責人自己）唔會 423/500 — write-disabled flag 令 workforce 寫止住喺 503（booking 保持 PENDING，無 CONFIRMED/無訊息副作用）
printf '{"clinicCode":"TKW"}' > .dev/workforce-mock-write-disabled.json
h1_req "$COOKIE_TKW" POST "$BASE/api/bookings/$LOCK_BOOK_ID/create" '{"visitReasonId":"vr-0010"}'
rm -f .dev/workforce-mock-write-disabled.json
[ "$H1_CODE" != "423" ] && [ "$H1_CODE" != "500" ] && pass "T62b A（負責人）代落單唔係 423/500（actual=$H1_CODE）" || { fail "T62b A 代落單被 lock 或 500（actual=$H1_CODE）"; H1=1; }
check "T62b A 落單 → 503 WRITE_DISABLED（mock flag 決定性）" "$H1_CODE" "503"
grep -q '"error":"WRITE_DISABLED"' "$H1_OUT" && pass "T62b 503 body = WRITE_DISABLED" || { fail "T62b 503 body 錯"; H1=1; }
check "T62b booking 保持 PENDING（503 無改狀態）" "$(q "SELECT \"status\"::text s FROM \"BookingRequest\" WHERE id='$LOCK_BOOK_ID'" | jf s)" "PENDING"

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
q "DELETE FROM \"BookingRequest\" WHERE id='$LOCK_BOOK_ID'" >/dev/null 2>&1 || true
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
# ═══════════════════════════════════════════════════════════════
# Phase AI-T1 — AI Workflow T1（cwi-ai-20260824-t1；Kairo mt6yt85v4yi3v）
#   P0 retention purge + Phase A（AUTO 七閘 + 媒體 StaffNotice 內部通知軌）
#   ★ 必須喺 R9 chaos 之前跑（T81 redis SHUTDOWN NOSAVE 會清掉未消費 job）
# ═══════════════════════════════════════════════════════════════

# ── T82. P0 retention-purge：超期 fixture → 手動 enqueue → 斷言刪除 + 未到期零觸碰 ──
echo "[AI-T1] T82: retention-purge (P0)..."
T82=0
RET_C="ret-c-${EPOCH}"
RET_CONV="ret-conv-${EPOCH}"
M_OLD_TEXT="ret-m-oldtext-${EPOCH}"    # 25mo → 全刪（連 NoteReadReceipt + PatientFact）
M_OLD_MEDIA="ret-m-oldmedia-${EPOCH}"  # 13mo + 媒體檔 → 刪檔 + mediaPath=null（殼留）
M_SHELL="ret-m-shell-${EPOCH}"         # 13mo 無媒體 → 殼保留到 24mo
M_MEDIA_KEEP="ret-m-keep-${EPOCH}"     # 11mo + 媒體檔 → 零觸碰（未到期）
D_OLD_DISC="ret-d-old-${EPOCH}"        # 100d DISCARDED → 刪
D_KEEP_PROP="ret-d-prop-${EPOCH}"      # 100d PROPOSED → 留（staff 未審批）
D_NEW_DISC="ret-d-new-${EPOCH}"        # 10d DISCARDED → 留（未 90d）
N_OLD="ret-n-old-${EPOCH}"             # 已讀 100d → 刪
N_RECENT="ret-n-recent-${EPOCH}"       # 已讀 10d → 留
N_UNREAD="ret-n-unread-${EPOCH}"       # 未讀 → 留
T25MO=$(date -u -d "-25 months" +%Y-%m-%dT%H:%M:%SZ)
T13MO=$(date -u -d "-13 months" +%Y-%m-%dT%H:%M:%SZ)
T11MO=$(date -u -d "-11 months" +%Y-%m-%dT%H:%M:%SZ)
T100D=$(date -u -d "-100 days" +%Y-%m-%dT%H:%M:%SZ)
T10D=$(date -u -d "-10 days" +%Y-%m-%dT%H:%M:%SZ)
NOWISO=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
RET_MEDIA_OLD="$WA_MEDIA_DIR/ret-old-${EPOCH}.bin"
RET_MEDIA_KEEP="$WA_MEDIA_DIR/ret-keep-${EPOCH}.bin"
echo "e2e-retention-fixture" > "$RET_MEDIA_OLD"
echo "e2e-retention-fixture" > "$RET_MEDIA_KEEP"
MF_STAFF_ID=$(q "SELECT id FROM \"StaffUser\" WHERE \"clinicId\"='$MF_CLINIC_ID' AND role='STAFF' LIMIT 1" | jf id)
[ -n "$MF_STAFF_ID" ] || { fail "T82 fixture: MF staff 搵唔到"; T82=1; }
q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\", \"profileName\", labels) VALUES ('$RET_C', '$MF_CLINIC_ID', '8526099${EPOCH}', 'E2E RET', ARRAY[]::text[])" >/dev/null 2>&1
q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", status, \"lastMessageAt\") VALUES ('$RET_CONV', '$MF_CLINIC_ID', '$RET_C', 'OPEN', '$NOWISO')" >/dev/null 2>&1
q "INSERT INTO \"Message\" (id, \"conversationId\", direction, channel, type, body, \"mediaPath\", \"mediaStatus\", status, \"waTimestamp\") VALUES ('$M_OLD_TEXT', '$RET_CONV', 'IN', 'API', 'text', 'e2e retention old text', NULL, 'READY', 'RECEIVED', '$T25MO')" >/dev/null 2>&1
q "INSERT INTO \"Message\" (id, \"conversationId\", direction, channel, type, body, \"mediaPath\", \"mediaStatus\", status, \"waTimestamp\") VALUES ('$M_OLD_MEDIA', '$RET_CONV', 'IN', 'API', 'image', NULL, '$RET_MEDIA_OLD', 'READY', 'RECEIVED', '$T13MO')" >/dev/null 2>&1
q "INSERT INTO \"Message\" (id, \"conversationId\", direction, channel, type, body, \"mediaPath\", \"mediaStatus\", status, \"waTimestamp\") VALUES ('$M_SHELL', '$RET_CONV', 'IN', 'API', 'text', 'e2e retention shell', NULL, 'READY', 'RECEIVED', '$T13MO')" >/dev/null 2>&1
q "INSERT INTO \"Message\" (id, \"conversationId\", direction, channel, type, body, \"mediaPath\", \"mediaStatus\", status, \"waTimestamp\") VALUES ('$M_MEDIA_KEEP', '$RET_CONV', 'IN', 'API', 'image', NULL, '$RET_MEDIA_KEEP', 'READY', 'RECEIVED', '$T11MO')" >/dev/null 2>&1
q "INSERT INTO \"NoteReadReceipt\" (id, \"messageId\", \"staffId\") VALUES ('ret-nrr-${EPOCH}', '$M_OLD_TEXT', '$MF_STAFF_ID')" >/dev/null 2>&1
q "INSERT INTO \"PatientFact\" (id, \"contactId\", \"clinicId\", kind, text, \"sourceMessageId\") VALUES ('ret-pf-${EPOCH}', '$RET_C', '$MF_CLINIC_ID', 'LOGISTICS', 'e2e retention fact', '$M_OLD_TEXT')" >/dev/null 2>&1
q "INSERT INTO \"AiDraft\" (id, \"conversationId\", \"inReplyToMessageId\", \"draftText\", model, \"latencyMs\", status, \"createdAt\") VALUES ('$D_OLD_DISC', '$RET_CONV', '$M_OLD_TEXT', 'e2e old discarded', 'mock', 1, 'DISCARDED', '$T100D')" >/dev/null 2>&1
q "INSERT INTO \"AiDraft\" (id, \"conversationId\", \"inReplyToMessageId\", \"draftText\", model, \"latencyMs\", status, \"createdAt\") VALUES ('$D_KEEP_PROP', '$RET_CONV', '$M_SHELL', 'e2e keep proposed', 'mock', 1, 'PROPOSED', '$T100D')" >/dev/null 2>&1
q "INSERT INTO \"AiDraft\" (id, \"conversationId\", \"inReplyToMessageId\", \"draftText\", model, \"latencyMs\", status, \"createdAt\") VALUES ('$D_NEW_DISC', '$RET_CONV', '$M_MEDIA_KEEP', 'e2e new discarded', 'mock', 1, 'DISCARDED', '$T10D')" >/dev/null 2>&1
q "INSERT INTO \"StaffNotice\" (id, \"clinicId\", \"conversationId\", kind, title, \"readByStaffId\", \"readAt\") VALUES ('$N_OLD', '$MF_CLINIC_ID', '$RET_CONV', 'MEDIA_RECEIVED', 'e2e retention notice', '$MF_STAFF_ID', '$T100D')" >/dev/null 2>&1
q "INSERT INTO \"StaffNotice\" (id, \"clinicId\", \"conversationId\", kind, title, \"readByStaffId\", \"readAt\") VALUES ('$N_RECENT', '$MF_CLINIC_ID', '$RET_CONV', 'MEDIA_RECEIVED', 'e2e retention notice', '$MF_STAFF_ID', '$T10D')" >/dev/null 2>&1
q "INSERT INTO \"StaffNotice\" (id, \"clinicId\", \"conversationId\", kind, title) VALUES ('$N_UNREAD', '$MF_CLINIC_ID', '$RET_CONV', 'MEDIA_RECEIVED', 'e2e retention notice')" >/dev/null 2>&1

pnpm -s e2e:cron retention-purge >/dev/null 2>&1 || { fail "T82 e2e:cron retention-purge enqueue"; T82=1; }
# 24 月訊息消失 = purge 跑完 marker（之後先斷言其餘）
if wait_for "SELECT count(*)::text c FROM \"Message\" WHERE id='$M_OLD_TEXT'" '[{"c":"0"}]' 90; then
  pass "T82 24 月 Message 刪除（purge 跑完）"
else
  fail "T82 24 月 Message 未刪"; T82=1
fi
check "T82 25mo text 訊息 + NoteReadReceipt 連刪" "$(q "SELECT count(*)::text c FROM \"NoteReadReceipt\" WHERE \"messageId\"='$M_OLD_TEXT'" | jf c)" "0"
check "T82 PatientFact(sourceMessageId) 連刪" "$(q "SELECT count(*)::text c FROM \"PatientFact\" WHERE \"sourceMessageId\"='$M_OLD_TEXT'" | jf c)" "0"
check "T82 13mo 無媒體訊息殼保留到 24mo" "$(q "SELECT count(*)::text c FROM \"Message\" WHERE id='$M_SHELL'" | jf c)" "1"
check "T82 13mo 媒體訊息 mediaPath 清 null" "$(q "SELECT (\"mediaPath\" IS NULL)::text n FROM \"Message\" WHERE id='$M_OLD_MEDIA'" | jf n)" "true"
[ ! -f "$RET_MEDIA_OLD" ] && pass "T82 過期媒體檔碟上已刪" || { fail "T82 過期媒體檔仍在碟上"; T82=1; }
check "T82 11mo 媒體 mediaPath 零觸碰（未到期）" "$(q "SELECT \"mediaPath\" FROM \"Message\" WHERE id='$M_MEDIA_KEEP'" | jf mediaPath)" "$RET_MEDIA_KEEP"
[ -f "$RET_MEDIA_KEEP" ] && pass "T82 11mo 媒體檔碟上保留（未到期）" || { fail "T82 未到期媒體檔被誤刪"; T82=1; }
check "T82 AiDraft 100d DISCARDED 刪" "$(q "SELECT count(*)::text c FROM \"AiDraft\" WHERE id='$D_OLD_DISC'" | jf c)" "0"
check "T82 AiDraft 100d PROPOSED 保留（staff 未審批）" "$(q "SELECT count(*)::text c FROM \"AiDraft\" WHERE id='$D_KEEP_PROP'" | jf c)" "1"
check "T82 AiDraft 10d DISCARDED 保留（未 90d）" "$(q "SELECT count(*)::text c FROM \"AiDraft\" WHERE id='$D_NEW_DISC'" | jf c)" "1"
check "T82 StaffNotice 已讀 100d 刪" "$(q "SELECT count(*)::text c FROM \"StaffNotice\" WHERE id='$N_OLD'" | jf c)" "0"
check "T82 StaffNotice 已讀 10d 保留" "$(q "SELECT count(*)::text c FROM \"StaffNotice\" WHERE id='$N_RECENT'" | jf c)" "1"
check "T82 StaffNotice 未讀保留" "$(q "SELECT count(*)::text c FROM \"StaffNotice\" WHERE id='$N_UNREAD'" | jf c)" "1"
T82_OP=$(q "SELECT count(*)::text c FROM \"OpsReport\" WHERE \"clinicId\"='' AND \"periodStart\"::date = CURRENT_DATE" | jf c)
[ -n "$T82_OP" ] && [ "$T82_OP" -ge 1 ] && pass "T82 OpsReport 落庫（當日 run 記錄）" || { fail "T82 OpsReport 未落庫（count=$T82_OP）"; T82=1; }
grep -q "retention-purge: done" /tmp/e2e-worker*.log 2>/dev/null && pass "T82 log metadata only（retention-purge: done + counts）" || { fail "T82 retention-purge log"; T82=1; }
# hermetic：清 fixture 殘留
q "DELETE FROM \"StaffNotice\" WHERE id IN ('$N_RECENT','$N_UNREAD')" >/dev/null 2>&1
q "DELETE FROM \"AiDraft\" WHERE id IN ('$D_KEEP_PROP','$D_NEW_DISC')" >/dev/null 2>&1
q "DELETE FROM \"Message\" WHERE id IN ('$M_SHELL','$M_MEDIA_KEEP')" >/dev/null 2>&1
q "DELETE FROM \"Conversation\" WHERE id='$RET_CONV'" >/dev/null 2>&1
q "DELETE FROM \"Contact\" WHERE id='$RET_C'" >/dev/null 2>&1
rm -f "$RET_MEDIA_KEEP" "$RET_MEDIA_OLD"
[ "$T82" = 0 ] && pass "T82 P0 retention-purge 全鏈（刪除 + 未到期零觸碰 + OpsReport）" || fail "T82 retention-purge 有項失敗（見上 ❌）"

# ── T83. A1 七閘：AUTO + assignee → 只出 draft 唔自動發（log assigned） ─────────
echo "[AI-T1] T83: AUTO + assigned gate..."
T83=0
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_ADMIN" -X PATCH "$BASE/api/admin/clinics/$MF_CLINIC_ID" -H 'Content-Type: application/json' -d '{"aiMode":"AUTO"}')
check "T83 MF→AUTO" "$CODE" "200"
P_T83="8526101${EPOCH}"; WAMID_T83="wamid.E2E_T83_${EPOCH}"; C_T83="t83-c-${EPOCH}"; CONV_T83="t83-conv-${EPOCH}"
q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\", \"profileName\", labels) VALUES ('$C_T83', '$MF_CLINIC_ID', '$P_T83', 'E2E T83', ARRAY[]::text[])" >/dev/null 2>&1
q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", status, \"lastMessageAt\") VALUES ('$CONV_T83', '$MF_CLINIC_ID', '$C_T83', 'OPEN', '$NOWISO')" >/dev/null 2>&1
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_ADMIN" -X POST "$BASE/api/conversations/$CONV_T83/assign" -H 'Content-Type: application/json' -d "{\"toStaffId\":\"$MF_STAFF_ID\",\"assignVersion\":0}")
check "T83 assign 俾 MF staff → 200" "$CODE" "200"
pnpm -s mock-inbound message --clinic MF --from "$P_T83" --text "想預約下週有冇位" --wamid "$WAMID_T83" --name "E2E T83 assigned" >/dev/null || fail "T83 mock-inbound POST"
M_T83=$(q "SELECT id FROM \"Message\" WHERE \"waMessageId\"='$WAMID_T83'" | jf id)
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$M_T83'" '[{"s":"PROPOSED"}]' 30; then
  pass "T83 assigned：draft 照出（PROPOSED 俾 staff）"
else
  fail "T83 assigned draft"; T83=1
fi
sleep 2
OUT_T83=$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$CONV_T83' AND direction='OUT' AND channel<>'INTERNAL'" | jf c)
check "T83 assigned：唔自動發（0 OUT 訊息）" "$OUT_T83" "0"
grep -F "$WAMID_T83" /tmp/e2e-worker*.log 2>/dev/null | grep -q "not eligible" && pass "T83 AUTO fallback log（not eligible）" || { fail "T83 not eligible log"; T83=1; }
grep -F "$WAMID_T83" /tmp/e2e-worker*.log 2>/dev/null | grep -q '"assigned"' && pass "T83 log reasons 見 assigned（Send Lock 語義補完）" || { fail "T83 assigned log"; T83=1; }
q "DELETE FROM \"AiDraft\" WHERE \"conversationId\"='$CONV_T83'" >/dev/null 2>&1
q "DELETE FROM \"Message\" WHERE \"conversationId\"='$CONV_T83'" >/dev/null 2>&1
q "DELETE FROM \"Conversation\" WHERE id='$CONV_T83'" >/dev/null 2>&1
q "DELETE FROM \"Contact\" WHERE id='$C_T83'" >/dev/null 2>&1
[ "$T83" = 0 ] && pass "T83 A1 閘：assigned" || fail "T83 assigned 閘有項失敗（見上 ❌）"

# ── T84. A1 七閘：RESOLVED 對話病人翻頭一句 → 唔自動發（log resolved） ──────
echo "[AI-T1] T84: AUTO + resolved gate..."
T84=0
P_T84="8526102${EPOCH}"; WAMID_T84="wamid.E2E_T84_${EPOCH}"; C_T84="t84-c-${EPOCH}"; CONV_T84="t84-conv-${EPOCH}"
q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\", \"profileName\", labels) VALUES ('$C_T84', '$MF_CLINIC_ID', '$P_T84', 'E2E T84', ARRAY[]::text[])" >/dev/null 2>&1
q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", status, \"lastMessageAt\") VALUES ('$CONV_T84', '$MF_CLINIC_ID', '$C_T84', 'RESOLVED', '$NOWISO')" >/dev/null 2>&1
pnpm -s mock-inbound message --clinic MF --from "$P_T84" --text "想預約下週有冇位" --wamid "$WAMID_T84" --name "E2E T84 resolved" >/dev/null || fail "T84 mock-inbound POST"
M_T84=$(q "SELECT id FROM \"Message\" WHERE \"waMessageId\"='$WAMID_T84'" | jf id)
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$M_T84'" '[{"s":"PROPOSED"}]' 30; then
  pass "T84 resolved：draft 照出（PROPOSED）"
else
  fail "T84 resolved draft"; T84=1
fi
sleep 2
OUT_T84=$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$CONV_T84' AND direction='OUT' AND channel<>'INTERNAL'" | jf c)
check "T84 resolved：唔自動發（0 OUT 訊息）" "$OUT_T84" "0"
grep -F "$WAMID_T84" /tmp/e2e-worker*.log 2>/dev/null | grep -q '"resolved"' && pass "T84 log reasons 見 resolved" || { fail "T84 resolved log"; T84=1; }
q "DELETE FROM \"AiDraft\" WHERE \"conversationId\"='$CONV_T84'" >/dev/null 2>&1
q "DELETE FROM \"Message\" WHERE \"conversationId\"='$CONV_T84'" >/dev/null 2>&1
q "DELETE FROM \"Conversation\" WHERE id='$CONV_T84'" >/dev/null 2>&1
q "DELETE FROM \"Contact\" WHERE id='$C_T84'" >/dev/null 2>&1
[ "$T84" = 0 ] && pass "T84 A1 閘：resolved" || fail "T84 resolved 閘有項失敗（見上 ❌）"

# ── T85. A1 第八閘：員工人手覆完 cooldown 內 AI 唔搶咪（log human-recent） ──
echo "[AI-T1] T85: AUTO + human-recent gate..."
T85=0
P_T85="8526103${EPOCH}"; WAMID_T85="wamid.E2E_T85_${EPOCH}"; C_T85="t85-c-${EPOCH}"; CONV_T85="t85-conv-${EPOCH}"
q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\", \"profileName\", labels) VALUES ('$C_T85', '$MF_CLINIC_ID', '$P_T85', 'E2E T85', ARRAY[]::text[])" >/dev/null 2>&1
q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", status, \"lastMessageAt\") VALUES ('$CONV_T85', '$MF_CLINIC_ID', '$C_T85', 'OPEN', '$NOWISO')" >/dev/null 2>&1
# 員工人手覆（直接落 DB：OUT + sentByStaffId 非 null — 唔經 send route 避免 auto-claim 混淆 assigned 閘）
q "INSERT INTO \"Message\" (id, \"conversationId\", direction, channel, type, body, \"mediaStatus\", status, \"sentByStaffId\", \"waTimestamp\") VALUES ('t85-staff-out-${EPOCH}', '$CONV_T85', 'OUT', 'API', 'text', 'e2e staff manual reply', 'READY', 'SENT', '$MF_STAFF_ID', '$NOWISO')" >/dev/null 2>&1
pnpm -s mock-inbound message --clinic MF --from "$P_T85" --text "想預約下週有冇位" --wamid "$WAMID_T85" --name "E2E T85 human-recent" >/dev/null || fail "T85 mock-inbound POST"
M_T85=$(q "SELECT id FROM \"Message\" WHERE \"waMessageId\"='$WAMID_T85'" | jf id)
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$M_T85'" '[{"s":"PROPOSED"}]' 30; then
  pass "T85 human-recent：draft 照出（PROPOSED）"
else
  fail "T85 human-recent draft"; T85=1
fi
sleep 2
OUT_T85=$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$CONV_T85' AND direction='OUT' AND \"aiAutoSent\"=true" | jf c)
check "T85 human-recent：cooldown 內 AI 唔搶咪（0 自動發 OUT）" "$OUT_T85" "0"
grep -F "$WAMID_T85" /tmp/e2e-worker*.log 2>/dev/null | grep -q '"human-recent"' && pass "T85 log reasons 見 human-recent（30 分鐘冷靜期）" || { fail "T85 human-recent log"; T85=1; }
q "DELETE FROM \"AiDraft\" WHERE \"conversationId\"='$CONV_T85'" >/dev/null 2>&1
q "DELETE FROM \"Message\" WHERE \"conversationId\"='$CONV_T85'" >/dev/null 2>&1
q "DELETE FROM \"Conversation\" WHERE id='$CONV_T85'" >/dev/null 2>&1
q "DELETE FROM \"Contact\" WHERE id='$C_T85'" >/dev/null 2>&1
[ "$T85" = 0 ] && pass "T85 A1 閘：human-recent" || fail "T85 human-recent 閘有項失敗（見上 ❌）"

# ── T86. A2 媒體：客戶端零回覆 + StaffNotice 落庫 + bell +1 + AiDraft 零新增 ──
echo "[AI-T1] T86: media → StaffNotice (no reply to client)..."
T86=0
P_T86="8526104${EPOCH}"; WAMID_T86="wamid.E2E_T86_${EPOCH}"; C_T86="t86-c-${EPOCH}"; CONV_T86="t86-conv-${EPOCH}"
q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\", \"profileName\", labels) VALUES ('$C_T86', '$MF_CLINIC_ID', '$P_T86', 'E2E T86', ARRAY[]::text[])" >/dev/null 2>&1
q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", status, \"lastMessageAt\") VALUES ('$CONV_T86', '$MF_CLINIC_ID', '$C_T86', 'OPEN', '$NOWISO')" >/dev/null 2>&1
# hermetic：T43（現有媒體測試）會落 MF MEDIA_RECEIVED 通知 — 清晒先確保 count 準確
q "DELETE FROM \"StaffNotice\" WHERE \"clinicId\"='$MF_CLINIC_ID'" >/dev/null 2>&1
pnpm -s mock-inbound message --clinic MF --from "$P_T86" --text "e2e T86 photo" --media image --wamid "$WAMID_T86" --name "E2E T86 media" >/dev/null || fail "T86 mock-inbound media POST"
M_T86=$(q "SELECT id FROM \"Message\" WHERE \"waMessageId\"='$WAMID_T86'" | jf id)
check "T86 媒體訊息落庫 type=image" "$(q "SELECT \"type\"::text t FROM \"Message\" WHERE id='$M_T86'" | jf t)" "image"
# 等 AI job 跑完（StaffNotice 落庫 = marker）
if wait_for "SELECT count(*)::text c FROM \"StaffNotice\" WHERE \"conversationId\"='$CONV_T86' AND kind='MEDIA_RECEIVED'" '[{"c":"1"}]' 30; then
  pass "T86 StaffNotice(MEDIA_RECEIVED) 落庫（bell +1 數據源）"
else
  fail "T86 StaffNotice 未落庫"; T86=1
fi
sleep 2
OUT_T86=$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$CONV_T86' AND direction='OUT' AND channel<>'INTERNAL'" | jf c)
check "T86 媒體訊息：客戶端零回覆（0 OUT）" "$OUT_T86" "0"
check "T86 媒體訊息：AiDraft 零新增（canDraft 限 text）" "$(q "SELECT count(*)::text c FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$M_T86'" | jf c)" "0"
INT_T86=$(q "SELECT (\"intent\" IS NOT NULL)::text i FROM \"Conversation\" WHERE id='$CONV_T86'" | jf i)
check "T86 分類照行（intent 欄照更新）" "$INT_T86" "true"
NOTICE_JSON=$(curl -s -b "$COOKIE_MF" "$BASE/api/notices")
NOTICE_CNT=$(echo "$NOTICE_JSON" | grep -oE '"count":[0-9]+' | head -1 | cut -d: -f2)
check "T86 GET /api/notices（MF staff）未讀含呢條（bell +1）" "$NOTICE_CNT" "1"
echo "$NOTICE_JSON" | grep -q "$CONV_T86" && pass "T86 /api/notices 回傳含該對話 id" || { fail "T86 /api/notices 內容"; T86=1; }
# PATCH 標已讀 → 再 GET = 0
NOTICE_ID_T86=$(q "SELECT id FROM \"StaffNotice\" WHERE \"conversationId\"='$CONV_T86' AND kind='MEDIA_RECEIVED'" | jf id)
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_MF" -X PATCH "$BASE/api/notices" -H 'Content-Type: application/json' -d "{\"ids\":[\"$NOTICE_ID_T86\"]}")
check "T86 PATCH /api/notices 標已讀 → 200" "$CODE" "200"
NOTICE_CNT2=$(curl -s -b "$COOKIE_MF" "$BASE/api/notices" | grep -oE '"count":[0-9]+' | head -1 | cut -d: -f2)
check "T86 標已讀後未讀清零" "$NOTICE_CNT2" "0"
check "T86 StaffNotice readAt 已落" "$(q "SELECT (\"readAt\" IS NOT NULL)::text r FROM \"StaffNotice\" WHERE id='$NOTICE_ID_T86'" | jf r)" "true"
# hermetic 清理
q "DELETE FROM \"StaffNotice\" WHERE \"conversationId\"='$CONV_T86'" >/dev/null 2>&1
q "DELETE FROM \"Message\" WHERE \"conversationId\"='$CONV_T86'" >/dev/null 2>&1
q "DELETE FROM \"Conversation\" WHERE id='$CONV_T86'" >/dev/null 2>&1
q "DELETE FROM \"Contact\" WHERE id='$C_T86'" >/dev/null 2>&1
[ "$T86" = 0 ] && pass "T86 A2 媒體→StaffNotice 全鏈（零覆客 + 落庫 + bell + 標已讀）" || fail "T86 媒體通知有項失敗（見上 ❌）"

# ── T87. hermetic：MF 還原 DRAFT（T19 只改咗 TKW；MF 由 T83 起轉 AUTO） ────────
echo "[AI-T1] T87: restore MF DRAFT (hermetic)..."
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_ADMIN" -X PATCH "$BASE/api/admin/clinics/$MF_CLINIC_ID" -H 'Content-Type: application/json' -d '{"aiMode":"DRAFT"}')
check "T87 MF 還原 DRAFT" "$CODE" "200"

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

# ── T88-T92. Phase B：template 發送鏈 + T-24h 預約提醒（cwi-tmpl-20260824-b1）──
echo "[12/12] T88-T92: Phase B template + T-24h reminder..."
T88=0
# 窗口 fixture 時刻：now+24h（HK）— 確保落入 23–25h 提醒窗口（單位测试已證邊界）
REM_D=$(TZ=Asia/Hong_Kong date -d '+24 hours' +%F)
REM_T=$(TZ=Asia/Hong_Kong date -d '+24 hours' +%H:%M)
REM2_D=$(TZ=Asia/Hong_Kong date -d '+26 hours' +%F)   # 窗口外（T92 用：route 發送唔受窗口限制）
REM2_T=$(TZ=Asia/Hong_Kong date -d '+26 hours' +%H:%M)
DL_REM=$(TZ=Asia/Hong_Kong date -d '+24 hours' '+%-m月%-d日')
# ★ EPOCH-scoped fixture id（重跑慣例 — 固定 id 會喺共享 DB 撞 PK；2026-08-24 T2 驗證回報修復）
BOOK_T88="bk-e2e-t88-${EPOCH}"
BOOK_T89="bk-e2e-t89-${EPOCH}"
BOOK_T90="bk-e2e-t90-${EPOCH}"
BOOK_T91="bk-e2e-t91-${EPOCH}"
BOOK_T92="bk-e2e-t92-${EPOCH}"

# fixture helper：新病人對話（mock-inbound 真路徑）+ 直插 BookingRequest
# 用法：mk_rem_bk <book-id> <wa-phone> <wamid> <name> <status> <date> <time> → 設 REMB_CONV
mk_rem_bk() {
  local bid="$1" pat="$2" wamid="$3" nm="$4" st="$5" d="$6" t="$7"
  pnpm -s mock-inbound message --clinic TKW --from "$pat" --text "e2e phase-b fixture $bid" --wamid "$wamid" --name "$nm" >/dev/null 2>&1 || return 1
  local conv=""
  for i in $(seq 1 30); do
    conv=$(q "SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$pat'" | jf id)
    [ -n "$conv" ] && break
    sleep 1
  done
  [ -n "$conv" ] || return 1
  q "INSERT INTO \"BookingRequest\" (id, \"conversationId\", \"clinicId\", \"flowToken\", \"providerApricotId\", \"providerName\", \"requestedDate\", \"requestedTime\", status, \"apricotApptId\", \"createdAt\") VALUES ('$bid', '$conv', '$TKW_CLINIC_ID', 'e2e-$bid-$EPOCH', 'mock-pract-tkw-1', '陳明軒（主理）', '$d', '$t', '$st', 'mock-appt-$bid', now())" >/dev/null 2>&1 || return 1
  REMB_CONV="$conv"
}

# ── T88. T-24h 提醒：窗口內 CONFIRMED 單 → template SENT + remindedAt；二掃冪等（零重發）──
echo "[12/12] T88: reminder scan → template SENT + idempotent..."
T88=0
mk_rem_bk "$BOOK_T88" "852648${EPOCH}" "wamid.E2E_T88_${EPOCH}" "E2E-T88" CONFIRMED "$REM_D" "$REM_T" || { fail "T88 fixture 建立失敗"; T88=1; }
if [ "$T88" = 0 ]; then
  pnpm -s e2e:cron reminder-scan >/dev/null 2>&1 || T88=1
  if wait_for "SELECT (count(*) > 0)::text c FROM \"Message\" WHERE \"conversationId\"='$REMB_CONV' AND direction='OUT' AND type='template' AND status='SENT' AND \"templateMeta\" IS NOT NULL" '[{"c":"true"}]' 45; then
    pass "T88 窗口內 CONFIRMED 單 → template Message SENT（mock Graph）"
  else
    fail "T88 template Message 未 SENT"
    T88=1
  fi
  check "T88 templateMeta.name = appt_reminder_zh" "$(q "SELECT (\"templateMeta\"->>'name')::text n FROM \"Message\" WHERE \"conversationId\"='$REMB_CONV' AND type='template'" | jf n)" "appt_reminder_zh"
  check "T88 templateMeta.language = zh_HK" "$(q "SELECT (\"templateMeta\"->>'language')::text l FROM \"Message\" WHERE \"conversationId\"='$REMB_CONV' AND type='template'" | jf l)" "zh_HK"
  check "T88 預覽文字含 提提你 + $DL_REM" "$(q "SELECT (\"body\" LIKE '%提提你%' AND \"body\" LIKE '%$DL_REM%' AND \"body\" LIKE '%$REM_T%')::text n FROM \"Message\" WHERE \"conversationId\"='$REMB_CONV' AND type='template'" | jf n)" "true"
  check "T88 waMessageId = mock-wamid-*（mock 發送）" "$(q "SELECT left(\"waMessageId\",11)::text p FROM \"Message\" WHERE \"conversationId\"='$REMB_CONV' AND type='template'" | jf p)" "mock-wamid-"
  check "T88 remindedAt 已寫（冪等旗）" "$(q "SELECT (\"remindedAt\" IS NOT NULL)::text n FROM \"BookingRequest\" WHERE id='$BOOK_T88'" | jf n)" "true"
  # 冪等：第二遍掃 → 零新 template Message（remindedAt 旗 + status 門）
  pnpm -s e2e:cron reminder-scan >/dev/null 2>&1 || T88=1
  sleep 5
  check "T88 二掃後 template Message 仍 = 1（零重發）" "$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$REMB_CONV' AND type='template'" | jf c)" "1"
fi
[ "$T88" = 0 ] && pass "T88 T-24h 提醒冪等鏈（掃→SENT→remindedAt→二掃零重發）" || fail "T88 提醒鏈（見上 ❌）"

# ── T89. 非 CONFIRMED（REJECTED/已取消）單 → 掃描 skip（零發送、remindedAt 留 null）──
echo "[12/12] T89: rejected booking skipped..."
T89=0
mk_rem_bk "$BOOK_T89" "852649${EPOCH}" "wamid.E2E_T89_${EPOCH}" "E2E-T89" REJECTED "$REM_D" "$REM_T" || { fail "T89 fixture 建立失敗"; T89=1; }
if [ "$T89" = 0 ]; then
  pnpm -s e2e:cron reminder-scan >/dev/null 2>&1 || T89=1
  sleep 5
  check "T89 REJECTED 單零 template Message" "$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$REMB_CONV' AND type='template'" | jf c)" "0"
  check "T89 remindedAt 仍 null（未提醒）" "$(q "SELECT (\"remindedAt\" IS NULL)::text n FROM \"BookingRequest\" WHERE id='$BOOK_T89'" | jf n)" "true"
  pass "T89 非 CONFIRMED 單 skip（零發送）"
fi

# ── T90. 發送失敗（WA_GRAPH_MOCK_FAIL）→ FAILED + remindedAt 已寫 + 恢復後二掃零重發 ──
echo "[12/12] T90: graph fail → FAILED + no resend..."
T90=0
pkill -f "src/workers/index.ts" 2>/dev/null || true
sleep 1
WA_GRAPH_MOCK_FAIL=1 nohup pnpm worker >/tmp/e2e-worker-t90.log 2>&1 &
for i in $(seq 1 30); do grep -q "all workers running" /tmp/e2e-worker-t90.log 2>/dev/null && break; sleep 1; done
mk_rem_bk "$BOOK_T90" "852650${EPOCH}" "wamid.E2E_T90_${EPOCH}" "E2E-T90" CONFIRMED "$REM_D" "$REM_T" || { fail "T90 fixture 建立失敗"; T90=1; }
if [ "$T90" = 0 ]; then
  pnpm -s e2e:cron reminder-scan >/dev/null 2>&1 || T90=1
  if wait_for "SELECT \"status\"::text s FROM \"Message\" WHERE \"conversationId\"='$REMB_CONV' AND type='template'" '[{"s":"FAILED"}]' 90; then
    pass "T90 graph 失敗 → Message FAILED（無假 SENT）"
  else
    fail "T90 Message 未 FAILED（actual=$(q "SELECT \"status\"::text s FROM \"Message\" WHERE \"conversationId\"='$REMB_CONV' AND type='template'" | jf s)）"
    T90=1
  fi
  check "T90 remindedAt 已寫（寧漏勿重 — 唔會再試）" "$(q "SELECT (\"remindedAt\" IS NOT NULL)::text n FROM \"BookingRequest\" WHERE id='$BOOK_T90'" | jf n)" "true"
  # 恢復正常 worker → 二掃 → 零重發（remindedAt 旗擋）
  pkill -f "src/workers/index.ts" 2>/dev/null || true
  sleep 1
  nohup pnpm worker >/tmp/e2e-worker-t90r.log 2>&1 &
  for i in $(seq 1 30); do grep -q "all workers running" /tmp/e2e-worker-t90r.log 2>/dev/null && break; sleep 1; done
  pnpm -s e2e:cron reminder-scan >/dev/null 2>&1 || T90=1
  sleep 5
  check "T90 恢復後二掃 → template Message 仍 = 1（FAILED，零重發）" "$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$REMB_CONV' AND type='template'" | jf c)" "1"
fi

# ── T91. 提醒後病人回覆 → 正常入 AI triage（conversation.intent 落庫）──
echo "[12/12] T91: post-reminder reply → triage..."
T91=0
mk_rem_bk "$BOOK_T91" "852651${EPOCH}" "wamid.E2E_T91_${EPOCH}" "E2E-T91" CONFIRMED "$REM_D" "$REM_T" || { fail "T91 fixture 建立失敗"; T91=1; }
if [ "$T91" = 0 ]; then
  pnpm -s e2e:cron reminder-scan >/dev/null 2>&1 || T91=1
  if wait_for "SELECT (count(*) > 0)::text c FROM \"Message\" WHERE \"conversationId\"='$REMB_CONV' AND type='template' AND status='SENT'" '[{"c":"true"}]' 45; then
    :; else fail "T91 提醒未 SENT"; T91=1; fi
  # 病人收到提醒後回覆（mock AI：預約意向 → BOOKING_REQUEST）
  pnpm -s mock-inbound message --clinic TKW --from "852651${EPOCH}" --text "你好，我想預約下週" --wamid "wamid.E2E_T91_REPLY_${EPOCH}" --name "E2E-T91" >/dev/null 2>&1 || T91=1
  if wait_for "SELECT \"intent\" i FROM \"Conversation\" WHERE id='$REMB_CONV'" '[{"i":"BOOKING_REQUEST"}]' 45; then
    pass "T91 提醒後病人回覆 → AI triage BOOKING_REQUEST（正常入隊）"
  else
    fail "T91 回覆未 triage（actual=$(q "SELECT \"intent\" i FROM \"Conversation\" WHERE id='$REMB_CONV'" | jf i)）"
    T91=1
  fi
fi

# ── T92. 過窗 422 帶 templates 欄 + templateName 發送（窗口外合法）+ 400 分支 ──
echo "[12/12] T92: window-closed 422 templates + template send..."
T92=0
mk_rem_bk "$BOOK_T92" "852652${EPOCH}" "wamid.E2E_T92_${EPOCH}" "E2E-T92" CONFIRMED "$REM2_D" "$REM2_T" || { fail "T92 fixture 執行失敗"; T92=1; }
if [ "$T92" = 0 ]; then
  # 製造過窗對話（lastInboundAt = 25h 前）
  q "UPDATE \"Conversation\" SET \"lastInboundAt\" = now() - interval '25 hours' WHERE id='$REMB_CONV'" >/dev/null 2>&1 || T92=1
  # 1) free-form 過窗 → 422 + templates 欄（APPROVED+UTILITY 名單）
  h1_req "$COOKIE_TKW" POST "$BASE/api/messages/send" "{\"conversationId\":\"$REMB_CONV\",\"body\":\"e2e T92 free-form closed window\"}"
  check "T92 過窗 free-form → 422" "$H1_CODE" "422"
  grep -q '"templates"' "$H1_OUT" && pass "T92 422 帶 templates 欄" || { fail "T92 422 冇 templates 欄"; T92=1; }
  grep -q '"appt_reminder_zh"' "$H1_OUT" && grep -q '"appointment_reminder"' "$H1_OUT" \
    && pass "T92 templates 含 APPROVED+UTILITY（appt_reminder_zh + appointment_reminder）" \
    || { fail "T92 templates 名單錯"; T92=1; }
  if grep -q '"new_arrival_intro"' "$H1_OUT"; then fail "T92 PENDING template 漏進名單"; T92=1; fi
  if grep -q '"checkup_promo_january"' "$H1_OUT"; then fail "T92 REJECTED template 漏進名單"; T92=1; fi
  # 2) templateName 發送（窗口外合法；自動攞對話 CONFIRMED booking 做變數）
  h1_req "$COOKIE_TKW" POST "$BASE/api/messages/send" "{\"conversationId\":\"$REMB_CONV\",\"templateName\":\"appt_reminder_zh\"}"
  check "T92 templateName 發送（窗口外）→ 202" "$H1_CODE" "202"
  T92_MID=$(grep -oE '"messageId":"[^"]*"' "$H1_OUT" | head -1 | cut -d'"' -f4)
  if wait_for "SELECT \"status\"::text s FROM \"Message\" WHERE id='$T92_MID'" '[{"s":"SENT"}]' 45; then
    pass "T92 template Message SENT（staff 覆，窗口外）"
  else
    fail "T92 template 未 SENT"
    T92=1
  fi
  check "T92 staff 發送（sentByStaffId 非空）" "$(q "SELECT (\"sentByStaffId\" IS NOT NULL)::text n FROM \"Message\" WHERE id='$T92_MID'" | jf n)" "true"
  # 3) 400 分支：approved 但冇 builder / 唔存在 / body+template 同傳
  h1_req "$COOKIE_TKW" POST "$BASE/api/messages/send" "{\"conversationId\":\"$REMB_CONV\",\"templateName\":\"appointment_reminder\"}"
  check "T92 approved 但冇 builder → 400 template_not_supported" "$(grep -oE '"error":"[^"]*"' "$H1_OUT" | head -1 | cut -d'"' -f4)" "template_not_supported"
  h1_req "$COOKIE_TKW" POST "$BASE/api/messages/send" "{\"conversationId\":\"$REMB_CONV\",\"templateName\":\"no_such_template\"}"
  check "T92 唔存在 template → 400 template_not_found" "$(grep -oE '"error":"[^"]*"' "$H1_OUT" | head -1 | cut -d'"' -f4)" "template_not_found"
  h1_req "$COOKIE_TKW" POST "$BASE/api/messages/send" "{\"conversationId\":\"$REMB_CONV\",\"body\":\"x\",\"templateName\":\"appt_reminder_zh\"}"
  check "T92 body+templateName 同傳 → 400" "$H1_CODE" "400"
fi

# ── R10 summary ─────────────────────────────────────────────────────────────
[ "$T88" = 0 ] && [ "$T89" = 0 ] && [ "$T90" = 0 ] && [ "$T91" = 0 ] && [ "$T92" = 0 ] \
  && pass "R10 Phase B e2e（T88-T92）" || fail "R10 Phase B 有項失敗（見上 ❌）"

# ══════════ Phase C：slot-filling 對話式預約 e2e（cwi-ai-20260824-t3）══════════
# 鐵律驗證：事實句全 engine 砌（斷言 reply byte-for-byte）/ L1/L2 店 byte-for-byte 不變
#（kill switch + 本節前所有 T14/T19-T27 無 policy row 跑舊鏈）/ commit-then-emit / jobId 冪等。
echo "[PC] Phase C: slot-filling session e2e (G1-G5 + S1/S2 + PatientFact) ..."
PC_FAIL=0

# ── PC setup：helpers + 重起 worker（乾浄 env + 預設 visit reason）+ 槽位選擇 ──
# 相對日期窗口（mock AI 只識聽日/後日/大後日 → +1/+2/+3）
PC_D1=$(date -d '+1 day' +%F); PC_D2=$(date -d '+2 day' +%F); PC_D3=$(date -d '+3 day' +%F)
# pc_pick <clinicId> <providerApricotId|''> <offset> → "providerApricotId|date"（15:00 open 槽）
pc_pick() {
  local prov="${2:-}"
  q "SELECT (\"providerApricotId\"||'|'||\"date\") v FROM \"AvailabilitySlot\" WHERE \"clinicId\"='$1' AND \"startTime\"='15:00' AND \"isOpen\"=true AND \"bookedCount\"=0 AND \"date\" IN ('$PC_D1','$PC_D2','$PC_D3')${prov:+ AND \"providerApricotId\"='$prov'} ORDER BY \"date\",\"providerApricotId\" LIMIT 1 OFFSET ${3:-0}" | jf v
}
pc_prov_name() { q "SELECT name FROM \"Provider\" WHERE \"apricotId\"='$1'" | jf name; }
pc_surname() { local n; n=$(pc_prov_name "$1"); echo "${n%% *}"; }
pc_date_kw() { case "$1" in "$PC_D1") echo "聽日";; "$PC_D2") echo "後日";; "$PC_D3") echo "大後日";; *) echo "";; esac; }
pc_conv_of() { q "SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$1' AND c.\"clinicId\"='$2' ORDER BY c.\"lastMessageAt\" DESC LIMIT 1" | jf id; }
pc_contact_of() { q "SELECT id FROM \"Contact\" WHERE \"waId\"='$1' AND \"clinicId\"='$2'" | jf id; }
pc_sess_replies() { q "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$1' AND \"direction\"='OUT' AND type='text' AND status='SENT' AND \"bookingSessionId\" IS NOT NULL" | jf c; }
pc_sess_reply() { # $1=convId $2=第幾條回覆（1-based）；q() 瞬時空 → retry x3
  local n="${2:-1}" out i
  for i in 1 2 3; do
    out=$(q "SELECT \"body\" b FROM \"Message\" WHERE \"conversationId\"='$1' AND \"direction\"='OUT' AND type='text' AND status='SENT' AND \"bookingSessionId\" IS NOT NULL ORDER BY \"waTimestamp\" ASC OFFSET $((n - 1)) LIMIT 1" | jf b)
    [ -n "$out" ] && break
    sleep 1
  done
  echo "$out"
}

# 重起 worker（PC 段用自己 env：預設 visit reason 俾 L4 AUTO_BOOK 用）
pkill -f "src/workers/index.ts" 2>/dev/null || true
sleep 1
export BOOKING_DEFAULT_VISIT_REASON_CODE=0021
nohup pnpm worker >/tmp/e2e-worker-pc.log 2>&1 &
WORKER_PID=$!
for i in $(seq 1 60); do grep -q "all workers running" /tmp/e2e-worker-pc.log 2>/dev/null && break; sleep 1; done
grep -q "all workers running" /tmp/e2e-worker-pc.log 2>/dev/null || { echo "  ❌ FATAL: PC worker 未起"; FAIL=$((FAIL + 1)); }

# 槽位選擇（決定性 djb2 grid — 執行時由 L2 查；T27 已 sync）
PC_SLOT1=$(pc_pick "$TKW_CLINIC_ID" "" 0)
[ -n "$PC_SLOT1" ] || { fail "PC setup：TKW 明日/後日/大後日 無任何 15:00 空槽（djb2 grid）"; PC_FAIL=1; }
if [ -n "$PC_SLOT1" ]; then
  PC_P1=${PC_SLOT1%%|*}; PC_D1S=${PC_SLOT1##*|}
  PC_S1_NAME=$(pc_prov_name "$PC_P1"); PC_S1_SUR=$(pc_surname "$PC_P1")
  # L3 店：TKW policy row（冪等 upsert — 重跑唔撞 unique；★ raw SQL 必帶 id — @default(cuid()) 係 Prisma client-level，DB 冇 default）
  PC1_POL=$(q "INSERT INTO \"AutomationPolicy\" (\"id\",\"clinicId\",\"category\",\"level\",\"updatedAt\") VALUES ('e2e-pc-tkw-l3','$TKW_CLINIC_ID','BOOKING_REQUEST','L3',now()) ON CONFLICT (\"clinicId\",\"category\") DO UPDATE SET \"level\"=EXCLUDED.\"level\" RETURNING \"id\"" | jf id)
  [ -n "$PC1_POL" ] || { fail "PC setup：TKW L3 policy INSERT 失敗（raw SQL 靜默錯）"; PC_FAIL=1; }

  # ── PC-G1. L3 全鏈（4 訊息 slot-filling → 綠色卡）+ 相對日期 + PatientFact 存在 ──
  echo "[PC] G1: L3 full chain (provider → 相對日期 → 15:00 → 確認) ..."
  PC1_WA="8526121${EPOCH}"; PC1_W1="wamid.E2E_PC1_1_${EPOCH}"
  pnpm -s mock-inbound message --clinic TKW --from "$PC1_WA" --text "想約${PC_S1_SUR}醫生洗牙" --wamid "$PC1_W1" --name "E2E PC1" >/dev/null 2>&1
  PC1_CONV=$(pc_conv_of "$PC1_WA" "$TKW_CLINIC_ID")
  if wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$PC1_CONV' AND \"direction\"='OUT' AND type='text' AND status='SENT' AND \"bookingSessionId\" IS NOT NULL" '[{"c":"1"}]' 45; then
    pass "PC-G1 r1 收到（候選時段 list）"
  else
    fail "PC-G1 r1 未收到（session 未開？）"; PC_FAIL=1
  fi
  PC1_SESS=$(q "SELECT id FROM \"BookingSession\" WHERE \"conversationId\"='$PC1_CONV'" | jf id)
  check "PC-G1 session 已開" "$(q "SELECT count(*)::text c FROM \"BookingSession\" WHERE \"conversationId\"='$PC1_CONV'" | jf c)" "1"
  check "PC-G1 session ACTIVE" "$(q "SELECT \"status\"::text s FROM \"BookingSession\" WHERE id='$PC1_SESS'" | jf s)" "ACTIVE"
  check "PC-G1 provider 已記" "$(q "SELECT (\"slots\"->>'providerApricotId') v FROM \"BookingSession\" WHERE id='$PC1_SESS'" | jf v)" "$PC_P1"
  PC1_R1=$(pc_sess_reply "$PC1_CONV" 1)
  case "$PC1_R1" in "收到！ 而家有以下時段："*) pass "PC-G1 r1 事實句 = engine 候選 list（零 LLM 事實）";; *) fail "PC-G1 r1 格式錯（[:0:0]）：${PC1_R1:0:80}"; PC_FAIL=1;; esac

  # 訊息 2：相對日期（聽日/後日/大後日 → +1/+2/+3 — mock 用 todayHk 換算，斷言 requestedDate 對上 bash 同日）
  PC1_KW=$(pc_date_kw "$PC_D1S")
  pnpm -s mock-inbound message --clinic TKW --from "$PC1_WA" --text "$PC1_KW" --wamid "wamid.E2E_PC1_2_${EPOCH}" --name "E2E PC1" >/dev/null 2>&1
  if wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$PC1_CONV' AND \"direction\"='OUT' AND type='text' AND status='SENT' AND \"bookingSessionId\" IS NOT NULL" '[{"c":"2"}]' 45; then
    pass "PC-G1 r2 收到（日期已濾候選）"
  else
    fail "PC-G1 r2 未收到"; PC_FAIL=1
  fi
  PC1_R2=$(pc_sess_reply "$PC1_CONV" 2)
  # 候選 list cap=5（MD C4 candidateText）— 15:00 唔一定喺前 5 項；事實鐵律斷言 = engine 砌 list 前綴（15:00 有效性由 confirmLine 逐字證明）
  case "$PC1_R2" in "收到！ 而家有以下時段："*) pass "PC-G1 r2 事實句 = engine 候選 list（日期已濾，${PC1_KW}）";; *) fail "PC-G1 r2 唔係候選 list：${PC1_R2:0:80}"; PC_FAIL=1;; esac

  # 訊息 3：15:00 → CONFIRMING + confirmLine
  pnpm -s mock-inbound message --clinic TKW --from "$PC1_WA" --text "三點啦" --wamid "wamid.E2E_PC1_3_${EPOCH}" --name "E2E PC1" >/dev/null 2>&1
  if wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$PC1_CONV' AND \"direction\"='OUT' AND type='text' AND status='SENT' AND \"bookingSessionId\" IS NOT NULL" '[{"c":"3"}]' 45; then
    pass "PC-G1 r3 收到（confirmLine）"
  else
    fail "PC-G1 r3 未收到"; PC_FAIL=1
  fi
  check "PC-G1 session CONFIRMING" "$(q "SELECT \"status\"::text s FROM \"BookingSession\" WHERE id='$PC1_SESS'" | jf s)" "CONFIRMING"
  PC1_MO=$((10#${PC_D1S:5:2})); PC1_DD=$((10#${PC_D1S:8:2}))
  check "PC-G1 confirmLine 逐字（engine 事實句）" "$(pc_sess_reply "$PC1_CONV" 3)" "收到！ 同你確認一次：${PC1_MO}月${PC1_DD}日 15:00 ${PC_S1_NAME}，啱唔啱？"

  # 訊息 4：確認 → COMPLETED + CREATE_CARD（L3）
  pnpm -s mock-inbound message --clinic TKW --from "$PC1_WA" --text "好呀" --wamid "wamid.E2E_PC1_4_${EPOCH}" --name "E2E PC1" >/dev/null 2>&1
  if wait_for "SELECT \"status\"::text s FROM \"BookingRequest\" WHERE \"conversationId\"='$PC1_CONV'" '[{"s":"PENDING"}]' 45; then
    pass "PC-G1 綠色卡 PENDING（precheck 過）"
  else
    fail "PC-G1 BookingRequest 未建"; PC_FAIL=1
  fi
  check "PC-G1 session COMPLETED" "$(q "SELECT \"status\"::text s FROM \"BookingSession\" WHERE id='$PC1_SESS'" | jf s)" "COMPLETED"
  check "PC-G1 卡 requestedDate（相對日期實證）" "$(q "SELECT \"requestedDate\" v FROM \"BookingRequest\" WHERE \"conversationId\"='$PC1_CONV'" | jf v)" "$PC_D1S"
  check "PC-G1 卡 requestedTime" "$(q "SELECT \"requestedTime\"::text v FROM \"BookingRequest\" WHERE \"conversationId\"='$PC1_CONV'" | jf v)" "15:00"
  check "PC-G1 卡 providerName 快照" "$(q "SELECT \"providerName\" v FROM \"BookingRequest\" WHERE \"conversationId\"='$PC1_CONV'" | jf v)" "$PC_S1_NAME"
  check "PC-G1 卡 precheckPassed" "$(q "SELECT (\"precheckPassed\")::text v FROM \"BookingRequest\" WHERE \"conversationId\"='$PC1_CONV'" | jf v)" "true"
  check "PC-G1 4 訊息 = 4 回覆（每條一次 LLM call、一條覆）" "$(pc_sess_replies "$PC1_CONV")" "4"
  check "PC-G1 收卡回覆逐字" "$(pc_sess_reply "$PC1_CONV" 4)" "收到！職員會好快幫你確認 🙂"

  # PatientFact #1（golden #1 後查存在）：COMPLETED 首次觸發、provider 固定模板、model=null、source=completion 前最後 IN text（writer 文檔化 1-step fallback）
  PC1_CONTACT=$(pc_contact_of "$PC1_WA" "$TKW_CLINIC_ID")
  check "PC-G1 PatientFact 恰 1 row" "$(q "SELECT count(*)::text c FROM \"PatientFact\" WHERE \"contactId\"='$PC1_CONTACT'" | jf c)" "1"
  check "PC-G1 PatientFact provider 模板" "$(q "SELECT text FROM \"PatientFact\" WHERE \"contactId\"='$PC1_CONTACT'" | jf text)" "預約偏好：${PC_S1_NAME}"
  check "PC-G1 PatientFact kind=PREFERENCE" "$(q "SELECT \"kind\"::text k FROM \"PatientFact\" WHERE \"contactId\"='$PC1_CONTACT'" | jf k)" "PREFERENCE"
  check "PC-G1 PatientFact model=null（deterministic 零 LLM）" "$(q "SELECT (\"model\" IS NULL)::text n FROM \"PatientFact\" WHERE \"contactId\"='$PC1_CONTACT'" | jf n)" "true"
  PC1_M3=$(q "SELECT id FROM \"Message\" WHERE \"waMessageId\"='wamid.E2E_PC1_3_${EPOCH}' AND \"direction\"='IN'" | jf id)
  check "PC-G1 PatientFact source=completion 前 IN 訊息" "$(q "SELECT (\"sourceMessageId\"='$PC1_M3')::text m FROM \"PatientFact\" WHERE \"contactId\"='$PC1_CONTACT'" | jf m)" "true"
fi

# ── PC-G2. L3 slot-taken（fill flag 填位 → 「滿咗」+ 候選重出 + session 續行）──
echo "[PC] G2: L3 slot-taken (fill flag) ..."
if [ -n "$PC_SLOT1" ]; then
  PC_SLOT2=$(pc_pick "$TKW_CLINIC_ID" "" 1)
  [ -n "$PC_SLOT2" ] || PC_SLOT2=$PC_SLOT1
  PC_P2=${PC_SLOT2%%|*}; PC_D2S=${PC_SLOT2##*|}
  PC_S2_SUR=$(pc_surname "$PC_P2")
  # 填位 flag（mock 填位形態：isOpen 照 true、bookedCount=1）
  [ -f .dev/workforce-mock-fill.json ] && cp .dev/workforce-mock-fill.json /tmp/pc-fill-flag.bak
  printf '[{"clinicCode":"TKW","providerApricotId":"%s","date":"%s","startTime":"15:00"}]' "$PC_P2" "$PC_D2S" > .dev/workforce-mock-fill.json
  # 自驗（in-process mock fetch）：flag 生效先繼續 — 路徑/內容錯係咗即刻響亮 fail（唔好等 90 秒 timeout）
  cat > /tmp/pc-fill-check.ts <<EOF2
import { fetchAvailability } from "$(pwd)/src/lib/workforce/client";
(async () => {
  const r: any = await fetchAvailability("TKW", "$PC_D1", "$PC_D3");
  const d = r.days.find((x: any) => x.date === "$PC_D2S");
  const p = d?.providers.find((x: any) => x.providerApricotId === "$PC_P2");
  const s = p?.slots.find((x: any) => x.start === "15:00");
  console.log(s ? String(s.bookedCount) : "missing");
})();
EOF2
  PC_FLAG_B=$( (set -a; . ./.env; set +a; ./node_modules/.bin/tsx /tmp/pc-fill-check.ts 2>/dev/null) )
  [ "$PC_FLAG_B" = "1" ] || { fail "PC-G2 fill flag 自驗失敗（in-process mock b=$PC_FLAG_B; flag file: $(cat .dev/workforce-mock-fill.json)）"; PC_FAIL=1; }
  # 強制 TKW L2 stale → sync job 重新 fetch（帶 flag）→ L2 落 b=1
  q "UPDATE \"AvailabilitySlot\" SET \"syncedAt\"=\"syncedAt\"-interval '1 hour' WHERE \"clinicId\"='$TKW_CLINIC_ID'" >/dev/null
  pnpm -s e2e:cron sync-availability >/dev/null 2>&1
  if wait_for "SELECT (\"bookedCount\")::text b FROM \"AvailabilitySlot\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND \"providerApricotId\"='$PC_P2' AND \"date\"='$PC_D2S' AND \"startTime\"='15:00'" '[{"b":"1"}]' 90; then
    pass "PC-G2 填位落 L2（bookedCount=1）"
  else
    fail "PC-G2 填位未生效（flag file: $(cat .dev/workforce-mock-fill.json)）"; PC_FAIL=1
  fi

  PC2_WA="8526122${EPOCH}"
  pnpm -s mock-inbound message --clinic TKW --from "$PC2_WA" --text "想約${PC_S2_SUR}醫生洗牙" --wamid "wamid.E2E_PC2_1_${EPOCH}" --name "E2E PC2" >/dev/null 2>&1
  PC2_CONV=$(pc_conv_of "$PC2_WA" "$TKW_CLINIC_ID")
  wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$PC2_CONV' AND \"direction\"='OUT' AND type='text' AND status='SENT' AND \"bookingSessionId\" IS NOT NULL" '[{"c":"1"}]' 45 || { fail "PC-G2 r1 未收到"; PC_FAIL=1; }
  PC2_SESS=$(q "SELECT id FROM \"BookingSession\" WHERE \"conversationId\"='$PC2_CONV'" | jf id)
  PC2_KW=$(pc_date_kw "$PC_D2S")
  pnpm -s mock-inbound message --clinic TKW --from "$PC2_WA" --text "$PC2_KW" --wamid "wamid.E2E_PC2_2_${EPOCH}" --name "E2E PC2" >/dev/null 2>&1
  wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$PC2_CONV' AND \"direction\"='OUT' AND type='text' AND status='SENT' AND \"bookingSessionId\" IS NOT NULL" '[{"c":"2"}]' 45 || { fail "PC-G2 r2 未收到"; PC_FAIL=1; }
  pnpm -s mock-inbound message --clinic TKW --from "$PC2_WA" --text "三點啦" --wamid "wamid.E2E_PC2_3_${EPOCH}" --name "E2E PC2" >/dev/null 2>&1
  wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$PC2_CONV' AND \"direction\"='OUT' AND type='text' AND status='SENT' AND \"bookingSessionId\" IS NOT NULL" '[{"c":"3"}]' 45 || { fail "PC-G2 r3 未收到"; PC_FAIL=1; }
  PC2_R3=$(pc_sess_reply "$PC2_CONV" 3)
  case "$PC2_R3" in *"唔好意思，呢個時段啱啱滿咗。而家有以下時段："*) pass "PC-G2 slot-taken 事實句逐字（滿咗 + 候選重出）";; *) fail "PC-G2 r3 唔係 slot-taken：${PC2_R3:0:80}"; PC_FAIL=1;; esac
  check "PC-G2 session 續行（ACTIVE）" "$(q "SELECT \"status\"::text s FROM \"BookingSession\" WHERE id='$PC2_SESS'" | jf s)" "ACTIVE"
  check "PC-G2 time 清回 null（等揀新時段）" "$(q "SELECT (\"slots\"->>'time' IS NULL)::text n FROM \"BookingSession\" WHERE id='$PC2_SESS'" | jf n)" "true"

  # 續行實證：改另一日（同 provider 另一 open 15:00）→ 收卡
  PC_D3S=$(q "SELECT \"date\" v FROM \"AvailabilitySlot\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND \"providerApricotId\"='$PC_P2' AND \"startTime\"='15:00' AND \"isOpen\"=true AND \"bookedCount\"=0 AND \"date\"!='$PC_D2S' AND \"date\" IN ('$PC_D1','$PC_D2','$PC_D3') ORDER BY \"date\" LIMIT 1" | jf v)
  if [ -n "$PC_D3S" ]; then
    pnpm -s mock-inbound message --clinic TKW --from "$PC2_WA" --text "$(pc_date_kw "$PC_D3S")" --wamid "wamid.E2E_PC2_4_${EPOCH}" --name "E2E PC2" >/dev/null 2>&1
    wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$PC2_CONV' AND \"direction\"='OUT' AND type='text' AND status='SENT' AND \"bookingSessionId\" IS NOT NULL" '[{"c":"4"}]' 45 || { fail "PC-G2 r4 未收到"; PC_FAIL=1; }
    pnpm -s mock-inbound message --clinic TKW --from "$PC2_WA" --text "三點啦" --wamid "wamid.E2E_PC2_5_${EPOCH}" --name "E2E PC2" >/dev/null 2>&1
    wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$PC2_CONV' AND \"direction\"='OUT' AND type='text' AND status='SENT' AND \"bookingSessionId\" IS NOT NULL" '[{"c":"5"}]' 45 || { fail "PC-G2 r5 未收到"; PC_FAIL=1; }
    pnpm -s mock-inbound message --clinic TKW --from "$PC2_WA" --text "好呀" --wamid "wamid.E2E_PC2_6_${EPOCH}" --name "E2E PC2" >/dev/null 2>&1
    if wait_for "SELECT \"status\"::text s FROM \"BookingRequest\" WHERE \"conversationId\"='$PC2_CONV'" '[{"s":"PENDING"}]' 45; then
      pass "PC-G2 session 續行改期 → 收卡（COMPLETED）"
    else
      fail "PC-G2 續行未收卡"; PC_FAIL=1
    fi
  else
    pass "PC-G2 session 續行（冇其他空槽 — 跳過收卡分支）"
  fi

  # 還原填位 flag + 重 sync（避免污染後續 run/店）
  if [ -f /tmp/pc-fill-flag.bak ]; then mv /tmp/pc-fill-flag.bak .dev/workforce-mock-fill.json; else rm -f .dev/workforce-mock-fill.json; fi
  pnpm -s e2e:cron sync-availability >/dev/null 2>&1
fi

# ── PC-G3. HANDOFF（「真人」逃生口）+ PatientFact 零 row + HANDOFF 後跌普通 triage ──
echo "[PC] G3: HANDOFF + PatientFact zero-row ..."
if [ -n "$PC_SLOT1" ]; then
  PC3_WA="8526123${EPOCH}"
  pnpm -s mock-inbound message --clinic TKW --from "$PC3_WA" --text "想約李醫生洗牙" --wamid "wamid.E2E_PC3_1_${EPOCH}" --name "E2E PC3" >/dev/null 2>&1
  PC3_CONV=$(pc_conv_of "$PC3_WA" "$TKW_CLINIC_ID")
  wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$PC3_CONV' AND \"direction\"='OUT' AND type='text' AND status='SENT' AND \"bookingSessionId\" IS NOT NULL" '[{"c":"1"}]' 45 || { fail "PC-G3 r1 未收到"; PC_FAIL=1; }
  pnpm -s mock-inbound message --clinic TKW --from "$PC3_WA" --text "我想搵真人" --wamid "wamid.E2E_PC3_2_${EPOCH}" --name "E2E PC3" >/dev/null 2>&1
  wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$PC3_CONV' AND \"direction\"='OUT' AND type='text' AND status='SENT' AND \"bookingSessionId\" IS NOT NULL" '[{"c":"2"}]' 45 || { fail "PC-G3 r2 未收到"; PC_FAIL=1; }
  PC3_SESS=$(q "SELECT id FROM \"BookingSession\" WHERE \"conversationId\"='$PC3_CONV'" | jf id)
  check "PC-G3 session HANDOFF" "$(q "SELECT \"status\"::text s FROM \"BookingSession\" WHERE id='$PC3_SESS'" | jf s)" "HANDOFF"
  check "PC-G3 HANDOFF 回覆逐字" "$(pc_sess_reply "$PC3_CONV" 2)" "收到，我哋職員好快覆你 🙏"
  wait_for "SELECT count(*)::text c FROM \"StaffNotice\" WHERE \"conversationId\"='$PC3_CONV' AND kind='HANDOFF_REQUEST'" '[{"c":"1"}]' 30 \
    && pass "PC-G3 StaffNotice(HANDOFF_REQUEST) 落庫" || { fail "PC-G3 HANDOFF 通知未落庫"; PC_FAIL=1; }
  # PatientFact #2（golden #4 HANDOFF 查零 row）
  check "PC-G3 PatientFact 零 row（HANDOFF 唔寫 fact）" "$(q "SELECT count(*)::text c FROM \"PatientFact\" WHERE \"contactId\"='$(pc_contact_of "$PC3_WA" "$TKW_CLINIC_ID")'" | jf c)" "0"
  # HANDOFF 後病人再講嘢 → 普通 triage（零 session 回覆、session 唔再起）
  pnpm -s mock-inbound message --clinic TKW --from "$PC3_WA" --text "再問下時間" --wamid "wamid.E2E_PC3_3_${EPOCH}" --name "E2E PC3" >/dev/null 2>&1
  wait_for "SELECT (\"aiSummary\" IS NOT NULL AND \"intent\"!='BOOKING_REQUEST')::text s FROM \"Conversation\" WHERE id='$PC3_CONV'" '[{"s":"true"}]' 45 \
    && pass "PC-G3 HANDOFF 後跌普通 triage" || { fail "PC-G3 HANDOFF 後未 triage"; PC_FAIL=1; }
  sleep 3
  check "PC-G3 HANDOFF 後零 session 回覆" "$(pc_sess_replies "$PC3_CONV")" "2"
  check "PC-G3 無第二 session" "$(q "SELECT count(*)::text c FROM \"BookingSession\" WHERE \"conversationId\"='$PC3_CONV'" | jf c)" "1"
fi

# ── PC-S1. staff 中途 claim → session 讓路（HANDOFF）+ 零 session 回覆 ──
echo "[PC] S1: staff claim mid-session ..."
if [ -n "$PC_SLOT1" ]; then
  PC5_WA="8526125${EPOCH}"
  pnpm -s mock-inbound message --clinic TKW --from "$PC5_WA" --text "想約王醫生洗牙" --wamid "wamid.E2E_PC5_1_${EPOCH}" --name "E2E PC5" >/dev/null 2>&1
  PC5_CONV=$(pc_conv_of "$PC5_WA" "$TKW_CLINIC_ID")
  wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$PC5_CONV' AND \"direction\"='OUT' AND type='text' AND status='SENT' AND \"bookingSessionId\" IS NOT NULL" '[{"c":"1"}]' 45 || { fail "PC-S1 r1 未收到"; PC_FAIL=1; }
  PC5_SESS=$(q "SELECT id FROM \"BookingSession\" WHERE \"conversationId\"='$PC5_CONV'" | jf id)
  PC5_STAFF=$(q "SELECT id::text id FROM \"StaffUser\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND role='STAFF' LIMIT 1" | jf id)
  q "UPDATE \"Conversation\" SET \"assigneeId\"='$PC5_STAFF' WHERE id='$PC5_CONV'" >/dev/null 2>&1
  pnpm -s mock-inbound message --clinic TKW --from "$PC5_WA" --text "聽日得唔得" --wamid "wamid.E2E_PC5_2_${EPOCH}" --name "E2E PC5" >/dev/null 2>&1
  wait_for "SELECT (\"aiSummary\" IS NOT NULL AND \"intent\"='QUESTION')::text s FROM \"Conversation\" WHERE id='$PC5_CONV'" '[{"s":"true"}]' 45 \
    && pass "PC-S1 病人再來訊已 triage" || { fail "PC-S1 未 triage"; PC_FAIL=1; }
  sleep 3
  check "PC-S1 session HANDOFF（讓路）" "$(q "SELECT \"status\"::text s FROM \"BookingSession\" WHERE id='$PC5_SESS'" | jf s)" "HANDOFF"
  check "PC-S1 零 session 回覆（ staff 接手）" "$(pc_sess_replies "$PC5_CONV")" "1"
fi

# ── PC-S2. 媒體入 session → 客戶端零回覆 + MEDIA_RECEIVED + session 不動 ──
echo "[PC] S2: media into active session ..."
if [ -n "$PC_SLOT1" ]; then
  PC6_WA="8526126${EPOCH}"
  pnpm -s mock-inbound message --clinic TKW --from "$PC6_WA" --text "想約陳醫生洗牙" --wamid "wamid.E2E_PC6_1_${EPOCH}" --name "E2E PC6" >/dev/null 2>&1
  PC6_CONV=$(pc_conv_of "$PC6_WA" "$TKW_CLINIC_ID")
  wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$PC6_CONV' AND \"direction\"='OUT' AND type='text' AND status='SENT' AND \"bookingSessionId\" IS NOT NULL" '[{"c":"1"}]' 45 || { fail "PC-S2 r1 未收到"; PC_FAIL=1; }
  PC6_SESS=$(q "SELECT id FROM \"BookingSession\" WHERE \"conversationId\"='$PC6_CONV'" | jf id)
  pnpm -s mock-inbound message --clinic TKW --from "$PC6_WA" --text "e2e PC6 photo" --media image --wamid "wamid.E2E_PC6_2_${EPOCH}" --name "E2E PC6" >/dev/null 2>&1
  wait_for "SELECT count(*)::text c FROM \"StaffNotice\" WHERE \"conversationId\"='$PC6_CONV' AND kind='MEDIA_RECEIVED'" '[{"c":"1"}]' 30 \
    && pass "PC-S2 StaffNotice(MEDIA_RECEIVED) 落庫" || { fail "PC-S2 MEDIA 通知未落庫"; PC_FAIL=1; }
  sleep 3
  check "PC-S2 媒體零客戶端回覆" "$(pc_sess_replies "$PC6_CONV")" "1"
  check "PC-S2 session 不動（ACTIVE）" "$(q "SELECT \"status\"::text s FROM \"BookingSession\" WHERE id='$PC6_SESS'" | jf s)" "ACTIVE"
fi

# ── PC-G4. L4 自動落單（pinned + 預設 visit reason → AUTO_BOOK 全鏈）──
echo "[PC] G4: L4 auto-book ..."
PC4_CID="$MF_CLINIC_ID"; PC4_CODE="MF"
PC4_SLOT=$(pc_pick "$MF_CLINIC_ID" "" 0)
if [ -z "$PC4_SLOT" ]; then
  PC4_CID=$(q "SELECT id FROM \"Clinic\" WHERE code='WTC'" | jf id); PC4_CODE="WTC"
  PC4_SLOT=$(pc_pick "$PC4_CID" "" 0)
fi
if [ -n "$PC4_SLOT" ]; then
  PC4_P=${PC4_SLOT%%|*}; PC4_D=${PC4_SLOT##*|}
  PC4_NAME=$(pc_prov_name "$PC4_P"); PC4_SUR=$(pc_surname "$PC4_P")
  q "INSERT INTO \"AutomationPolicy\" (\"id\",\"clinicId\",\"category\",\"level\",\"updatedAt\") VALUES ('e2e-pc-l4-${PC4_CODE}','$PC4_CID','BOOKING_REQUEST','L4',now()) ON CONFLICT (\"clinicId\",\"category\") DO UPDATE SET \"level\"=EXCLUDED.\"level\" RETURNING \"id\"" | jf id | grep -q . || { fail "PC-G4：L4 policy INSERT 失敗"; PC_FAIL=1; }
  PC4_WA="8526124${EPOCH}"
  # 先一條中性訊息開對話（QUESTION），pin 之後先發 BOOKING_REQUEST（pinned 必須喺開波前已設）
  pnpm -s mock-inbound message --clinic "$PC4_CODE" --from "$PC4_WA" --text "你好，想問下地址" --wamid "wamid.E2E_PC4_1_${EPOCH}" --name "E2E PC4" >/dev/null 2>&1
  wait_for "SELECT \"intent\"::text i FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$PC4_WA' AND c.\"clinicId\"='$PC4_CID'" '[{"i":"QUESTION"}]' 45 || { fail "PC-G4 首訊未 triage"; PC_FAIL=1; }
  PC4_CONV=$(pc_conv_of "$PC4_WA" "$PC4_CID")
  q "UPDATE \"Conversation\" SET \"pinnedPatientApricotId\"='e2e-pc-l4-pat' WHERE id='$PC4_CONV'" >/dev/null 2>&1

  pnpm -s mock-inbound message --clinic "$PC4_CODE" --from "$PC4_WA" --text "想約${PC4_SUR}醫生洗牙" --wamid "wamid.E2E_PC4_2_${EPOCH}" --name "E2E PC4" >/dev/null 2>&1
  wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$PC4_CONV' AND \"direction\"='OUT' AND type='text' AND status='SENT' AND \"bookingSessionId\" IS NOT NULL" '[{"c":"1"}]' 45 || { fail "PC-G4 r1 未收到"; PC_FAIL=1; }
  PC4_SESS=$(q "SELECT id FROM \"BookingSession\" WHERE \"conversationId\"='$PC4_CONV'" | jf id)
  pnpm -s mock-inbound message --clinic "$PC4_CODE" --from "$PC4_WA" --text "$(pc_date_kw "$PC4_D")" --wamid "wamid.E2E_PC4_3_${EPOCH}" --name "E2E PC4" >/dev/null 2>&1
  wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$PC4_CONV' AND \"direction\"='OUT' AND type='text' AND status='SENT' AND \"bookingSessionId\" IS NOT NULL" '[{"c":"2"}]' 45 || { fail "PC-G4 r2 未收到"; PC_FAIL=1; }
  pnpm -s mock-inbound message --clinic "$PC4_CODE" --from "$PC4_WA" --text "三點啦" --wamid "wamid.E2E_PC4_4_${EPOCH}" --name "E2E PC4" >/dev/null 2>&1
  wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$PC4_CONV' AND \"direction\"='OUT' AND type='text' AND status='SENT' AND \"bookingSessionId\" IS NOT NULL" '[{"c":"3"}]' 45 || { fail "PC-G4 r3 未收到"; PC_FAIL=1; }
  PC4_MO_N=$((10#$(echo "$PC4_D" | cut -d- -f2))); PC4_DD_N=$((10#$(echo "$PC4_D" | cut -d- -f3)))
  check "PC-G4 confirmLine 逐字" "$(pc_sess_reply "$PC4_CONV" 3)" "收到！ 同你確認一次：${PC4_MO_N}月${PC4_DD_N}日 15:00 ${PC4_NAME}，啱唔啱？"

  PC4_CALLS_LOG=.dev/workforce-mock-calls.jsonl
  pc4_creates() { grep -c '"method":"POST","path":"/api/external/v1/bookings","status":200' "$PC4_CALLS_LOG" 2>/dev/null; }
  PC4_CREATE_BEFORE=$(pc4_creates); PC4_CREATE_BEFORE=${PC4_CREATE_BEFORE:-0}
  pnpm -s mock-inbound message --clinic "$PC4_CODE" --from "$PC4_WA" --text "好呀" --wamid "wamid.E2E_PC4_5_${EPOCH}" --name "E2E PC4" >/dev/null 2>&1
  if wait_for "SELECT \"status\"::text s FROM \"BookingRequest\" WHERE \"conversationId\"='$PC4_CONV'" '[{"s":"CONFIRMED"}]' 60; then
    pass "PC-G4 L4 自動落單 → CONFIRMED"
  else
    fail "PC-G4 未 CONFIRMED（auto-book 失敗？）"; PC_FAIL=1
  fi
  check "PC-G4 autoBooked=true" "$(q "SELECT (\"autoBooked\")::text v FROM \"BookingRequest\" WHERE \"conversationId\"='$PC4_CONV'" | jf v)" "true"
  check "PC-G4 apricotApptId（mock 決定性單號）" "$(q "SELECT (\"apricotApptId\" LIKE 'mock-appt-%')::text v FROM \"BookingRequest\" WHERE \"conversationId\"='$PC4_CONV'" | jf v)" "true"
  PC4_CREATE_AFTER=$(pc4_creates); PC4_CREATE_AFTER=${PC4_CREATE_AFTER:-0}
  check "PC-G4 workforce mock 真調 create（恰一次）" "$((PC4_CREATE_AFTER - PC4_CREATE_BEFORE))" "1"
  check "PC-G4 AuditLog(AI_AUTO_BOOKING)" "$(q "SELECT count(*)::text c FROM \"AuditLog\" WHERE action='AI_AUTO_BOOKING' AND \"meta\"->>'sessionId'='$PC4_SESS'" | jf c)" "1"
  check "PC-G4 AuditLog staffId=null（AI 無 staff）" "$(q "SELECT (\"staffId\" IS NULL)::text n FROM \"AuditLog\" WHERE action='AI_AUTO_BOOKING' AND \"meta\"->>'sessionId'='$PC4_SESS'" | jf n)" "true"
  check "PC-G4 StaffNotice(BOOKING_AUTO) title" "$(q "SELECT title FROM \"StaffNotice\" WHERE \"conversationId\"='$PC4_CONV' AND kind='BOOKING_AUTO'" | jf title)" "AI 已自動落單 ${PC4_MO_N}月${PC4_DD_N}日 15:00 ${PC4_NAME}"
  wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$PC4_CONV' AND \"direction\"='OUT' AND type='text' AND status='SENT' AND \"bookingSessionId\" IS NOT NULL" '[{"c":"4"}]' 45 || { fail "PC-G4 確認訊息未 SENT"; PC_FAIL=1; }
  PC4_R4=$(pc_sess_reply "$PC4_CONV" 4)
  case "$PC4_R4" in "已為你預約 ${PC4_MO_N}月${PC4_DD_N}日 15:00 ${PC4_NAME}，到時見 🙂") pass "PC-G4 病人確認訊息逐字（confirm-core）";; *) fail "PC-G4 確認訊息錯：${PC4_R4:0:80}"; PC_FAIL=1;; esac
  check "PC-G4 確認訊息 aiAutoSent + session 追溯" "$(q "SELECT (\"aiAutoSent\" AND \"bookingSessionId\"='$PC4_SESS')::text v FROM \"Message\" WHERE \"conversationId\"='$PC4_CONV' AND \"bookingSessionId\"='$PC4_SESS' AND \"aiAutoSent\"" | jf v)" "true"
  check "PC-G4 session COMPLETED" "$(q "SELECT \"status\"::text s FROM \"BookingSession\" WHERE id='$PC4_SESS'" | jf s)" "COMPLETED"
  check "PC-G4 PatientFact（COMPLETED 觸發）" "$(q "SELECT count(*)::text c FROM \"PatientFact\" WHERE \"contactId\"='$(pc_contact_of "$PC4_WA" "$PC4_CID")' AND text='預約偏好：${PC4_NAME}'" | jf c)" "1"
else
  fail "PC-G4：MF/WTC 明日/後日/大後日 無 15:00 空槽（djb2 grid）"; PC_FAIL=1
fi

# ── PC-G5. kill switch 演練：AI_GLOBAL_MAX_LEVEL=L2 → 有 L3 policy 都唔開 session ──
echo "[PC] G5: kill switch (AI_GLOBAL_MAX_LEVEL=L2) ..."
if [ -n "$PC_SLOT1" ]; then
  pkill -f "src/workers/index.ts" 2>/dev/null || true
  sleep 1
  AI_GLOBAL_MAX_LEVEL=L2 BOOKING_DEFAULT_VISIT_REASON_CODE=0021 nohup pnpm worker >/tmp/e2e-worker-pc-cap.log 2>&1 &
  WORKER_PID=$!
  for i in $(seq 1 60); do grep -q "all workers running" /tmp/e2e-worker-pc-cap.log 2>/dev/null && break; sleep 1; done
  PC7_WA="8526127${EPOCH}"
  pnpm -s mock-inbound message --clinic TKW --from "$PC7_WA" --text "想約陳醫生洗牙" --wamid "wamid.E2E_PC7_1_${EPOCH}" --name "E2E PC7" >/dev/null 2>&1
  PC7_CONV=$(pc_conv_of "$PC7_WA" "$TKW_CLINIC_ID")
  wait_for "SELECT count(*)::text c FROM \"AiDraft\" WHERE \"conversationId\"='$PC7_CONV'" '[{"c":"1"}]' 45 \
    && pass "PC-G5 cap 生效：舊 draft 行為照行（L1/L2 鏈 byte-for-byte）" || { fail "PC-G5 舊 draft 未出（cap 異常？）"; PC_FAIL=1; }
  check "PC-G5 零 session（cap L2 壓過 policy L3）" "$(q "SELECT count(*)::text c FROM \"BookingSession\" WHERE \"conversationId\"='$PC7_CONV'" | jf c)" "0"
  check "PC-G5 零 session 回覆" "$(pc_sess_replies "$PC7_CONV")" "0"
  # 還原 worker（清晒 PC env）
  pkill -f "src/workers/index.ts" 2>/dev/null || true
  sleep 1
  unset BOOKING_DEFAULT_VISIT_REASON_CODE
  nohup pnpm worker >/tmp/e2e-worker.log 2>&1 &
  WORKER_PID=$!
  for i in $(seq 1 60); do grep -q "all workers running" /tmp/e2e-worker.log 2>/dev/null && break; sleep 1; done
fi

# ── PC cleanup：policy row 清走（持久 DB — 下次 run 嘅 T14 等要舊行為）──
q "DELETE FROM \"AutomationPolicy\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND category='BOOKING_REQUEST' AND \"level\" IN ('L3','L4')" >/dev/null 2>&1
q "DELETE FROM \"AutomationPolicy\" WHERE \"clinicId\"='$MF_CLINIC_ID' AND category='BOOKING_REQUEST' AND \"level\" IN ('L3','L4')" >/dev/null 2>&1
q "DELETE FROM \"AutomationPolicy\" WHERE \"clinicId\" IN (SELECT id FROM \"Clinic\" WHERE code='WTC') AND category='BOOKING_REQUEST' AND \"level\" IN ('L3','L4')" >/dev/null 2>&1

# ── PC summary ─────────────────────────────────────────────────────────
[ "$PC_FAIL" = 0 ] && pass "R-PC Phase C e2e（G1-G5 + S1/S2 + PatientFact 全綠）" || fail "R-PC Phase C 有項失敗（見上 ❌）"

# ── summary ────────────────────────────────────────────────────────────
echo "════════════════════════════════════════════"
echo " E2E 完成：PASS=$PASS FAIL=$FAIL"
echo "════════════════════════════════════════════"
[ "$FAIL" = 0 ] || exit 1

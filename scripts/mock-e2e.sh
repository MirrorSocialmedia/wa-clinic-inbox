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
#   T88 Fix A canary（cwi-fix-20260825-f1）：INTERNAL 備註含「投訴」→ 病人下條 QUESTION 唔被污染（intent=QUESTION + 零 HANDOFF_REQUEST）
#
# Phase E 尾部（cwi-fix-20260825-f1，Fix B）：
#   T89 policy 壓 AUTO + cache broadcast：MF→AUTO + PATCH QUESTION=L1 → draft 照出 + 0 自動發 + log policy-L1；
#       PATCH QUESTION=L2（唔手動 clear cache — control channel 廣播）→ 同類訊息即刻自動發（aiAutoSent=1）
#   T90 panic 全店降 L1：TKW "*"=L3 baseline（BOOKING_REQUEST 開 session）→ 兩店 "*"→L1 →
#       AUTO 店（MF）文字唔再自動發 + L3 店（TKW）session 唔開（只出 draft）
#
# R11 輪一收尾（cwi-r1close-20260827）：
#   T93 Flow 發送失敗（WA_GRAPH_MOCK_FAIL）→ Message FAILED + FlowSession 回滾 FAILED →
#       重按 = 新發送（唔謊報「已發咗」）+ 成功 case 重按照舊 reused（防連撳保留）
#   T94 /schedule 七日週表頁：STAFF 自己店 / ADMIN ?clinicId= 選店 / STAFF 跨店 param fail-closed / 搵唔到店 / workforce 離線 fail-soft
#   T95 §B2 今日當值卡 client 端刷新（browser：mock duty 變更 → 換對話卡更新，零 reload）
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
#
# WIN（cwi-window-20260901 — 過窗三出路 + COPY_ONLY + 單訊息鐵律 + 用量統計）：
#   T175 billingCategory 數據層：人手窗口內 text=SERVICE / template=類別（UTILITY+meta 快照）/
#       APP_ECHO=NONE / legacy NULL row 冪等 backfill（text→SERVICE、template meta category→MARKETING、echo→NONE）+
#       重跑零變動 + 新寫入 row 唔受 backfill 蓋
#   T171 過窗 + AUTO → draft mode=COPY_ONLY + 零 OUT（唔產生 FAILED outbound）
#   T174 窗口內迴歸：draft mode=NORMAL + AUTO 自動發照舊（行為零改變）
#   T172 過窗三出路 ① 開手機對話：wa.me deep link（E164 無加號 + encodeURIComponent 草稿）+
#       audit APP_HANDOFF_CLICK（conversationId+staffId，零電話原文）+ INTERNAL 備註「已轉用手機 App 跟進」
#   T173 過窗三出路 ② 揀 template：只列 APPROVED+UTILITY + 逐條收費標示 + 發送走現有 outbound（202→SENT，UTILITY）
#   T170 單訊息鐵律：AUTO 一條 QUESTION → 只 1 條 OUT（aiAutoSent）；5s 內同對話第 2 條 AI OUT →
#       worker log warn `outbound: multi-message burst`（唔擋，觀察期）
#   T176 /admin/usage：本月按店×類別×人手/AI + App 跟進次數（APP_HANDOFF_CLICK）+ 週趨勢 + AI 自動覆佔比；
#       STAFF 頁/API → 403
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
# cwi-fix-20260825-f1 hermetic：PC 段殘留測試 row（L3 policy / session / booking）—
#   不清會污染下一 run 嘅 T14/T19/T23/T25 BOOKING_REQUEST 路由（run5 殘留 L3 row 實測 16 項紅事故）
q "DELETE FROM \"BookingSession\"" >/dev/null 2>&1 || true
q "DELETE FROM \"PainTriageSession\"" >/dev/null 2>&1 || true  # Part E（cwi-paintriage-20260903）：痛症問診 session hermetic
q "DELETE FROM \"BookingRequest\"" >/dev/null 2>&1 || true
q "DELETE FROM \"AutomationPolicy\"" >/dev/null 2>&1 || true
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
pnpm -s mock-inbound message --clinic TKW --from "$PATIENT_AI1" --text "医生我牙痛到瞓唔著" --wamid "$WAMID_AI1" --name "E2E-A-URGENT" >/dev/null || fail "T13 mock-inbound POST"
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
BAIT_PAT="8526009${EPOCH}"   # ★ cwi-paintriage-20260903 fix：原 ${EPOCH}1 = 18 位 → pii-scan idCard regex 誤中（T33 假紅）
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
for kw in "e2e 第一則" "医生我牙痛到瞓唔著" "我想預約下週" "想問下埋門時間" "再問一次時間" "mf msg" "e2e 店員 App 覆" "e2e 發送測試"; do
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

# ── T19b. /api/admin/clinics 列表：近 24h 自動發統計（API 值 == DB 同式；cwi-clinic24h）──
T19B_CODE=$(curl -s -o /tmp/e2e-t19b.json -w '%{http_code}' -b "$COOKIE_ADMIN" "$BASE/api/admin/clinics")
T19B_PRESENT=$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const c=Array.isArray(j)?j.find(x=>x.id===process.argv[2]):null;console.log(c&&typeof c.autoSent24h==="number"&&typeof c.autoSentOk24h==="number"&&(c.autoSentRate24h===null||typeof c.autoSentRate24h==="number")?"ok":"missing")}catch{console.log("badjson")}' /tmp/e2e-t19b.json "$TKW_CLINIC_ID" 2>/dev/null)
check "T19b admin clinics list 200 + TKW 近 24h 自動發三欄存在（autoSent24h/Ok/Rate）" "${T19B_CODE}_${T19B_PRESENT}" "200_ok"
DB_24H_TOTAL=$(q "SELECT COUNT(*)::text c FROM \"Message\" m JOIN \"Conversation\" cv ON cv.\"id\"=m.\"conversationId\" WHERE m.\"aiAutoSent\"=true AND m.\"direction\"='OUT' AND m.\"createdAt\">= now() - interval '24 hours' AND cv.\"clinicId\"='$TKW_CLINIC_ID'" | jf c)
DB_24H_OK=$(q "SELECT COUNT(*)::text c FROM \"Message\" m JOIN \"Conversation\" cv ON cv.\"id\"=m.\"conversationId\" WHERE m.\"aiAutoSent\"=true AND m.\"direction\"='OUT' AND m.\"status\" IN ('SENT','DELIVERED','READ') AND m.\"createdAt\">= now() - interval '24 hours' AND cv.\"clinicId\"='$TKW_CLINIC_ID'" | jf c)
API_24H_TO=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const c=j.find(x=>x.id===process.argv[2]);console.log(c.autoSent24h+"|"+c.autoSentOk24h)' /tmp/e2e-t19b.json "$TKW_CLINIC_ID" 2>/dev/null)
API_24H_RATE=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const c=j.find(x=>x.id===process.argv[2]);console.log(c.autoSentRate24h)' /tmp/e2e-t19b.json "$TKW_CLINIC_ID" 2>/dev/null)
check "T19b TKW autoSent24h/autoSentOk24h == DB 同式（近 24h 自動發/其中成功）" "$API_24H_TO" "$DB_24H_TOTAL|$DB_24H_OK"
check "T19b TKW autoSentRate24h == round(ok/total*100)（DB 基準；total=0→null）" "$API_24H_RATE" "$(node -e 'const t=+process.argv[1],o=+process.argv[2];console.log(t>0?Math.round(o/t*100):"null")' "$DB_24H_TOTAL" "$DB_24H_OK")"

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
# ★ cwi-paintriage-20260903 fix：D.4（cwi-schedv2-20260903）移除咗 SSR 當值卡管線（側欄改 MiniSchedule client 自拉 /api/flows/slots）
#   → SSR HTML 冇「當值（」/ 人員文字（stale grep 假紅）；client 端卡已由 T95（browser-level）斷言覆蓋
grep -q '<html' /tmp/e2e-inbox.html || { echo "    ❌ T38 /inbox 頁面唔存在"; T38=1; }
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
for _WARM in "/api/conversations/warmup-h1/assign" "/api/conversations/warmup-h1/notes" "/api/conversations/warmup-h1/flows" "/api/messages/send" "/api/bookings/warmup-h1/create" "/api/admin/workflows/triage/publish" "/api/admin/workflows/booking-session/publish" "/api/admin/workflows/reminder/publish" "/api/flows/endpoint"; do
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
  while [ "$attempt" -lt 3 ]; do
    if [ -n "$body" ]; then
      code=$(curl -s -o "$out" -w '%{http_code}' -b "$cookie" -X "$method" "$url" \
        -H 'Content-Type: application/json' -d "$body")
    else
      code=$(curl -s -o "$out" -w '%{http_code}' -b "$cookie" -X "$method" "$url")
    fi
    # ★ 2026-08-25 run2 教訓：dev manifest flake 除 500 外仲有 308 形態（body 冇 marker）；
    #   API route 永遠唔應該 308 → 當 flake 重試（最多 3 次）
    if { [ "$code" = "500" ] && grep -q "Unexpected end of JSON input" "$out" 2>/dev/null; } || [ "$code" = "308" ]; then
      echo "    (dev manifest flake ${code} → retry: ${method} ${url##*/})"
      rm -f "$out"
      sleep 2
      attempt=$((attempt+1))
      continue
    fi
    break
  done
  sleep 1
  H1_CODE=$code
  H1_OUT=$out
}

patch_aimode() { # patch_aimode <clinicId> <mode> [out-file 可空] → $PAM_CODE
  # ★ 2026-08-25 run4 教訓：T87 aiMode 還原 PATCH 撞 dev manifest flake（500）→ MF 遺留 AUTO 污染下次 run。
  #   aiMode PATCH 冪等 → 非 200 重試（最多 3 次）
  local cid="$1" mode="$2" out="${3:-/dev/null}" code=""
  for _try in 1 2 3; do
    code=$(curl -s -o "$out" -w '%{http_code}' -b "$COOKIE_ADMIN" -X PATCH "$BASE/api/admin/clinics/$cid" \
      -H 'Content-Type: application/json' -d "{\"aiMode\":\"$mode\"}")
    [ "$code" = "200" ] && break
    [ "$_try" -lt 3 ] && { echo "    (dev flake ${code} → aiMode PATCH retry)"; sleep 2; }
  done
  PAM_CODE=$code
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
# ★ 2026-08-25 run2 教訓：raw curl 無 flake retry → 一次 dev manifest 500 → B 無 cookie → 後續 ~10 項 401 連鎖。
for _try in 1 2 3; do
  CODE=$(curl -s -o /dev/null -D /tmp/e2e-h2b-login-headers.txt -w '%{http_code}' -c /tmp/e2e-cookie-h2b.txt \
    -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$H2_B_EMAIL\",\"password\":\"$H1B_PASS\"}")
  [ "$CODE" = "200" ] && break
  [ "$_try" -lt 3 ] && { echo "    (dev flake ${CODE} → staff B login retry)"; sleep 2; }
done
check "H2-0 臨時 staff B 登入 → 200" "$CODE" "200"
for _try in 1 2 3; do
  CODE=$(curl -s -o /dev/null -D /tmp/e2e-h2c-login-headers.txt -w '%{http_code}' -c /tmp/e2e-cookie-h2c.txt \
    -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$H2_C_EMAIL\",\"password\":\"$H1B_PASS\"}")
  [ "$CODE" = "200" ] && break
  [ "$_try" -lt 3 ] && { echo "    (dev flake ${CODE} → staff C login retry)"; sleep 2; }
done
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
patch_aimode "$MF_CLINIC_ID" AUTO; CODE=$PAM_CODE
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
patch_aimode "$MF_CLINIC_ID" DRAFT; CODE=$PAM_CODE
check "T87 MF 還原 DRAFT" "$CODE" "200"

# ── T88. Fix A canary（cwi-fix-20260825-f1）：INTERNAL 備註含「投訴」唔污染病人下條訊息 intent ─
#   canary 法（唔 introspect prompt）：mock RE_COMPLAINT（/投訴|退款|.../）係分類觸發器 —
#   修前備註「投訴」入 prompt → mock regex 掃中 → COMPLAINT（HANDOFF_REQUEST 誤觸）；
#   修後（context query filter + msgLine guard 雙重）→ 病人「幾點開門」照判 QUESTION。
#   ★ 注：現 mock classify 只掃 last IN body — 呢 canary 喺真 AI 模式先係真探針；
#     mock 模式係行為守護（+ unit-prompts 做直接 regression probe）。
echo "[AI-T1] T88: INTERNAL note must not pollute AI context (Fix A)..."
T88=0
P_T88="8526105${EPOCH}"; WAMID_T88="wamid.E2E_T88_${EPOCH}"; C_T88="t88-c-${EPOCH}"; CONV_T88="t88-conv-${EPOCH}"
q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\", \"profileName\", labels) VALUES ('$C_T88', '$MF_CLINIC_ID', '$P_T88', 'E2E T88', ARRAY[]::text[])" >/dev/null 2>&1
q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", status, \"lastMessageAt\") VALUES ('$CONV_T88', '$MF_CLINIC_ID', '$C_T88', 'OPEN', '$NOWISO')" >/dev/null 2>&1
# 1. 內部備註（含 mock 投訴詞）
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_MF" -X POST "$BASE/api/conversations/$CONV_T88/notes" -H 'Content-Type: application/json' -d '{"body":"e2e T88 內部備註：該患者曾投訴服務態度，注意處理"}')
check "T88 內部備註 POST → 201" "$CODE" "201"
check "T88 note row 形態（INTERNAL/note/OUT）" "$(q "SELECT (channel='INTERNAL' AND type='note' AND direction='OUT')::text ok FROM \"Message\" WHERE \"conversationId\"='$CONV_T88'" | jf ok)" "true"
# 2. 病人跟住發普通問題（唔含任何分類觸發詞）
pnpm -s mock-inbound message --clinic MF --from "$P_T88" --text "你哋幾點開門" --wamid "$WAMID_T88" --name "E2E T88 question" >/dev/null || fail "T88 mock-inbound POST"
M_T88=$(q "SELECT id FROM \"Message\" WHERE \"waMessageId\"='$WAMID_T88'" | jf id)
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$M_T88'" '[{"s":"PROPOSED"}]' 30; then
  pass "T88 QUESTION draft 照出（PROPOSED）"
else
  fail "T88 QUESTION draft"; T88=1
fi
sleep 2
# 3. intent 斷言（修前 mock 若掃中備註「投訴」→ COMPLAINT）
check "T88 intent = QUESTION（備註「投訴」唔污染分類）" "$(q "SELECT \"intent\"::text i FROM \"Conversation\" WHERE id='$CONV_T88'" | jf i)" "QUESTION"
# 4. COMPLAINT 通知唔被誤觸
check "T88 零 HANDOFF_REQUEST（COMPLAINT 軌未誤觸）" "$(q "SELECT count(*)::text c FROM \"StaffNotice\" WHERE \"conversationId\"='$CONV_T88' AND kind='HANDOFF_REQUEST'" | jf c)" "0"
q "DELETE FROM \"AiDraft\" WHERE \"conversationId\"='$CONV_T88'" >/dev/null 2>&1
q "DELETE FROM \"Message\" WHERE \"conversationId\"='$CONV_T88'" >/dev/null 2>&1
q "DELETE FROM \"Conversation\" WHERE id='$CONV_T88'" >/dev/null 2>&1
q "DELETE FROM \"Contact\" WHERE id='$C_T88'" >/dev/null 2>&1
[ "$T88" = 0 ] && pass "T88 Fix A canary：INTERNAL 備註唔入 prompt（intent 唔受污染）" || fail "T88 Fix A canary 有項失敗（見上 ❌）"

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
        # ★ cwi-paintriage-20260903 fix：i≥10 時 852610${i}${EPOCH} = 18 位數字 → pii-scan idCard regex 誤中（T33 假紅）→ 換 85262 前綴（17 位）
        T76_NUM="852610${i}${EPOCH}"; [ "$i" -ge 10 ] && T76_NUM="85262${i}${EPOCH}"
        T76_OUT=$(timeout 15 "$TSX" scripts/mock-inbound.ts message --clinic TKW --from "$T76_NUM" --text "e2e T76 order $i.$j" --wamid "wamid.E2E_ORDER_${EPOCH}_${i}_${j}" --name "E2E-T76-P${i}" --ts "$((T76_BASE + i * 3 + j))" 2>&1)
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
check "T76 20 新對話建立" "$(q "SELECT count(*)::text c FROM \"Conversation\" cv JOIN \"Contact\" x ON x.id=cv.\"contactId\" WHERE (x.\"waId\" LIKE '852610%${EPOCH}' OR x.\"waId\" LIKE '85262%${EPOCH}')" | jf c)" "20"
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
  # ★ 2026-08-25 run5 教訓：mock-inbound waTimestamp 只到秒級 — m3/m4 同一秒 → PatientFact writer 嘅
  #   `waTimestamp < msg` strict lt 會漏咗 m3（同秒 tie）→ source 回退去 m2。sleep 1.1 保證秒級分離（deterministic）
  sleep 1.1
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
  console.log("FILLB:" + (s ? String(s.bookedCount) : "missing"));
  process.exit(0); // ★ cwi-refresh-20260831：client.ts import 鏈含 redis handle — 成功路徑必須顯式 exit，否則 $( ) 永久 hang
})();
EOF2
  # FILLB: marker + grep — 隔離 import 鏈帶入嘅 pino "redis connected" stdout 行（T145/PC-G2 實測污染）
  PC_FLAG_B=$( (set -a; . ./.env; set +a; ./node_modules/.bin/tsx /tmp/pc-fill-check.ts 2>/dev/null) | grep -oE 'FILLB:[0-9a-z]+' | head -1 | cut -d: -f2 )
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

# ── W 段：Phase D workflow 參數化 e2e（cwi-ai-20260825-t4）────────────────────
#
# W1: triage cooldown — v1（30min）發 1 次 → 職員覆核 → msg2 被 human-recent 擋（PROPOSED）
#     → publish v2（cooldown 0）→ msg3 SENT_AUTO（即時生效，worker TTL=0）→ revert v1 → v3
#     → msg4 再被擋（cooldown 還原）
# W2: booking-session confirmText 改字 → golden 3 訊息重跑 → 新文案逐字 → revert 還原
# W3: RBAC STAFF 403 + AuditLog WORKFLOW_DRAFT/PUBLISH 有 row（meta.key 可審）
# W4: fail-soft — WorkflowDefinition 表 rename 走 → GET 200（defaults）+ 全鏈照行（SENT_AUTO）
#
# EPOCH-scoped：waId 8526901-3${EPOCH} / wamid.E2E_W*_${EPOCH} / policy id e2e-w2-tkw-l3-${EPOCH}
W_FAIL=0
WF_PATIENT_LOG=/tmp/e2e-worker-w.log

# W 段用自己 worker：WORKFLOW_PARAMS_TTL_MS=0 — publish/revert 即刻生效（唔靠 5min TTL 倒數）
pkill -f "src/workers/index.ts" 2>/dev/null || true
sleep 1
WORKFLOW_PARAMS_TTL_MS=0 nohup pnpm worker >/tmp/e2e-worker-w.log 2>&1 &
WORKER_PID=$!
for i in $(seq 1 60); do grep -q "all workers running" "$WF_PATIENT_LOG" 2>/dev/null && break; sleep 1; done

# 乾淨起點：global WorkflowDefinition row 清走（殘留/上次 run — 版本編號要由 1 起）
q "DELETE FROM \"WorkflowDefinition\" WHERE \"clinicId\" IS NULL" >/dev/null 2>&1

wf_put() { # wf_put <key> <clinicId 可空> <params-json> → $W_CODE $W_OUT
  local cid_json="null"
  [ -n "$2" ] && cid_json="\"$2\""
  # ★ cwi-paintriage-20260903：dev loadManifest race（已知 flake — TOOLS.md T4）500 重試一次
  local _att
  for _att in 1 2; do
    W_CODE=$(curl -s -o /tmp/e2e-wf-put.json -w '%{http_code}' -b "$COOKIE_ADMIN" -X PUT "$BASE/api/admin/workflows/$1" \
      -H 'Content-Type: application/json' -d "{\"clinicId\":$cid_json,\"params\":$3}")
    if [ "$W_CODE" = "201" ] || [ "$W_CODE" != "500" ]; then break; fi
    sleep 1
  done
  W_OUT=$(cat /tmp/e2e-wf-put.json)
}
wf_publish() { # wf_publish <key> <defId> → $W_CODE $W_OUT
  local _att
  for _att in 1 2; do
    W_CODE=$(curl -s -o /tmp/e2e-wf-pub.json -w '%{http_code}' -b "$COOKIE_ADMIN" -X POST "$BASE/api/admin/workflows/$1/publish" \
      -H 'Content-Type: application/json' -d "{\"defId\":\"$2\"}")
    if [ "$W_CODE" = "200" ] || [ "$W_CODE" != "500" ]; then break; fi
    sleep 1
  done
  W_OUT=$(cat /tmp/e2e-wf-pub.json)
}
wf_revert() { # wf_revert <key> <clinicId 可空> <toVersion> → $W_CODE $W_OUT
  local cid_json="null"
  [ -n "$2" ] && cid_json="\"$2\""
  W_CODE=$(curl -s -o /tmp/e2e-wf-rev.json -w '%{http_code}' -b "$COOKIE_ADMIN" -X POST "$BASE/api/admin/workflows/$1/revert" \
    -H 'Content-Type: application/json' -d "{\"clinicId\":$cid_json,\"toVersion\":$3}")
  W_OUT=$(cat /tmp/e2e-wf-rev.json)
}
wf_get() { # wf_get <out-file> → $W_CODE（JSON 有效先算成功）
  # ★ 2026-08-25 run2/run3 教訓：dev manifest flake 會喺單次 GET 回 500/HTML（body 非 JSON）→ node -e 崩。
  #   retry 條件 = body 可 JSON.parse（唔係 status code — flake 有時 200 都回 HTML 500 page）
  local out="$1" code=""
  for _try in 1 2 3; do
    code=$(curl -s -o "$out" -w '%{http_code}' -b "$COOKIE_ADMIN" "$BASE/api/admin/workflows")
    if node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$out" 2>/dev/null; then
      W_CODE=$code
      return 0
    fi
    [ "$_try" -lt 3 ] && { echo "    (dev flake → workflows GET retry)"; sleep 2; }
  done
  W_CODE=$code
  return 0
}
# defaults 原句（同 src/lib/workflow/definitions.ts — W2 v1 行用）
WF_DEF_TRIAGE='{"humanCooldownMs":1800000,"confidenceFloor":0.6,"autoThanksReply":"唔緊要，祝你早日康復！"}'
WF_DEF_SESSION='{"maxTurns":12,"maxNoProgress":3,"candidateCount":5,"askProviderText":"想約邊位醫生？我哋有：{providers}","candidateHeader":"而家有以下時段：","candidateFooter":"直接覆編號或者講你想要嘅時間就得🙂","confirmText":"同你確認一次：{date} {time} {provider}，啱唔啱？","slotTakenText":"唔好意思，呢個時段啱啱滿咗。","handoffText":"等我搵職員直接同你安排 🙏","staleDisclaimer":"（時段以最終確認為準）"}'

# ── W1. triage cooldown：0 生效 + revert 還原 ────────────────────────────────────
echo "[W/4] W1: triage cooldown 0 生效 + revert 還原..."
patch_aimode "$TKW_CLINIC_ID" AUTO /tmp/e2e-w1-a.json; CODE=$PAM_CODE
check "W1 PATCH aiMode=AUTO → 200" "$CODE" "200"

wf_put triage "" "$WF_DEF_TRIAGE"
check "W1 PUT triage v1（defaults 30min）→ 201" "$W_CODE" "201"
WF_V1=$(echo "$W_OUT" | jf id)
wf_publish triage "$WF_V1"
check "W1 publish v1 → 200" "$W_CODE" "200"

W1_WA="8526901${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$W1_WA" --text "牙唔啱食嘢" --wamid "wamid.E2E_W1_1_${EPOCH}" --name "E2E W1" >/dev/null 2>&1 || fail "W1 mock-inbound msg1"
wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"waMessageId\"='wamid.E2E_W1_1_${EPOCH}'" '[{"c":"1"}]' 15
W1_MSG1=$(q "SELECT id FROM \"Message\" WHERE \"waMessageId\"='wamid.E2E_W1_1_${EPOCH}'" | jf id)
W1_CONV=$(pc_conv_of "$W1_WA" "$TKW_CLINIC_ID")
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$W1_MSG1'" '[{"s":"SENT_AUTO"}]' 30; then
  pass "W1 msg1 SENT_AUTO（cooldown 30min 首發唔受影響）"
else
  fail "W1 msg1 未 SENT_AUTO（v1 參數未生效？）"; W_FAIL=1
fi

# 職員覆核（OUT + sentByStaffId 非空 → 第八閘 human-recent 觸發源）
h1_req "$COOKIE_TKW" POST "$BASE/api/messages/send" "{\"conversationId\":\"$W1_CONV\",\"body\":\"e2e W1 職員覆核\"}"
check "W1 職員 send → 2xx" "$([ "${H1_CODE:0:1}" = "2" ] && echo y || echo n)" "y"
wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$W1_CONV' AND direction='OUT' AND \"sentByStaffId\" IS NOT NULL AND status='SENT'" '[{"c":"1"}]' 30

pnpm -s mock-inbound message --clinic TKW --from "$W1_WA" --text "牙唔啱食嘢" --wamid "wamid.E2E_W1_2_${EPOCH}" --name "E2E W1" >/dev/null 2>&1
wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"waMessageId\"='wamid.E2E_W1_2_${EPOCH}'" '[{"c":"1"}]' 15
W1_MSG2=$(q "SELECT id FROM \"Message\" WHERE \"waMessageId\"='wamid.E2E_W1_2_${EPOCH}'" | jf id)
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$W1_MSG2'" '[{"s":"PROPOSED"}]' 45; then
  pass "W1 msg2 PROPOSED（第八閘 human-recent 擋 auto）"
else
  fail "W1 msg2 未 PROPOSED（human-recent 閘失靈？）"; W_FAIL=1
fi
check "W1 msg2 無新 auto OUT（仍 1）" "$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$W1_CONV' AND direction='OUT' AND \"aiAutoSent\"=true" | jf c)" "1"
if grep -F "wamid.E2E_W1_2_${EPOCH}" "$WF_PATIENT_LOG" 2>/dev/null | grep -q "human-recent"; then
  pass "W1 worker log：msg2 block reasons 含 human-recent（metadata only）"
else
  fail "W1 worker log 無 msg2 human-recent 記錄"; W_FAIL=1
fi

# staff send 會 auto-assign 對話（send route：unassigned → sender 變 assignee）→ assignee gate 會永久擋 AUTO。
# 純 cooldown 測試：unassign 清走 assignee gate，隔離測第八閘。
h1_req "$COOKIE_TKW" POST "$BASE/api/conversations/$W1_CONV/assign" '{"toStaffId":null}'
check "W1 unassign → 200（清 assignee gate）" "$H1_CODE" "200"
check "W1 conv.assigneeId 已清" "$(q "SELECT (\"assigneeId\" IS NULL)::text n FROM \"Conversation\" WHERE id='$W1_CONV'" | jf n)" "true"

wf_put triage "" '{"humanCooldownMs":0,"confidenceFloor":0.6,"autoThanksReply":"唔緊要，祝你早日康復！"}'
check "W1 PUT triage v2（cooldown 0）→ 201" "$W_CODE" "201"
WF_V2=$(echo "$W_OUT" | jf id)
wf_publish triage "$WF_V2"
check "W1 publish v2 → 200" "$W_CODE" "200"

pnpm -s mock-inbound message --clinic TKW --from "$W1_WA" --text "牙唔啱食嘢" --wamid "wamid.E2E_W1_3_${EPOCH}" --name "E2E W1" >/dev/null 2>&1
wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"waMessageId\"='wamid.E2E_W1_3_${EPOCH}'" '[{"c":"1"}]' 15
W1_MSG3=$(q "SELECT id FROM \"Message\" WHERE \"waMessageId\"='wamid.E2E_W1_3_${EPOCH}'" | jf id)
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$W1_MSG3'" '[{"s":"SENT_AUTO"}]' 30; then
  pass "W1 msg3 SENT_AUTO（cooldown 0 publish 後即時生效 — 唔使重啟）"
else
  fail "W1 msg3 未 SENT_AUTO（TTL/cache 唔係 0？）"; W_FAIL=1
fi

wf_revert triage "" 1
check "W1 revert toVersion=1 → 200" "$W_CODE" "200"
W1_NV=$(node -e 'const j=JSON.parse(require("fs").readFileSync("/tmp/e2e-wf-rev.json","utf8"));console.log(j.newVersion)')
check "W1 revert newVersion=3（re-publish as v(n+1)）" "$W1_NV" "3"
wf_get /tmp/e2e-w1-get.json
W1_AV=$(node -e 'const j=JSON.parse(require("fs").readFileSync("/tmp/e2e-w1-get.json","utf8"));const w=j.workflows.find(x=>x.key==="triage");console.log(w.active.version+"|"+w.active.params.humanCooldownMs)')
check "W1 GET workflows：triage ACTIVE v3 + cooldown 還原 30min" "$W1_AV" "3|1800000"

pnpm -s mock-inbound message --clinic TKW --from "$W1_WA" --text "牙唔啱食嘢" --wamid "wamid.E2E_W1_4_${EPOCH}" --name "E2E W1" >/dev/null 2>&1
wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"waMessageId\"='wamid.E2E_W1_4_${EPOCH}'" '[{"c":"1"}]' 15
W1_MSG4=$(q "SELECT id FROM \"Message\" WHERE \"waMessageId\"='wamid.E2E_W1_4_${EPOCH}'" | jf id)
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$W1_MSG4'" '[{"s":"PROPOSED"}]' 45; then
  pass "W1 msg4 PROPOSED（revert 後 cooldown 30min 還原生效）"
else
  fail "W1 msg4 未 PROPOSED（revert 未生效？）"; W_FAIL=1
fi
check "W1 msg4 無新 auto OUT（仍 2）" "$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$W1_CONV' AND direction='OUT' AND \"aiAutoSent\"=true" | jf c)" "2"

# ── W2. booking-session confirmText 改字 → golden 重跑新文案 + revert ──────────
echo "[W/4] W2: confirmText 改字 → golden 3 訊息重跑新文案 + revert..."
wf_put booking-session "" "$WF_DEF_SESSION"
check "W2 PUT booking-session v1（defaults）→ 201" "$W_CODE" "201"
WF2_V1=$(echo "$W_OUT" | jf id)
wf_publish booking-session "$WF2_V1"
check "W2 publish v1 → 200" "$W_CODE" "200"

WF2_P2=$(node -e 'const p=JSON.parse(process.argv[1]);p.confirmText="e2e-W2確認：{date} {time} {provider} OK未？";console.log(JSON.stringify(p))' "$WF_DEF_SESSION")
wf_put booking-session "" "$WF2_P2"
check "W2 PUT v2（confirmText 改字）→ 201" "$W_CODE" "201"
WF2_V2=$(echo "$W_OUT" | jf id)
wf_publish booking-session "$WF2_V2"
check "W2 publish v2 → 200" "$W_CODE" "200"

# L3 policy 重建（PC cleanup 清咗 — EPOCH-scoped id，raw INSERT 必帶 id）
q "INSERT INTO \"AutomationPolicy\" (\"id\",\"clinicId\",\"category\",\"level\",\"updatedAt\") VALUES ('e2e-w2-tkw-l3-${EPOCH}','$TKW_CLINIC_ID','BOOKING_REQUEST','L3',now()) ON CONFLICT (\"clinicId\",\"category\") DO UPDATE SET \"level\"=EXCLUDED.\"level\" RETURNING \"id\"" >/dev/null 2>&1

W2_SLOT=""
for OFF in 1 2 3; do
  W2_SLOT=$(pc_pick "$TKW_CLINIC_ID" "" $OFF)
  [ -n "$W2_SLOT" ] && break
done
if [ -z "$W2_SLOT" ]; then
  fail "W2：TKW 無 15:00 空槽（offset 1-3 都冇）"; W_FAIL=1
else
  W2_P="${W2_SLOT%%|*}"; W2_D="${W2_SLOT##*|}"
  W2_SUR=$(pc_surname "$W2_P")
  W2_WA="8526902${EPOCH}"
  pnpm -s mock-inbound message --clinic TKW --from "$W2_WA" --text "想約${W2_SUR}醫生洗牙" --wamid "wamid.E2E_W2_1_${EPOCH}" --name "E2E W2" >/dev/null 2>&1
  wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"waMessageId\"='wamid.E2E_W2_1_${EPOCH}'" '[{"c":"1"}]' 15
  W2_CONV=$(pc_conv_of "$W2_WA" "$TKW_CLINIC_ID")
  if wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$W2_CONV' AND \"direction\"='OUT' AND type='text' AND status='SENT' AND \"bookingSessionId\" IS NOT NULL" '[{"c":"1"}]' 45; then
    pass "W2 r1 收到（候選 list）"
  else
    fail "W2 r1 未收到（session 未開？）"; W_FAIL=1
  fi
  W2_KW=$(pc_date_kw "$W2_D")
  pnpm -s mock-inbound message --clinic TKW --from "$W2_WA" --text "$W2_KW" --wamid "wamid.E2E_W2_2_${EPOCH}" --name "E2E W2" >/dev/null 2>&1
  if wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$W2_CONV' AND \"direction\"='OUT' AND type='text' AND status='SENT' AND \"bookingSessionId\" IS NOT NULL" '[{"c":"2"}]' 45; then
    pass "W2 r2 收到（日期濾候選）"
  else
    fail "W2 r2 未收到"; W_FAIL=1
  fi
  pnpm -s mock-inbound message --clinic TKW --from "$W2_WA" --text "三點啦" --wamid "wamid.E2E_W2_3_${EPOCH}" --name "E2E W2" >/dev/null 2>&1
  if wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$W2_CONV' AND \"direction\"='OUT' AND type='text' AND status='SENT' AND \"bookingSessionId\" IS NOT NULL" '[{"c":"3"}]' 45; then
    pass "W2 r3 收到（confirmLine）"
  else
    fail "W2 r3 未收到"; W_FAIL=1
  fi
  W2_R3=$(pc_sess_reply "$W2_CONV" 3)
  case "$W2_R3" in
    *"e2e-W2確認："*"OK未？") pass "W2 confirmLine 用 v2 新文案（ACTIVE 生效）：${W2_R3:0:70}";;
    *) fail "W2 confirmLine 未用新文案：${W2_R3:0:80}"; W_FAIL=1;;
  esac
  wf_revert booking-session "" 1
  check "W2 revert toVersion=1 → 200" "$W_CODE" "200"
  W2_NV=$(node -e 'const j=JSON.parse(require("fs").readFileSync("/tmp/e2e-wf-rev.json","utf8"));console.log(j.newVersion)')
  check "W2 revert newVersion=3" "$W2_NV" "3"
  wf_get /tmp/e2e-w2-get.json
  W2_CT=$(node -e 'const j=JSON.parse(require("fs").readFileSync("/tmp/e2e-w2-get.json","utf8"));const w=j.workflows.find(x=>x.key==="booking-session");console.log(w.active.params.confirmText)')
  check "W2 revert 後 confirmText 還原原句" "$W2_CT" "同你確認一次：{date} {time} {provider}，啱唔啱？"
fi

# ── W3. RBAC STAFF 403 + AuditLog ─────────────────────────────────────────
echo "[W/4] W3: STAFF 403 + AuditLog..."
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_TKW" -X PUT "$BASE/api/admin/workflows/triage" -H 'Content-Type: application/json' -d '{"clinicId":null,"params":{}}')
check "W3 STAFF PUT /workflows/triage → 403" "$CODE" "403"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_TKW" "$BASE/api/admin/workflows")
check "W3 STAFF GET /workflows → 403" "$CODE" "403"
A_DRAFT=$(q "SELECT count(*)::text c FROM \"AuditLog\" WHERE action='WORKFLOW_DRAFT'" | jf c)
A_PUB=$(q "SELECT count(*)::text c FROM \"AuditLog\" WHERE action='WORKFLOW_PUBLISH'" | jf c)
if [ "$A_DRAFT" -ge 6 ] 2>/dev/null; then pass "W3 AuditLog WORKFLOW_DRAFT ≥6（實際 $A_DRAFT）"; else fail "W3 WORKFLOW_DRAFT=$A_DRAFT <6"; W_FAIL=1; fi
if [ "$A_PUB" -ge 6 ] 2>/dev/null; then pass "W3 AuditLog WORKFLOW_PUBLISH ≥6（實際 $A_PUB）"; else fail "W3 WORKFLOW_PUBLISH=$A_PUB <6"; W_FAIL=1; fi
A_PUB_BS=$(q "SELECT count(*)::text c FROM \"AuditLog\" WHERE action='WORKFLOW_PUBLISH' AND \"meta\"->>'key'='booking-session'" | jf c)
if [ "$A_PUB_BS" -ge 3 ] 2>/dev/null; then pass "W3 audit meta.key 可審（booking-session publish ≥3，實際 $A_PUB_BS）"; else fail "W3 audit meta.key booking-session=$A_PUB_BS <3"; W_FAIL=1; fi

# ── W4. fail-soft：WorkflowDefinition 表 rename 走 → 全鏈照行 ─────────────────
echo "[W/4] W4: fail-soft（表 rename 走 → defaults 底）..."
# 冪等 pre-cleanup（上次 crash 殘留：broken 表存在而主表唔存在 → 還原）
TBL_MAIN=$(q "SELECT count(*)::text c FROM information_schema.tables WHERE table_name='WorkflowDefinition'" | jf c)
TBL_BROKEN=$(q "SELECT count(*)::text c FROM information_schema.tables WHERE table_name='WorkflowDefinition_e2eW4_broken'" | jf c)
if [ "$TBL_MAIN" = "0" ] && [ "$TBL_BROKEN" = "1" ]; then
  q 'ALTER TABLE "WorkflowDefinition_e2eW4_broken" RENAME TO "WorkflowDefinition"' >/dev/null 2>&1
fi
if q 'ALTER TABLE "WorkflowDefinition" RENAME TO "WorkflowDefinition_e2eW4_broken"' >/dev/null 2>&1; then
  pass "W4 表 rename 走（模擬 drop/斷線）"
else
  fail "W4 rename 失敗"; W_FAIL=1
fi
wf_get /tmp/e2e-w4-a.json
CODE=$W_CODE
check "W4 GET workflows（表死）→ 200 fail-soft（零 5xx）" "$CODE" "200"
check "W4 active source=defaults" "$(grep -oE '"source":"[a-z]+"' /tmp/e2e-w4-a.json | head -1)" '"source":"defaults"'

W4_WA="8526903${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$W4_WA" --text "牙唔啱食嘢" --wamid "wamid.E2E_W4_1_${EPOCH}" --name "E2E W4" >/dev/null 2>&1
wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"waMessageId\"='wamid.E2E_W4_1_${EPOCH}'" '[{"c":"1"}]' 15
W4_MSG1=$(q "SELECT id FROM \"Message\" WHERE \"waMessageId\"='wamid.E2E_W4_1_${EPOCH}'" | jf id)
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$W4_MSG1'" '[{"s":"SENT_AUTO"}]' 30; then
  pass "W4 表死仍 SENT_AUTO（fail-soft → code defaults 底，inbox 照行）"
else
  fail "W4 未 SENT_AUTO（fail-soft 失效？）"; W_FAIL=1
fi
if grep -q "fail-soft" "$WF_PATIENT_LOG" 2>/dev/null; then
  pass "W4 worker log 有 fail-soft warn（metadata only）"
else
  fail "W4 worker log 無 fail-soft 記錄"; W_FAIL=1
fi

# 還原 + 斷言表返嚟後 API 照行
q 'ALTER TABLE "WorkflowDefinition_e2eW4_broken" RENAME TO "WorkflowDefinition"' >/dev/null 2>&1
wf_get /tmp/e2e-w4-b.json
CODE=$W_CODE
check "W4 表還原 → GET 200" "$CODE" "200"
check "W4 還原後 source=global（row 返嚟）" "$(grep -oE '"source":"[a-z]+"' /tmp/e2e-w4-b.json | head -1)" '"source":"global"'

# ── W cleanup：global row 清走（unit/下次 run 要乾淨空間）+ aiMode 還原 DRAFT ──
q "DELETE FROM \"WorkflowDefinition\" WHERE \"clinicId\" IS NULL" >/dev/null 2>&1
# ★ W2 插入咗 TKW L3 policy（e2e-w2-tkw-l3-<epoch>）— 必清，否則下次 run 嘅 T-section（T14/T19/T23/T25）
#   撞 L3 session 路由 → legacy draft 斷言全爆（run2 教訓：run1 殘留 row 污染 run2）
q "DELETE FROM \"AutomationPolicy\" WHERE id='e2e-w2-tkw-l3-${EPOCH}'" >/dev/null 2>&1
patch_aimode "$TKW_CLINIC_ID" DRAFT; CODE=$PAM_CODE
check "W cleanup aiMode → DRAFT" "$CODE" "200"

# ── W summary ───────────────────────────────────────────────────────────
[ "$W_FAIL" = 0 ] && pass "R-W Phase D e2e（W1-W4：cooldown/revert/confirmText/RBAC+audit/fail-soft 全綠）" || fail "R-W Phase D 有項失敗（見上 ❌）"

# ═══ R-E: Phase E — 學習迴路 + 成熟度儀表板 + 級別開關 ═════════════════════
echo "[E/6] R-E: Phase E (stats / mining / flag / rollback / review / automation)..."
E_FAIL=0
COOKIE_EADM2=/tmp/e2e-cookie-eadm2.txt
E_START=$(date -u +%FT%TZ)

# ── E0. setup：第二 ADMIN + 白名單 env 重啟 server ───────────────────
# session secret 固定喺 .env — 重啟後 cookie 依然有效（SESSION_SECRET 唔變）
E2E_ADM2_EMAIL="e2e-adm2-${EPOCH}@e2e.local"
CODE=$(curl -s -o /tmp/e2e-e-adm2.json -w '%{http_code}' -b "$COOKIE_ADMIN" \
  -X POST "$BASE/api/admin/staff" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$E2E_ADM2_EMAIL\",\"name\":\"E2E Admin2\",\"role\":\"ADMIN\",\"clinicId\":null,\"password\":\"e2e-admin2-pass-123\"}")
check "E0 create 2nd ADMIN → 201" "$CODE" "201"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIE_EADM2" \
  -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$E2E_ADM2_EMAIL\",\"password\":\"e2e-admin2-pass-123\"}")
check "E0 login eadm2 → 200" "$CODE" "200"
EADM2_ID=$(q "SELECT id FROM \"StaffUser\" WHERE email='$E2E_ADM2_EMAIL'" | jf id)
[ -n "$EADM2_ID" ] || { echo "FATAL: eadm2 id 搵唔到"; exit 1; }

kill "$SERVER_PID" 2>/dev/null || true
pkill -f " server.ts" 2>/dev/null || true
sleep 2
lsof -ti:"$PORT" 2>/dev/null | xargs -r kill 2>/dev/null || true
AUTOMATION_ADMIN_STAFF_IDS="$EADM2_ID" nohup pnpm dev >/tmp/e2e-server-e.log 2>&1 &
SERVER_PID=$!
EUP=0
for i in $(seq 1 90); do
  if curl -sf "$BASE/healthz" >/dev/null 2>&1; then EUP=1; break; fi
  sleep 1
done
check "E0 server 重啟（AUTOMATION_ADMIN_STAFF_IDS=eadm2）" "$EUP" "1"

# 四個完整週（升序：最舊 → 最近）— 同 production 同一個 pure 函數算
E_WEEKS=($($TSX -e "import {lastFourCompleteWeeks} from './src/lib/ops/automation-stats'; console.log(lastFourCompleteWeeks().join(' '))" 2>/dev/null | tail -1))
[ "${#E_WEEKS[@]}" = "4" ] || { echo "FATAL: lastFourCompleteWeeks 回唔啱（${#E_WEEKS[@]} 個）"; exit 1; }
E_CURW=$($TSX -e "import {hkWeekStart} from './src/lib/ops/automation-stats'; console.log(hkWeekStart())" 2>/dev/null | tail -1)
[ -n "$E_CURW" ] || { echo "FATAL: E_CURW 計算失敗（hkWeekStart）"; exit 1; }
E_PREVWK="${E_WEEKS[3]}"   # 最近一個完整週 = mining 目標週

# ── E1. eligible 矩陣 + PATCH 白名單 + cache bust ────────────────────
# seed 四完整週（TKW·QUESTION）：draft=20 / 18+2（rate=1.0）/ 0 complaint / 0 rollback → eligible
for ws in "${E_WEEKS[@]}"; do
  q "INSERT INTO \"AutomationStat\" (id, \"clinicId\", category, \"weekStart\", \"draftCount\", \"adoptedAsIs\", \"adoptedEdited\", complaints, rollbacks) VALUES ('e2e-e-stat-${ws}-${EPOCH}', '$TKW_CLINIC_ID', 'QUESTION', '${ws}', 20, 18, 2, 0, 0) ON CONFLICT (\"clinicId\", category, \"weekStart\") DO UPDATE SET \"draftCount\"=20, \"adoptedAsIs\"=18, \"adoptedEdited\"=2, complaints=0, rollbacks=0" >/dev/null
done
CODE=$(curl -s -o /tmp/e2e-e-auto.json -w '%{http_code}' -b "$COOKIE_ADMIN" "$BASE/api/admin/automation")
check "E1 GET /admin/automation → 200" "$CODE" "200"
E_ELIG=$(node -e "const d=require('/tmp/e2e-e-auto.json');const c=d.clinics.find(x=>x.id==='$TKW_CLINIC_ID');console.log(c?c.cells.QUESTION.eligible:'NOCLINIC')")
check "E1 TKW·QUESTION eligible=true（四週 seed）" "$E_ELIG" "true"
E_ELIG_MF=$(node -e "const d=require('/tmp/e2e-e-auto.json');const c=d.clinics.find(x=>x.id==='$MF_CLINIC_ID');console.log(c?c.cells.QUESTION.eligible:'NOCLINIC')")
check "E1 MF·QUESTION eligible=false（零數據）" "$E_ELIG_MF" "false"

APL_BEFORE=$(q "SELECT count(*)::text c FROM \"AuditLog\" WHERE action='SET_AUTOMATION_LEVEL'" | jf c)
CODE=$(curl -s -o /tmp/e2e-e-patch.json -w '%{http_code}' -b "$COOKIE_EADM2" \
  -X PATCH "$BASE/api/admin/automation" -H 'Content-Type: application/json' \
  -d "{\"clinicId\":\"$TKW_CLINIC_ID\",\"category\":\"QUESTION\",\"level\":\"L3\"}")
check "E1 PATCH L3（eadm2 喺白名單）→ 200" "$CODE" "200"
curl -s -b "$COOKIE_ADMIN" "$BASE/api/admin/automation" -o /tmp/e2e-e-auto2.json
E_LVL=$(node -e "const d=require('/tmp/e2e-e-auto2.json');const c=d.clinics.find(x=>x.id==='$TKW_CLINIC_ID');console.log(c?c.cells.QUESTION.level:'NOCLINIC')")
check "E1 GET 矩陣即時 level=L3（cache bust）" "$E_LVL" "L3"
E_RES=$($TSX -e "import {getAutomationLevel} from './src/lib/ai/automation'; getAutomationLevel('$TKW_CLINIC_ID','QUESTION').then(l=>console.log(l)).catch(e=>console.log('ERR'))" 2>/dev/null | tail -1)
check "E1 resolver getAutomationLevel = L3" "$E_RES" "L3"
APL_AFTER=$(q "SELECT count(*)::text c FROM \"AuditLog\" WHERE action='SET_AUTOMATION_LEVEL'" | jf c)
check "E1 AuditLog SET_AUTOMATION_LEVEL +1" "$((APL_AFTER - APL_BEFORE))" "1"

# ── E2. 403 白名單外 + locked 400 ─────────────────────────────────────
CODE=$(curl -s -o /tmp/e2e-e-403.json -w '%{http_code}' -b "$COOKIE_ADMIN" \
  -X PATCH "$BASE/api/admin/automation" -H 'Content-Type: application/json' \
  -d "{\"clinicId\":\"$MF_CLINIC_ID\",\"category\":\"QUESTION\",\"level\":\"L2\"}")
check "E2 主 admin（白名單外）PATCH → 403" "$CODE" "403"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_EADM2" \
  -X PATCH "$BASE/api/admin/automation" -H 'Content-Type: application/json' \
  -d "{\"clinicId\":\"$TKW_CLINIC_ID\",\"category\":\"URGENT_PAIN\",\"level\":\"L3\"}")
check "E2 URGENT_PAIN PATCH → 400（locked）" "$CODE" "400"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_EADM2" \
  -X PATCH "$BASE/api/admin/automation" -H 'Content-Type: application/json' \
  -d "{\"clinicId\":\"$TKW_CLINIC_ID\",\"category\":\"COMPLAINT\",\"level\":\"L3\"}")
check "E2 COMPLAINT PATCH → 400（locked）" "$CODE" "400"

# ── E3. flag → complaints+1 → eligible 熄 ─────────────────────────────
# hermetic fixture：自建乾淨對話（intent NULL → UNKNOWN row；唔依賴前段殘留狀態）
E3_C="e2e-e3-c1-${EPOCH}"; E3_V="e2e-e3-v1-${EPOCH}"
q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\") VALUES ('$E3_C','$TKW_CLINIC_ID','8526088${EPOCH}')" >/dev/null
q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", \"lastMessageAt\") VALUES ('$E3_V','$TKW_CLINIC_ID','$E3_C',now())" >/dev/null
E_FLAG_INTENT="UNKNOWN"   # conversation.intent NULL → 記帳落 UNKNOWN
CODE=$(curl -s -o /tmp/e2e-e-flag.json -w '%{http_code}' -b "$COOKIE_TKW" \
  -X POST "$BASE/api/conversations/$E3_V/flag" -H 'Content-Type: application/json' -d '{"kind":"COMPLAINT"}')
check "E3 flag COMPLAINT → 200" "$CODE" "200"
check "E3 counted=true" "$(grep -o '"counted":true' /tmp/e2e-e-flag.json)" '"counted":true'
E_COMP=$(q "SELECT complaints::text c FROM \"AutomationStat\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND category='$E_FLAG_INTENT' AND \"weekStart\"='$E_CURW'" | jf c)
check "E3 本週（未完成）complaints=1（即時記帳）" "$E_COMP" "1"
CODE=$(curl -s -o /tmp/e2e-e-flag2.json -w '%{http_code}' -b "$COOKIE_TKW" \
  -X POST "$BASE/api/conversations/$E3_V/flag" -H 'Content-Type: application/json' -d '{"kind":"COMPLAINT"}')
check "E3 重複 flag → 200" "$CODE" "200"
check "E3 24h 冪等 counted=false" "$(grep -o '"counted":false' /tmp/e2e-e-flag2.json)" '"counted":false'
# 偏離註：eligibility 窗口只用「四個完整週」；flag 按設計計落本週（未完成週）。
#   要驗證「complaint → eligible 熄」聯動，直接 UPDATE 一個已 seed 嘅完整週 row。
q "UPDATE \"AutomationStat\" SET complaints=1 WHERE id='e2e-e-stat-${E_WEEKS[1]}-${EPOCH}'" >/dev/null
curl -s -b "$COOKIE_ADMIN" "$BASE/api/admin/automation" -o /tmp/e2e-e-auto3.json
E_ELIG2=$(node -e "const d=require('/tmp/e2e-e-auto3.json');const c=d.clinics.find(x=>x.id==='$TKW_CLINIC_ID');console.log(c?c.cells.QUESTION.eligible:'NOCLINIC')")
check "E3 完整週 complaints=1 → eligible=false" "$E_ELIG2" "false"
E_REASONS=$(node -e "const d=require('/tmp/e2e-e-auto3.json');const c=d.clinics.find(x=>x.id==='$TKW_CLINIC_ID');console.log(c&&c.cells.QUESTION.reasons.length>0)")
check "E3 reasons 非空" "$E_REASONS" "true"

# ── E4. autoBooked rollback 記帳（manual 唔計）────────────────────────
# hermetic fixture：自建未分配對話（rollback 會 423 非負責人 — 自建 = 零 assignee）
E4_C="e2e-e4-c1-${EPOCH}"; E4_V="e2e-e4-v1-${EPOCH}"
q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\") VALUES ('$E4_C','$TKW_CLINIC_ID','8526087${EPOCH}')" >/dev/null
q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", \"lastMessageAt\") VALUES ('$E4_V','$TKW_CLINIC_ID','$E4_C',now())" >/dev/null
E_ROLL_CONV="$E4_V"
E_BK1="e2e-e4-bk1-${EPOCH}"; E_BK2="e2e-e4-bk2-${EPOCH}"
E_TODAY=$(date +%F)
q "INSERT INTO \"BookingRequest\" (id, \"conversationId\", \"clinicId\", \"flowToken\", \"providerApricotId\", \"providerName\", \"requestedDate\", \"requestedTime\", status, \"handledByStaffId\", \"handledAt\", \"apricotApptId\", \"autoBooked\") VALUES ('$E_BK1','$E_ROLL_CONV','$TKW_CLINIC_ID','e2e-e4-ft1-${EPOCH}','mock-pract-tkw-1','e2e doc','${E_TODAY}','10:30','CONFIRMED',(SELECT id FROM \"StaffUser\" WHERE email='$TKW_EMAIL'),now(),'e2e-e4-appt-${EPOCH}',true)" >/dev/null
CODE=$(curl -s -o /tmp/e2e-e-rb1.json -w '%{http_code}' -b "$COOKIE_TKW" -X POST "$BASE/api/bookings/$E_BK1/rollback")
check "E4 autoBooked rollback → 200" "$CODE" "200"
E_RB=$(q "SELECT rollbacks::text c FROM \"AutomationStat\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND category='BOOKING_REQUEST' AND \"weekStart\"='$E_CURW'" | jf c)
check "E4 rollbacks=1（autoBooked 記帳）" "$E_RB" "1"
q "INSERT INTO \"BookingRequest\" (id, \"conversationId\", \"clinicId\", \"flowToken\", \"providerApricotId\", \"providerName\", \"requestedDate\", \"requestedTime\", status, \"handledByStaffId\", \"handledAt\", \"apricotApptId\", \"autoBooked\") VALUES ('$E_BK2','$E_ROLL_CONV','$TKW_CLINIC_ID','e2e-e4-ft2-${EPOCH}','mock-pract-tkw-1','e2e doc','${E_TODAY}','11:00','CONFIRMED',(SELECT id FROM \"StaffUser\" WHERE email='$TKW_EMAIL'),now(),'e2e-e4-appt2-${EPOCH}',false)" >/dev/null
CODE=$(curl -s -o /tmp/e2e-e-rb2.json -w '%{http_code}' -b "$COOKIE_TKW" -X POST "$BASE/api/bookings/$E_BK2/rollback")
check "E4 manual rollback → 200" "$CODE" "200"
E_RB2=$(q "SELECT rollbacks::text c FROM \"AutomationStat\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND category='BOOKING_REQUEST' AND \"weekStart\"='$E_CURW'" | jf c)
check "E4 rollbacks 仍然 1（manual 唔計）" "$E_RB2" "1"

# ── E5. FAQ 卡全鏈：mining → 通知 → review → APPROVED → prompt 斷言 ──
# fixture：上週（= 最近完整週）5 條 SENT_EDITED QUESTION（evidence 塞 bait）
E5_C="e2e-e5-c1-${EPOCH}"; E5_V="e2e-e5-v1-${EPOCH}"
E5_TAIL=$(node -e "console.log(String((Date.now()*7919)%100000000).padStart(8,'0'))")
E5_WA="8526099${E5_TAIL}"
E5_BAIT="E2E採名丙"
E5_DRAFTAT=$($TSX -e "import {hkWeekStart,weekRangeUtc} from './src/lib/ops/automation-stats'; const ws=hkWeekStart(new Date(Date.now()-7*86400000)); const [lo]=weekRangeUtc(ws); console.log(new Date(lo.getTime()+2*86400000+8*3600000).toISOString())" 2>/dev/null | tail -1)
q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\", \"profileName\") VALUES ('$E5_C','$TKW_CLINIC_ID','$E5_WA','$E5_BAIT')" >/dev/null
q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", \"lastMessageAt\") VALUES ('$E5_V','$TKW_CLINIC_ID','$E5_C','$E5_DRAFTAT')" >/dev/null
for i in 1 2 3 4 5; do
  q "INSERT INTO \"AiDraft\" (id, \"conversationId\", \"inReplyToMessageId\", \"draftText\", model, \"latencyMs\", status, intent, \"finalText\", \"createdAt\") VALUES ('e2e-e5-d${i}-${EPOCH}','$E5_V','e2e-e5-m${i}-${EPOCH}','草稿版本${i}：病人 ${E5_BAIT} 電話尾 ${E5_TAIL} 問埋位','unit',1,'SENT_EDITED','QUESTION','人手改寫版本${i}（已答覆）','$E5_DRAFTAT')" >/dev/null
done
# stats-weekly job：runWeeklyStats（上週）+ runMining（上週）— 全鏈
pnpm -s e2e:cron stats-weekly >/dev/null 2>&1
if wait_for "SELECT count(*)::text c FROM \"SuggestionCard\" WHERE kind='FAQ' AND \"clinicId\"='$TKW_CLINIC_ID' AND \"payload\"->>'fingerprint'='faq:${TKW_CLINIC_ID}:QUESTION:${E_PREVWK}'" '[{"c":"1"}]' 60; then
  pass "E5 mining 出 FAQ 卡（stats-weekly 全鏈，fingerprint 冪等）"
else
  fail "E5 mining 未出 FAQ 卡"; E_FAIL=1
fi
E5_CARD=$(q "SELECT id FROM \"SuggestionCard\" WHERE \"payload\"->>'fingerprint'='faq:${TKW_CLINIC_ID}:QUESTION:${E_PREVWK}'" | jf id)
E5_NOTE=$(q "SELECT count(*)::text c FROM \"StaffNotice\" WHERE kind='SUGGESTION_READY' AND \"meta\"->>'cardId'='$E5_CARD'" | jf c)
check "E5 StaffNotice SUGGESTION_READY = 1" "$E5_NOTE" "1"
E5_BLOB=$(q "SELECT \"title\" t, \"evidence\"::text e FROM \"SuggestionCard\" WHERE id='$E5_CARD'")
echo "$E5_BLOB" | grep -q "$E5_BAIT" && { fail "E5 PII：title/evidence 含假名"; E_FAIL=1; } || pass "E5 PII：title/evidence 零假名"
echo "$E5_BLOB" | grep -q "$E5_TAIL" && { fail "E5 PII：title/evidence 含電話尾號"; E_FAIL=1; } || pass "E5 PII：title/evidence 零電話尾號"
CODE=$(curl -s -o /tmp/e2e-e-sugg.json -w '%{http_code}' -b "$COOKIE_ADMIN" "$BASE/api/admin/suggestions?status=PROPOSED")
check "E5 GET /admin/suggestions → 200" "$CODE" "200"
check "E5 卡喺 PROPOSED 列表" "$(grep -c "$E5_CARD" /tmp/e2e-e-sugg.json)" "1"
E5_Q="e2e-e5-q-${EPOCH}"; E5_A="e2e-e5-a-${EPOCH}"
CODE=$(curl -s -o /tmp/e2e-e-decide.json -w '%{http_code}' -b "$COOKIE_ADMIN" \
  -X POST "$BASE/api/admin/suggestions/$E5_CARD/decide" -H 'Content-Type: application/json' \
  -d "{\"decision\":\"APPROVED\",\"edits\":{\"faq\":{\"q\":\"$E5_Q\",\"a\":\"$E5_A\"}}}")
check "E5 APPROVED（FAQ edits）→ 200" "$CODE" "200"
E5_FAQ=$(q "SELECT count(*)::text c FROM \"Clinic\" WHERE code='TKW' AND \"greetingConfig\"->'faq' @> '[{\"q\":\"$E5_Q\"}]'" | jf c)
check "E5 greetingConfig.faq 已 append" "$E5_FAQ" "1"
E5_PROMPT_HIT=$($TSX -e "
import { PrismaClient } from '@prisma/client';
import { buildUserPrompt } from './src/lib/ai/prompts';
(async () => {
  const p = new PrismaClient();
  const c = await p.clinic.findUnique({ where: { code: 'TKW' } });
  await p.\$disconnect();
  const prompt = buildUserPrompt({ messages: [], clinic: { name: c.name, greetingConfig: c.greetingConfig } });
  console.log(prompt.includes('$E5_A') ? 'HIT' : 'MISS');
})().catch((e) => { console.error(e); process.exit(1); });
" 2>/dev/null | tail -1)
check "E5 mock prompt 含已批准 FAQ A（學習迴路閉環）" "$E5_PROMPT_HIT" "HIT"

# ── E6. REJECT 零變化 snapshot ─────────────────────────────────────────
E6_CARD="e2e-e6-card-${EPOCH}"
q "INSERT INTO \"SuggestionCard\" (id, \"clinicId\", kind, title, payload, evidence) VALUES ('$E6_CARD','$TKW_CLINIC_ID','TEMPLATE','e2e-e6 模板建議','{\"fingerprint\":\"template:e2e-e6-${EPOCH}\"}','{\"counts\":{},\"samples\":[]}')" >/dev/null
SNAP_GC=$(q "SELECT coalesce(\"greetingConfig\"::text,'') gc FROM \"Clinic\" ORDER BY id" | md5sum | cut -d' ' -f1)
SNAP_WF=$(q "SELECT count(*)::text c FROM \"WorkflowDefinition\"" | jf c)
SNAP_POL=$(q "SELECT count(*)::text c FROM \"AutomationPolicy\"" | jf c)
CODE=$(curl -s -o /tmp/e2e-e-rej.json -w '%{http_code}' -b "$COOKIE_ADMIN" \
  -X POST "$BASE/api/admin/suggestions/$E6_CARD/decide" -H 'Content-Type: application/json' \
  -d '{"decision":"REJECTED"}')
check "E6 REJECTED → 200" "$CODE" "200"
check "E6 card status=REJECTED" "$(q "SELECT status::text c FROM \"SuggestionCard\" WHERE id='$E6_CARD'" | jf c)" "REJECTED"
SNAP_GC2=$(q "SELECT coalesce(\"greetingConfig\"::text,'') gc FROM \"Clinic\" ORDER BY id" | md5sum | cut -d' ' -f1)
check "E6 greetingConfig 零變化（snapshot）" "$SNAP_GC2" "$SNAP_GC"
check "E6 WorkflowDefinition 零變化" "$(q "SELECT count(*)::text c FROM \"WorkflowDefinition\"" | jf c)" "$SNAP_WF"
check "E6 AutomationPolicy 零變化" "$(q "SELECT count(*)::text c FROM \"AutomationPolicy\"" | jf c)" "$SNAP_POL"
E6_AUDIT=$(q "SELECT count(*)::text c FROM \"AuditLog\" WHERE action='SUGGESTION_DECIDE' AND \"entityId\"='$E6_CARD'" | jf c)
check "E6 audit SUGGESTION_DECIDE = 1" "$E6_AUDIT" "1"

# ── E7 (T89). Fix B（cwi-fix-20260825-f1）：policy 壓 AUTO + 跨 process cache broadcast ──────
#   MF→AUTO + PATCH QUESTION=L1（白名單 admin eadm2）→ 病人 QUESTION → draft 照出 + 0 自動發 + log policy-L1；
#   PATCH QUESTION=L2（唔手動 clear cache — worker 靠 control channel 廣播即時失效）
#   → 同類訊息 → 自動發（aiAutoSent=1）。broadcast 唔通 → 第二項會 0（5 分鐘 TTL cache 遮住）。
echo "[E/6] T89: policy L1 suppresses AUTO + cache broadcast (Fix B)..."
# ★ hermetic：PC-G5 之後嘅 worker 仲帶 AI_GLOBAL_MAX_LEVEL=L2（cap 壓 L3 — T90 baseline session 唔會開）—
#   照 T77/PC-G5 既有 pattern 用乾淨 env 重啟 worker（無 global cap）
pkill -f "src/workers/index.ts" 2>/dev/null || true
sleep 1
nohup pnpm worker >/tmp/e2e-worker-t89w.log 2>&1 &
WORKER_PID=$!
T89W=0
for i in $(seq 1 60); do grep -q "all workers running" /tmp/e2e-worker-t89w.log 2>/dev/null && { T89W=1; break; }; sleep 1; done
check "T89 worker 重啟（乾淨 env，無 global cap）" "$T89W" "1"
T89=0
patch_aimode "$MF_CLINIC_ID" AUTO; CODE=$PAM_CODE
check "T89 MF→AUTO" "$CODE" "200"
T89_C="e2e-t89-c-${EPOCH}"; T89_V="e2e-t89-v-${EPOCH}"; T89_PAT="8526201${EPOCH}"
q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\", \"profileName\") VALUES ('$T89_C','$MF_CLINIC_ID','$T89_PAT','E2E T89')" >/dev/null
q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", \"lastMessageAt\") VALUES ('$T89_V','$MF_CLINIC_ID','$T89_C',now())" >/dev/null
CODE=$(curl -s -o /tmp/e2e-t89-p1.json -w '%{http_code}' -b "$COOKIE_EADM2" \
  -X PATCH "$BASE/api/admin/automation" -H 'Content-Type: application/json' \
  -d "{\"clinicId\":\"$MF_CLINIC_ID\",\"category\":\"QUESTION\",\"level\":\"L1\"}")
check "T89 PATCH QUESTION=L1 (eadm2) → 200" "$CODE" "200"
T89_W1="wamid.E2E_T89_1_${EPOCH}"
pnpm -s mock-inbound message --clinic MF --from "$T89_PAT" --text "你哋幾點開門" --wamid "$T89_W1" --name "E2E T89 q1" >/dev/null || fail "T89 mock-inbound 1"
T89_M1=$(q "SELECT id FROM \"Message\" WHERE \"waMessageId\"='$T89_W1'" | jf id)
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$T89_M1'" '[{"s":"PROPOSED"}]' 30; then
  pass "T89 L1 壓 AUTO：draft 照出（PROPOSED）"
else
  fail "T89 draft 未出"; T89=1
fi
sleep 2
check "T89 L1 壓 AUTO：0 aiAutoSent OUT" "$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$T89_V' AND direction='OUT' AND \"aiAutoSent\"=true" | jf c)" "0"
grep -F "$T89_W1" /tmp/e2e-worker*.log 2>/dev/null | grep -q "policy-L1" && pass "T89 log 見 policy-L1" || { fail "T89 policy-L1 log 唔見"; T89=1; }
CODE=$(curl -s -o /tmp/e2e-t89-p2.json -w '%{http_code}' -b "$COOKIE_EADM2" \
  -X PATCH "$BASE/api/admin/automation" -H 'Content-Type: application/json' \
  -d "{\"clinicId\":\"$MF_CLINIC_ID\",\"category\":\"QUESTION\",\"level\":\"L2\"}")
check "T89 PATCH QUESTION=L2（broadcast，唔手動 clear）→ 200" "$CODE" "200"
T89_W2="wamid.E2E_T89_2_${EPOCH}"
pnpm -s mock-inbound message --clinic MF --from "$T89_PAT" --text "你哋幾點收門" --wamid "$T89_W2" --name "E2E T89 q2" >/dev/null || fail "T89 mock-inbound 2"
if wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$T89_V' AND direction='OUT' AND \"aiAutoSent\"=true" '[{"c":"1"}]' 30; then
  pass "T89 broadcast 即刻生效：同類訊息自動發（aiAutoSent=1）"
else
  fail "T89 自動發未發生（broadcast 未通？）"; T89=1
fi
# hermetic：末態 = 冇 row + worker cache L1（= DRAFT fallback，harmless）
curl -s -o /dev/null -b "$COOKIE_EADM2" -X PATCH "$BASE/api/admin/automation" -H 'Content-Type: application/json' \
  -d "{\"clinicId\":\"$MF_CLINIC_ID\",\"category\":\"QUESTION\",\"level\":\"L1\"}" >/dev/null 2>&1
q "DELETE FROM \"AutomationPolicy\" WHERE \"clinicId\"='$MF_CLINIC_ID' AND category='QUESTION'" >/dev/null 2>&1
q "DELETE FROM \"AiDraft\" WHERE \"conversationId\"='$T89_V'" >/dev/null 2>&1
q "DELETE FROM \"Message\" WHERE \"conversationId\"='$T89_V'" >/dev/null 2>&1
q "DELETE FROM \"Conversation\" WHERE id='$T89_V'" >/dev/null 2>&1
q "DELETE FROM \"Contact\" WHERE id='$T89_C'" >/dev/null 2>&1
[ "$T89" = 0 ] && pass "T89 Fix B：policy 壓 AUTO + cache broadcast 全鏈" || { fail "T89 有項失敗（見上 ❌）"; E_FAIL=1; }

# ── E8 (T90). Fix B（cwi-fix-20260825-f1）：panic 全店降 L1 — 文字自動覆 + L3 session 全停 ────
#   Baseline：TKW "*"=L3 → BOOKING_REQUEST 解到 L3 → session 開；
#   panic：MF "*"→L1（AUTO 店文字唔再自動發 + policy-L1）/ TKW "*"→L1（L3 店 session 唔開，只出 draft）。
#   ★ resolver 語義（現有設計，unit-session-engine [12]）：exact row > star row —
#     panic 降嘅係店 star level；店自設 exact L2+ row 嘅類別保持原 level（儀表板文案同語義）。
echo "[E/6] T90: panic '*'→L1 full chain (Fix B)..."
T90=0
CODE=$(curl -s -o /tmp/e2e-t90-p0.json -w '%{http_code}' -b "$COOKIE_EADM2" \
  -X PATCH "$BASE/api/admin/automation" -H 'Content-Type: application/json' \
  -d "{\"clinicId\":\"$TKW_CLINIC_ID\",\"category\":\"*\",\"level\":\"L3\"}")
check "T90 baseline TKW '*'=L3 → 200" "$CODE" "200"
T90_C1="e2e-t90-c1-${EPOCH}"; T90_V1="e2e-t90-v1-${EPOCH}"; T90_PAT1="8526202${EPOCH}"
# ★ raw INSERT 必帶必填欄：Contact.labels（無 default）/ Conversation.status — 漏咗 = 靜默失敗（q 吞 stderr）
#   → worker 自建新 contact/conv → 斷言盯住預建 id 失明（run3 實測：session 其實開咗喺 worker 個 conv）
q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\", \"profileName\", labels) VALUES ('$T90_C1','$TKW_CLINIC_ID','$T90_PAT1','E2E T90 b', ARRAY[]::text[])" >/dev/null 2>&1
q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", status, \"lastMessageAt\") VALUES ('$T90_V1','$TKW_CLINIC_ID','$T90_C1','OPEN',now())" >/dev/null 2>&1
T90_W0="wamid.E2E_T90_0_${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$T90_PAT1" --text "想預約下週有冇位" --wamid "$T90_W0" --name "E2E T90 booking" >/dev/null || fail "T90 mock-inbound baseline"
# ★ 斷言跟訊息實際落喺邊個 conversation（預建行萬一唔喺，worker 會建新 conv — 唔死盯預建 id）
T90_M0=$(q "SELECT id FROM \"Message\" WHERE \"waMessageId\"='$T90_W0'" | jf id)
T90_B0V=$(q "SELECT \"conversationId\" FROM \"Message\" WHERE id='$T90_M0'" | jf conversationId)
if wait_for "SELECT count(*)::text c FROM \"BookingSession\" WHERE \"conversationId\"='$T90_B0V'" '[{"c":"1"}]' 30; then
  pass "T90 baseline：L3 店 BOOKING_REQUEST 開 session"
else
  fail "T90 baseline session 未開"; T90=1
fi
CODE=$(curl -s -o /tmp/e2e-t90-p1.json -w '%{http_code}' -b "$COOKIE_EADM2" \
  -X PATCH "$BASE/api/admin/automation" -H 'Content-Type: application/json' \
  -d "{\"clinicId\":\"$MF_CLINIC_ID\",\"category\":\"*\",\"level\":\"L1\"}")
check "T90 panic MF '*'→L1 → 200" "$CODE" "200"
CODE=$(curl -s -o /tmp/e2e-t90-p2.json -w '%{http_code}' -b "$COOKIE_EADM2" \
  -X PATCH "$BASE/api/admin/automation" -H 'Content-Type: application/json' \
  -d "{\"clinicId\":\"$TKW_CLINIC_ID\",\"category\":\"*\",\"level\":\"L1\"}")
check "T90 panic TKW '*'→L1 → 200" "$CODE" "200"
# MF（AUTO — T89 轉咗）：QUESTION 唔再自動發
T90_CM="e2e-t90-cm-${EPOCH}"; T90_VM="e2e-t90-vm-${EPOCH}"; T90_PATM="8526204${EPOCH}"
q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\", \"profileName\", labels) VALUES ('$T90_CM','$MF_CLINIC_ID','$T90_PATM','E2E T90 q', ARRAY[]::text[])" >/dev/null 2>&1
q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", status, \"lastMessageAt\") VALUES ('$T90_VM','$MF_CLINIC_ID','$T90_CM','OPEN',now())" >/dev/null 2>&1
T90_W1="wamid.E2E_T90_1_${EPOCH}"
pnpm -s mock-inbound message --clinic MF --from "$T90_PATM" --text "你哋幾點開門" --wamid "$T90_W1" --name "E2E T90 q" >/dev/null || fail "T90 mock-inbound MF"
T90_M1=$(q "SELECT id FROM \"Message\" WHERE \"waMessageId\"='$T90_W1'" | jf id)
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$T90_M1'" '[{"s":"PROPOSED"}]' 30; then
  pass "T90 panic：MF QUESTION draft 照出"
else
  fail "T90 MF draft 未出"; T90=1
fi
sleep 2
T90_B1V=$(q "SELECT \"conversationId\" FROM \"Message\" WHERE id='$T90_M1'" | jf conversationId)
check "T90 panic：MF AUTO 店 0 aiAutoSent" "$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$T90_B1V' AND direction='OUT' AND \"aiAutoSent\"=true" | jf c)" "0"
grep -F "$T90_W1" /tmp/e2e-worker*.log 2>/dev/null | grep -q "policy-L1" && pass "T90 MF log 見 policy-L1" || { fail "T90 MF policy-L1 唔見"; T90=1; }
# TKW（L3 店）：新 BOOKING_REQUEST 唔再開 session，只出 draft
T90_C2="e2e-t90-c2-${EPOCH}"; T90_V2="e2e-t90-v2-${EPOCH}"; T90_PAT2="8526203${EPOCH}"
q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\", \"profileName\", labels) VALUES ('$T90_C2','$TKW_CLINIC_ID','$T90_PAT2','E2E T90 b2', ARRAY[]::text[])" >/dev/null 2>&1
q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", status, \"lastMessageAt\") VALUES ('$T90_V2','$TKW_CLINIC_ID','$T90_C2','OPEN',now())" >/dev/null 2>&1
T90_W2="wamid.E2E_T90_2_${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$T90_PAT2" --text "想預約下週有冇位" --wamid "$T90_W2" --name "E2E T90 b2" >/dev/null || fail "T90 mock-inbound TKW2"
T90_M2=$(q "SELECT id FROM \"Message\" WHERE \"waMessageId\"='$T90_W2'" | jf id)
T90_B2V=$(q "SELECT \"conversationId\" FROM \"Message\" WHERE id='$T90_M2'" | jf conversationId)
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$T90_M2'" '[{"s":"PROPOSED"}]' 30; then
  pass "T90 panic：L3 店 BOOKING_REQUEST 跌落 draft 行為（PROPOSED）"
else
  fail "T90 TKW draft 未出"; T90=1
fi
check "T90 panic：L3 店 session 唔開（0 BookingSession）" "$(q "SELECT count(*)::text c FROM \"BookingSession\" WHERE \"conversationId\"='$T90_B2V'" | jf c)" "0"
# hermetic cleanup（waId 為本：預建行萬一靜默失敗，worker 會自建 cuid contact/conv — 殘留要 sweep）
for pat in "$T90_PAT1" "$T90_PATM" "$T90_PAT2"; do
  CONV_SUB="SELECT id FROM \"Conversation\" cv JOIN \"Contact\" ct ON ct.id=cv.\"contactId\" WHERE ct.\"waId\"='$pat'"
  q "DELETE FROM \"BookingSession\" WHERE \"conversationId\" IN ($CONV_SUB)" >/dev/null 2>&1
  q "DELETE FROM \"BookingRequest\" WHERE \"conversationId\" IN ($CONV_SUB)" >/dev/null 2>&1
  q "DELETE FROM \"AiDraft\" WHERE \"conversationId\" IN ($CONV_SUB)" >/dev/null 2>&1
  q "DELETE FROM \"Message\" WHERE \"conversationId\" IN ($CONV_SUB)" >/dev/null 2>&1
  q "DELETE FROM \"Conversation\" cv USING \"Contact\" ct WHERE ct.id=cv.\"contactId\" AND ct.\"waId\"='$pat'" >/dev/null 2>&1
  q "DELETE FROM \"Contact\" WHERE \"waId\"='$pat'" >/dev/null 2>&1
done
q "DELETE FROM \"AutomationPolicy\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND category='*'" >/dev/null 2>&1
q "DELETE FROM \"AutomationPolicy\" WHERE \"clinicId\"='$MF_CLINIC_ID' AND category='*'" >/dev/null 2>&1
patch_aimode "$MF_CLINIC_ID" DRAFT; CODE=$PAM_CODE
check "T90 MF 還原 DRAFT" "$CODE" "200"
[ "$T90" = 0 ] && pass "T90 Fix B：panic 全店降 L1 全鏈" || { fail "T90 有項失敗（見上 ❌）"; E_FAIL=1; }

# ── R-E cleanup（持久 DB 衞生 — 所有 fixture / 副作用全清）───────────────
q "DELETE FROM \"SuggestionCard\" WHERE id IN ('$E5_CARD','$E6_CARD')" >/dev/null 2>&1
q "DELETE FROM \"StaffNotice\" WHERE kind='SUGGESTION_READY' AND \"meta\"->>'cardId' IN ('$E5_CARD','$E6_CARD')" >/dev/null 2>&1
q "DELETE FROM \"AiDraft\" WHERE id LIKE 'e2e-e5-%'" >/dev/null 2>&1
q "DELETE FROM \"Conversation\" WHERE id IN ('$E5_V','$E3_V','$E4_V')" >/dev/null 2>&1
q "DELETE FROM \"Contact\" WHERE id IN ('$E5_C','$E3_C','$E4_C')" >/dev/null 2>&1
q "DELETE FROM \"BookingRequest\" WHERE id IN ('$E_BK1','$E_BK2')" >/dev/null 2>&1
q "DELETE FROM \"AutomationStat\" WHERE id LIKE 'e2e-e-stat-%'" >/dev/null 2>&1
# 本週 bump row：冇其他數據 → 整行清；有 → 只歸零 complaints/rollbacks
for cat in "$E_FLAG_INTENT" "BOOKING_REQUEST"; do
  q "DELETE FROM \"AutomationStat\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND category='$cat' AND \"weekStart\"='$E_CURW' AND \"draftCount\"=0 AND \"adoptedAsIs\"=0 AND \"adoptedEdited\"=0 AND \"autoSent\"=0" >/dev/null 2>&1
  q "UPDATE \"AutomationStat\" SET complaints=0, rollbacks=0 WHERE \"clinicId\"='$TKW_CLINIC_ID' AND category='$cat' AND \"weekStart\"='$E_CURW'" >/dev/null 2>&1
done
# E1 PATCH 建嘅 (TKW, QUESTION) policy — 必須清，否則污染下次 run 嘅 T-section 路由
q "DELETE FROM \"AutomationPolicy\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND category='QUESTION'" >/dev/null 2>&1
# E5 APPROVED 落嘅 FAQ 還原出 greetingConfig
q "UPDATE \"Clinic\" SET \"greetingConfig\" = jsonb_set(\"greetingConfig\", '{faq}', (SELECT coalesce(jsonb_agg(x), '[]'::jsonb) FROM jsonb_array_elements(\"greetingConfig\"->'faq') x WHERE x->>'q' <> '$E5_Q')) WHERE code='TKW'" >/dev/null 2>&1
# eadm2 staff 清走（hermetic）
q "DELETE FROM \"StaffUser\" WHERE email='$E2E_ADM2_EMAIL'" >/dev/null 2>&1

# ── R-E summary ───────────────────────────────────────────────────────
[ "$E_FAIL" = 0 ] && pass "R-E Phase E e2e（E1-E8：eligible/PATCH/cache-bust/403/flag/rollback/FAQ 全鏈/REJECT snapshot/T89 policy 壓 AUTO/T90 panic 全停 全綠）" || fail "R-E Phase E 有項失敗（見上 ❌）"

# ══════════════ R11：輪一收尾（cwi-r1close-20260827）═══════════════════

# ── T93. Flow 發送失敗（WA_GRAPH_MOCK_FAIL）→ Message FAILED + FlowSession 回滾 → 重按 = 新發送；成功 case 重按照 reused ──
echo "[R11] T93: flow graph fail → FlowSession rollback + re-press new send..."
T93=0
R11_FAIL=0
pkill -f "src/workers/index.ts" 2>/dev/null || true
sleep 1
WA_GRAPH_MOCK_FAIL=1 nohup pnpm worker >/tmp/e2e-worker-t93.log 2>&1 &
for i in $(seq 1 30); do grep -q "all workers running" /tmp/e2e-worker-t93.log 2>/dev/null && break; sleep 1; done
PAT_T93="8526301${EPOCH}"; WAMID_T93="wamid.E2E_T93_${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$PAT_T93" --text "你好，我想預約下週" --wamid "$WAMID_T93" --name "E2E T93 flowfail" >/dev/null || T93=1
CONV_T93=$(q "SELECT \"conversationId\" FROM \"Message\" WHERE \"waMessageId\"='$WAMID_T93'" | jf conversationId)
[ -n "$CONV_T93" ] || { fail "T93 conversation 未入庫"; T93=1; }
# 1a) auto-claim 可能分畀其他臨時 staff（e2e 後半段 TKW 有多 staff — 本 run 實測分咗 T79 D）→
#     A（COOKIE_TKW）先 takeover 到自己（同店 self-claim 路徑）保證有 send 權（否則 flow POST 423）
STAFF_A_ID=$(q "SELECT id::text id FROM \"StaffUser\" WHERE email='$TKW_EMAIL'" | jf id)
wait_for "SELECT (\"assigneeId\" IS NOT NULL)::text a FROM \"Conversation\" WHERE id='$CONV_T93'" '[{"a":"true"}]' 15 || true
ASGN_T93=$(q "SELECT \"assigneeId\" FROM \"Conversation\" WHERE id='$CONV_T93'" | jf assigneeId)
if [ -n "$ASGN_T93" ] && [ "$ASGN_T93" != "$STAFF_A_ID" ]; then
  curl -s -o /dev/null -b "$COOKIE_TKW" -X POST "$BASE/api/conversations/$CONV_T93/assign" -H 'Content-Type: application/json' -d "{\"toStaffId\":\"$STAFF_A_ID\"}"
  sleep 1
fi
if [ "$T93" = 0 ]; then
  # 1) staff 發 Flow（mock-inbound 後 24h 窗口開）
  CODE93=$(curl -s -o /tmp/e2e-t93-1.json -w '%{http_code}' -b "$COOKIE_TKW" -X POST "$BASE/api/conversations/$CONV_T93/flows" -H 'Content-Type: application/json')
  check "T93 flow send → 200" "$CODE93" "200"
  M93_1=$(jf messageId < /tmp/e2e-t93-1.json)
  [ -n "$M93_1" ] || { fail "T93 messageId 空"; T93=1; }
  # 2) worker WA_GRAPH_MOCK_FAIL → 重試 3 次 exhausted → Message FAILED + FlowSession 回滾 FAILED
  if wait_for "SELECT m.\"status\"::text ms, f.\"status\"::text fs FROM \"Message\" m JOIN \"FlowSession\" f ON f.\"messageId\"=m.id WHERE m.id='$M93_1'" '[{"ms":"FAILED","fs":"FAILED"}]' 90; then
    pass "T93 graph fail → Message FAILED + FlowSession 回滾 FAILED（dedup 不再中）"
  else
    fail "T93 未達 FAILED+FAILED（actual=$(q "SELECT m.\"status\"::text ms, f.\"status\"::text fs FROM \"Message\" m JOIN \"FlowSession\" f ON f.\"messageId\"=m.id WHERE m.id='$M93_1'" | tr -d '\n')）"
    T93=1
  fi
  # 3) 重按 → 唔係 reused（舊 bug：SENT 未回滾 → reused=true 謊報「已發咗」）
  curl -s -o /tmp/e2e-t93-2.json -w '%{http_code}' -b "$COOKIE_TKW" -X POST "$BASE/api/conversations/$CONV_T93/flows" -H 'Content-Type: application/json' > /dev/null
  M93_2=$(jf messageId < /tmp/e2e-t93-2.json)
  check "T93 重按 reused=false" "$(grep -oE '"reused":[a-z]+' /tmp/e2e-t93-2.json | head -1 | cut -d: -f2)" "false"
  [ -n "$M93_2" ] && [ "$M93_2" != "$M93_1" ] || { fail "T93 重按未開新 message"; T93=1; }
  FS93_2=$(q "SELECT id FROM \"FlowSession\" WHERE \"messageId\"='$M93_2'" | jf id)
  check "T93 新 session 已寫 messageId" "$(q "SELECT (\"messageId\" IS NOT NULL)::text n FROM \"FlowSession\" WHERE id='$FS93_2'" | jf n)" "true"
  # 4) 恢復正常 worker → 第 2 條 message SENT（新發送真送到）
  pkill -f "src/workers/index.ts" 2>/dev/null || true
  sleep 1
  nohup pnpm worker >/tmp/e2e-worker-t93r.log 2>&1 &
  for i in $(seq 1 30); do grep -q "all workers running" /tmp/e2e-worker-t93r.log 2>/dev/null && break; sleep 1; done
  if wait_for "SELECT \"status\"::text s FROM \"Message\" WHERE id='$M93_2'" '[{"s":"SENT"}]' 45; then
    pass "T93 恢復後 → 第 2 條 flow message SENT（重按 = 真新發送）"
  else
    fail "T93 第 2 條 message 未 SENT"; T93=1
  fi
  # 5) 成功 case 重按 → 照舊 reused（防連撳語義保留）
  curl -s -o /tmp/e2e-t93-3.json -w '%{http_code}' -b "$COOKIE_TKW" -X POST "$BASE/api/conversations/$CONV_T93/flows" -H 'Content-Type: application/json' > /dev/null
  check "T93 成功 case 重按 reused=true" "$(grep -oE '"reused":[a-z]+' /tmp/e2e-t93-3.json | head -1 | cut -d: -f2)" "true"
  check "T93 重用同一 session（唯一 SENT session 嘅 messageId 未變）" "$(q "SELECT \"messageId\" FROM \"FlowSession\" WHERE \"conversationId\"='$CONV_T93' AND status='SENT'" | jf messageId)" "$M93_2"
  check "T93 interactive message 總數 = 2（零重發）" "$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$CONV_T93' AND type='interactive'" | jf c)" "2"
fi
# hermetic cleanup（waId sweep — 預建行萬一靜默失敗，worker 自建 cuid contact/conv）
q "DELETE FROM \"FlowSession\" WHERE \"conversationId\"='$CONV_T93'" >/dev/null 2>&1
q "DELETE FROM \"BookingRequest\" WHERE \"conversationId\"='$CONV_T93'" >/dev/null 2>&1
q "DELETE FROM \"AiDraft\" WHERE \"conversationId\"='$CONV_T93'" >/dev/null 2>&1
q "DELETE FROM \"Message\" WHERE \"conversationId\"='$CONV_T93'" >/dev/null 2>&1
q "DELETE FROM \"Conversation\" WHERE id='$CONV_T93'" >/dev/null 2>&1
q "DELETE FROM \"Contact\" WHERE \"waId\"='$PAT_T93'" >/dev/null 2>&1
[ "$T93" = 0 ] && pass "T93 Flow fail 回滾全鏈（重按唔謊報「已發咗」+ 防連撳保留）" || { fail "T93 有項失敗（見上 ❌）"; R11_FAIL=1; }

# ── T94. /schedule 醫生時間表頁（cwi-sched-20260901 後：單入口 + 全店唯讀）──
echo "[R11] T94: /schedule doctor-schedule page..."
T94=0
MF_NAME=$(q "SELECT name FROM \"Clinic\" WHERE code='MF'" | jf name)
TKW_NAME=$(q "SELECT name FROM \"Clinic\" WHERE code='TKW'" | jf name)
# (1) STAFF：自己店（primary clinic）週視圖（fixture A — DUTY_MOCK 預設 1）
CODE94=$(curl -s -o /tmp/e2e-sched-staff.html -w '%{http_code}' -b "$COOKIE_TKW" "$BASE/schedule")
check "T94 STAFF GET /schedule → 200" "$CODE94" "200"
grep -qF "醫生時間表" /tmp/e2e-sched-staff.html && pass "T94 頁標題（醫生時間表）" || { fail "T94 頁標題缺失"; T94=1; }
grep -qF "林小曼" /tmp/e2e-sched-staff.html && pass "T94 當值 entries（fixture）" || { fail "T94 當值 entries 冇（fixture 林小曼）"; T94=1; }
[ "$(grep -oF "今日" /tmp/e2e-sched-staff.html | wc -l)" -ge 1 ] && pass "T94 今日 badge" || { fail "T94 今日 badge 缺失"; T94=1; }
check "T94 STAFF 見自己店名" "$(grep -cF "$TKW_NAME" /tmp/e2e-sched-staff.html)" "1"
# (2) cwi-sched §4（全店唯讀）：STAFF 跨店 param → 200 有 MF 資料（舊版 fail-closed 斷言已反轉）
CODE94X=$(curl -s -o /tmp/e2e-sched-staff-mf.html -w '%{http_code}' -b "$COOKIE_TKW" "$BASE/schedule?clinic=MF")
check "T94 STAFF 跨店 ?clinic=MF → 200（全店唯讀）" "$CODE94X" "200"
grep -qF "$MF_NAME" /tmp/e2e-sched-staff-mf.html && pass "T94 STAFF 跨店有 MF 資料" || { fail "T94 STAFF 跨店 MF 資料冇"; T94=1; }
# (3) ADMIN 唔帶 param → 店選單（零數據 fetch — fixture 名唔出現）
CODE94B=$(curl -s -o /tmp/e2e-sched-admin.html -w '%{http_code}' -b "$COOKIE_ADMIN" "$BASE/schedule")
check "T94 ADMIN GET /schedule（無 param）→ 200" "$CODE94B" "200"
grep -qF "揀一間店" /tmp/e2e-sched-admin.html && pass "T94 ADMIN 店選單" || { fail "T94 ADMIN 店選單缺失"; T94=1; }
if grep -qF "林小曼" /tmp/e2e-sched-admin.html; then fail "T94 ADMIN 無 param 已 fetch 數據"; T94=1; else pass "T94 ADMIN 無 param 零數據"; fi
# (4) ADMIN ?clinicId=TKW（舊 link 只讀 fallback — CEO 指令）→ TKW 數據
CODE94C=$(curl -s -o /tmp/e2e-sched-admin-tkw.html -w '%{http_code}' -b "$COOKIE_ADMIN" "$BASE/schedule?clinicId=TKW")
check "T94 ADMIN ?clinicId=TKW（fallback）→ 200" "$CODE94C" "200"
grep -qF "林小曼" /tmp/e2e-sched-admin-tkw.html && pass "T94 ADMIN clinicId fallback entries" || { fail "T94 ADMIN clinicId fallback entries 冇"; T94=1; }
# (5) ADMIN ?clinicId=MF（舊 fallback 參數）→ MF 店名 + 數據
CODE94D=$(curl -s -o /tmp/e2e-sched-admin-mf.html -w '%{http_code}' -b "$COOKIE_ADMIN" "$BASE/schedule?clinicId=MF")
check "T94 ADMIN ?clinicId=MF（fallback）→ 200" "$CODE94D" "200"
grep -qF "$MF_NAME" /tmp/e2e-sched-admin-mf.html && pass "T94 ADMIN MF 店名" || { fail "T94 ADMIN MF 店名冇"; T94=1; }
grep -qF "林小曼" /tmp/e2e-sched-admin-mf.html && pass "T94 ADMIN MF entries" || { fail "T94 ADMIN MF entries 冇"; T94=1; }
# (6) ADMIN ?clinicId=NOPE → 搵唔到店（唔 500）
CODE94E=$(curl -s -o /tmp/e2e-sched-admin-nope.html -w '%{http_code}' -b "$COOKIE_ADMIN" "$BASE/schedule?clinicId=NOPE")
check "T94 ADMIN ?clinicId=NOPE → 200（錯誤狀態唔 500）" "$CODE94E" "200"
grep -qF "搵唔到店" /tmp/e2e-sched-admin-nope.html && pass "T94 搵唔到店狀態" || { fail "T94 搵唔到店狀態缺失"; T94=1; }
# (7) workforce 離線 → /api/duty-roster fail-soft（inbox 當值卡數據層 — schedule 頁本身靠 buildFlowSlots connected=false pattern）
DOWN_OUT=$(pnpm -s e2e:duty --cookie "$COOKIE_TKW" --down 2>&1)
echo "$DOWN_OUT" | grep -q "DUTY-DOWN-OK" && pass "T94 workforce 離線 → duty null 唔 crash（數據層）" || { fail "T94 workforce 離線 fail-soft"; T94=1; }
[ "$T94" = 0 ] && pass "T94 /schedule 醫生時間表全鏈" || { fail "T94 有項失敗（見上 ❌）"; R11_FAIL=1; }

# ── T95. §B2 今日當值卡 client 端刷新（browser-level — mock duty 變更 → 卡更新唔使 reload） ──
echo "[R11] T95: duty card client refresh (browser)..."
T95=0
PAT_T95A="8526302${EPOCH}"; PAT_T95B="8526303${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$PAT_T95A" --text "你哋幾點開門" --wamid "wamid.E2E_T95A_${EPOCH}" --name "E2E-DUTY-A" >/dev/null || T95=1
pnpm -s mock-inbound message --clinic TKW --from "$PAT_T95B" --text "你哋做幾日" --wamid "wamid.E2E_T95B_${EPOCH}" --name "E2E-DUTY-B" >/dev/null || T95=1
CONV_T95A=$(q "SELECT \"conversationId\" FROM \"Message\" WHERE \"waMessageId\"='wamid.E2E_T95A_${EPOCH}'" | jf conversationId)
CONV_T95B=$(q "SELECT \"conversationId\" FROM \"Message\" WHERE \"waMessageId\"='wamid.E2E_T95B_${EPOCH}'" | jf conversationId)
[ -n "$CONV_T95A" ] && [ -n "$CONV_T95B" ] || { fail "T95 conversation 未入庫"; T95=1; }
if [ "$T95" = 0 ]; then
  OUT95=$(pnpm -s e2e:duty-refresh --base "$BASE" --cookie "$COOKIE_TKW" --conv1 "$CONV_T95A" --conv2 "$CONV_T95B" 2>&1)
  echo "$OUT95" | tail -3
  echo "$OUT95" | grep -q "DUTY-REFRESH-OK" && pass "T95 duty 卡 client 端刷新（mock 變更 → 換對話卡更新，零 reload）" \
    || { fail "T95 duty 卡刷新失敗"; T95=1; }
fi
# hermetic cleanup（waId sweep）
for pat in "$PAT_T95A" "$PAT_T95B"; do
  CONV_SUB="SELECT id FROM \"Conversation\" cv JOIN \"Contact\" ct ON ct.id=cv.\"contactId\" WHERE ct.\"waId\"='$pat'"
  q "DELETE FROM \"AiDraft\" WHERE \"conversationId\" IN ($CONV_SUB)" >/dev/null 2>&1
  q "DELETE FROM \"Message\" WHERE \"conversationId\" IN ($CONV_SUB)" >/dev/null 2>&1
  q "DELETE FROM \"Conversation\" cv USING \"Contact\" ct WHERE ct.id=cv.\"contactId\" AND ct.\"waId\"='$pat'" >/dev/null 2>&1
  q "DELETE FROM \"Contact\" WHERE \"waId\"='$pat'" >/dev/null 2>&1
done
rm -f .dev/duty-mock-override.json
[ "$T95" = 0 ] && pass "T95 §B2 client 端刷新 browser e2e" || { fail "T95 有項失敗（見上 ❌）"; R11_FAIL=1; }

# ══════════════ R12：真 Flow v7.3 + §D remainingCapacity（cwi-r2-20260827）══════════════
#   T96 §D：capacity=0 唔入候選 + 缺欄 fallback=1 迴歸
#   T98 生產信封真 Flow 握手（stepx：INIT→SCR_DATE→SCR_SLOT→SCR_CONFIRM→SUCCESS + 401 + legacy 契約）
#   T97 §D：confirm 後 sync capacity 遞減（2→1→0，mock stateful store）
#   T99 nfm_reply（帶新 params name/notes）→ BookingRequest PENDING + 三掣卡（寫入路徑照舊）
#   T100 ping / error_notification：解密後 token 驗證前放行（靜態回應無 PII，零 DB — cwi-flowping-20260828）
R12=0

# ── T96. §D：remainingCapacity=0 唔入候選 + 缺欄 → fallback=1 ──────────────
echo "[R12] T96: remainingCapacity=0 hidden + missing-field fallback=1..."
T96=0
T96_S1=$(q "SELECT \"date\"||'|'||\"startTime\" v FROM \"AvailabilitySlot\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND \"providerApricotId\"='$DOC_A' AND \"isOpen\" AND \"bookedCount\"=0 AND \"date\" >= ((date_trunc('day', (now() AT TIME ZONE 'Asia/Hong_Kong'))::date + 1)::text) ORDER BY \"date\",\"startTime\" LIMIT 1" | jf v)
T96_S2=$(q "SELECT \"date\"||'|'||\"startTime\" v FROM \"AvailabilitySlot\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND \"providerApricotId\"='$DOC_A' AND \"isOpen\" AND \"bookedCount\"=0 AND \"date\" >= ((date_trunc('day', (now() AT TIME ZONE 'Asia/Hong_Kong'))::date + 1)::text) ORDER BY \"date\",\"startTime\" LIMIT 1 OFFSET 1" | jf v)
[ -n "$T96_S1" ] && [ -n "$T96_S2" ] || { echo "    ❌ T96 fixture：DOC_A 空 slot 唔夠 2 個"; T96=1; }
T96_S1D=${T96_S1%%|*}; T96_S1T=${T96_S1##*|}
T96_S2D=${T96_S2%%|*}; T96_S2T=${T96_S2##*|}
# S2 = capacity 0（flag 帶 remainingCapacity → 唔標滿，純容量治理）；S1 = 無 flag（缺欄 fallback 對照）
printf '[{"clinicCode":"TKW","providerApricotId":"%s","date":"%s","startTime":"%s","remainingCapacity":0}]' "$DOC_A" "$T96_S2D" "$T96_S2T" > .dev/workforce-mock-fill.json
q "UPDATE \"AvailabilitySlot\" SET \"syncedAt\"=\"syncedAt\"-interval '1 hour' WHERE \"clinicId\"='$TKW_CLINIC_ID'" >/dev/null
pnpm -s e2e:cron sync-availability >/dev/null 2>&1 || { echo "    ❌ T96 sync-availability fail"; T96=1; }
if wait_for "SELECT \"remainingCapacity\"::text c FROM \"AvailabilitySlot\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND \"providerApricotId\"='$DOC_A' AND \"date\"='$T96_S2D' AND \"startTime\"='$T96_S2T'" '[{"c":"0"}]' 60; then
  pass "T96 S2 sync → remainingCapacity=0 入 L2"
else
  echo "    ❌ T96 S2 rc=0 未入 L2"; T96=1
fi
check "T96 S1 缺欄 → rc=NULL（workforce 未回欄，行為不變）" "$(q "SELECT (\"remainingCapacity\" IS NULL)::text c FROM \"AvailabilitySlot\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND \"providerApricotId\"='$DOC_A' AND \"date\"='$T96_S1D' AND \"startTime\"='$T96_S1T'" | jf c)" "true"
check "T96 capacity=0 slot 唔入候選集（slotAvailable 語義）" "$(q "SELECT count(*)::text c FROM \"AvailabilitySlot\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND \"providerApricotId\"='$DOC_A' AND \"date\"='$T96_S2D' AND \"startTime\"='$T96_S2T' AND \"isOpen\" AND ((\"remainingCapacity\" IS NULL AND \"bookedCount\"=0) OR \"remainingCapacity\">0)" | jf c)" "0"
check "T96 fallback slot（缺欄+bookedCount=0）照入候選集" "$(q "SELECT count(*)::text c FROM \"AvailabilitySlot\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND \"providerApricotId\"='$DOC_A' AND \"date\"='$T96_S1D' AND \"startTime\"='$T96_S1T' AND \"isOpen\" AND ((\"remainingCapacity\" IS NULL AND \"bookedCount\"=0) OR \"remainingCapacity\">0)" | jf c)" "1"
[ "$T96" = 0 ] && pass "T96 §D capacity=0 隱藏 + 缺欄 fallback=1 迴歸" || { fail "T96 有項失敗（見上 ❌）"; R12=1; }

# ── T98. 生產信封真 Flow 握手（stepx）：INIT→SCR_DATE→SCR_SLOT→SCR_CONFIRM→SUCCESS + 401 ──
echo "[R12] T98: prod-envelope flow handshake (3 screens → SUCCESS)..."
T98=0
t98_setup_pat() { # t98_setup_pat <pat> <name> → 設 T98_CONV / T98_TOK（0/1）
  local pat="$1" nm="$2"
  pnpm -s mock-inbound message --clinic TKW --from "$pat" --text "預約" --wamid "wamid.E2E_T98_${pat}_${EPOCH}" --name "$nm" >/dev/null 2>&1 || return 1
  wait_for "SELECT (c.\"lastInboundAt\" IS NOT NULL)::text ok FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$pat'" '[{"ok":"true"}]' 15 || return 1
  T98_CONV=$(q "SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$pat'" | jf id)
  [ -n "$T98_CONV" ] || return 1
  curl -s -o /tmp/e2e-t98-flow.json -b "$COOKIE_TKW" -X POST "$BASE/api/conversations/$T98_CONV/flows" -H 'Content-Type: application/json'
  T98_TOK=$(jf flowToken < /tmp/e2e-t98-flow.json)
  [ -n "$T98_TOK" ] || return 1
  return 0
}
stepx_parse() { # stepx_parse <out> <file> → 提 HTTP= 行（容許 pnpm 命令回顯行）→ 200 時寫 plaintext 去 file
  local line
  line=$(printf '%s\n' "$1" | grep -E '^HTTP=' | head -1)
  [ -n "$line" ] || return 1
  case "$line" in
    HTTP=200*) printf '%s' "${line#HTTP=200 DATA=}" > "$2"; return 0 ;;
    *) return 1 ;;
  esac
}
t98_pat_sweep() { # waId sweep（同 R11 模式）
  local pat="$1"
  CONV_SUB="SELECT id FROM \"Conversation\" cv JOIN \"Contact\" ct ON ct.id=cv.\"contactId\" WHERE ct.\"waId\"='$pat'"
  q "DELETE FROM \"AiDraft\" WHERE \"conversationId\" IN ($CONV_SUB)" >/dev/null 2>&1
  q "DELETE FROM \"Message\" WHERE \"conversationId\" IN ($CONV_SUB)" >/dev/null 2>&1
  q "DELETE FROM \"Conversation\" cv USING \"Contact\" ct WHERE ct.id=cv.\"contactId\" AND ct.\"waId\"='$pat'" >/dev/null 2>&1
  q "DELETE FROM \"Contact\" WHERE \"waId\"='$pat'" >/dev/null 2>&1
}
if t98_setup_pat "8526903${EPOCH}" "E2E T98"; then
  # T4：bookable 決定性 fixture（重現 client.ts mock 規則 — TKW / 09:00–13:00 / 兩 mock 醫生）
  T98_D=$(node -e 'function djb2(s){let h=5381;for(let i=0;i<s.length;i++){h=((h<<5)+h+s.charCodeAt(i))>>>0}return h}const c="TKW";const d0=new Date(Date.now()+8*3600e3).toISOString().slice(0,10);for(let i=0;i<31;i++){const day=new Date(Date.parse(d0+"T00:00:00Z")+i*86400e3).toISOString().slice(0,10);if(djb2(c+"|"+day)%7!==3){console.log(day);break}}')
  [ -n "$T98_D" ] || { echo "    ❌ T98 fixture：30 日內冇 bookable 開診日"; T98=1; }
  # (a) INIT → SCR_DATE（T4：DatePicker min/max + dates[] = bookable 可約日 + has_error=false）
  OUT=$(pnpm -s flow-client stepx --clinic TKW --token "$T98_TOK" --action INIT 2>&1 || true)
  if stepx_parse "$OUT" /tmp/e2e-t98-init.json; then
    check "T98 INIT → SCR_DATE" "$(jf screen < /tmp/e2e-t98-init.json)" "SCR_DATE"
    T98_HE=$(grep -oE '"has_error":(true|false)' /tmp/e2e-t98-init.json | head -1 | cut -d: -f2)
    check "T98 INIT has_error=false（v2 明確 boolean）" "$T98_HE" "false"
    check "T98 INIT date_min = 今日" "$(jf date_min < /tmp/e2e-t98-init.json)" "$(node -e 'console.log(new Date(Date.now()+8*3600e3).toISOString().slice(0,10))')"
    grep -qF "\"id\":\"$T98_D\"" /tmp/e2e-t98-init.json && pass "T98 INIT dates[] 含 $T98_D（bookable 可約日）" || { echo "    ❌ T98 INIT dates[] 冇 $T98_D（bookable 開診日）"; T98=1; }
  else
    echo "    ❌ T98 INIT fail（=${OUT%%$'\n'*}）"; T98=1
  fi
  # (a2) v2 error 路徑：超範圍日期 → 留 SCR_DATE + has_error=true + error_message 非空（同送規則）
  OUT=$(pnpm -s flow-client stepx --clinic TKW --token "$T98_TOK" --action data_exchange --screen SCR_DATE --data '{"user_action":"submit_date","date":"2030-01-01"}' 2>&1 || true)
  if stepx_parse "$OUT" /tmp/e2e-t98-err.json; then
    T98_HEE=$(grep -oE '"has_error":(true|false)' /tmp/e2e-t98-err.json | head -1 | cut -d: -f2)
    { [ "$(jf screen < /tmp/e2e-t98-err.json)" = "SCR_DATE" ] && [ "$T98_HEE" = "true" ] && grep -qE '"error_message":"[^"]+"' /tmp/e2e-t98-err.json; } \
      && pass "T98 v2 error 路徑：超範圍日 → 留 SCR_DATE + has_error=true + error_message 非空" \
      || { echo "    ❌ T98 v2 error 路徑（screen=$(jf screen < /tmp/e2e-t98-err.json) has_error=${T98_HEE:-?}）"; T98=1; }
  else
    echo "    ❌ T98 v2 error 路徑 stepx fail（=${OUT%%$'\n'*}）"; T98=1
  fi
  # (b) submit_date → SCR_SLOT（T4：bookable 源 — providers = workforce 簽發 id；times = 該日可約時段）
  OUT=$(pnpm -s flow-client stepx --clinic TKW --token "$T98_TOK" --action data_exchange --screen SCR_DATE --data "{\"user_action\":\"submit_date\",\"date\":\"$T98_D\"}" 2>&1 || true)
  if stepx_parse "$OUT" /tmp/e2e-t98-slot.json; then
    check "T98 submit_date → SCR_SLOT" "$(jf screen < /tmp/e2e-t98-slot.json)" "SCR_SLOT"
    grep -qF "\"id\":\"mock-pract-TKW-0\"" /tmp/e2e-t98-slot.json || { echo "    ❌ T98 providers 冇 mock-pract-TKW-0（server 簽發 id）"; T98=1; }
    grep -qF "\"09:00\"" /tmp/e2e-t98-slot.json || { echo "    ❌ T98 times 冇 09:00（bookable 時段）"; T98=1; }
    grep -qF "\"id\":\"$DOC_A\"" /tmp/e2e-t98-slot.json && { echo "    ❌ T98 providers 混入 L2 apricotId（$DOC_A）— 應該係 bookable 源"; T98=1; }
  else
    echo "    ❌ T98 submit_date fail（=${OUT%%$'\n'*}）"; T98=1
  fi
  # (c) submit_slot → SCR_CONFIRM（summary + profile_name 預填 + provider_id = workforce 簽發 id）
  OUT=$(pnpm -s flow-client stepx --clinic TKW --token "$T98_TOK" --action data_exchange --screen SCR_SLOT --data "{\"user_action\":\"submit_slot\",\"date\":\"$T98_D\",\"provider_id\":\"mock-pract-TKW-0\",\"time\":\"09:00\"}" 2>&1 || true)
  if stepx_parse "$OUT" /tmp/e2e-t98-confirm.json; then
    check "T98 submit_slot → SCR_CONFIRM" "$(jf screen < /tmp/e2e-t98-confirm.json)" "SCR_CONFIRM"
    check "T98 confirm profile_name 預填（Contact profileName）" "$(jf profile_name < /tmp/e2e-t98-confirm.json)" "E2E T98"
    check "T98 confirm time（轉發欄）" "$(jf time < /tmp/e2e-t98-confirm.json)" "09:00"
    check "T98 confirm provider_id（server 簽發）" "$(jf provider_id < /tmp/e2e-t98-confirm.json)" "mock-pract-TKW-0"
    T98_HE3=$(grep -oE '"has_error":(true|false)' /tmp/e2e-t98-confirm.json | head -1 | cut -d: -f2)
    check "T98 confirm has_error=false（v2 三屏同送規則）" "$T98_HE3" "false"
  else
    echo "    ❌ T98 submit_slot fail（=${OUT%%$'\n'*}）"; T98=1
  fi
  # (d) submit_confirm → ★ claim（T4）→ SUCCESS（params 帶 holdId）+ FlowHoldEvent 落 DB
  OUT=$(pnpm -s flow-client stepx --clinic TKW --token "$T98_TOK" --action data_exchange --screen SCR_CONFIRM --data "{\"user_action\":\"submit_confirm\",\"date\":\"$T98_D\",\"provider_id\":\"mock-pract-TKW-0\",\"time\":\"09:00\",\"name\":\"E2E T98\",\"notes\":\"e2e note\"}" 2>&1 || true)
  if stepx_parse "$OUT" /tmp/e2e-t98-success.json; then
    check "T98 submit_confirm → SUCCESS" "$(jf screen < /tmp/e2e-t98-success.json)" "SUCCESS"
    check "T98 SUCCESS params.providerId" "$(jf providerId < /tmp/e2e-t98-success.json)" "mock-pract-TKW-0"
    check "T98 SUCCESS params.date" "$(jf date < /tmp/e2e-t98-success.json)" "$T98_D"
    check "T98 SUCCESS params.time" "$(jf time < /tmp/e2e-t98-success.json)" "09:00"
    T98_HOLD=$(jf holdId < /tmp/e2e-t98-success.json)
    [ -n "$T98_HOLD" ] && [ "$T98_HOLD" != "undefined" ] && pass "T98 SUCCESS params.holdId（claim 201）" || { echo "    ❌ T98 SUCCESS 冇 holdId（claim 未成功？）"; T98=1; }
    T98_HEV=$(q "SELECT \"status\"||'|'||\"patientPhone\" v FROM \"FlowHoldEvent\" WHERE \"flowToken\"='$T98_TOK'" | jf v)
    check "T98 FlowHoldEvent 落 DB（HELD + WA fallback 電話）" "$T98_HEV" "HELD|8526903${EPOCH}"
  else
    echo "    ❌ T98 submit_confirm fail（=${OUT%%$'\n'*}）"; T98=1
  fi
  # (e) 壞 token → 401（生產信封認證）
  OUT=$(pnpm -s flow-client stepx --clinic TKW --token "$T98_TOK" --action INIT --bad-token 2>&1 || true)
  case "$(printf '%s\n' "$OUT" | grep -E '^HTTP=' | head -1)" in
    HTTP=401*) pass "T98 壞 token → 401";;
    *) echo "    ❌ T98 壞 token 應該 401（=$(printf '%s\n' "$OUT" | grep -E '^HTTP=' | head -1)）"; T98=1;;
  esac
  # (f) legacy 契約迴歸：同 token 舊 canvas 三 action 照行
  OUT=$(pnpm -s flow-client step --clinic TKW --conv "$T98_CONV" --token "$T98_TOK" --action SCREEN_PROVIDER 2>&1 || true)
  F_HTTP=$(printf '%s' "$OUT" | grep -oE 'HTTP=[0-9]+' | head -1 | cut -d= -f2)
  [ "$F_HTTP" = "200" ] || { echo "    ❌ T98 legacy SCREEN_PROVIDER 迴歸（HTTP=${F_HTTP:-?}）"; T98=1; }
  OUT=$(pnpm -s flow-client step --clinic TKW --conv "$T98_CONV" --token "$T98_TOK" --action SCREEN_DATE --provider "$DOC_A" 2>&1 || true)
  F_HTTP=$(printf '%s' "$OUT" | grep -oE 'HTTP=[0-9]+' | head -1 | cut -d= -f2)
  { [ "$F_HTTP" = "200" ] && printf '%s' "$OUT" | grep -qF "\"$T96_S1D\""; } || { echo "    ❌ T98 legacy SCREEN_DATE 迴歸（HTTP=${F_HTTP:-?}，dates 應含 $T96_S1D）"; T98=1; }
  # cleanup（T4：SUCCESS 後 nfm_reply 走 claimed 變體 → 無 BookingRequest；claim store + FlowHoldEvent 清零）
  q "DELETE FROM \"FlowHoldEvent\" WHERE \"flowToken\"='$T98_TOK'" >/dev/null 2>&1
  q "DELETE FROM \"FlowSession\" WHERE \"flowToken\"='$T98_TOK'" >/dev/null 2>&1
  q "DELETE FROM \"AuditLog\" WHERE action='FLOW_CLAIM'" >/dev/null 2>&1
  rm -f .dev/workforce-mock-claims.json
  t98_pat_sweep "8526903${EPOCH}"
  [ "$T98" = 0 ] && pass "T98 真 Flow v7.3 握手（T4 bookable 三屏 → claim → SUCCESS）+ 壞 token 401 + legacy 契約唔變" || { fail "T98 有項失敗（見上 ❌）"; R12=1; }
else
  echo "    ❌ T98 setup fail（mock-inbound / flow token）"; T98=1; fail "T98 有項失敗（見上 ❌）"; R12=1
fi

# ── T97. §D：confirm 後 sync capacity 遞減（base 2 → 1 → 0，mock stateful） ────────
echo "[R12] T97: capacity decrement after confirm (2→1→0)..."
T97=0
T97_S3=$(q "SELECT \"date\"||'|'||\"startTime\" v FROM \"AvailabilitySlot\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND \"providerApricotId\"='$DOC_A' AND \"isOpen\" AND \"bookedCount\"=0 AND \"date\" >= ((date_trunc('day', (now() AT TIME ZONE 'Asia/Hong_Kong'))::date + 1)::text) ORDER BY \"date\",\"startTime\" LIMIT 1 OFFSET 2" | jf v)
[ -n "$T97_S3" ] || { echo "    ❌ T97 fixture：DOC_A 空 slot 唔夠 3 個"; T97=1; }
T97_S3D=${T97_S3%%|*}; T97_S3T=${T97_S3##*|}
# flag：S2 rc=0（繼承 T96）+ S3 base=2（遞減測試）
printf '[{"clinicCode":"TKW","providerApricotId":"%s","date":"%s","startTime":"%s","remainingCapacity":0},{"clinicCode":"TKW","providerApricotId":"%s","date":"%s","startTime":"%s","remainingCapacity":2}]' "$DOC_A" "$T96_S2D" "$T96_S2T" "$DOC_A" "$T97_S3D" "$T97_S3T" > .dev/workforce-mock-fill.json
q "UPDATE \"AvailabilitySlot\" SET \"syncedAt\"=\"syncedAt\"-interval '1 hour' WHERE \"clinicId\"='$TKW_CLINIC_ID'" >/dev/null
pnpm -s e2e:cron sync-availability >/dev/null 2>&1
if wait_for "SELECT \"remainingCapacity\"::text c FROM \"AvailabilitySlot\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND \"providerApricotId\"='$DOC_A' AND \"date\"='$T97_S3D' AND \"startTime\"='$T97_S3T'" '[{"c":"2"}]' 60; then
  pass "T97 S3 base capacity=2 入 L2"
else
  echo "    ❌ T97 S3 rc=2 未入 L2"; T97=1
fi
# booking cycle：新病人 → flow → complete（nfm_reply）→ PENDING → 釘病人+代落單 create（workforce 寫入 → mock store）→ CONFIRMED → re-sync
# ★ 用 /create（代落單）唔係 /confirm：confirm = staff 已喺醫生系統落單（唔 call workforce）；
#   create 先會行 confirmBookingCore → workforce createBooking（mock recordBooked → capacity 遞減）
t97_book_cycle() { # t97_book_cycle <pat> <suf> → 設 T97_BOOK_ID；回 0/1（fail 時 echo 原因）
  local pat="$1" suf="$2"
  local t97dbg="/tmp/e2e-t97-dbg-${suf}.txt"
  : > "$t97dbg"
  pnpm -s mock-inbound message --clinic TKW --from "$pat" --text "預約" --wamid "wamid.E2E_T97_${suf}_${EPOCH}" --name "E2E T97 $suf" >/dev/null 2>&1 || { echo "    ❌ T97 $suf step=mock-inbound"; return 1; }
  wait_for "SELECT (c.\"lastInboundAt\" IS NOT NULL)::text ok FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$pat'" '[{"ok":"true"}]' 20 || { echo "    ❌ T97 $suf step=lastInboundAt"; return 1; }
  local conv; conv=$(q "SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$pat'" | jf id)
  [ -n "$conv" ] || { echo "    ❌ T97 $suf step=conv"; return 1; }
  curl -s -o /tmp/e2e-t97-flow-${suf}.json -b "$COOKIE_TKW" -X POST "$BASE/api/conversations/$conv/flows" -H 'Content-Type: application/json'
  local tok; tok=$(jf flowToken < /tmp/e2e-t97-flow-${suf}.json)
  [ -n "$tok" ] || { echo "    ❌ T97 $suf step=flowtoken（=$(head -c 200 /tmp/e2e-t97-flow-${suf}.json)）"; return 1; }
  pnpm -s flow-client complete --clinic TKW --conv "$conv" --token "$tok" --provider "$DOC_A" --providerName "$NAME_A" --date "$T97_S3D" --time "$T97_S3T" --wamid "wamid.E2E_T97_DONE_${suf}_${EPOCH}" >/dev/null 2>&1 || { echo "    ❌ T97 $suf step=complete"; return 1; }
  wait_for "SELECT \"status\"::text s FROM \"BookingRequest\" WHERE \"conversationId\"='$conv'" '[{"s":"PENDING"}]' 45 || { echo "    ❌ T97 $suf step=pending（nfm_reply 未落單）"; return 1; }
  T97_BOOK_ID=$(q "SELECT id FROM \"BookingRequest\" WHERE \"conversationId\"='$conv'" | jf id)
  [ -n "$T97_BOOK_ID" ] || { echo "    ❌ T97 $suf step=bookingId"; return 1; }
  # 代落單前置（鐵律 A：pinned 舊客 + Send Lock：assignee=自己）
  q "UPDATE \"Conversation\" SET \"assigneeId\"='$TKW_STAFF_ID', \"pinnedPatientApricotId\"='e2e-t97-pat-${suf}', \"pinnedPatientName\"='E2E T97 ${suf}' WHERE id='$conv'" >/dev/null 2>&1
  local code; code=$(curl -s -o /tmp/e2e-t97-create-${suf}.json -w '%{http_code}' -b "$COOKIE_TKW" -X POST "$BASE/api/bookings/$T97_BOOK_ID/create" -H 'Content-Type: application/json' -d '{"visitReasonId":"vr-0010"}')
  [ "$code" = "200" ] || { echo "    ❌ T97 $suf step=create（HTTP=$code body=$(head -c 200 /tmp/e2e-t97-create-${suf}.json)）"; return 1; }
  wait_for "SELECT \"status\"::text s FROM \"BookingRequest\" WHERE id='$T97_BOOK_ID'" '[{"s":"CONFIRMED"}]' 20 || { echo "    ❌ T97 $suf step=confirmed"; return 1; }
  # create 成功（mock recordBooked 已寫 store）→ re-sync → rc 遞減
  q "UPDATE \"AvailabilitySlot\" SET \"syncedAt\"=\"syncedAt\"-interval '1 hour' WHERE \"clinicId\"='$TKW_CLINIC_ID'" >/dev/null
  pnpm -s e2e:cron sync-availability >/dev/null 2>&1
  return 0
}
T97_BOOK_1=""; T97_BOOK_2=""
if t97_book_cycle "8526904${EPOCH}" "A"; then
  T97_BOOK_1="$T97_BOOK_ID"
  if wait_for "SELECT \"remainingCapacity\"::text c FROM \"AvailabilitySlot\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND \"providerApricotId\"='$DOC_A' AND \"date\"='$T97_S3D' AND \"startTime\"='$T97_S3T'" '[{"c":"1"}]' 60; then
    pass "T97 第 1 次 confirm + sync → capacity 2→1（遞減）"
  else
    echo "    ❌ T97 rc 未遞減到 1"; T97=1
  fi
else
  echo "    ❌ T97 booking cycle #1 fail"; T97=1
fi
if t97_book_cycle "8526905${EPOCH}" "B"; then
  T97_BOOK_2="$T97_BOOK_ID"
  if wait_for "SELECT \"remainingCapacity\"::text c FROM \"AvailabilitySlot\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND \"providerApricotId\"='$DOC_A' AND \"date\"='$T97_S3D' AND \"startTime\"='$T97_S3T'" '[{"c":"0"}]' 60; then
    pass "T97 第 2 次 confirm + sync → capacity 1→0"
  else
    echo "    ❌ T97 rc 未遞減到 0"; T97=1
  fi
  check "T97 rc=0 後 S3 消失喺候選集" "$(q "SELECT count(*)::text c FROM \"AvailabilitySlot\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND \"providerApricotId\"='$DOC_A' AND \"date\"='$T97_S3D' AND \"startTime\"='$T97_S3T' AND \"isOpen\" AND ((\"remainingCapacity\" IS NULL AND \"bookedCount\"=0) OR \"remainingCapacity\">0)" | jf c)" "0"
else
  echo "    ❌ T97 booking cycle #2 fail"; T97=1
fi
# cleanup：mock store/flag 清掉 + bookings + convs
rm -f .dev/workforce-mock-booked.json .dev/workforce-mock-fill.json
[ -n "$T97_BOOK_1" ] && q "DELETE FROM \"BookingRequest\" WHERE id='$T97_BOOK_1'" >/dev/null 2>&1
[ -n "$T97_BOOK_2" ] && q "DELETE FROM \"BookingRequest\" WHERE id='$T97_BOOK_2'" >/dev/null 2>&1
t98_pat_sweep "8526904${EPOCH}"
t98_pat_sweep "8526905${EPOCH}"
[ "$T97" = 0 ] && pass "T97 §D confirm 後 capacity 遞減全鏈（2→1→0 → 唔入候選）" || { fail "T97 有項失敗（見上 ❌）"; R12=1; }

# ── T99. nfm_reply（帶新 params name/notes）→ BookingRequest PENDING + 三掣卡 ────
echo "[R12] T99: nfm_reply with name/notes → BookingRequest + 3-button card..."
T99=0
if t98_setup_pat "8526906${EPOCH}" "E2E T99"; then
  pnpm -s flow-client complete --clinic TKW --conv "$T98_CONV" --token "$T98_TOK" --provider "$DOC_A" --providerName "$NAME_A" --date "$T96_S1D" --time "$T96_S1T" --name "E2E T99 name" --notes "e2e T99 notes" --wamid "wamid.E2E_T99_DONE_${EPOCH}" >/dev/null 2>&1 || { echo "    ❌ T99 complete webhook"; T99=1; }
  if wait_for "SELECT \"status\"::text s FROM \"BookingRequest\" WHERE \"conversationId\"='$T98_CONV'" '[{"s":"PENDING"}]' 30; then
    pass "T99 BookingRequest PENDING（name/notes extras 唔碎寫入路徑）"
  else
    echo "    ❌ T99 BookingRequest 未 PENDING"; T99=1
  fi
  BOOK_T99=$(q "SELECT id FROM \"BookingRequest\" WHERE \"conversationId\"='$T98_CONV'" | jf id)
  FS=$(q "SELECT \"status\"::text s FROM \"FlowSession\" WHERE \"flowToken\"='$T98_TOK'" | jf s)
  [ "$FS" = "COMPLETED" ] || { echo "    ❌ T99 FlowSession 未 COMPLETED（=$FS）"; T99=1; }
  curl -s -b "$COOKIE_TKW" "$BASE/api/conversations" -o /tmp/e2e-t99-conv-list.json
  grep -qF "\"pendingBooking\":{\"id\":\"$BOOK_T99\"" /tmp/e2e-t99-conv-list.json || { echo "    ❌ T99 三掣卡（pendingBooking）冇喺 conversations API"; T99=1; }
  # cleanup
  [ -n "$BOOK_T99" ] && q "DELETE FROM \"BookingRequest\" WHERE id='$BOOK_T99'" >/dev/null 2>&1
  q "DELETE FROM \"FlowSession\" WHERE \"flowToken\"='$T98_TOK'" >/dev/null 2>&1
  t98_pat_sweep "8526906${EPOCH}"
  [ "$T99" = 0 ] && pass "T99 nfm_reply（新 params）→ PENDING + 三掣卡，寫入路徑照舊" || { fail "T99 有項失敗（見上 ❌）"; R12=1; }
else
  echo "    ❌ T99 setup fail"; T99=1; fail "T99 有項失敗（見上 ❌）"; R12=1
fi

# ── T100. ping / error_notification：無 flow_token 放行（解密後 token 驗證前 — cwi-flowping-20260828）──
echo "[R12] T100: ping / error_notification no-token passthrough (static, zero DB)..."
T100=0
# (a) ping（無 token）→ 200 + 加密回應解密後 data.status="active"
OUT=$(pnpm -s flow-client stepx --clinic TKW --no-token --action ping 2>&1 || true)
if stepx_parse "$OUT" /tmp/e2e-t100-ping.json; then
  check "T100 ping data.status=active" "$(jf status < /tmp/e2e-t100-ping.json)" "active"
else
  echo "    ❌ T100 ping fail（=${OUT%%$'\n'*}）"; T100=1
fi
# (b) error_notification（無 token）→ 200 + data.acknowledged=true
OUT=$(pnpm -s flow-client stepx --clinic TKW --no-token --action error_notification 2>&1 || true)
if stepx_parse "$OUT" /tmp/e2e-t100-errnoti.json; then
  grep -qE '"acknowledged":true' /tmp/e2e-t100-errnoti.json && pass "T100 error_notification data.acknowledged=true" \
    || { echo "    ❌ T100 error_notification acknowledged 唔係 true（=$(cat /tmp/e2e-t100-errnoti.json)）"; T100=1; }
else
  echo "    ❌ T100 error_notification fail（=${OUT%%$'\n'*}）"; T100=1
fi
# (c) 迴歸：其他 action（INIT）無 token 照 401 invalid_flow_token（放行唔洩漏）
OUT=$(pnpm -s flow-client stepx --clinic TKW --no-token --action INIT 2>&1 || true)
case "$(printf '%s\n' "$OUT" | grep -E '^HTTP=' | head -1)" in
  HTTP=401*ERROR=invalid_flow_token) pass "T100 迴歸：INIT 無 token 照 401 invalid_flow_token";;
  *) echo "    ❌ T100 迴歸：INIT 無 token 應該 401 invalid_flow_token（=$(printf '%s\n' "$OUT" | grep -E '^HTTP=' | head -1)）"; T100=1;;
esac
# (d) 零 DB：ping / error_notification 前後 FlowSession / Conversation count 唔變
T100_FS=$(q "SELECT count(*)::text c FROM \"FlowSession\"" | jf c)
T100_CONV=$(q "SELECT count(*)::text c FROM \"Conversation\"" | jf c)
pnpm -s flow-client stepx --clinic TKW --no-token --action ping >/dev/null 2>&1 || true
pnpm -s flow-client stepx --clinic TKW --no-token --action error_notification >/dev/null 2>&1 || true
T100_FS2=$(q "SELECT count(*)::text c FROM \"FlowSession\"" | jf c)
T100_CONV2=$(q "SELECT count(*)::text c FROM \"Conversation\"" | jf c)
{ [ "$T100_FS" = "$T100_FS2" ] && [ "$T100_CONV" = "$T100_CONV2" ]; } \
  && pass "T100 零 DB（FlowSession/Conversation count 前後一致）" \
  || { echo "    ❌ T100 零 DB（FlowSession $T100_FS→$T100_FS2 / Conversation $T100_CONV→$T100_CONV2）"; T100=1; }
[ "$T100" = 0 ] && pass "T100 ping/error_notification 無 token 放行 + INIT 照 401 + 零 DB" || { fail "T100 有項失敗（見上 ❌）"; R12=1; }

# R12 最終 cleanup：fill flag / booked store / rc 欄重置（避免殘留污染下次 run 早期測試）
rm -f .dev/workforce-mock-fill.json .dev/workforce-mock-booked.json
q "UPDATE \"AvailabilitySlot\" SET \"remainingCapacity\"=NULL" >/dev/null 2>&1

[ "$R12" = 0 ] && pass "R12 真 Flow v7.3 + §D remainingCapacity e2e（T96-T100）" || fail "R12 有項失敗（見上 ❌）"

# ══════════════ R13：providerslot T4 — Flow 三屏 claim（providerslot-20260830-T4）═══════════════
#   T101 三屏 round-trip（bookable 源）+ claim@submit_confirm + FlowHoldEvent + 冪等 replay
#        + 409 slot_taken → SCR_SLOT 重導 + patient_phone 空 → WA fallback + claimed nfm_reply 變體
R13=0
rm -f .dev/workforce-mock-claims.json
# deterministic fixture（重現 client.ts mock 規則）：首個開診日 + 一個 base seatsFree=1 嘅 slot（409 目標）
eval "$(node -e '
function djb2(s){let h=5381;for(let i=0;i<s.length;i++){h=((h<<5)+h+s.charCodeAt(i))>>>0}return h}
function pad(n){return String(n).padStart(2,"0")}
const c="TKW";
const d0=new Date(Date.now()+8*3600e3).toISOString().slice(0,10);
let d=null,t=null,p=null;
outer:
for(let i=0;i<31;i++){
  const day=new Date(Date.parse(d0+"T00:00:00Z")+i*86400e3).toISOString().slice(0,10);
  if(djb2(c+"|"+day)%7===3) continue;
  for(let pr=0;pr<2;pr++){
    for(let s=9*60;s<13*60;s+=30){
      if(1+(djb2(c+"|"+day+"|"+s+"|"+pr)%3)===1){ d=day; t=pad(Math.floor(s/60))+":"+pad(s%60); p="mock-pract-"+c+"-"+pr; break outer; }
    }
  }
}
if(!d){ console.log("T4_D=\"\""); process.exit(0); }
console.log([`T4_D=${d}`,`T4_T=${t}`,`T4_PROV=${p}`,`T4_SLOTKEY=\"mock|${c}|${d}|${t}|${p}\"`].join("\n"));
')"
if [ -z "${T4_D:-}" ]; then
  echo "    ❌ T4 fixture：30 日內搵唔到 base=1 slot（理論上不可能 — 496 個 slot 全 2..3）"
  fail "T101 fixture fail"; R13=1
else
  # T4_B = 同日另一可約 slot（唔係 T4_T）；T4_C = 另一 provider 個 09:00（FLOW_TOKEN_REUSED 測試用）
  T4_BT="09:30"; [ "$T4_T" = "09:30" ] && T4_BT="09:00"
  T4_B="mock|TKW|$T4_D|$T4_BT|$T4_PROV"
  T4_C="mock|TKW|$T4_D|09:00|mock-pract-TKW-1"
  T101=0
  echo "[R13] T101: 三屏 claim（deterministic：day=$T4_D slot=$T4_T prov=$T4_PROV base=1）..."
  t101_setup_pat() { # $1=waId $2=name $3=VARPREFIX
    local pat="$1" nm="$2" vp="$3" conv tok
    pnpm -s mock-inbound message --clinic TKW --from "$pat" --text "預約" --wamid "wamid.E2E_T101_${pat}_${EPOCH}" --name "$nm" >/dev/null 2>&1 || return 1
    wait_for "SELECT (c.\"lastInboundAt\" IS NOT NULL)::text ok FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$pat'" '[{"ok":"true"}]' 15 || return 1
    conv=$(q "SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$pat'" | jf id)
    [ -n "$conv" ] || return 1
    curl -s -o "/tmp/e2e-t101-flow-$vp.json" -b "$COOKIE_TKW" -X POST "$BASE/api/conversations/$conv/flows" -H 'Content-Type: application/json'
    tok=$(jf flowToken < "/tmp/e2e-t101-flow-$vp.json")
    [ -n "$tok" ] || return 1
    printf -v "${vp}_CONV" '%s' "$conv"
    printf -v "${vp}_TOK" '%s' "$tok"
    return 0
  }
  if t101_setup_pat "8526911${EPOCH}" "E2E T101A" T101A && t101_setup_pat "8526912${EPOCH}" "E2E T101B" T101B; then
    # ── P1：三屏 round-trip ──
    OUT=$(pnpm -s flow-client stepx --clinic TKW --token "$T101A_TOK" --action INIT 2>&1 || true)
    if stepx_parse "$OUT" /tmp/e2e-t101a-init.json; then
      check "T101 P1 INIT → SCR_DATE" "$(jf screen < /tmp/e2e-t101a-init.json)" "SCR_DATE"
      check "T101 P1 INIT date_min = 今日" "$(jf date_min < /tmp/e2e-t101a-init.json)" "$(node -e 'console.log(new Date(Date.now()+8*3600e3).toISOString().slice(0,10))')"
      T101A_HE=$(grep -oE '"has_error":(true|false)' /tmp/e2e-t101a-init.json | head -1 | cut -d: -f2)
      check "T101 P1 INIT has_error=false" "$T101A_HE" "false"
    else echo "    ❌ T101 P1 INIT fail"; T101=1; R13=1; fi
    OUT=$(pnpm -s flow-client stepx --clinic TKW --token "$T101A_TOK" --action data_exchange --screen SCR_DATE --data "{\"user_action\":\"submit_date\",\"date\":\"$T4_D\"}" 2>&1 || true)
    if stepx_parse "$OUT" /tmp/e2e-t101a-slot.json; then
      check "T101 P1 submit_date → SCR_SLOT" "$(jf screen < /tmp/e2e-t101a-slot.json)" "SCR_SLOT"
      grep -qF "\"id\":\"$T4_PROV\"" /tmp/e2e-t101a-slot.json && pass "T101 P1 SCR_SLOT providers 含 $T4_PROV" || { echo "    ❌ T101 P1 providers 冇 $T4_PROV"; T101=1; R13=1; }
      grep -qF "\"$T4_T\"" /tmp/e2e-t101a-slot.json && pass "T101 P1 SCR_SLOT times 含 $T4_T" || { echo "    ❌ T101 P1 times 冇 $T4_T"; T101=1; R13=1; }
    else echo "    ❌ T101 P1 submit_date fail"; T101=1; R13=1; fi
    OUT=$(pnpm -s flow-client stepx --clinic TKW --token "$T101A_TOK" --action data_exchange --screen SCR_SLOT --data "{\"user_action\":\"submit_slot\",\"date\":\"$T4_D\",\"provider_id\":\"$T4_PROV\",\"time\":\"$T4_T\"}" 2>&1 || true)
    if stepx_parse "$OUT" /tmp/e2e-t101a-confirm.json; then
      check "T101 P1 submit_slot → SCR_CONFIRM" "$(jf screen < /tmp/e2e-t101a-confirm.json)" "SCR_CONFIRM"
      check "T101 P1 confirm provider_id" "$(jf provider_id < /tmp/e2e-t101a-confirm.json)" "$T4_PROV"
      check "T101 P1 confirm profile_name" "$(jf profile_name < /tmp/e2e-t101a-confirm.json)" "E2E T101A"
    else echo "    ❌ T101 P1 submit_slot fail"; T101=1; R13=1; fi
    # ── P2：搶先都推到 SCR_CONFIRM（slot 仍係空）──
    OUT=$(pnpm -s flow-client stepx --clinic TKW --token "$T101B_TOK" --action INIT 2>&1 || true)
    stepx_parse "$OUT" /tmp/e2e-t101b-init.json || { echo "    ❌ T101 P2 INIT fail"; T101=1; R13=1; }
    OUT=$(pnpm -s flow-client stepx --clinic TKW --token "$T101B_TOK" --action data_exchange --screen SCR_DATE --data "{\"user_action\":\"submit_date\",\"date\":\"$T4_D\"}" 2>&1 || true)
    stepx_parse "$OUT" /tmp/e2e-t101b-slot.json || { echo "    ❌ T101 P2 submit_date fail"; T101=1; R13=1; }
    OUT=$(pnpm -s flow-client stepx --clinic TKW --token "$T101B_TOK" --action data_exchange --screen SCR_SLOT --data "{\"user_action\":\"submit_slot\",\"date\":\"$T4_D\",\"provider_id\":\"$T4_PROV\",\"time\":\"$T4_T\"}" 2>&1 || true)
    if stepx_parse "$OUT" /tmp/e2e-t101b-confirm.json; then
      check "T101 P2（未佔位）submit_slot → SCR_CONFIRM" "$(jf screen < /tmp/e2e-t101b-confirm.json)" "SCR_CONFIRM"
    else echo "    ❌ T101 P2 submit_slot fail（應該仲可進 confirm）"; T101=1; R13=1; fi
    # ── P1：submit_confirm → ★ claim 201 → SUCCESS（patient_phone 空 → WA fallback）──
    OUT=$(pnpm -s flow-client stepx --clinic TKW --token "$T101A_TOK" --action data_exchange --screen SCR_CONFIRM --data "{\"user_action\":\"submit_confirm\",\"date\":\"$T4_D\",\"provider_id\":\"$T4_PROV\",\"time\":\"$T4_T\",\"name\":\"E2E T101A\",\"patient_phone\":\"\",\"notes\":\"t101\"}" 2>&1 || true)
    if stepx_parse "$OUT" /tmp/e2e-t101a-success.json; then
      check "T101 P1 submit_confirm → SUCCESS" "$(jf screen < /tmp/e2e-t101a-success.json)" "SUCCESS"
      T101_HOLD=$(jf holdId < /tmp/e2e-t101a-success.json)
      [ -n "$T101_HOLD" ] && [ "$T101_HOLD" != "undefined" ] && pass "T101 P1 SUCCESS params.holdId" || { echo "    ❌ T101 P1 SUCCESS 冇 holdId"; T101=1; R13=1; }
      T101_HEV=$(q "SELECT \"status\"||'|'||\"patientPhone\"||'|'||\"patientName\" v FROM \"FlowHoldEvent\" WHERE \"flowToken\"='$T101A_TOK'" | jf v)
      check "T101 FlowHoldEvent（HELD + WA fallback 電話 + 病人名）" "$T101_HEV" "HELD|8526911${EPOCH}|E2E T101A"
      # conversations API holdEvent（T3 預約卡「線上已佔」源；HoldEventView 唔帶 workforceHoldId — 用 patientPhone 唯一鍵斷言）
      curl -s -b "$COOKIE_TKW" "$BASE/api/conversations" -o /tmp/e2e-t101-convlist.json
      grep -qF "\"patientPhone\":\"8526911${EPOCH}\"" /tmp/e2e-t101-convlist.json && grep -qF "\"status\":\"HELD\"" /tmp/e2e-t101-convlist.json && pass "T101 conversations API 帶 holdEvent（HELD + patientPhone）" || { echo "    ❌ T101 conversations API 冇 holdEvent"; T101=1; R13=1; }
    else echo "    ❌ T101 P1 submit_confirm fail"; T101=1; R13=1; fi
    # ── P1 冪等 replay：同 token 同 slot 重複 submit_confirm → SUCCESS 再回，唔雙佔 ──
    OUT=$(pnpm -s flow-client stepx --clinic TKW --token "$T101A_TOK" --action data_exchange --screen SCR_CONFIRM --data "{\"user_action\":\"submit_confirm\",\"date\":\"$T4_D\",\"provider_id\":\"$T4_PROV\",\"time\":\"$T4_T\",\"name\":\"E2E T101A\",\"patient_phone\":\"\",\"notes\":\"t101\"}" 2>&1 || true)
    if stepx_parse "$OUT" /tmp/e2e-t101a-replay.json; then
      check "T101 P1 冪等 replay → SUCCESS" "$(jf screen < /tmp/e2e-t101a-replay.json)" "SUCCESS"
      check "T101 P1 replay holdId 同一" "$(jf holdId < /tmp/e2e-t101a-replay.json)" "$T101_HOLD"
      T101_CNT=$(q "SELECT count(*)::text c FROM \"FlowHoldEvent\" WHERE \"flowToken\"='$T101A_TOK'" | jf c)
      check "T101 FlowHoldEvent 仍 1 行（唔雙佔）" "$T101_CNT" "1"
    else echo "    ❌ T101 P1 replay fail"; T101=1; R13=1; fi
    # ── P2：submit_confirm → 409 等價 → SCR_SLOT 重導（$T4_T 已冇）──
    OUT=$(pnpm -s flow-client stepx --clinic TKW --token "$T101B_TOK" --action data_exchange --screen SCR_CONFIRM --data "{\"user_action\":\"submit_confirm\",\"date\":\"$T4_D\",\"provider_id\":\"$T4_PROV\",\"time\":\"$T4_T\",\"name\":\"E2E T101B\",\"patient_phone\":\"\",\"notes\":\"\"}" 2>&1 || true)
    if stepx_parse "$OUT" /tmp/e2e-t101b-409.json; then
      check "T101 P2 submit_confirm → SCR_SLOT 重導" "$(jf screen < /tmp/e2e-t101b-409.json)" "SCR_SLOT"
      T101B_HE=$(grep -oE '"has_error":(true|false)' /tmp/e2e-t101b-409.json | head -1 | cut -d: -f2)
      check "T101 P2 重導 has_error=true" "$T101B_HE" "true"
      grep -qE '"error_message":"[^\"]+' /tmp/e2e-t101b-409.json && pass "T101 P2 重導 error_message 非空" || { echo "    ❌ T101 P2 重導 error_message 空"; T101=1; R13=1; }
      # 被佔組合（$T4_PROV,$T4_T）唔可再揀（times 係去重平铺 — 其他 provider 同時段仍會列，所以斷言組合拒收）
      OUT=$(pnpm -s flow-client stepx --clinic TKW --token "$T101B_TOK" --action data_exchange --screen SCR_SLOT --data "{\"user_action\":\"submit_slot\",\"date\":\"$T4_D\",\"provider_id\":\"$T4_PROV\",\"time\":\"$T4_T\"}" 2>&1 || true)
      if stepx_parse "$OUT" /tmp/e2e-t101b-combo.json; then
        T101B_COMBOK="$(jf screen < /tmp/e2e-t101b-combo.json)|$(grep -oE '"has_error":(true|false)' /tmp/e2e-t101b-combo.json | head -1 | cut -d: -f2)"
        check "T101 P2 被佔組合再揀 → 留 SCR_SLOT + error" "$T101B_COMBOK" "SCR_SLOT|true"
      else echo "    ❌ T101 P2 組合拒收 stepx fail"; T101=1; R13=1; fi
      T101B_HEV=$(q "SELECT count(*)::text c FROM \"FlowHoldEvent\" WHERE \"flowToken\"='$T101B_TOK'" | jf c)
      check "T101 P2 無 FlowHoldEvent（未佔位）" "$T101B_HEV" "0"
    else echo "    ❌ T101 P2 submit_confirm fail（應該 200 + SCR_SLOT 重導）"; T101=1; R13=1; fi
    # ── mock claim 直查：409 SLOT_TAKEN + 冪等 replay + FLOW_TOKEN_REUSED（client 層）──
    cat > .dev/t101-claim-check.ts <<'T101TS'
import { claimSlot, WorkforceApiError } from "@/lib/workforce/client";
const [slotKey, p1Token, slotB, slotC] = process.argv.slice(2);
async function main() {
  // (a) 新 token 搶已佔 slot → 409 SLOT_TAKEN
  try {
    await claimSlot({ slotKey, patientWaId: "999000111", patientName: "X", flowToken: "t4-e2e-token-c" });
    console.log("A-FAIL: 無 409");
  } catch (e) {
    console.log(e instanceof WorkforceApiError && e.status === 409 && e.code !== "FLOW_TOKEN_REUSED" ? "A-OK" : `A-FAIL: ${String(e)}`); // 同真 T1：slot_taken 409 無 code 欄
  }
  // (b) replay P1 token + 同 slot → 201 同 holdId（冪等唔雙佔）
  try {
    const r = await claimSlot({ slotKey, patientWaId: "8526911", patientName: "E2E T101A", flowToken: p1Token });
    console.log(`B-${r ? "OK" : "FAIL"}: holdId=${r.holdId}`);
  } catch (e) { console.log(`B-FAIL: ${String(e)}`); }
  // (c) 新 token3 搶另一 slot → 201；再用 token3 搶第三 slot → 409 FLOW_TOKEN_REUSED
  try {
    const r = await claimSlot({ slotKey: slotB, patientWaId: "999000222", patientName: "Y", flowToken: "t4-e2e-token3" });
    console.log(`C-${r ? "OK" : "FAIL"}`);
  } catch (e) { console.log(`C-FAIL: ${String(e)}`); }
  try {
    await claimSlot({ slotKey: slotC, patientWaId: "999000222", patientName: "Y", flowToken: "t4-e2e-token3" });
    console.log("D-FAIL: 無 409 REUSED");
  } catch (e) {
    console.log(e instanceof WorkforceApiError && e.status === 409 && e.code === "FLOW_TOKEN_REUSED" ? "D-OK" : `D-FAIL: ${String(e)}`);
  }
}
main().then(() => process.exit(0)); // ★ cwi-refresh-20260831：client.ts import 鏈含 redis handle — 必須顯式 exit
T101TS
    T101_CLAIM_OUT=$(WORKFORCE_MOCK=1 pnpm exec tsx .dev/t101-claim-check.ts "$T4_SLOTKEY" "$T101A_TOK" "$T4_B" "$T4_C" 2>&1 | grep -E '^[A-D]-' || true)
    T101_B_HOLD=$(q "SELECT \"workforceHoldId\"::text w FROM \"FlowHoldEvent\" WHERE \"flowToken\"='$T101A_TOK'" | jf w)
    grep -q "^A-OK$" <<< "$T101_CLAIM_OUT" && pass "T101 mock claim：已佔 slot 新 token → 409 SLOT_TAKEN" || { echo "    ❌ T101 (a)（=$(echo "$T101_CLAIM_OUT" | head -1)）"; T101=1; R13=1; }
    grep -q "^B-OK: holdId=$T101_B_HOLD$" <<< "$T101_CLAIM_OUT" && pass "T101 mock claim：同 token 同 slot replay → 同 holdId（冪等）" || { echo "    ❌ T101 (b)（=$(echo "$T101_CLAIM_OUT" | sed -n 2p)）"; T101=1; R13=1; }
    grep -q "^C-OK$" <<< "$T101_CLAIM_OUT" && pass "T101 mock claim：新 token 另一 slot → 201" || { echo "    ❌ T101 (c)"; T101=1; R13=1; }
    grep -q "^D-OK$" <<< "$T101_CLAIM_OUT" && pass "T101 mock claim：同 token 第三 slot → 409 FLOW_TOKEN_REUSED" || { echo "    ❌ T101 (d)"; T101=1; R13=1; }
    rm -f .dev/t101-claim-check.ts
    # ── nfm_reply claimed 變體（--holdId）：唔建 BookingRequest + session COMPLETED ──
    OUT=$(pnpm -s flow-client complete --clinic TKW --conv "$T101A_CONV" --token "$T101A_TOK" --provider "$T4_PROV" --providerName "mock 陳醫師" --date "$T4_D" --time "$T4_T" --wa-id "8526911${EPOCH}" --wamid "wamid.E2E_T101_CLAIM_${EPOCH}" --name "E2E T101A" --holdId "$T101_HOLD" 2>&1 || true)
    echo "$OUT" | grep -q "OK wamid=" && pass "T101 nfm_reply claimed 變體 webhook OK" || { echo "    ❌ T101 nfm_reply fail（=${OUT%%$'\n'*}）"; T101=1; R13=1; }
    wait_for "SELECT (\"status\"='COMPLETED')::text ok FROM \"FlowSession\" WHERE \"flowToken\"='$T101A_TOK'" '[{"ok":"true"}]' 10 && pass "T101 claimed nfm_reply → FlowSession COMPLETED" || { echo "    ❌ T101 FlowSession 未 COMPLETED"; T101=1; R13=1; }
    T101_BR=$(q "SELECT count(*)::text c FROM \"BookingRequest\" WHERE \"conversationId\"='$T101A_CONV'" | jf c)
    check "T101 claimed 變體唔建 BookingRequest" "$T101_BR" "0"
    # ── cleanup ──
    q "DELETE FROM \"FlowHoldEvent\" WHERE \"flowToken\" IN ('$T101A_TOK','$T101B_TOK')" >/dev/null 2>&1
    q "DELETE FROM \"FlowSession\" WHERE \"flowToken\" IN ('$T101A_TOK','$T101B_TOK')" >/dev/null 2>&1
    q "DELETE FROM \"AuditLog\" WHERE action='FLOW_CLAIM'" >/dev/null 2>&1
    rm -f .dev/workforce-mock-claims.json
    t98_pat_sweep "8526911${EPOCH}"
    t98_pat_sweep "8526912${EPOCH}"
    [ "$T101" = 0 ] && pass "T101 三屏 claim round-trip（409 重導 + 冪等 + WA fallback + claimed nfm_reply）" || fail "T101 有項失敗（見上 ❌）"
  else
    echo "    ❌ T101 patient setup fail"; T101=1; fail "T101 有項失敗（見上 ❌）"
  fi
fi
[ "$R13" = 0 ] && pass "R13 providerslot T4 三屏 claim e2e（T101）" || fail "R13 有項失敗（見上 ❌）"

# ── R11 summary ─────────────────────────────────────────────────────────────
[ "$R11_FAIL" = 0 ] && pass "R11 輪一收尾 e2e（T93 Flow 回滾 / T94 週表頁 / T95 duty 卡刷新）" || fail "R11 有項失敗（見上 ❌）"

# ── R14: cwi-refresh-20260831（T145–T148）────────────────────────────────
echo "[R14] T145–T148: 全鏈手動刷新 + 寫入後 bust + Flow stale gate (cwi-refresh-20260831)..."
R14=0
# 決定性 open 日（mock 規則 djb2(clinic|day)%7!==3 — 同 T98；取兩個做雙日測試）
read -r R14_D R14_D2 <<EOF14
$(node -e 'function djb2(s){let h=5381;for(let i=0;i<s.length;i++){h=((h<<5)+h+s.charCodeAt(i))>>>0}return h}const c="TKW";const d0=new Date(Date.now()+8*3600e3).toISOString().slice(0,10);const f=[];for(let i=1;i<31&&f.length<2;i++){const day=new Date(Date.parse(d0+"T00:00:00Z")+i*86400e3).toISOString().slice(0,10);if(djb2(c+"|"+day)%7!==3)f.push(day)}console.log(f.join(" "))')
EOF14
# L2 該日 max syncedAt（text — 避開 naive timestamp tz 陷阱：只比「變咗冇」/ epoch 比較）
l2_max() { q "SELECT max(\"syncedAt\")::text m FROM \"AvailabilitySlot\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND \"date\"='$1'" | jf m; }
# a3 2026-09-02：dev manifest flake（loadManifest race → HTML 500）只對 flake 簽名 retry；真 500 照 fail
#（同下方 400 check 既設；r3 實測 T146 409 撞 flake 返 HTML 500）
t146_call() { # t146_call <body-json> → 設 T146_R / T146_C
  local body="$1" i
  for i in 1 2 3; do
    T146_R=$(curl -s -w '\n%{http_code}' -b "$COOKIE_TKW" -X POST "$BASE/api/availability/refresh" -H 'Content-Type: application/json' -d "$body")
    T146_C=$(tail -1 <<< "$T146_R")
    if [ "$T146_C" = "500" ] && grep -qE 'Unexpected end of JSON input|<!DOCTYPE html>' <<< "$(sed '$d' <<< "$T146_R")"; then
      echo "    (T146 dev manifest flake 500 → retry $i)"; sleep 2; continue
    fi
    return 0
  done
}

if [ -z "$R14_D" ] || [ -z "$R14_D2" ]; then
  echo "    ❌ R14：mock 30 日內搵唔到兩個 open 日"; R14=1
else
  # ── T145. 手動刷新 200 全鏈 + 寫入後 dayRefreshed hook ───────────────────
  T145_OLD=$(l2_max "$R14_D")
  T145_RES=$(curl -s -w '\n%{http_code}' -b "$COOKIE_TKW" -X POST "$BASE/api/availability/refresh" -H 'Content-Type: application/json' -d "{\"clinicCode\":\"TKW\",\"dates\":[\"$R14_D\"]}")
  T145_HTTP=$(tail -1 <<< "$T145_RES")
  T145_BODY=$(head -1 <<< "$T145_RES")
  sleep 1
  T145_NEW=$(l2_max "$R14_D")
  check "T145a 手動刷新 200" "$T145_HTTP" "200"
  grep -q '"v":1' <<< "$T145_BODY" && pass "T145a body v=1" || { echo "    ❌ T145a body（=${T145_BODY:0:120}）"; R14=1; }
  grep -q "\"date\":\"$R14_D\",\"ok\":true" <<< "$T145_BODY" && pass "T145a refreshed[0].ok=true" || { echo "    ❌ T145a ok（=${T145_BODY:0:120}）"; R14=1; }
  [ -n "$T145_NEW" ] && [ "$T145_NEW" != "$T145_OLD" ] && pass "T145a L2 busted + refilled（syncedAt ${T145_OLD:0:19}→${T145_NEW:0:19}）" || { echo "    ❌ T145a L2 未變（old=$T145_OLD new=$T145_NEW）"; R14=1; }

  # (b) 寫入 → dayRefreshed hook（on=bust / off=唔 bust 對照 — tsx 直測 client hook）
  cat > .dev/t145-hook-check.ts <<'T145TS'
// T145b：createBooking(dayRefreshed) → L2 syncedAt 必變；dayrefreshed-off flag → 唔變
// ★ async IIFE 包身：.dev/*.ts 無 "type":"module" → tsx 按 CJS 轉譯 → top-level await 直接 TransformError（2026-08-31 實測空輸出）
process.env.WORKFORCE_MOCK = "1";
import prisma from "../src/lib/prisma";
import { createBooking } from "../src/lib/workforce/client";
import { writeFileSync } from "node:fs";

const [, , clinicId, date] = process.argv;
const maxSync = async () => {
  const r = await prisma.$queryRawUnsafe(
    'SELECT max("syncedAt")::text m FROM "AvailabilitySlot" WHERE "clinicId"=$1 AND "date"=$2',
    clinicId, date,
  );
  return String((r as Array<{ m: string | null }>)[0]?.m ?? "");
};
const mk = (n: string) => ({
  idempotencyKey: `t145-hook-${n}-${Date.now()}`,
  clinicCode: "TKW",
  providerApricotId: "mock-dr-t145",
  date,
  start: "09:00",
  durationMin: 30,
  visitReasonId: "0010",
  patient: { name: "E2E T145", phone: "85200000001" },
});
(async () => {
  // new-patient mock Stage 1 預設 off → {name,phone} 新客 body 會 422 NEW_PATIENT_DISABLED（T145b 2026-08-31 實測）
  writeFileSync(".dev/workforce-mock-newpatient.json", JSON.stringify({ on: true }));
  const before = await maxSync();
  await new Promise((r) => setTimeout(r, 1100));
  await createBooking(mk("on"));
  const after = await maxSync();
  console.log(`HOOK-DIFF:${before === after ? "SAME" : "CHANGED"}`);
  writeFileSync(".dev/workforce-mock-dayrefreshed-off.json", JSON.stringify({ on: true }));
  const before2 = await maxSync();
  await new Promise((r) => setTimeout(r, 1100));
  await createBooking(mk("off"));
  const after2 = await maxSync();
  console.log(`HOOK-OFF-DIFF:${before2 === after2 ? "SAME" : "CHANGED"}`);
  writeFileSync(".dev/workforce-mock-dayrefreshed-off.json", JSON.stringify({ on: false }));
  writeFileSync(".dev/workforce-mock-newpatient.json", JSON.stringify({ on: false })); // 還原，防止污染其他 run 嘅 new-patient 422 斷言
  process.exit(0); // ★ client.ts import 鏈含 redis handle — 必須顯式 exit
})().catch((e) => {
  console.error(`HOOK-ERR:${e?.message ?? e}`);
  process.exit(1);
});
T145TS
  T145_HK=$(WORKFORCE_MOCK=1 pnpm exec tsx .dev/t145-hook-check.ts "$TKW_CLINIC_ID" "$R14_D" 2>&1 | grep -E '^HOOK' || true)
  grep -q "HOOK-DIFF:CHANGED" <<< "$T145_HK" && pass "T145b 寫入(dayRefreshed=true) → L2 即時 bust（syncedAt 變）" || { echo "    ❌ T145b on（=$(echo "$T145_HK" | tr '\n' ' ')）"; R14=1; }
  grep -q "HOOK-OFF-DIFF:SAME" <<< "$T145_HK" && pass "T145b 寫入(dayRefreshed=false) → 唔 bust（對照）" || { echo "    ❌ T145b off（=$(echo "$T145_HK" | tr '\n' ' ')）"; R14=1; }
  rm -f .dev/t145-hook-check.ts .dev/workforce-mock-dayrefreshed-off.json .dev/workforce-mock-booked.json

  # ── T146. refresh 錯誤 shape（429/409/404/403/400 — 對齊 S1 真端點）────
  # 429 flag
  echo '{}' > .dev/workforce-mock-refresh-429.json
  t146_call "{\"clinicCode\":\"TKW\",\"dates\":[\"$R14_D\"]}"
  check "T146 429" "$T146_C" "429"
  grep -q '"code":"RATE_LIMITED"' <<< "$(head -1 <<< "$T146_R")" && pass "T146 429 code=RATE_LIMITED" || { echo "    ❌ T146 429 code（=$(head -1 <<< "$T146_R" | head -c 120)）"; R14=1; }
  grep -q '"retryAfterSec":37' <<< "$(head -1 <<< "$T146_R")" && pass "T146 429 retryAfterSec=37" || { echo "    ❌ T146 429 retryAfterSec（=$(head -1 <<< "$T146_R" | head -c 120)）"; R14=1; }
  rm -f .dev/workforce-mock-refresh-429.json
  # 409
  echo '{}' > .dev/workforce-mock-refresh-409.json
  t146_call "{\"clinicCode\":\"TKW\",\"dates\":[\"$R14_D\"]}"
  check "T146 409" "$T146_C" "409"
  grep -q 'APRICOT_BUSY' <<< "$(head -1 <<< "$T146_R")" && pass "T146 409 code=APRICOT_BUSY" || { echo "    ❌ T146 409（=$(head -1 <<< "$T146_R" | head -c 120)）"; R14=1; }
  rm -f .dev/workforce-mock-refresh-409.json
  # 404
  echo '{}' > .dev/workforce-mock-refresh-404.json
  t146_call "{\"clinicCode\":\"TKW\",\"dates\":[\"$R14_D\"]}"
  check "T146 404" "$T146_C" "404"
  grep -q 'CLINIC_NOT_FOUND' <<< "$(head -1 <<< "$T146_R")" && pass "T146 404 code=CLINIC_NOT_FOUND" || { echo "    ❌ T146 404（=$(head -1 <<< "$T146_R" | head -c 120)）"; R14=1; }
  rm -f .dev/workforce-mock-refresh-404.json
  # 403
  echo '{}' > .dev/workforce-mock-refresh-403.json
  t146_call "{\"clinicCode\":\"TKW\",\"dates\":[\"$R14_D\"]}"
  check "T146 403" "$T146_C" "403"
  rm -f .dev/workforce-mock-refresh-403.json
  # 400：8 日（超上限）— POST 可安全 retry：8 日喺 route zod 層即拒，唔到 mock（無 side effect）
  T146_R=$(curl -s -w '\n%{http_code}' -b "$COOKIE_TKW" -X POST "$BASE/api/availability/refresh" -H 'Content-Type: application/json' -d '{"clinicCode":"TKW","dates":["2026-09-01","2026-09-02","2026-09-03","2026-09-04","2026-09-05","2026-09-06","2026-09-07","2026-09-08"]}')
  T146_C=$(tail -1 <<< "$T146_R")
  for i in 1 2; do
    [ "$T146_C" = "400" ] && break
    grep -q "Unexpected end of JSON input" <<< "$(sed '$d' <<< "$T146_R")" || break # 只 retry flake 簽名；真 500 照 fail
    echo "    (T146 8d dev manifest flake 500 → retry $i)"
    sleep 2
    T146_R=$(curl -s -w '\n%{http_code}' -b "$COOKIE_TKW" -X POST "$BASE/api/availability/refresh" -H 'Content-Type: application/json' -d '{"clinicCode":"TKW","dates":["2026-09-01","2026-09-02","2026-09-03","2026-09-04","2026-09-05","2026-09-06","2026-09-07","2026-09-08"]}')
    T146_C=$(tail -1 <<< "$T146_R")
  done
  check "T146 400（8 日）" "$T146_C" "400"

  # ── T147. 逐日 ok:false → 該日唔 bust（對照日照 bust）──────────────────
  T147_OLD=$(l2_max "$R14_D")
  T147_OLD2=$(l2_max "$R14_D2")
  echo "[\"$R14_D\"]" > .dev/workforce-mock-refresh-failday.json
  T147_R=$(curl -s -w '\n%{http_code}' -b "$COOKIE_TKW" -X POST "$BASE/api/availability/refresh" -H 'Content-Type: application/json' -d "{\"clinicCode\":\"TKW\",\"dates\":[\"$R14_D\",\"$R14_D2\"]}")
  T147_BODY=$(head -1 <<< "$T147_R")
  check "T147 200" "$(tail -1 <<< "$T147_R")" "200"
  sleep 1
  T147_NEW=$(l2_max "$R14_D")
  T147_NEW2=$(l2_max "$R14_D2")
  grep -q "\"date\":\"$R14_D\",\"ok\":false" <<< "$T147_BODY" && pass "T147 fail day ok:false" || { echo "    ❌ T147 ok:false（=${T147_BODY:0:160}）"; R14=1; }
  grep -q 'SYNC_FAILED' <<< "$T147_BODY" && pass "T147 fail day error=SYNC_FAILED" || { echo "    ❌ T147 error（=${T147_BODY:0:160}）"; R14=1; }
  grep -q "\"date\":\"$R14_D2\",\"ok\":true" <<< "$T147_BODY" && pass "T147 對照日 ok:true" || { echo "    ❌ T147 對照日（=${T147_BODY:0:160}）"; R14=1; }
  [ "$T147_NEW" = "$T147_OLD" ] && pass "T147 fail day 唔 bust（L2 原封）" || { echo "    ❌ T147 fail day 被 bust（old=$T147_OLD new=$T147_NEW）"; R14=1; }
  [ -n "$T147_NEW2" ] && [ "$T147_NEW2" != "$T147_OLD2" ] && pass "T147 對照日 busted + refilled" || { echo "    ❌ T147 對照日未變（old=$T147_OLD2 new=$T147_NEW2）"; R14=1; }
  rm -f .dev/workforce-mock-refresh-failday.json

  # ── T148. Flow data_exchange stale gate（>20m → 靜默 refresh+bust → 出 options）──
  # 準備：L2 窗口（today..R14_D）清晒 → 只 seed R14_D → 打舊 2 小時（naive column：AT TIME ZONE 'UTC'）
  T148_TODAY=$(node -e 'console.log(new Date(Date.now()+8*3600e3).toISOString().slice(0,10))')
  q "DELETE FROM \"AvailabilitySlot\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND \"date\" BETWEEN '$T148_TODAY' AND '$R14_D'" >/dev/null 2>&1
  curl -s -o /dev/null -b "$COOKIE_TKW" -X POST "$BASE/api/availability/refresh" -H 'Content-Type: application/json' -d "{\"clinicCode\":\"TKW\",\"dates\":[\"$R14_D\"]}"
  q "UPDATE \"AvailabilitySlot\" SET \"syncedAt\"=(now() AT TIME ZONE 'UTC') - interval '2 hours' WHERE \"clinicId\"='$TKW_CLINIC_ID' AND \"date\"='$R14_D'" >/dev/null 2>&1
  if t98_setup_pat "8526955${EPOCH}" "E2E T148"; then
    T148_TOK="$T98_TOK" # t98_setup_pat 設嘅係 T98_TOK（T148 原引用咗唔存在嘅 T148_TOK → stepx 空 token → 全段靜默失敗，2026-08-31 實測）
    T148_LOG0=$(grep -c '"path":"/api/external/v1/availability/refresh"' .dev/workforce-mock-calls.jsonl 2>/dev/null); T148_LOG0=${T148_LOG0:-0}
    T148_OUT=$(pnpm -s flow-client stepx --clinic TKW --token "$T148_TOK" --action data_exchange --screen SCR_DATE --data '{"user_action":"submit_date","date":"'$R14_D'"}' 2>&1 || true)
    stepx_parse "$T148_OUT" /tmp/e2e-t148-slot.json
    T148_LOG1=$(grep -c '"path":"/api/external/v1/availability/refresh"' .dev/workforce-mock-calls.jsonl 2>/dev/null); T148_LOG1=${T148_LOG1:-0}
    [ "$T148_LOG1" -gt "$T148_LOG0" ] && pass "T148 stale(>20m) → data_exchange 前靜默 refresh 觸發" || { echo "    ❌ T148 無 refresh（log0=$T148_LOG0 log1=$T148_LOG1 out=$(echo "$T148_OUT" | head -c 160)）"; R14=1; }
    grep -q '"screen":"SCR_SLOT"' /tmp/e2e-t148-slot.json 2>/dev/null && pass "T148 refresh 後出 options（SCR_SLOT）" || { echo "    ❌ T148 屏（=$(head -c 160 /tmp/e2e-t148-slot.json 2>/dev/null)）"; R14=1; }
    T148_MAX=$(l2_max "$R14_D")
    T148_MAX_E=$(date -u -d "$T148_MAX" +%s 2>/dev/null || echo 0)
    T148_STALE_E=$(date -u -d '2 hours ago' +%s)
    [ "$T148_MAX_E" -gt "$T148_STALE_E" ] && pass "T148 L2 已重填（syncedAt 新於 stale mark）" || { echo "    ❌ T148 L2 未重填（max=$T148_MAX）"; R14=1; }
    # 負對照：L2 已 fresh → 再 stepx 唔該再 refresh
    T148_OUT2=$(pnpm -s flow-client stepx --clinic TKW --token "$T148_TOK" --action data_exchange --screen SCR_DATE --data '{"user_action":"submit_date","date":"'$R14_D'"}' 2>&1 || true)
    T148_LOG2=$(grep -c '"path":"/api/external/v1/availability/refresh"' .dev/workforce-mock-calls.jsonl 2>/dev/null); T148_LOG2=${T148_LOG2:-0}
    [ "$T148_LOG2" = "$T148_LOG1" ] && pass "T148 fresh L2 → 唔重複 refresh（gate 正確）" || { echo "    ❌ T148 fresh 仲 refresh（log1=$T148_LOG1 log2=$T148_LOG2）"; R14=1; }
    t98_pat_sweep "8526955${EPOCH}"
  else
    echo "    ❌ T148 patient setup fail"; R14=1
  fi
fi
rm -f .dev/workforce-mock-refresh-4*.json .dev/workforce-mock-refresh-failday.json .dev/workforce-mock-dayrefreshed-off.json
[ "$R14" = 0 ] && pass "R14 cwi-refresh 全鏈 e2e（T145 手動刷新+hook / T146 錯誤 shape / T147 逐日失敗 / T148 Flow stale gate）" || fail "R14 有項失敗（見上 ❌）"

# ════════════════════════════════════════════════════════════════════════
# H6 cwi-h6-20260830 §7：E2E H6-T91–T99（多店員工 + 接手放手 + auto-release + 備註卡）
# ★ 偏差聲明：本檔既有 T88–T104 編號已被舊 ticket（template/flow/schedule/duty/capacity）佔用 —
#   新測試標 H6-T91…H6-T99，一一对應 MD §7 嘅 T91…T99 定義（編號撞車，唔改名舊測試）。
# 合成 fixture 全帶 E2E/EPOCH 前綴，零 PII；段尾 hermetic cleanup。
# ════════════════════════════════════════════════════════════════════════
echo "[H6] cwi-h6-20260830: H6-T91–T99..."
H6=0
NOWISO6=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
WTC_CLINIC_ID=$(q "SELECT id FROM \"Clinic\" WHERE code='WTC'" | jf id)
WTC_STAFF_ID=$(q "SELECT id FROM \"StaffUser\" WHERE email='staff-wtc@wa-clinic.local'" | jf id)
ADMIN_STAFF_ID=$(q "SELECT id FROM \"StaffUser\" WHERE email='$ADMIN_EMAIL'" | jf id)
[ -n "$WTC_CLINIC_ID" ] && [ -n "$WTC_STAFF_ID" ] && [ -n "$ADMIN_STAFF_ID" ] || { echo "    FATAL: WTC/ADMIN id 搵唔到"; exit 1; }
WTC_EMAIL=$(awk '/^WTC STAFF:/{print $3}' .dev/credentials.txt)
WTC_PASS=$(awk '/^WTC STAFF:/{split($0,a," / "); print a[2]}' .dev/credentials.txt)
COOKIE_WTC=/tmp/e2e-cookie-wtc.txt
CODE=$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIE_WTC" \
  -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$WTC_EMAIL\",\"password\":\"$WTC_PASS\"}")
check "H6 setup login staff-wtc → 200" "$CODE" "200"

# H6 多店 staff fixture：TKW primary + MF secondary（固定 email 冪等；段尾刪 — hermetic）
H6M_EMAIL="h6-multi@wa-clinic.local"
H6M_OUT=$(pnpm -s e2e:staff create --clinic TKW --email "$H6M_EMAIL" --name "E2E H6 Multi")
H6M_ID=$(echo "$H6M_OUT" | grep -oE 'STAFF_ID=\S+' | cut -d= -f2)
q "INSERT INTO \"StaffClinic\" (\"staffId\", \"clinicId\", \"isPrimary\") VALUES ('$H6M_ID', '$MF_CLINIC_ID', false) ON CONFLICT DO NOTHING" >/dev/null 2>&1
COOKIE_H6M=/tmp/e2e-cookie-h6m.txt
CODE=$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIE_H6M" \
  -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$H6M_EMAIL\",\"password\":\"$H1B_PASS\"}")
check "H6 setup 多店 staff login（TKW+MF）→ 200" "$CODE" "200"

# ── H6-T91. 同秒雙搶 → 一 200 一 409 + 留痕齊 ────────────────────────────
echo "[H6] T91: same-second double claim..."
P91="8526961${EPOCH}"; C91="h6-t91-c-${EPOCH}"; CV91="h6-t91-conv-${EPOCH}"
q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\", \"profileName\", labels) VALUES ('$C91', '$TKW_CLINIC_ID', '$P91', 'E2E H6 T91', ARRAY[]::text[])" >/dev/null 2>&1
q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", status, \"lastMessageAt\") VALUES ('$CV91', '$TKW_CLINIC_ID', '$C91', 'OPEN', '$NOWISO6')" >/dev/null 2>&1
CODE_A=$(curl -s -o /tmp/e2e-h6-t91a.json -w '%{http_code}' -b "$COOKIE_TKW" -X POST "$BASE/api/conversations/$CV91/assign" -H 'Content-Type: application/json' -d "{\"toStaffId\":\"$TKW_STAFF_ID\",\"assignVersion\":0}")
CODE_B=$(curl -s -o /tmp/e2e-h6-t91b.json -w '%{http_code}' -b "$COOKIE_H6M" -X POST "$BASE/api/conversations/$CV91/assign" -H 'Content-Type: application/json' -d "{\"toStaffId\":\"$H6M_ID\",\"assignVersion\":0}")
if { [ "$CODE_A" = 200 ] && [ "$CODE_B" = 409 ]; } || { [ "$CODE_A" = 409 ] && [ "$CODE_B" = 200 ]; }; then
  pass "H6-T91 同秒雙搶：一 200 一 409（A=$CODE_A B=$CODE_B）"
else
  fail "H6-T91 同秒雙搶（A=$CODE_A B=$CODE_B）"; H6=1
fi
LOSERR=$(grep -oE '"error":"[A-Z_]+"' /tmp/e2e-h6-t91a.json /tmp/e2e-h6-t91b.json 2>/dev/null | grep -o 'ASSIGN_CONFLICT' | head -1)
check "H6-T91 輸家 409 body = ASSIGN_CONFLICT" "$LOSERR" "ASSIGN_CONFLICT"
WINNER=$(q "SELECT \"assigneeId\"::text a FROM \"Conversation\" WHERE id='$CV91'" | jf a)
[ "$WINNER" = "$TKW_STAFF_ID" ] || [ "$WINNER" = "$H6M_ID" ] && pass "H6-T91 贏家已 assign（version 樂觀鎖生效）" || { fail "H6-T91 贏家"; H6=1; }
NOTE91=$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$CV91' AND channel='INTERNAL' AND type='note'" | jf c)
AUD91=$(q "SELECT count(*)::text c FROM \"AuditLog\" WHERE entity='Conversation' AND \"entityId\"='$CV91' AND action='TRANSFER'" | jf c)
check "H6-T91 留痕：INTERNAL note=1" "$NOTE91" "1"
check "H6-T91 留痕：AuditLog TRANSFER=1" "$AUD91" "1"

# ── H6-T92. 放手 → AI 喺病人下一句接力；舊訊息冇被補覆 ────────────────────
echo "[H6] T92: release → AI resumes on next patient message..."
patch_aimode "$TKW_CLINIC_ID" AUTO
code_pam=$PAM_CODE
check "H6-T92 TKW→AUTO" "$code_pam" "200"
q "DELETE FROM \"AutomationPolicy\" WHERE \"clinicId\"='$TKW_CLINIC_ID'" >/dev/null 2>&1  # hermetic：fallback L2
P92="8526962${EPOCH}"; C92="h6-t92-c-${EPOCH}"; CV92="h6-t92-conv-${EPOCH}"
q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\", \"profileName\", labels) VALUES ('$C92', '$TKW_CLINIC_ID', '$P92', 'E2E H6 T92', ARRAY[]::text[])" >/dev/null 2>&1
q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", status, \"lastMessageAt\") VALUES ('$CV92', '$TKW_CLINIC_ID', '$C92', 'OPEN', '$NOWISO6')" >/dev/null 2>&1
# staff-tkw 先 claim（pre-inbound — 無 race）
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_TKW" -X POST "$BASE/api/conversations/$CV92/assign" -H 'Content-Type: application/json' -d "{\"toStaffId\":\"$TKW_STAFF_ID\",\"assignVersion\":0}")
check "H6-T92 staff-tkw claim → 200" "$CODE" "200"
# 病人第一句（AI 應 assigned 閘收聲 — draft only）
WAMID92A="wamid.E2E_H6T92A_${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$P92" --text "你哋幾點開門" --wamid "$WAMID92A" --name "E2E H6 T92a" >/dev/null || fail "H6-T92a mock-inbound"
M92A=$(q "SELECT id FROM \"Message\" WHERE \"waMessageId\"='$WAMID92A'" | jf id)
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$M92A'" '[{"s":"PROPOSED"}]' 30; then
  pass "H6-T92 assigned：舊訊息只出 draft（PROPOSED）"
else
  fail "H6-T92 assigned draft"; H6=1
fi
sleep 2
OUT92A=$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$CV92' AND direction='OUT' AND channel<>'INTERNAL'" | jf c)
check "H6-T92 assigned：0 OUT（assigned 閘生效）" "$OUT92A" "0"
# 回撥超時（病人等 16m + 負責人齋 16m > default 15m）→ 手動 sweep
q "UPDATE \"Conversation\" SET \"lastInboundAt\" = now() - interval '16 minutes', \"assigneeLastActionAt\" = now() - interval '16 minutes' WHERE id='$CV92'" >/dev/null
pnpm -s e2e:cron auto-release >/dev/null 2>&1 || fail "H6-T92 e2e:cron auto-release enqueue"
if wait_for "SELECT (\"assigneeId\" IS NULL)::text u FROM \"Conversation\" WHERE id='$CV92'" '[{"u":"true"}]' 45; then
  pass "H6-T92 auto-release：超時 → 放手回隊列（assigneeId=null）"
else
  fail "H6-T92 auto-release 放手"; H6=1
fi
NOTE92REL=$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$CV92' AND channel='INTERNAL' AND type='note' AND body LIKE '系統自動放手%'" | jf c)
AUD92REL=$(q "SELECT count(*)::text c FROM \"AuditLog\" WHERE entity='Conversation' AND \"entityId\"='$CV92' AND action='UNASSIGN' AND (meta->>'by')='AUTO_RELEASE'" | jf c)
check "H6-T92 放手留痕：INTERNAL 備註=1" "$NOTE92REL" "1"
check "H6-T92 放手留痕：audit UNASSIGN by=AUTO_RELEASE" "$AUD92REL" "1"
OUT92B=$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$CV92' AND direction='OUT' AND channel<>'INTERNAL'" | jf c)
check "H6-T92 舊訊息冇被補覆（放手後、病人未再開口 → 0 OUT）" "$OUT92B" "0"
# 病人下一句 → AI 接力（auto-send）
WAMID92B="wamid.E2E_H6T92B_${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$P92" --text "你哋幾點開門" --wamid "$WAMID92B" --name "E2E H6 T92b" >/dev/null || fail "H6-T92b mock-inbound"
M92B=$(q "SELECT id FROM \"Message\" WHERE \"waMessageId\"='$WAMID92B'" | jf id)
if wait_for "SELECT (\"aiAutoSent\")::text a FROM \"Message\" WHERE \"conversationId\"='$CV92' AND direction='OUT' AND channel<>'INTERNAL'" '[{"a":"true"}]' 45; then
  pass "H6-T92 病人下一句 → AI 接力（auto-send 成功）"
else
  fail "H6-T92 AI 接力"; H6=1
fi
OUT92C=$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$CV92' AND direction='OUT' AND channel<>'INTERNAL'" | jf c)
check "H6-T92 只補覆下一句（OUT 總數=1，冇追舊訊息）" "$OUT92C" "1"

# ── H6-T93. auto-release 三防呆 + 踢中 case（一次 sweep 四案例）──────────
echo "[H6] T93: auto-release 3 foolproofs + hit case..."
mk93() { # mk93 <suffix> <patient> → 預建 + claim，echo conv id
  local suf="$1" p="$2"
  local c="h6-t93-${suf}-${EPOCH}" cv="h6-t93-${suf}conv-${EPOCH}"  # 拆兩行：set -u 下同 local 行自引用 ${suf} 會先展開後賦值 → unbound
  q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\", \"profileName\", labels) VALUES ('$c', '$TKW_CLINIC_ID', '$p', 'E2E H6 T93${suf}', ARRAY[]::text[])" >/dev/null 2>&1
  q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", status, \"lastMessageAt\") VALUES ('$cv', '$TKW_CLINIC_ID', '$c', 'OPEN', '$NOWISO6')" >/dev/null 2>&1
  # claim 重試 2 次（loadManifest flake 500 已知 — 重跑即好，唔好當 code 回歸）
  local i code
  for i in 1 2; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_TKW" -X POST "$BASE/api/conversations/$cv/assign" -H 'Content-Type: application/json' -d "{\"toStaffId\":\"$TKW_STAFF_ID\",\"assignVersion\":0}")
    [ "$code" = 200 ] && break
    sleep 2
  done
  echo "$cv"
}
CV93A=$(mk93 a "8526963${EPOCH}")
CV93B=$(mk93 b "8526964${EPOCH}")
CV93C=$(mk93 c "8526965${EPOCH}")
CV93D=$(mk93 d "8526966${EPOCH}")
# A：已覆（markRead + send → unread=0）
pnpm -s mock-inbound message --clinic TKW --from "8526963${EPOCH}" --text "你哋幾點開門" --wamid "wamid.E2E_H6T93A_${EPOCH}" --name "E2E H6 T93a" >/dev/null || true
sleep 2
curl -s -o /dev/null -b "$COOKIE_TKW" -X PATCH -H 'Content-Type: application/json' -d '{"markRead":true}' "$BASE/api/conversations/$CV93A"
curl -s -o /dev/null -b "$COOKIE_TKW" -X POST -H 'Content-Type: application/json' -d "{\"conversationId\":\"$CV93A\",\"body\":\"e2e h6 t93a reply\"}" "$BASE/api/messages/send"
q "UPDATE \"Conversation\" SET \"lastInboundAt\" = now() - interval '16 minutes' WHERE id='$CV93A'" >/dev/null
# B：病人剛到（lastInboundAt 新）+ 負責人齋 16m
pnpm -s mock-inbound message --clinic TKW --from "8526964${EPOCH}" --text "你哋幾點開門" --wamid "wamid.E2E_H6T93B_${EPOCH}" --name "E2E H6 T93b" >/dev/null || true
q "UPDATE \"Conversation\" SET \"assigneeLastActionAt\" = now() - interval '16 minutes' WHERE id='$CV93B'" >/dev/null
# C：病人等 16m 但負責人剛 claim（lastAction 新）
pnpm -s mock-inbound message --clinic TKW --from "8526965${EPOCH}" --text "你哋幾點開門" --wamid "wamid.E2E_H6T93C_${EPOCH}" --name "E2E H6 T93c" >/dev/null || true
q "UPDATE \"Conversation\" SET \"lastInboundAt\" = now() - interval '16 minutes' WHERE id='$CV93C'" >/dev/null
# D：踢中（兩邊都 16m + unread=1）
pnpm -s mock-inbound message --clinic TKW --from "8526966${EPOCH}" --text "你哋幾點開門" --wamid "wamid.E2E_H6T93D_${EPOCH}" --name "E2E H6 T93d" >/dev/null || true
sleep 3
q "UPDATE \"Conversation\" SET \"lastInboundAt\" = now() - interval '16 minutes', \"assigneeLastActionAt\" = now() - interval '16 minutes' WHERE id='$CV93D'" >/dev/null
pnpm -s e2e:cron auto-release >/dev/null 2>&1 || fail "H6-T93 e2e:cron auto-release enqueue"
if wait_for "SELECT (\"assigneeId\" IS NULL)::text u FROM \"Conversation\" WHERE id='$CV93D'" '[{"u":"true"}]' 45; then
  pass "H6-T93 踢中 case：三條件全真 → 放手"
else
  fail "H6-T93 踢中 case 放手"; H6=1
fi
# 防呆 A/B/C：全部仲係 staff-tkw
STILL_A=$(q "SELECT (\"assigneeId\"='$TKW_STAFF_ID')::text s FROM \"Conversation\" WHERE id='$CV93A'" | jf s)
STILL_B=$(q "SELECT (\"assigneeId\"='$TKW_STAFF_ID')::text s FROM \"Conversation\" WHERE id='$CV93B'" | jf s)
STILL_C=$(q "SELECT (\"assigneeId\"='$TKW_STAFF_ID')::text s FROM \"Conversation\" WHERE id='$CV93C'" | jf s)
# 瞬時 DB 查詢失敗（q 吞 stderr → 空）→ 重試一次再斷言
if [ -z "$STILL_A" ] || [ -z "$STILL_B" ] || [ -z "$STILL_C" ]; then
  sleep 2
  [ -n "$STILL_A" ] || STILL_A=$(q "SELECT (\"assigneeId\"='$TKW_STAFF_ID')::text s FROM \"Conversation\" WHERE id='$CV93A'" | jf s)
  [ -n "$STILL_B" ] || STILL_B=$(q "SELECT (\"assigneeId\"='$TKW_STAFF_ID')::text s FROM \"Conversation\" WHERE id='$CV93B'" | jf s)
  [ -n "$STILL_C" ] || STILL_C=$(q "SELECT (\"assigneeId\"='$TKW_STAFF_ID')::text s FROM \"Conversation\" WHERE id='$CV93C'" | jf s)
fi
check "H6-T93 防呆 A：已覆（unread=0）→ 唔放手" "$STILL_A" "true"
check "H6-T93 防呆 B：病人等唔夠 N → 唔放手" "$STILL_B" "true"
check "H6-T93 防呆 C：負責人冇齋夠 N → 唔放手" "$STILL_C" "true"

# ── H6-T94. 多店員工：TKW+MF 睇晒覆晒；WTC 403；default = isPrimary ──────
echo "[H6] T94: multi-clinic staff scope..."
curl -s -b "$COOKIE_H6M" -o /tmp/e2e-h6-t94.json "$BASE/api/conversations"
H6M_SCOPE=$(node -e 'try{const a=JSON.parse(require("fs").readFileSync("/tmp/e2e-h6-t94.json","utf8"));const s=new Set(a.map(x=>x.clinicId));console.log((s.has(process.argv[1])&&s.has(process.argv[2])?"ok":"missing:"+s.size))}catch{console.log("badjson")}' "$TKW_CLINIC_ID" "$MF_CLINIC_ID")
check "H6-T94 多店列表：TKW + MF 對話都見到" "$H6M_SCOPE" "ok"
# 覆兩店：TKW 用 T92 conv（unassigned），MF 用 T10 conv
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_H6M" -X POST -H 'Content-Type: application/json' -d "{\"conversationId\":\"$CV92\",\"body\":\"e2e h6 t94 tkw reply\"}" "$BASE/api/messages/send")
check "H6-T94 覆 TKW 對話 → 202" "$CODE" "202"
# MF：新預建 unassigned 對話（MF_CONV_ID 可能被前段測試 assign 過 → 423）
P94M="8526970${EPOCH}"; C94M="h6-t94m-c-${EPOCH}"; CV94M="h6-t94m-conv-${EPOCH}"
q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\", \"profileName\", labels) VALUES ('$C94M', '$MF_CLINIC_ID', '$P94M', 'E2E H6 T94M', ARRAY[]::text[])" >/dev/null 2>&1
q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", status, \"lastMessageAt\") VALUES ('$CV94M', '$MF_CLINIC_ID', '$C94M', 'OPEN', '$NOWISO6')" >/dev/null 2>&1
# 病人先開口（開 24h 窗 — 預建對話 lastInboundAt=null → 直接 send 會 422）
pnpm -s mock-inbound message --clinic MF --from "$P94M" --text "你哋幾點開門" --wamid "wamid.E2E_H6T94M_${EPOCH}" --name "E2E H6 T94M" >/dev/null || true
sleep 2
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_H6M" -X POST -H 'Content-Type: application/json' -d "{\"conversationId\":\"$CV94M\",\"body\":\"e2e h6 t94 mf reply\"}" "$BASE/api/messages/send")
check "H6-T94 覆 MF 對話 → 202" "$CODE" "202"
# WTC 對話 → 403
P94W="8526967${EPOCH}"; C94W="h6-t94w-c-${EPOCH}"; CV94W="h6-t94w-conv-${EPOCH}"
q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\", \"profileName\", labels) VALUES ('$C94W', '$WTC_CLINIC_ID', '$P94W', 'E2E H6 T94W', ARRAY[]::text[])" >/dev/null 2>&1
q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", status, \"lastMessageAt\") VALUES ('$CV94W', '$WTC_CLINIC_ID', '$C94W', 'OPEN', '$NOWISO6')" >/dev/null 2>&1
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_H6M" "$BASE/api/conversations/$CV94W")
check "H6-T94 WTC 對話（唔喺店集合）→ 403" "$CODE" "403"
# session default 店 = isPrimary（TKW）+ clinicIds 齊
H6M_SEAL=$(awk '$6=="wa_inbox_session"{print $7}' "$COOKIE_H6M" | head -1)
H6M_SESS=$(node -e "const{unsealData}=require('iron-session');const fs=require('fs');const env=fs.readFileSync('.env','utf8');const secret=(env.split('\n').find(l=>l.startsWith('SESSION_SECRET'))||'').split('=').slice(1).join('=').trim();(async()=>{try{const d=await unsealData(process.argv[1],{ttl:86400,password:secret});console.log(d&&d.clinicId===process.argv[2]&&Array.isArray(d.clinicIds)&&d.clinicIds.includes(process.argv[2])&&d.clinicIds.includes(process.argv[3])?'ok':'bad:'+JSON.stringify(d))}catch(e){console.log('unseal-fail')}})()" "$H6M_SEAL" "$TKW_CLINIC_ID" "$MF_CLINIC_ID" 2>/dev/null)
check "H6-T94 session：clinicId=TKW（isPrimary default）+ clinicIds=[TKW,MF]" "$H6M_SESS" "ok"

# ── H6-T95. 外店指派：TKW 線指派俾 WTC staff → 單線授權；轉走即失 ─────────
echo "[H6] T95: cross-clinic assign (single-line grant)..."
P95="8526968${EPOCH}"; C95="h6-t95-c-${EPOCH}"; CV95="h6-t95-conv-${EPOCH}"
q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\", \"profileName\", labels) VALUES ('$C95', '$TKW_CLINIC_ID', '$P95', 'E2E H6 T95', ARRAY[]::text[])" >/dev/null 2>&1
q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", status, \"lastMessageAt\") VALUES ('$CV95', '$TKW_CLINIC_ID', '$C95', 'OPEN', '$NOWISO6')" >/dev/null 2>&1
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_ADMIN" -X POST "$BASE/api/conversations/$CV95/assign" -H 'Content-Type: application/json' -d "{\"toStaffId\":\"$WTC_STAFF_ID\",\"assignVersion\":0}")
check "H6-T95 ADMIN 指派 TKW 線 → WTC staff（外店 target）→ 200" "$CODE" "200"
# 病人先開口（開 24h 窗 — 預建對話 lastInboundAt=null → 直接 send 會 422）
pnpm -s mock-inbound message --clinic TKW --from "$P95" --text "你哋幾點開門" --wamid "wamid.E2E_H6T95_${EPOCH}" --name "E2E H6 T95" >/dev/null || true
sleep 2
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_WTC" "$BASE/api/conversations/$CV95")
check "H6-T95 WTC staff 睇到呢條（單線授權）→ 200" "$CODE" "200"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_WTC" -X POST -H 'Content-Type: application/json' -d "{\"conversationId\":\"$CV95\",\"body\":\"e2e h6 t95 wtc reply\"}" "$BASE/api/messages/send")
check "H6-T95 WTC staff 覆到（TKW 線）→ 202" "$CODE" "202"
WAMID95=$(q "SELECT \"waMessageId\" FROM \"Message\" WHERE \"conversationId\"='$CV95' AND direction='OUT' AND channel<>'INTERNAL' ORDER BY \"createdAt\" DESC LIMIT 1" | jf waMessageId)
if [ -n "$WAMID95" ] && [ "$WAMID95" != "null" ]; then
  pass "H6-T95 發送成功（wamid 由 TKW 號碼出 — mock Graph 已收）"
else
  sleep 3
  WAMID95=$(q "SELECT \"waMessageId\" FROM \"Message\" WHERE \"conversationId\"='$CV95' AND direction='OUT' AND channel<>'INTERNAL' ORDER BY \"createdAt\" DESC LIMIT 1" | jf waMessageId)
  [ -n "$WAMID95" ] && [ "$WAMID95" != "null" ] && pass "H6-T95 發送成功（wamid 由 TKW 號碼出）" || { fail "H6-T95 發送 wamid"; H6=1; }
fi
# 其他 TKW 對話仍 403（單線授權只限嗰一條）
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_WTC" "$BASE/api/conversations/$CV91")
check "H6-T95 其他 TKW 對話 → 403（單線唔擴散）" "$CODE" "403"
# 轉走（ADMIN 改指 staff-tkw）→ 即失 access
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_ADMIN" -X POST "$BASE/api/conversations/$CV95/assign" -H 'Content-Type: application/json' -d "{\"toStaffId\":\"$TKW_STAFF_ID\",\"assignVersion\":1}")
check "H6-T95 ADMIN 轉走 → 200" "$CODE" "200"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_WTC" "$BASE/api/conversations/$CV95")
check "H6-T95 轉走後 WTC staff 即失 access → 403" "$CODE" "403"

# ── H6-T96. 外店 self-claim → 403 CROSS_CLINIC_CLAIM_FORBIDDEN ───────────
curl -s -o /tmp/e2e-h6-t96.json -b "$COOKIE_WTC" -X POST "$BASE/api/conversations/$CV95/assign" -H 'Content-Type: application/json' -d "{\"toStaffId\":\"$WTC_STAFF_ID\",\"assignVersion\":2}"
CODE=$(grep -oE '"error":"[A-Z_]+"' /tmp/e2e-h6-t96.json | head -1 | cut -d'"' -f4)
check "H6-T96 外店 self-claim → 403 CROSS_CLINIC_CLAIM_FORBIDDEN" "$CODE" "CROSS_CLINIC_CLAIM_FORBIDDEN"

# ── H6-T97. ADMIN 接手 → 發送成功（原 ASSIGNEE_INVALID 場景反轉）───────────
echo "[H6] T97: ADMIN joins + sends..."
P97="8526969${EPOCH}"; C97="h6-t97-c-${EPOCH}"; CV97="h6-t97-conv-${EPOCH}"
q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\", \"profileName\", labels) VALUES ('$C97', '$TKW_CLINIC_ID', '$P97', 'E2E H6 T97', ARRAY[]::text[])" >/dev/null 2>&1
q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", status, \"lastMessageAt\") VALUES ('$CV97', '$TKW_CLINIC_ID', '$C97', 'OPEN', '$NOWISO6')" >/dev/null 2>&1
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_TKW" -X POST "$BASE/api/conversations/$CV97/assign" -H 'Content-Type: application/json' -d "{\"toStaffId\":\"$TKW_STAFF_ID\",\"assignVersion\":0}")
check "H6-T97 staff-tkw claim → 200" "$CODE" "200"
# 病人先開口（開 24h 窗）
pnpm -s mock-inbound message --clinic TKW --from "$P97" --text "你哋幾點開門" --wamid "wamid.E2E_H6T97_${EPOCH}" --name "E2E H6 T97" >/dev/null || true
sleep 2
# ADMIN 接手（target = ADMIN 自己 — 舊同店檢查會 ASSIGNEE_INVALID 嘅場景）
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_ADMIN" -X POST "$BASE/api/conversations/$CV97/assign" -H 'Content-Type: application/json' -d "{\"toStaffId\":\"$ADMIN_STAFF_ID\",\"assignVersion\":1}")
check "H6-T97 ADMIN 接手（target=ADMIN）→ 200" "$CODE" "200"
# 接手後 ADMIN 覆 → 成功（MD §7 T97：ADMIN 接手 → 發送成功）
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_ADMIN" -X POST -H 'Content-Type: application/json' -d "{\"conversationId\":\"$CV97\",\"body\":\"e2e h6 t97 admin send\"}" "$BASE/api/messages/send")
check "H6-T97 接手後 ADMIN 覆 → 202（MD T97 場景）" "$CODE" "202"
# ADMIN 放手（release）
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_ADMIN" -X POST "$BASE/api/conversations/$CV97/assign" -H 'Content-Type: application/json' -d "{\"toStaffId\":null,\"assignVersion\":2}")
check "H6-T97 ADMIN 放手 → 200" "$CODE" "200"
REL97=$(q "SELECT (\"assigneeId\" IS NULL)::text u FROM \"Conversation\" WHERE id='$CV97'" | jf u)
check "H6-T97 放手後 assigneeId=null" "$REL97" "true"

# ── H6-T98. 舊 session（無 clinicIds）→ fallback 單店行為不變 ─────────────
echo "[H6] T98: legacy session fallback..."
OLDSEAL=$(node -e "const{sealData}=require('iron-session');const fs=require('fs');const env=fs.readFileSync('.env','utf8');const secret=(env.split('\n').find(l=>l.startsWith('SESSION_SECRET'))||'').split('=').slice(1).join('=').trim();(async()=>{const s=await sealData({staffId:process.argv[1],email:process.argv[2],name:'E2E H6 Old',role:'STAFF',clinicId:process.argv[3],loginAt:Date.now()-3600e3},{ttl:86400,password:secret});process.stdout.write(s)})()" "$TKW_STAFF_ID" "$TKW_EMAIL" "$TKW_CLINIC_ID" 2>/dev/null)
COOKIE_OLD=/tmp/e2e-cookie-h6old.txt
printf '#HttpOnly_127.0.0.1\tFALSE\t/\tFALSE\t%s\twa_inbox_session\t%s\n' "$(( $(date +%s) + 86400 ))" "$OLDSEAL" > "$COOKIE_OLD"
curl -s -b "$COOKIE_OLD" -o /tmp/e2e-h6-t98.json "$BASE/api/conversations"
H6T98=$(node -e 'try{const a=JSON.parse(require("fs").readFileSync("/tmp/e2e-h6-t98.json","utf8"));console.log(Array.isArray(a)&&a.some(x=>x.id===process.argv[1])&&!a.some(x=>x.id===process.argv[2])?"ok":"bad")}catch{console.log("badjson")}' "$CV91" "$MF_CONV_ID")
check "H6-T98 舊 session 列表：TKW 見到 + MF 唔見（fallback 單店）" "$H6T98" "ok"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_OLD" "$BASE/api/conversations/$MF_CONV_ID")
check "H6-T98 舊 session GET MF 對話 → 403（行為同舊單店一致）" "$CODE" "403"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_OLD" "$BASE/api/conversations/$CV91")
check "H6-T98 舊 session GET TKW 對話 → 200" "$CODE" "200"

# ── H6-T99. 內部備註卡：兩 staff 見到 + 已讀 receipt + canary（唔入 AI prompt）─
echo "[H6] T99: internal notes card + canary..."
CODE=$(curl -s -o /tmp/e2e-h6-t99.json -w '%{http_code}' -b "$COOKIE_TKW" -X POST "$BASE/api/conversations/$CV91/notes" -H 'Content-Type: application/json' -d '{"body":"e2e H6 T99 canary：該患者曾投訴服務態度，注意處理"}')
check "H6-T99 加備註 → 201" "$CODE" "201"
NOTE99=$(grep -oE '"messageId":"[^"]*"' /tmp/e2e-h6-t99.json | head -1 | cut -d'"' -f4)
[ -n "$NOTE99" ] && pass "H6-T99 note messageId 回傳" || { fail "H6-T99 note id"; H6=1; }
curl -s -b "$COOKIE_H6M" -o /tmp/e2e-h6-t99msg.json "$BASE/api/conversations/$CV91/messages?limit=100"
H6T99VIS=$(grep -c "e2e H6 T99 canary" /tmp/e2e-h6-t99msg.json)
[ "$H6T99VIS" -ge 1 ] && pass "H6-T99 第二個 staff（h6m）見到備註" || { fail "H6-T99 備註可見性"; H6=1; }
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_H6M" -X POST "$BASE/api/notes/$NOTE99/read")
check "H6-T99 已讀 receipt POST → 200" "$CODE" "200"
curl -s -b "$COOKIE_H6M" -o /tmp/e2e-h6-t99rc.json "$BASE/api/conversations/$CV91/note-read-receipts"
H6T99RC=$(node -e 'try{const j=JSON.parse(require("fs").readFileSync("/tmp/e2e-h6-t99rc.json","utf8"));console.log((j.receipts||[]).some(r=>r.messageId===process.argv[1]&&r.staffId===process.argv[2])?"ok":"bad")}catch{console.log("badjson")}' "$NOTE99" "$H6M_ID")
check "H6-T99 receipt 落庫（GET 見到 h6m 已讀）" "$H6T99RC" "ok"
# canary（沿用 T88 法）：備註含「投訴」→ 病人下條 QUESTION 唔被污染
WAMID99="wamid.E2E_H6T99_${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$P91" --text "你哋幾點開門" --wamid "$WAMID99" --name "E2E H6 T99 canary" >/dev/null || fail "H6-T99 canary mock-inbound"
M99=$(q "SELECT id FROM \"Message\" WHERE \"waMessageId\"='$WAMID99'" | jf id)
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$M99'" '[{"s":"PROPOSED"}]' 30; then
  pass "H6-T99 canary：QUESTION draft 照出（PROPOSED）"
else
  fail "H6-T99 canary draft"; H6=1
fi
sleep 2
check "H6-T99 canary：intent = QUESTION（備註「投訴」唔污染分類）" "$(q "SELECT \"intent\"::text i FROM \"Conversation\" WHERE id='$CV91'" | jf i)" "QUESTION"
check "H6-T99 canary：零 HANDOFF_REQUEST（COMPLAINT 軌未誤觸）" "$(q "SELECT count(*)::text c FROM \"StaffNotice\" WHERE \"conversationId\"='$CV91' AND kind='HANDOFF_REQUEST'" | jf c)" "0"

# ── H6-MC cwi-multiclinic-20260903（B3）：Part A 缺口補齊斷言（clinicName / crossClinic / UI 四場景）──
# 前置：H6 fixture（H6M 多店 staff + cookies）已建；T99 之後、H6 cleanup 之前。
echo "[H6-MC] cwi-multiclinic-20260903 B3: clinicName/crossClinic/UI..."
MC=0
# TKW 先還 DRAFT（T92 置 AUTO 做接力測試）— 防 AI auto-OUT 爭「待跟進」badge 斷言
patch_aimode "$TKW_CLINIC_ID" DRAFT
code_mc_pam=$PAM_CODE
check "H6-MC setup TKW→DRAFT" "$code_mc_pam" "200"

# fixtures：R/M/423/F/X = TKW、W = WTC（固定 id + EPOCH 冪等；零 PII；profileName = UI 斷言搜字）
WTC_CLINIC_NAME=$(q "SELECT name::text name FROM \"Clinic\" WHERE id='$WTC_CLINIC_ID'" | jf name)
TKW_CLINIC_NAME=$(q "SELECT name::text name FROM \"Clinic\" WHERE id='$TKW_CLINIC_ID'" | jf name)
TKW_STAFF_NAME=$(q "SELECT name::text name FROM \"StaffUser\" WHERE id='$TKW_STAFF_ID'" | jf name)
WTC_STAFF_NAME=$(q "SELECT name::text name FROM \"StaffUser\" WHERE id='$WTC_STAFF_ID'" | jf name)
Q_MC_R="8526971${EPOCH}"; C_MC_R="h6mc-r-c-${EPOCH}"; CV_MC_R="h6mc-r-conv-${EPOCH}"
Q_MC_M="8526972${EPOCH}"; C_MC_M="h6mc-m-c-${EPOCH}"; CV_MC_M="h6mc-m-conv-${EPOCH}"
Q_MC_4="8526973${EPOCH}"; C_MC_4="h6mc-423-c-${EPOCH}"; CV_MC_4="h6mc-423-conv-${EPOCH}"
Q_MC_F="8526974${EPOCH}"; C_MC_F="h6mc-f-c-${EPOCH}"; CV_MC_F="h6mc-f-conv-${EPOCH}"
Q_MC_W="8526975${EPOCH}"; C_MC_W="h6mc-w-c-${EPOCH}"; CV_MC_W="h6mc-w-conv-${EPOCH}"
Q_MC_X="8526976${EPOCH}"; C_MC_X="h6mc-x-c-${EPOCH}"; CV_MC_X="h6mc-x-conv-${EPOCH}"
Q_MC_W2="8526977${EPOCH}"; C_MC_W2="h6mc-w2-c-${EPOCH}"; CV_MC_W2="h6mc-w2-conv-${EPOCH}"
q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\", \"profileName\", labels) VALUES ('$C_MC_R', '$TKW_CLINIC_ID', '$Q_MC_R', 'E2E MC R', ARRAY[]::text[]) ON CONFLICT (id) DO NOTHING" >/dev/null 2>&1
q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\", \"profileName\", labels) VALUES ('$C_MC_M', '$TKW_CLINIC_ID', '$Q_MC_M', 'E2E MC M', ARRAY[]::text[]) ON CONFLICT (id) DO NOTHING" >/dev/null 2>&1
q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\", \"profileName\", labels) VALUES ('$C_MC_4', '$TKW_CLINIC_ID', '$Q_MC_4', 'E2E MC 423', ARRAY[]::text[]) ON CONFLICT (id) DO NOTHING" >/dev/null 2>&1
q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\", \"profileName\", labels) VALUES ('$C_MC_F', '$TKW_CLINIC_ID', '$Q_MC_F', 'E2E MC F', ARRAY[]::text[]) ON CONFLICT (id) DO NOTHING" >/dev/null 2>&1
q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\", \"profileName\", labels) VALUES ('$C_MC_W', '$WTC_CLINIC_ID', '$Q_MC_W', 'E2E MC WTC', ARRAY[]::text[]) ON CONFLICT (id) DO NOTHING" >/dev/null 2>&1
q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\", \"profileName\", labels) VALUES ('$C_MC_X', '$TKW_CLINIC_ID', '$Q_MC_X', 'E2E MC X', ARRAY[]::text[]) ON CONFLICT (id) DO NOTHING" >/dev/null 2>&1
q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\", \"profileName\", labels) VALUES ('$C_MC_W2', '$WTC_CLINIC_ID', '$Q_MC_W2', 'E2E MC W2', ARRAY[]::text[]) ON CONFLICT (id) DO NOTHING" >/dev/null 2>&1
# 交付證明：raw INSERT 靜默失敗防線（q() 吞 stderr）— 7 contact + 7 conv 必齊
MC_NCONTACT=$(q "SELECT count(*)::text n FROM \"Contact\" WHERE id IN ('$C_MC_R','$C_MC_M','$C_MC_4','$C_MC_F','$C_MC_W','$C_MC_X','$C_MC_W2')" | jf n)
check "H6-MC fixture：7 contact 入庫（靜默失敗防線）" "$MC_NCONTACT" "7"
q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", status, \"lastMessageAt\") VALUES ('$CV_MC_R', '$TKW_CLINIC_ID', '$C_MC_R', 'OPEN', '$NOWISO6') ON CONFLICT (id) DO NOTHING" >/dev/null 2>&1
q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", status, \"lastMessageAt\") VALUES ('$CV_MC_M', '$TKW_CLINIC_ID', '$C_MC_M', 'OPEN', '$NOWISO6') ON CONFLICT (id) DO NOTHING" >/dev/null 2>&1
q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", status, \"lastMessageAt\") VALUES ('$CV_MC_4', '$TKW_CLINIC_ID', '$C_MC_4', 'OPEN', '$NOWISO6') ON CONFLICT (id) DO NOTHING" >/dev/null 2>&1
q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", status, \"lastMessageAt\") VALUES ('$CV_MC_F', '$TKW_CLINIC_ID', '$C_MC_F', 'OPEN', '$NOWISO6') ON CONFLICT (id) DO NOTHING" >/dev/null 2>&1
q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", status, \"lastMessageAt\") VALUES ('$CV_MC_W', '$WTC_CLINIC_ID', '$C_MC_W', 'OPEN', '$NOWISO6') ON CONFLICT (id) DO NOTHING" >/dev/null 2>&1
q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", status, \"lastMessageAt\") VALUES ('$CV_MC_X', '$TKW_CLINIC_ID', '$C_MC_X', 'OPEN', '$NOWISO6') ON CONFLICT (id) DO NOTHING" >/dev/null 2>&1
q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", status, \"lastMessageAt\") VALUES ('$CV_MC_W2', '$WTC_CLINIC_ID', '$C_MC_W2', 'OPEN', '$NOWISO6') ON CONFLICT (id) DO NOTHING" >/dev/null 2>&1
MC_NCONV=$(q "SELECT count(*)::text n FROM \"Conversation\" WHERE id IN ('$CV_MC_R','$CV_MC_M','$CV_MC_4','$CV_MC_F','$CV_MC_W','$CV_MC_W2','$CV_MC_X')" | jf n)
check "H6-MC fixture：7 conv 入庫（靜默失敗防線）" "$MC_NCONV" "7"

# ── H6-MC-1. list：外店指派線（OR path）可見 + clinicName；外店未指派線唔見（T1.1）──
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_ADMIN" -X POST "$BASE/api/conversations/$CV_MC_W/assign" -H 'Content-Type: application/json' -d "{\"toStaffId\":\"$H6M_ID\",\"assignVersion\":0}")
check "H6-MC-1 setup: ADMIN 指派 WTC 線 → H6M（外店 staff）→ 200" "$CODE" "200"
curl -s -b "$COOKIE_H6M" -o /tmp/e2e-mc-list.json "$BASE/api/conversations"
MC_LIST=$(node -e 'try{const a=JSON.parse(require("fs").readFileSync("/tmp/e2e-mc-list.json","utf8"));const w=a.find(x=>x.id===process.argv[1]);const x=a.find(x=>x.id===process.argv[2]);const r=a.find(x=>x.id===process.argv[3]);console.log(w&&w.clinicName===process.argv[4]&&!x&&r&&r.clinicName===process.argv[5]?"ok":"bad:"+JSON.stringify({w:w&&{cn:w.clinicName},x:!!x,r:r&&{cn:r.clinicName}}))}catch{console.log("badjson")}' "$CV_MC_W" "$CV_MC_W2" "$CV_MC_R" "$WTC_CLINIC_NAME" "$TKW_CLINIC_NAME")
check "H6-MC-1 H6M list：WTC 指派線可見（OR path）+ clinicName=店名 + 外店未指派線唔見" "$MC_LIST" "ok"
# MD A.3 clinic-tab 語義：STAFF 睇自己店 tab（?clinicId=）時，跨店指派自己嘅線仍要可見；外店未指派線依然唔見
curl -s -b "$COOKIE_H6M" -o /tmp/e2e-mc-list-para.json "$BASE/api/conversations?clinicId=$TKW_CLINIC_ID"
MC_LISTP=$(node -e 'try{const a=JSON.parse(require("fs").readFileSync("/tmp/e2e-mc-list-para.json","utf8"));const w=a.find(x=>x.id===process.argv[1]);const w2=a.find(x=>x.id===process.argv[2]);const r=a.find(x=>x.id===process.argv[3]);console.log(w&&w.clinicName===process.argv[4]&&!w2&&r?"ok":"bad:"+JSON.stringify({w:!!w,w2:!!w2,r:!!r}))}catch{console.log("badjson")}' "$CV_MC_W" "$CV_MC_W2" "$CV_MC_R" "$WTC_CLINIC_NAME")
check "H6-MC-1 H6M list?clinicId=TKW：跨店指派線仍可見（clinic-tab OR 語義）+ 外店未指派線仍唔見" "$MC_LISTP" "ok"

# ── H6-MC-2. crossClinic audit meta（T1.2：from=TKW staff → to=WTC staff）──
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_TKW" -X POST "$BASE/api/conversations/$CV_MC_X/assign" -H 'Content-Type: application/json' -d "{\"toStaffId\":\"$TKW_STAFF_ID\",\"assignVersion\":0}")
check "H6-MC-2 setup: staff-tkw claim TKW 線 → 200" "$CODE" "200"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_ADMIN" -X POST "$BASE/api/conversations/$CV_MC_X/assign" -H 'Content-Type: application/json' -d "{\"toStaffId\":\"$WTC_STAFF_ID\",\"assignVersion\":1}")
check "H6-MC-2 ADMIN 跨店 takeover（TKW staff → WTC staff）→ 200" "$CODE" "200"
MC_XC=$(q "SELECT count(*)::text c FROM \"AuditLog\" WHERE entity='Conversation' AND \"entityId\"='$CV_MC_X' AND action='TRANSFER' AND (meta->>'crossClinic')='true' AND (meta->>'takeover')='true'" | jf c)
check "H6-MC-2 audit meta：crossClinic:true + takeover:true" "$MC_XC" "1"
MC_XNOTE=$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$CV_MC_X' AND channel='INTERNAL' AND type='note' AND body LIKE '%· 由 %'" | jf c)
check "H6-MC-2 takeover note 含「· 由 {店名}」" "$MC_XNOTE" "1"

# ── H6-MC-UI. 四場景瀏覽器斷言（e2e-multiclinic-ui.ts；每次一 browser）──────
# UI fixtures：R → H6M 接手（release 用）；423/F → 病人開口（開窗 + 待跟進狀態）
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_ADMIN" -X POST "$BASE/api/conversations/$CV_MC_R/assign" -H 'Content-Type: application/json' -d "{\"toStaffId\":\"$H6M_ID\",\"assignVersion\":0}")
check "H6-MC-UI setup: R 線 → H6M（release 前態）→ 200" "$CODE" "200"
pnpm -s mock-inbound message --clinic TKW --from "$Q_MC_4" --text "你哋幾點開門" --wamid "wamid.E2E_MC423_${EPOCH}" --name "E2E MC 423" >/dev/null || fail "H6-MC-UI mock-inbound 423"
pnpm -s mock-inbound message --clinic TKW --from "$Q_MC_F" --text "你哋幾點開門" --wamid "wamid.E2E_MCF_${EPOCH}" --name "E2E MC F" >/dev/null || fail "H6-MC-UI mock-inbound F"
# 確定性 gate：F 線待跟進條件必真（lastInboundAt >= lastMessageAt）先放 browser
if ! wait_for "SELECT (\"lastInboundAt\" >= \"lastMessageAt\")::text f FROM \"Conversation\" WHERE id='$CV_MC_F'" '[{"f":"true"}]' 30; then
  fail "H6-MC-UI F 線待跟進條件未達（lastInboundAt < lastMessageAt）"; MC=1
fi
# dev loadManifest race（已知 flake：JS chunk 500 → 整頁無 hydrate → dead click）— 預熱 /inbox（H6M STAFF 視圖）確保 client chunk 已編譯
for i in 1 2 3; do
  PW=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_H6M" "$BASE/inbox")
  [ "$PW" = "200" ] && break
  sleep 3
done
sleep 2

# UI-1 badges：跨店線店名 badge（WTC 線有 / 本店線無）+ 待跟進 badge（覆咗消失）
MCUI_OUT=$(pnpm -s e2e:multiclinic-ui --scenario badges --base "$BASE" --cookie "$COOKIE_H6M" \
  --conv-follower "$CV_MC_F" --conv-wtc "$CV_MC_W" --clinic-wtc-code WTC 2>&1)
echo "$MCUI_OUT" | grep -E "MCUI-(OK|FAIL)" | sed 's/^/  [UI] /'
echo "$MCUI_OUT" > /tmp/e2e-mcui-badges.log
echo "$MCUI_OUT" | grep -q "MCUI-OK badges" && pass "H6-MC-UI badges：跨店店名 badge + 待跟進 badge（覆咗消失）" || { fail "H6-MC-UI badges（見 /tmp/e2e-mcui-badges.log）"; MC=1; }

# UI-2 release：現任負責人 header〔放手〕（兩段確認）→ 負責人 chip 消失 + toast
MCUI_OUT=$(pnpm -s e2e:multiclinic-ui --scenario release --base "$BASE" --cookie "$COOKIE_H6M" \
  --conv-release "$CV_MC_R" 2>&1)
echo "$MCUI_OUT" | grep -E "MCUI-(OK|FAIL)" | sed 's/^/  [UI] /'
echo "$MCUI_OUT" > /tmp/e2e-mcui-release.log
echo "$MCUI_OUT" | grep -q "MCUI-OK release" && pass "H6-MC-UI release：放手掣兩段確認 → 放返隊列" || { fail "H6-MC-UI release（見 /tmp/e2e-mcui-release.log）"; MC=1; }

# UI-3 send423：打緊字時 staff-tkw 接手 → composer 文字保留 + toast + header 即時更新
MCUI_OUT=$(pnpm -s e2e:multiclinic-ui --scenario send423 --base "$BASE" \
  --cookie "$COOKIE_H6M" --cookie2 "$COOKIE_TKW" --conv-423 "$CV_MC_4" \
  --staff-tkw-id "$TKW_STAFF_ID" --staff-tkw-name "$TKW_STAFF_NAME" 2>&1)
echo "$MCUI_OUT" | grep -E "MCUI-(OK|FAIL)" | sed 's/^/  [UI] /'
echo "$MCUI_OUT" > /tmp/e2e-mcui-423.log
echo "$MCUI_OUT" | grep -q "MCUI-OK send423" && pass "H6-MC-UI send423：composer 保留 + toast + header 即時更新" || { fail "H6-MC-UI send423（見 /tmp/e2e-mcui-423.log）"; MC=1; }

# UI-4 menu：二級指派選單（其他分店… → WTC → staff）+ 跨店 confirm 文案
MCUI_OUT=$(pnpm -s e2e:multiclinic-ui --scenario menu --base "$BASE" --cookie "$COOKIE_ADMIN" \
  --conv-menu "$CV_MC_M" --staff-wtc-name "$WTC_STAFF_NAME" --clinic-wtc-code WTC 2>&1)
echo "$MCUI_OUT" | grep -E "MCUI-(OK|FAIL)" | sed 's/^/  [UI] /'
echo "$MCUI_OUT" > /tmp/e2e-mcui-menu.log
echo "$MCUI_OUT" | grep -q "MCUI-OK menu" && pass "H6-MC-UI menu：二級選單 + 跨店 confirm 文案" || { fail "H6-MC-UI menu（見 /tmp/e2e-mcui-menu.log）"; MC=1; }

# ── H6-MC cleanup（hermetic）──
q "DELETE FROM \"AiDraft\" WHERE \"conversationId\" IN ('$CV_MC_R','$CV_MC_M','$CV_MC_4','$CV_MC_F','$CV_MC_W','$CV_MC_W2','$CV_MC_X')" >/dev/null 2>&1
q "DELETE FROM \"NoteReadReceipt\" WHERE \"messageId\" IN (SELECT id FROM \"Message\" WHERE \"conversationId\" IN ('$CV_MC_R','$CV_MC_M','$CV_MC_4','$CV_MC_F','$CV_MC_W','$CV_MC_W2','$CV_MC_X'))" >/dev/null 2>&1
q "DELETE FROM \"Message\" WHERE \"conversationId\" IN ('$CV_MC_R','$CV_MC_M','$CV_MC_4','$CV_MC_F','$CV_MC_W','$CV_MC_W2','$CV_MC_X')" >/dev/null 2>&1
q "DELETE FROM \"StaffNotice\" WHERE \"conversationId\" IN ('$CV_MC_R','$CV_MC_M','$CV_MC_4','$CV_MC_F','$CV_MC_W','$CV_MC_W2','$CV_MC_X')" >/dev/null 2>&1
q "DELETE FROM \"Conversation\" WHERE id IN ('$CV_MC_R','$CV_MC_M','$CV_MC_4','$CV_MC_F','$CV_MC_W','$CV_MC_W2','$CV_MC_X')" >/dev/null 2>&1
q "DELETE FROM \"Contact\" WHERE id IN ('$C_MC_R','$C_MC_M','$C_MC_4','$C_MC_F','$C_MC_W','$C_MC_W2','$C_MC_X')" >/dev/null 2>&1
for QP in "$Q_MC_R" "$Q_MC_M" "$Q_MC_4" "$Q_MC_F" "$Q_MC_W" "$Q_MC_W2" "$Q_MC_X"; do
  q "DELETE FROM \"Message\" WHERE \"conversationId\" IN (SELECT id FROM \"Conversation\" WHERE \"contactId\" IN (SELECT id FROM \"Contact\" WHERE \"waId\"='$QP'))" >/dev/null 2>&1
  q "DELETE FROM \"Conversation\" WHERE \"contactId\" IN (SELECT id FROM \"Contact\" WHERE \"waId\"='$QP')" >/dev/null 2>&1
  q "DELETE FROM \"Contact\" WHERE \"waId\"='$QP'" >/dev/null 2>&1
done
[ "$MC" = 0 ] && pass "H6-MC cwi-multiclinic-20260903 缺口補齊 e2e（clinicName/crossClinic/UI×4）" || fail "H6-MC 有項失敗（見上 ❌）"

# ── H6 cleanup（hermetic：fixture staff / policy / aiMode / 對話全清）─────
q "DELETE FROM \"AiDraft\" WHERE \"conversationId\" IN ('$CV91','$CV92','$CV93A','$CV93B','$CV93C','$CV93D','$CV94W','$CV94M','$CV95','$CV97')" >/dev/null 2>&1
q "DELETE FROM \"NoteReadReceipt\" WHERE \"messageId\" IN (SELECT id FROM \"Message\" WHERE \"conversationId\" IN ('$CV91','$CV92','$CV93A','$CV93B','$CV93C','$CV93D','$CV94W','$CV94M','$CV95','$CV97'))" >/dev/null 2>&1
q "DELETE FROM \"Message\" WHERE \"conversationId\" IN ('$CV91','$CV92','$CV93A','$CV93B','$CV93C','$CV93D','$CV94W','$CV94M','$CV95','$CV97')" >/dev/null 2>&1
q "DELETE FROM \"StaffNotice\" WHERE \"conversationId\" IN ('$CV91','$CV92','$CV93A','$CV93B','$CV93C','$CV93D','$CV94W','$CV94M','$CV95','$CV97')" >/dev/null 2>&1
q "DELETE FROM \"Conversation\" WHERE id IN ('$CV91','$CV92','$CV93A','$CV93B','$CV93C','$CV93D','$CV94W','$CV94M','$CV95','$CV97')" >/dev/null 2>&1
q "DELETE FROM \"Contact\" WHERE id IN ('$C91','$C92','h6-t93-a-${EPOCH}','h6-t93-b-${EPOCH}','h6-t93-c-${EPOCH}','h6-t93-d-${EPOCH}','$C94W','$C94M','$C95','$C97')" >/dev/null 2>&1
# waId sweep（兜底：mk93 失敗時 inbound worker 自建嘅 contact/conv 殘留 — 跟 waId 洗先洗到齊）
for P9 in "8526963${EPOCH}" "8526964${EPOCH}" "8526965${EPOCH}" "8526966${EPOCH}"; do
  q "DELETE FROM \"AiDraft\" WHERE \"conversationId\" IN (SELECT id FROM \"Conversation\" WHERE \"contactId\" IN (SELECT id FROM \"Contact\" WHERE \"waId\"='$P9' AND \"clinicId\"='$TKW_CLINIC_ID'))" >/dev/null 2>&1
  q "DELETE FROM \"Message\" WHERE \"conversationId\" IN (SELECT id FROM \"Conversation\" WHERE \"contactId\" IN (SELECT id FROM \"Contact\" WHERE \"waId\"='$P9' AND \"clinicId\"='$TKW_CLINIC_ID'))" >/dev/null 2>&1
  q "DELETE FROM \"StaffNotice\" WHERE \"conversationId\" IN (SELECT id FROM \"Conversation\" WHERE \"contactId\" IN (SELECT id FROM \"Contact\" WHERE \"waId\"='$P9' AND \"clinicId\"='$TKW_CLINIC_ID'))" >/dev/null 2>&1
  q "DELETE FROM \"Conversation\" WHERE \"contactId\" IN (SELECT id FROM \"Contact\" WHERE \"waId\"='$P9' AND \"clinicId\"='$TKW_CLINIC_ID')" >/dev/null 2>&1
  q "DELETE FROM \"Contact\" WHERE \"waId\"='$P9' AND \"clinicId\"='$TKW_CLINIC_ID'" >/dev/null 2>&1
done
q "DELETE FROM \"AutomationPolicy\" WHERE \"clinicId\"='$TKW_CLINIC_ID'" >/dev/null 2>&1
patch_aimode "$TKW_CLINIC_ID" DRAFT
pnpm -s e2e:staff delete --email "$H6M_EMAIL" >/dev/null 2>&1 || echo "    WARN: H6M staff delete fail（留意殘留）"
H6M_RESID=$(q "SELECT count(*)::text c FROM \"StaffUser\" WHERE email='$H6M_EMAIL'" | jf c)
check "H6 cleanup：fixture staff 零殘留" "$H6M_RESID" "0"
[ "$H6" = 0 ] && pass "H6 cwi-h6-20260830 全鏈 e2e（H6-T91–T99）" || fail "H6 有項失敗（見上 ❌）"

# ── SCHED. cwi-sched-20260901 T150–T156（醫生時間表合併重做）────────────────
echo "[SCHED] T150-T156: doctor schedule merged e2e..."
SCHED_FAIL=0
SCHED_TODAY=$(TZ=Asia/Hong_Kong date +%F)

# T150 週視圖：每日當值 + 醫生名 + 席數；>3 醫生收埋「+N 位」（extra-providers mock flag）
printf '[{"clinicCode":"TKW","extra":2}]' > .dev/workforce-mock-extra-providers.json
CODE150=$(curl -s -o /tmp/e2e-sched-t150.html -w '%{http_code}' -b "$COOKIE_ADMIN" "$BASE/schedule?clinic=TKW")
check "T150 週視圖 → 200" "$CODE150" "200"
grep -qF "當值：" /tmp/e2e-sched-t150.html && pass "T150 當值副標題" || { fail "T150 當值副標題缺失"; SCHED_FAIL=1; }
grep -qF "mock 陳醫師" /tmp/e2e-sched-t150.html && pass "T150 醫生名" || { fail "T150 醫生名缺失"; SCHED_FAIL=1; }
grep -qE "[0-9]+ 席" /tmp/e2e-sched-t150.html && pass "T150 剩餘席數" || { fail "T150 席數缺失"; SCHED_FAIL=1; }
# ★ React SSR 喺 expression/text 之間插 <!-- --> 分隔（`+{N} 位…` = 3 個 text node）
#   raw grep "​+1 位" 假紅 — 先 strip 先 grep（a2 2026-09-01 實測）
sed 's/<!-- -->//g' /tmp/e2e-sched-t150.html | grep -qF "+1 位只開診冇預約" && pass "T150 >3 醫生收埋（+1）" || { fail "T150 >3 收埋缺失（4 醫生未出）"; SCHED_FAIL=1; }
rm -f .dev/workforce-mock-extra-providers.json

# T152 前置：mock held flag（TKW 今日 10:00–11:00 mock-pract-TKW-0 HELD → 日視圖 已佔 格）
printf '[{"holdId":"sched-t152-hold","clinicCode":"TKW","providerId":"mock-pract-TKW-0","providerName":"mock 陳醫師","date":"%s","startMin":600,"endMin":660,"status":"HELD","source":"e2e_flag","createdAt":"%sT00:00:00.000Z","ageHours":0,"appointmentPast":false}]' "$SCHED_TODAY" "$SCHED_TODAY" > .dev/workforce-mock-held.json

# T151 + T152 + T156 + D.1–D.4（T180–T186）browser-level — playwright-core
SCHED_UI_OUT=$(pnpm -s e2e:schedule-ui --base "$BASE" --cookie "$COOKIE_ADMIN" --log /tmp/e2e-server.log 2>&1)
# a2：UI 失敗 reason 之前被吞（只 grep OK marker）— 落檔 + echo 埋主 log（diagnose 用）
echo "$SCHED_UI_OUT" > /tmp/e2e-sched-ui-out.log
echo "$SCHED_UI_OUT" | grep -E "SCHED-T15|WARMUP" | sed 's/^/  [UI] /'
echo "$SCHED_UI_OUT" | grep -q "SCHED-T151-OK" && pass "T151 揀診所 → 真 fetch + URL 同步（週+日）" || { fail "T151 揀診所 fetch/URL（見 SCHED-T151 行）"; SCHED_FAIL=1; }
echo "$SCHED_UI_OUT" | grep -q "SCHED-T152-OK" && pass "T152 日格→日視圖 + chips + 48 格四態" || { fail "T152 日視圖（見 SCHED-T152 行）"; SCHED_FAIL=1; }
echo "$SCHED_UI_OUT" | grep -q "SCHED-T156-OK" && pass "T156 更新掣 7 日/1 日 + 429/409 UI" || { fail "T156 更新掣（見 SCHED-T156 行）"; SCHED_FAIL=1; }
# D（cwi-schedv2-20260903）：T180–T186 瀏覽器斷言（同一 script 擴充）
echo "$SCHED_UI_OUT" | grep -E "SCHED-T18" | sed 's/^/  [UI] /'
echo "$SCHED_UI_OUT" | grep -q "SCHED-T180-OK" && pass "T180 今日 auto-scroll + 淡化 + 摺疊 + 而家線 + 60s tick" || { fail "T180 見 SCHED-T180 行"; SCHED_FAIL=1; }
echo "$SCHED_UI_OUT" | grep -q "SCHED-T181-OK" && pass "T181 非今日冇而家線/淡化" || { fail "T181 見 SCHED-T181 行"; SCHED_FAIL=1; }
echo "$SCHED_UI_OUT" | grep -q "SCHED-T182-OK" && pass "T182 capacity fallback warn（每 process 每 key 一次）" || { fail "T182 見 SCHED-T182 行"; SCHED_FAIL=1; }
echo "$SCHED_UI_OUT" | grep -q "SCHED-T183-OK" && pass "T183 日視圖 popover 搜病人 → Flow prefill" || { fail "T183 見 SCHED-T183 行"; SCHED_FAIL=1; }
echo "$SCHED_UI_OUT" | grep -q "SCHED-T184-OK" && pass "T184 側欄迷你表撳格直接發 Flow" || { fail "T184 見 SCHED-T184 行"; SCHED_FAIL=1; }
echo "$SCHED_UI_OUT" | grep -q "SCHED-T185-OK" && pass "T185 過窗改三出路（popover + 側欄）" || { fail "T185 見 SCHED-T185 行"; SCHED_FAIL=1; }
echo "$SCHED_UI_OUT" | grep -q "SCHED-T186-OK" && pass "T186 迷你表 ≤10 行 + >3 醫生橫捲" || { fail "T186 見 SCHED-T186 行"; SCHED_FAIL=1; }
# T187：迴歸總 gate（in-script T151/T152/T156 + 本段 curl T150/T153/T154/T155 全綠）
echo "$SCHED_UI_OUT" | grep -q "SCHED-UI-OK" && pass "T187 T150–T156 全迴歸（script SCHED-UI-OK）" || { fail "T187 迴歸未全綠（見 SCHED-UI-FAIL 行）"; SCHED_FAIL=1; }
rm -f .dev/workforce-mock-held.json .dev/workforce-mock-refresh-429.json .dev/workforce-mock-refresh-409.json

# T153 文案：頁面唔再出現「可出」（週 + 日兩 view）
curl -s -o /tmp/e2e-sched-t153w.html -b "$COOKIE_ADMIN" "$BASE/schedule?clinic=TKW"
curl -s -o /tmp/e2e-sched-t153d.html -b "$COOKIE_ADMIN" "$BASE/schedule?clinic=TKW&view=day&date=$SCHED_TODAY"
if grep -q "可出" /tmp/e2e-sched-t153w.html /tmp/e2e-sched-t153d.html; then
  fail "T153 頁面仍出現「可出」（$(grep -c "可出" /tmp/e2e-sched-t153w.html /tmp/e2e-sched-t153d.html | tr '\n' ' ')）"
  SCHED_FAIL=1
else
  pass "T153 週+日視圖零「可出」"
fi

# T154 全店唯讀：STAFF A（綁 TKW）開 MF 時間表 → 200 有資料（頁 + API 兩層）
CODE154=$(curl -s -o /tmp/e2e-sched-t154.html -w '%{http_code}' -b "$COOKIE_TKW" "$BASE/schedule?clinic=MF")
check "T154 STAFF-TKW 開 MF 頁 → 200" "$CODE154" "200"
grep -qF "$MF_NAME" /tmp/e2e-sched-t154.html && grep -qF "mock 陳醫師" /tmp/e2e-sched-t154.html \
  && pass "T154 MF 頁有資料" || { fail "T154 MF 頁資料冇"; SCHED_FAIL=1; }
CODE154B=$(curl -s -o /tmp/e2e-sched-t154.json -w '%{http_code}' -b "$COOKIE_TKW" "$BASE/api/flows/slots?clinicCode=MF&from=$SCHED_TODAY&to=$SCHED_TODAY&granularity=day")
check "T154 STAFF-TKW 跨店 API → 200" "$CODE154B" "200"
grep -qE '"ok": *true' /tmp/e2e-sched-t154.json && grep -q '"date"' /tmp/e2e-sched-t154.json && pass "T154 API ok:true 有數據" || { fail "T154 API 唔 ok"; SCHED_FAIL=1; }

# T155 邊界：同一 STAFF A 對 MF 寫 → 403（唯讀 ≠ 可寫 — 落單/claim/commit call site 零改動）
CODE155=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_TKW" -X POST "$BASE/api/availability/refresh" -H 'Content-Type: application/json' -d "{\"clinicCode\":\"MF\",\"dates\":[\"$SCHED_TODAY\"]}")
check "T155 STAFF-TKW 對 MF 寫（availability refresh）→ 403" "$CODE155" "403"
CODE155B=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_TKW" -X POST "$BASE/api/flows/holds/schedt155nopehold000000000/commit" -H 'Content-Type: application/json' -d '{}')
[ "$CODE155B" = "404" ] || [ "$CODE155B" = "403" ] && pass "T155 外店 commit → 唔會 2xx（$CODE155B）" || { fail "T155 外店 commit 狀態異常（$CODE155B）"; SCHED_FAIL=1; }

# SCHED cleanup（零殘留：SCHEDULE_VIEW audit row + mock flags + claims 冩入）
q "DELETE FROM \"AuditLog\" WHERE action='SCHEDULE_VIEW'" >/dev/null 2>&1
rm -f .dev/workforce-mock-extra-providers.json .dev/workforce-mock-held.json .dev/workforce-mock-refresh-429.json .dev/workforce-mock-refresh-409.json
AUDIT_RESID=$(q "SELECT count(*)::text c FROM \"AuditLog\" WHERE action='SCHEDULE_VIEW'" | jf c)
check "SCHED cleanup：SCHEDULE_VIEW audit 零殘留" "$AUDIT_RESID" "0"
[ "$SCHED_FAIL" = 0 ] && pass "SCHED cwi-sched-20260901 全鏈 e2e（T150–T156）" || fail "SCHED 有項失敗（見上 ❌）"

# ── WIN. cwi-window-20260901 T171/T174: AI COPY_ONLY 草稿模式（過窗 AUTO / 窗口內迴歸）────
echo "[WIN] T171/T174: AI COPY_ONLY mode..."
WIN2_FAIL=0

# setup（hermetic — 唔靠前段殘留狀態）：
#   - waId 用 8526771/8526772（專留 block — 2026-09-02 教訓：8526011/8526014 同 T19 PATIENT_AUTO1 / PATIENT_OLD 撞）
#   - aiMode 明確設 AUTO（patch_aimode 帶重試；前段 W cleanup 還原 DRAFT — 唔好假設 AUTO）
#   - QUESTION→L2 policy raw INSERT（e2e 環 AUTOMATION_ADMIN_STAFF_IDS=eadm2（E 段 cleanup 已刪）→ API PATCH 會 403）
#   - cache 容錯：worker level cache 若 stale L3（E1 row）/ L2 — 兩者都 auto-eligible，gate 行為相同
patch_aimode "$TKW_CLINIC_ID" AUTO
check "T171 setup：TKW aiMode→AUTO" "$PAM_CODE" "200"
W171_AIMODE=$(q "SELECT (\"aiMode\")::text m FROM \"Clinic\" WHERE id='$TKW_CLINIC_ID'" | jf m)
check "T171 setup：DB 核 aiMode=AUTO" "$W171_AIMODE" "AUTO"
q "INSERT INTO \"AutomationPolicy\" (\"id\",\"clinicId\",\"category\",\"level\",\"updatedAt\") VALUES ('e2e-w171-q-${EPOCH}','$TKW_CLINIC_ID','QUESTION','L2',now()) ON CONFLICT (\"clinicId\",\"category\") DO UPDATE SET \"level\"=EXCLUDED.\"level\"" >/dev/null 2>&1
sleep 1

# ── T171：過窗 + AUTO → draft mode=COPY_ONLY + 零 OUT（唔產生 FAILED outbound）──
W171_PAT="8526771${EPOCH}"; W171_CONV=""
W171_FIX=""
for _try in 1 2 3; do
  W171_FIX=$(pnpm -s e2e:ai-job old-inbound --clinic TKW --from "$W171_PAT" --text "e2e W171 過窗查詢" 2>&1)
  W171_CONV=$(echo "$W171_FIX" | grep -oE 'CONV=[^ ]*' | cut -d= -f2)  # a2 fix：sed -n 's/^CONV=//p' 會帶埋 MSG=/CLINIC= 整行（space 唔斷）→ WHERE 0 行假紅；改 T23 同款 pattern
  [ -n "$W171_CONV" ] && break
  echo "    (old-inbound retry ${_try}: $(echo "$W171_FIX" | tail -1 | head -c 200))"; sleep 2
done
if [ -z "$W171_CONV" ]; then
  fail "T171 old-inbound fixture 失敗（out: $W171_FIX）"; WIN2_FAIL=1
else
  if wait_for "SELECT (\"mode\")::text m, (\"status\")::text s FROM \"AiDraft\" WHERE \"conversationId\"='$W171_CONV'" '[{"m":"COPY_ONLY","s":"PROPOSED"}]' 45; then
    pass "T171 過窗 draft mode=COPY_ONLY"
  else
    fail "T171 draft mode（last: $(q "SELECT (\"mode\")::text m, (\"status\")::text s FROM \"AiDraft\" WHERE \"conversationId\"='$W171_CONV'")）"; WIN2_FAIL=1
  fi
  # AUTO+L2 但 window-closed 閘 → 零 OUT（無 auto-send、無 FAILED）
  sleep 5
  W171_OUTC=$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$W171_CONV' AND direction='OUT'" | jf c)
  check "T171 AUTO 唔自動覆（過窗零 OUT）" "$W171_OUTC" "0"
  # UI：COPY_ONLY 草稿卡（banner + 複製掣 + 採用並編輯 消失）
  W171_UI=$(pnpm -s e2e:copyonly-ui --base "$BASE" --cookie "$COOKIE_TKW" --conv "$W171_CONV" 2>&1 | grep -E "COPYONLY-UI-(OK|FAIL)" | head -1)
  check "T171 UI：COPY_ONLY 卡（banner/複製掣/採用消失）" "$W171_UI" "COPYONLY-UI-OK"
fi

# ── T174：窗口內行為零改變迴歸（NORMAL + AUTO 自動發照舊）──
W174_PAT="8526772${EPOCH}"; W174_WAMID="wamid.E2E_W174_${EPOCH}"; W174_CONV=""
pnpm -s mock-inbound message --clinic TKW --from "$W174_PAT" --text "e2e W174 窗口內查詢" --wamid "$W174_WAMID" --name "E2E-W174" >/dev/null 2>&1 || { fail "T174 mock-inbound 失敗"; WIN2_FAIL=1; }
for _i in $(seq 1 30); do
  W174_CONV=$(q "SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$W174_PAT'" | jf id)
  [ -n "$W174_CONV" ] && break; sleep 1
done
if [ -z "$W174_CONV" ]; then
  fail "T174 conv 搵唔到（mock-inbound 失敗）"; WIN2_FAIL=1
else
  if wait_for "SELECT (\"mode\")::text m, (\"status\")::text s FROM \"AiDraft\" WHERE \"conversationId\"='$W174_CONV'" '[{"m":"NORMAL","s":"SENT_AUTO"}]' 45; then
    pass "T174 窗口內 draft mode=NORMAL + AUTO 自動發（SENT_AUTO）"
  else
    fail "T174 draft mode（last: $(q "SELECT (\"mode\")::text m, (\"status\")::text s FROM \"AiDraft\" WHERE \"conversationId\"='$W174_CONV'")）"; WIN2_FAIL=1
  fi
  if wait_for "SELECT count(*)::text c, bool_and(\"aiAutoSent\")::text a FROM \"Message\" WHERE \"conversationId\"='$W174_CONV' AND direction='OUT' AND channel='API'" '[{"c":"1","a":"true"}]' 30; then
    pass "T174 恰一條 AI 自動 OUT（aiAutoSent）— 行為零改變"
  else
    fail "T174 OUT 計數（last: $(q "SELECT count(*)::text c, bool_and(\"aiAutoSent\")::text a FROM \"Message\" WHERE \"conversationId\"='$W174_CONV' AND direction='OUT' AND channel='API'")）"; WIN2_FAIL=1
  fi
fi

# restore + cleanup（policy row 清走；aiMode 還原 DRAFT；洗 W171/W174 病人殘留）
q "DELETE FROM \"AutomationPolicy\" WHERE id='e2e-w171-q-${EPOCH}'" >/dev/null 2>&1
patch_aimode "$TKW_CLINIC_ID" DRAFT
if [ -n "$W171_CONV" ] || [ -n "$W174_CONV" ]; then
  q "DELETE FROM \"AiDraft\" WHERE \"conversationId\" IN ('$W171_CONV','$W174_CONV')" >/dev/null 2>&1
  q "DELETE FROM \"Message\" WHERE \"conversationId\" IN ('$W171_CONV','$W174_CONV')" >/dev/null 2>&1
  q "DELETE FROM \"Conversation\" WHERE id IN ('$W171_CONV','$W174_CONV')" >/dev/null 2>&1
fi
q "DELETE FROM \"Contact\" WHERE \"waId\" IN ('$W171_PAT','$W174_PAT')" >/dev/null 2>&1
W17X_RESID=$(q "SELECT count(*)::text c FROM \"Contact\" WHERE \"waId\" IN ('$W171_PAT','$W174_PAT')" | jf c)
check "WIN cleanup：W171/W174 零殘留" "$W17X_RESID" "0"
[ "$WIN2_FAIL" = 0 ] && pass "WIN cwi-window-20260901 T171/T174 全鏈（COPY_ONLY 模式 + 窗口內迴歸）" || fail "WIN T171/T174 有項失敗（見上 ❌）"

# ── WIN. cwi-window-20260901 T172/T173: 過窗三出路 UI（① App handoff + ② template picker）──
echo "[WIN] T172/T173: over-window three-exit UI..."
WIN3_FAIL=0

# ── T172：① 開手機對話 — wa.me deep link + audit APP_HANDOFF_CLICK（零 PII）+ INTERNAL 備註 ──
W172_PAT="8526773${EPOCH}"; W172_CONV=""; W172_DRAFT=""
for _try in 1 2 3; do
  W172_FIX=$(pnpm -s e2e:ai-job old-inbound --clinic TKW --from "$W172_PAT" --text "e2e W172 過窗查詢" 2>&1)
  W172_CONV=$(echo "$W172_FIX" | grep -oE 'CONV=[^ ]*' | cut -d= -f2)  # a2 fix：同上（CONV= 提取要斷 space）
  [ -n "$W172_CONV" ] && break
  echo "    (W172 old-inbound retry ${_try}: $(echo "$W172_FIX" | tail -1 | head -c 200))"; sleep 2
done
if [ -z "$W172_CONV" ]; then
  fail "T172 old-inbound fixture 失敗（out: $W172_FIX）"; WIN3_FAIL=1
else
  # 等 COPY_ONLY 草稿（wa.me link 要帶編碼草稿文字）
  for _i in $(seq 1 45); do
    W172_DRAFT=$(q "SELECT \"draftText\" d FROM \"AiDraft\" WHERE \"conversationId\"='$W172_CONV' AND \"mode\"='COPY_ONLY'" | jf d)
    [ -n "$W172_DRAFT" ] && break; sleep 1
  done
  if [ -z "$W172_DRAFT" ]; then
    fail "T172 COPY_ONLY 草稿未生成（wa.me 斷言跳過）"; WIN3_FAIL=1
  else
    # 1) API：App handoff
    CODE=$(curl -s -o /tmp/e2e-w172-ho.json -w '%{http_code}' -b "$COOKIE_TKW" -X POST "$BASE/api/conversations/$W172_CONV/app-handoff" -H 'Content-Type: application/json' -d '{}')
    check "T172 ① App handoff POST → 200" "$CODE" "200"
    # 2) audit：APP_HANDOFF_CLICK（staffId 正確 + meta 有 conversationId + 零電話原文）
    W172_AUDIT=$(q "SELECT count(*)::text c, bool_and(\"staffId\"='$TKW_STAFF_ID')::text s, bool_and(meta ? 'conversationId')::text ci FROM \"AuditLog\" WHERE action='APP_HANDOFF_CLICK' AND \"entityId\"='$W172_CONV'" | tr -d ' \n')
    check "T172 audit APP_HANDOFF_CLICK（staffId + meta.conversationId）" "$W172_AUDIT" "[{\"c\":\"1\",\"s\":\"true\",\"ci\":\"true\"}]"
    W172_PII=$(q "SELECT count(*) FILTER (WHERE meta::text LIKE '%$W172_PAT%' OR \"entityId\"::text LIKE '%$W172_PAT%')::text c FROM \"AuditLog\" WHERE action='APP_HANDOFF_CLICK' AND \"entityId\"='$W172_CONV'" | jf c)
    check "T172 audit 零電話原文（零 PII 鐵律）" "$W172_PII" "0"
    # 3) INTERNAL 備註（billingCategory=NONE + sentByStaffId 正確）
    W172_NOTE=$(q "SELECT count(*)::text c, bool_and(\"billingCategory\"='NONE')::text b, bool_and(\"sentByStaffId\"='$TKW_STAFF_ID')::text sf FROM \"Message\" WHERE \"conversationId\"='$W172_CONV' AND channel='INTERNAL' AND body LIKE '%已轉用手機 App 跟進%'" | tr -d ' \n')
    check "T172 INTERNAL 備註（NONE + staffId）" "$W172_NOTE" "[{\"c\":\"1\",\"b\":\"true\",\"sf\":\"true\"}]"
    # 4) UI：三出路 block + wa.me link（E164 無加號 + 編碼草稿）+ picker + ③
    W172_UI=$(pnpm -s e2e:window-ui --base "$BASE" --cookie "$COOKIE_TKW" --conv "$W172_CONV" --draft "$W172_DRAFT" 2>&1 | grep -E "WINDOW-UI-(OK|FAIL)" | head -1)
    check "T172 UI：wa.me link 編碼 + 三出路 block" "$W172_UI" "WINDOW-UI-OK"
  fi
fi

# ── T173：② 揀 template — 只列 APPROVED + 變數預填 + 發送成功（走現有 outbound）──
W173_PAT="8526774${EPOCH}"; W173_CONV=""
for _try in 1 2 3; do
  W173_FIX=$(pnpm -s e2e:ai-job old-inbound --clinic TKW --from "$W173_PAT" --text "e2e W173 過窗查詢" 2>&1)
  W173_CONV=$(echo "$W173_FIX" | grep -oE 'CONV=[^ ]*' | cut -d= -f2)  # a2 fix：同上（CONV= 提取要斷 space）
  [ -n "$W173_CONV" ] && break
  echo "    (W173 old-inbound retry ${_try}: $(echo "$W173_FIX" | tail -1 | head -c 200))"; sleep 2
done
if [ -z "$W173_CONV" ]; then
  fail "T173 old-inbound fixture 失敗（out: $W173_FIX）"; WIN3_FAIL=1
else
  # CONFIRMED booking fixture（變數預填來源 — raw INSERT 冪等）
  q "INSERT INTO \"BookingRequest\" (id, \"conversationId\", \"clinicId\", \"flowToken\", \"providerApricotId\", \"providerName\", \"requestedDate\", \"requestedTime\", status, \"createdAt\") VALUES ('e2e-w173-br', '$W173_CONV', '$TKW_CLINIC_ID', 'e2e-w173-flow-${EPOCH}', 'mock-pract-tkw-1', '陳明軒（主理）', '2026-10-01', '10:30', 'CONFIRMED', now()) ON CONFLICT (id) DO NOTHING" >/dev/null 2>&1
  # picker API：只列 APPROVED（PENDING/REJECTED 唔入）
  CODE=$(curl -s -o /tmp/e2e-w173-tpl.json -w '%{http_code}' -b "$COOKIE_TKW" "$BASE/api/conversations/$W173_CONV/templates")
  check "T173 ② picker GET → 200" "$CODE" "200"
  W173_NAMES=$(node -e "try{const d=require('/tmp/e2e-w173-tpl.json');console.log(d.templates.map(t=>t.name).sort().join(','))}catch(e){console.log('ERR')}" 2>/dev/null)
  # a2 fix：預期值要同 node `.sort()`（JS lexicographic）同序 — o<t 所以 appointment_reminder 排前（原寫反 = 假紅）
  check "T173 只列 APPROVED+UTILITY（2 款）" "$W173_NAMES" "appointment_reminder,appt_reminder_zh"
  W173_PREFILL=$(node -e "try{const d=require('/tmp/e2e-w173-tpl.json');const p=d.prefill;console.log(p?[p.patientName,p.clinicName,p.requestedDate,p.requestedTime,p.providerName].join('|'):'NULL')}catch(e){console.log('ERR')}" 2>/dev/null)
  check "T173 變數預填（病人名/診所/日期/時間/醫生）" "$W173_PREFILL" "E2E-A-WINDOW|TKW 診所（試點店）|2026-10-01|10:30|陳明軒（主理）"
  # 發送成功（picker 掣同一 outbound 路徑：POST /api/messages/send templateName）
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_TKW" -X POST "$BASE/api/messages/send" -H 'Content-Type: application/json' -d "{\"conversationId\":\"$W173_CONV\",\"templateName\":\"appt_reminder_zh\"}")
  check "T173 ② 發送（picker 同路徑）→ 202" "$CODE" "202"
  if wait_for "SELECT (count(*)>0)::text c FROM \"Message\" WHERE \"conversationId\"='$W173_CONV' AND type='template' AND status='SENT' AND \"billingCategory\"='UTILITY'" '[{"c":"true"}]' 30; then
    pass "T173 ② template SENT（mock Graph）+ billingCategory=UTILITY"
  else
    fail "T173 template 未 SENT（last: $(q "SELECT type t, status s, \"billingCategory\" b FROM \"Message\" WHERE \"conversationId\"='$W173_CONV' AND direction='OUT'")）"; WIN3_FAIL=1
  fi
  # UI：picker DOM（select + 預填行 + 發送掣 + ③）
  W173_UI=$(pnpm -s e2e:window-ui --base "$BASE" --cookie "$COOKIE_TKW" --conv "$W173_CONV" --expect-prefill 1 2>&1 | grep -E "WINDOW-UI-(OK|FAIL)" | head -1)
  check "T173 UI：picker + 預填行 + 三出路 block" "$W173_UI" "WINDOW-UI-OK"
fi

# cleanup（W172/W173 病人殘留 + booking row）
if [ -n "$W172_CONV" ] || [ -n "$W173_CONV" ]; then
  q "DELETE FROM \"AiDraft\" WHERE \"conversationId\" IN ('$W172_CONV','$W173_CONV')" >/dev/null 2>&1
  q "DELETE FROM \"Message\" WHERE \"conversationId\" IN ('$W172_CONV','$W173_CONV')" >/dev/null 2>&1
  q "DELETE FROM \"BookingRequest\" WHERE id='e2e-w173-br'" >/dev/null 2>&1
  q "DELETE FROM \"Conversation\" WHERE id IN ('$W172_CONV','$W173_CONV')" >/dev/null 2>&1
fi
q "DELETE FROM \"Contact\" WHERE \"waId\" IN ('$W172_PAT','$W173_PAT')" >/dev/null 2>&1
W17X2_RESID=$(q "SELECT count(*)::text c FROM \"Contact\" WHERE \"waId\" IN ('$W172_PAT','$W173_PAT')" | jf c)
check "WIN cleanup：W172/W173 零殘留" "$W17X2_RESID" "0"
[ "$WIN3_FAIL" = 0 ] && pass "WIN cwi-window-20260901 T172/T173 全鏈（三出路 UI + App handoff + picker）" || fail "WIN T172/T173 有項失敗（見上 ❌）"
# ── WIN. cwi-window-20260901 T170: 單訊息鐵律（1 QUESTION → 恰 1 AI OUT；5s burst → warn 唔擋）──
echo "[WIN] T170: single-message iron rule + burst guard..."
W170_FAIL=0
W170_PAT="8526775${EPOCH}"; W170_WAMID1="wamid.E2E_W170A_${EPOCH}"; W170_WAMID2="wamid.E2E_W170B_${EPOCH}"
# setup 同 T171 模式：AUTO + QUESTION→L2（cache 容錯：stale L3/L2 都 auto-eligible，gate 行為相同）
patch_aimode "$TKW_CLINIC_ID" AUTO
check "T170 setup：TKW aiMode→AUTO" "$PAM_CODE" "200"
q "INSERT INTO \"AutomationPolicy\" (\"id\",\"clinicId\",\"category\",\"level\",\"updatedAt\") VALUES ('e2e-w170-q-${EPOCH}','$TKW_CLINIC_ID','QUESTION','L2',now()) ON CONFLICT (\"clinicId\",\"category\") DO UPDATE SET \"level\"=EXCLUDED.\"level\"" >/dev/null 2>&1
sleep 1

# ①+② 兩條 inbound 連發（back-to-back）→ 1 入 1 出（恰 2 OUT）+ 5s burst warn
# a2 fix v2：r2 實測 full-run 負載下 δ+q≥3s → 「等第 1 條 OUT 確認先发第 2 條」margin 唔夠（Δ=2+δ+q≥5s）；
#   改兩條 inbound 連發（Δ ≈ 連發間隔 ~1s + δ 差）→ 結構上喺 5s 窗內
pnpm -s mock-inbound message --clinic TKW --from "$W170_PAT" --text "e2e W170 窗口內查詢" --wamid "$W170_WAMID1" --name "E2E-W170" >/dev/null 2>&1 || { fail "T170 mock-inbound#1 失敗"; W170_FAIL=1; }
W170_CONV=""
for _i in $(seq 1 30); do
  W170_CONV=$(q "SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$W170_PAT'" | jf id)
  [ -n "$W170_CONV" ] && break; sleep 1
done
if [ -z "$W170_CONV" ]; then
  fail "T170 conv 搵唔到（mock-inbound 失敗）"; W170_FAIL=1
else
  # 第 2 條 back-to-back（conv 找到就即刻发 — 第 1 條 OUT 仲喺 pipeline 入面）
  pnpm -s mock-inbound message --clinic TKW --from "$W170_PAT" --text "e2e W170 窗口內查詢 2" --wamid "$W170_WAMID2" --name "E2E-W170" >/dev/null 2>&1 || true
  # ① 1 入 1 出基線：2 條 inbound → 恰 2 條 AI 自動 OUT（無雙發、無漏發）
  if wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$W170_CONV' AND direction='OUT' AND channel='API' AND \"aiAutoSent\"=true AND status='SENT'" '[{"c":"2"}]' 45; then
    pass "T170 ① 兩條 inbound 連發 → 恰 2 條 AI 自動 OUT（1 入 1 出）"
  else
    fail "T170 ① OUT 計數（last: $(q "SELECT id, status FROM \"Message\" WHERE \"conversationId\"='$W170_CONV' AND direction='OUT'")）"; W170_FAIL=1
  fi
  # ② burst：兩 OUT createdAt 相差 ~1s → 第 2 條發送時第 1 條喺 5s 窗內 → log warn
  # a3 2026-09-02：e2e 中途會重啟 worker（t93r 等）→ burst warn 可能落咗其他 log 檔；r3 實測 T170 ②
  # 假紅源 = 死 grep /tmp/e2e-worker.log（v1 舊 worker），而真 burst warn 喺 e2e-worker-t93r.log（產品行為正確）
  BURST_OK=0
  for _i in $(seq 1 30); do
    BURST_CONV=$(grep -h "multi-message burst" /tmp/e2e-worker*.log 2>/dev/null | grep -c "$W170_CONV")
    [ "${BURST_CONV:-0}" -ge 1 ] 2>/dev/null && { BURST_OK=1; break; }
    sleep 1
  done
  if [ "$BURST_OK" != 1 ]; then
    # retry：再一組 back-to-back pair（inbound3+4）— pipeline 慢時呢組兩 OUT 一樣貼身
    pnpm -s mock-inbound message --clinic TKW --from "$W170_PAT" --text "e2e W170 窗口內查詢 3" --wamid "wamid.E2E_W170C_${EPOCH}" --name "E2E-W170" >/dev/null 2>&1 || true
    pnpm -s mock-inbound message --clinic TKW --from "$W170_PAT" --text "e2e W170 窗口內查詢 4" --wamid "wamid.E2E_W170D_${EPOCH}" --name "E2E-W170" >/dev/null 2>&1 || true
    for _i in $(seq 1 45); do
      BURST_CONV=$(grep -h "multi-message burst" /tmp/e2e-worker*.log 2>/dev/null | grep -c "$W170_CONV")
      [ "${BURST_CONV:-0}" -ge 1 ] 2>/dev/null && { BURST_OK=1; break; }
      sleep 1
    done
  fi
  if [ "$BURST_OK" = 1 ]; then
    pass "T170 ② 5s 內第 2 條 AI OUT → worker log warn multi-message burst（含 conv id）"
  else
    fail "T170 ② burst warn 未出現（OUT=$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$W170_CONV' AND direction='OUT' AND channel='API' AND \"aiAutoSent\"=true AND status='SENT'") burstlog=$(grep -h "multi-message burst" /tmp/e2e-worker*.log 2>/dev/null | wc -l)）"; W170_FAIL=1
  fi
  # ③ 唔擋：burst 唔阻 auto OUT（全部實 OUT 皆 SENT — 觀察期唔硬擋）
  OUT_REAL=$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$W170_CONV' AND direction='OUT' AND channel='API' AND \"aiAutoSent\"=true AND status='SENT'" | jf c)
  if [ "${OUT_REAL:-0}" -ge 2 ]; then
    pass "T170 ③ 唔擋：burst 唔阻 auto OUT（$OUT_REAL 條實 OUT 皆 SENT）"
  else
    fail "T170 ③ auto OUT 被擋/未齊（OUT_REAL=$OUT_REAL last: $(q "SELECT id, status FROM \"Message\" WHERE \"conversationId\"='$W170_CONV' AND direction='OUT'")）"; W170_FAIL=1
  fi
fi

# ④ 負對照：T174 conv（窗口內單條 auto OUT）零 burst warn
# a3 2026-09-02：同樣跟全部 worker log（見 T170 ② 註）
W170_NEG=$(grep -h "multi-message burst" /tmp/e2e-worker*.log 2>/dev/null | grep -c "$W174_CONV")
check "T170 ④ 負對照：T174 conv 零 burst warn" "${W170_NEG:-0}" "0"

# restore + cleanup（policy 清走；aiMode 還原 DRAFT；洗 W170 病人 + fixture 殘留）
q "DELETE FROM \"AutomationPolicy\" WHERE id='e2e-w170-q-${EPOCH}'" >/dev/null 2>&1
patch_aimode "$TKW_CLINIC_ID" DRAFT
if [ -n "$W170_CONV" ]; then
  q "DELETE FROM \"AiDraft\" WHERE \"conversationId\"='$W170_CONV'" >/dev/null 2>&1
  q "DELETE FROM \"Message\" WHERE \"conversationId\"='$W170_CONV'" >/dev/null 2>&1
  q "DELETE FROM \"Conversation\" WHERE id='$W170_CONV'" >/dev/null 2>&1
fi
q "DELETE FROM \"Contact\" WHERE \"waId\"='$W170_PAT'" >/dev/null 2>&1
W170_RESID=$(q "SELECT count(*)::text c FROM \"Contact\" WHERE \"waId\"='$W170_PAT'" | jf c)
check "T170 cleanup：W170 零殘留（含 fixture）" "$W170_RESID" "0"
[ "$W170_FAIL" = 0 ] && pass "WIN cwi-window-20260901 T170 全鏈（單訊息鐵律 + burst guard 觀察）" || fail "WIN T170 有項失敗（見上 ❌）"


# ── WIN. cwi-window-20260901 T175: billingCategory 數據層 ─────────────
echo "[WIN] T175: billingCategory data layer..."
WIN_FAIL=0
W175_PAT="8526003${EPOCH}"   # hermetic 新病人（零污染前段斷言）
W175_WAMID="wamid.E2E_W175_${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$W175_PAT" --text "e2e W175 窗口內查詢" --wamid "$W175_WAMID" --name "E2E-W175" >/dev/null || { fail "T175 mock-inbound POST"; WIN_FAIL=1; }
W175_CONV=$(q "SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$W175_PAT'" | jf id)

if [ -n "$W175_CONV" ]; then
  # T175a：staff 窗口內人手 text send → SERVICE
  CODE=$(curl -s -o /tmp/e2e-w175a.json -w '%{http_code}' -b "$COOKIE_TKW" \
    -X POST "$BASE/api/messages/send" -H 'Content-Type: application/json' \
    -d "{\"conversationId\":\"$W175_CONV\",\"body\":\"e2e W175 人手覆\"}")
  check "T175a 窗口內人手 send → 202" "$CODE" "202"
  W175A_MSG=$(jf messageId < /tmp/e2e-w175a.json)
  if wait_for "SELECT (\"billingCategory\")::text b FROM \"Message\" WHERE id='$W175A_MSG'" '[{"b":"SERVICE"}]' 10; then
    pass "T175a 人手窗口內 text = SERVICE"
  else
    fail "T175a 人手 text billingCategory（last: $(q "SELECT (\"billingCategory\")::text b FROM \"Message\" WHERE id='$W175A_MSG'")）"; WIN_FAIL=1
  fi
  wait_for "SELECT status s FROM \"Message\" WHERE id='$W175A_MSG'" '[{"s":"SENT"}]' 30 >/dev/null || true

  # T175b：template send（appt_reminder_zh + 顯式 templateParams — 對話無 CONFIRMED 預約）→ UTILITY + templateMeta 類別快照
  CODE=$(curl -s -o /tmp/e2e-w175b.json -w '%{http_code}' -b "$COOKIE_TKW" \
    -X POST "$BASE/api/messages/send" -H 'Content-Type: application/json' \
    -d "{\"conversationId\":\"$W175_CONV\",\"templateName\":\"appt_reminder_zh\",\"templateParams\":{\"requestedDate\":\"2026-09-15\",\"requestedTime\":\"14:00\",\"providerName\":\"Dr E2E\"}}")
  check "T175b template send → 202" "$CODE" "202"
  W175B_MSG=$(jf messageId < /tmp/e2e-w175b.json)
  if wait_for "SELECT (\"billingCategory\")::text b, (\"templateMeta\"->>'category')::text c FROM \"Message\" WHERE id='$W175B_MSG'" '[{"b":"UTILITY","c":"UTILITY"}]' 10; then
    pass "T175b template = UTILITY + templateMeta.category 快照"
  else
    fail "T175b template billingCategory（last: $(q "SELECT (\"billingCategory\")::text b, (\"templateMeta\"->>'category')::text c FROM \"Message\" WHERE id='$W175B_MSG'")）"; WIN_FAIL=1
  fi
else
  fail "T175 conv 搵唔到（mock-inbound 失敗）"; WIN_FAIL=1
fi

# T175c：echo row（T5 本 run 建立）= NONE
W175C=$(q "SELECT (\"billingCategory\")::text b FROM \"Message\" WHERE \"waMessageId\"='$ECHO_WAMID'" | jf b)
check "T175c APP_ECHO row = NONE" "$W175C" "NONE"

# T175d：backfill 冪等 — 手插 legacy row（billingCategory NULL）→ 跑 backfill → 斷言填晒 → 再跑一次冪等
if [ -n "$W175_CONV" ]; then
  q "INSERT INTO \"Message\" (id, \"conversationId\", \"direction\", \"channel\", \"type\", \"body\", \"status\", \"waTimestamp\") VALUES ('e2e-w175-legacy-text', '$W175_CONV', 'OUT','API','text','e2e legacy text','SENT', now())" >/dev/null
  q "INSERT INTO \"Message\" (id, \"conversationId\", \"direction\", \"channel\", \"type\", \"body\", \"status\", \"waTimestamp\", \"templateMeta\") VALUES ('e2e-w175-legacy-tpl', '$W175_CONV', 'OUT','API','template','e2e legacy tpl','SENT', now(), '{\"name\":\"legacy_promo\",\"language\":\"en_US\",\"components\":[],\"category\":\"MARKETING\"}'::jsonb)" >/dev/null
  q "INSERT INTO \"Message\" (id, \"conversationId\", \"direction\", \"channel\", \"type\", \"body\", \"status\", \"waTimestamp\") VALUES ('e2e-w175-legacy-echo', '$W175_CONV', 'OUT','APP_ECHO','text','e2e legacy echo','SENT', now())" >/dev/null
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/backfill-billing-category.sql >/dev/null 2>&1 || { fail "T175d backfill script 執行失敗"; WIN_FAIL=1; }
  W175D1=$(q "SELECT \"type\" t, (\"billingCategory\")::text b FROM \"Message\" WHERE id IN ('e2e-w175-legacy-text','e2e-w175-legacy-tpl','e2e-w175-legacy-echo') ORDER BY id" | tr -d ' ')
  check "T175d backfill 填 legacy（text=SERVICE/tpl=MARKETING/echo=NONE）" "$W175D1" "[{\"t\":\"text\",\"b\":\"NONE\"},{\"t\":\"text\",\"b\":\"SERVICE\"},{\"t\":\"template\",\"b\":\"MARKETING\"}]"
  # 冪等：已填 row 唔會變（再跑一次）
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/backfill-billing-category.sql >/dev/null 2>&1 || true
  W175D2=$(q "SELECT \"type\" t, (\"billingCategory\")::text b FROM \"Message\" WHERE id IN ('e2e-w175-legacy-text','e2e-w175-legacy-tpl','e2e-w175-legacy-echo') ORDER BY id" | tr -d ' ')
  check "T175d backfill 冪等（重跑零變動）" "$W175D2" "$W175D1"
  # 新寫入規則 row（T175a）唔會被 backfill 蓋掉
  W175D3=$(q "SELECT (\"billingCategory\")::text b FROM \"Message\" WHERE id='$W175A_MSG'" | jf b)
  check "T175d 新 row（已寫 SERVICE）唔受 backfill 影響" "$W175D3" "SERVICE"
fi

# WIN cleanup（hermetic：洗走 W175 病人全部殘留）
q "DELETE FROM \"AiDraft\" WHERE \"conversationId\"='$W175_CONV'" >/dev/null 2>&1
q "DELETE FROM \"Message\" WHERE id LIKE 'e2e-w175-legacy-%'" >/dev/null 2>&1
q "DELETE FROM \"Message\" WHERE \"conversationId\"='$W175_CONV'" >/dev/null 2>&1
q "DELETE FROM \"Conversation\" WHERE id='$W175_CONV'" >/dev/null 2>&1
q "DELETE FROM \"Contact\" WHERE \"waId\"='$W175_PAT'" >/dev/null 2>&1
W175_RESID=$(q "SELECT count(*)::text c FROM \"Contact\" WHERE \"waId\"='$W175_PAT'" | jf c)
check "WIN cleanup：W175 零殘留" "$W175_RESID" "0"
[ "$WIN_FAIL" = 0 ] && pass "WIN cwi-window-20260901 T175 全鏈（billingCategory 數據層）" || fail "WIN T175 有項失敗（見上 ❌）"
# ── WIN. cwi-window-20260901 T176: /admin/usage（ADMIN 限定 + 數字對得返 DB + 決策表）──
echo "[WIN] T176: /admin/usage..."

# ── T176 fixture（hermetic）：獨立對話 + 3 計數行（SERVICE 人手 / SERVICE AI / UTILITY template）+ 1 audit ──
q "INSERT INTO \"Contact\" (id, \"clinicId\", \"waId\", \"profileName\", labels) VALUES ('e2e-w176-ct','$TKW_CLINIC_ID','8526776${EPOCH}','E2E-W176',ARRAY[]::text[]) ON CONFLICT (id) DO NOTHING" >/dev/null 2>&1
q "INSERT INTO \"Conversation\" (id, \"clinicId\", \"contactId\", status, \"lastMessageAt\") VALUES ('e2e-w176-cv','$TKW_CLINIC_ID','e2e-w176-ct','OPEN',now()) ON CONFLICT (id) DO NOTHING" >/dev/null 2>&1
q "INSERT INTO \"Message\" (id, \"conversationId\", \"waMessageId\", direction, channel, type, body, status, \"sentByStaffId\", \"aiAutoSent\", \"billingCategory\", \"waTimestamp\", \"createdAt\") VALUES ('e2e-w176-m1','e2e-w176-cv','mock-wamid-w176-1','OUT','API','text','e2e W176 staff service row','SENT','$TKW_STAFF_ID',false,'SERVICE',now(),now()) ON CONFLICT (id) DO NOTHING" >/dev/null 2>&1
q "INSERT INTO \"Message\" (id, \"conversationId\", \"waMessageId\", direction, channel, type, body, status, \"sentByStaffId\", \"aiAutoSent\", \"billingCategory\", \"waTimestamp\", \"createdAt\") VALUES ('e2e-w176-m2','e2e-w176-cv','mock-wamid-w176-2','OUT','API','text','e2e W176 ai service row','SENT',null,true,'SERVICE',now(),now()) ON CONFLICT (id) DO NOTHING"
q "INSERT INTO \"Message\" (id, \"conversationId\", \"waMessageId\", direction, channel, type, body, status, \"sentByStaffId\", \"aiAutoSent\", \"billingCategory\", \"waTimestamp\", \"createdAt\") VALUES ('e2e-w176-m3','e2e-w176-cv','mock-wamid-w176-3','OUT','API','template','e2e W176 utility template row','SENT',null,false,'UTILITY',now(),now()) ON CONFLICT (id) DO NOTHING" >/dev/null 2>&1
q "INSERT INTO \"AuditLog\" (id, \"staffId\", action, entity, \"entityId\", meta) VALUES ('e2e-w176-au','$TKW_STAFF_ID','APP_HANDOFF_CLICK','Conversation','e2e-w176-cv','{\"conversationId\":\"e2e-w176-cv\"}'::jsonb) ON CONFLICT (id) DO NOTHING" >/dev/null 2>&1

# 1) RBAC
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/admin/usage")
check "T176 未登入 → 401" "$CODE" "401"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_TKW" "$BASE/api/admin/usage")
check "T176 STAFF → 403" "$CODE" "403"
CODE=$(curl -s -o /tmp/e2e-w176-usage.json -w '%{http_code}' -b "$COOKIE_ADMIN" "$BASE/api/admin/usage")
check "T176 ADMIN → 200" "$CODE" "200"

# 2) 數字對得返 DB（本月 OUT API 總數 + App 跟進次數 — 同一 HK 月邊界）
# a2 fix：DB 對帳查詢要同 API 語義一致（JOIN Conversation ⋈ Clinic）— 裸 count 會數到
#   孤兒 row（conversation 已刪嘅 e2e 殘留）→ API 少計 = 假紅（r1 實測 120 vs 132）
W176_RANGE=$(node -e "const t=Date.now()+8*3600e3;const hk=new Date(t);const y=hk.getUTCFullYear();const m=hk.getUTCMonth();const f=Date.UTC(y,m,1)-8*3600e3;const o=Date.UTC(y,m+1,1)-8*3600e3;console.log(new Date(f).toISOString()+' '+new Date(o).toISOString())")
W176_FROM=$(echo "$W176_RANGE" | cut -d' ' -f1); W176_TO=$(echo "$W176_RANGE" | cut -d' ' -f2)
W176_DB=$(q "SELECT count(*)::text c FROM \"Message\" m JOIN \"Conversation\" cv ON cv.id=m.\"conversationId\" JOIN \"Clinic\" cl ON cl.id=cv.\"clinicId\" WHERE m.direction='OUT' AND m.channel='API' AND m.\"createdAt\" >= '$W176_FROM' AND m.\"createdAt\" < '$W176_TO'" | jf c)
W176_API=$(node -e "try{const d=require('/tmp/e2e-w176-usage.json');console.log(d.totals.total)}catch(e){console.log('ERR')}" 2>/dev/null)
check "T176 本月 API 出街總數對得返 DB" "$W176_API" "$W176_DB"
W176_HO_DB=$(q "SELECT count(*)::text c FROM \"AuditLog\" a JOIN \"Conversation\" cv ON cv.id=a.\"entityId\" JOIN \"Clinic\" cl ON cl.id=cv.\"clinicId\" WHERE a.action='APP_HANDOFF_CLICK' AND a.\"createdAt\" >= '$W176_FROM' AND a.\"createdAt\" < '$W176_TO'" | jf c)
W176_HO_API=$(node -e "try{const d=require('/tmp/e2e-w176-usage.json');console.log(d.appHandoff.reduce((a,x)=>a+x.count,0))}catch(e){console.log('ERR')}" 2>/dev/null)
check "T176 App 跟進次數對得返 DB（APP_HANDOFF_CLICK）" "$W176_HO_API" "$W176_HO_DB"

# 3) 類別分布 + fixture 行入數（TKW·SERVICE 人手≥1 / AI≥1；TKW·UTILITY ≥1）
W176_CATS=$(node -e "try{const d=require('/tmp/e2e-w176-usage.json');console.log(Array.from(new Set(d.rows.map(r=>r.category))).sort().join(','))}catch(e){console.log('ERR')}" 2>/dev/null)
echo "  (T176 類別分布: $W176_CATS)"
if echo "$W176_CATS" | grep -q "SERVICE" && echo "$W176_CATS" | grep -q "UTILITY"; then
  pass "T176 類別分布含 SERVICE + UTILITY"
else
  fail "T176 類別分布缺 SERVICE/UTILITY（actual: $W176_CATS）"
fi
W176_FIX=$(node -e "
try {
  const d = require('/tmp/e2e-w176-usage.json');
  const tkwSvc = d.rows.filter(r=>r.clinicCode==='TKW' && r.category==='SERVICE');
  const tkwUti = d.rows.filter(r=>r.clinicCode==='TKW' && r.category==='UTILITY');
  const staff = tkwSvc.reduce((a,r)=>a+r.staffSent,0);
  const ai = tkwSvc.reduce((a,r)=>a+r.aiSent,0);
  const uti = tkwUti.reduce((a,r)=>a+r.total,0);
  console.log((staff>=1 && ai>=1 && uti>=1) ? 'OK' : 'BAD staff='+staff+' ai='+ai+' uti='+uti);
} catch(e) { console.log('ERR'); }" 2>/dev/null)
check "T176 fixture 行入數（SERVICE 人手≥1 / AI≥1 / UTILITY≥1）" "$W176_FIX" "OK"

# 4) 頁面（layout 擋 STAFF 403；ADMIN 200 + 決策表 render）
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_TKW" "$BASE/admin/usage")
check "T176 頁面 STAFF → 403" "$CODE" "403"
CODE=$(curl -s -o /tmp/e2e-w176-page.html -w '%{http_code}' -b "$COOKIE_ADMIN" "$BASE/admin/usage")
check "T176 頁面 ADMIN → 200" "$CODE" "200"
grep -q "用量統計" /tmp/e2e-w176-page.html && pass "T176 頁面 render（用量統計）" || fail "T176 頁面缺「用量統計」"
# a2 fix：§5 決策表係 client 載入後先 render（SSR 只有「載入中…」）→ curl grep HTML 永遠假紅；
#   改真實瀏覽器級斷言（e2e:usage-ui）
W176_UI=$(pnpm -s e2e:usage-ui --base "$BASE" --cookie "$COOKIE_ADMIN" 2>&1 | grep -E "USAGE-UI-(OK|FAIL)" | head -1)
check "T176 頁面 §5 決策表 render（瀏覽器級）" "$W176_UI" "USAGE-UI-OK"

# cleanup（T176 fixture 全清）
q "DELETE FROM \"Message\" WHERE id IN ('e2e-w176-m1','e2e-w176-m2','e2e-w176-m3')" >/dev/null 2>&1
q "DELETE FROM \"AuditLog\" WHERE id='e2e-w176-au'" >/dev/null 2>&1
q "DELETE FROM \"Conversation\" WHERE id='e2e-w176-cv'" >/dev/null 2>&1
q "DELETE FROM \"Contact\" WHERE id='e2e-w176-ct'" >/dev/null 2>&1
W176_RESID=$(q "SELECT count(*)::text c FROM \"Contact\" WHERE id='e2e-w176-ct'" | jf c)
check "T176 cleanup 零殘留" "$W176_RESID" "0"
pass "WIN cwi-window-20260901 T176 全鏈（/admin/usage RBAC + 數字對帳 + 決策表）"


# ── N. cwi-master B2（Part B 通知 v1）T160–T169 ──────────────────────
# 客人來訊一定要有提示：三觸發（message:new IN / urgent:escalation / notice:new）
# + N-2 指派/ADMIN 規則 + N-4 零 PII + N-5 開住唔響 + N-6 節流 + N-7 降級 + N-8 設定。
# 瀏覽器級斷言 = e2e:notify-ui（playwright + Redis publish wa-inbox:notify 真實 socket 路徑）；
# 詳細見 scripts/e2e-notify-gate.sh（亦可 N_STANDALONE=1 單行 N 段）。
source scripts/e2e-notify-gate.sh
run_notify_gate

# ══════════════ E. cwi-master B4（Part E PAIN_TRIAGE + Lexicon）T97–T104 ══════════════
# 核心：「牙痛」唔再自動紅標（詞觸發 → 流程結論觸發）：牙痛 → PAIN intent → PAIN_TRIAGE 問診 session；
# 升級由確定性紅旗規則決定（FLOOR ∪ params ∪ slots ∪ severity ∪ 術後），LLM 只抽槽唔判級（鐵律）。
# T13 = 新語義迴歸（FLOOR 詞仍直升）。七閘 URGENT/COMPLAINT 語義零改動（T13/T20/W/N 段全跑）。
echo "[E/8] Part E: PAIN_TRIAGE + Lexicon (T97-T104)"
# 專用 worker：WORKFLOW_PARAMS_TTL_MS=0 → T102 params 即時生效/還原（唔等 TTL）
pkill -f "src/workers/index.ts" 2>/dev/null || true
sleep 1
WORKFLOW_PARAMS_TTL_MS=0 nohup pnpm worker >/tmp/e2e-worker-pain.log 2>&1 &
WORKER_PID=$!
for i in $(seq 1 60); do grep -q "all workers running" /tmp/e2e-worker-pain.log 2>/dev/null && break; sleep 1; done
grep -q "all workers running" /tmp/e2e-worker-pain.log 2>/dev/null || { echo "  ❌ FATAL: E worker 未起"; FAIL=$((FAIL + 1)); }

# E0：TKW → DRAFT（L1 草稿唔自動發 — 決定性斷言；T100 出口固定 L1 俾 staff）
patch_aimode "$TKW_CLINIC_ID" DRAFT /tmp/e2e-e0.json; CODE=$PAM_CODE
check "E0 TKW aiMode=DRAFT → 200" "$CODE" "200"

# ── T97. 「我牙痛」唔紅標（新語義 — 進 PAIN_TRIAGE 問診）──────────────────────────────
E97_WA="8526781${EPOCH}"; E97_WID="wamid.E2E_E97_${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$E97_WA" --text "我牙痛" --wamid "$E97_WID" --name "E2E E97" >/dev/null || fail "T97 POST"
if wait_for "SELECT c.\"intent\" i, (c.\"urgent\")::text ug, c.\"urgency\" u FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$E97_WA'" '[{"i":"PAIN","ug":"false","u":"MED"}]' 30; then
  pass "T97 「我牙痛」→ PAIN（唔紅標）"
else
  fail "T97 PAIN 唔紅標"
fi
E97_CONV=$(q "SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$E97_WA'" | jf id)
check "T97 問診 session ACTIVE" "$(q "SELECT count(*)::text c FROM \"PainTriageSession\" s WHERE s.\"conversationId\"='$E97_CONV' AND s.\"status\"='ACTIVE'" | jf c)" "1"
E97_Q=$(q "SELECT \"body\" b FROM \"Message\" WHERE \"conversationId\"='$E97_CONV' AND \"direction\"='OUT' AND type='text' ORDER BY \"createdAt\" DESC LIMIT 1" | jf b)
case "$E97_Q" in
  *邊隻牙痛*) pass "T97 第一問已發（location）" ;;
  *) fail "T97 第一問已發（got: ${E97_Q:0:40}）" ;;
esac
check "T97 零紅旗 notice" "$(q "SELECT count(*)::text c FROM \"StaffNotice\" WHERE \"conversationId\"='$E97_CONV'" | jf c)" "0"
check "T97 零 draft（問診中）" "$(q "SELECT count(*)::text c FROM \"AiDraft\" WHERE \"conversationId\"='$E97_CONV'" | jf c)" "0"

# ── T98. 問診中講腫 → URGENT 全套（紅標 + StaffNotice + escalation + AI 收聲）────────
E98_WA="8526782${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$E98_WA" --text "我牙痛" --wamid "wamid.E2E_E98a_${EPOCH}" --name "E2E E98" >/dev/null || fail "T98 POST1"
wait_for "SELECT count(*)::text c FROM \"PainTriageSession\" s JOIN \"Conversation\" c ON c.id=s.\"conversationId\" JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$E98_WA' AND s.\"status\"='ACTIVE'" '[{"c":"1"}]' 30
sleep 2
E98_CONV=$(q "SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$E98_WA'" | jf id)
E98_OUT_BEFORE=$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$E98_CONV' AND \"direction\"='OUT' AND type='text'" | jf c)
pnpm -s mock-inbound message --clinic TKW --from "$E98_WA" --text "右後牙，塊面腫咗" --wamid "wamid.E2E_E98b_${EPOCH}" --name "E2E E98" >/dev/null || fail "T98 POST2"
if wait_for "SELECT c.\"intent\" i, (c.\"urgent\")::text ug, c.\"urgency\" u FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$E98_WA'" '[{"i":"URGENT_PAIN","ug":"true","u":"HIGH"}]' 30; then
  pass "T98 問診中紅旗 → URGENT_PAIN（紅標）"
else
  fail "T98 URGENT_PAIN"
fi
check "T98 session COMPLETED" "$(q "SELECT s.\"status\"::text st FROM \"PainTriageSession\" s WHERE s.\"conversationId\"='$E98_CONV'" | jf st)" "COMPLETED"
check "T98 closeReason=RED_FLAG" "$(q "SELECT s.\"closeReason\" r FROM \"PainTriageSession\" s WHERE s.\"conversationId\"='$E98_CONV'" | jf r)" "RED_FLAG"
check "T98 StaffNotice URGENT_ESCALATION" "$(q "SELECT count(*)::text c FROM \"StaffNotice\" WHERE \"conversationId\"='$E98_CONV' AND kind='URGENT_ESCALATION'" | jf c)" "1"
E98_OUT_AFTER=$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$E98_CONV' AND \"direction\"='OUT' AND type='text'" | jf c)
check "T98 AI 收聲（零新 OUT）" "$E98_OUT_AFTER" "$E98_OUT_BEFORE"
check "T98 零 draft（鐵律 3）" "$(q "SELECT count(*)::text c FROM \"AiDraft\" WHERE \"conversationId\"='$E98_CONV'" | jf c)" "0"
grep -q "URGENT_ESCALATE" /tmp/e2e-worker-pain.log 2>/dev/null && pass "T98 worker log URGENT_ESCALATE effect" || fail "T98 worker log URGENT_ESCALATE"

# ── T99. severity threshold 8 分界：9 → 紅旗 / 5 → 唔升級 ──────────────────────────
E99A_WA="8526783${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$E99A_WA" --text "我牙痛" --wamid "wamid.E2E_E99a1_${EPOCH}" --name "E2E E99A" >/dev/null || fail "T99A POST1"
wait_for "SELECT count(*)::text c FROM \"PainTriageSession\" s JOIN \"Conversation\" c ON c.id=s.\"conversationId\" JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$E99A_WA' AND s.\"status\"='ACTIVE'" '[{"c":"1"}]' 30
sleep 2
pnpm -s mock-inbound message --clinic TKW --from "$E99A_WA" --text "右後牙，痛9分" --wamid "wamid.E2E_E99a2_${EPOCH}" --name "E2E E99A" >/dev/null || fail "T99A POST2"
if wait_for "SELECT (c.\"urgent\")::text ug FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$E99A_WA'" '[{"ug":"true"}]' 30; then
  pass "T99 severity 9 >= 8 → 紅旗（urgent）"
else
  fail "T99A severity 9 紅旗"
fi
E99B_WA="8526784${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$E99B_WA" --text "我牙痛" --wamid "wamid.E2E_E99b1_${EPOCH}" --name "E2E E99B" >/dev/null || fail "T99B POST1"
wait_for "SELECT count(*)::text c FROM \"PainTriageSession\" s JOIN \"Conversation\" c ON c.id=s.\"conversationId\" JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$E99B_WA' AND s.\"status\"='ACTIVE'" '[{"c":"1"}]' 30
sleep 2
pnpm -s mock-inbound message --clinic TKW --from "$E99B_WA" --text "左前牙，痛5分" --wamid "wamid.E2E_E99b2_${EPOCH}" --name "E2E E99B" >/dev/null || fail "T99B POST2"
wait_for "SELECT s.\"turns\" t FROM \"PainTriageSession\" s JOIN \"Conversation\" c ON c.id=s.\"conversationId\" JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$E99B_WA'" '[{"t":2}]' 30
check "T99 severity 5 < 8 → 唔升級" "$(q "SELECT (c.\"urgent\")::text ug FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$E99B_WA'" | jf ug)" "false"
check "T99 session 仍 ACTIVE（問診繼續）" "$(q "SELECT s.\"status\"::text st FROM \"PainTriageSession\" s JOIN \"Conversation\" c ON c.id=s.\"conversationId\" JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$E99B_WA'" | jf st)" "ACTIVE"

# ── T100. 完整問診 → L1 草稿 + 病人覆日期接 booking（自然接手，無橋）────────────────
E100_WA="8526785${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$E100_WA" --text "我牙痛" --wamid "wamid.E2E_E100a_${EPOCH}" --name "E2E E100" >/dev/null || fail "T100 POST1"
wait_for "SELECT count(*)::text c FROM \"PainTriageSession\" s JOIN \"Conversation\" c ON c.id=s.\"conversationId\" JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$E100_WA' AND s.\"status\"='ACTIVE'" '[{"c":"1"}]' 30
sleep 2
# turn 2：一把答晒（mock 決定性抽槽）— 紅旗類（腫/術後/紅旗症狀）+ severity + location 全填
pnpm -s mock-inbound message --clinic TKW --from "$E100_WA" --text "右後牙，痛咗2日，痛3分，一停就冇，唔會自己痛，夜晚冇，咬唔痛，冇做過，冇腫" --wamid "wamid.E2E_E100b_${EPOCH}" --name "E2E E100" >/dev/null || fail "T100 POST2"
E100_CONV=$(q "SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$E100_WA'" | jf id)
wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$E100_CONV' AND \"direction\"='OUT' AND type='text' AND \"body\" LIKE '%流血止唔到%'" '[{"c":"1"}]' 30
# turn 3：答紅旗問題「冇」→ 完成條件齊（紅旗類問完 + severity + location）→ 出口 E.5
pnpm -s mock-inbound message --clinic TKW --from "$E100_WA" --text "冇" --wamid "wamid.E2E_E100c_${EPOCH}" --name "E2E E100" >/dev/null || fail "T100 POST3"
if wait_for "SELECT s.\"status\"::text st, s.\"closeReason\" r, s.\"impression\" im FROM \"PainTriageSession\" s WHERE s.\"conversationId\"='$E100_CONV'" '[{"st":"COMPLETED","r":"COMPLETED","im":"sensitivity"}]' 30; then
  pass "T100 完整問診 → COMPLETED + impression sensitivity"
else
  fail "T100 COMPLETED + sensitivity"
fi
check "T100 L1 草稿（pain-triage-engine）" "$(q "SELECT count(*)::text c FROM \"AiDraft\" WHERE \"conversationId\"='$E100_CONV' AND model='pain-triage-engine'" | jf c)" "1"
E100_DRAFT=$(q "SELECT \"draftText\" d FROM \"AiDraft\" WHERE \"conversationId\"='$E100_CONV' AND model='pain-triage-engine'" | jf d)
case "$E100_DRAFT" in
  *先確定*想約邊日*) pass "T100 草稿三句式結構（②未確診 ③下一步）" ;;
  *) fail "T100 草稿三句式結構（got: ${E100_DRAFT:0:60}）" ;;
esac
case "$E100_DRAFT" in
  *常見原因*) pass "T100 草稿①句 = 白名單措辭（常見原因…）" ;;
  *) fail "T100 草稿①句白名單措辭（got: ${E100_DRAFT:0:60}）" ;;
esac
case "$E100_DRAFT" in
  *確診*|*你係*|*一定要*) fail "T100 措辭鐵律（禁詞出現）" ;;
  *) pass "T100 措辭鐵律（零禁詞）" ;;
esac
E100_SA=$(q "SELECT (\"aiSummary\" LIKE '%右後牙%')::text a FROM \"Conversation\" WHERE id='$E100_CONV'" | jf a)
E100_SB=$(q "SELECT (\"aiSummary\" LIKE '%傾向%')::text b FROM \"Conversation\" WHERE id='$E100_CONV'" | jf b)
check "T100 aiSummary 結構化（右後牙）" "$E100_SA" "true"
check "T100 aiSummary 結構化（傾向）" "$E100_SB" "true"
# 病人覆日期 → BOOKING_REQUEST → 現有 booking 流程自然接手（L1 draft — 無 policy = 無 session）
pnpm -s mock-inbound message --clinic TKW --from "$E100_WA" --text "你好，我想預約下週" --wamid "wamid.E2E_E100d_${EPOCH}" --name "E2E E100" >/dev/null || fail "T100 POST4"
if wait_for "SELECT \"intent\" i FROM \"Conversation\" WHERE id='$E100_CONV'" '[{"i":"BOOKING_REQUEST"}]' 30; then
  # a2 fix（2026-09-03）：原 `c.\"intent\"` 冇 alias c → SQLSTATE 42P01 → q() 吞 stderr → 30s 全空假紅（run3 T100 死因；產品行為正確 — worker log + DB 雙證）
  pass "T100 病人覆日期 → BOOKING_REQUEST（自然接手）"
else
  fail "T100 BOOKING_REQUEST"
fi
check "T100 booking 流程 draft 生成" "$(q "SELECT count(*)::text c FROM \"AiDraft\" WHERE \"conversationId\"='$E100_CONV' AND intent='BOOKING_REQUEST'" | jf c)" "1"
check "T100 pain draft 保留（總 2）" "$(q "SELECT count(*)::text c FROM \"AiDraft\" WHERE \"conversationId\"='$E100_CONV'" | jf c)" "2"

# ── T101. lexicon：「cool牙」→ 矯齒（canonical 入 aiSummary — 可觀察渠道）─────────
E101_WA="8526786${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$E101_WA" --text "我cool牙，牙痛" --wamid "wamid.E2E_E101_${EPOCH}" --name "E2E E101" >/dev/null || fail "T101 POST"
wait_for "SELECT c.\"intent\" i FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$E101_WA'" '[{"i":"PAIN"}]' 30
E101_SUM=$(q "SELECT c.\"aiSummary\" s FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$E101_WA'" | jf s)
case "$E101_SUM" in
  *矯齒*) pass "T101 lexicon：cool牙 → 矯齒（canonical）" ;;
  *) fail "T101 lexicon canonical（got: ${E101_SUM:0:60}）" ;;
esac
case "$E101_SUM" in
  *cool牙*) fail "T101 lexicon：原文 cool牙 仍喺" ;;
  *) pass "T101 lexicon：原文 cool牙 已 canonical 化" ;;
esac

# ── T102. params 加詞即生效 + 刪 FLOOR 被拒（zod refine 400）────────────────────────
# 3 條問題最小合法 params（questions min 3）；exitDraftTemplate 用 code 默認結構
E_PT_Q3='[{"id":"q-location","slot":"toothLocation","text":"想先了解邊隻牙痛？（例如：右後牙）","enabled":true,"order":0},{"id":"q-duration","slot":"durationDays","text":"痛咗幾耐呀？","enabled":true,"order":1},{"id":"q-severity","slot":"severity","text":"而家痛幾痛？1–10 分","enabled":true,"order":2}]'
E_PT_TPL='{impression}實際情況要{examination}睇過先確定。呢類情況建議{window}返嚟檢查，想約邊日？'
wf_put pain-triage "" "{\"questions\":$E_PT_Q3,\"redFlagTerms\":{\"severe_pain\":[\"痛到崩潰\"]},\"exitDraftTemplate\":\"$E_PT_TPL\"}"
check "T102 PUT pain-triage（附加詞 痛到崩潰）→ 201" "$W_CODE" "201"
E_PT_V1=$(echo "$W_OUT" | jf id)
wf_publish pain-triage "$E_PT_V1"
check "T102 publish v1 → 200" "$W_CODE" "200"
E102_WA="8526787${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$E102_WA" --text "我牙痛到崩潰" --wamid "wamid.E2E_E102_${EPOCH}" --name "E2E E102" >/dev/null || fail "T102 POST"
if wait_for "SELECT c.\"intent\" i, (c.\"urgent\")::text ug FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$E102_WA'" '[{"i":"URGENT_PAIN","ug":"true"}]' 30; then
  pass "T102 params 加詞即生效（fast path 確定性 → URGENT_PAIN）"
else
  fail "T102 加詞即生效"
fi
check "T102 fast path 唔開問診 session" "$(q "SELECT count(*)::text c FROM \"PainTriageSession\" s JOIN \"Conversation\" c ON c.id=s.\"conversationId\" JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$E102_WA'" | jf c)" "0"
# （b）FLOOR 詞寫入附加欄 → 400（「刪 FLOOR」物理上無路徑）
wf_put pain-triage "" "{\"questions\":$E_PT_Q3,\"redFlagTerms\":{\"bleeding\":[\"流血不止\"]},\"exitDraftTemplate\":\"$E_PT_TPL\"}"
check "T102 FLOOR 詞入附加欄 → 400（刪 FLOOR 被拒）" "$W_CODE" "400"
# （c）還原 defaults（12 條全問題 — 保護後續段）
E_PT_Q12='[{"id":"q-location","slot":"toothLocation","text":"想先了解邊隻牙痛？（例如：右後牙 / 左前牙 / 智慧齒）","enabled":true,"order":0},{"id":"q-duration","slot":"durationDays","text":"痛咗幾耐呀？（例如：2 日 / 一星期）","enabled":true,"order":1},{"id":"q-stimulus","slot":"stimulusLinger","text":"食凍熱嘢嗰陣痛，停咗之後痛會即收，定係持續幾分鐘？","enabled":true,"order":2},{"id":"q-spontaneous","slot":"spontaneousPain","text":"唔食嘢嘅時候會唔會自己痛？","enabled":true,"order":3},{"id":"q-night","slot":"nightPain","text":"瞓覺嗰陣會唔會痛醒？","enabled":true,"order":4},{"id":"q-bite","slot":"bitePain","text":"咬嘢嗰陣會唔會痛？","enabled":true,"order":5},{"id":"q-recent","slot":"recentTreatment","text":"最近兩星期有冇做過牙醫治療（補牙 / 杜牙根 / 拔牙）？","enabled":true,"order":6},{"id":"q-swelling","slot":"swelling","text":"面、頸或者眼有冇腫？","enabled":true,"order":7},{"id":"q-redflag","slot":"redFlagSymptoms","text":"有冇以下情況：流血止唔到、發燒、吞唔到嘢 / 呼吸唔順、外傷？如果有請即刻講。","enabled":true,"order":8},{"id":"q-severity","slot":"severity","text":"而家痛幾痛？1–10 分（10 = 痛到忍唔到）","enabled":true,"order":9},{"id":"q-impact","slot":"functionalImpact","text":"有冇影響到你？（食唔食到嘢 / 講嘢痛 / 瞓唔瞓到）","enabled":true,"order":10},{"id":"q-photo","slot":"photo","text":"方便嘅話俾張痛嗰邊嘅相，醫生可以預先睇（唔強制）。","enabled":true,"order":11}]'
wf_put pain-triage "" "{\"questions\":$E_PT_Q12,\"redFlagTerms\":{},\"exitDraftTemplate\":\"$E_PT_TPL\"}"
check "T102 PUT defaults 還原 → 201" "$W_CODE" "201"
E_PT_V2=$(echo "$W_OUT" | jf id)
wf_publish pain-triage "$E_PT_V2"
check "T102 publish defaults → 200" "$W_CODE" "200"

# ── T103. 術後自動判（E.7：phoneHash match + 窗口內 appointment → autoPostOp 即紅旗）─
E103_WA="8526788${EPOCH}"
E103_HASH=$(npx tsx -e 'import { phoneHash } from "./src/lib/phone-hash"; console.log(phoneHash(process.argv[1]));' "$E103_WA" 2>/dev/null | tail -1)
[ "${#E103_HASH}" = "64" ] || fail "T103 phoneHash 計算失敗（${E103_HASH:0:16}）"
E103_DATE=$(date -d 'yesterday' +%F)
cat > .dev/workforce-mock-patients.json <<EOJSON
{"byPhoneHash":{"$E103_HASH":{"matches":[{"patientApricotId":"apr-e2e-t103","patientCode":"E2E-T103","patientName":"E2E T103","lastVisit":{"date":"$E103_DATE","providerName":"E2E DR","visitReasons":["e2e"]}}],"appointments":[{"apricotApptId":"apt-e2e-t103","clinicCode":"TKW","providerApricotId":"prov-e2e-t103","providerName":"E2E DR","date":"$E103_DATE","start":"10:00","end":"10:30","bookingStatus":1,"patientApricotId":"apr-e2e-t103","patientCode":"E2E-T103","patientName":"E2E T103","visitReasons":["e2e"],"remarks":null}]}}}
EOJSON
pnpm -s mock-inbound message --clinic TKW --from "$E103_WA" --text "我牙痛" --wamid "wamid.E2E_E103_${EPOCH}" --name "E2E E103" >/dev/null || fail "T103 POST"
if wait_for "SELECT c.\"intent\" i, (c.\"urgent\")::text ug FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$E103_WA'" '[{"i":"URGENT_PAIN","ug":"true"}]' 30; then
  pass "T103 術後窗口內 → autoPostOp 即紅旗"
else
  fail "T103 auto post-op"
fi
E103_CONV=$(q "SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$E103_WA'" | jf id)
check "T103 session autoPostOp=true" "$(q "SELECT (s.\"autoPostOp\")::text a FROM \"PainTriageSession\" s WHERE s.\"conversationId\"='$E103_CONV'" | jf a)" "true"
check "T103 closeReason=RED_FLAG" "$(q "SELECT s.\"closeReason\" r FROM \"PainTriageSession\" s WHERE s.\"conversationId\"='$E103_CONV'" | jf r)" "RED_FLAG"
grep -q "pain-triage: auto post-op hit" /tmp/e2e-worker-pain.log 2>/dev/null && pass "T103 log: auto post-op hit" || fail "T103 log auto post-op hit"
rm -f .dev/workforce-mock-patients.json

# ── T104. 「流血不止」fast path（FLOOR 詞 — 唔問診直接 URGENT）───────────────────────
E104_WA="8526789${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$E104_WA" --text "我牙流血不止" --wamid "wamid.E2E_E104_${EPOCH}" --name "E2E E104" >/dev/null || fail "T104 POST"
if wait_for "SELECT c.\"intent\" i, (c.\"urgent\")::text ug, c.\"urgency\" u FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$E104_WA'" '[{"i":"URGENT_PAIN","ug":"true","u":"HIGH"}]' 30; then
  pass "T104 FLOOR 詞（流血不止）fast path → URGENT_PAIN"
else
  fail "T104 fast path"
fi
check "T104 無問診 session（唔問診）" "$(q "SELECT count(*)::text c FROM \"PainTriageSession\" s JOIN \"Conversation\" c ON c.id=s.\"conversationId\" JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$E104_WA'" | jf c)" "0"
check "T104 零 draft（鐵律 3）" "$(q "SELECT count(*)::text c FROM \"AiDraft\" d JOIN \"Conversation\" cv ON cv.id=d.\"conversationId\" JOIN \"Contact\" x ON x.id=cv.\"contactId\" WHERE x.\"waId\"='$E104_WA'" | jf c)" "0"
check "T104 StaffNotice URGENT_ESCALATION" "$(q "SELECT count(*)::text c FROM \"StaffNotice\" n JOIN \"Conversation\" cv ON cv.id=n.\"conversationId\" JOIN \"Contact\" x ON x.id=cv.\"contactId\" WHERE x.\"waId\"='$E104_WA' AND n.kind='URGENT_ESCALATION'" | jf c)" "1"
pass "E 段完成：PAIN_TRIAGE + Lexicon（T97–T104 8 格）"


# ══════════════ F. cwi-master B5（Part F 知識庫 RAG + GoldenCase 評測）T120–T131 ══════════════
# MD §Part F + §8 表 F 行。mock worker（AI_MOCK=1）決定性路徑 + 兩支 unit script +
# eval/sample 真 sglang（T131）。fixture 前綴 852698x/852699x + EPOCH（13 個 waId）。
echo "[F/12] Part F: Knowledge RAG + GoldenCase (T120-T131)"
F_FAIL=0

# ── F0. 準備：seed 冪等 + 上輪 e2e GoldenCase 標記行清走（hermetic）──────────────
pnpm -s seed:knowledge >/tmp/e2e-f-seed.log 2>&1 || F_FAIL=1
check "F0 KnowledgeDoc 39 骨架（TKW seed 冪等）" "$(q "SELECT count(*)::text c FROM \"KnowledgeDoc\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND \"enabled\"=true" | jf c)" "39"
q "DELETE FROM \"GoldenCase\" WHERE \"note\" IN ('e2e-F-gate','e2e-F-deid')" >/dev/null 2>&1

# ── T120. 目錄選 id（stage 1 揀中嘅 id 全部喺 KnowledgeDoc；<knowledge> 入 prompt）──
F120_WA="8526980${EPOCH}"
F120_WID="wamid.E2E_F120_${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$F120_WA" --text "洗牙之後幾耐可以返工" --wamid "$F120_WID" --name "E2E F120" >/dev/null || fail "T120 POST"
F120_MSG=$(q "SELECT id v FROM \"Message\" WHERE \"waMessageId\"='$F120_WID'" | jf v)
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$F120_MSG'" '[{"s":"PROPOSED"}]' 30; then
  pass "T120 QUESTION 出 draft（PROPOSED）"
else
  fail "T120 draft PROPOSED"
fi
check "T120 traceJson.knowledge.ran=true" "$(q "SELECT (\"traceJson\"->'knowledge'->>'ran')::text v FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$F120_MSG'" | jf v)" "true"
check "T120 picked ≥1（目錄選中）" "$(q "SELECT CASE WHEN jsonb_array_length(\"traceJson\"->'knowledge'->'picked')>=1 THEN 'yes' ELSE 'no' END v FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$F120_MSG'" | jf v)" "yes"
F120_P0T=$(q "SELECT (\"traceJson\"->'knowledge'->'picked'->0->>'title') v FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$F120_MSG'" | jf v)
case "$F120_P0T" in
  *洗牙*) pass "T120 picked[0] = 洗牙 相關（${F120_P0T:0:20}）" ;;
  *) fail "T120 picked[0] 唔係洗牙相關（got: ${F120_P0T:0:30}）" ;;
esac
F120_IDS=$(q "SELECT coalesce(string_agg(distinct p->>'id',','),'') v FROM \"AiDraft\" d CROSS JOIN LATERAL jsonb_array_elements(d.\"traceJson\"->'knowledge'->'picked') p WHERE d.\"inReplyToMessageId\"='$F120_MSG'" | jf v)
F120_N=$(q "SELECT jsonb_array_length(d.\"traceJson\"->'knowledge'->'picked')::text v FROM \"AiDraft\" d WHERE d.\"inReplyToMessageId\"='$F120_MSG'" | jf v)
F120_MATCH=$(q "SELECT count(*)::text v FROM \"KnowledgeDoc\" WHERE id=ANY(string_to_array('$F120_IDS',','))" | jf v)
check "T120 picked ids 全部喺 KnowledgeDoc（無幻覺）" "$F120_MATCH" "$F120_N"

# ── T121. 幻覺 id 丟棄（目錄外 id → 丟棄 + log + picked 淨真 id）─────────────────
F121_WA="8526981${EPOCH}"
F121_WID="wamid.E2E_F121_${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$F121_WA" --text "洗牙之後幾耐可以返工 E2E-KNOWLEDGE-HALLUCINATE" --wamid "$F121_WID" --name "E2E F121" >/dev/null || fail "T121 POST"
F121_MSG=$(q "SELECT id v FROM \"Message\" WHERE \"waMessageId\"='$F121_WID'" | jf v)
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$F121_MSG'" '[{"s":"PROPOSED"}]' 30; then
  pass "T121 幻覺後照出 draft（PROPOSED）"
else
  fail "T121 draft"
fi
check "T121 discarded=1（幻覺 id 計數）" "$(q "SELECT (\"traceJson\"->'knowledge'->>'discarded')::text v FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$F121_MSG'" | jf v)" "1"
check "T121 picked 冇 fake id" "$(q "SELECT count(*)::text v FROM \"AiDraft\" d CROSS JOIN LATERAL jsonb_array_elements(d.\"traceJson\"->'knowledge'->'picked') p WHERE d.\"inReplyToMessageId\"='$F121_MSG' AND (p->>'id')='e2e-hallucinated-id'" | jf v)" "0"
sleep 1
grep -q "hallucinated id" /tmp/e2e-worker*.log 2>/dev/null && pass "T121 log: knowledge: hallucinated id — 丟棄" || fail "T121 log hallucinated id"

# ── T122. timeout fail-soft（3s timeout → 跳過 RAG 照出草稿）─────────────────────
F122_WA="8526982${EPOCH}"
F122_WID="wamid.E2E_F122_${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$F122_WA" --text "洗牙之後幾耐可以返工 E2E-KNOWLEDGE-TIMEOUT" --wamid "$F122_WID" --name "E2E F122" >/dev/null || fail "T122 POST"
F122_MSG=$(q "SELECT id v FROM \"Message\" WHERE \"waMessageId\"='$F122_WID'" | jf v)
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$F122_MSG'" '[{"s":"PROPOSED"}]' 30; then
  pass "T122 timeout fail-soft：草稿照出（PROPOSED）"
else
  fail "T122 fail-soft draft"
fi
check "T122 skipped=timeout" "$(q "SELECT (\"traceJson\"->'knowledge'->>'skipped')::text v FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$F122_MSG'" | jf v)" "timeout"
check "T122 picked=0" "$(q "SELECT jsonb_array_length(\"traceJson\"->'knowledge'->'picked')::text v FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$F122_MSG'" | jf v)" "0"
sleep 1
grep -q "stage1 mock timeout" /tmp/e2e-worker*.log 2>/dev/null && pass "T122 log: stage1 mock timeout — 跳過 RAG" || fail "T122 log timeout"

# ── T122b. L2 自動覆前提：價錢問題 + 零引用 → 強制降 L1（AUTO 模式實測）──────────────
#   範圍 = priceIntent（MD F.3；非價錢 QUESTION 維持 F 前行為 — W1/W4 回歸綠）。
#   洗耳 = 目錄外服務：stage1 timeout + keyword fallback 都撳唔到 PRICE doc → 零引用 → block + needsHuman。
patch_aimode "$TKW_CLINIC_ID" AUTO
case "$PAM_CODE" in 200) pass "T122b PATCH TKW aiMode=AUTO → 200" ;; *) fail "T122b PATCH AUTO（code=$PAM_CODE）" ;; esac
F122B_WA="8526983${EPOCH}"
F122B_WID="wamid.E2E_F122B_${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$F122B_WA" --text "洗耳幾錢 E2E-KNOWLEDGE-TIMEOUT" --wamid "$F122B_WID" --name "E2E F122B" >/dev/null || fail "T122b POST"
F122B_MSG=$(q "SELECT id v FROM \"Message\" WHERE \"waMessageId\"='$F122B_WID'" | jf v)
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$F122B_MSG'" '[{"s":"PROPOSED"}]' 30; then
  pass "T122b 價錢問題+零引用唔自動發（draft 停留 PROPOSED）"
else
  fail "T122b PROPOSED"
fi
sleep 1
check "T122b 零自動發 OUT" "$(q "SELECT count(*)::text c FROM \"Message\" m JOIN \"Conversation\" cv ON cv.id=m.\"conversationId\" JOIN \"Contact\" x ON x.id=cv.\"contactId\" WHERE x.\"waId\"='$F122B_WA' AND m.direction='OUT' AND m.\"aiAutoSent\"=true" | jf c)" "0"
grep -q "no-knowledge-citation" /tmp/e2e-worker*.log 2>/dev/null && pass "T122b log: no-knowledge-citation block" || fail "T122b log no-knowledge-citation"
patch_aimode "$TKW_CLINIC_ID" DRAFT
case "$PAM_CODE" in 200) pass "T122b 還原 TKW aiMode=DRAFT → 200" ;; *) fail "T122b 還原 DRAFT（code=$PAM_CODE）" ;; esac

# ── T123. price-guard ①：零 PRICE 引用幻覺價 → 棄用改人手提示版 ─────────────────
F123_WA="8526984${EPOCH}"
F123_WID="wamid.E2E_F123_${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$F123_WA" --text "醫院有冇停車場 E2E-PRICE-LEAK" --wamid "$F123_WID" --name "E2E F123" >/dev/null || fail "T123 POST"
F123_MSG=$(q "SELECT id v FROM \"Message\" WHERE \"waMessageId\"='$F123_WID'" | jf v)
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$F123_MSG'" '[{"s":"PROPOSED"}]' 30; then
  pass "T123 draft 存在（PROPOSED）"
else
  fail "T123 draft"
fi
check "T123 幻覺價被擋 → 人手提示版（無 $ 金額）" "$(q "SELECT CASE WHEN \"draftText\" LIKE '%問返同事%' AND \"draftText\" NOT LIKE '%$%' THEN 'yes' ELSE 'no' END v FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$F123_MSG'" | jf v)" "yes"
check "T123 trace guard.blocked=true" "$(q "SELECT (\"traceJson\"->'price'->'guard'->>'blocked')::text v FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$F123_MSG'" | jf v)" "true"
sleep 1
grep -q "unsourced amount blocked" /tmp/e2e-worker*.log 2>/dev/null && pass "T123 log: price: unsourced amount blocked" || fail "T123 log unsourced amount"

# ── T124. price-guard ②：有 PRICE 引用漏 disclaimer → code 自動 append ──────────
F124_WA="8526985${EPOCH}"
F124_WID="wamid.E2E_F124_${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$F124_WA" --text "洗牙有冇需要注意 E2E-PRICE-NODISC" --wamid "$F124_WID" --name "E2E F124" >/dev/null || fail "T124 POST"
F124_MSG=$(q "SELECT id v FROM \"Message\" WHERE \"waMessageId\"='$F124_WID'" | jf v)
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$F124_MSG'" '[{"s":"PROPOSED"}]' 30; then
  pass "T124 draft 存在（PROPOSED）"
else
  fail "T124 draft"
fi
check "T124 草稿含範圍 600–1200" "$(q "SELECT CASE WHEN \"draftText\" LIKE '%600–1200%' THEN 'yes' ELSE 'no' END v FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$F124_MSG'" | jf v)" "yes"
check "T124 disclaimer 自動 append" "$(q "SELECT CASE WHEN \"draftText\" LIKE '%以到診評估同前台報價為準%' THEN 'yes' ELSE 'no' END v FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$F124_MSG'" | jf v)" "yes"
check "T124 trace guard.disclaimerAppended=true + blocked=false" "$(q "SELECT (\"traceJson\"->'price'->'guard'->>'disclaimerAppended')::text||'|'||(\"traceJson\"->'price'->'guard'->>'blocked')::text v FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$F124_MSG'" | jf v)" "true|false"

# ── T125. price-guard ③：金額出 [priceMin,priceMax] → 棄用改人手提示版 ──────────
F125_WA="8526986${EPOCH}"
F125_WID="wamid.E2E_F125_${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$F125_WA" --text "洗牙有冇需要注意 E2E-PRICE-OUTRANGE" --wamid "$F125_WID" --name "E2E F125" >/dev/null || fail "T125 POST"
F125_MSG=$(q "SELECT id v FROM \"Message\" WHERE \"waMessageId\"='$F125_WID'" | jf v)
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$F125_MSG'" '[{"s":"PROPOSED"}]' 30; then
  pass "T125 draft 存在（PROPOSED）"
else
  fail "T125 draft"
fi
check "T125 出範圍價被擋 → 人手提示版" "$(q "SELECT CASE WHEN \"draftText\" LIKE '%問返同事%' AND \"draftText\" NOT LIKE '%\$5000%' THEN 'yes' ELSE 'no' END v FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$F125_MSG'" | jf v)" "yes"
check "T125 trace guard.outOfRange=true + blocked=true" "$(q "SELECT (\"traceJson\"->'price'->'guard'->>'outOfRange')::text||'|'||(\"traceJson\"->'price'->'guard'->>'blocked')::text v FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$F125_MSG'" | jf v)" "true|true"
sleep 1
grep -q "out-of-range amount" /tmp/e2e-worker*.log 2>/dev/null && pass "T125 log: price: out-of-range amount" || fail "T125 log out-of-range"

# ── T126. 全鏈：問診 → impression → 報價（同一對話）────────────────────────────
F126_WA="8526987${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$F126_WA" --text "我牙痛" --wamid "wamid.E2E_F126a_${EPOCH}" --name "E2E F126" >/dev/null || fail "T126 POST1"
if wait_for "SELECT count(*)::text c FROM \"PainTriageSession\" s JOIN \"Conversation\" cv ON cv.id=s.\"conversationId\" JOIN \"Contact\" x ON x.id=cv.\"contactId\" WHERE x.\"waId\"='$F126_WA' AND s.\"status\"='ACTIVE'" '[{"c":"1"}]' 30; then
  pass "T126 問診 session ACTIVE（PAIN 入場）"
else
  fail "T126 session ACTIVE"
fi
sleep 2
pnpm -s mock-inbound message --clinic TKW --from "$F126_WA" --text "右後牙，痛咗2日，痛3分，一停就冇，唔會自己痛，夜晚冇，咬唔痛，冇做過，冇腫" --wamid "wamid.E2E_F126b_${EPOCH}" --name "E2E F126" >/dev/null || fail "T126 POST2"
F126_CONV=$(q "SELECT c.id v FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$F126_WA'" | jf v)
wait_for "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$F126_CONV' AND \"direction\"='OUT' AND type='text' AND \"body\" LIKE '%流血止唔到%'" '[{"c":"1"}]' 30
pnpm -s mock-inbound message --clinic TKW --from "$F126_WA" --text "冇" --wamid "wamid.E2E_F126c_${EPOCH}" --name "E2E F126" >/dev/null || fail "T126 POST3"
if wait_for "SELECT s.\"status\"::text st, s.\"closeReason\"::text r, s.\"impression\"::text im FROM \"PainTriageSession\" s WHERE s.\"conversationId\"='$F126_CONV'" '[{"st":"COMPLETED","r":"COMPLETED","im":"sensitivity"}]' 30; then
  pass "T126 問診完成 → impression=sensitivity"
else
  fail "T126 COMPLETED+sensitivity"
fi
F126_PAIN_DRAFT=$(q "SELECT \"draftText\" v FROM \"AiDraft\" WHERE \"conversationId\"='$F126_CONV' AND model='pain-triage-engine'" | jf v)
case "$F126_PAIN_DRAFT" in
  *先確定*想約邊日*) pass "T126 impression 三句式出口草稿（②未確診 ③下一步）" ;;
  *) fail "T126 三句式（got: ${F126_PAIN_DRAFT:0:60}）" ;;
esac
# 病人翻轉問價 → 報價鏈
F126_Q_WID="wamid.E2E_F126d_${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$F126_WA" --text "洗牙幾錢" --wamid "$F126_Q_WID" --name "E2E F126" >/dev/null || fail "T126 POST4"
F126_Q_MSG=$(q "SELECT id v FROM \"Message\" WHERE \"waMessageId\"='$F126_Q_WID'" | jf v)
if wait_for "SELECT \"status\"::text s FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$F126_Q_MSG'" '[{"s":"PROPOSED"}]' 30; then
  pass "T126 報價 QUESTION 出 draft（PROPOSED）"
else
  fail "T126 報價 draft"
fi
check "T126 報價 = 範圍 + 影響因素 + disclaimer（code 決定性）" "$(q "SELECT CASE WHEN \"draftText\" LIKE '%600–1200%' AND \"draftText\" LIKE '%影響因素%' AND \"draftText\" LIKE '%以到診評估同前台報價為準%' THEN 'yes' ELSE 'no' END v FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$F126_Q_MSG'" | jf v)" "yes"
F126_PRICE_DOC=$(q "SELECT id v FROM \"KnowledgeDoc\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND kind='PRICE' AND title='洗牙收費'" | jf v)
check "T126 trace price.docId = PRICE 洗牙 doc" "$(q "SELECT (\"traceJson\"->'price'->>'docId')::text v FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$F126_Q_MSG'" | jf v)" "$F126_PRICE_DOC"
check "T126 trace price.triggered=true + guard.blocked=false" "$(q "SELECT (\"traceJson\"->'price'->>'triggered')::text||'|'||(\"traceJson\"->'price'->'guard'->>'blocked')::text v FROM \"AiDraft\" WHERE \"inReplyToMessageId\"='$F126_Q_MSG'" | jf v)" "true|false"
check "T126 全鏈：同一對話 2 支 draft（問診 + 報價）" "$(q "SELECT count(*)::text c FROM \"AiDraft\" WHERE \"conversationId\"='$F126_CONV'" | jf c)" "2"

# ── T127. impression 七條 + fallback（unit：6 impression + post_op 紅旗 + fallback）─
if pnpm -s test:unit-impressions-f >/tmp/e2e-f-impressions.log 2>&1; then
  pass "T127 unit-impressions-f 全綠（六 impression + post_op 紅旗 + fallback + 爛模板兜底）"
else
  fail "T127 unit-impressions-f（見 /tmp/e2e-f-impressions.log）"
fi
check "T127 e2e 出口草稿含 ② 未確診（先確定）" "$(q "SELECT CASE WHEN \"draftText\" LIKE '%先確定%' THEN 'yes' ELSE 'no' END v FROM \"AiDraft\" WHERE \"conversationId\"='$F126_CONV' AND model='pain-triage-engine'" | jf v)" "yes"

# ── T128. 措辭 canary：出口/報價草稿零「確診/你係/一定要」─────────────────────────
F128_BAD=$(q "SELECT count(*)::text v FROM \"AiDraft\" WHERE \"conversationId\"='$F126_CONV' AND (\"draftText\" LIKE '%確診%' OR \"draftText\" LIKE '%你係%' OR \"draftText\" LIKE '%一定要%')" | jf v)
check "T128 全鏈草稿零禁詞（確診/你係/一定要）" "$F128_BAD" "0"

# ── T129. 相片只做 signal：唔入 AI 判斷 + 零 draft + 卡標「有相待人手睇」─────────
F129_WA="8526988${EPOCH}"
F129_WID="wamid.E2E_F129_${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$F129_WA" --text "e2e F129 photo" --media image --wamid "$F129_WID" --name "E2E F129" >/dev/null || fail "T129 POST media"
F129_CONV=$(q "SELECT c.id v FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$F129_WA'" | jf v)
if wait_for "SELECT count(*)::text c FROM \"StaffNotice\" WHERE \"conversationId\"='$F129_CONV' AND kind='MEDIA_RECEIVED'" '[{"c":"1"}]' 30; then
  pass "T129 相片 → StaffNotice MEDIA_RECEIVED"
else
  fail "T129 MEDIA_RECEIVED"
fi
check "T129 卡標：有相待人手睇（AI 唔判斷相片內容）" "$(q "SELECT CASE WHEN \"title\" LIKE '%有相待人手睇（AI 唔判斷相片內容）%' THEN 'yes' ELSE 'no' END v FROM \"StaffNotice\" WHERE \"conversationId\"='$F129_CONV' AND kind='MEDIA_RECEIVED'" | jf v)" "yes"
sleep 2
check "T129 相片零 AI draft（唔入判斷）" "$(q "SELECT count(*)::text c FROM \"AiDraft\" WHERE \"conversationId\"='$F129_CONV'" | jf c)" "0"
check "T129 相片零自動覆 OUT" "$(q "SELECT count(*)::text c FROM \"Message\" WHERE \"conversationId\"='$F129_CONV' AND \"direction\"='OUT'" | jf c)" "0"

# ── T130. deid 零 PII：prefill 去識別 + 入庫二次兜底 + 結構層無 conversationId ────
F130_WA="8526989${EPOCH}"
F130_WID="wamid.E2E_F130_${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$F130_WA" --text "我電話 91234567 想問下洗牙" --wamid "$F130_WID" --name "E2E F130" >/dev/null || fail "T130 POST"
F130_MSG=$(q "SELECT id v FROM \"Message\" WHERE \"waMessageId\"='$F130_WID'" | jf v)
[ -n "$F130_MSG" ] || fail "T130 message 未落庫"
F130_CODE=$(curl -s -o /tmp/e2e-f130-pre.json -w '%{http_code}' -b "$COOKIE_TKW" "$BASE/api/golden-cases/prefill?messageId=$F130_MSG")
check "T130 prefill 200（STAFF 自己店對話）" "$F130_CODE" "200"
F130_UTT=$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync("/tmp/e2e-f130-pre.json","utf8")).utterance||"")}catch{process.stdout.write("")}')
case "$F130_UTT" in
  *"<phone>"*) pass "T130 prefill utterance 電話 → <phone>" ;;
  *) fail "T130 prefill 電話未 deid（got: ${F130_UTT:0:40}）" ;;
esac
case "$F130_UTT" in
  *"91234567"*) fail "T130 prefill 殘留原始電話" ;;
  *) pass "T130 prefill 零原始電話" ;;
esac
node -e 'const u=require("fs").readFileSync("/tmp/e2e-f130-pre.json","utf8");const j=JSON.parse(u);require("fs").writeFileSync("/tmp/e2e-f130-post.json",JSON.stringify({clinicId:process.argv[1],utterance:j.utterance,contextBefore:[],expectIntent:"QUESTION",expectRedFlag:false,expectAutoOk:false,expectDocIds:[],note:"e2e-F-deid"}))' "$TKW_CLINIC_ID"
F130_POST=$(curl -s -o /tmp/e2e-f130-resp.json -w '%{http_code}' -b "$COOKIE_TKW" -X POST "$BASE/api/golden-cases" -H 'Content-Type: application/json' -d @/tmp/e2e-f130-post.json)
check "T130 STAFF 加入測試集 → 201" "$F130_POST" "201"
F130_GID=$(jf id < /tmp/e2e-f130-resp.json)
check "T130 入庫 utterance 零原始電話" "$(q "SELECT (NOT (\"utterance\" LIKE '%91234567%'))::text v FROM \"GoldenCase\" WHERE id='$F130_GID'" | jf v)" "true"
check "T130 GoldenCase 結構層無 conversationId/messageId 欄" "$(q "SELECT count(*)::text v FROM information_schema.columns WHERE table_name='GoldenCase' AND column_name IN ('conversationId','messageId')" | jf v)" "0"

# ── T131. eval 紅旗 gate 退出碼 1 + sample 未審核唔入 eval（真 sglang）──────────
# (a) MF 控制組：expectRedFlag=true 但句子無任何紅旗 → recall 0% → 硬 gate FAIL
q "INSERT INTO \"GoldenCase\" (id, \"clinicId\", source, utterance, \"contextBefore\", \"expectIntent\", \"expectRedFlag\", \"expectAutoOk\", \"expectDocIds\", note, enabled) VALUES ('e2e-fgate-${EPOCH}', '$MF_CLINIC_ID', 'MANUAL', '你好，想問下有冇做洗牙', '{}', 'QUESTION', true, false, '{}', 'e2e-F-gate', true)" >/dev/null 2>&1
pnpm -s eval:golden --clinic MF --limit 10 > /tmp/e2e-eval-mf.log 2>&1
F131_RC=$?
check "T131 eval 紅旗 recall 0% → 退出碼 1" "$F131_RC" "1"
F131_RPT=$(ls -t evals/reports/golden-*.json 2>/dev/null | head -1)
F131_GATE=$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(j.summary&&j.summary.redFlagRecall&&j.summary.redFlagRecall.fail===true?"fail":"pass")}catch(e){console.log("err")}' "$F131_RPT")
check "T131 報告 redFlagRecall.fail=true" "$F131_GATE" "fail"
# (b) golden:sample（真 Qwen 預標）→ HISTORY_SAMPLE enabled=false → eval 唔入
F131B_WA="8526990${EPOCH}"
pnpm -s mock-inbound message --clinic TKW --from "$F131B_WA" --text "你好" --wamid "wamid.E2E_F131a_${EPOCH}" --name "E2E F131" >/dev/null || fail "T131 POST conv"
F131B_CONV=$(q "SELECT c.id v FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\"='$F131B_WA'" | jf v)
q "INSERT INTO \"Message\" (id, \"conversationId\", direction, channel, type, body, status, \"waTimestamp\", \"createdAt\") VALUES ('e2e-f131-hist-${EPOCH}', '$F131B_CONV', 'IN', 'HISTORY', 'text', '我電話 98765432 想問洗牙幾耐好', 'RECEIVED', now() - interval '1 hour', now())" >/dev/null 2>&1
F131_FROM=$(date -u -d '-1 day' +%Y-%m-%dT%H:%M:%SZ)
pnpm -s golden:sample --clinic TKW --from "$F131_FROM" --limit 5 > /tmp/e2e-sample.log 2>&1
F131_SAMP=$(q "SELECT id v FROM \"GoldenCase\" WHERE \"clinicId\"='$TKW_CLINIC_ID' AND source='HISTORY_SAMPLE' AND \"utterance\" LIKE '%洗牙%' ORDER BY \"createdAt\" DESC LIMIT 1" | jf v)
[ -n "$F131_SAMP" ] && pass "T131 golden:sample 入庫（HISTORY_SAMPLE）" || fail "T131 sample 未入庫（見 /tmp/e2e-sample.log）"
check "T131 sample enabled=false（未審核）" "$(q "SELECT (enabled)::text v FROM \"GoldenCase\" WHERE id='$F131_SAMP'" | jf v)" "false"
check "T131 sample utterance 已 deid（零原始電話）" "$(q "SELECT (NOT (\"utterance\" LIKE '%98765432%'))::text v FROM \"GoldenCase\" WHERE id='$F131_SAMP'" | jf v)" "true"
pnpm -s eval:golden --clinic TKW --limit 50 > /tmp/e2e-eval-tkw.log 2>&1
F131B_RPT=$(ls -t evals/reports/golden-*.json 2>/dev/null | head -1)
F131B_IN=$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const sid=process.argv[2];console.log(Array.isArray(j.cases)&&j.cases.some(c=>c.id===sid)?"in":"out")}catch(e){console.log("err")}' "$F131B_RPT" "$F131_SAMP")
check "T131 未審核 sample 唔入 eval 報告" "$F131B_IN" "out"

# ── F sweep：fixture 病人殘留清走（新表 hermetic；GoldenCase e2e 標記行清走）──────
q "DELETE FROM \"AiDraft\" WHERE \"conversationId\" IN (SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\" LIKE '852698%' OR x.\"waId\" LIKE '852699%')" >/dev/null 2>&1
q "DELETE FROM \"PainTriageSession\" WHERE \"conversationId\" IN (SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\" LIKE '852698%' OR x.\"waId\" LIKE '852699%')" >/dev/null 2>&1
q "DELETE FROM \"StaffNotice\" WHERE \"conversationId\" IN (SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\" LIKE '852698%' OR x.\"waId\" LIKE '852699%')" >/dev/null 2>&1
q "DELETE FROM \"Message\" WHERE \"conversationId\" IN (SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\" LIKE '852698%' OR x.\"waId\" LIKE '852699%')" >/dev/null 2>&1
q "DELETE FROM \"Conversation\" WHERE id IN (SELECT c.id FROM \"Conversation\" c JOIN \"Contact\" x ON x.id=c.\"contactId\" WHERE x.\"waId\" LIKE '852698%' OR x.\"waId\" LIKE '852699%')" >/dev/null 2>&1
q "DELETE FROM \"Contact\" WHERE \"waId\" LIKE '852698%' OR \"waId\" LIKE '852699%'" >/dev/null 2>&1
q "DELETE FROM \"GoldenCase\" WHERE \"note\" IN ('e2e-F-gate','e2e-F-deid')" >/dev/null 2>&1
check "F sweep fixture 零殘留" "$(q "SELECT count(*)::text c FROM \"Contact\" WHERE \"waId\" LIKE '852698%' OR \"waId\" LIKE '852699%'" | jf c)" "0"

[ "$F_FAIL" = 0 ] && pass "F 段完成：Knowledge RAG + GoldenCase（T120–T131 12 格）" || fail "F 段有項失敗（見上 ❌）"

# ── summary ────────────────────────────────────────────────────────────

# ── summary ────────────────────────────────────────────────────────────
echo "════════════════════════════════════════════"
echo " E2E 完成：PASS=$PASS FAIL=$FAIL"
echo "════════════════════════════════════════════"
[ "$FAIL" = 0 ] || exit 1

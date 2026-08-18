# WA Clinic Inbox

WhatsApp AI 覆客系統 — 六間牙醫診所共用 inbox。Meta Cloud API 直連（Tech Provider）+ 全本地 AI（vLLM）+ Apricot 空檔讀取。

> 完整框架：見 repo 外 MD `wa-clinic-inbox-framework` v1.0。本 repo 為獨立 project（獨立 DB / 獨立 process），唔掂 clinic-workforce 底層。

## 技術棧

- **Next.js 15** (App Router, TypeScript) + custom `server.ts`
- **Socket.IO 4** — 實時推 inbox（room = `clinic:{id}`）
- **PostgreSQL 16 + Prisma** — 獨立 DB `wa_inbox`、獨立 role
- **Redis 7 + BullMQ** — webhook 秒回、發送重試、AI job、cron
- **pino** — 統一 log（★ PII 鐵律：訊息原文永不入 log）
- **PM2** — `wa-inbox`（web）+ `wa-worker`（BullMQ）兩個 process

## 快速開始

```bash
cp .env.example .env   # 填 DATABASE_URL / REDIS_URL / WA_* / SESSION_SECRET ...
pnpm install
npx prisma migrate dev # 首次建表（本地要有 DB）
pnpm seed              # seed 2 間 clinic（TKW/MF，假 waPhoneNumberId）+ 1 ADMIN + 各 1 STAFF
pnpm dev               # web server + Socket.IO @ :3100
pnpm worker            # 另一個 terminal 起 BullMQ workers
```

seed 完會打 log + 寫 `.dev/credentials.txt`（gitignored）：

```
ADMIN:     admin@wa-clinic.local    / <隨機>
TKW STAFF: staff-tkw@wa-clinic.local / <隨機>
MF STAFF:  staff-mf@wa-clinic.local  / <隨機>
```

## 常用命令

| 命令 | 用途 |
|------|------|
| `pnpm dev` | dev server（tsx server.ts，NODE_ENV≠production） |
| `pnpm build` | prisma generate + next build |
| `pnpm start` | production server |
| `pnpm worker` | 起 4 個 BullMQ workers（inbound/outbound/ai/cron） |
| `pnpm typecheck` | tsc --noEmit |
| `pnpm prisma:validate` | 校驗 schema 語法 |
| `pm2 start ecosystem.config.cjs` | production 兩 process |

## 端點

- `GET /healthz` — 健康檢查（DB/Redis/AI；AI down = degraded 唔算 fail，DB/Redis down = 503）
- `GET/POST /api/wa/webhook` — Meta webhook（GET 驗證握手 / POST 驗簽→入隊→極速 200）
- `/socket.io/*` — Socket.IO（掛同一 port；connect 時驗 iron-session cookie，先過先 join room）

### API routes（Phase 1）

| Route | 說明 | 權限 |
|-------|------|------|
| `POST /api/auth/login` / `POST /api/auth/logout` | email + argon2 登入 / 登出 | public / session |
| `GET/POST /api/admin/clinics`、`GET/PATCH/DELETE /api/admin/clinics/[id]` | clinic CRUD（code/name/waPhoneNumberId/waDisplayNumber/greetingConfig） | ADMIN |
| `GET/POST /api/admin/staff`、`GET/PATCH/DELETE /api/admin/staff/[id]` | staff CRUD（email/name/role/clinicId/active + password reset） | ADMIN |
| `GET /api/clinics` | 登入後睇自己可見嘅 clinic 列表（STAFF = 自己店） | session |
| `GET /api/conversations?clinicId=&status=` | 對話列表（queue 欄；unread/assignee/window） | session（clinicScope） |
| `GET /api/conversations/[id]` / `PATCH` | 單對話（contact 帶住）/ 狀態、assignee、markRead | session（clinicScope） |
| `GET /api/conversations/[id]/messages?before=&after=&limit=` | 訊息分頁（舊 chat HISTORY 段向上攞） | session（clinicScope） |
| `PATCH /api/contacts/[id]` | 改 profileName / labels | session（clinicScope） |
| `POST /api/messages/send` | 發 free-form（24h 窗口檢查；過窗 422 window_closed） | session（clinicScope） |
| `GET /api/staff` | 自己店 staff 列表（assignee 選擇器用） | session（clinicScope） |
| `GET /api/search?q=` | 全文搜尋（tsvector 英文 + pg_trgm 中文 fuzzy；Contact + Message） | session（clinicScope） |
| `GET /api/media/[file]` | 本地媒體檔（basename 校驗 + session） | session |

### API routes（Phase 2 — AI triage）

| Route | 說明 | 權限 |
|-------|------|------|
| `GET /api/conversations`（Phase 2 更新） | 加返 `intentConfidence`/`urgency`/`urgent`/`aiSummary`；排序 urgent 優先 | session（clinicScope） |
| `PATCH /api/conversations/[id]`（Phase 2 更新） | 加 `urgent: false`（人工清紅標；status→RESOLVED 自動清） | session（clinicScope） |
| `GET /api/conversations/[id]/drafts` | 對話嘅 pending AI 草稿（PROPOSED，最新 5） | session（clinicScope） |
| `PATCH /api/conversations/[id]/drafts/[draftId]` | 採用 draft（回 draftText 俾 composer；audit ADOPT_DRAFT；**採用 ≠ 發送**） | session（clinicScope） |
| `DELETE /api/conversations/[id]/drafts/[draftId]` | 棄用 draft（→ DISCARDED；已 SENT_* → 409） | session（clinicScope） |
| `POST /api/messages/send`（Phase 2 更新） | 發出時自動標 AiDraft：內容一字不差 = SENT_AS_IS，改過 = SENT_EDITED（finalText 留底） | session（clinicScope） |
| `GET /api/admin/ai-status` | AI 狀態快照（mode/model/breaker/probe/call 統計） | **ADMIN** |
| `GET /admin`（頁面） | 總覽 + AI 狀態卡 | **ADMIN** |

> ★ RBAC 鐵律：所有 `/api/*`（除 auth/webhook/healthz）都過 `clinicScope` — STAFF 砌 URL 攞別店資料一律 403（e2e 實測）。

## 架構重點

- **分流**：webhook `phone_number_id` → `Clinic.waPhoneNumberId` 決定屬邊間店
- **冪等**：`wamid` upsert `WebhookEvent`（Meta 會重發）
- **PII**：log 只記 metadata；`redactDeep()` 任意深度 redact `body/text/draftText/message`
- **RBAC**：ADMIN 跨店 / STAFF 硬綁 `clinicId`（`src/lib/rbac.ts`）
- **AI 降級**：GPU 離線 = inbox 照常，冇標籤冇草稿而已

## 安全

- 所有 API route（webhook/flows/healthz 除外）過 `rbac.ts`
- 訊息原文永不入 log、永不外送第三方
- DB volume + `/srv/wa-media` 開 encryption at rest；backup 先加密先落地

---

## Phase 2 — 本地 AI 分層 + Triage

### 鐵律（D4/D6 延伸，code 強制）

1. **AI 永遠唔自己發送** — AI 只生成 draft（PROPOSED）；staff 一鍵採用先入 composer（可改），發送必有人手 `sentByStaffId`
2. **URGENT_PAIN 永不入 AI 草稿** — `urgency=HIGH` 或 `intent=URGENT_PAIN` → 唔生成 draft + `urgent=true` + Socket `urgent:escalation`
3. **AI 失敗 = 降級唔係中斷** — call 失敗/超時：舊 intent/summary 保留、唔生成 draft、inbox 照常可用；log 只 metadata
4. **log metadata only** — 訊息原文 / summary / draft 永不入 log（`redactDeep` + 新 sensitive keys：summary/aiSummary/draft/prompt）
5. **AI 100% 本地** — 只打 vLLM（Tailscale 私網）；唔准入任何第三方 AI API（D4）

### 流程

```
inbound worker（Message IN+API 寫入）→ aiQueue（jobId=ai:<messageId>，冪等；HISTORY/APP_ECHO 唔觸發）
  → ai.worker：最近 10 條 context + Clinic.greetingConfig → classifyAndDraft（mock / vLLM 統一入口）
  → 分類落 Conversation（intent/urgency/urgent/aiSummary）
  → 非急症 & !needsHuman & model 畀咗 draft → AiDraft(PROPOSED)（unique(conversationId, inReplyToMessageId) 冪等）
  → Socket：ai:classified（每次成功）/ draft:ready（有 draft）/ urgent:escalation（急症）
  → 發送時 send route 標 AiDraft SENT_AS_IS / SENT_EDITED（採用率 + 微調數據）
```

失敗降級鏈：每 model 超時 8s + 重試 1 次 → primary 失敗 → fallback 2 次 → 都失敗 = throw（BullMQ attempts 3 + exponential backoff）→ circuit breaker 連 3 fail OPEN 60s。

### 真機 GPU 對接（vLLM 起法）

GPU 機（2×GPU）用 systemd 起 vLLM（TP=2），對 Tailscale IP 開 8000：

```bash
# GPU 機（一次性）
sudo apt install -y tailscale && sudo tailscaled &
sudo tailscale up  # 入同一 tailnet

# /etc/systemd/system/vllm.service
# [Unit]
# Description=vLLM — Qwen2.5-32B-Instruct-AWQ (TP=2)
# [Service]
# ExecStart=/usr/local/bin/vllm serve Qwen/Qwen2.5-32B-Instruct-AWQ \
#   --tensor-parallel-size 2 --max-model-len 8192 \
#   --gpu-memory-utilization 0.92 --served-model-name auto \
#   --host <tailscale-ip> --port 8000
# Restart=always
# [Install]
# WantedBy=multi-user.target
sudo systemctl enable --now vllm
```

Tailscale ACL 限死：只准 inbox VPS 嘅 node 入 GPU 機 8000 port。

Inbox 端 `.env`（GPU 機起好之後）：

```bash
VLLM_BASE_URL=http://<tailscale-ip>:8000/v1
VLLM_API_KEY=                    # 可選
VLLM_MODEL=Qwen/Qwen2.5-32B-Instruct-AWQ
VLLM_FALLBACK_MODEL=Qwen3-30B-A3B   # 32B 失敗時自動切
AI_MOCK=                         # 清走 = 真 AI
```

對接驗：`curl $VLLM_BASE_URL/models` 有 model → 開 mock 病人發「我想預約」→ inbox 見到真 draft（model 欄 = Qwen2.5-32B…）→ `/admin` AI 卡 probe=ok + call 成功率累積。

### 管理端 AI 狀態

`/admin`（ADMIN-only）：模式（mock/real）、primary/fallback model、circuit breaker、health probe、call 成功率（`AiCallStats`，worker 每次 call 後 atomic upsert）。

### E2E（mock）

`pnpm mock-e2e` — 28 條斷言（Phase 1 的 22 + Phase 2 的 6）：

| # | 斷言 |
|---|------|
| T13 | 「好痛」→ URGENT_PAIN + HIGH + urgent=true + **無 draft** + aiSummary + job 存在 + worker log urgent（escalation 同源） |
| T14 | 「想預約」→ BOOKING_REQUEST + LOW + urgent=false + draft PROPOSED |
| T15 | 採用 PATCH 200（回 draftText，DB 仍 PROPOSED）+ 棄用 DELETE → DISCARDED + 別店 403 |
| T16 | `AI_MOCK_FAIL=1` 重啟 worker → 舊 intent 保留 + 無新 draft + inbox 200 + AiCallStats 記 fail；還原 worker |
| T17 | HISTORY/APP_ECHO 訊息全部無 aiQueue job key |
| T18 | log 抽查：server/worker log 無任何訊息原文（grep 驗證） |

---

## 本地開發（無 Meta token — mock 模式）

指揮大神未做 Meta App 設定之前，全部用 **mock 測試** 行 E2E（`WA_MOCK=1`）：

- `WA_MOCK=1`：`graph.ts` 唔打真 API，回假 wamid；inbound worker 跳過媒體下載
- `scripts/mock-inbound.ts`：造真係 Meta format 嘅 webhook payload（messages/echoes/statuses/history/unknown）→ HMAC 簽名 → POST 本地 webhook
- `scripts/mock-e2e.sh`：一鍵完整 E2E（seed → 起 server+worker → 28 條斷言 T1-T18；Phase 2 加 T13-T18 AI triage + log PII 抽查，AI 用 `AI_MOCK=1`）

### 本地 DB（沙箱冇 docker 用 embedded-postgres）

```bash
pnpm dev:db        # embedded PG 18 @ 127.0.0.1:15432（長駐；data dir .dev/pgdata）
```

有 docker 嘅環境（指揮大神）改用 `.dev/docker-compose.dev.yml`（PG16 + 同一 port/credentials），然後 `.env` 嘅 `DATABASE_URL` 指向佢就搞掂。

### 一鍵 mock E2E

```bash
pnpm mock-e2e
```

涵蓋：login / 跨店 403（列表 + 單對話 + PATCH）/ inbound 建立 Contact+Conversation+Message（unread=1）/
冪等重發唔重複 / echo 唔加 unread / history 匯入 10 條唔觸發 unread 唔觸發 AI / send 202 → worker 發完 SENT + wamid /
status webhook → READ / 窗口過咗 send 422 window_closed / 未登入 401 / unknown payload 唔崩。

### 手工 smoke（驗 inbox UI 見到訊息）

```bash
# terminal 1: DB（首次 / 重啟機後）
pnpm dev:db

# terminal 2: server + terminal 3: worker
pnpm dev
pnpm worker

# 4. 瀏覽器登入 http://localhost:3100/login
#    用 .dev/credentials.txt 入面嘅 staff-tkw@wa-clinic.local 帳號

# 5. 開一個模擬病人入貨：
PN=8526001$(date +%s | tail -c 6)
pnpm mock-inbound message --clinic TKW --from $PN --text "你好，想問埋約" --name "示範病人"

# 6. 瀏覽器 /inbox → 隊列欄見到「示範病人」（unread badge 1）→ 點擊 → 對話欄見到氣泡
#    打字發送 → 見到 OUT 氣泡 + 勾勾；頂部 24h 窗口 chip 綠色
```

### 真機對接（Meta App 設定完成後）

1. Meta Business Manager → WhatsApp Manager 建 App，攞：
   - **Phone number ID**（每間店一個；TKW/MF seed 時係假 `109990000000001/2`）
   - **Permanent access token**（System User，scope `whatsapp_business_messaging`）
   - **App Secret**（webhook 簽名驗證）
2. `.env` 改：
   - `WA_MOCK=`（清走 → 真 mode）
   - `WA_ACCESS_TOKEN=<真 token>`
   - `WA_APP_SECRET=<真 app secret>`
   - `WA_VERIFY_TOKEN=<自訂 string>`（webhook 設定時同一個）
3. Admin 頁 `/admin/clinics` 改每間 clinic 嘅 `waPhoneNumberId` + `waDisplayNumber` 為真值
4. Meta webhook 設定：
   - Callback URL：`https://<domain>/api/wa/webhook`
   - Verify token：`WA_VERIFY_TOKEN` 嘅值
   - Subscribe：`messages`、`message_template_status_update`（statuses）、`smb_message_echoes`
5. 舊 chat 匯入（每間店）：WhatsApp Business 側會自動送 history span（`is_end_of_history`），worker 已處理
6. 驗：真機病人發訊息 → inbox 即時見到；店員回覆 → 手機收到；窗口過咗 → send 422

### 環境變數（`.env`）

| 變數 | 用途 |
|------|------|
| `DATABASE_URL` / `REDIS_URL` | 基建 |
| `WA_MOCK` | `1` = mock mode（假 token 都行）；清走 = 真 API |
| `WA_ACCESS_TOKEN` / `WA_APP_SECRET` / `WA_VERIFY_TOKEN` | Meta Cloud API |
| `WA_MEDIA_DIR` | 媒體下載目錄（預設 `/srv/wa-media`，冇權限 fallback `/tmp/wa-media`） |
| `TOKEN_ENC_KEY` / `SESSION_SECRET` | iron-session 加密（SESSION_SECRET ≥32 chars） |
| `PORT` | 預設 3100 |
| `VLLM_BASE_URL` | 本地 AI OpenAI-compatible endpoint（GPU 機 Tailscale IP + `/v1`）；兼容 fallback `AI_BASE_URL` |
| `VLLM_API_KEY` | 可選（vLLM 預設唔使 key） |
| `VLLM_MODEL` / `VLLM_FALLBACK_MODEL` | primary / fallback 模型（預設 `Qwen/Qwen2.5-32B-Instruct-AWQ` / `Qwen3-30B-A3B`） |
| `AI_TIMEOUT_MS` | 單次 call 超時（預設 8000；每 model 重試 1 次 → fallback → 都失敗 = degraded） |
| `AI_MOCK` | `1` = deterministic mock（無 GPU 行 E2E）；清走 = 真 vLLM |
| `AI_MOCK_FAIL` | `1` = mock 模擬 AI 斷線（測降級路徑；E2E T16 用） |

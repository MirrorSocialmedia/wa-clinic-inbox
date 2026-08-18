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
| `GET /api/admin/ai-status`（Phase 2b 更新） | AI 狀態快照（mode/model/breaker/probe/call 統計 + 實測 latency/tokens + **各舖 aiMode 近 24h AUTO 自動發數量/成功率**） | **ADMIN** |
| `GET /api/admin/clinics/[id]`（Phase 2b 更新） | 單店詳情（含 `aiMode`） | **ADMIN** |
| `PUT` / `PATCH /api/admin/clinics/[id]`（Phase 2b 更新） | 更新店設定（含 `aiMode`: `DRAFT`/`AUTO`，逐舖 AI 模式開關） | **ADMIN** |
| `GET /admin`（頁面，Phase 2b 更新） | 總覽 + AI 狀態卡（真 model 名 + 實測 latency/tokens + 各舖 AUTO 24h 統計表） | **ADMIN** |

### API routes（Phase 3 — Apricot + Flow）

| Route | 說明 | 權限 |
|-------|------|------|
| `POST /api/flows/endpoint` | WhatsApp Flow data_exchange（RSA+AES 加密；flow_token 驗證；3 屏） | 外部（WA 簽名不適用 — 加密+token 即身份） |
| `POST /api/conversations/[id]/flows` | staff 發預約 Flow（24h 窗口檢查；冪等重用 SENT session；回 flowToken） | session（clinicScope） |
| `GET /api/bookings?status=` | 本店 BookingRequest 隊列（PENDING 卡） | session（clinicScope） |
| `POST /api/bookings/[id]/confirm` | 〔已喺 Apricot 落單〕→ CONFIRMED + AuditLog + 自動確認訊息（過窗 → 200 + hint） | session（clinicScope） |
| `POST /api/bookings/[id]/reschedule` | 〔改期〕→ 重出 Flow（PENDING only；過窗 422） | session（clinicScope） |
| `POST /api/apricot/refresh` | 手動觸發本店 slot sync（經 apricot queue 序列化） | session（clinicScope） |
| `GET /api/admin/apricot-status` | Apricot session 狀態 + 各店 slot 新鮮度（14 日 token 監控） | **ADMIN** |
| `POST /api/admin/apricot/session` | 真 mode bootstrap：首次貼入 cookie 三件套（加密落 DB） | **ADMIN** |
| `GET /bookings`（頁面） | 預約隊列頁（PENDING/ALL 分頁 + confirm/reschedule 掣） | session |

> ★ RBAC 鐵律：所有 `/api/*`（除 auth/webhook/healthz/**flows/endpoint**）都過 `clinicScope` — STAFF 砌 URL 攞別店資料一律 403（e2e 實測）。

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

1. **逐舖 AI 模式（Phase 2b，指揮大神 2026-08-18 決定）** — `Clinic.aiMode`（`DRAFT` 預設 / `AUTO`）：
   - `DRAFT`：AI 只生成 draft（PROPOSED）；staff 一鍵採用先入 composer（可改），發送必有人手 `sentByStaffId`
   - `AUTO`：AI 回覆可直接自動發出 — **但以下任何一個唔滿足就退回 DRAFT 行為**（AUTO 係 DRAFT 超集，永遠有得覆）：
     `intent≠URGENT_PAIN` + `urgency≠HIGH` + `needsHuman=false` + 有 draft + 24h 窗口內
   - **鐵律（雙重擋：code + prompt）：URGENT_PAIN / HIGH / needsHuman 任何模式永遠唔自動發**
   - AUTO 發出嘅訊息：`sentByStaffId=null` + `aiAutoSent=true` + `AuditLog(AI_AUTO_SEND)`（metadata only，可審計）+ draft 留底標 `SENT_AUTO` + Socket `message:new` 帶 auto 標記（UI 顯示「🤖 AI 自動覆」）
2. **URGENT_PAIN 永不入 AI 草稿** — `urgency=HIGH` 或 `intent=URGENT_PAIN` → 唔生成 draft + `urgent=true` + Socket `urgent:escalation`（任何 aiMode 都係）
3. **AI 失敗 = 降級唔係中斷** — call 失敗/超時：舊 intent/summary 保留、唔生成 draft、inbox 照常可用；AUTO 模式 AI 失敗 = 唔發（staff 手動）；log 只 metadata
4. **log metadata only** — 訊息原文 / summary / draft / AUTO 發送內容永不入 log（`redactDeep` + 新 sensitive keys：summary/aiSummary/draft/prompt）
5. **AI 100% 本地** — 只打本地 sglang / OpenAI-compatible endpoint；唔准入任何第三方 AI API（D4）

### 流程

```
inbound worker（Message IN+API 寫入）→ aiQueue（jobId=ai:<messageId>，冪等；HISTORY/APP_ECHO 唔觸發）
  → ai.worker：最近 10 條 context + Clinic.greetingConfig → classifyAndDraft（mock / 真 AI 統一入口）
  → 分類落 Conversation（intent/urgency/urgent/aiSummary）
  → 非急症 & model 畀咗 draft → AiDraft(PROPOSED)（unique(conversationId, inReplyToMessageId) 冪等）
  → [Phase 2b] clinic.aiMode=AUTO 且全部條件滿足（非急症/非HIGH/!needsHuman/有draft/24h窗口內）
      → 自動發：Message(OUT, QUEUED, aiAutoSent=true, sentByStaffId=null) → 既有 outbound chain
      → draft 標 SENT_AUTO（留底審計）+ AuditLog(AI_AUTO_SEND) + Socket message:new（帶 auto 標記）
      → 任何條件唔滿足 → 退回 DRAFT（pending draft 俾 staff）；冪等：重 enqueue 唔重發
  → Socket：ai:classified（每次成功）/ draft:ready（draft 仍 PROPOSED）/ urgent:escalation（急症）
  → 發送時 send route 標 AiDraft SENT_AS_IS / SENT_EDITED（採用率 + 微調數據）
```

失敗降級鏈：每 model 超時 8s + 重試 1 次 → primary 失敗 → fallback 2 次 → 都失敗 = throw（BullMQ attempts 3 + exponential backoff）→ circuit breaker 連 3 fail OPEN 60s。

### 真 AI 後端對接（本地 sglang）

AI backend 係**本地 sglang**（OpenAI-compatible）— client 只認 OpenAI-compatible endpoint，所以 vLLM / sglang / 其他 SGLang-compatible server 都用同一份 code，只需改 `.env`：

```bash
VLLM_BASE_URL=http://127.0.0.1:30000/v1   # sglang endpoint（OpenAI-compatible）
VLLM_API_KEY=                              # 本地冇 key（留空）
VLLM_MODEL=/models/Qwen3.8-27B-FP8         # ★ model id 有斜線，照字面傳（server 原樣存/發）
VLLM_FALLBACK_MODEL=                       # 本地就留空（primary 冇 fallback）
AI_MOCK=                                   # 清走 = 真 AI
AI_TIMEOUT_MS=20000                        # 27B 首 token 慢啲，俾 20s
AI_DISABLE_THINKING=1                      # 唔開思考（快；唔需要 reasoning 內容）
```

對接驗：
1. `curl $VLLM_BASE_URL/models` 見到 model id（含斜線）
2. `pnpm e2e-real-ai` — 一鍵真 AI 實測（WhatsApp 照 mock，AI 用真 sglang）：
   3 類 intent（牙痛→URGENT_PAIN 0 draft / 預約→BOOKING_REQUEST+真 draft / 多謝→其他 intent+reply）
   + ai-status 真 model 名 + 實測 latency/tokens；斷言用「合理範圍」（真 AI 唔係 100% 決定性，每 case 連 3 次失敗先 fail）
3. 開 mock 病人發「我想預約」→ inbox 見到真 draft → `/admin` AI 卡 probe=ok + 實測 latency/tokens 累積

> model id 有斜線（`/models/Qwen3.8-27B-FP8`）對 request 冇影響 — 只係 JSON body 嘅字符串，
> client 唔做 URL 編碼/路徑拼接。實測 `pnpm e2e-real-ai` 已驗證。

<details>
<summary>附錄：原 vLLM GPU 機對接法（2×3090 Tailscale 私網方案，未採用 — 保留作參考）</summary>

原 MD 假設 AI 後端係雙 3090 vLLM（TP=2）對 Tailscale IP 開 8000。實際改用本地 sglang，以下保留作參考：

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

</details>

### 管理端 AI 狀態

`/admin`（ADMIN-only）：模式（mock/real）、primary/fallback model、circuit breaker、health probe、call 成功率（`AiCallStats`，worker 每次 call 後 atomic upsert）+ **實測 lastLatencyMs / lastTokens**（最近一次成功 call）+ **各舖 aiMode + 近 24h AUTO 自動發數量/成功率**（Phase 2b；raw SQL join Message→Conversation）。

`/admin/clinics`（Phase 2b）：逐舖 DRAFT/AUTO 開關 — AUTO 有醒目提示「AI 會直接覆病人」+ 二次確認；只可切自家權限（ADMIN 全店）。

### E2E（mock）

`pnpm mock-e2e` — 79 條斷言（Phase 1 的 22 + Phase 2 的 6 + Phase 2b 的 8 + Phase 3 的 T27-T34 8 條 Apricot+Flow 實測）：

| # | 斷言 |
|---|------|
| T13 | 「好痛」→ URGENT_PAIN + HIGH + urgent=true + **無 draft** + aiSummary + job 存在 + worker log urgent（escalation 同源） |
| T14 | 「想預約」→ BOOKING_REQUEST + LOW + urgent=false + draft PROPOSED |
| T15 | 採用 PATCH 200（回 draftText，DB 仍 PROPOSED）+ 棄用 DELETE → DISCARDED + 別店 403 |
| T16 | `AI_MOCK_FAIL=1` 重啟 worker → 舊 intent 保留 + 無新 draft + inbox 200 + AiCallStats 記 fail；還原 worker |
| T17 | HISTORY/APP_ECHO 訊息全部無 aiQueue job key |
| T18 | log 抽查：server/worker log 無任何訊息原文（grep 驗證） |
| T19 | (2b) AUTO + BOOKING_REQUEST → **自動發送**（mock Graph 收到）+ `aiAutoSent=true` + `sentByStaffId=null` + AuditLog(AI_AUTO_SEND) + draft SENT_AUTO |
| T20 | (2b) AUTO + URGENT_PAIN → **唔自動發** + urgent flag + escalation（鐵律實測）+ fallback log |
| T21 | (2b) AUTO + needsHuman=true（「想搵人工」）→ 出 pending draft 唔自動發 |
| T22 | (2b) DRAFT 舖（預設）行為唔變（有 draft、冇自動發） |
| T23 | (2b) AUTO 舖過 24h window → 唔自動發 + window-closed log |
| T24 | (2b) STAFF 攞別店 aiMode / PATCH 別店 aiMode → 403（RBAC） |
| T25 | (2b) AUTO 冪等：重 enqueue AI job → 唔重發（OUT 訊息 count 不變） |
| T26 | (2b) AUTO 發送 log PII 抽查（鐵律 1 擴展） |
| T27 | (3) Apricot mock sync（slot 落庫 + heartbeat）+ Flow endpoint 3 步加密 round-trip（provider 列表 / date 只回有空日 / time 只回空 slot / 壞 token 401） |
| T28 | (3) 病人 Complete → BookingRequest PENDING + 綠色卡 + /bookings 見到 |
| T29 | (3) 〔已喺 Apricot 落單〕→ CONFIRMED + AuditLog + 自動確認訊息（內容含日期時間醫生名） |
| T30 | (3) **race**：兩病人同 slot 同時 Complete → 第二個被擋（precheck）+ 自動覆「滿咗」+ 重出 Flow |
| T31 | (3) flow 中途棄 → 0 BookingRequest（無殭屍） |
| T32 | (3) 48h 冇處理 → cron EXPIRED + AuditLog（DB 時移 49h） |
| T33 | (3) PII：mock raw（含 clinicPatient/visitReasons/diagnosis 餌字串）經 adapter → DB + log 全 0 hit + pii-scan 0 violation |
| T34 | (3) 別店 flow_token 被拒 + STAFF 撳別店 booking confirm → 403 |

### E2E（真 AI — sglang 實測）

`pnpm e2e-real-ai` — WhatsApp 照 mock（`WA_MOCK=1`）但 AI 用**真 sglang**（`AI_MOCK=0`）：

1. 探活：`curl $VLLM_BASE_URL/models` 見到 model id 先開跑
2. 真機 3 類：「牙痛得夜都唔掱得」→ URGENT_PAIN（0 draft/唔自動發）；「想約下週一睇牙」→ BOOKING_REQUEST + 真 draft 內容；「多謝」→ 其他 intent + 合理 reply
3. 斷言（合理範圍，唔斷死字串）：intent 合理、draft 唔含醫療診斷/報價（prompt 鐵律 regex 抽查）、latency 記錄、ai-status 真 model 名 + 實測 latency/tokens + 各舖 aiMode 統計
4. 真 AI 輸出唔係 100% 決定性 — 每 case 最多 3 次嘗試（fresh patient），中間失敗 log 但重試，連 3 次失敗先 fail
5. mock 同 real 並存：`pnpm mock-e2e`（AI_MOCK=1）保持全綠，互唔影響

---

## Phase 3 — Apricot 空檔讀取 + WhatsApp Flow 預約收集

> 沙箱現狀：`WA_MOCK=1`（無真 WA token）+ `APRICOT_MOCK=1`（無真 Apricot bot 帳號）。
> **真碼全部寫完整**（HTTP client / RSA+AES 加密 / rotation / 序列化），E2E 用 mock 行全流程；
> 真機對接只係改 env + bootstrap token，code 零改動。

### Apricot adapter（`src/lib/apricot/`）

移植 clinic-workforce-mvp 實測核心邏輯（只讀參考，未改嗰邊 repo）：

| 檔案 | 職責 |
|------|------|
| `session.ts` | cookie 三件套（access_token JWT / refresh_token rotating / iat）AES-256-GCM 加密存 `ApricotSession`（singleton id=1）；`APRICOT_ENC_KEY`（32-byte base64） |
| `client.ts` | `apricotCall()`：cookie 三件套 header + `redirect:"manual"` 防 302 登入頁；**每次 response 用 `res.headers.getSetCookie()` 攞全部 Set-Cookie**（`get('set-cookie')` 只回第一隻 = 炒車，MD §8.1）；攞到新 cookie → `saveCreds`（寫入失敗 throw）；401/403/3xx → `APRICOT_AUTH_EXPIRED` 唔重試；429 → `APRICOT_RATE_LIMITED` |
| `sanitize.ts` | **PII 白名單**：`sanitizeOverview()` 只准留 slot 時間 / 醫生 id / 預約數；`clinicPatient` / `visitReasons[].des` / `diagnosis` / `createdBy` 全部 drop；`assertNoPii()` 落地前再斷言。★ raw response 永不入 log 永不落 disk（鐵律 2） |
| `slots.ts` | `syncClinic()`：`getOverviewAppointments?startDate=&endDate=&doctorIds=<一個>&openSchClinicId=<單數>`。★兩陷阱：① doctorIds 逐個列（先 `syncDoctorRoster` 同步醫生名單再逐醫生拉）② openSchClinicId 單數逐店 loop。`APRICOT_MOCK=1` 用決定性 fixture（3 店 × 醫生 × 未來 30 日，djb2 hash 決定閉诊日 ~1/7 + 滿位 ~1/4；`.dev/apricot-mock-fill.json` 可指定 slot 強制變滿俾 race 測試） |
| `mock.ts` | mock fixture — appointments 刻意帶 PII 餌字串（`MOCK_PII_*` / clinicPatient / visitReasons / diagnosis）俾 pii-scan 驗 0 hit |

**序列化**：所有 Apricot request 一律經 BullMQ `apricot` queue（worker concurrency=1）— token rotation 互斥，任何地方都唔可以直接 `apricotCall`。

**cron**（`workers/index.ts` upsertJobScheduler）：
- `sync-availability` 每 15 分鐘 — 各店 slot 重 sync（heartbeat 寫 `ApricotSession.lastSyncAt`）
- `apricot-keepalive` 每 3 日 03:00 — 輕量 request 推 token sliding window（14 日唔死靠呢個 + rotation）
- `bookings-expire` 每 5 分鐘 — PENDING 48h → EXPIRED；SENT flow 48h → ABANDONED

**監控**：
- `GET /api/admin/apricot-status`（ADMIN-only）：session 狀態（上次 sync / 上次 keepalive / 上次錯誤 / rotation 次數 / token 有效期估算）+ 各店 slot 新鮮度（min/max syncedAt + slot 數 + 20 分鐘內 = fresh）。14 日 token 驗收 = 每日查 `lastSyncAt` 有更新 + `lastError` null。
- `POST /api/apricot/refresh`（ADMIN / STAFF 本店）：手動觸發本店 sync（經 apricot queue）。
- `POST /api/admin/apricot/session`（ADMIN-only）：**真 mode bootstrap** — 首次貼入 cookie 三件套（見下方步驟）。

### WhatsApp Flow（`src/lib/flows/` + `src/app/api/flows/endpoint`）

**加密**（MD §8.2 樣板）：
- RSA-2048 keypair 首次生成存 `FLOW_KEYS_DIR`（預設 `.dev/flow-keys/`，gitignored）；真 mode 另需 `POST /{phone_number_id}/whatsapp_business_encryption` 上傳公鑰（`uploadPublicKey()`，mock mode 跳過）
- request：`wrapped_key` → RSA-OAEP(SHA-256) 私鑰解 → AES-128-GCM 解 body
- response：**同一把 AES key + 反轉 IV**（`reversedIv()`）加密 — mock client 用反轉 IV 解密驗證 round-trip
- `flow_token` = HS256 JWT（`FLOW_JWT_SECRET` 32-byte hex），payload = `{convId, clinicId}` — 防別店/別對話用；驗不過 → 401/400（唔 crash）

**data_exchange 三屏**（每次 call 查最新 `AvailabilitySlot` — precheck 原則：病人揀親 = 真有空）：
1. `SCREEN_PROVIDER` — 該店 active 醫生（`Provider`/`ProviderClinic` 對照；mock 期由 seed 派生，真期由 `syncDoctorRoster` 同步）
2. `SCREEN_DATE` — 聽日 ~ +30 日，只回該醫生有 open slot 嘅日期
3. `SCREEN_TIME` — 該日該醫生 `bookedCount=0` 嘅 30 分鐘 slot

**發送**：inbound BOOKING_REQUEST 對話頂部出「📅 預約」掣（或 `/bookings` 卡「改期」）→ staff 撳 → `POST /api/conversations/[id]/flows` → 24h 窗口檢查（過窗 → 422 提示用 template）→ 冪等（已有 SENT FlowSession 重用）→ 創 `FlowSession(SENT)` + interactive flow message（mock Graph 記假 wamid）+ AuditLog(SEND_FLOW)。

**mock client**：`pnpm flow-client step|complete ...` 模擬病人端 — 加密 request（同 WhatsApp 真實格式）→ 3 步行完 → 產生 `nfm_reply` webhook payload（加密 response_json，含 wrapped_key round-trip）打去本地 webhook。

### BookingRequest 生命周期（MD §8.3 D9）

```
nfm_reply.webhook → 解密 response_json → 驗證 flow_token/對話/店 → FlowSession SENT?
  → 對 AvailabilitySlot（$transaction + FOR UPDATE 串行化）
     ├ 過：BookingRequest(PENDING) + FlowSession(COMPLETED) + 對話綠色卡 + /bookings 隊列 + socket 通知
     └ 唔過（slot 滿咗/已有 PENDING 撞同 slot）：FlowSession(FAILED) + 自動覆「滿咗」+ 重出 Flow
staff 撳〔已喺 Apricot 落單〕→ CONFIRMED + AuditLog + 自動確認訊息（窗口內 free-form：「已為你預約 X 月 X 日 HH:mm 醫生名，到時見 🙂」）
staff 撳〔改期〕→ 重出 Flow（PENDING only）
48h 冇處理 → EXPIRED（cron）+ AuditLog(BOOKING_EXPIRED)
```

**冪等**：同一 flow_token 重複 Complete → 第二條 no-op（FlowSession 已 COMPLETED/FAILED 就 skip）；flow 中途棄（冇 Complete）→ 零 BookingRequest，session 留 SENT 等 48h ABANDONED（無殭屍）。

**`/bookings` 頁**（staff 本店 scope）：PENDING/ALL 分頁、PENDING 卡（病人/醫生/日期/時間/對話連結 `/inbox?conv=…`/窗口倒數）+ 兩個掣（confirm / reschedule）。

### 真機對接步驟（俾指揮大神）

#### 1. Apricot 真 bot 帳號

1. 開一個**專用 bot 帳號**登入 Apricot（同 provider-roster 帳號分開 — 只讀用途，权限只要 appointment 查閱）
2. 浏览器登入 `https://apricotvita.com`（或真 baseURL）後，DevTools → Application → Cookies 攞三件套：`access_token`（JWT）、`refresh_token`、`iat`
3. `.env` 改：`APRICOT_MOCK=0`、`APRICOT_BASE_URL=https://apricotvita.com`（如唔同）、各店 `apricotClinicId` 改真值（DB `Clinic.apricotClinicId` 或重新 seed）
4. Admin 登入後：`curl -X POST $BASE/api/admin/apricot/session -H "Authorization: Bearer <admin>" -d '{"accessToken":"...","refreshToken":"...","iat":"..."}'`
5. 攞醫生名錄 API path：`APRICOT_DOCTORS_PATH`（真 code 先有 roster endpoint；如果真 API 格式同 mock 唔同，只需改 `syncDoctorRoster` 入面嗰個白名單映射）
6. 驗：`GET /api/admin/apricot-status` → `lastSyncAt` 有值、`lastError=null`、各店 `fresh=true`；`pnpm e2e:cron sync-availability` 手動觸發一次

#### 2. WhatsApp Flow 真機

1. WhatsApp Manager 建立 Flow（3 個 screen：provider list / date picker / time list + complete）→ publish 攞 `flow_id` + CDN URL
2. `.env`：`WA_MOCK=0` + 真 token、`FLOW_ID=<publish 後 id>`、`FLOW_CDN_URL=<flow.json CDN>`；`uploadPublicKey()` 會喺首發 flow 前自動上傳公鑰（`POST /{phone_number_id}/whatsapp_business_encryption`）
3. 真手機 3 步：收到「📅 預約」掣訊息 → 撳入 Flow → 揀醫生 → 揀日期 → 揀時間 → Complete → 對話出現綠色卡 + `/bookings` 有 PENDING

#### 3. 空檔對數（3 店 × 3 日逐格對）

1. 開瀏覽器登入真 Apricot，逐店（3 店）逐醫生拉 3 日 schedule
2. 同系統 `AvailabilitySlot` 對：每一格（醫生 × 日 × 30 分鐘）— Apricot 有開門 + 冇預約 = slot row `bookedCount=0`；有預約 = `bookedCount≥1`（UI 唔顯示呢啲 slot）；冇開門 = 冇 row
3. 注意時區：slot 全部 HK 時區（UTC+8），DatePicker 範圍 = 聽日 ~ +30 日

### 同 MD 唔同嘅位（偏差）

- **confirm 過 24h 窗口**：MD 寫 422 提示 staff 用 template。實作：booking 本身照標 `CONFIRMED` + AuditLog（人已經喺 Apricot 落單，狀態要反映現實），HTTP 200 但 `autoMessage:{sent:false, reason:"window_closed"}` + hint 提示 staff 用 template 覆病人。422 保留俾「free-form 發送」同「reschedule 重出 Flow」兩個會真正發訊息嘅操作。
- **doctor roster**：MD 寫「cron 先 sync 醫生名單再拉」— 真 Apricot roster endpoint 未實測（無真 bot 帳號）；`syncDoctorRoster` 真 mode 讀 `APRICOT_DOCTORS_PATH` env 指定嘅 API，白名單 mapping 集中喺嗰一個 function（真機對接時如格式唔同只改呢度）。Mock 期 roster 由 seed 派生（`mock-pract-<clinic>-<n>`）。
- **keypair 存檔**：MD 寫「存 DB/keypair file」— 用 keypair file（`FLOW_KEYS_DIR`，gitignored 0600）；私鑰唔入 DB。
- **ApricotSession**：MD 只提 token 三件套 — 加咗 4 個監控欄（lastSyncAt / lastKeepaliveAt / lastError / rotationCount）俾 `/api/admin/apricot-status`（MD 任務 D 要求）。

---

指揮大神未做 Meta App 設定之前，全部用 **mock 測試** 行 E2E（`WA_MOCK=1`）：

## 本地開發（無 Meta token — mock 模式）

指揮大神未做 Meta App 設定之前，全部用 **mock 測試** 行 E2E（`WA_MOCK=1`）：

- `WA_MOCK=1`：`graph.ts` 唔打真 API，回假 wamid；inbound worker 跳過媒體下載
- `scripts/mock-inbound.ts`：造真係 Meta format 嘅 webhook payload（messages/echoes/statuses/history/unknown）→ HMAC 簽名 → POST 本地 webhook
- `scripts/mock-e2e.sh`：一鍵完整 E2E（seed → 起 server+worker → 79 條斷言 T1-T34；Phase 2 加 T13-T18 AI triage + log PII 抽查，Phase 2b 加 T19-T26 AUTO 模式實測，Phase 3 加 T27-T34 Apricot+Flow 實測；AI 用 `AI_MOCK=1`）
- `scripts/e2e-real-ai.sh` + `e2e-real-ai.ts`：一鍵真 AI 實測（AI 用真 sglang，WhatsApp 照 mock；3 類 intent + 鐵律 + latency/tokens）

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
| `VLLM_BASE_URL` | AI OpenAI-compatible endpoint（本地 sglang：`http://127.0.0.1:30000/v1`；兼容 fallback `AI_BASE_URL`） |
| `VLLM_API_KEY` | 可選（本地 sglang 冇 key — 留空） |
| `VLLM_MODEL` / `VLLM_FALLBACK_MODEL` | primary / fallback 模型（本地 sglang：`/models/Qwen3.8-27B-FP8`，model id 有斜線照字面傳；fallback 留空） |
| `AI_TIMEOUT_MS` | 單次 call 超時（預設 8000；sglang 27B 建議 20000；每 model 重試 1 次 → fallback → 都失敗 = degraded） |
| `AI_DISABLE_THINKING` | `1` = 唔開思考（sglang Qwen 系列；快） |
| `AI_MOCK` | `1` = deterministic mock（無 GPU 行 E2E）；清走 = 真 AI（sglang） |
| `AI_MOCK_FAIL` | `1` = mock 模擬 AI 斷線（測降級路徑；E2E T16 用） |

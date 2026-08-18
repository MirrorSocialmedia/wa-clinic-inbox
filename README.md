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

## 本地開發（無 Meta token — mock 模式）

指揮大神未做 Meta App 設定之前，全部用 **mock 測試** 行 E2E（`WA_MOCK=1`）：

- `WA_MOCK=1`：`graph.ts` 唔打真 API，回假 wamid；inbound worker 跳過媒體下載
- `scripts/mock-inbound.ts`：造真係 Meta format 嘅 webhook payload（messages/echoes/statuses/history/unknown）→ HMAC 簽名 → POST 本地 webhook
- `scripts/mock-e2e.sh`：一鍵完整 E2E（seed → 起 server+worker → 22 條斷言）

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

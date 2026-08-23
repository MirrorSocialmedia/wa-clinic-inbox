# WA Clinic Inbox — 故障 Runbook

> 三個故障演習各實測一次（sandbox，2026-08-19）。每節：**症狀 → 恢復程序 → 實測結果（時間/步驟/RTO）**。
> 原則：**inbox 收發唔好倒** — AI/queue/worker 死咗都係降級，唔係停擺。

---

## 0. 系統圖（故障域）

```
Meta webhook → Next.js server (3100) → Postgres (15432)
                        ↓ inboundQueue
                 Redis (6379) ←→ worker process（inbound/ai/outbound/cron 四 worker 同 process — 2026-08-23 apricot worker 拆除，空檔改 workforce API）
                 AI (sglang 30000)  ←  breaker 包住（in-memory）
```

---

## 1. AI 死（GPU 斷電 / sglang 重啟 / 模型掛）

### 症狀（前台角度）
- 新訊息**照收照發**（inbox 收發完全唔受影響）
- **冇 AI 草稿、冇自動標籤**（intent 保留上一次；新訊息未分類）
- `/admin` AI 卡顯示 breaker OPEN / 最後錯誤
- 每 5 分鐘 health-check 彈 **HIGH 警報 `ai_breaker_open`**（ALERT_CHANNEL 通知）

### 系統行為（設計預期）
1. AI call 失敗 → circuit breaker 計失敗（real mode：連續 3 次最終失敗 → OPEN 60s → 期間 skip AI；half-open 試一次，成功 → CLOSED）
   - 註：`AI_MOCK_FAIL=1` mock 路徑喺真 call 之前 throw，**唔經 breaker**（mock 係 deterministic 測試路徑；breaker 代碼路徑已喺 T35 用 override 模擬驗證）
2. AI job 重試（attempts 3，backoff 2s/4s）→ 超過 → job 標 failed，**舊 intent 保留、唔抹走**
3. `AiCallStats.lastError` 更新（admin 卡真數據）
4. AUTO 模式舖：失敗 → 唔自動發（fallback log），人手指路
5. 恢復後：breaker half-open → 下一條成功 → CLOSED → **自動恢復，唔使重啟任何嘢**（mock 路徑：worker 重啟後即恢復）

### 恢復程序
```bash
# 1. 確認 AI 服務（sglang/vLLM）本身有無起
curl -s http://127.0.0.1:30000/v1/models | head -5

# 2. 冇起 → 起返（GPU 機斷電 = 去返屋企開機，呢步無法 remote）
#    （部署命令見 .env.example VLLM 段）

# 3. 等 breaker 自己 half-open（backoff 到期）— 唔使重啟 worker
# 4. 手動觸發一單 AI（入一則 mock / 或等真訊息）→ 睇 /admin AI 卡轉 CLOSED
# 5. 睇警報：health-check 下一次 cycle 會 auto-resolve ai_breaker_open
```

### 實測結果（2026-08-19，sandbox）
_（見下方演習記錄 D1）_

---

## 2. Redis 停（OOM / 重啟 / 主機問題）

### 症狀（實測修正版）
- `/healthz` 報 `redis: down`（monitoring 用）
- **webhook 入站：enqueue 有 1.5s timeout（`ENQUEUE_TIMEOUT_MS`）→ 超时即回 500 `queue unavailable`（唔會 hang 住 Meta）** → Meta 重發
- ioredis `maxRetriesPerRequest=null`（BullMQ 要求）：攞住嘅 command 喺 Redis 起返後會 **自動補發**（double safety — 見實測）
- worker：斷線後 log `redis connection error`；**如 queue state 已經唔一致（例：nosave 重啟後 job key 冇咗），BullMQ error handler 會 `exiting for PM2 restart` 令 process 退出等 supervisor 重啟**（設計如此 — 唔帶病運行）
- 已 enqueue 未處理嘅 job **喺 Redis 入面** → 無 persistence 嗰啲會丟；RDB/AOF 開住就唔會

### ★ 訊息唔會永久丟嘅保證（實測驗證）
1. Redis 死嗰陣 webhook → **1.5s 快速 500** → Meta 重發（生產有 retry；wamid 冪等 → 重發唔會重複）
2. 攞住嘅 enqueue command 喺 Redis 起返後 **自動補發**（ioredis buffer）→ 即使 Meta 未重發，job 都補返咗
3. 已落 DB 但 job 丟咗嘅訊息：訊息本身安全（DB），worst case 手動重 enqueue AI

### 恢復程序
```bash
# 1. 起返 Redis（systemd 好使時）：
systemctl start redis          # 或 redis-server /etc/redis/redis.conf &
# systemd unit failed / D-Bus 冇權時（實測遇到）：手動起
redis-server --bind 127.0.0.1 --port 6379 --daemonize yes
redis-cli ping                          # → PONG

# 2. 等 worker：
#    - 多數情況 BullMQ 自動重連（等 ~10s，log 見 "redis connected"）
#    - 如 worker 已退出（log "exiting for PM2 restart"）→ 重啟 worker：
#      pm2 restart wa-inbox-worker      # 生產
#      pnpm worker                      # sandbox

# 3. 查 backlog：queue depth（reconnect 後 waiting 數）
redis-cli llen wa-inbox:ai:wait
#    有 waiting → worker 會逐條處理，唔使手動

# 4. 驗證：新入一則訊息 → 5s 內 intent/draft；/healthz 返 ok

# 5. health-check 下一 cycle auto-resolve 相關警報
```

### 實測結果（2026-08-19，sandbox）
_（見下方演習記錄 D2）_

---

## 3. kill worker（deploy / OOM / 手誤）

### 症狀
- 冇任何「即時」錯誤（server 照常 200/202 — webhook 照 enqueue 入 Redis）
- **backlog 積喺 `inbound` queue（入站入口 queue）**：`redis-cli llen wa-inbox:inbound:wait` 上升
- queue >100 → 5 分鐘後 health-check `queue_depth` 警報
- 訊息唔會丟（queue 喺 Redis；已處理嘅喺 DB）

### 恢復程序
```bash
# PM2 部署（生產）：
pm2 restart wa-inbox-worker          # 或 pm2 resurrect（boot 時間）
pm2 logs wa-inbox-worker --lines 50  # 睇 "all workers started"

# sandbox/dev：
cd /srv/wa-clinic-inbox && pnpm worker   # （先 kill 舊：pkill -f 'src/workers/index[.]ts'）

# 驗證：
# 1. log 見 "all workers started" + 各 scheduler 註冊
# 2. queue waiting 數開始下降（drain）
# 3. 新入一則 mock 訊息 → 5 秒內有 intent/draft
```

### queue 唔會堆死嘅保證
- 重啟後 worker 由 queue 頭逐條食；concurrency 有上限唔會爆
- 堆積期：前台照見新訊息（server 端），只係 AI 處理延後
- `bookings-expire` 等 cron job 延後喺正常範圍內（冪等，補跑安全）

### 實測結果（2026-08-19，sandbox）
_（見下方演習記錄）_

---

## 4. 部署 Checklist — workforce 來源切換（2026-08-23，trace cwi-wfsw-20260823-a1）

Apricot 直連 → clinic-workforce External API（v1 availability + duty-roster）切換嘅上線驗收。順序執行：

1. **apply migration**（`prisma/migrations/20260823120000_workforce_switch/`）：
   review `migration.sql`（drop ApricotSession / BookingRequest nullable / +timeOfDay / create WorkforceSyncState）→ `pnpm prisma:migrate deploy`（或 `prisma migrate deploy`）→ 核對 `prisma migrate status` = up to date。
   ★ 本 repo 開發 DB（15432）刻意未 apply — 只限生產 / 部署 DB。
2. **env**：`WORKFORCE_API_URL`（workforce 站 base）+ `WORKFORCE_API_KEY`（scope: availability；永不入 log）；`WORKFORCE_MOCK=0`；
   `FLOW_REQ_CDN_URL` / `FLOW_REQ_ID`（WhatsApp Manager publish 純收需求 canvas 後填入 — 未填 = NONE 時回落正常 canvas，endpoint 兜底出 REQUIREMENT data）。
3. **真機 getSlots**：首個 `pnpm e2e:cron sync-availability`（或等 */15 cron）→ log 見 `workforce fetch ok（L2 upserted）`；
   其後 5 分鐘內 Flow 操作應零 HTTP（log 唔再有 fetch — L2 fresh 即回）；`SELECT * FROM "WorkforceSyncState"` lastOkAt 持續更新。
4. **四層降級鏈逐層演**（`pnpm e2e:workforce` — stale / throw→STALE_CACHE / NONE / 恢復 / alert 全鏈）：
   - 真機可手動加劇：workforce 邊停服務 / 改 key → 睇 STALE_CACHE（L2 過期照用）；再清 L2 → NONE → Flow 轉純收需求 canvas（灰字卡）。
5. **alert 15 分鐘**：停 workforce >15 分鐘 → health-check 開 `workforce_api_degraded`（MEDIUM）+ ALERT_CHANNEL log（metadata only）；恢復 → auto-resolved。
6. **兩條新 E2E**：`pnpm e2e:workforce`（= T35b，stale + throw 路徑）全綠；`pnpm e2e:workforce-contract`（fixture sha256 錨定 + PII strip）全綠。
7. **收口**：`grep -ri apricot src/` 只剩 `providerApricotId`/`apricotId`/`apricotClinicId` 型別/欄名/注釋；`.env` 零 `APRICOT_*`；全量 `bash scripts/mock-e2e.sh`（需 15432 起）。

## 附：演習記錄（RTO 實測）

> 格式：時間 | 注入方式 | 症狀觀察 | 恢復步驟 | RTO（注入→完全恢復）
> 所有演習喺 sandbox 實做，數據係真 log/DB 對帳。演習腳本：`scripts/drill-1-ai-down.sh` / `drill-2-redis-down.sh` / `drill-3-kill-worker.sh`（可重跑）。

### D1 — AI 死（2026-08-19 02:46 HKT，注入 02:47:04）
| 項 | 結果 |
|---|---|
| 注入 | worker 用 `AI_MOCK_FAIL=1` 重啟（模擬 sglang 死）；TKW `aiMode=DRAFT` |
| 症狀 | 新訊息：無 intent、無 draft、無 AI 欄位更新；log `ai: call failed — degraded（舊 intent/summary 保留，無 draft，inbox 照常）` ×3 attempts（backoff 2s/4s）→ job final failed；**inbox 列表 HTTP 200 照常**；breaker 保持 closed（mock 路徑唔經 breaker — 見上）；AiCallStats.lastError 更新 |
| 恢復 | 重啟正常 worker（模擬 sglang 恢復） |
| 恢復後 | 第一條新訊息 **+2.6s 後 intent+draft 返嚟**，breaker closed，舊數據冇損 |
| **RTO** | **outage 30.6s（drill 控制）；恢復程序 2.6s**（重啟→首條成功） |

### D2 — Redis 停（2026-08-19 02:58 HKT，注入 02:58:47）
| 項 | 結果 |
|---|---|
| 注入 | `redis-cli shutdown nosave`（真停機；nosave = 模擬無 persistence 最壞情況） |
| 症狀 | `/healthz` `redis: down`；停機中 webhook → **1.51s 後 500 `queue unavailable`**（`enqueue timeout 1500ms` — 快速 500 令 Meta 重發，唔 hang）；worker log `redis connection error` → **`inbound worker error — exiting for PM2 restart`（自動退出，設計如此）**；DB 照常 ok |
| 恢復 | 手動 `redis-server --bind 127.0.0.1 --port 6379 --daemonize yes`（sandbox systemd unit 已 failed，D-Bus 冇權 — 即 runbook 第 1 步手動分支）→ PONG；重啟 worker（1.0s） |
| 恢復後 | 停機中嗰條訊息：**DB count=1、intent 已設 — 冇丟冇重複**（攞住嘅 enqueue command 喺 Redis 起返後自動補發 → worker 處理；即使 Meta 重發都係 wamid 冪等） |
| **RTO** | **redis 停機 11.2s（operator 動作）；全處理 14.7s**（注入→DB 完整）。附註：如果 systemd supervisor 好使（未爆 start-limit），實測 ~1.5s 自動重啟，operator 唔使做嘢 |
| 發現 | 連續多次 shutdown 會爆 systemd start-limit → unit failed → 要手動起（runbook 已寫兩軌）；`shutdown nosave` 會令在途 job key 消失 → worker 按設計退出等重啟 |

### D3 — kill worker（2026-08-19 03:05 HKT，注入 03:05:49）
| 項 | 結果 |
|---|---|
| 注入 | `pkill -f 'src/workers/index[.]ts'`（worker pid 確認先 kill） |
| 症狀 | 冇即時錯誤；webhook 照 200（server 照 enqueue 入 Redis）；**backlog 積喺 `inbound` queue**；**inbox 網頁 HTTP 200 照常**；Message 行照寫 |
| 恢復 | 重啟 worker（`pnpm worker`；生產 = `pm2 restart wa-inbox-worker`） |
| 恢復後 | 3 則 backlog 全部處理：**Message 3/3、AiDraft 3/3**（逐人核對），queue drain 返 0/0/0 |
| **RTO** | **worker 死 6.3s；重啟+drain 完 7.3s** |

### 結論
三個故障域全部符合「inbox 收發唔倒」原則：AI 死 = 降級冇標籤；Redis 死 = 快速 500 + Meta 重發 + wamid 冪等 + 自動補發；worker 死 = queue 積 → 重啟 drain。RTO 全部 < 15s（operator 介入），有 supervisor 時更短。

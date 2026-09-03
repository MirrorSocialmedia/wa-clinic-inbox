# 生產 Runbook — wa-clinic-inbox 開 `bookings` 寫入 scope（2026-09-04）

> 施工單：cwi-master-20260902 B6（Part G-3 寫入輪）· W repo commit：見 git log（`G-3 人手落單`）
> 範圍：**F 側零 code 改動**（bookings 寫入 endpoint 已存在）；全部改動喺 W 生產 + F 機 key rotate。
> 執行順序鐵律：**① F 機換 key → ② W 生產換 .env + build + restart — 一氣呵成**（rotate 即刻作廢舊 key）。

---

## 0. 事前確認（5 分鐘）

| # | 項 | 方法 | 預期 |
|---|-----|------|------|
| 0.1 | W 生產而家 `WORKFORCE_API_KEY` 運行正常 | W 生產 log 搵 `workforce fetch ok` | 有（availability 同步每 15 分鐘） |
| 0.2 | `ALLOW_NEW_PATIENT_WRITE` **off** | `grep ALLOW_NEW_PATIENT_WRITE <W repo>/.env` | 無呢行，或 `=0`／`=false`（**鐵律：保持 off**） |
| 0.3 | 揀低峰時段 | 診所收職後（建議 21:00–翌晨 09:00） | 斷線窗影響最小 |
| 0.4 | 備份 F 機 DB（key 表） | 慣常 backup | — |

---

## 1. 步驟 ① — F 機：rotate key（加 `bookings` scope）

喺 **F 機（clinic-workforce 生產機）** 嘅 `apps/web` 目錄（`docker compose.yml` 所在）：

```bash
# 1.1 入咗 F 機 repo（apps/web/）
cd <F 機 repo>/apps/web

# 1.2 將 key 生成 script 拷入 container（/app 只讀 image — 每次 deploy 都會要重做呢步）
docker compose cp apps/web/scripts/gen-external-key.ts app:/app/gen-key.ts

# 1.3 rotate（同名 key 已存在 → 換新 key；舊 key 即刻作廢！）
docker compose exec app npx tsx /app/gen-key.ts wa-clinic-inbox availability,duty-roster,patients,appointments,bookable-slots,bookings --rotate
```

- 輸出嘅 **64 位 hex 明文 key 只印一次** — 立即喺剪貼簿／密文位置抄走（`wk_live_` 格式無前綴，純 hex）。
- 6 個 scope 一個都唔少（production 而家 5 個 + 新加 `bookings`）。
- scope 寫錯 script 會報錯退出（`❌ scope 錯誤`）— 冇事，重打就得，**唔會改到 DB**。

> ⚠️ 呢一刻起，舊 key 已經作廢。**W 生產仍然用緊舊 key → 由而家起 W 嘅 workforce 呼叫會 401**。
> 影響：W 四層降級鏈照運（stale cache / L2 照回 / degraded 標記）— 唔會 crash、唔會鎖死對話；
> 排班板 / 值班表顯示會係「同步前」數據。**斷線窗 = 步驟 ① 完成 → 步驟 ② pm2 restart 完成**，
> 正常操作 < 5 分鐘。

## 2. 步驟 ② — W 生產：換 key + build + restart

喺 **W 生產機** 嘅 wa-clinic-inbox repo：

```bash
cd <W 生產 repo>

# 2.1 撳返最新 code（本批 commit：manual route + schedule-board 人手落單掣 + e2e + runbook）
git pull

# 2.2 .env 換 key（W 鐵律：web 改動必 build — 本批有 web 改動，build 必跑）
#     將 .env 嘅 WORKFORCE_API_KEY 換做步驟 ① 抄返嘅 64 位 hex 明文
sed -i.bak 's/^WORKFORCE_API_KEY=.*/WORKFORCE_API_KEY=<新 64 位 hex 明文>/' .env
#     （確認咗先删 .env.bak；sed 錯字會即刻喺 2.4 log 見到 401）

# 2.3 build（W 鐵律）
pnpm install --frozen-lockfile
pnpm build

# 2.4 restart（pm2 process 名用 pm2 list 睇返 — 通常係 wa-inbox 或 inbox）
pm2 restart <process-name>

# 2.5 驗（30 秒內）
pm2 logs <process-name> --lines 40   # 要見到 workforce fetch ok / 冇 401
curl -s http://127.0.0.1:3000/ | head -3   # 或者你生產嘅 port / 反代
```

**驗收標準**：
- log 冇 `workforce API fail`（401 = key 換錯 — 重核 2.2；連續失敗會出 `workforce_api_degraded` 警報）。
- 下一班 15 分鐘 availability 同步正常（`WorkforceSyncState` heartbeat 更新）。
- 登入排班板 → 格正常顯示（唔係全部 stale 提示）。

## 3. 步驟 ③ — 鐵律確認

```bash
grep -n "ALLOW_NEW_PATIENT_WRITE" <W 生產 repo>/.env
```

- 預期：**無輸出**（= off）或 `=0`／`=false`。
- **新客代落單路徑唔存在**（人手落單／代落單都只收已釘住舊客 — 未釘住一律 422 `NEW_PATIENT_DISABLED`）。
- 唔好為咗方便開呢個 env — 開咗 = 新客寫入開門 = 破鐵律。

## 4. 步驟 ④ — 生產 SOP 測試（restart 後 30 分鐘內做）

> 目的：確認 W → F bookings 寫入鏈喺生產真 F（唔係 mock）行得通 + 對數得返。
> 原則：**TEST 前綴資料 / 未來非繁忙時段 / 測完即 remove 清場**。

### 4.1 準備 TEST 對話（唔建新客）
1. 揀一個**真舊客**嘅對話（或者用 staff 自己 WhatsApp 收過訊息嗰個 TEST 對話）。
2. Inbox 側欄 patient-context → **釘住舊客**（要出現「已釘住」+ Apricot patient 檔）。
   - 未釘住就落單 → 會 422 `NEW_PATIENT_DISABLED`（正常，鐵律喺度）。

### 4.2 落單
1. 開排班板（/schedule 或 inbox 排班板）→ 撳一個 **未來 + 非繁忙** 嘅 ONLINE 格
   （建議：聽日或後日 10:00–11:00 之間、唔係收職前後、clinic 唔會真有人搶嘅格）。
2. popover 入面：揀 TEST 對話 → 撳 **〔人手落單（直接入 Apricot）〕**。
3. 預期：toast **已喺 Apricot 落單（單號 mock…／真 Apricot 單號）— 確認訊息已自動發**（窗口內）；
   對話出 CONFIRMED 卡（帶 Apricot 單號 + 15 分鐘時長）。

### 4.3 對數（落單後 1 分鐘內）
**F 機**（`apps/web/` 目錄，db 用生產 DB）：

```bash
docker compose exec app npx tsx -e "
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const logs = await p.bookingWriteLog.findMany({ where: { requestedBy: 'wa-clinic-inbox' }, orderBy: { createdAt: 'desc' }, take: 5 });
console.log(JSON.stringify(logs, null, 1));
const audit = await p.externalApiAudit.findMany({ where: { keyName: 'wa-clinic-inbox' }, orderBy: { createdAt: 'desc' }, take: 10 });
console.log(JSON.stringify(audit, null, 1));
await p.\$disconnect();
"
```

（若 `npx tsx -e` 行唔到，用 psql 直查代替：
`SELECT * FROM "BookingWriteLog" WHERE "requestedBy"='wa-clinic-inbox' ORDER BY "createdAt" DESC LIMIT 5;`
`SELECT * FROM "ExternalApiAudit" WHERE "keyName"='wa-clinic-inbox' ORDER BY "createdAt" DESC LIMIT 10;`）

對數條件（全部要成立）：

| 邊 | 欄 | 預期 |
|----|----|------|
| F `BookingWriteLog` | `action` / `status` | `CREATE` / `OK` |
| F `BookingWriteLog` | `idempotencyKey` | `wa-inbox-<W bookingId>`（W 卡嘅 booking id） |
| F `BookingWriteLog` | `apricotApptId` | 非空 |
| W `BookingRequest` | `apricotApptId` | **= F 嗰個 apricotApptId**（逐字相同） |
| W `AuditLog`（Admin 審計頁 或 DB `AuditLog` where action='BOOKING_CREATE'） | `meta.apricotApptId` | 同上 |
| F `ExternalApiAudit` | 最新行 | `path=/api/external/v1/bookings` `status=200` |
| Apricot 本身 | 該醫生聽日 schedule | 見到呢單測試預約（15 分鐘） |

### 4.4 測完即 remove 清場（**5 分鐘窗內**）
1. 對話 CONFIRMED 卡 → **〔撤銷（已入 Apricot）〕**（5 分鐘內先有得撳 — server 強制 410 過期）。
2. 預期：toast 撤銷成功；卡復原 PENDING。
3. 再對數（同一 F 機查詢）：
   - `BookingWriteLog` 最新行 `action=REMOVE` `status=OK`，`apricotApptId` 同落單時相同；
   - `ExternalApiAudit` 多一行 `path=.../remove` `status=200`；
   - Apricot 該預約已刪（醫生 schedule 淨返）。
4. 清場完成 = SOP 測試過。之後 staff 日常用人手落單唔使再測（除非 key 再 rotate）。

### 4.5 失敗裁決
| 現象 | 裁決 |
|------|------|
| 落單 502/503 `WORKFORCE_UNAVAILABLE` | 重試 1 次；再 fail → 檢查 F 機 log + `ExternalApiAudit` status（503 = F guard；502 = network/F down） |
| 落單 401（workforce 401） | key 換錯／唔同步 — 重核步驟 ②；必要時再 rotate 一次 |
| 409 `SLOT_TAKEN` | 真係滿（mock 先至有 flag；生產 = F checkClash 真擋）— 換格 |
| 422 `NEW_PATIENT_DISABLED` | 對話未釘住舊客 — 側欄釘住先（鐵律，唔係 bug） |
| 撤銷 410 | 過咗 5 分鐘窗 — 要人手喺 Apricot 刪（之後同步會對返） |

## 5. 步驟 ⑤ — 書面知會模板

> **致：各診所主任 / Apricot 管理員**
>
> 由 **2026-09-04（星期 X）HKT** 起，WhatsApp 客服系統（wa-clinic-inbox）開通
> 「direct 落單」功能：staff 可以喺 WhatsApp 對話直接喺 **Apricot 為已釘住嘅舊客落 15 分鐘預約**，
> 落單內容（醫生／日期／時間／病人）會即時顯示喺 Apricot，與人手落單無分別。
>
> 請注意：
> 1. 只對 **系統內已有檔案嘅舊客** 生效（新客唔會自動入 Apricot）。
> 2. 上線後 30 分鐘內會有一單 **測試預約**（TEST 對話）出現再刪除 — 屬正常驗收，唔使處理。
> 3. staff 落單後病人會即時收到 WhatsApp 確認訊息；staff 有 5 分鐘窗口可以撤銷。
> 4. 如有異常（重複單／錯誤時段），請立即通知 IT（eatblack）並截圖對話卡單號。
>
> 特此知會。
>
> — IT / <簽署>

---

## 6. 回滾（出事先睇呢度）

| 層 | 回滾方法 | 影響 |
|----|----------|------|
| key 換錯 | F 機再 `--rotate` 一次 → W `.env` 再換 → `pm2 restart` | 唔改任何 appointment |
| W 本批 code 有問題 | W 生產 `git revert <本批 commit>` → `pnpm build` → `pm2 restart` | 人手落單掣消失；而家 bookings scope key 繼續有效（F 側 endpoint 唔受影響） |
| 要全線切走 bookings 寫入 | F 機 re-rotate key 剔走 `bookings` scope（`... availability,duty-roster,patients,appointments,bookable-slots --rotate`）+ W 換 key | W 落單 = 403 scope 擋（fail-safe：只係落唔到單，讀取全正常） |

已落單嘅真單唔需要回滾處理 — 佢哋就係 Apricot 入面嘅普通預約。

## 7. 交貨附錄

- W e2e（本批新增 `pnpm e2e:manual-booking`，T132–T138，mock workforce 決定性）— 26/26 PASS。
- 偏離項：15 分鐘時長 = 現狀 D-1（跟代落單一致，唔改）；L2 預檢 `bookedCount>0` 即擋 = 跟現有 Flow 鏈現狀（F checkClash 係最終防線）。
- F 側：零改動。

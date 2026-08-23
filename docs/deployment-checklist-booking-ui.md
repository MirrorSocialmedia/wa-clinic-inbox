# Deployment Checklist — booking-ui（代落單 UI + 即時刷新 + patient-context 側欄）

trace: `cwi-bkui-20260823-a1` · Kairo: `mt5qkcaise6gs` · 2026-08-23

本任務本地 DB（15432）down 咗（老細 data），所以 DB 依賴嘅 e2e 斷言本地跑唔到，全部集中喺度。
部署環境（DB + Redis 起緊）依序執行；本地可跑嘅 unit gates 已喺 dev 全綠。

## 0. 上線前置（人肉拍板）

| # | 項目 | 狀態 / 說明 |
|---|------|------------|
| 0.1 | `BOOKING_DEFAULT_VISIT_REASON_CODE` | **未拍板**（0010 抑 0021）。留空 = 卡上必須揀 visit reason（400 提示）。拍板後填 env 即生效，唔使改 code。 |
| 0.2 | `PHONE_HASH_KEY` | 生產必須同 clinic-workforce-mvp **完全一致**，否則 patient-lookup 全部查唔到（靜默 fail → 側欄顯示 workload 降級）。本地係 sandbox 生成。 |
| 0.3 | Migration `20260823203000_booking_ui_patient_context` | 純 ADD COLUMN（Conversation 4 欄 + BookingRequest 3 欄，全部 nullable）— 可熱遷移。`prisma migrate deploy` 喺生產跑。 |
| 0.4 | 預約時長 | 代落單 / 改期固定 `15 分鐘`（MD 無寫時長 — 偏離項 D-1）。逐舖時長唔同就要再改。 |

## 1. 本地已綠（唔使重複跑）

- `pnpm typecheck` — 0 error
- `pnpm lint` — baseline（1 舊 error `scripts/e2e-socket-events.ts:58` + 8 舊 warnings；0 新增）
- `pnpm test:booking-ui-unit` — 5 分鐘倒數邊界 / 卡狀態機 pure fns / L2 invalidate where / 訊息文字 / phone-hash byte-identical anchor
- `pnpm e2e:booking-ui-contract` — mock 五端點 contract + fixture sha256 錨定 + 409/422/503 分支 + 冪等
- PII grep（新增行）— raw phone 零出現

## 2. DB 依賴 e2e（`pnpm e2e:booking-ui`，mock workforce）

前提：15432 起緊 + seed（TKW clinic + 至少 1 個 active STAFF + `waPhoneNumberId` 填咗）+ Redis 起緊。
Script 會自建/自清 test data（`e2e-bkui-*` 前綴）；DB 唔到會自動 SKIP（exit 0）。

| # | 斷言 | 覆蓋 |
|---|------|------|
| ① | 代落單 200 → 卡 CONFIRMED + `apricotApptId` + 確認訊息 QUEUED + **L2 該日 invalidate**（下一次 `getSlots` 打 API：`WorkforceSyncState.lastOkAt` fresh） | D create + C 即時刷新 |
| ② | 409 SLOT_TAKEN（flag file）→ 卡保持 PENDING + `error:"SLOT_TAKEN"`（前端紅字「時段啱啱滿咗」）+ 重發 Flow 200 | D 409 分支 + 現有 24h 窗口 |
| ③ | 撤銷（3 分鐘內）→ remove call（mock call log 200）+ 卡彈返 PENDING + `apricotApptId` 清 null + **零自動訊息** + AuditLog `BOOKING_ROLLBACK` | D 撤銷 + AuditLog |
| ④ | 過 5 分鐘撤銷 → API 410（server 端強制；前端掣 5 分鐘後消失） | D 5 分鐘邊界 |
| ⑤ | 側欄改期全鏈：reschedule route → Flow 發出 → nfm_reply（加密 envelope 模擬）→ `rescheduleBooking`（workforce 原子 102+新單）→ 旗標清 + AuditLog `BOOKING_RESCHEDULE` + 改期訊息 + L2 新日 invalidate | E 改期全鏈 |
| ⑥ | 取消全鏈：cancel route → `status -7`（mock call log）+ AuditLog `BOOKING_CANCEL` + 取消訊息 + L2 invalidate | E 取消全鏈 |
| ⑦ | Send Lock：非負責人 → rollback / reschedule / cancel **全部 423**（副作用前擋） | E 權限 |
| ⑧ | 未釘住 conv 代落單 → 400 `no_pinned_patient`（ALLOW_NEW_PATIENT_WRITE off 時新客寫入路徑唔存在；mock newpatient 預設 off → 直接打新客 create 會 422 `NEW_PATIENT_DISABLED`） | A 鐵律 + workforce 契約 |
| ⑨ | socket 第二 browser 即時見 `booking:changed`（見 §3） | C 即時刷新 |

## 3. ⑨ socket 第二 browser（要 live server）

1. 部署環境起 server：`WORKFORCE_MOCK=1 pnpm dev`（PORT 預設 3100）
2. 登入攞 cookie（或 e2e 用 staff session seal）
3. 跑：`pnpm e2e:booking-ui --server`
   - 會開第二個 socket.io client（同 staff cookie → hub 自動 join `clinic:{id}` room）
   - 喺 10 秒內等 `booking:changed`（部署環境有其他寫入流量先到；冇流量就手動喺 UI 撳一次代落單）
4. 驗收：第二 client 收到 `booking:changed { conversationId, clinicId, date, kind }` → 前端三位訂閱（inbox 列表 / detail 側欄 patient-context / /bookings 隊列）各自重拉

另：可配合現有 `pnpm e2e:socket-events --cookie "wa_inbox_session=..."` 捕 `booking:changed` 事件原文（payload 零 PII — 只有 id/date/kind）。

## 4. 上線後冒煙（人手）

- [ ] 側欄：釘住舊客 → 姓名/最近就診/預約狀態 三欄顯示；取消釘住 → 藍掣消失
- [ ] 卡：PENDING 綠邊（visit reason 下拉 + 3 掣）→ 代落單 → CONFIRMED（單號 + 發起人 + mm:ss 倒數）
- [ ] 撤銷 5 分鐘內撳 → 卡彈返 PENDING；5 分鐘後掣消失
- [ ] 側欄改期 → 病人收 Flow → 完成 → 兩卡轉色 + 改期訊息
- [ ] 側欄取消（二次確認）→ 刪除線 + 取消訊息
- [ ] 另一個 staff（非負責人）撳三掣 → 全部 423
- [ ] 15 分鐘 cron 未改動（availability 照常全量同步；寫入只 invalidate 該日 L2）

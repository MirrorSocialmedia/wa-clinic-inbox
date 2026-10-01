# cwi-final Stage 5 交貨報告

- **Kairo task**：見 Kairo 記錄
- **Repo**：wa-inbox（W 側，F1–F4 + W 側最後批）＋ workforce（CWM 側 F4/F5 + S5-1~7）
- **日期**：2026-09-25 ～ 2026-09-26（Asia/Hong_Kong，git commit 時間）
- **並行環境**：見 Kairo 記錄
- **補寫說明**：本報告 2026-09-28 由 cwi-qa-fix（FX-22）依兩 repo commit log 補整；驗收 drill 細節見 Kairo 記錄

## Commits

### wa-inbox（W 側）

| Commit | 項 | 內容（commit subject 摘錄） |
|---|---|---|
| `4ded0a5` | S5-1(W)+S5-6+S5-8①（F1） | booking 寫入 timeout/結果未知 + 確認雙擊防護 + 排班表落單重複防護 |
| `bb9b962` | S5-7(W)+S5-8②+S5-3③（F2） | 預約狀態一致 + T4 改期唔取消舊單 + rollback 新 key 重試 |
| `0fd821a` | S5 F4（W 側） | S5-11 hold 卡全套 + S5-12 同號多病人 + S5-4①-W sweep alert + S5-5④ 防呆 + T675/T676 |
| `dc8d029` | S5 W 側最後批 | S5-9 nfm_reply 明文（真 Meta 格式）+ claim 時 COMPLETED / S5-10 新 Flow wire 格式（flow_message_version=3+body.text+action.parameters）/ S5-13-W quotes+patient-lookup 對齊 / S5-14-W 八項（P2: 組合 list 20/頁+時長+per-day 新鮮度+10s 預算+COMMITTED 降級+PENDING 過期通知+確認文字診所名址+窗口由今日）+ T675/T676 |

### workforce（CWM 側）

| Commit | 項 | 內容（commit subject 摘錄） |
|---|---|---|
| `4ee741a5` | S5-1~S5-7 | S5-1 先查後建 dedup + S5-2 reschedule 原子化冪等 + S5-3①② key 消耗/hash + S5-5 clinic 消歧 + S5-7 ACTIVE=[0,1,102] + T810–T815 |
| `de21a181` | S5-4 + S5-14-CWM（F4） | S5-4 hold TTL 兩段式 + claim 先查 PatientIndex（F4）+ 測試 |
| `b3ac6338` | S5-13①② + S5-14-CWM（F5） | 報價 clinic filter + 單條 + decision 狀態鎖 + patient-lookup 回傳診所 + bookings 核對 + X-Staff-Id 必填 |

## 範圍總覽

- S5-1：booking 寫入 — timeout/結果未知口徑（W 側）+ 先查後建 dedup（CWM 側）
- S5-2：reschedule 原子化冪等（CWM）
- S5-3：key 消耗/hash + rollback 新 key 重試
- S5-4：hold TTL 兩段式 + claim 先查 PatientIndex + sweep alert
- S5-5：clinic 消歧 + 防呆
- S5-6：確認雙擊防護 + 排班表落單重複防護
- S5-7：ACTIVE 狀態集 [0,1,102] + 預約狀態一致
- S5-8：T4 改期唔取消舊單
- S5-9：nfm_reply 明文（真 Meta 格式）+ claim 時 COMPLETED
- S5-10：新 Flow wire 格式（flow_message_version=3）
- S5-11：hold 卡全套
- S5-12：同號多病人
- S5-13：quotes + patient-lookup 兩 repo 對齊（X-Staff-Id 必填）
- S5-14：八項 P2 收口（組合 list 20/頁、時長、新鮮度、10s 預算、COMMITTED 降級、PENDING 過期通知、確認文字診所名址、窗口由今日）

## 驗收

- CWM 側 T810–T815、W 側 T675/T676（commit subject 列明）— 執行記錄見 Kairo 記錄
- 2026-09-28 QA 複核（workorder 附錄 A）：S0–S6 功能全部落地

## 後續

- G2 閘（`ALLOW_SLOT_CLAIM`／`APRICOT_WRITE`）開閘前必做：FX-05、FX-11、FX-12、FX-17 + 原施工單「真機 Flow 10 次 drill」（見 workorder §G）

# cwi-final Stage 1 交貨報告

- **Kairo task**：見 Kairo 記錄
- **Repo**：wa-inbox（W 側）；本 stage 無 workforce 側 commit
- **日期**：2026-09-19 ～ 2026-09-22（Asia/Hong_Kong，git commit 時間）
- **並行環境**：見 Kairo 記錄
- **補寫說明**：本報告 2026-09-28 由 cwi-qa-fix（FX-22）依 main commit log 補整；驗收 drill 細節見 Kairo 記錄

## Commits

| Commit | 項 | 內容（commit subject 摘錄） |
|---|---|---|
| `05068b9` | S1-1a | inbound 最終失敗 DLQ + upsertAlert 抽出/R-28 + health queue 擴充 |
| `a73191a` | S1-1b | commit 後副作用補做（ensureSideEffects）+ notify try/catch + stuck-sweep */5 |
| `4ddf246` | S1-1c | PendingStatus + 狀態單調升級（B4 Stage 1 G0） |
| `9782db8` | S1-1d+e | 延遲送達 reload 唔見（createdAt 軸 + beforeId keyset）+ 異步競態交叉污染（guard + remount）（B5） |
| `d635375` | S1-2 | list loader 單一來源 + cursor 分頁 + API object 化 + 膠囊計數同源（B6） |
| `f92ada1` | S1-3+4+7 | 空白對話載入（ensureConversationLoaded+ids/contactId）+ 跨店 realtime 統一出口（publishConvEvent 28 emitter+eventId 去重）+ 事件契約（zod 20 事件）（B7） |
| `d38c88e` | S1-5+8+9 | push 收件人按 scope（N-5/L-2/P2-12 + prefs ∩ scope）+ 膠囊全 toggle + 停用員工原子釋放（B8） |
| `05ec93f` | S1-10+12+13 | 翻開已解決對話即刻升級（reopen routedAt）+ Per-staff 已讀（ConversationRead/myUnread/Notices）+ 草稿堆疊最近3個（B9） |
| `c5bfbc1` | S1-14+15 | 急症 deterministic 紅旗 intake（唔靠 LLM）+ Outbound 狀態機（SENDING/UNKNOWN 唔雙發 + permanent/transient）（B10） |

### 隨附 harness 修復（純測試碼，同期）

| Commit | 內容 |
|---|---|
| `1fe0559` | B3-harness：T183 改動態 provider 斷言（mock grid djb2 每日不同 → 舊硬編碼恒紅） |
| `d90a55a` | B3-fix：upsertAlert 冪等 race — partial unique index + P2002 吞掉（T610 實錘） |
| `de8207f` | B3-harness2：T185 加 09:00 時段 skip-guard + T186 goto 500-retry（dev 重編譯 race） |
| `53b4357` | B10-harness：SCHED 日視圖改用最近 open day（--date）+ T95/T180/T184-186 閉診日 skip guard |

## 範圍總覽

- S1-1（a–e）：inbound 可靠性（DLQ、副作用補做、狀態機 PendingStatus 單調升級、延遲送達 reload、競態隔離）
- S1-2：list loader 單一來源 + cursor 分頁 + 膠囊計數同源
- S1-3/4/7：空白對話載入 + 跨店 realtime 統一出口（事件契約 zod 20 事件）
- S1-5/8/9：push 按 scope + 膠囊全 toggle + 停用員工原子釋放
- S1-10/12/13：已解決對話 reopen 升級 + per-staff 已讀 + 草稿堆疊
- S1-14/15：急症 deterministic 紅旗 intake + Outbound 狀態機

## 驗收

- 各 commit 內含測試（commit subject 列明）；執行記錄見 Kairo 記錄
- 2026-09-28 QA 複核（cwi-qa-fix workorder 附錄 A）：S0–S6 功能全部落地 — 詳見該單

## 後續

- 無本 stage 專屬 production 待辦；gate 口徑見 `cwi-qa-fix-workorder-20260928.md` §G

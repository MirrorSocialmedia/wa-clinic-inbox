# cwi-final Stage 2 交貨報告

- **Kairo task**：見 Kairo 記錄
- **Repo**：wa-inbox（W 側 C1–C4 + S2-9a）＋ workforce（CWM 側 S2-9b）
- **日期**：2026-09-22 ～ 2026-09-23（Asia/Hong_Kong，git commit 時間）
- **並行環境**：見 Kairo 記錄
- **補寫說明**：本報告 2026-09-28 由 cwi-qa-fix（FX-22）依兩 repo commit log 補整；驗收 drill 細節見 Kairo 記錄
- **接盤記錄**：C4 commit（`dd83ff6`）subject 標「Stage 2 C4，接盤完成」— 本 stage 中途有過一次接盤

## Commits

### wa-inbox（W 側）

| Commit | 項 | 內容（commit subject 摘錄） |
|---|---|---|
| `448eac2` | S2-1（C1） | 建議去重改業務科目 subjectKey（科目級終態 + 7 日冷卻 + 建前計過期 + P2002 防疊）+ cwi_final_s2_followup migration（subjectKey/paramOrder/timestamptz/B1 disable） |
| `627e575` | S2-2+3+4（C2） | opt-out 即時取消已有建議（N-8 recheck + opt-out 路徑 + 建議卡隱藏）+ auto-resolve 守門③（SUGGESTED 唔好關）+ RESOLVED 採用發送重開對話 + followup:changed 實時事件（T621/T622/T741） |
| `6926f63` | S2-5+6+7（C3） | 過窗 template 雙審批發送（本地∧Meta approvedTemplateList + 真 category 計費 + components.parameters=paramOrder）+ engine 發送原子化（claim+message.create+sentMessageId 同一 $transaction）+ B-6 術後 72h 覆蓋全部草稿（T742/T743/T744） |
| `dd83ff6` | S2-8（C4） | scan 健康四分（WorkforceApiError 0/5xx/404=DEP_FAIL warn、其他例外=ERROR+log.error、ruleFail 真累加）+ FOLLOWUP_SCAN audit 只喺 created>0 或 DEP_FAIL/ERROR 先寫（~864 行/日→異常/新建先有 row）+ contacts PATCH assertCanWriteConversation + 過時 L2/欠款字眼清理 + chat-pane 簡體字 + 兩 UI lastScanResult ERROR 紅字（T745a/b/c 18 項） |
| `659947d` | S2-9a | wa-inbox LLM proxy（envelope AES-256-GCM + quote-llm + /api/internal/llm-extract + 防落地 gate + T745-749） |

### workforce（CWM 側）

| Commit | 項 | 內容（commit subject 摘錄） |
|---|---|---|
| `f27f7567` | S2-9b | 報價 LLM 第二層改經 wa-inbox proxy（llm-client 換 proxy client + backfill 限流 + compose env + T623） |

## 範圍總覽

- S2-1～S2-8：followup 建議系統（subjectKey 去重、opt-out、過窗 template 雙審批、scan 健康四分、PII/字眼清理）
- S2-9：報價 LLM 第二層改經 wa-inbox 內部 proxy — 決策檔 `docs/decisions/2026-09-17-llm-proxy.md`（KV cache 拍板 + 信封 + Cloudflare 口徑）

## 驗收

- commit 內含測試（T621/T622/T741–T749、T623）；執行記錄見 Kairo 記錄
- 2026-09-28 QA 複核（workorder 附錄 A）：「S2-9 信封兩 repo 逐字一致、防落地靜態鎖」已驗證 OK
- workforce 側 T623 = `apps/web/src/lib/clinical/t623-llm-proxy-contract.test.ts`（stub proxy、零 GPU）

## 後續

- S2-9b 舊 `LLM_*` env 生產清理 = 部署後步驟（老細側，見 decision doc 配套段）
- GPU 機三項人手檢查結果：**老細未提供 — 見 decision doc placeholder**

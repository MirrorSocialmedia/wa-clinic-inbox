# cwi-final Stage 6 交貨報告

- **Kairo task**：見 Kairo 記錄
- **Repo**：wa-inbox（W 側 G1–G5）＋ workforce（CWM 側 S6-1 + S6-8）
- **日期**：2026-09-26 ～ 2026-09-28（Asia/Hong_Kong，git commit 時間）
- **並行環境**：見 Kairo 記錄
- **補寫說明**：本報告 2026-09-28 由 cwi-qa-fix（FX-22）依兩 repo commit log 補整；驗收 drill 細節見 Kairo 記錄

## Commits

### wa-inbox（W 側）

| Commit | 項 | 內容（commit subject 摘錄） |
|---|---|---|
| `bfc6d27` | S6 G1 | W repo CI + e2e --ci + playwright de-hardcode + S6-2 indexes |
| `cfd0cd3` | S6 G2 | S6-3① search 重寫 + S6-3② mediaKey unique Index Scan + S6-4 8 項（retention/metrics/telemetry/backup offsite/drill） |
| `e6fff39` | S6 G3 | S6-5 worker 生命週期 + heartbeat |
| `ba29d33` | S6 G4 | S6-7 前端效能（bundle+virtuoso 修）+ S6-9①retry ②IME ③Enter 發送開關 + e2e TOTP pre-flight |
| `5f83b08` | S6 G5 | S6-9④ 附件發送（圖片/PDF）— sniff/media route/worker/UI + T695+T698 |

### workforce（CWM 側）

| Commit | 項 | 內容（commit subject 摘錄） |
|---|---|---|
| `2187079a` | S6-1 | CWM CI（audit3 P1-22）+ D-1 appointments phoneHash validation |
| `61183d5a` | S6-8 | T694 clinical-index Apricot lock 驗證 + Stage 6 驗收 drill（restore drill 記錄 + EXPLAIN 快照） |

## 範圍總覽

- S6-1：CWM CI + phoneHash validation
- S6-2：indexes
- S6-3：search 重寫（參數化、3 秒 timeout、INTERNAL 預設排除、keyset）+ mediaKey unique Index Scan
- S6-4：8 項（retention/metrics/telemetry/backup offsite/drill）
- S6-5：worker 生命週期 + heartbeat
- S6-7：前端效能（bundle + virtuoso 修）
- S6-8：clinical-index Apricot lock 驗證 + Stage 6 驗收 drill
- S6-9：retry / IME / Enter 發送開關 / 附件發送（圖片/PDF）

## 驗收

- S6-8 drill 產物（workforce repo）：
  - `docs/drills/restore-drill-2026-09-27.md` — restore drill 記錄
  - `docs/perf/explain-snapshot-2026-09-27.md` — EXPLAIN 快照
- T695/T698（S6-9④）、T694（S6-8）commit 內含 — 執行記錄見 Kairo 記錄
- 2026-09-28 QA 複核（workorder 附錄 A）：S6-3 搜尋、S6-5 worker 生命週期、S6-8 lock、S6-9 附件 全部已驗證 OK；workforce CI 子集 632/632

## 後續

- 本 stage 為 cwi-final 最後 stage；S6-4 backup offsite/drill 嘅定期執行 = 運維側（見 Kairo 記錄）

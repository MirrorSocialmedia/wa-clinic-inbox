# cwi-qa Phase 1 報告 — Lane A（wa-inbox CI + 部署保險）

- 完成日期：2026-09-28
- Kairo task：`mukvk8r0q5h8g`（CEO 管 — 未 mark）
- Branch：`qa-fix/lane-a`（由 main `5f83b08`）
- 細節見 `cwi-qa-batch-1-report.md`（同 commit 歷史）

## 範圍完成狀態
| FX | 內容 | 狀態 |
|---|---|---|
| FX-01 | CI 真正跑得綠（7 項全修 + LANE 區塊 + 臨時 admin=ALL） | ✅ 代碼完；本地 gate 全綠 |
| FX-06 | statement_timeout 只限 web | ✅ migration + ecosystem + .env.example + T760 |
| FX-07 | APP_HOST 必填（boot fail-fast + predeploy） | ✅ server.ts + predeploy + .env.example + T761 |
| FX-13 | Origin null/garbage → 403 | ✅ middleware fail-closed + T765 |
| FX-22（env 部分） | .env.example 補 7 key + 格式註明 | ✅ |

## 本機 gate 結果
- typecheck 綠；`npx eslint .` = 0 errors（140 warnings）
- 全 unit 綠（4 紅修晒；reminder/session-engine 正常退出；company-sync/knowledge 本機綠 — CI 全新 DB 行為差異留待 Actions 實證）
- mock-e2e 全量（本地）：round 2 = 1520/0（基線維持）；round 3（含 LANE A T760/T761/T765）= `<待填>`
- T760 雙向實測：web 8s / worker 0；T761：boot exit 1 + fatal、predeploy 兩 guard 點名；T765：null/garbage 403 + same-origin 過 gate

## 交還 / 未做
1. GitHub Actions 驗證 — token 未到位：`<push 後填 run sha + 狀態>`
2. CI 臨時 SQL（admin scopeType=ALL）— FX-02 上線後刪（階段 2 Lane A）
3. `docs/decisions/` eslint 降級記錄 — 歸 Lane B（本報告 + progress 先記錄）
4. FX-22 其餘（stage report / llm-proxy decision）— 歸 Lane B

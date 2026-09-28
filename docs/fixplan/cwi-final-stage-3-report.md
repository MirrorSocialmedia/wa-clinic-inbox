# cwi-final Stage 3 交貨報告

- **Kairo task**：見 Kairo 記錄
- **Repo**：wa-inbox（W 側）；本 stage 無 workforce 側 commit
- **日期**：2026-09-23 ～ 2026-09-24（Asia/Hong_Kong，git commit 時間）
- **並行環境**：見 Kairo 記錄
- **補寫說明**：本報告 2026-09-28 由 cwi-qa-fix（FX-22）依 main commit log 補整；驗收 drill 細節見 Kairo 記錄

## Commits

| Commit | 項 | 內容（commit subject 摘錄） |
|---|---|---|
| `e4e00ca` | S3-1+S3-4 | scoped ADMIN 權限全套 + 術語字典 requireGlobalAdmin + T630 矩陣 scaffold |
| `239a94b` | S3-3+S3-2 | send-lock 單一來源（D-11）+ per-device logout/session 失效 |
| `e1c2a9d` | S3-5+S3-6 | TOTP 強制/重放/lockout + enroll-confirm + log 私隱 PII + CSRF/Origin middleware + rate limit sliding window + e2e harness Origin/cron-guard 兼容 |
| `9763cf3` | S3-7+S3-8+S3-9 | push allowlist/rebind, flows endpoint hardening（432/421/427+exp 24h+flowToken 剷+holdId 核）, misc authz/PII hardening |

## 範圍總覽

- S3-1/4：權限模型 — scoped ADMIN 全套 + 術語字典全局 ADMIN 守門（T630 RBAC 矩陣 scaffold）
- S3-2/3：session/lock — send-lock 單一來源（decision doc D-11）+ per-device logout
- S3-5/6：TOTP 強制期 + 重放/lockout + enroll-confirm + PII log 清理 + CSRF/Origin middleware + rate limit sliding window
- S3-7/8/9：push allowlist/rebind + flows endpoint 加固（421/427/exp 24h/flowToken 剷/holdId 核）+ 雜項 authz/PII

## 驗收

- T630 矩陣 scaffold 落喺本 stage（`e4e00ca`）；其餘 commit 內含測試 — 執行記錄見 Kairo 記錄
- 2026-09-28 QA 複核（workorder 附錄 A）：S0–S6 功能全部落地；T630 矩陣格於 cwi-qa-fix 階段 2（FX-21）繼續落

## 後續

- G3 閘（scoped ADMIN，`ALLOW_SCOPED_ADMIN=1`）開閘前必做：FX-02、FX-03（見 workorder §G）
- `TOTP_ENFORCE_FROM` 設定前必做：FX-04（見 workorder §G）

# cwi-final Stage 0 補丁批（S0fix）交貨報告

- **Kairo task**：`mu8epv65r3bi9`
- **Worktree**：`/home/kenneth/.openclaw/workspace/wa-clinic-inbox-s0fix`（branch `cwi-final-s0fix`，base `d455564`）
- **日期**：2026-09-19（Asia/Hong_Kong）
- **並行環境**：同 B3（main tree / 3100 / mock-e2e）並行；本批 3101 dev server + 15432 查詢/測試數據

## Commits（一條 F 一個 commit）

| Commit | F | 內容 |
|---|---|---|
| `507d86f` | F-8 | predeploy-check.sh `envv()` 行尾註釋/引號 bug（🔴 假綠）— strip comment/whitespace/quotes + `export KEY=` 兼容 |
| `5676e7d` | F-9 | predeploy-check.sh Redis 段防呆 — REDIS_URL 空用 default；冇 redis-cli → wrn 唔係 bad；連唔到顯示實際值 |
| `433b4c6` | F-1 | composer precheck fail-open（workforce 出事唔擋發送）+ T754 e2e（failopen/normal 雙模式） |
| `5e4ce8d` | F-2 | seed B1 預約提醒規則預設關（D-9）+ `docs/decisions/b1-before-appointment-disabled.md`（重開條件） |
| `02044cc` | F-3 | inbox 列表刷新 debounce（1.2s 合併窗口）+ T755 e2e |
| `300ef8f` | F-4 | 報價頁 teach 權限跟 `sessionScopeType` fallback（舊格式 session 唔失明）+ T750f e2e |
| `c89d5c1` | F-5 | 11 個 e2e script + `e2e-s0-all.sh` 一鍵迴歸 + `_pw.ts` playwright 單一入口 |
| `acdec9c` | F-5 | t605 入口補必要 env（script 自身 guard） |
| `5aa3e5d` | F-3 | t600/t601 UI timing 斷言 suite 加固（見偏離 #5） |
| `b3b0d2c` | F-6 | mock-e2e.sh REMINDER_AUTO_SEND trap 兜底 |

## 各 F 驗收

### F-8（🔴 假綠）
`envv()` 原实现唔 strip 行尾註釋 → `AI_MOCK=1 # test` 讀成 `1 # test`（truthy 但值錯）/ 帶引號值失配 → predeploy 假綠/假紅。改後 4 case 自檢全對（A 正常值 / B 行尾註釋 / C 引號 / D `export KEY=`）+ `bash -n` 通過。

### F-9
REDIS_URL 空 → default `redis://127.0.0.1:6379`；冇 redis-cli → warning 唔係 fail（假紅）；連唔到時顯示實際值。`bash -n` 通過。

### F-1（🔴 fail-open）
send route `precheckAdoptedTask` try/catch → `log.warn("send: followup precheck 依賴失敗 — fail-open 照發（F-1）")` → `why=null` 照發。
**T754 雙模式全綠**（BASE=3101）：
- failopen（server `WORKFORCE_MOCK_FAIL=1`）：釘病人 task 採用發送 → 202 + Message OUT + task SENT + sentMessageId + AuditLog FOLLOWUP_SENT(sentVia=AI_ADOPTED) + log 有 fail-open 行；REPLIED 對照 → 409 FOLLOWUP_NOT_SENDABLE + task CANCELLED/REPLIED + 零 Message（REPLIED 檢查喺 appointments 分支之前，workforce 狀態唔影響）
- normal：同一 task 形 202 + SENT，log 無 fail-open（正常路徑未回歸）

### F-2
`prisma/seed.ts` B1（BEFORE_APPOINTMENT）規則 `enabled: false` 預設 + decision doc（重開條件：S2-1 上線 + UI 首次確認 + 觀察一星期）。**生產停用 SQL = 老細 server 低峰待辦**（本批唔郁生產）。

### F-3
`inbox-client.tsx`：`scheduleListRefresh`（1.2s trailing 合併）；`conversation:assigned` / `notify:assigned` 兩 handler 改用；首次 connect / 重連補漏 / 手動 action（suggestion 採用/發送、onSuggestionSent）照舊即時 fetch（補丁單禁改）。
**T755 全綠**（e2e-t600 5.5 段，BASE=3101）：3 assign（200ms 間隔）→ `page.on("request")` 計 `/api/conversations` GET 增量 = 1～2（debounce 前 = 3+）+ 公海計數 nAfter-3。**兩輪 suite 全綠（穩定）**。

### F-4
`quotes/page.tsx`：`canTeach = role==="ADMIN" && sessionScopeType(session)==="ALL"`（`@/lib/rbac`，同 API 同一口徑）。
**T750 全綠**（含新 f 格）：舊格式 iron-session cookie（sealData payload 無 scopeType/clinicIds）→ 報價頁 200 + pending 行見到 + `data-e2e="q-teach-toggle"` 出現。

### F-5
- `package.json`：`e2e:t600/601/601b/602/605/606/608/609/750/751` + `e2e:s0`
- `scripts/e2e-s0-all.sh`（chmod +x）：Stage 0 一鍵迴歸
- `scripts/_pw.ts`：`PW_CORE` 可覆蓋；t600/t750 改用 `import { chromium } from "./_pw"`（其餘 14 檔留 S6-1）

### F-6
mock-e2e.sh：`_restore_reminder_worker`（unset + pkill + 重起乾淨 worker）+ trap 兜底；現有收口段保留。**只改 code 未跑**（B3 地盤）；`bash -n` 通過。

### F-7（記錄，唔改 code）
| # | 觀察 | 點解唔改 |
|---|---|---|
| a | claim 搬到 enqueue 之後：enqueue 成功但 process 即刻死 → 訊息發出但 task 仍 SUGGESTED | 比舊版「task SENT 但訊息 FAILED」安全；S2-4 之後由 `followup:changed` 收窄 |
| b | 採用跟進建議發送多一次 workforce round-trip（最多 3 秒） | 正確性換延遲，可接受；F-1 之後最壞情況係 3 秒後 fail-open |
| c | 受限用戶開報價頁 → 向 workforce 拉 500 條 | S5-13（workforce clinic filter）會解決 |

### 跳過項
- **F-10**：已喺 CWM `1315da63`/`bfa36038`（workforce 側最後防線 + LLM log）— CWM 一個字未郁 ✅
- **F-0**：mock flag 檢查 = 老細 restart 前 todo（部署守则）
- **F-2 生產 SQL**：老細 server 低峰待辦
- **F-11**：可選未拍板

## 偏離記錄

1. **F-3 行號**：補丁單「`:1186` notify:assigned 同改」— 行號 +3 offset 對到 1189 行（suggestion handler，手動 action）；按 semantic + T755 驗收要求（assignee 收 `notify:assigned` 必須 debounce 先至 GET 增量 ≤2），改咗 `notify:assigned` handler（現行 916 行）；suggestion handler（1189）屬手動 action（同禁區 onSuggestionSent 類）未郁。
2. **F-6 trap 鏈接**：補丁單逐字 `trap _restore_reminder_worker EXIT INT TERM` 會蓋走檔頭全局 `trap cleanup EXIT`（line 346：殺 e2e server/worker + 清 e2e.lock）→ 改 `trap '_restore_reminder_worker; cleanup' EXIT` + `trap '_restore_reminder_worker; exit 130' INT TERM`（兜底語義相同，唔漏 e2e stack）。
3. **F-5 環境適配**：① `e2e-s0-all.sh` 內 pnpm 加 `--config.verify-deps-before-run=false`（worktree symlink node_modules → pnpm 11 deps check 拒跑，`ERR_PNPM_UNSAFE_MODULES_DIR`；main tree/CI 無害）；② t605 入口補 `NODE_ENV=production DUTY_MOCK= WORKFORCE_MOCK=0 WORKFORCE_API_URL=http://mock.invalid:9999`（補丁單逐字過唔到 script 自己個 env guard）；③ script 之間 `sleep 65`（login per-IP in-memory 限流 5 次/60s，全 e2e 共用 `local` IP → 第 3 輪 suite 實測 t608/t609/t750/t751 連坐 429）。
4. **F-3 mockInbound 環境適配**：t600/t606 `mockInbound` 由 `pnpm -s mock-inbound` 改 `./node_modules/.bin/tsx scripts/mock-inbound.ts` + `PORT` 跟 BASE（同一 pnpm quirk + webhook 要打自己個 3101）。
5. **t600/t601 UI timing 加固**：t600 (5) 行文字窗口 25s→45s；t601 T607h 建議卡 sleep(1s)→10s 有界等。原因：兩輪 suite 各 flake 一次舊有斷言（standalone 全綠；T755 GET 計數斷言兩輪全綠 = debounce 行為本身穩定）— 斷言語義不變。

## 環境/事故記錄

- **3101 server 被 B3 pkill 一次**：我個 `pnpm dev`（cmdline `tsx server.ts`）被 B3 mock-e2e cleanup 嘅 `pkill -f " server.ts"` 匹配殺死。重啟改 `./node_modules/.bin/tsx ./server.ts`（cmdline `./server.ts` 唔匹配 pattern）。交貨前會 exact PID kill。
- **mem0 唔可用**：127.0.0.1:18789 而家係 OpenClaw Control UI（非 mem0 API），toolset 無 mem0 tool — 本批 memory 寫入落呢份 report + Kairo notes（AGENTS.md：log warning、proceed、notify CEO later）。
- **worktree pnpm quirk**：pnpm 11.22.0 對 symlink node_modules 嘅 deps check 無解（.npmrc/env 都唔生效）— 唯一 `--config.verify-deps-before-run=false`。

## Gate 結果（7/7 全綠）

| # | Gate | 結果 |
|---|---|---|
| 1 | `tsc --noEmit` = 0 | ✅ 0 errors（最後複驗喺全部 commit 後，exit 0） |
| 2 | `npx next lint` 0 errors / 16 warnings | ✅ 0 errors；**16 warnings = baseline 數字，零新增**（全部係舊有檔：opt-out.ts / quotes UI img / hooks deps 等，冇一喺本批改動檔） |
| 3 | F-8 自檢 4 case + `bash -n` | ✅ **5/5**（A 正常值 / B 行尾註釋 / C 引號 / D `export KEY=` + 附加 leading-space case）+ `bash -n` OK；實跑 predeploy Redis 段行為正確（appendonly=no → ✗ 顯示實際值、noeviction → ✓） |
| 4 | T754 / T755 / T750 新格 | ✅ 全綠（T754 failopen+normal 雙模式；T755 兩輪 suite 穩定；T750 含 f 格舊格式 session） |
| 5 | `pnpm e2e:s0` 全綠（BASE=3101） | ✅ **S0 ALL GREEN**（10/10 script：t600/t601/t601b/t602/t605/t606/t608/t609/t750/t751，121 ✅，S0-EXIT=0；run 4 含 65s login pacing） |
| 6 | 紅線：D-2 零 + diff 檔清單 = 本單範圍（F-10/CWM 零改動） | ✅ `git diff d455564..HEAD` = **15 檔全部本單範圍**（無 prisma/schema.prisma、無 migration）；CWM（clinic-workforce-mvp）`git status --short` **零 tracked 改動**（只有舊 e2e script untracked，0910/0917 批次）；F-10 兩 commit `1315da63`/`bfa36038` 確認喺 CWM history |
| 7 | 3101 已清、3100/worker/15432 健康 | ✅ 3101 exact PID kill（2210715 → tsx wrapper 2210698 + bash wrapper 2210697 全退，port 3101 free）；3100 healthz=200；main worker（2205473/2205474/2205490）running 未受影響；15432 查詢正常（StaffUser count=9） |

## 交貨前清理確認

- **3101**：exact PID kill 完成（2210715；三個 process 全退、`ss -ltn` port 3101 free）
- **chromium orphan**：playwright 跑完後 pgrep 核 = **0 個**（各 e2e script 自帶 browser close）
- **e2e fixture**：各 script 自帶 cleanup + 零殘留斷言（suite 內全部通過）
- **B3 地盤**：3100/worker/15432 全程未 stop/restart/migrate（15432 只查询 + e2e 測試數據寫入）；中途 3101 曾被 B3 mock-e2e cleanup 嘅 `pkill -f " server.ts"` 誤殺（我個 `pnpm dev` cmdline 匹配 pattern）→ 改 `./node_modules/.bin/tsx ./server.ts` cmdline 規避（見環境記錄）

## T754 過程摘要（F-1）

1. 3101 server 加 `WORKFORCE_MOCK_FAIL=1`（mock client 全路徑 throw WorkforceApiError 500）
2. 建 fixture：STAFF + 病人 contact/conv + SUGGESTED task（apricotApptId 指向 mock appointments）
3. UI 外直接 POST `/api/messages/send`（session cookie）帶 followupTaskId → **202** + Message OUT + task SENT + sentMessageId 填入 + AuditLog FOLLOWUP_SENT(sentVia=AI_ADOPTED)
4. 3101 log grep 到 `send: followup precheck 依賴失敗 — fail-open 照發（F-1）`（workforce 500 被 catch，未 500 擋發送）
5. 對照 case（REPLIED 病人）→ **409 FOLLOWUP_NOT_SENDABLE** + task CANCELLED(reason=REPLIED) + 零 Message（REPLIED 檢查喺 appointments 分支之前）
6. 重啟 3101（無 FAIL flag）→ normal 模式同一 task 形 → 202 + SENT，log 無 fail-open 行（正常路徑未回歸）

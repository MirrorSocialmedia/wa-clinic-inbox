# cwi-qa 批次 1 報告 — Lane A（wa-inbox CI + 部署保險，階段 1）

- 日期：2026-09-28
- Kairo task：`mukvk8r0q5h8g`（CEO 管 — 未 mark）
- Branch：`qa-fix/lane-a`（由 main `5f83b08`）
- 範圍：FX-01 → FX-06 → FX-07 → FX-13 → FX-22（env 部分）

## 改咗邊啲檔

### FX-01 CI 真正跑得綠（commit `<sha>`）
| 檔 | 改動 |
|---|---|
| `package.json` | 加 `"packageManager": "pnpm@10.33.0"`（`pnpm/action-setup@v4` 要 version） |
| `.github/workflows/ci.yml` | job `timeout-minutes: 240`；postgres health-cmd 加 `-U postgres` + interval/retries；seed 後臨時 SQL 設 `admin@wa-clinic.local` scopeType=ALL（**FX-02 上線後刪** — 階段 2 Lane A）；unit loop 加 `timeout 150` |
| `eslint.config.mjs` | `scripts/**` 嘅 `@typescript-eslint/no-explicit-any` 降 warn（85 處全部係測試腳本快速取值；src/** 維持 error）。**⚠️ workorder 要求原因記錄喺 `docs/decisions/` — 該目錄歸 Lane B（並行規則），本 batch 先記錄於此檔 + progress，待 Lane B/CEO 補檔** |
| `scripts/e2e-hub-b.ts` / `e2e-s12-t700.ts` / `e2e-schedule-ui.ts` | prefer-const ×3（gen 1 改，gen 3 核實） |
| `scripts/e2e-consult-c6.ts` | `m3msg?.waMessageId!` → `m3msg?.waMessageId ?? ""`（non-null-asserted optional chain） |
| `scripts/unit-reopen-reply.ts` | combo test 補 `now: NOW`（漏傳 → 實際日期 vs fixture 2026-09-13 漂移 → age 條件假紅） |
| `scripts/unit-workflow-definitions.ts` | G5 結構化欄豁免（pain-triage questions/redFlagTerms/impressionTemplates、lexicon entries 按設計唔入 hints）；lexicon 全結構化 → 斷言 hints 空 |
| `src/lib/workflow/definitions.ts` | **擁有權例外（spec FX-01④ 要求修紅，最小改動）**：SCHEMA_HINTS.triage 補 2 個缺失 scalar hint — `autoReleaseMinutes`（min 1 max 1440）、`autoResolveDays`（min 1 max 30）。G5-triage 假紅根因（cwi-h6 / cwi-statusrole2 加欄時漏登記） |
| `scripts/unit-reminder.ts` / `unit-session-engine.ts` | 尾段 `closeRedis()` + `prisma.$disconnect()` + `process.exit(failed?1:0)`（import 鏈 module-level 建 8 個 BullMQ queue → event loop 唔空 → CI 卡 6 小時根因） |
| `scripts/mock-e2e.sh` | `--ci` 自足：`.env` 生成唔再綁 `! -f .env` 以外條件、補 `WA_APP_SECRET`/`WA_VERIFY_TOKEN`/`MEDIA_ENC_KEY`（恰 64 hex）、`TOTP_ENC_KEY` 改 32-byte base64（舊 24 bytes = TOTP enroll 500）；CI mode 寫 `.env.local`（APP_HOST=127.0.0.1:3100 / TRUST_PROXY=1 / 隨機 INTERNAL_LLM_SECRET）；fixture 檔無就生成（唔理 .env 存唔存在）；`uuidgen` → `node crypto.randomUUID()`；T81 redis 重啟修（`redis-server --port 6379 --bind 127.0.0.1 --daemonize yes`；CI = `docker restart` service container；兩者都冇 → 整段 SKIP 唔 SHUTDOWN）；尾建 `# === FX LANE A ===` / `# === FX LANE B ===` 空區塊（並行計劃 §0 規則 4） |

### FX-06 statement_timeout 只限 web（commit `<sha>`）
| 檔 | 改動 |
|---|---|
| `prisma/migrations/20260928000100_cwi_qa_fx06_reset_timeout/migration.sql` | `ALTER ROLE wa_inbox RESET statement_timeout`（guard 同 S6 一致 — role 唔存在跳過） |
| `ecosystem.config.cjs` | wa-inbox app 啟動時讀 .env `DATABASE_URL`（strip 引號）append `&options=-c%20statement_timeout%3D8000`（worker 唔加 = 無超時）；.env 冇 DATABASE_URL → 行為同舊版一致 |
| `.env.example` | DATABASE_URL 下註明兩條口徑（web 自動 append / worker 原 URL） |

### FX-07 APP_HOST 必填（commit `<sha>`）
| 檔 | 改動 |
|---|---|
| `server.ts` | boot guard：`NODE_ENV=production` 無 `APP_HOST` → `log.fatal` + `process.exit(1)`（喺 Next app 建立前 = 真 fail-fast） |
| `scripts/predeploy-check.sh` | APP_HOST 入必填 list；production 值唔准 `localhost`/`127.0.0.1`/`0.0.0.0` |
| `.env.example` | 加 `APP_HOST=`（無 scheme，= Cloudflare hostname）+ 用途/後果註明 |

### FX-13 Origin null/garbage → 403（commit `<sha>`）
| 檔 | 改動 |
|---|---|
| `src/middleware.ts` | origin parse 改 spec 版：`"null"` / parse 唔到 → `originHost=null` → 403 fail-closed（舊 `new URL(origin)` throw → 500）。server.ts socket `allowRequest` 本身已有 try/catch（同義）— 無需改 |

### FX-22 env 部分（commit `<sha>`）
| 檔 | 改動 |
|---|---|
| `.env.example` | 補 `TRUST_PROXY`、`HEALTHZ_TOKEN`、`TOTP_ENFORCE_FROM`（YYYY-MM-DD；註 FX-04 前唔准設）、`AI_JOB_DEADLINE_MS`、`GRAPH_TIMEOUT_MS`、`WORKFORCE_TIMEOUT_MS`+`WORKFORCE_WRITE_TIMEOUT_MS`、`ALLOW_SCOPED_ADMIN`（G3 閘）；`MEDIA_ENC_KEY` 格式註明改「恰 64 hex」；`TOTP_ENC_KEY` 已有 32-byte base64 註明（核實無改） |

## 測試結果

### 本機 gates（2026-09-28）
| Gate | 結果 |
|---|---|
| `pnpm typecheck` | 綠（含 server.ts / middleware.ts / definitions.ts 改動） |
| `npx eslint .` | **0 errors**（140 warnings — 85 any 降 warn 入內；基線 89 errors / 55 warnings） |
| unit-reopen-reply | 36/0 綠（修前 1 紅） |
| unit-workflow-definitions | 37/0 綠（修前 G5×3 紅） |
| unit-reminder / unit-session-engine | PASS + **正常退出**（修前 event loop 唔空卡死） |
| unit-company-sync / unit-knowledge | 本機綠（gen 1 實測 15/0、50/0）— CI 全新 DB 紅先複現決定改法，未盲改 |
| T760 雙向實測 | plain URL `SHOW statement_timeout`=0 / URL+options=8s ✅ |
| T761 boot 實測 | `NODE_ENV=production tsx server.ts`（無 APP_HOST）→ exit 1 + fatal log ✅ |
| mock-e2e 全量（本地） | **round 1**：349/0 到 T74 後卡死（bash `do_wait` 無 child — kernel/bash wait 異常，非測試失敗）→ kill；**round 2**：`<待填>` |
| LANE A 新測試 T760/T761/T765 | `<待填 — e2e round 2 後 insert + 驗證>` |

### GitHub Actions
- `<push 後填：run 觸發 sha + 時間 + URL；查唔到狀態就標「待 CEO/PAT 驗證」— 唔聲稱已綠>`

## 未做到嘅嘢同原因
1. **Actions 驗證**：GitHub API token 未到位 — push 後未必查得到 run 狀態（按施工單規則 3 處理）。
2. **`docs/decisions/` eslint 降級記錄**：該目錄歸 Lane B（並行擁有權）— 本報告 + progress 先記錄，待 Lane B/CEO 補檔。
3. **`docs/fixplan/cwi-final-stage-{1..6}-report.md` + `docs/decisions/2026-09-17-llm-proxy.md`**（FX-22 其餘部分）：歸 Lane B（wa-inbox `docs/**`）。
4. **CI 臨時 SQL**（seed 後 admin scopeType=ALL）：by design 臨時 — FX-02 上線（階段 2）後刪。
5. **e2e round 1 stuck**：bash wait 異常（見上）— round 2 驗證；若重現 → mock-e2e.sh wait 模式要修。
6. **gen 1 曾改 `docs/drills/restore-drill-2026-09.md`**（drill 記錄 append）：唔屬 Lane A 擁有權 → gen 3 已 revert（drill 結果「OK」留痕於 progress 15:52 段，Lane B/CEO 可重跑補檔）。

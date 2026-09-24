# A9 — consult 首輪唔報價（first turn never quotes）

**日期**: 2026-09-17（診所拍板）／2026-09-24（實作 — W Stage 4 E3）
**狀態**: 已上線（mock e2e T659 + unit/e2e-consult 全覆蓋）

## 產品決策（逐字）

> 首輪唔報價：第一句問需求 + 病情邀請，唔出任何價格/範圍；病人**再追問**（第二輪或之後問價）先答價格範圍。
> 目的：避開「第一句就報價」嘅 salesy 感 + 確保 AI 有至少一輪了解需求/牙齒情況先才講價錢。

## 實作口徑

| 層 | 改動 |
|---|---|
| 報價鏈（pipeline.ts） | 加 `consultTrigger === null` — 報價鏈（deterministic 報價覆寫 / NO_PRICE_TEXT / stage price-guard）唔再搶 consult 話題；`priceTrace.triggered` 照計（trace/guard 用）；`citedPriceDoc` 兩類話題都照常認定（ANSWER_PRICE 輪用） |
| engine #14 | 加 `session.turnCount >= 1 && minimumSlotsMet(workflow, slots)` — 指名產品都要先了解需求先報價 |
| engine #14b（新 row 141） | `DISCOVER + asksPrice + priceAskCount>=1 + turnCount>=1`（唔要求 namedProduct/minSlots）→ `ANSWER_PRICE` / ruleId `A9-REASK` |
| 外層首輪保護 | `consultTransition` = `consultTransitionInner` + turnCount===0 && ANSWER_PRICE → remap ASK_DISCOVERY/ASK_FOR_CONSULTATION + ruleId `A9-FIRST-TURN`（defense-in-depth — 現行規則表 turn 0 已唔會出 ANSWER_PRICE；#9 START_BOOKING 唔經 ANSWER_PRICE → 唔受影響） |
| 生成（consult-llm / consult-runner） | `priceRange` 只喺 `action === "ANSWER_PRICE"` 入 payload；新欄 `patientAskedPrice = extract.askedPrice ∨ priceTrace.triggered` — ASK_DISCOVERY 時 prompt/mock 先講「收費會因應你嘅牙齒情況而唔同，想先了解多少少」（零金額），再問指定問題 |
| price guard（pipeline ⑪） | `priceDocForTurn = action === "ANSWER_PRICE" ? citedPriceDoc : null` — 非 ANSWER_PRICE 輪 LLM 出任何金額 = 幻覺 → 擋 |
| fallback（⑤） | ASK_DISCOVERY/ASK_FOR_CONSULTATION 且（LLM 失敗 ∨ price guard blocked）→ deterministic 安全句 `Hello☺️ [費note?] {discovery 問題}`（model `a9-safe-fallback`）— 唔再用 classify 草稿（可能含價）；其他 action 失敗照舊 |
| R-7 合併（⑥） | `applyRoutingFirstReply({ composeWith })` — consult 首輪（ASK_DISCOVERY/ASK_FOR_CONSULTATION）草稿 = `${discovery 草稿}\n\n${rule.autoReplyTemplate}`，model `routing-r7+consult`；`routedFirstReplyAt` 原子閘保留（每對話一次）；admin UI 欄下提示（唔改 DB） |
| 設定頁（⑦） | consult-settings Tab 2 加鎖定行「🔒 第一輪唔報價…（診所拍板 2026-09-17）」；`rules.ortho_price` 關咗 = 連第二次都唔答（#14/#14b 都 skip） |

## GC 對齊

- **GC-A9-1～5**（`scripts/seed-golden-a9.ts` 入 GoldenCase 表，`enabled=false` 待真機校準）：首輪零金額 + discovery 問題 + 費 note；A9-REASK 範圍；R-7 合併；fallback 安全句；injection 唔跟。
- **舊「第一輪報範圍」期望改動清單**（DB 無 consult GC row — 全係測試斷言）：
  - `scripts/unit-consult-engine.ts`：#14 首輪 → row 16；priority「指名問價 > 比較」→ 首輪 row 15（比較先）；新 #14 turn1+slots / #14b A9-REASK / 首輪唔觸發 case
  - `scripts/e2e-consult-c3.ts` S14：首輪 row 16 + 再追問 row 141 A9-REASK
  - `scripts/e2e-consult-c4.ts` P 段：warm-up 後加 speed slot turn（turn 2 row 16）→ turn 3 指名問價 row 14 + 範圍；M-warmup model `routing-r7` → `routing-r7+consult`（合併草稿）
  - `scripts/e2e-consult-c6.ts`：gc14b/gc15 改 A9-REASK 三 turn 流；gc16 price-guard BLOCK → A9 fallback 安全句（唔再係 NO_PRICE_TEXT）
  - `scripts/unit-prompts.ts`：msgLine 格式 → 一行一條 `JSON.stringify({dir, ts, text})`（S4-7 P2-09 injection 加固）
- **非 consult 報價流唔受影響**：洗牙 $580 類（price chain）照舊 — 只收窄咗 consult 話題。

## 驗證

- T659（mock-e2e）：GC-A9-1～5 + `E2E-A9-PRICE-LEAK`（mock 故意出 $28,000 → price guard 擋 → fallback 安全句）
- unit-consult-engine（128 checks）+ e2e-consult-c1/c3/c4/c6 全跑
- GoldenCase 真機（`eval:golden`，enabled=true 先計）= 老細側 4 項

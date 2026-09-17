# Retention Policy（資料保留期）

## 2026-09-16 確認：對話 24 個月、媒體 12 個月

老細拍板（cwi-followup-v3-20260916，MD §6 A-2）：

| 數據 | 保留期 | env |
|------|--------|-----|
| 對話訊息（Message + NoteReadReceipt + PatientFact 聯動行） | **24 個月** | `RETENTION_CONV_MONTHS=24` |
| 媒體檔（碟上加密檔；訊息殼留到對話期） | **12 個月** | `RETENTION_MEDIA_MONTHS=12` |
| AiDraft（只刪 status ≠ PROPOSED） | 90 日 | `RETENTION_DRAFT_DAYS=90` |

## 一致性鐵律（MD §6 A-2）

1. **env 必須明確寫入**（`.env` — 唔靠 code default）：`RETENTION_CONV_MONTHS` / `RETENTION_MEDIA_MONTHS`。
2. **Startup 檢查**（`src/lib/ops/retention-policy.ts`）：server（`server.ts`）同 worker（`src/workers/index.ts`）開機即核 env vs `POLICY_RETENTION_MONTHS=24` / `POLICY_RETENTION_MEDIA_MONTHS=12` — 唔一致或唔設 → **拒啟**（T432）。
3. **同 privacy 頁文案同源**：`POLICY_RETENTION_MONTHS` 常數 = 政策頁顯示數字嘅唯一來源；改政策要一齊改常數 + 文案 + 本檔 + env。

## 改政策流程

老細改拍板 → ① 本檔記日期+新數字 ② 改 `retention-policy.ts` 常數 ③ 改 privacy 頁文案（zh/en） ④ 改 `.env` ⑤ startup 檢查自動兜底（唔對就拒啟）。

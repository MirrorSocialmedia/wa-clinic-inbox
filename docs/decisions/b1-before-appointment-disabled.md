# B1 預約提醒規則（BEFORE_APPOINTMENT）預設停用

## 2026-09-19 決定：seed 預設關（cwi-final F-2 / D-9）

### 背景
- v3 seed 出廠規則 `預約提醒（診前 1 日）`（trigger = `BEFORE_APPOINTMENT`）原本 `enabled: true`（create-if-missing）。
- S0-8 只擋「由 disabled 再 enable」（`admin/followups/rules/[id]/route.ts` 要 `firstUseConfirmedAt`），冇停用已經開住嘅規則。
- 現行 `engine.ts` 取消條件把 `bookingStatus` 0 **同 102** 都當有效預約 → 前台會見到「被改期嘅舊單」嘅提醒建議。S2-1（B1 只取 `bookingStatus = 0`）未上線前，B1 出嘅建議唔可靠（D-9：S2-1 之後先開 B1）。

### 決定
1. `prisma/seed.ts`：B1 規則 create-if-missing 時 `enabled: r.trigger === "BEFORE_APPOINTMENT" ? false : true`（其他規則不受影響）。
2. 生產 DB 由老細低峰執行停用 SQL（補丁單 F-2 ①②③；停用未確認 B1 + 清未處理 B1 建議）— 2026-09-19 交貨，執行時間待補。
3. 已開住嘅規則唔會由 code 自動關（避免改運行中生產配置）；re-seed 唔會再開返 B1。

### 重開條件（全部滿足先由 UI 開）
1. **S2-1 上線**：B1 只取 `bookingStatus = 0`（改期/取消舊單唔再計作有效預約）。
2. **UI 首次啟用確認**：經 `admin/followups/rules/[id]` S0-8 守門（寫 `firstUseConfirmedAt`）。
3. **觀察一星期**：無誤報（改期舊單提醒）先算完成收口。

### 驗證口徑
```sql
SELECT count(*) FROM "FollowupTask" t JOIN "FollowupRule" r ON r.id = t."ruleId"
WHERE r.trigger = 'BEFORE_APPOINTMENT' AND t.status = 'SUGGESTED' AND t."createdAt" > now() - interval '30 minutes';
```
兩輪 followup-scan 之後應該 = 0。

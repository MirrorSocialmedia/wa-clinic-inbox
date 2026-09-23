# D-11：ADMIN 發送都要先接手（Send Lock 零豁免）

## 2026-09-17 決定（cwi-final S3-3，audit3 P1-02 跟進）

### 背景
- H1 Send Lock（MD §3.2）：對話有負責人時，只有負責人可以發 WhatsApp（其他店內員工 → 423 SEND_LOCKED）。
- `messages/send/route.ts` 一直係**零豁免**口徑：`if (conv.assigneeId && conv.assigneeId !== ctx.staff.id)` — 非負責人（**包 ADMIN**）照 423（T97 迴歸：ADMIN 要先接手（變 assignee）先可以覆）。
- 唯一例外：`conversations/[id]/flows/route.ts` 有 `ctx.staff.role !== "ADMIN"` 豁免（cwi-h6-20260830 §8）— ADMIN 未接手可以直接發 Flow。兩條同類 route 口徑不一致 = audit3 P1-02。
- 而外，`bookings/[id]/confirm`（自動發確認訊息）/ `bookings/[id]/reschedule`（重出 Flow）都有發訊息副作用但完全冇 Send Lock。

### 決定
1. **ADMIN 一律要先撳〔接手〕先可以發**（打字、Flow、確認、改期都一樣）— flows 嘅 ADMIN 豁免刪走，同 `messages/send`（T97）口徑統一。
2. Send Lock 抽單一來源 `src/lib/send-lock.ts` `sendLockResponse(ctx, conv)`（有負責人而唔係自己 → 423；ADMIN 都唔豁免），`flows` / `bookings/[id]/confirm` / `bookings/[id]/reschedule` 三條 route 共用（route 用法：`const locked = sendLockResponse(ctx, conv); if (locked) return locked;`）。
3. 同一項（S3-3 SUPERVISOR 寫入邊界）：`patient-pin` POST/DELETE、`app-handoff`、`flag`、`golden-cases` POST、`contacts/[id]` PATCH（S2-8 已入）、`notices` PATCH 一律 `assertCanWriteConversation`（SUPERVISOR = 睇 + 內部備註，403）。
4. mock-e2e 核實（2026-09-23）：無 case 依賴 flows 嘅 ADMIN 豁免 — H6-T97 本身已係「ADMIN 先接手（assign target=ADMIN）再發」pattern；所有 flows/confirm case 都由當時負責人（或預期 423 嘅非負責人）發出。零改動。
5. 矩陣（T630）：S3-3 受影響 route 嘅 SUPERVISOR 格 = 403；confirm/reschedule/flows 嘅非負責人 STAFF/ADMIN 格 = 423。

### 影響面
- ADMIN 喺「非自己負責」嘅對話撳 Flow/確認/改期 → 423 SEND_LOCKED（之前 flows = 200，confirm/reschedule = 200/422）— UI 提示「此對話已有負責人…或撳〔接手〕」。
- SUPERVISOR 對上述 6 route 寫入 → 403（之前 = 可寫）。

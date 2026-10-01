# cwi-ux-07 Progress — 負責人跨分店預約 (trace-cwi-ux-07)

## Status: STARTED 2026-10-01 15:01 HKT
worktree: /home/kenneth/.openclaw/workspace/wa-ux-07 @ cwi-ux/fix07 (base 912b108)

## Flags
- ⚠️ spec §7.3 `/api/search mine=1` 寫「（同公司）」同拍板①（跨公司容許）衝突 → 以拍板為準：mine=1 = 我負責緊嘅對話，唔按公司過濾。

## Phase 0（workforce contract test）— 完成 15:12

**結論：CWM 代碼路徑無跨公司拒；dev 環境 WRITE 閘阻真寫 → 用 mock workforce 驗證寫路徑 + flag 老細。**

實測（CWM dev 3001 真實 API，tmp key `ux07-phase0-tmp` scope=availability+bookings，已建 dev DB）：
1. `GET /api/external/v1/availability?clinicCode=TY`（TY=菁薈，跨公司）→ 200 OK（`stale:true` 只係 cache 空）→ 跨公司讀 OK
2. `GET ...clinicCode=TKW`（本公司 匯樂）→ 200 OK
3. `POST /api/external/v1/bookings`（clinicCode=TY + patient={patientApricotId}）→ **503 `WRITE_DISABLED`**（HTTP 503）
   - 根因：CWM dev `APRICOT_WRITE=0`（.env.development）— dev 唔開真寫（防寫 production Apricot apricotvita.com）
   - 門序（guards.ts）：auth → **requireWriteEnabled（503）** → parse patient → 新客 flag → resolveClinic → createBooking → 503 喺 clinic/patient 邏輯**之前**fire → 唔係跨公司拒
4. 靜態：`write-booking.ts` / `bookings/guards.ts` / `external-clinic.ts` **零 company 檢查** — 舊客 `clinicPatient={id:apricotId}` 原樣傳 Apricot；CWM 全系統單一 Apricot credential（`ExternalCredential` provider=APRICOT）→ 病人 id 係 Apricot account 層級全局，6 間店同一 login
5. CWM dev DB 有第二間公司 clinic 數據：TY（菁薈 fup0cmpa…001）、E2E T2CACHE（E2E26）；匯樂=TKW/YL/WTC、臻善=MF/TW/YMT → 「dev 冇第二間公司」fallback 唔適用

🔴 **Open flag 老細**：production Apricot 真跨公司 createBooking 接受度無法由 dev 驗證（WRITE=0；要 production 寫）。C-8 口徑（outsideCompany 黃標「唔阻」）+ 單一 Apricot account 模型 → 推斷 OK；建議老細上線前做一次真跨公司預約實測收尾。

W 側：寫路徑用 mock workforce（WORKFORCE_MOCK=1）驗證（T-UX07c），mock 對等行為 = 接受跨公司（同 CWM 代碼一致）。

## Liveness
- 15:01 started
- 15:06 worktree 建好（node_modules/.env/.env.local symlink 主樹）
- 15:12 Phase 0 完成
- 15:40 Phase 1 code 探索完成 — 開始寫 code
- 15:55 C2 commit（manual route）
- 16:05 C3 commit（flow chain：token/send/flows route/endpoint/flow-reply/hold commit/reschedule）
- 16:18 C4 commit（worker/confirm 店名址/reminder/patient-appointments reschedule+cancel）— tsc 0
- 16:30 C5a server commit（/api/search mine=1 + /api/conversations mine=1）
- 16:40 C5b client（schedule board popover 兩組＋跨店確認框＋bookingClinicId 參數）— tsc 0

## Commits
- `521ecfb` C1 schema：BookingRequest/FlowSession +bookingClinicId + effectiveBookingClinicId/isCrossClinicBooking/targetClinicSlotWhere helper（migration 已 apply dev 15432 + resolve + generate）
- `d37e2ca` C2 manual route：bookingClinicId 跨分店落單（時段/dup/slotAvailable 全用目標店；非負責人跨店 403 CROSS_CLINIC_NOT_ALLOWED 喺 Send Lock 前）
- `3910274` C3 flow chain：token 簽名帶 bookingClinicId（舊 token 兼容）；send/flows route（403 喺 sendLock 前）；endpoint 全鏈目標店（freshness/refresh/slots/claim/hold/audit）；flow-reply token↔session 一致性 + 目標店 precheck/existingPending/create；reschedule 重發 flow 帶 bookingClinicId；hold commit 跨店 conversation-level auth fallback
- `fc1e1fa` C4 worker/改期取消/提醒：createBooking clinicCode=目標店；確認訊息店名+地址=目標店（🔴 叫病人去錯店）；afterBookingWrite/AI reply/audit 目標店；24h reminder 目標店名；patient-appointments cancel/reschedule 容許對話店或已用 bookingClinicId 目標店
- C5（next commit）server+client：/api/search mine=1（我負責緊嘅對話，唔按店；ConversationHit 帶 conversationId）+ /api/conversations mine=1（完整 DTO）；schedule board popover 兩組（本店對話＋我負責緊其他店）＋跨店確認框＋Flow/落單帶 bookingClinicId；目標店時間表「已佔」= TAKEN 不可撳（天然成立，零改動）

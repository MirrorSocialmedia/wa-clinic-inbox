# WA Clinic Inbox

WhatsApp AI 覆客系統 — 六間牙醫診所共用 inbox。Meta Cloud API 直連（Tech Provider）+ 全本地 AI（vLLM）+ Apricot 空檔讀取。

> 完整框架：見 repo 外 MD `wa-clinic-inbox-framework` v1.0。本 repo 為獨立 project（獨立 DB / 獨立 process），唔掂 clinic-workforce 底層。

## 技術棧

- **Next.js 15** (App Router, TypeScript) + custom `server.ts`
- **Socket.IO 4** — 實時推 inbox（room = `clinic:{id}`）
- **PostgreSQL 16 + Prisma** — 獨立 DB `wa_inbox`、獨立 role
- **Redis 7 + BullMQ** — webhook 秒回、發送重試、AI job、cron
- **pino** — 統一 log（★ PII 鐵律：訊息原文永不入 log）
- **PM2** — `wa-inbox`（web）+ `wa-worker`（BullMQ）兩個 process

## 快速開始

```bash
cp .env.example .env   # 填 DATABASE_URL / REDIS_URL / WA_* / SESSION_SECRET ...
pnpm install
npx prisma migrate dev # 首次建表（本地要有 DB）
pnpm dev               # web server + Socket.IO @ :3100
pnpm worker            # 另一個 terminal 起 BullMQ workers
```

## 常用命令

| 命令 | 用途 |
|------|------|
| `pnpm dev` | dev server（tsx server.ts，NODE_ENV≠production） |
| `pnpm build` | prisma generate + next build |
| `pnpm start` | production server |
| `pnpm worker` | 起 4 個 BullMQ workers（inbound/outbound/ai/cron） |
| `pnpm typecheck` | tsc --noEmit |
| `pnpm prisma:validate` | 校驗 schema 語法 |
| `pm2 start ecosystem.config.cjs` | production 兩 process |

## 端點

- `GET /healthz` — 健康檢查（DB/Redis/AI；AI down = degraded 唔算 fail，DB/Redis down = 503）
- `GET/POST /api/wa/webhook` — Meta webhook（GET 驗證握手 / POST 驗簽→入隊→極速 200）
- `/socket.io/*` — Socket.IO（掛同一 port）

## 架構重點

- **分流**：webhook `phone_number_id` → `Clinic.waPhoneNumberId` 決定屬邊間店
- **冪等**：`wamid` upsert `WebhookEvent`（Meta 會重發）
- **PII**：log 只記 metadata；`redactDeep()` 任意深度 redact `body/text/draftText/message`
- **RBAC**：ADMIN 跨店 / STAFF 硬綁 `clinicId`（`src/lib/rbac.ts`）
- **AI 降級**：GPU 離線 = inbox 照常，冇標籤冇草稿而已

## 安全

- 所有 API route（webhook/flows/healthz 除外）過 `rbac.ts`
- 訊息原文永不入 log、永不外送第三方
- DB volume + `/srv/wa-media` 開 encryption at rest；backup 先加密先落地

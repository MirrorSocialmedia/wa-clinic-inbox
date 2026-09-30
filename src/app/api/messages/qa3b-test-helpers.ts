/**
 * cwi-qa stage3-b（Agent B / 附件+API lane）unit test 共用 helpers。
 *
 * 口徑（跟 FX-03/FX-05 既有 .test.ts convention）：node:test 直打 route handler —
 * - NextRequest 手工造（cookie = iron-session sealData 偽 session）
 * - 真 dev DB（DATABASE_URL）+ 真 dev Redis（REDIS_URL）— fixture 全部用唯一 id 前綴，
 *   after() 逐項清走（唔會撞 dev server / mock-e2e 嘅活數據）
 * - 本地跑要 env：CI 有 workflow env（DATABASE_URL/REDIS_URL）；本地 = 呢度 loadEnvIfMissing()
 *   由 repo root .env 補（唔覆蓋已有 process env）。
 *
 * 呢個檔本身唔係 test（冇 .test.ts 結尾 → tsx --test glob 唔會當 test 跑）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { PrismaClient, type MsgStatus } from "@prisma/client";
import { sealData } from "iron-session";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** src/app/api/messages → repo root（4 層上） */
export const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

/** CI：DATABASE_URL/REDIS_URL/SESSION_SECRET 由 workflow env 提供；本地：由 root .env 補（唔覆蓋）。 */
export function loadEnvIfMissing(): void {
  if (process.env.DATABASE_URL && process.env.REDIS_URL && process.env.SESSION_SECRET) return;
  const p = join(REPO_ROOT, ".env");
  if (!existsSync(p)) throw new Error(`qa3b helpers: 無 .env（${p}）— DATABASE_URL/REDIS_URL/SESSION_SECRET 必需`);
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

/** 偽 iron-session cookie（同 login route 寫出嘅 SessionData 格式 — flat：staffId/email/name/role/…）。 */
export async function sessionCookie(o: {
  staffId: string;
  role: "ADMIN" | "STAFF" | "SUPERVISOR";
  name: string;
  email: string;
  clinicId: string | null;
  clinicIds?: string[];
  scopeType?: "ALL" | "COMPANY" | "CLINICS";
  scopeCompanyId?: string | null;
}): Promise<string> {
  const data: Record<string, unknown> = {
    staffId: o.staffId,
    email: o.email,
    name: o.name,
    role: o.role,
    clinicId: o.clinicId,
    clinicIds: o.clinicIds ?? [],
    loginAt: Date.now(),
    sid: randomUUID(),
  };
  if (o.scopeType) {
    data.scopeType = o.scopeType;
    data.scopeCompanyId = o.scopeCompanyId ?? null;
  }
  const sealed = await sealData(data, { password: process.env.SESSION_SECRET!, ttl: 86_400 });
  return `wa_inbox_session=${sealed}`;
}

const BASE_URL = "http://127.0.0.1:3100";

export function jsonReq(path: string, body: unknown, cookie: string): NextRequest {
  return new NextRequest(BASE_URL + path, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

export function getReq(path: string, cookie: string): NextRequest {
  return new NextRequest(BASE_URL + path, { method: "GET", headers: { cookie } });
}

export function formReq(path: string, form: FormData, cookie: string): NextRequest {
  // undici 自動帶 multipart boundary；cookie 手工加
  const headers: Record<string, string> = { cookie };
  return new NextRequest(BASE_URL + path, { method: "POST", headers, body: form });
}

/** 讀走 response body（防 undici stream 掛住 event loop → 測試 hang）。 */
export async function drainRes(res: Response): Promise<void> {
  try {
    if (res.body) await res.body.cancel();
    else await res.text();
  } catch {
    /* noop */
  }
}

export async function readJson<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json().catch(() => null)) as T;
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

export interface ConvFx {
  clinicId: string;
  contactId: string;
  convId: string;
  staffId: string; // seeded admin
}

/**
 * 建一組隔離 fixture：TKW 診所 + 新 Contact + 新 Conversation（OPEN、未 claim）。
 * prefix = 唯一測試前綴（入 id → 清理 + 除錯）。
 */
export async function createConvFx(
  prisma: PrismaClient,
  o: { prefix: string; lastInboundAt?: Date; assigneeId?: string | null }
): Promise<ConvFx> {
  const clinic = await prisma.clinic.findFirst({ where: { code: "TKW" } });
  if (!clinic) throw new Error("qa3b fixture: TKW clinic 未 seed");
  const staff = await prisma.staffUser.findUnique({ where: { email: "admin@wa-clinic.local" } });
  if (!staff) throw new Error("qa3b fixture: admin 未 seed");
  const lastInboundAt = o.lastInboundAt ?? new Date();
  const contact = await prisma.contact.create({
    data: {
      waId: `60${String(Date.now()).slice(-8)}${String(Math.floor(Math.random() * 90) + 10)}`,
      profileName: `${o.prefix} C`,
      labels: [],
      clinicId: clinic.id,
    },
  });
  const conv = await prisma.conversation.create({
    data: {
      id: `${o.prefix}-${randomUUID()}`,
      contactId: contact.id,
      clinicId: clinic.id,
      status: "OPEN",
      lastInboundAt,
      lastMessageAt: lastInboundAt,
      assigneeId: o.assigneeId ?? null,
    },
  });
  return { clinicId: clinic.id, contactId: contact.id, convId: conv.id, staffId: staff.id };
}

export interface OutMsgFx extends ConvFx {
  messageId: string;
}

/** 建一條 OUT/API 訊息（retry / media serve / DTO 測試用）。 */
export async function createOutMsgFx(
  prisma: PrismaClient,
  o: ConvFx & {
    prefix: string;
    type?: string;
    body?: string;
    createdAt?: Date;
    status?: string;
    mediaKey?: string;
    mediaPath?: string;
    mediaName?: string;
    waMediaId?: string;
    waMessageId?: string;
  }
): Promise<OutMsgFx> {
  const createdAt = o.createdAt ?? new Date();
  const msg = await prisma.message.create({
    data: {
      id: `${o.prefix}-m-${randomUUID()}`,
      conversationId: o.convId,
      direction: "OUT",
      channel: "API",
      type: o.type ?? "text",
      body: o.body ?? null,
      status: (o.status ?? "FAILED") as MsgStatus,
      sentByStaffId: o.staffId,
      billingCategory: "SERVICE",
      mediaKey: o.mediaKey ?? null,
      mediaPath: o.mediaPath ?? null,
      mediaName: o.mediaName ?? null,
      waMediaId: o.waMediaId ?? null,
      waMessageId: o.waMessageId ?? null,
      waTimestamp: createdAt,
      createdAt,
    },
  });
  return { ...o, messageId: msg.id };
}

/** 逐項清 fixture（FK 安全順序）+ 相關 audit 行。 */
export async function cleanupFx(
  prisma: PrismaClient,
  fx: ConvFx,
  o: { messageIds?: string[]; followupTaskIds?: string[] } = {}
): Promise<void> {
  const msgIds = o.messageIds ?? [];
  const taskIds = o.followupTaskIds ?? [];
  if (taskIds.length) {
    await prisma.followupTask.deleteMany({ where: { id: { in: taskIds } } }).catch(() => {});
  }
  if (msgIds.length) {
    await prisma.message.deleteMany({ where: { id: { in: msgIds } } }).catch(() => {});
  }
  await prisma.auditLog
    .deleteMany({ where: { entityId: { in: [...msgIds, ...taskIds, fx.convId] } } })
    .catch(() => {});
  await prisma.conversation.deleteMany({ where: { id: fx.convId } }).catch(() => {});
  await prisma.contact.deleteMany({ where: { id: fx.contactId } }).catch(() => {});
}

/** HKT 日期字串（app 全口徑；telemetry dedup key 用）。 */
export function hktDateStr(d: Date = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" });
}

/**
 * Follow-up 引擎（followup-v2 MD §4 — P3 A/B/F 三類先上）
 *
 * 排程（cron "followup-scan" 每 10 分鐘）：對每條 enabled 規則掃候選 → 查重 + opt-out + 配對
 * → 建 FollowupTask（SCHEDULED/DUE）→ L2 到期即發；L1 入「待跟進」隊列等人撳。
 *
 * 🔴 紅線（MD §6 + 老細 07:31）：
 * - wa-inbox 唔存臨床全文：contextJson/templateVars 只入**顯示用**結構化數據
 *   （到診日期/欠款金額/預約時間/醫生名）— 零臨床全文、零原始電話（只 phoneHashes）。
 * - opt-out 永遠優先：任何規則唔可 override（自動偵測 + 手動 toggle）。
 * - 窗口過咗只可 template（registry approved=true）；未審批 → SKIPPED(NO_TEMPLATE) 唔真發。
 * - 發送行 W 現有 outbound 機制（Message QUEUED → outbound worker）；
 *   sentVia = AI_AUTO（L2）/ AI_ADOPTED（L1 人撳）→ 唔觸發 human cooldown（cooldown 只計 HUMAN_TYPED）。
 * - audit FOLLOWUP_SENT / FOLLOWUP_OPT_OUT / FOLLOWUP_REPLIED 零 PII；billingCategory = UTILITY。
 *
 * 配對（P0 多號 E.164）：Contact.waId → phoneHashes(waId) ↔ appointment.phoneHashes hasSome。
 * 配唔到對話 → 唔建 task（P3 口徑；第二期街客召回先處理 — MD §4.3 NO_CONVERSATION 只係
 * scan 計數，唔落 task 行：唔配到 = 無 WA 對話可發，建咗都係永久死 task）。
 *
 * 取消條件（MD §4.4 — **每次發送前重跑**，唔止建 task 時）：
 *   OPT_OUT（永遠檢查）/ REPLIED / BOOKED / ARRIVED / RESOLVED / PAID（F 類）。
 *
 * 冪等（重跑安全）：查重 = 同 rule + 同 conv/patient 已有 SCHEDULED/DUE → 跳；
 *   SENT 數 >= maxSends → 跳；NO_TEMPLATE SKIPPED 24h 內且 template 仍未審批 → 跳
 *   （防 10 分鐘一條 SKIPPED 冚爆表；template 審批後抑製自然解除 → 重掃可再建）。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { Prisma } from "@prisma/client";
import { phoneHashes } from "@/lib/phone-hash";
import { hkDateOffset, hkTodayStr } from "@/lib/availability";
import {
  fetchAppointmentsByClinic,
  fetchPatientBalance,
  fetchClinicVisits,
  fetchQuotes,
  WorkforceApiError,
  type BatchVisit,
  type ClinicAppointment,
  type WorkforceQuote,
} from "@/lib/workforce/client";
import { getWindowState } from "@/lib/wa/window";

// ★ 延遲 import（同 booking/reminder.ts 口徑）：outboundQueue/publishNotify 拉起 Redis 連接 —
//   unit test（零 Redis）import 呢個 module 時唔連坐。
async function lazyEnqueue(messageId: string): Promise<void> {
  const { enqueueOutboundSend } = await import("@/lib/queue");
  await enqueueOutboundSend(messageId);
}
async function lazyNotify(clinicId: string, event: string, payload: unknown): Promise<void> {
  const { publishNotify } = await import("@/lib/notify");
  publishNotify(clinicId, event, payload);
}

const DAY_MS = 86_400_000;

// ── 工具 ─────────────────────────────────────────────────────────────────

export function delayToMs(delayValue: number, delayUnit: string): number {
  switch (delayUnit) {
    case "HOUR":
      return delayValue * 3_600_000;
    case "DAY":
      return delayValue * DAY_MS;
    case "WEEK":
      return delayValue * 7 * DAY_MS;
    case "MONTH":
      return delayValue * 30 * DAY_MS; // 近似（規則頁顯示會標「約 N 個月」）
    default:
      return delayValue * DAY_MS;
  }
}

/** HH:mm（HK）+ YYYY-MM-DD → epoch ms（同 booking/reminder.ts hkApptEpochMs 口徑）。 */
export function hkApptTimeMs(dateStr: string, timeStr: string): number {
  const t = (timeStr ?? "").slice(0, 5);
  return new Date(`${dateStr}T${t || "00:00"}:00+08:00`).getTime();
}

/** 渲染 {{var}}；缺變數 → 空字串（唔留佔位符出街）。 */
export function renderFollowupText(text: string, vars: Record<string, string | number | null | undefined>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => {
    const v = vars[k];
    return v === null || v === undefined ? "" : String(v);
  });
}

/** 候選對話 → 配對病人（pinned 優先；零 workforce call）。 */
export function pinnedPatientOf(conv: { pinnedPatientApricotId: string | null }): string | null {
  return conv.pinnedPatientApricotId;
}

/** contact.waId → hash set（server 端算 — raw phone 永唔出）。 */
function contactHashSet(waId: string): Set<string> {
  const hs = phoneHashes(waId);
  return new Set(hs);
}

function hasSome(a: Set<string>, b: readonly string[]): boolean {
  return b.some((h) => a.has(h));
}

// ── 查重（MD §4.3）───────────────────────────────────────────────────────

export type CreationSkip = "in-flight" | "exhausted" | "no-template-suppressed" | null;

/**
 * 建 task 前查重：
 * - in-flight：同 rule + 同 conv/patient 已有 SCHEDULED/DUE（進行中，唔重複建）
 * - exhausted：SENT 數 >= maxSends
 * - no-template-suppressed：template 未審批 且 24h 內已有 SKIPPED(NO_TEMPLATE)（防 10 分鐘一條冚爆；
 *   審批後自動解除 — 見 docstring 冪等段）
 */
export async function shouldSkipCreation(
  rule: { id: string; maxSends: number },
  key: { conversationId: string | null; patientApricotId: string | null },
  templateApproved: boolean | null,
  now: Date
): Promise<CreationSkip> {
  const or: Prisma.FollowupTaskWhereInput[] = [];
  if (key.conversationId) or.push({ conversationId: key.conversationId });
  if (key.patientApricotId) or.push({ patientApricotId: key.patientApricotId });
  if (or.length === 0) return null;
  const existing = await prisma.followupTask.findMany({
    where: { ruleId: rule.id, status: { in: ["SCHEDULED", "DUE", "SENT"] }, OR: or },
    select: { status: true },
  });
  if (existing.some((t) => t.status === "SCHEDULED" || t.status === "DUE")) return "in-flight";
  const sentCount = existing.filter((t) => t.status === "SENT").length;
  if (sentCount >= rule.maxSends) return "exhausted";
  if (templateApproved === false) {
    const suppressed = await prisma.followupTask.findFirst({
      where: {
        ruleId: rule.id,
        status: "SKIPPED",
        cancelReason: "NO_TEMPLATE",
        createdAt: { gt: new Date(now.getTime() - DAY_MS) },
        OR: or,
      },
      select: { id: true },
    });
    if (suppressed) return "no-template-suppressed";
  }
  return null;
}

// ── 建 task（共用四類掃描）────────────────────────────────────────────────

interface TaskDraft {
  clinicId: string;
  conversationId: string | null;
  contactId: string | null;
  patientApricotId: string | null;
  phoneHashes: string[];
  ruleId: string;
  dueAt: Date;
  templateName: string;
  templateVars: Record<string, string | number | null> | null;
  contextJson: Record<string, unknown> | null;
  note?: string;
}

/**
 * 建 task 前總門：opt-out（永遠）+ 查重 + L2 到期即發。
 * 回「實際落咗 DB 嘅 task」或 null（跳過原因喺 skip 計數）。
 */
async function createTask(
  rule: {
    id: string;
    level: string;
    maxSends: number;
    trigger: string;
    templateName: string;
    minAmount: number | null;
  },
  draft: TaskDraft,
  template: { approved: boolean } | null,
  now: Date,
  counters: Record<string, number>
): Promise<{ id: string; status: string; dueAt: Date } | null> {
  // opt-out 永遠優先（MD §4.4 — 任何規則唔可 override）
  if (draft.contactId) {
    const contact = await prisma.contact.findUnique({ where: { id: draft.contactId }, select: { followupOptOut: true } });
    if (contact?.followupOptOut) {
      counters.optOut = (counters.optOut ?? 0) + 1;
      return null;
    }
  }
  const skip = await shouldSkipCreation(
    rule,
    { conversationId: draft.conversationId, patientApricotId: draft.patientApricotId },
    template ? template.approved : null,
    now
  );
  if (skip) {
    counters[skip] = (counters[skip] ?? 0) + 1;
    return null;
  }
  const due = draft.dueAt <= now;
  const status = due ? "DUE" : "SCHEDULED";
  const task = await prisma.followupTask.create({
    data: {
      clinicId: draft.clinicId,
      conversationId: draft.conversationId,
      patientApricotId: draft.patientApricotId,
      phoneHashes: draft.phoneHashes,
      ruleId: draft.ruleId,
      source: "RULE",
      dueAt: draft.dueAt,
      status,
      templateName: draft.templateName,
      templateVars: (draft.templateVars ?? undefined) as Prisma.InputJsonValue | undefined,
      contextJson: (draft.contextJson ?? undefined) as Prisma.InputJsonValue | undefined,
      note: draft.note ?? null,
    },
  });
  counters.created = (counters.created ?? 0) + 1;
  // L2 到期 → cron 直接發（同樣行取消檢查）；L1 → 留 DUE 等人撳
  if (due && rule.level === "L2") {
    const r = await sendFollowupTask(task.id, { via: "AI_AUTO", now });
    if (r.cancelReason) counters.cancelled = (counters.cancelled ?? 0) + 1;
    else if (r.status === "SENT") counters.sent = (counters.sent ?? 0) + 1;
    else if (r.status === "SKIPPED") counters.noTemplate = (counters.noTemplate ?? 0) + 1;
  }
  return { id: task.id, status, dueAt: task.dueAt };
}

// ── A：CONVERSATION_IDLE（本地，零 workforce call）────────────────────────

async function scanIdleConversations(
  rule: FollowupRuleRow,
  clinicIds: string[],
  now: Date,
  counters: Record<string, number>
): Promise<void> {
  const cutoff = new Date(now.getTime() - delayToMs(rule.delayValue, rule.delayUnit));
  // idle = 病人最後 inbound 同 我哋最後 outbound 都喺 cutoff 之前（對話真正冇聲）
  const convs = await prisma.conversation.findMany({
    where: {
      clinicId: { in: clinicIds },
      status: "OPEN",
      lastInboundAt: { lte: cutoff, not: null },
      OR: [{ lastOutboundAt: { lte: cutoff } }, { lastOutboundAt: null }],
    },
    select: {
      id: true,
      clinicId: true,
      contactId: true,
      lastInboundAt: true,
      lastOutboundAt: true,
      pinnedPatientApricotId: true,
    },
  });
  const contacts = await prisma.contact.findMany({
    where: { id: { in: convs.map((c) => c.contactId) } },
    select: { id: true, waId: true, profileName: true },
  });
  const contactMap = new Map(contacts.map((c) => [c.id, c]));
  for (const cv of convs) {
    const contact = contactMap.get(cv.contactId);
    if (!contact) continue;
    const ref = cv.lastOutboundAt && cv.lastOutboundAt > (cv.lastInboundAt as Date) ? cv.lastOutboundAt : cv.lastInboundAt;
    const dueAt = new Date((ref as Date).getTime() + delayToMs(rule.delayValue, rule.delayUnit));
    const template = await prisma.followupTemplate.findUnique({ where: { key: rule.templateName } });
    await createTask(
      rule,
      {
        clinicId: cv.clinicId,
        conversationId: cv.id,
        contactId: cv.contactId,
        patientApricotId: pinnedPatientOf(cv),
        phoneHashes: phoneHashes(contact.waId),
        ruleId: rule.id,
        dueAt,
        templateName: rule.templateName,
        templateVars: null,
        contextJson: { idleDays: Math.round((now.getTime() - (ref as Date).getTime()) / DAY_MS) },
      },
      template,
      now,
      counters
    );
  }
}

// ── B：appointments feed（clinic 模式 + phoneHashes 配對）──────────────────

async function loadClinicPairing(clinicId: string): Promise<{
  byHash: Map<string, { contactId: string; conversationId: string | null; waId: string }>;
}> {
  const [contacts, convs] = await Promise.all([
    prisma.contact.findMany({ where: { clinicId }, select: { id: true, waId: true } }),
    prisma.conversation.findMany({ where: { clinicId }, select: { id: true, contactId: true } }),
  ]);
  const convByContact = new Map(convs.map((c) => [c.contactId, c.id]));
  const byHash = new Map<string, { contactId: string; conversationId: string | null; waId: string }>();
  for (const c of contacts) {
    for (const h of contactHashSet(c.waId)) byHash.set(h, { contactId: c.id, conversationId: convByContact.get(c.id) ?? null, waId: c.waId });
  }
  return { byHash };
}

function pairAppt(
  appt: ClinicAppointment,
  byHash: Map<string, { contactId: string; conversationId: string | null; waId: string }>
): { contactId: string; conversationId: string | null } | null {
  return (appt.phoneHashes ?? []).map((h) => byHash.get(h)).find(Boolean) ?? null;
}

interface FollowupRuleRow {
  id: string;
  clinicId: string | null;
  name: string;
  trigger: string;
  delayValue: number;
  delayUnit: string;
  reasonCodes: string[]; // C/D 類：visitReason code 集（P4）
  minAmount: number | null;
  templateName: string;
  level: string;
  maxSends: number;
  cancelOnReply: boolean;
  cancelOnBooking: boolean;
  cancelOnArrival: boolean;
  cancelOnResolved: boolean;
  cancelOnPaid: boolean;
}

async function fetchClinicAppts(
  clinic: { code: string },
  from: string,
  to: string,
  counters: Record<string, number>
): Promise<ClinicAppointment[] | null> {
  try {
    const res = await fetchAppointmentsByClinic(clinic.code, from, to);
    return res.appointments;
  } catch (e) {
    // workforce 離線/店唔存在 = 該店當輪跳過（fail-soft — 其他店照跑；下輪 */10 重試）
    if (e instanceof WorkforceApiError && (e.status === 404 || e.status === 503 || e.status === 0)) {
      counters.workforceFail = (counters.workforceFail ?? 0) + 1;
      log.warn({ clinic: clinic.code, status: e.status }, "followup: workforce appointments fail-soft（該店跳過）");
      return null;
    }
    throw e;
  }
}

async function scanBeforeAppointment(
  rule: FollowupRuleRow,
  clinics: { id: string; code: string }[],
  now: Date,
  counters: Record<string, number>
): Promise<void> {
  const delayDays = Math.ceil(delayToMs(rule.delayValue, rule.delayUnit) / DAY_MS);
  const from = hkTodayStr(now);
  const to = hkDateOffset(delayDays + 1, now);
  for (const clinic of clinics) {
    const appts = await fetchClinicAppts(clinic, from, to, counters);
    if (appts === null) continue;
    const { byHash } = await loadClinicPairing(clinic.id);
    for (const a of appts) {
      // MD §0.2：0/102 = 有效預約（待覆診）；改期（102）照提醒
      if (a.bookingStatus !== 0 && a.bookingStatus !== 102) continue;
      const apptTime = new Date(hkApptTimeMs(a.date, a.start));
      if (apptTime <= now) continue; // 已過嘅預約唔提醒
      const dueAt = new Date(apptTime.getTime() - delayToMs(rule.delayValue, rule.delayUnit));
      const pair = pairAppt(a, byHash);
      if (!pair || !pair.conversationId) {
        counters.noConversation = (counters.noConversation ?? 0) + 1;
        continue;
      }
      const template = await prisma.followupTemplate.findUnique({ where: { key: rule.templateName } });
      await createTask(
        rule,
        {
          clinicId: clinic.id,
          conversationId: pair.conversationId,
          contactId: pair.contactId,
          patientApricotId: a.patientApricotId,
          phoneHashes: a.phoneHashes ?? [],
          ruleId: rule.id,
          dueAt,
          templateName: rule.templateName,
          templateVars: { apptDate: a.date, apptTime: a.start, providerName: a.providerName },
          // 顯示用結構化數據（零臨床全文）— apptId 供 ARRIVED 取消檢查對照
          contextJson: { apptId: a.apricotApptId, apptDate: a.date, apptTime: a.start, clinicCode: a.clinicCode },
        },
        template,
        now,
        counters
      );
    }
  }
}

async function scanAfterNoShow(
  rule: FollowupRuleRow,
  clinics: { id: string; code: string }[],
  now: Date,
  counters: Record<string, number>
): Promise<void> {
  const delayDays = Math.ceil(delayToMs(rule.delayValue, rule.delayUnit) / DAY_MS);
  const from = hkDateOffset(-(delayDays + 1), now);
  const to = hkTodayStr(now);
  const cutoff = now.getTime() - delayToMs(rule.delayValue, rule.delayUnit);
  for (const clinic of clinics) {
    const appts = await fetchClinicAppts(clinic, from, to, counters);
    if (appts === null) continue;
    const { byHash } = await loadClinicPairing(clinic.id);
    for (const a of appts) {
      // MD §0.2：爽約 = **明確 -3**（唔照抄 treatment-summary 的 >= 0）；其他負數 = 取消 → 跳
      if (a.bookingStatus !== -3) continue;
      const apptTime = new Date(hkApptTimeMs(a.date, a.start));
      if (apptTime.getTime() > cutoff) continue; // 爽約未夠 delay 時長 → 未到期
      const dueAt = new Date(apptTime.getTime() + delayToMs(rule.delayValue, rule.delayUnit));
      const pair = pairAppt(a, byHash);
      if (!pair || !pair.conversationId) {
        counters.noConversation = (counters.noConversation ?? 0) + 1;
        continue;
      }
      const template = await prisma.followupTemplate.findUnique({ where: { key: rule.templateName } });
      await createTask(
        rule,
        {
          clinicId: clinic.id,
          conversationId: pair.conversationId,
          contactId: pair.contactId,
          patientApricotId: a.patientApricotId,
          phoneHashes: a.phoneHashes ?? [],
          ruleId: rule.id,
          dueAt,
          templateName: rule.templateName,
          templateVars: { apptDate: a.date, apptTime: a.start, providerName: a.providerName },
          contextJson: { apptId: a.apricotApptId, apptDate: a.date, apptTime: a.start, clinicCode: a.clinicCode, noShow: true },
        },
        template,
        now,
        counters
      );
    }
  }
}

// ── F：OUTSTANDING_BALANCE（近 14 日 appointments 配對 + balance）───────────

async function scanOutstandingBalance(
  rule: FollowupRuleRow,
  clinics: { id: string; code: string }[],
  now: Date,
  counters: Record<string, number>
): Promise<void> {
  const minAmount = rule.minAmount ?? 0;
  for (const clinic of clinics) {
    // 配對源 = 近 14 日 appointments（phoneHashes hasSome）+ 已釘住嘅對話（pinned）
    const appts = await fetchClinicAppts(clinic, hkDateOffset(-14, now), hkTodayStr(now), counters);
    if (appts === null) continue;
    const { byHash } = await loadClinicPairing(clinic.id);
    const convs = await prisma.conversation.findMany({
      where: { clinicId: clinic.id, pinnedPatientApricotId: { not: null } },
      select: { id: true, contactId: true, pinnedPatientApricotId: true },
    });
    // cpId → 配對結果（多對話同 cpId 各建 task — 一店一通話一病人）
    const pairs = new Map<string, { conversationId: string; contactId: string; patientApricotId: string }[]>();
    const addPair = (cpId: string, conversationId: string, contactId: string) => {
      const arr = pairs.get(cpId) ?? [];
      if (!arr.some((p) => p.conversationId === conversationId)) arr.push({ conversationId, contactId, patientApricotId: cpId });
      pairs.set(cpId, arr);
    };
    if (appts) {
      for (const a of appts) {
        const pair = pairAppt(a, byHash);
        if (pair?.conversationId) addPair(a.patientApricotId, pair.conversationId, pair.contactId);
      }
    }
    for (const cv of convs) {
      if (cv.pinnedPatientApricotId) addPair(cv.pinnedPatientApricotId, cv.id, cv.contactId);
    }
    for (const [cpId, pairList] of pairs) {
      let osAmt: number | null;
      try {
        const bal = await fetchPatientBalance(cpId);
        osAmt = bal.balance.osAmt;
      } catch (e) {
        // 404 PATIENT_NOT_FOUND = 無索引行（walk-in 未同步）→ 跳（fail-soft）
        if (e instanceof WorkforceApiError && (e.status === 404 || e.status === 503 || e.status === 0)) {
          counters.balanceMiss = (counters.balanceMiss ?? 0) + 1;
          continue;
        }
        throw e;
      }
      if (osAmt === null || osAmt < minAmount) {
        counters.belowThreshold = (counters.belowThreshold ?? 0) + 1;
        continue;
      }
      const template = await prisma.followupTemplate.findUnique({ where: { key: rule.templateName } });
      for (const p of pairList) {
        await createTask(
          rule,
          {
            clinicId: clinic.id,
            conversationId: p.conversationId,
            contactId: p.contactId,
            patientApricotId: p.patientApricotId,
            phoneHashes: [],
            ruleId: rule.id,
            dueAt: now, // F 類：到期即發（delay 只係規則欄佔位）
            templateName: rule.templateName,
            templateVars: { osAmt },
            contextJson: { osAmt, minAmount },
          },
          template,
          now,
          counters
        );
      }
    }
  }
}

// ── S2 入口：runFollowupScan（cron followup-scan 每 10 分鐘）────────────────

export interface FollowupScanResult {
  ok: boolean;
  rules: number;
  created: number;
  sent: number;
  cancelled: number;
  noTemplate: number;
  inFlight: number;
  exhausted: number;
  optOut: number;
  noConversation: number;
  workforceFail: number;
  booked: number; // P4：E 類「報價後已有 booking」跳過數
}

// ── C：AFTER_TREATMENT（術後關懷 — P4；batch #1 visits + rxCodes 抗生素判定）──
// 觸發：visitReasonCodes ∩ rule.reasonCodes 唔空 **且** 該 visit rxCodes 有抗生素
//   （AND 語義 — 老細 2026-09-16 拍板；progress 設計 #10）。洗牙（0008）唔喺 rule.reasonCodes → 唔會出。
// 口徑：bookingStatus >= 0（實際到診/已排；-3 爽約 / -7 釋放唔計）；
//   同病人多筆合格 visit → 取最近一筆（dueAt 由佢起）。
async function scanAfterTreatment(
  rule: FollowupRuleRow,
  clinics: { id: string; code: string }[],
  now: Date,
  counters: Record<string, number>
): Promise<void> {
  const delayMs = delayToMs(rule.delayValue, rule.delayUnit);
  const windowDays = Math.ceil(delayMs / DAY_MS) + 14; // 緩衝：note 遲到索引
  const from = hkDateOffset(-windowDays, now);
  const to = hkTodayStr(now);
  for (const clinic of clinics) {
    let visits: BatchVisit[];
    try {
      visits = (await fetchClinicVisits(clinic.code, from, to, { reasonCodes: rule.reasonCodes })).visits;
    } catch (e) {
      if (e instanceof WorkforceApiError && (e.status === 404 || e.status === 503 || e.status === 0)) {
        counters.workforceFail = (counters.workforceFail ?? 0) + 1;
        continue;
      }
      throw e;
    }
    const { byHash } = await loadClinicPairing(clinic.id);
    // 同病人取最近合格 visit
    const best = new Map<string, BatchVisit>();
    for (const v of visits) {
      if (v.bookingStatus < 0) continue; // 爽約/釋放唔計
      if (!v.visitReasonCodes.some((c) => rule.reasonCodes.includes(c))) continue; // visitReason ∩ rule（defensive — server 已過濾，mock 唔會）
      if (!v.rxCodes.some((rx) => rx.isAntibiotic)) continue; // 無抗生素 → 唔觸發（AND）
      const prev = best.get(v.patientApricotId);
      if (!prev || v.visitDate > prev.visitDate) best.set(v.patientApricotId, v);
    }
    for (const v of best.values()) {
      if (new Date(`${v.visitDate}T23:59:59+08:00`).getTime() > now.getTime()) continue; // 未完結嘅日
      const dueAt = new Date(new Date(`${v.visitDate}T00:00:00+08:00`).getTime() + delayMs);
      if (dueAt.getTime() > now.getTime()) continue; // 未到期
      const pair = (v.phoneHashes ?? []).map((h) => byHash.get(h)).find(Boolean);
      if (!pair || !pair.conversationId) {
        counters.noConversation = (counters.noConversation ?? 0) + 1;
        continue;
      }
      const template = await prisma.followupTemplate.findUnique({ where: { key: rule.templateName } });
      await createTask(
        rule,
        {
          clinicId: clinic.id,
          conversationId: pair.conversationId,
          contactId: pair.contactId,
          patientApricotId: v.patientApricotId,
          phoneHashes: v.phoneHashes ?? [],
          ruleId: rule.id,
          dueAt,
          templateName: rule.templateName,
          templateVars: { visitDate: v.visitDate },
          contextJson: { visitId: v.visitId, visitDate: v.visitDate, matchedReasons: v.visitReasonCodes.filter((c) => rule.reasonCodes.includes(c)), hasAntibiotic: true, clinicCode: clinic.code },
        },
        template,
        now,
        counters
      );
    }
  }
}

// ── D：RECALL_NO_REPEAT（定期召回 — P4；冪等 = 期間再做過同類唔會出）──────
// 觸發：rule.reasonCodes 指定治療類型；window 內該病人**最近**一筆同類到診
//   max(visitDate)；now - maxVisitDate >= interval（delayValue/delayUnit）→ due。
//   window = min(365, 1.5×interval + 30d) — 365 係 CWM #1 上限；interval ≤ 12 月全覆蓋。
// decide（progress #11）：window 內冇同類 visit = 唔敢斷言「從前有做」→ 唔觸發（寧缺勿濫）。
async function scanRecallNoRepeat(
  rule: FollowupRuleRow,
  clinics: { id: string; code: string }[],
  now: Date,
  counters: Record<string, number>
): Promise<void> {
  const intervalMs = delayToMs(rule.delayValue, rule.delayUnit);
  const windowDays = Math.min(365, Math.ceil((intervalMs * 1.5) / DAY_MS) + 30);
  const from = hkDateOffset(-windowDays, now);
  const to = hkTodayStr(now);
  for (const clinic of clinics) {
    let visits: BatchVisit[];
    try {
      visits = (await fetchClinicVisits(clinic.code, from, to, { reasonCodes: rule.reasonCodes })).visits;
    } catch (e) {
      if (e instanceof WorkforceApiError && (e.status === 404 || e.status === 503 || e.status === 0)) {
        counters.workforceFail = (counters.workforceFail ?? 0) + 1;
        continue;
      }
      throw e;
    }
    const { byHash } = await loadClinicPairing(clinic.id);
    const latest = new Map<string, BatchVisit>();
    for (const v of visits) {
      if (v.bookingStatus < 0) continue;
      if (!v.visitReasonCodes.some((c) => rule.reasonCodes.includes(c))) continue; // visitReason ∩ rule（defensive）
      const prev = latest.get(v.patientApricotId);
      if (!prev || v.visitDate > prev.visitDate) latest.set(v.patientApricotId, v);
    }
    for (const v of latest.values()) {
      const lastMs = new Date(`${v.visitDate}T00:00:00+08:00`).getTime();
      if (now.getTime() - lastMs < intervalMs) continue; // 期間再做過 / 未夠 interval → 唔出（冪等）
      const dueAt = new Date(lastMs + intervalMs);
      if (dueAt.getTime() > now.getTime()) continue;
      const pair = (v.phoneHashes ?? []).map((h) => byHash.get(h)).find(Boolean);
      if (!pair || !pair.conversationId) {
        counters.noConversation = (counters.noConversation ?? 0) + 1;
        continue;
      }
      const template = await prisma.followupTemplate.findUnique({ where: { key: rule.templateName } });
      await createTask(
        rule,
        {
          clinicId: clinic.id,
          conversationId: pair.conversationId,
          contactId: pair.contactId,
          patientApricotId: v.patientApricotId,
          phoneHashes: v.phoneHashes ?? [],
          ruleId: rule.id,
          dueAt,
          templateName: rule.templateName,
          templateVars: { lastVisitDate: v.visitDate, intervalMonths: rule.delayValue },
          contextJson: { lastVisitDate: v.visitDate, visitId: v.visitId, matchedReasons: v.visitReasonCodes.filter((c) => rule.reasonCodes.includes(c)), intervalUnit: rule.delayUnit, clinicCode: clinic.code },
        },
        template,
        now,
        counters
      );
    }
  }
}

// ── E：QUOTED_NOT_BOOKED（報價未成交 — P4；CWM 報價 + W 本地 Bookings 為準）──
// 觸發：quote（confirmed/corrected 或 pending 高信心，非 discarded）
//   + sourceVisitDate + delay <= now + 報價之後冇「對應 booking」。
// decide（progress #12）：對應 booking = 該病人對話之後任何 booking（唔 match 療程類型 —
//   保守口徑：有 booking = 病人返咗門診 = 唔算「未成交」）。
//   主查 = W 本地 BookingRequest（PENDING/CONFIRMED，requestedDate >= 報價日）；
//   輔助 = CWM appointments feed（bookingStatus >= 0，date >= 報價日）— 本地無行先查。
async function scanQuotedNotBooked(
  rule: FollowupRuleRow,
  clinics: { id: string; code: string }[],
  now: Date,
  counters: Record<string, number>
): Promise<void> {
  const delayMs = delayToMs(rule.delayValue, rule.delayUnit);
  let quotes: WorkforceQuote[];
  try {
    quotes = (await fetchQuotes({ status: "confirmed,corrected,pending", limit: 500 })).quotes;
  } catch (e) {
    if (e instanceof WorkforceApiError && (e.status === 404 || e.status === 503 || e.status === 0)) {
      counters.workforceFail = (counters.workforceFail ?? 0) + 1;
      return;
    }
    throw e;
  }
  // patient → 對話（pinned 配對 — 本地）
  const clinicIds = clinics.map((c) => c.id);
  const convs = await prisma.conversation.findMany({
    where: { clinicId: { in: clinicIds } },
    select: { id: true, clinicId: true, contactId: true, pinnedPatientApricotId: true },
  });
  const convByPatient = new Map<string, { id: string; clinicId: string; contactId: string }>();
  for (const c of convs) {
    if (c.pinnedPatientApricotId) convByPatient.set(`${c.clinicId}|${c.pinnedPatientApricotId}`, c);
  }
  // 報價後 booking 主查（本地 Bookings — 一次 query 晒）
  const dueQuotes: WorkforceQuote[] = quotes.filter((q) => {
    if (q.status === "discarded") return false;
    if (q.status === "pending" && q.certainty !== "high") return false;
    return new Date(`${q.sourceVisitDate}T00:00:00+08:00`).getTime() + delayMs <= now.getTime();
  });
  if (!dueQuotes.length) return;
  const patientIds = [...new Set(dueQuotes.map((q) => q.patientApricotId))];
  const convIds = convs.map((c) => c.id);
  const bookRows = await prisma.bookingRequest.findMany({
    where: { conversationId: { in: convIds }, status: { in: ["PENDING", "CONFIRMED"] } },
    select: { conversationId: true, requestedDate: true },
  });
  const bookedByConv = new Map<string, string[]>(); // convId → requestedDate[]
  for (const b of bookRows) {
    const arr = bookedByConv.get(b.conversationId) ?? [];
    arr.push(b.requestedDate);
    bookedByConv.set(b.conversationId, arr);
  }
  const apptClinicCache = new Map<string, ClinicAppointment[] | null>();
  for (const clinic of clinics) {
    const clinicQuotes = dueQuotes.filter((q) => q.clinicCode === clinic.code);
    if (!clinicQuotes.length) continue;
    const { byHash } = await loadClinicPairing(clinic.id);
    // 同一病人只建一條（取最新報價）
    const best = new Map<string, WorkforceQuote>();
    for (const q of clinicQuotes) {
      const prev = best.get(q.patientApricotId);
      if (!prev || q.sourceVisitDate > prev.sourceVisitDate) best.set(q.patientApricotId, q);
    }
    for (const q of best.values()) {
      const conv = convByPatient.get(`${clinic.id}|${q.patientApricotId}`);
      if (!conv) {
        counters.noConversation = (counters.noConversation ?? 0) + 1;
        continue;
      }
      // 主查：本地 booking（對話級）
      const localDates = bookedByConv.get(conv.id) ?? [];
      let booked = localDates.some((d) => d >= q.sourceVisitDate);
      if (!booked && localDates.length === 0) {
        // 輔助：CWM appointments（本地無行 = 可能另一渠道落單）
        const from = q.sourceVisitDate;
        const to = hkDateOffset(1, now);
        let appts = apptClinicCache.get(clinic.code);
        if (appts === undefined) {
          try {
            const res = await fetchAppointmentsByClinic(clinic.code, from, to);
            appts = res.appointments;
          } catch (e) {
            if (e instanceof WorkforceApiError && (e.status === 404 || e.status === 503 || e.status === 0)) {
              appts = null;
            } else {
              throw e;
            }
          }
          apptClinicCache.set(clinic.code, appts);
        }
        if (appts) {
          booked = appts.some(
            (a) => a.patientApricotId === q.patientApricotId && a.bookingStatus >= 0 && a.date >= q.sourceVisitDate
          );
        }
      }
      if (booked) {
        counters.booked = (counters.booked ?? 0) + 1;
        continue;
      }
      const dueAt = new Date(new Date(`${q.sourceVisitDate}T00:00:00+08:00`).getTime() + delayMs);
      const amount = q.amountMin == null ? null : q.amountMax && q.amountMax !== q.amountMin ? `${q.amountMin}-${q.amountMax}` : `${q.amountMin}${q.perUnit ? "@" : ""}`;
      await createTask(
        rule,
        {
          clinicId: clinic.id,
          conversationId: conv.id,
          contactId: conv.contactId,
          patientApricotId: q.patientApricotId,
          phoneHashes: [], // 報價 lane 無 phoneHashes（患者經 pinned 配對）
          ruleId: rule.id,
          dueAt,
          templateName: rule.templateName,
          templateVars: { quoteDate: q.sourceVisitDate, item: q.nameCn ?? q.text, amount: amount ?? "" },
          contextJson: { quoteId: q.id, quoteDate: q.sourceVisitDate, item: q.text, nameCn: q.nameCn, amountMin: q.amountMin, amountMax: q.amountMax, perUnit: q.perUnit, intent: q.intent, quoteStatus: q.status, certainty: q.certainty, clinicCode: clinic.code },
        },
        await prisma.followupTemplate.findUnique({ where: { key: rule.templateName } }),
        now,
        counters
      );
    }
  }
}

export async function runFollowupScan(now: Date = new Date()): Promise<FollowupScanResult> {
  const rules = (await prisma.followupRule.findMany({ where: { enabled: true } })) as unknown as FollowupRuleRow[];
  const clinics = await prisma.clinic.findMany({ select: { id: true, code: true } });
  const counters: Record<string, number> = {
    created: 0,
    sent: 0,
    cancelled: 0,
    noTemplate: 0,
    inFlight: 0,
    exhausted: 0,
    "no-template-suppressed": 0,
    optOut: 0,
    noConversation: 0,
    workforceFail: 0,
    balanceMiss: 0,
    belowThreshold: 0,
    booked: 0,
  };
  // 計數映射：shouldSkipCreation 回傳 key → 對外 summary
  const origCreate = createTask;
  void origCreate;
  for (const rule of rules) {
    const scope = rule.clinicId ? clinics.filter((c) => c.id === rule.clinicId) : clinics;
    try {
      switch (rule.trigger) {
        case "CONVERSATION_IDLE":
          await scanIdleConversations(rule, scope.map((c) => c.id), now, counters);
          break;
        case "BEFORE_APPOINTMENT":
          await scanBeforeAppointment(rule, scope, now, counters);
          break;
        case "AFTER_NO_SHOW":
          await scanAfterNoShow(rule, scope, now, counters);
          break;
        case "OUTSTANDING_BALANCE":
          await scanOutstandingBalance(rule, scope, now, counters);
          break;
        case "AFTER_TREATMENT": // C（P4）
          await scanAfterTreatment(rule, scope, now, counters);
          break;
        case "RECALL_NO_REPEAT": // D（P4）
          await scanRecallNoRepeat(rule, scope, now, counters);
          break;
        case "QUOTED_NOT_BOOKED": // E（P4）
          await scanQuotedNotBooked(rule, scope, now, counters);
          break;
        default:
          log.warn({ rule: rule.id, trigger: rule.trigger }, "followup: 未知 trigger — 跳過");
          break;
      }
    } catch (err) {
      // 單條規則失敗唔阻其他規則（fail-soft；log 只 ruleId — 零病人資料）
      log.error({ rule: rule.id, trigger: rule.trigger, err: err instanceof Error ? err.message : String(err) }, "followup: rule scan failed");
      counters.ruleFail = (counters.ruleFail ?? 0) + 1;
    }
  }
  const result: FollowupScanResult = {
    ok: true,
    rules: rules.length,
    created: counters.created ?? 0,
    sent: counters.sent ?? 0,
    cancelled: counters.cancelled ?? 0,
    noTemplate: (counters.noTemplate ?? 0) + (counters["no-template-suppressed"] ?? 0),
    inFlight: counters.inFlight ?? 0,
    exhausted: counters.exhausted ?? 0,
    optOut: counters.optOut ?? 0,
    noConversation: counters.noConversation ?? 0,
    workforceFail: counters.workforceFail ?? 0,
    booked: counters.booked ?? 0,
  };
  log.info({ ...result }, "followup: scan done");
  return result;
}

// ── S3：取消條件六項（每次發送前重跑 — MD §4.4）────────────────────────────

export type CancelReason = "OPT_OUT" | "REPLIED" | "BOOKED" | "ARRIVED" | "RESOLVED" | "PAID" | "NO_CONVERSATION";

/**
 * 發送前重跑取消檢查。回 null = 可發。
 * OPT_OUT 永遠檢查（規則唔可關）；其餘跟規則 cancelOn* 旗。
 * workforce call fail-soft：攞唔到appointments/balance 唔會誤取消（寧可照發 —
 * 病人收到多條提醒好過漏提醒；force fail-soft 唔會誤 kill task）。
 */
export async function checkCancellations(
  task: {
    id: string;
    clinicId: string;
    conversationId: string | null;
    patientApricotId: string | null;
    ruleId: string | null;
    createdAt: Date;
    contextJson: Prisma.JsonValue | null;
  },
  rule: FollowupRuleRow | null,
  clinic: { code: string } | null,
  now: Date
): Promise<CancelReason | null> {
  const onReply = rule?.cancelOnReply ?? true;
  const onBooking = rule?.cancelOnBooking ?? true;
  const onArrival = rule?.cancelOnArrival ?? true;
  const onResolved = rule?.cancelOnResolved ?? true;
  const onPaid = rule?.cancelOnPaid ?? true;
  const trigger = rule?.trigger;

  if (!task.conversationId) return "NO_CONVERSATION";
  const conv = await prisma.conversation.findUnique({
    where: { id: task.conversationId },
    select: { id: true, status: true, lastInboundAt: true, contactId: true, clinicId: true },
  });
  if (!conv) return "NO_CONVERSATION";
  const contact = await prisma.contact.findUnique({
    where: { id: conv.contactId },
    select: { followupOptOut: true },
  });
  // ① OPT_OUT — 永遠檢查，唔可關
  if (contact?.followupOptOut) return "OPT_OUT";
  // ⑤ RESOLVED — 對話已解決
  if (onResolved && conv.status === "RESOLVED") return "RESOLVED";
  // ② REPLIED — task 建立後有新 inbound
  if (onReply && conv.lastInboundAt && conv.lastInboundAt > task.createdAt) return "REPLIED";

  // ③ BOOKED（期間有新 booking）+ ④ ARRIVED（該預約已到診）— 同一份 appointments feed
  if (clinic && task.patientApricotId && (onBooking || (onArrival && trigger === "BEFORE_APPOINTMENT"))) {
    try {
      const from = hkDateOffset(-1, new Date(task.createdAt));
      const to = hkDateOffset(14, now);
      const res = await fetchAppointmentsByClinic(clinic.code, from, to);
      const mine = res.appointments.filter((a) => a.patientApricotId === task.patientApricotId);
      // ④ ARRIVED：task 對住嗰筆預約 status ∈ {1,4}
      if (onArrival && trigger === "BEFORE_APPOINTMENT") {
        const ctx = (task.contextJson ?? {}) as { apptId?: string };
        if (ctx.apptId) {
          const target = mine.find((a) => a.apricotApptId === ctx.apptId);
          if (target && (target.bookingStatus === 1 || target.bookingStatus === 4)) return "ARRIVED";
        }
      }
      // ③ BOOKED：task 之後新出現嘅有效預約（0/1/4/102）— 排除 task 自己跟嗰筆（contextJson.apptId）：
      //   BEFORE_APPOINTMENT task 由嗰筆預約而建，佢自己 status 0 係預期（未到期），唔係「新 booking」
      if (onBooking) {
        const ctxApptId = ((task.contextJson ?? {}) as { apptId?: string }).apptId;
        const fresh = mine.find(
          (a) =>
            a.bookingStatus >= 0 &&
            (!ctxApptId || a.apricotApptId !== ctxApptId) &&
            new Date(hkApptTimeMs(a.date, a.start)) > task.createdAt
        );
        if (fresh) return "BOOKED";
      }
    } catch (e) {
      if (!(e instanceof WorkforceApiError && (e.status === 404 || e.status === 503 || e.status === 0))) throw e;
      log.warn({ clinic: clinic.code }, "followup: cancel-check appointments fail-soft（照發）");
    }
  }
  // ⑥ PAID — F 類：欠款已歸零
  if (onPaid && trigger === "OUTSTANDING_BALANCE" && task.patientApricotId) {
    try {
      const bal = await fetchPatientBalance(task.patientApricotId);
      if (bal.balance.osAmt === null || bal.balance.osAmt <= 0) return "PAID";
    } catch (e) {
      if (!(e instanceof WorkforceApiError && (e.status === 404 || e.status === 503 || e.status === 0))) throw e;
      log.warn({ patient: task.patientApricotId }, "followup: cancel-check balance fail-soft（照發）");
    }
  }
  return null;
}

// ── S4：發送（L1 人撳 / L2 cron 共用；行 W 現有 outbound 機制）───────────────

export interface SendResult {
  status: "SENT" | "SKIPPED" | "CANCELLED" | "NOT_DUE";
  cancelReason: CancelReason | "NO_TEMPLATE" | null;
  messageId: string | null;
  /** 過窗走 template 發送（META template）— e2e 斷言用 */
  viaTemplate: boolean;
}

/**
 * 發一個 follow-up task（L1 隊列人撳 / L2 cron 直發共用入口）。
 * 流程：狀態守門 → 取消檢查（重跑）→ 窗口判斷（開 = text / 過 = 必 approved template）
 *   → Message QUEUED + task SENT 同 tx → enqueue outbound + notify + audit。
 * 鐵律：唔 claim（assigneeId 零改動）；billingCategory = UTILITY；audit 零 PII。
 */
export async function sendFollowupTask(
  taskId: string,
  opts: { via: "AI_AUTO" | "AI_ADOPTED"; staffId?: string | null; now?: Date }
): Promise<SendResult> {
  const now = opts.now ?? new Date();
  const task = await prisma.followupTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error(`followup: task ${taskId} not found`);
  if (task.status !== "DUE" && task.status !== "SCHEDULED") {
    return { status: task.status as SendResult["status"], cancelReason: task.cancelReason as SendResult["cancelReason"], messageId: task.sentMessageId, viaTemplate: false };
  }
  const rule = task.ruleId
    ? ((await prisma.followupRule.findUnique({ where: { id: task.ruleId } })) as unknown as FollowupRuleRow | null)
    : null;
  const clinic = await prisma.clinic.findUnique({ where: { id: task.clinicId }, select: { id: true, code: true, name: true } });

  // ① 取消檢查（每次發送前重跑 — MD §4.4）
  const cancelReason = await checkCancellations(task, rule, clinic, now);
  if (cancelReason) {
    await prisma.followupTask.update({
      where: { id: taskId },
      data: { status: "CANCELLED", cancelReason, handledAt: now },
    });
    log.info({ taskId, cancelReason }, "followup: send cancelled（發送前檢查命中）");
    return { status: "CANCELLED", cancelReason, messageId: null, viaTemplate: false };
  }

  const conv = task.conversationId
    ? await prisma.conversation.findUnique({ where: { id: task.conversationId }, select: { contactId: true, lastInboundAt: true } })
    : null;
  const convId = task.conversationId;
  if (!conv || !convId) {
    await prisma.followupTask.update({ where: { id: taskId }, data: { status: "CANCELLED", cancelReason: "NO_CONVERSATION", handledAt: now } });
    return { status: "CANCELLED", cancelReason: "NO_CONVERSATION", messageId: null, viaTemplate: false };
  }
  const contact = await prisma.contact.findUnique({ where: { id: conv.contactId }, select: { salutation: true, profileName: true } });
  const template = task.templateName
    ? await prisma.followupTemplate.findUnique({ where: { key: task.templateName } })
    : null;
  if (!template) {
    // template 行缺失 = 配置錯 → SKIPPED（同 NO_TEMPLATE 口徑）
    await prisma.followupTask.update({ where: { id: taskId }, data: { status: "SKIPPED", cancelReason: "NO_TEMPLATE", handledAt: now } });
    return { status: "SKIPPED", cancelReason: "NO_TEMPLATE", messageId: null, viaTemplate: false };
  }

  // ② 窗口判斷（MD §4.5）：窗口內 = free-form text；窗口過咗 = 只可 approved template
  const win = getWindowState(conv.lastInboundAt, now);
  // 變數來源：contextJson（顯示用結構化數據 — 建 task 時已零 PII）< templateVars（scan 精確變數）< 常規欄
  const vars: Record<string, string | number | null> = {
    ...((task.contextJson as Record<string, string | number | null> | null | undefined) ?? {}),
    ...((task.templateVars as Record<string, string | number | null> | null | undefined) ?? {}),
    salutation: contact?.salutation ?? "您",
    clinicName: clinic?.name ?? "",
  };
  const body = renderFollowupText(template.text, vars);
  let viaTemplate = false;
  let msgType: "text" | "template" = "text";
  let templateMeta: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined;
  if (!win.open) {
    if (!template.approved) {
      // 🔴 安全設計：template 未審批 → 唔會真發（老細 07:31 拍板 — seed 全部 approved=false）
      await prisma.followupTask.update({ where: { id: taskId }, data: { status: "SKIPPED", cancelReason: "NO_TEMPLATE", handledAt: now } });
      log.warn({ taskId, template: template.key }, "followup: 窗口過咗但 template 未審批 → SKIPPED(NO_TEMPLATE)");
      return { status: "SKIPPED", cancelReason: "NO_TEMPLATE", messageId: null, viaTemplate: false };
    }
    viaTemplate = true;
    msgType = "template";
    templateMeta = {
      name: template.waTemplateName ?? template.key,
      language: template.language,
      category: "UTILITY",
      // 過窗 template 發送：body 預覽 = 渲染後文字（同 Phase B reminder 口徑）
      components: [{ type: "body", parameters: [body] }],
    };
  }

  // ③ Message QUEUED + task SENT 同一 transaction（冪等：先搶佔 task 狀態先建 message）
  const claimed = await prisma.followupTask.updateMany({
    where: { id: taskId, status: { in: ["DUE", "SCHEDULED"] } },
    data: { status: "SENT", handledAt: now, handledBy: opts.staffId ?? null },
  });
  if (claimed.count !== 1) {
    // 併發（cron + 人撳同時）— 後到者退
    const fresh = await prisma.followupTask.findUnique({ where: { id: taskId }, select: { status: true, sentMessageId: true } });
    return { status: (fresh?.status ?? "SENT") as SendResult["status"], cancelReason: null, messageId: fresh?.sentMessageId ?? null, viaTemplate: false };
  }
  const msg = await prisma.message.create({
    data: {
      conversationId: convId,
      direction: "OUT",
      channel: "API",
      type: msgType,
      body,
      templateMeta,
      status: "QUEUED",
      sentByStaffId: opts.staffId ?? null,
      aiAutoSent: opts.via === "AI_AUTO",
      // ★ 鐵律：AI_AUTO（L2）/ AI_ADOPTED（L1 人撳）— cooldown 只計 HUMAN_TYPED → 唔觸發
      sentVia: opts.via,
      // ★ 鐵律：billingCategory = UTILITY
      billingCategory: "UTILITY",
      waTimestamp: now,
    },
  });
  await prisma.followupTask.update({ where: { id: taskId }, data: { sentMessageId: msg.id } });

  // ④ outbound（W 現有機制：QUEUED → outbound worker → Graph）+ notify + audit
  try {
    await lazyEnqueue(msg.id);
  } catch (err) {
    // 寧漏勿重（同 reminder.ts）：task 已 SENT，enqueue 失敗 → message FAILED 員工人手補
    await prisma.message
      .update({ where: { id: msg.id }, data: { status: "FAILED", errorCode: "ENQUEUE_FAILED" } })
      .catch(() => undefined);
    log.error({ taskId, err: err instanceof Error ? err.message : String(err) }, "followup: enqueue failed（task 已 SENT — 員工人手補）");
  }
  await prisma.$executeRaw`
    UPDATE "Conversation" SET "lastMessageAt" = GREATEST("lastMessageAt", ${now}) WHERE "id" = ${convId}`;
  await lazyNotify(task.clinicId, "message:new", { conversationId: task.conversationId, clinicId: task.clinicId });
  // ★ audit FOLLOWUP_SENT 零 PII（只 id/metadata — 病人姓名/電話/內容全部唔入）
  await prisma.auditLog.create({
    data: {
      staffId: opts.staffId ?? null,
      action: "FOLLOWUP_SENT",
      entity: "FollowupTask",
      entityId: taskId,
      meta: {
        ruleId: task.ruleId ?? null,
        clinicId: task.clinicId,
        conversationId: task.conversationId,
        trigger: rule?.trigger ?? null,
        level: rule?.level ?? null,
        sentVia: opts.via,
        viaTemplate,
      } as object,
    },
  });
  log.info({ taskId, via: opts.via, viaTemplate }, "followup: sent（queued）");
  return { status: "SENT", cancelReason: null, messageId: msg.id, viaTemplate };
}

// ── 病人回覆 → COMPLETED（唔 claim + 跟進回覆 badge）────────────────────────

/**
 * inbound 工人調（病人回覆咗跟住 SENT follow-up 嘅對話）：
 * task → COMPLETED + Conversation.followupRepliedAt = now（badge「跟進回覆」24h）
 * **唔 claim**：assigneeId 零改動（對話落公海照公海）；正常回覆流程完全唔受影響。
 */
export async function markFollowupReplied(conversationId: string, now: Date = new Date()): Promise<number> {
  const sent = await prisma.followupTask.findFirst({
    where: { conversationId, status: "SENT" },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!sent) return 0;
  const n = await prisma.followupTask.updateMany({
    where: { conversationId, status: "SENT" },
    data: { status: "COMPLETED", handledAt: now },
  });
  if (n.count > 0) {
    await prisma.conversation
      .updateMany({ where: { id: conversationId }, data: { followupRepliedAt: now } })
      .catch(() => undefined);
    await prisma.auditLog
      .create({
        data: {
          staffId: null,
          action: "FOLLOWUP_REPLIED",
          entity: "FollowupTask",
          entityId: sent.id,
          meta: { conversationId } as object,
        },
      })
      .catch(() => undefined);
  }
  return n.count;
}

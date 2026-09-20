/**
 * Follow-up 引擎（cwi-followup-v3-20260916 — 重新定位：「自動發訊息」→「員工提示層」）
 *
 * 語義：FollowupTask = **未處理建議**（唔再係「待發送任務」）。系統只指出邊個對話要跟 + 點解；
 * 發唔發、幾時發、講咩，一律由員工撳。cron 只建 SUGGESTED 建議 + 過期標記 + 取消檢查 —
 * **cron 零 outbound**（T430 鐵律）。
 *
 * 排程（cron "followup-scan" 每 10 分鐘）：
 *   ① expireStaleSuggestions（§2.4 時效表 — 過期 SUGGESTED → EXPIRED，唔通知唔提示）
 *   ② 對每條 enabled 規則掃候選 → 防呆（B-4 去重 / B-5 A 類）+ opt-out + 配對 → 建 SUGGESTED
 *   ③ A-1：per-rule lastScanAt/lastScanResult（OK|DEP_FAIL|EMPTY）+ audit FOLLOWUP_SCAN
 *
 * 狀態流：SUGGESTED →（員工採用）SENT →（病人回覆）COMPLETED
 *                 →（員工跳過）SKIPPED(MANUAL)   →（取消條件命中）CANCELLED   →（時效過期）EXPIRED
 *
 * 🔴 紅線：
 * - wa-inbox 唔存臨床全文：contextJson/templateVars 只入**顯示用**結構化數據
 *   （到診日期/預約時間/醫生名/visitId）— 零臨床全文、零原始電話（只 phoneHashes）。
 * - opt-out 永遠優先：任何規則唔可 override（自動偵測 + 手動 toggle）。
 * - 窗口過咗只可 template（registry approved=true）；未審批 → UI 唔俾發（send 側 403）。
 * - 發送只由 UI 觸發（POST /api/followups/tasks/:id adopt/send）→ 行 W 現有 outbound 機制；
 *   sentVia = AI_ADOPTED（永遠）→ 唔觸發 human cooldown（cooldown 只計 HUMAN_TYPED）。
 * - E 類訊息唔准重複報價金額（template 唔入 {{amount}}）。
 * - audit FOLLOWUP_SENT / FOLLOWUP_SCAN / FOLLOWUP_OPT_OUT / FOLLOWUP_REPLIED 零 PII；billingCategory = UTILITY。
 *
 * 防呆（spec §5）：
 * - B-4 跨店/多號去重：同 patientApricotId × 同 trigger 跨 clinic → 只留最近活躍對話嘅建議；
 *   終態（SKIPPED/SENT/COMPLETED）喺 rule.dedupWindowDays（default 7 日）內 → 唔再出。
 * - B-5 A 類防騷擾：最後 intent ∈ {THANKS, CLOSING} 唔出；同對話連續兩條建議被跳過/冇回應 → 永久唔再出；
 *   對話 RESOLVED 唔出（scan 只掃 OPEN）。
 * - B-6：C 類建議發出後標 conv.postOpFollowupAt；72h 內痛症訊號 → pipeline 強制 PAIN_TRIAGE（唔入 CONSULT）。
 *
 * 配對（P0 多號 E.164）：Contact.waId → phoneHashes(waId) ↔ appointment.phoneHashes hasSome。
 * 配唔到對話 → 唔建 task（無 WA 對話可發，建咗都係永久死 task）。
 *
 * 取消條件（每次發送前重跑）：OPT_OUT（永遠）/ REPLIED / BOOKED / ARRIVED / RESOLVED / NO_CONVERSATION。
 * （F 類 PAID 已隨 OUTSTANDING_BALANCE 整類剷走。）
 *
 * 冪等（重跑安全）：查重 = 同 rule 已有 SUGGESTED（in-flight）→ 跳；SENT 數 >= maxSends → 跳。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { Prisma, FollowupTrigger } from "@prisma/client";
import { phoneHashes } from "@/lib/phone-hash";
import { hkDateOffset, hkTodayStr } from "@/lib/availability";
import {
  fetchAppointmentsByClinic,
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
// ★ cwi-final S1-4/S1-7：message:new 完整 payload 單一來源 + publishConvEvent（跨店 targeting + eventId 去重）
async function lazyNotifyMessageNew(
  messageId: string,
  conv: { id: string; clinicId: string; assigneeId: string | null; routedStaffId: string | null; routedGroupId: string | null }
): Promise<void> {
  const { publishConvEvent, convRef } = await import("@/lib/notify");
  const { buildMessageNewPayload } = await import("@/lib/realtime-payload");
  const payload = await buildMessageNewPayload(messageId);
  await publishConvEvent(convRef(conv), "message:new", payload);
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

export type CreationSkip = "in-flight" | "exhausted" | "dedup-window" | null;

/**
 * 建 task 前查重（v3 口徑）：
 * - in-flight：同 rule + 同 conv/patient 已有 SUGGESTED（未處理建議喺度 — 唔重複出）
 * - exhausted：SENT 數 >= maxSends
 * - dedup-window（B-4②）：同 patientApricotId × 同 trigger 已有終態（SKIPPED/SENT/COMPLETED）
 *   喺 rule.dedupWindowDays（default 7 日）內 → 唔再出（跳過 7 日冷卻 / 已發 / 已覆）。
 *   跨 rule（同 trigger 唔同規則）都算 — 病人層去重優先於規則層。
 *   （B-4① 跨店 peer 比對喺 createTask — 要查對話活躍度。）
 */
export async function shouldSkipCreation(
  rule: { id: string; trigger: string; maxSends: number; dedupWindowDays: number },
  key: { conversationId: string | null; patientApricotId: string | null },
  now: Date
): Promise<CreationSkip> {
  const or: Prisma.FollowupTaskWhereInput[] = [];
  // ★ v3-fix（cwi-followup-v3 S5 T427）：in-flight/exhausted 只按**同對話**計 —
  //   同病人跨對話（跨店）嘅 SUGGESTED 由 B-4① 處理（留最近活躍）；
  //   若度計 patient 層，B-4① 會被永久遮蔽（「先到先贏」— 非 spec「留最近活躍」口徑）。
  //   無 conversationId 嘅 call（純病人層）→ fallback patient scope（保守不變）。
  if (key.conversationId) or.push({ conversationId: key.conversationId });
  else if (key.patientApricotId) or.push({ patientApricotId: key.patientApricotId });
  if (or.length === 0) return null;
  const existing = await prisma.followupTask.findMany({
    where: { ruleId: rule.id, status: { in: ["SUGGESTED", "SENT"] }, OR: or },
    select: { status: true },
  });
  if (existing.some((t) => t.status === "SUGGESTED")) return "in-flight";
  const sentCount = existing.filter((t) => t.status === "SENT").length;
  if (sentCount >= rule.maxSends) return "exhausted";
  if (key.patientApricotId) {
    const windowStart = new Date(now.getTime() - (rule.dedupWindowDays ?? 7) * DAY_MS);
    const sameTriggerRuleIds = await prisma.followupRule.findMany({
      where: { trigger: rule.trigger as FollowupTrigger },
      select: { id: true },
    });
    // 病人層去重：同 trigger 所有規則（跨 rule）的終態喺窗口內 → 跳。
    // ★ v3-fix（cwi-followup-v3 S5 T414a）：EXPIRED 入終態集 — §2.4「過咗就算」：
    //   舊 visit（dueAt 已過）嘅 task 建出即過期，下个 scan EXPIRED 後若唔計終態會無限重建（churn — p4 T414a 冪等恆紅）。
    const recent = await prisma.followupTask.findFirst({
      where: {
        patientApricotId: key.patientApricotId,
        ruleId: { in: sameTriggerRuleIds.map((r) => r.id) },
        status: { in: ["SKIPPED", "SENT", "COMPLETED", "EXPIRED"] },
        OR: [{ handledAt: { gte: windowStart } }, { createdAt: { gte: windowStart } }],
      },
      select: { id: true },
    });
    if (recent) return "dedup-window";
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
 * 建 task 前總門：opt-out（永遠）+ 查重 + B-4 跨店 peer 去重。
 * 建出 task 恒為 SUGGESTED（v3 — cron 零發送）。
 * 回「實際落咗 DB 嘅 task」或 null（跳過原因喺 skip 計數）。
 */
async function createTask(
  rule: {
    id: string;
    trigger: string;
    maxSends: number;
    dedupWindowDays: number;
  },
  draft: TaskDraft,
  template: { approved: boolean } | null,
  now: Date,
  counters: Record<string, number>
): Promise<{ id: string; status: string; dueAt: Date } | null> {
  void template; // v3：建 task 唔再 gate 審批（審批 gate 移咗去採用/發送側 + UI 顯示「等 template 審批」）
  // opt-out 永遠優先（任何規則唔可 override）
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
    now
  );
  if (skip) {
    counters[skip] = (counters[skip] ?? 0) + 1;
    return null;
  }
  // ★ B-4① 跨店/多號去重：同 patientApricotId × 同 trigger 已有 SUGGESTED peer（其他對話）
  //   → 只留最近活躍（lastMessageAt 較新）嗰條；舊 peer 換做 CANCELLED(DEDUP) 留痕。
  if (draft.patientApricotId && draft.conversationId) {
    const sameTriggerRuleIds = await prisma.followupRule.findMany({
      where: { trigger: rule.trigger as FollowupTrigger },
      select: { id: true },
    });
    const peer = await prisma.followupTask.findFirst({
      where: {
        patientApricotId: draft.patientApricotId,
        status: "SUGGESTED",
        ruleId: { in: sameTriggerRuleIds.map((r) => r.id) },
        conversationId: { not: draft.conversationId },
      },
      select: { id: true, conversationId: true },
    });
    if (peer?.conversationId) {
      const [peerConv, mine] = await Promise.all([
        prisma.conversation.findUnique({ where: { id: peer.conversationId }, select: { lastMessageAt: true } }),
        prisma.conversation.findUnique({ where: { id: draft.conversationId }, select: { lastMessageAt: true } }),
      ]);
      if (peerConv) {
        const mineTs = mine?.lastMessageAt?.getTime() ?? 0;
        const peerTs = peerConv.lastMessageAt.getTime();
        if (peerTs >= mineTs) {
          counters["dedup-cross"] = (counters["dedup-cross"] ?? 0) + 1;
          return null;
        }
        // 我哋更活躍 → 換掉 peer（留痕；兩個方向都計 dedup-cross — 均係跨店去重動作）
        counters["dedup-cross"] = (counters["dedup-cross"] ?? 0) + 1;
        await prisma.followupTask.update({
          where: { id: peer.id },
          data: { status: "CANCELLED", cancelReason: "DEDUP", handledAt: now, note: "B-4 跨店去重：換做最近活躍對話" },
        });
      }
    }
  }
  const task = await prisma.followupTask.create({
    data: {
      clinicId: draft.clinicId,
      conversationId: draft.conversationId,
      patientApricotId: draft.patientApricotId,
      phoneHashes: draft.phoneHashes,
      ruleId: draft.ruleId,
      source: "RULE",
      dueAt: draft.dueAt,
      status: "SUGGESTED",
      templateName: draft.templateName,
      templateVars: (draft.templateVars ?? undefined) as Prisma.InputJsonValue | undefined,
      contextJson: (draft.contextJson ?? undefined) as Prisma.InputJsonValue | undefined,
      note: draft.note ?? null,
    },
  });
  counters.created = (counters.created ?? 0) + 1;
  // ★ v3：cron 零 outbound — 冇 L2 直發。SUGGESTED 等員工喺收件箱建議卡撳採用/跳過。
  return { id: task.id, status: task.status, dueAt: task.dueAt };
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
      intent: true, // ★ B-5：最後 intent（THANKS/CLOSING 唔出建議）
    },
  });
  const contacts = await prisma.contact.findMany({
    where: { id: { in: convs.map((c) => c.contactId) } },
    select: { id: true, waId: true, profileName: true },
  });
  const contactMap = new Map(contacts.map((c) => [c.id, c]));
  // B-5② 用：A 類規則 id 集（一次查，喺 per-conv 循環內用 ruleId in）
  const idleRuleIds = await prisma.followupRule.findMany({ where: { trigger: "CONVERSATION_IDLE" }, select: { id: true } });
  const idleRuleIdSet = new Set(idleRuleIds.map((r) => r.id));
  for (const cv of convs) {
    const contact = contactMap.get(cv.contactId);
    if (!contact) continue;
    // ★ B-5 防騷擾①：最後一條訊息 intent ∈ {THANKS, CLOSING} → 病人已經謝過/收尾 — 唔出建議
    if (cv.intent === "THANKS" || cv.intent === "CLOSING") {
      counters["a-intent-close"] = (counters["a-intent-close"] ?? 0) + 1;
      continue;
    }
    // ★ B-5 防騷擾②：同對話**連續兩條** A 類建議都被跳過（SKIPPED）/冇回應（EXPIRED）→ 永久唔再出。
    //   口徑：撳晒終態（SKIPPED/EXPIRED/COMPLETED/SENT/CANCELLED）最近兩條 — 兩條都係 SKIPPED/EXPIRED 先算連續；
    //   中間有 COMPLETED/SENT（病人有反應）或 CANCELLED（自動取消）→ 斷連。
    const terminalTail = await prisma.followupTask.findMany({
      where: {
        conversationId: cv.id,
        status: { in: ["SKIPPED", "EXPIRED", "COMPLETED", "SENT", "CANCELLED"] },
        ruleId: { in: idleRuleIds.map((r) => r.id) },
      },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: { status: true },
    });
    void idleRuleIdSet;
    if (terminalTail.length === 2 && terminalTail.every((t) => t.status === "SKIPPED" || t.status === "EXPIRED")) {
      counters["a-two-strike"] = (counters["a-two-strike"] ?? 0) + 1;
      continue;
    }
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
  reasonCodes: string[]; // C/D 類：visitReason code 集
  templateName: string;
  level: string; // v3：engine 忽略（所有 follow-up 硬性 L1 — 永遠唔 auto-send）
  maxSends: number;
  cancelOnReply: boolean;
  cancelOnBooking: boolean;
  cancelOnArrival: boolean;
  cancelOnResolved: boolean;
  // ★ v3 新欄
  dedupWindowDays: number; // B-4 去重窗口（日；default 7）
  firstUseConfirmedAt: Date | null; // §3 B1 首啟用確認
  lastScanAt: Date | null; // A-1 留痕
  lastScanResult: string | null; // A-1：OK | DEP_FAIL | EMPTY
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

// ★ v3：F 欠款提醒（scanOutstandingBalance / OUTSTANDING_BALANCE）整類剷走 —
//   billOsAmt 分期係正常狀態，主動追破壞關係（spec §1）。餘額只做病人記錄側欄中性顯示。

// ── S2 入口：runFollowupScan（cron followup-scan 每 10 分鐘）────────────────

export interface FollowupScanResult {
  ok: boolean;
  rules: number;
  created: number;
  expired: number;
  inFlight: number;
  exhausted: number;
  dedupWindow: number;
  dedupCross: number;
  optOut: number;
  noConversation: number;
  workforceFail: number;
  booked: number; // E 類「報價後已有 booking」跳過數
  aIntentClose: number; // B-5① 最後 intent=THANKS/CLOSING 唔出
  aTwoStrike: number; // B-5② 兩連跳過永久停
  ruleFail: number;
}

// ── §2.4 時效：過期 SUGGESTED → EXPIRED（唔通知唔提示 — 過咗就算）──────────────

/**
 * 各 trigger 嘅過期條件（spec §2.4 時效表）：
 *   B1 BEFORE_APPOINTMENT = 應診時間已過（contextJson.apptDate/apptTime；fallback dueAt+1d）
 *   B2 AFTER_NO_SHOW      = 爽約後 7 日（contextJson.apptDate；fallback dueAt+7d）
 *   C  AFTER_TREATMENT    = 建議日（dueAt）+ 3 日
 *   D  RECALL_NO_REPEAT   = 建議日 + 14 日
 *   E  QUOTED_NOT_BOOKED  = 建議日 + 14 日
 *   A  CONVERSATION_IDLE  = 建議日 + 7 日
 */
export function suggestionExpiryAt(task: {
  dueAt: Date;
  contextJson: Prisma.JsonValue | null;
  rule: { trigger: string } | null;
}): Date {
  const trigger = task.rule?.trigger;
  const ctx = (task.contextJson ?? {}) as { apptDate?: string; apptTime?: string };
  switch (trigger) {
    case "BEFORE_APPOINTMENT": {
      if (ctx.apptDate) {
        const t = new Date(hkApptTimeMs(ctx.apptDate, ctx.apptTime ?? ""));
        if (!Number.isNaN(t.getTime())) return t; // 應診時間已過即過期
      }
      return new Date(task.dueAt.getTime() + DAY_MS);
    }
    case "AFTER_NO_SHOW": {
      if (ctx.apptDate) {
        return new Date(new Date(`${ctx.apptDate}T00:00:00+08:00`).getTime() + 7 * DAY_MS);
      }
      return new Date(task.dueAt.getTime() + 7 * DAY_MS);
    }
    case "AFTER_TREATMENT":
      return new Date(task.dueAt.getTime() + 3 * DAY_MS);
    case "RECALL_NO_REPEAT":
    case "QUOTED_NOT_BOOKED":
      return new Date(task.dueAt.getTime() + 14 * DAY_MS);
    case "CONVERSATION_IDLE":
      return new Date(task.dueAt.getTime() + 7 * DAY_MS);
    default:
      return new Date(task.dueAt.getTime() + 7 * DAY_MS);
  }
}

/** 過期掃（runFollowupScan 每輪先跑）：SUGGESTED 過時效 → EXPIRED。回過期數。 */
export async function expireStaleSuggestions(now: Date = new Date()): Promise<number> {
  const suggested = await prisma.followupTask.findMany({
    where: { status: "SUGGESTED" },
    select: { id: true, dueAt: true, contextJson: true, ruleId: true },
  });
  const rules = await prisma.followupRule.findMany({ select: { id: true, trigger: true } });
  const triggerById = new Map(rules.map((r) => [r.id, r.trigger]));
  let n = 0;
  for (const t of suggested) {
    const trigger = t.ruleId ? triggerById.get(t.ruleId) : undefined;
    if (suggestionExpiryAt({ dueAt: t.dueAt, contextJson: t.contextJson, rule: trigger ? { trigger } : null }).getTime() <= now.getTime()) {
      const r = await prisma.followupTask.updateMany({
        where: { id: t.id, status: "SUGGESTED" },
        data: { status: "EXPIRED", handledAt: now },
      });
      n += r.count;
    }
  }
  if (n > 0) log.info({ expired: n }, "followup: 過期建議 → EXPIRED（唔通知唔提示）");
  return n;
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
          // ★ v3 紅線：E 類訊息唔准重複報價金額 → templateVars 唔入 amount（template 已無 {{amount}}）
          templateVars: { quoteDate: q.sourceVisitDate, item: q.nameCn ?? q.text },
          contextJson: { quoteId: q.id, quoteDate: q.sourceVisitDate, item: q.text, nameCn: q.nameCn, intent: q.intent, quoteStatus: q.status, certainty: q.certainty, clinicCode: clinic.code },
        },
        await prisma.followupTemplate.findUnique({ where: { key: rule.templateName } }),
        now,
        counters
      );
    }
  }
}

export async function runFollowupScan(now: Date = new Date()): Promise<FollowupScanResult> {
  // ① 時效：過期 SUGGESTED → EXPIRED（先於 scan — 新建議唔會建喺已過期病人身上，dedup 計 terminal）
  const expired = await expireStaleSuggestions(now);
  const rules = (await prisma.followupRule.findMany({ where: { enabled: true } })) as unknown as FollowupRuleRow[];
  const clinics = await prisma.clinic.findMany({ select: { id: true, code: true } });
  const counters: Record<string, number> = {};
  for (const rule of rules) {
    const scope = rule.clinicId ? clinics.filter((c) => c.id === rule.clinicId) : clinics;
    const rc: Record<string, number> = {};
    let ruleErr: unknown = null;
    try {
      switch (rule.trigger) {
        case "CONVERSATION_IDLE":
          await scanIdleConversations(rule, scope.map((c) => c.id), now, rc);
          break;
        case "BEFORE_APPOINTMENT":
          await scanBeforeAppointment(rule, scope, now, rc);
          break;
        case "AFTER_NO_SHOW":
          await scanAfterNoShow(rule, scope, now, rc);
          break;
        case "AFTER_TREATMENT": // C（P4）
          await scanAfterTreatment(rule, scope, now, rc);
          break;
        case "RECALL_NO_REPEAT": // D（P4）
          await scanRecallNoRepeat(rule, scope, now, rc);
          break;
        case "QUOTED_NOT_BOOKED": // E（P4）
          await scanQuotedNotBooked(rule, scope, now, rc);
          break;
        default:
          log.warn({ rule: rule.id, trigger: rule.trigger }, "followup: 未知 trigger — 跳過");
          break;
      }
    } catch (err) {
      // 單條規則失敗唔阻其他規則（fail-soft；log 只 ruleId — 零病人資料）
      ruleErr = err;
      log.error({ rule: rule.id, trigger: rule.trigger, err: err instanceof Error ? err.message : String(err) }, "followup: rule scan failed");
    }
    // 合併 per-rule 計數入總計
    for (const [k, v] of Object.entries(rc)) counters[k] = (counters[k] ?? 0) + v;
    // ③ A-1 依賴斷線留痕：per-rule lastScanAt/lastScanResult（OK|DEP_FAIL|EMPTY）+ audit（hub 3 連 DEP_FAIL 紅字依據）
    const wf = rc.workforceFail ?? 0;
    const sawCandidate =
      (rc.created ?? 0) > 0 ||
      (rc["in-flight"] ?? 0) > 0 ||
      (rc.exhausted ?? 0) > 0 ||
      (rc["dedup-window"] ?? 0) > 0 ||
      (rc["dedup-cross"] ?? 0) > 0 ||
      (rc["a-intent-close"] ?? 0) > 0 ||
      (rc["a-two-strike"] ?? 0) > 0 ||
      (rc.noConversation ?? 0) > 0;
    const scanResult = ruleErr || wf > 0 ? "DEP_FAIL" : sawCandidate ? "OK" : "EMPTY";
    if (wf > 0) {
      log.warn({ ruleId: rule.id, trigger: rule.trigger, fails: wf }, "followup: workforce 依賴唔通 — 今輪零建議");
    }
    try {
      await prisma.followupRule.update({
        where: { id: rule.id },
        data: { lastScanAt: now, lastScanResult: scanResult },
      });
      await prisma.auditLog.create({
        data: {
          staffId: null,
          action: "FOLLOWUP_SCAN",
          entity: "FollowupRule",
          entityId: rule.id,
          meta: { trigger: rule.trigger, result: scanResult, created: rc.created ?? 0, workforceFail: wf } as object,
        },
      });
    } catch (err) {
      log.warn({ rule: rule.id, err: err instanceof Error ? err.message : String(err) }, "followup: scan trace write failed（fail-soft）");
    }
  }
  const result: FollowupScanResult = {
    ok: true,
    rules: rules.length,
    created: counters.created ?? 0,
    expired,
    inFlight: counters["in-flight"] ?? 0,
    exhausted: counters.exhausted ?? 0,
    dedupWindow: counters["dedup-window"] ?? 0,
    dedupCross: counters["dedup-cross"] ?? 0,
    optOut: counters.optOut ?? 0,
    noConversation: counters.noConversation ?? 0,
    workforceFail: counters.workforceFail ?? 0,
    booked: counters.booked ?? 0,
    aIntentClose: counters["a-intent-close"] ?? 0,
    aTwoStrike: counters["a-two-strike"] ?? 0,
    ruleFail: counters.ruleFail ?? 0,
  };
  log.info({ ...result }, "followup: scan done");
  return result;
}

// ── S3：取消條件六項（每次發送前重跑 — MD §4.4）────────────────────────────

export type CancelReason = "OPT_OUT" | "REPLIED" | "BOOKED" | "ARRIVED" | "RESOLVED" | "DEDUP" | "MANUAL" | "NO_CONVERSATION";

/**
 * 發送前重跑取消檢查。回 null = 可發。
 * OPT_OUT 永遠檢查（規則唔可關）；其餘跟規則 cancelOn* 旗。
 * workforce call fail-soft：攞唔到 appointments 唔會誤取消（寧可照發 —
 * 病人收到多條提醒好過漏提醒；fail-soft 唔會誤 kill task）。
 * （F 類 PAID 已隨 OUTSTANDING_BALANCE 整類剷走。）
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
  return null;
}

/**
 * ★ cwi-final S0-6：composer 路徑 claim 前嘅守門（同 sendFollowupTask 同一套檢查，但唔建訊息）。
 * 回 null = 可以 claim；否則回原因（task 已同步轉態）。
 */
export async function precheckAdoptedTask(
  taskId: string,
  conversationId: string,
  now = new Date()
): Promise<null | "NOT_FOUND" | "WRONG_CONVERSATION" | "NOT_SUGGESTED" | "EXPIRED" | string> {
  const task = await prisma.followupTask.findUnique({ where: { id: taskId } });
  if (!task) return "NOT_FOUND";
  if (task.conversationId !== conversationId) return "WRONG_CONVERSATION";
  if (task.status !== "SUGGESTED") return "NOT_SUGGESTED";
  const rule = task.ruleId ? ((await prisma.followupRule.findUnique({ where: { id: task.ruleId } })) as unknown as FollowupRuleRow | null) : null;
  if (suggestionExpiryAt({ dueAt: task.dueAt, contextJson: task.contextJson, rule }).getTime() <= now.getTime()) {
    await prisma.followupTask.updateMany({ where: { id: taskId, status: "SUGGESTED" }, data: { status: "EXPIRED", handledAt: now } });
    return "EXPIRED";
  }
  const clinic = await prisma.clinic.findUnique({ where: { id: task.clinicId }, select: { id: true, code: true, name: true } });
  const reason = await checkCancellations(task, rule, clinic, now);
  if (reason) {
    await prisma.followupTask.updateMany({ where: { id: taskId, status: "SUGGESTED" }, data: { status: "CANCELLED", cancelReason: reason, handledAt: now } });
    return reason;
  }
  return null;
}

// ── S4：發送（v3：只由 UI 觸發 — 員工撳「採用」；cron 永不入呢度）──────────────

export interface SendResult {
  status: "SENT" | "SKIPPED" | "CANCELLED" | "EXPIRED";
  cancelReason: CancelReason | "NO_TEMPLATE" | null;
  messageId: string | null;
  /** 過窗走 template 發送（META template）— e2e 斷言用 */
  viaTemplate: boolean;
}

/**
 * 發一個 follow-up 建議（v3：只由 UI 觸發 — 員工喺建議卡撳採用）。
 * 流程：狀態守門（SUGGESTED）→ 時效預檢（過期 → EXPIRED）→ 取消檢查（重跑）
 *   → 窗口判斷（開 = text / 過 = 必 approved template，未審批 → 唔真發、task 留 SUGGESTED）
 *   → Message QUEUED + task SENT 搶佔 → enqueue outbound + notify + audit。
 * 鐵律：唔 claim（assigneeId 零改動）；billingCategory = UTILITY；audit 零 PII；
 *   sentVia 恒為 AI_ADOPTED（v3 冇 AI_AUTO — L2 自動發送已取消）。
 * ★ B-6：C 類（AFTER_TREATMENT）發出成功 → conv.postOpFollowupAt = now（開 72h 痛症讓路窗口）。
 */
/**
 * ★ cwi-followup-v3 B-9：template locale 解析 — Contact.locale === "en" 且 `<key>_en` 存在 → 用 _en 版本；
 * 否則用 base key（出廠 5 條中文 draft — 英文章本由老細審批時補）。
 * 零 fallback 驚喜：locale=en 但冇 _en 行 → 照舊用 base（唔會唔發）。
 */
export async function resolveFollowupTemplate(key: string, contact: { locale: string | null } | null | undefined) {
  if (contact?.locale === "en") {
    const en = await prisma.followupTemplate.findUnique({ where: { key: `${key}_en` } });
    if (en) return en;
  }
  return prisma.followupTemplate.findUnique({ where: { key } });
}

export async function sendFollowupTask(
  taskId: string,
  opts: { via?: "AI_ADOPTED"; staffId?: string | null; now?: Date } = {}
): Promise<SendResult> {
  const now = opts.now ?? new Date();
  const task = await prisma.followupTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error(`followup: task ${taskId} not found`);
  if (task.status !== "SUGGESTED") {
    return { status: task.status as SendResult["status"], cancelReason: task.cancelReason as SendResult["cancelReason"], messageId: task.sentMessageId, viaTemplate: false };
  }
  const rule = task.ruleId
    ? ((await prisma.followupRule.findUnique({ where: { id: task.ruleId } })) as unknown as FollowupRuleRow | null)
    : null;
  // ★ 時效預檢：過咗 §2.4 時效 → EXPIRED（唔發）
  if (suggestionExpiryAt({ dueAt: task.dueAt, contextJson: task.contextJson, rule }).getTime() <= now.getTime()) {
    await prisma.followupTask.update({ where: { id: taskId }, data: { status: "EXPIRED", handledAt: now } });
    return { status: "EXPIRED", cancelReason: null, messageId: null, viaTemplate: false };
  }
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
    ? await prisma.conversation.findUnique({
        // ★ cwi-final S1-4：ConvRef 五欄齊（publishConvEvent targeting 用）
        where: { id: task.conversationId },
        select: { id: true, clinicId: true, contactId: true, lastInboundAt: true, assigneeId: true, routedStaffId: true, routedGroupId: true },
      })
    : null;
  const convId = task.conversationId;
  if (!conv || !convId) {
    await prisma.followupTask.update({ where: { id: taskId }, data: { status: "CANCELLED", cancelReason: "NO_CONVERSATION", handledAt: now } });
    return { status: "CANCELLED", cancelReason: "NO_CONVERSATION", messageId: null, viaTemplate: false };
  }
  const contact = await prisma.contact.findUnique({ where: { id: conv.contactId }, select: { salutation: true, profileName: true, locale: true } });
  // ★ cwi-followup-v3 B-9：EN template 由 Contact.locale 決定（*_en 存在優先）
  const template = task.templateName ? await resolveFollowupTemplate(task.templateName, contact) : null;
  if (!template) {
    // template 行缺失 = 配置錯 → 唔真發（task 留 SUGGESTED — 修好配置后可再採；UI 顯示配置錯）
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
      // 🔴 安全設計：template 未審批 → 唔會真發（seed 全部 approved=false）。
      // v3：task 留 SUGGESTED（審批後可再採用 — 唔係 terminal，唔計入 dedup 窗口）；UI 顯示「等 template 審批」。
      log.warn({ taskId, template: template.key }, "followup: 窗口過咗但 template 未審批 → 唔俾發（task 留 SUGGESTED）");
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

  // ③ Message QUEUED + task SENT 搶佔（併發冪等：先搶佔 SUGGESTED 先建 message）
  const claimed = await prisma.followupTask.updateMany({
    where: { id: taskId, status: "SUGGESTED" },
    data: { status: "SENT", handledAt: now, handledBy: opts.staffId ?? null },
  });
  if (claimed.count !== 1) {
    // 併發（兩員工同時撳）— 後到者退
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
      // ★ v3：只由 UI 觸發 → 永遠 AI_ADOPTED（cooldown 只計 HUMAN_TYPED → 唔觸發）
      aiAutoSent: false,
      sentVia: "AI_ADOPTED",
      // ★ 鐵律：billingCategory = UTILITY
      billingCategory: "UTILITY",
      waTimestamp: now,
    },
  });
  await prisma.followupTask.update({ where: { id: taskId }, data: { sentMessageId: msg.id } });
  // ★ B-6：C 類術後關懷建議發出 → 對話開 72h 窗口（痛症訊號讓路 PAIN_TRIAGE + 草稿零療程零報價）
  if (rule?.trigger === "AFTER_TREATMENT") {
    await prisma.conversation
      .updateMany({ where: { id: convId }, data: { postOpFollowupAt: now } })
      .catch(() => undefined);
  }

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
  await lazyNotifyMessageNew(msg.id, conv);
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
        sentVia: "AI_ADOPTED",
        viaTemplate,
      } as object,
    },
  });
  log.info({ taskId, viaTemplate }, "followup: sent（queued — 員工採用）");
  return { status: "SENT", cancelReason: null, messageId: msg.id, viaTemplate };
}

// ── 員工跳過 → SKIPPED(MANUAL)（dedup 窗口內同 trigger 同病人唔再出）────────

/**
 * 員工喺建議卡撳「跳過」：SUGGESTED → SKIPPED，cancelReason = MANUAL。
 * B-4②：dedupWindowDays 內同 patient × 同 trigger 唔再出新建議（shouldSkipCreation）。
 * 併發冪等：updateMany where=SUGGESTED 搶佔；後到者收到現狀。
 */
export async function skipFollowupTask(
  taskId: string,
  opts: { staffId?: string | null; now?: Date } = {}
): Promise<{ status: string }> {
  const now = opts.now ?? new Date();
  const task = await prisma.followupTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error(`followup: task ${taskId} not found`);
  if (task.status !== "SUGGESTED") {
    return { status: task.status };
  }
  const r = await prisma.followupTask.updateMany({
    where: { id: taskId, status: "SUGGESTED" },
    data: { status: "SKIPPED", cancelReason: "MANUAL", handledAt: now, handledBy: opts.staffId ?? null },
  });
  if (r.count === 1) {
    await prisma.auditLog
      .create({
        data: {
          staffId: opts.staffId ?? null,
          action: "FOLLOWUP_SKIPPED",
          entity: "FollowupTask",
          entityId: taskId,
          meta: { ruleId: task.ruleId ?? null, clinicId: task.clinicId, conversationId: task.conversationId } as object,
        },
      })
      .catch(() => undefined);
  }
  return { status: r.count === 1 ? "SKIPPED" : (await prisma.followupTask.findUnique({ where: { id: taskId }, select: { status: true } }))?.status ?? "SKIPPED" };
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

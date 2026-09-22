/**
 * cwi-followup-p4-20260916 S6 + ★ cwi-followup-v3-20260916 — hub「主動跟進」server 摘要
 *
 * v3（員工提示層）：
 *  ① 幾時排   — trigger 規則列表（出廠 6 條 = P3 3 + P4 3；F 欠款整類已剷）
 *  ② 取消條件 — 五項 checkbox（OPT_OUT 鐵律鎖定；每次發送前重跑 — §4.4）
 *  ③ 點發     — 建議卡（cron 零 outbound — 永遠由員工喺對話內建議卡撳）
 * 健康警示 6 項：template 未審批 / 建議積壓 > 30 / opt-out 詞未設 / 索引 job 昨晚失敗 / 電話正規化率 < 90%
 *              / ★ A-1 依賴斷線（某規則最近 3 次 scan 全 DEP_FAIL → 紅字）
 *
 * 零 client 端邏輯分支：全部數字 server 端即時算（fail-soft — workforce 斷唔會炸 hub）。
 */
import prisma from "@/lib/prisma";
import { fetchClinicalIndexStatus, fetchDictionaries, WorkforceApiError } from "@/lib/workforce/client";
import { optOutWordCount } from "./opt-out";

export interface FollowupHubRule {
  id: string;
  name: string;
  trigger: string;
  delayValue: number;
  delayUnit: string;
  whenText: string; // ① 幾時排（人話）
  reasonCodes: string[];
  reasonLabels: string[]; // 字典名（fail-soft：映唔到照回 code）
  templateKey: string;
  templateName: string; // 顯示名
  templateApproved: boolean | null;
  maxSends: number;
  enabled: boolean;
  // ★ v3：A-1 掃描留痕（hub 顯示用）
  lastScanAt: string | null;
  lastScanResult: string | null; // OK | DEP_FAIL | EMPTY | ERROR（★ cwi-final S2-8：非 workforce 例外 = ERROR）
}
export interface CancelCondition {
  key: string;
  label: string;
  locked: boolean;
  note: string;
}
export interface FollowupHubWarning {
  id: string;
  ok: boolean;
  reason: string;
}
export interface FollowupHubSummary {
  rules: FollowupHubRule[];
  cancelConditions: CancelCondition[];
  sendPolicy: { note: string };
  health: FollowupHubWarning[];
  queue: { suggested: number };
  generatedAt: string;
}

const UNIT_CN: Record<string, string> = { HOUR: "小時", DAY: "日", WEEK: "星期", MONTH: "個月" };

function whenText(r: { trigger: string; delayValue: number; delayUnit: string; reasonLabels: string[] }): string {
  const u = UNIT_CN[r.delayUnit] ?? r.delayUnit;
  switch (r.trigger) {
    case "CONVERSATION_IDLE":
      return `對話 ${r.delayValue} ${u}無回應`;
    case "BEFORE_APPOINTMENT":
      return `預約前 ${r.delayValue} ${u}`;
    case "AFTER_NO_SHOW":
      return `爽約後 ${r.delayValue} ${u}`;
    case "AFTER_TREATMENT":
      return `合格治療（有抗生素）後 ${r.delayValue} ${u}`;
    case "RECALL_NO_REPEAT":
      return `上次${r.reasonLabels[0] ?? "同類治療"}後滿 ${r.delayValue} ${u}`;
    case "QUOTED_NOT_BOOKED":
      return `報價後 ${r.delayValue} ${u}未成交`;
    default:
      return `${r.delayValue} ${u}`;
  }
}

/** 五項取消條件（v3 — 每次發送前重跑；OPT_OUT 鐵律鎖定唔可關；F 類 PAID 已隨欠款整類剷走）。 */
const CANCEL_CONDITIONS: CancelCondition[] = [
  { key: "OPT_OUT", label: "病人 opt-out（唔好再跟進）", locked: true, note: "鐵律鎖定 — 永遠檢查，唔可關" },
  { key: "REPLIED", label: "task 建後病人已回覆", locked: false, note: "有新 inbound = 已對話" },
  { key: "BOOKED", label: "期間已有新 booking", locked: false, note: "已落單 = 唔使跟" },
  { key: "ARRIVED", label: "該預約已到店（bookingStatus 1/4）", locked: false, note: "已到店 = 唔使跟" },
  { key: "RESOLVED", label: "對話已解決（status=RESOLVED）", locked: false, note: "結咗 = 唔使跟" },
];

const SEND_POLICY = { note: "cron 零 outbound — 只建建議；一律由員工喺對話內建議卡撳採用（窗口內 free-form / 過窗 template）或跳過" };

export async function buildFollowupHubSummary(): Promise<FollowupHubSummary> {
  const rules = await prisma.followupRule.findMany({ orderBy: [{ trigger: "asc" }] });

  // VISIT_REASON 字典名（fail-soft — 映唔到照回 code；client 有 1h cache）
  const dictNames = new Map<string, string>();
  try {
    const d = await fetchDictionaries("VISIT_REASON");
    for (const it of d.items) dictNames.set(it.code, it.des);
  } catch {
    /* codes 原樣顯示 */
  }

  const templates = await prisma.followupTemplate.findMany({ select: { key: true, name: true, approved: true } });
  const tplMap = new Map(templates.map((t) => [t.key, t]));

  const ruleRows: FollowupHubRule[] = rules.map((r) => {
    const t = tplMap.get(r.templateName);
    const reasonCodes = r.reasonCodes ?? [];
    const reasonLabels = reasonCodes.map((c) => dictNames.get(c) ?? c);
    return {
      id: r.id,
      name: r.name,
      trigger: r.trigger,
      delayValue: r.delayValue,
      delayUnit: r.delayUnit,
      whenText: whenText({ trigger: r.trigger, delayValue: r.delayValue, delayUnit: r.delayUnit, reasonLabels }),
      reasonCodes,
      reasonLabels,
      templateKey: r.templateName,
      templateName: t?.name ?? r.templateName,
      templateApproved: t ? t.approved : null,
      maxSends: r.maxSends,
      enabled: r.enabled,
      lastScanAt: r.lastScanAt ? r.lastScanAt.toISOString() : null,
      lastScanResult: r.lastScanResult,
    };
  });

  // 建議積壓（v3：SUGGESTED 等員工處理）
  const suggested = await prisma.followupTask.count({ where: { status: "SUGGESTED" } });

  const finish = (health: FollowupHubWarning[]): FollowupHubSummary => ({
    rules: ruleRows,
    cancelConditions: CANCEL_CONDITIONS,
    sendPolicy: SEND_POLICY,
    health,
    queue: { suggested },
    generatedAt: new Date().toISOString(),
  });

  // ── 健康警示 6 項 ──
  const health: FollowupHubWarning[] = [];
  // 1) template 未審批
  const unapproved = ruleRows.filter((r) => r.enabled && r.templateApproved === false);
  health.push(
    unapproved.length
      ? { id: "template_unapproved", ok: false, reason: `${unapproved.map((r) => `${r.name}（${r.templateKey}）`).join("、")} template 未審批 — 過窗採用唔會真發（等審批），窗口內 free-form 不受影響` }
      : { id: "template_unapproved", ok: true, reason: "" }
  );
  // 2) 建議積壓 > 30
  health.push(
    suggested > 30
      ? { id: "queue_backlog", ok: false, reason: `待跟進建議積壓 ${suggested} 條（SUGGESTED）> 30 — 請安排跟進` }
      : { id: "queue_backlog", ok: true, reason: "" }
  );
  // 3) opt-out 詞未設
  const wordCount = optOutWordCount();
  health.push(
    wordCount === 0
      ? { id: "optout_words", ok: false, reason: "opt-out 詞表未設（0 詞）— 自動偵測失效，只剩手動 toggle" }
      : { id: "optout_words", ok: true, reason: "" }
  );
  // 4+5) 索引 job / 電話正規化率（CWM 狀態）
  let idx: Awaited<ReturnType<typeof fetchClinicalIndexStatus>> | null = null;
  try {
    idx = await fetchClinicalIndexStatus();
  } catch (e) {
    if (e instanceof WorkforceApiError && (e.status === 404 || e.status === 503 || e.status === 0)) {
      idx = null; // 網絡斷 / 未部署 → fail-soft（同 P3 口徑）
    } else {
      // 4xx/5xx 真錯 → 警示（hub 要睇到 workforce 異常）
      const st = e instanceof WorkforceApiError ? e.status : 500;
      health.push({ id: "index_job", ok: false, reason: `索引狀態讀唔到（workforce ${st}）` });
      health.push({ id: "phone_normalize", ok: false, reason: `電話正規化率讀唔到（workforce ${st}）` });
      return finish(health);
    }
  }
  if (idx) {
    const ln = idx.lastNightly;
    const failedLastNight = !!ln && ln.status === "FAILED" && !!ln.finishedAt && Date.now() - new Date(ln.finishedAt).getTime() < 36 * 3600 * 1000;
    health.push(
      failedLastNight
        ? { id: "index_job", ok: false, reason: `臨床索引夜跑失敗（${new Date(ln.finishedAt as string).toLocaleString("zh-HK")}，errors=${ln.errors}${ln.lastError ? `：${ln.lastError.slice(0, 80)}` : ""}）— C/D/E 觸發數據會遲` }
        : { id: "index_job", ok: true, reason: "" }
    );
    const rate = idx.phoneNormalize.rate;
    health.push(
      rate !== null && rate < 0.9
        ? { id: "phone_normalize", ok: false, reason: `電話正規化率 ${(rate * 100).toFixed(1)}% < 90%（${idx.phoneNormalize.total - idx.phoneNormalize.withHash}/${idx.phoneNormalize.total} 行冇 phone hash）— 跟進配對會漏` }
        : { id: "phone_normalize", ok: true, reason: "" }
    );
  } else {
    health.push({ id: "index_job", ok: true, reason: "" }); // fail-soft
    health.push({ id: "phone_normalize", ok: true, reason: "" });
  }
  // 6) ★ A-1 依賴斷線：某規則最近 3 次 FOLLOWUP_SCAN audit 全 DEP_FAIL → 紅字
  try {
    const depFails: string[] = [];
    for (const r of rules) {
      const last3 = await prisma.auditLog.findMany({
        where: { action: "FOLLOWUP_SCAN", entityId: r.id },
        orderBy: { createdAt: "desc" },
        take: 3,
        select: { meta: true },
      });
      if (last3.length === 3 && last3.every((a) => (a.meta as { result?: string } | null)?.result === "DEP_FAIL")) {
        depFails.push(r.name);
      }
    }
    health.push(
      depFails.length
        ? { id: "scan_dep_fail", ok: false, reason: `${depFails.join("、")} 最近 3 次掃描全部 workforce 依賴失敗（DEP_FAIL）— 該類建議會持續為零，請檢查 workforce 連線` }
        : { id: "scan_dep_fail", ok: true, reason: "" }
    );
  } catch {
    health.push({ id: "scan_dep_fail", ok: true, reason: "" }); // fail-soft
  }
  return finish(health);
}

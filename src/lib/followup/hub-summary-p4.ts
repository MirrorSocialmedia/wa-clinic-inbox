/**
 * cwi-followup-p4-20260916 S6 — hub 第二 tab「主動跟進」server 摘要（MD §5.4）
 *
 * 三步：
 *  ① 幾時排   — trigger 規則列表（出廠 7 條 = P3 4 + P4 3）
 *  ② 取消條件 — 六項 checkbox（OPT_OUT 鐵律鎖定；每次發送前重跑 — §4.4）
 *  ③ 點發     — template 對應 · L1/L2 · 每日上限（唔設，靠 L1 — 老細拍板）
 * 健康警示 5 項：template 未審批 / 隊列積壓 > 30 / opt-out 詞未設 / 索引 job 昨晚失敗 / 電話正規化率 < 90%
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
  level: string;
  maxSends: number;
  enabled: boolean;
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
  sendPolicy: { dailyCap: string; l1: string; l2: string };
  health: FollowupHubWarning[];
  queue: { due: number; scheduled: number };
  generatedAt: string;
}

const UNIT_CN: Record<string, string> = { HOUR: "小時", DAY: "日", WEEK: "星期", MONTH: "個月" };

function whenText(r: { trigger: string; delayValue: number; delayUnit: string; minAmount: number | null; reasonLabels: string[] }): string {
  const u = UNIT_CN[r.delayUnit] ?? r.delayUnit;
  switch (r.trigger) {
    case "CONVERSATION_IDLE":
      return `對話 ${r.delayValue} ${u}無回應`;
    case "BEFORE_APPOINTMENT":
      return `預約前 ${r.delayValue} ${u}`;
    case "AFTER_NO_SHOW":
      return `爽約後 ${r.delayValue} ${u}`;
    case "OUTSTANDING_BALANCE":
      return `欠款 ≥ $${r.minAmount ?? "—"}`;
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

/** 六項取消條件（MD §4.4 — 每次發送前重跑；OPT_OUT 鐵律鎖定唔可關）。 */
const CANCEL_CONDITIONS: CancelCondition[] = [
  { key: "OPT_OUT", label: "病人 opt-out（唔好再跟進）", locked: true, note: "鐵律鎖定 — 永遠檢查，唔可關" },
  { key: "REPLIED", label: "task 建後病人已回覆", locked: false, note: "有新 inbound = 已對話" },
  { key: "BOOKED", label: "期間已有新 booking", locked: false, note: "已落單 = 唔使跟" },
  { key: "ARRIVED", label: "該預約已到店（bookingStatus 1/4）", locked: false, note: "已到店 = 唔使跟" },
  { key: "RESOLVED", label: "對話已解決（status=RESOLVED）", locked: false, note: "結咗 = 唔使跟" },
  { key: "PAID", label: "F 類：欠款已歸零", locked: false, note: "付清 = 唔使跟" },
];

const SEND_POLICY = { dailyCap: "唔設 — 靠 L1 人手隊列", l1: "入「待跟進」隊列等人撳（AI_ADOPTED）", l2: "cron 直接發（AI_AUTO；同樣行取消檢查）" };

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
      whenText: whenText({ trigger: r.trigger, delayValue: r.delayValue, delayUnit: r.delayUnit, minAmount: r.minAmount, reasonLabels }),
      reasonCodes,
      reasonLabels,
      templateKey: r.templateName,
      templateName: t?.name ?? r.templateName,
      templateApproved: t ? t.approved : null,
      level: r.level,
      maxSends: r.maxSends,
      enabled: r.enabled,
    };
  });

  // 隊列積壓
  const [due, scheduled] = await Promise.all([
    prisma.followupTask.count({ where: { status: "DUE" } }),
    prisma.followupTask.count({ where: { status: "SCHEDULED" } }),
  ]);

  const finish = (health: FollowupHubWarning[]): FollowupHubSummary => ({
    rules: ruleRows,
    cancelConditions: CANCEL_CONDITIONS,
    sendPolicy: SEND_POLICY,
    health,
    queue: { due, scheduled },
    generatedAt: new Date().toISOString(),
  });

  // ── 健康警示 5 項 ──
  const health: FollowupHubWarning[] = [];
  // 1) template 未審批
  const unapproved = ruleRows.filter((r) => r.enabled && r.templateApproved === false);
  health.push(
    unapproved.length
      ? { id: "template_unapproved", ok: false, reason: `${unapproved.map((r) => `${r.name}（${r.templateKey}）`).join("、")} template 未審批 — 到期 task 會 SKIPPED(NO_TEMPLATE)，零發送（審批後自動恢復）` }
      : { id: "template_unapproved", ok: true, reason: "" }
  );
  // 2) 隊列積壓 > 30
  const backlog = due + scheduled;
  health.push(
    backlog > 30
      ? { id: "queue_backlog", ok: false, reason: `待跟進隊列積壓 ${backlog} 條（DUE ${due} + SCHEDULED ${scheduled}）> 30 — 請安排跟進` }
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
  return finish(health);
}

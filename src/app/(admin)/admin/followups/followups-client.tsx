"use client";
/**
 * /admin/followups client — cwi-followup-v3-20260916（MD §0/§2/§3）。
 *
 * ★ v3 形態：follow-up = 員工提示層（系統只指出邊個對話要跟＋點解；發唔發一律員工撳）。
 *   - 獨立「待跟進隊列」頁 ❌ 已取消 → 改為**收件箱「待跟進 N」膠囊 + 對話內建議卡**（MD §2）。
 *   - L2 自動發送 ❌ 取消（全部硬性 L1）；cron 零 outbound（只建 SUGGESTED 建議 + 過期 EXPIRED）。
 *   - F 欠款提醒 ❌ 整類剷走（餘額只做病人記錄中性顯示）。
 *   本頁剩兩區：① 規則（啟用/延遲/dedupWindowDays/健康）② Template registry（審批）。
 * 全繁體 UI；零臨床全文顯示（contextJson 只係顯示用結構化數據）。
 */
import { useCallback, useEffect, useState } from "react";

type Tab = "rules" | "templates";

interface RuleRow {
  id: string;
  name: string;
  enabled: boolean;
  trigger: string;
  delayValue: number;
  delayUnit: string;
  /** ★ v3 B-4②：同病人同 trigger 終態（SKIPPED/SENT/COMPLETED）後 N 日內唔再出（default 7） */
  dedupWindowDays: number;
  /** ★ v3 §3 B1：BEFORE_APPOINTMENT 首啟用確認時間（null = 啟用時要彈確認） */
  firstUseConfirmedAt: string | null;
  /** ★ v3 A-1：上輪 scan 留痕（OK | DEP_FAIL | EMPTY） */
  lastScanAt: string | null;
  lastScanResult: string | null;
  templateName: string;
  templateApproved: boolean;
  level: string;
  maxSends: number;
}
interface TemplateRow {
  key: string;
  name: string;
  text: string;
  approved: boolean;
  approvedAt: string | null;
}

const TRIGGER_LABEL: Record<string, string> = {
  CONVERSATION_IDLE: "對話空窗",
  BEFORE_APPOINTMENT: "預約提醒",
  AFTER_NO_SHOW: "未到診提醒",
  AFTER_TREATMENT: "術後關懷",
  RECALL_NO_REPEAT: "定期召回",
  QUOTED_NOT_BOOKED: "報價未成交",
};

function fmtTs(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleString("zh-HK", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function FollowupsClient() {
  const [tab, setTab] = useState<Tab>("rules");
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // ★ v3 §3 B1：首啟用確認彈窗（「確認診所冇其他渠道發預約提醒？」— 老細拍板：照做 + 確認）
  const [pendingEnable, setPendingEnable] = useState<RuleRow | null>(null);

  const load = useCallback(async () => {
    try {
      const [rl, tp] = await Promise.all([
        fetch("/api/admin/followups/rules").then((r) => (r.ok ? r.json() : { rules: [] })),
        fetch("/api/admin/followups/templates").then((r) => (r.ok ? r.json() : { templates: [] })),
      ]);
      setRules(rl.rules ?? []);
      setTemplates(tp.templates ?? []);
    } catch {
      setMsg("載入失敗 — 重試");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: string, fn: () => Promise<void>, doneMsg: string) => {
    setBusy(id);
    setMsg(null);
    try {
      await fn();
      setMsg(doneMsg);
      await load();
    } catch {
      setMsg("操作失敗");
    } finally {
      setBusy(null);
    }
  };

  /** B1 啟用流程：未首啟用確認 → 彈確認；已確認 → 直接 PATCH enabled */
  const toggleEnable = (r: RuleRow, checked: boolean) => {
    if (checked && r.trigger === "BEFORE_APPOINTMENT" && !r.firstUseConfirmedAt) {
      setPendingEnable(r); // 等彈窗確認先 PATCH
      return;
    }
    void act(r.id, async () => {
      const res = await fetch(`/api/admin/followups/rules/${r.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: checked }),
      });
      if (!res.ok) throw new Error(`patch ${res.status}`);
    }, "規則狀態已更新");
  };

  const confirmB1Enable = () => {
    const r = pendingEnable;
    if (!r) return;
    setPendingEnable(null);
    void act(r.id, async () => {
      const res = await fetch(`/api/admin/followups/rules/${r.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // ★ B1：首啟用確認（MD §3）— 之後發現有其它渠道 = 規則 disable 就得（唔使改 code）
        body: JSON.stringify({ enabled: true, firstUseConfirmedAt: new Date().toISOString() }),
      });
      if (!res.ok) throw new Error(`patch ${res.status}`);
    }, "預約提醒已啟用（首啟用確認已記錄）");
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold">跟進規則</h1>
        <p className="text-sm text-t2">
          引擎每 10 分鐘掃規則建「未處理建議」（SUGGESTED）→ 顯示喺**收件箱「待跟進」膠囊 + 對話內建議卡**；
          發唔發、改唔改字一律員工撳（cron 零 outbound，全部硬性 L1 建議）。
        </p>
      </div>

      <div className="flex gap-2 border-b border-line">
        {(
          [
            ["rules", "規則"],
            ["templates", "Template"],
          ] as [Tab, string][]
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-3 py-1.5 text-sm ${tab === k ? "border-b-2 border-primary font-semibold" : "text-t2"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {msg && <div className="rounded border border-line bg-panel-2 px-3 py-2 text-sm">{msg}</div>}

      {tab === "rules" && (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="bg-panel-2 text-left text-xs text-t2">
              <tr>
                <th className="px-3 py-2">規則</th>
                <th className="px-3 py-2">類型</th>
                <th className="px-3 py-2">延遲</th>
                <th className="px-3 py-2">去重窗</th>
                <th className="px-3 py-2">Template</th>
                <th className="px-3 py-2">上輪 scan</th>
                <th className="px-3 py-2 text-right">啟用</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="px-3 py-2">{r.name}</td>
                  <td className="px-3 py-2 text-xs">{TRIGGER_LABEL[r.trigger] ?? r.trigger}</td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">
                    {r.delayValue} {r.delayUnit === "DAY" ? "日" : r.delayUnit === "HOUR" ? "小時" : r.delayUnit === "WEEK" ? "週" : "月"}
                  </td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">{r.dedupWindowDays} 日</td>
                  <td className="px-3 py-2 text-xs">
                    {r.templateName}
                    {r.templateApproved ? null : <span className="text-warn-text">（未審批）</span>}
                  </td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">
                    {r.lastScanAt ? (
                      <>
                        {fmtTs(r.lastScanAt)}
                        <div
                          className={
                            r.lastScanResult === "DEP_FAIL"
                              ? "text-danger-text font-semibold"
                              : r.lastScanResult === "EMPTY"
                                ? "text-t3"
                                : "text-ok-text"
                          }
                        >
                          {r.lastScanResult ?? "—"}
                        </div>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      disabled={busy === r.id}
                      onChange={(e) => toggleEnable(r, e.target.checked)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-line bg-panel-2 px-3 py-2 text-xs text-t2">
            取消條件（建議發出前每次重跑）：OPT_OUT（永遠優先）/ 病人已回覆 / 期間新預約 / 已到店 / 對話已解決 — 可喺規則 JSON 調校（cancelOn* 旗）。
            時效過期由引擎自動標 EXPIRED（唔通知、唔提示）。
          </p>
        </div>
      )}

      {tab === "templates" && (
        <div className="space-y-3">
          {templates.map((t) => (
            <div key={t.key} className="rounded-lg border border-line p-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold">
                  {t.name} <span className="text-xs font-normal text-t2">（{t.key}）</span>
                </div>
                <div className="flex items-center gap-2">
                  {t.approved ? (
                    <span className="rounded-full border border-ok/40 bg-ok-soft px-2.5 py-0.5 text-xs font-semibold text-ok-text">
                      已審批{t.approvedAt ? ` ${fmtTs(t.approvedAt)}` : ""}
                    </span>
                  ) : (
                    <>
                      <span className="rounded-full border border-warn/40 bg-warn-soft px-2.5 py-0.5 text-xs font-semibold text-warn-text">
                        未審批（過窗發唔出）
                      </span>
                      <button
                        disabled={busy === t.key}
                        onClick={() =>
                          act(t.key, async () => {
                            const r = await fetch("/api/admin/followups/templates", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ key: t.key }),
                            });
                            if (!r.ok) throw new Error(`approve ${r.status}`);
                          }, `「${t.name}」已審批 — 過窗可發`)
                        }
                        className="rounded bg-primary px-2.5 py-1 text-xs text-white disabled:opacity-50"
                      >
                        審批
                      </button>
                    </>
                  )}
                </div>
              </div>
              <pre className="mt-2 whitespace-pre-wrap rounded bg-panel-2 p-2 text-xs text-t2">{t.text}</pre>
            </div>
          ))}
          <p className="text-xs text-t2">
            變數佔位：{"{{salutation}}"} 稱呼 / {"{{clinicName}}"} 診所名 / {"{{apptDate}}"}・{"{{apptTime}}"} 預約 / {"{{providerName}}"} 醫生。
            出廠 5 條 draft 全部未審批（老細審批中）— 審批前過窗建議會顯示「等 template 審批」唔會真發（窗口內 free-form 不受影響）。
          </p>
        </div>
      )}

      {/* ★ v3 §3 B1：首啟用確認彈窗（一次；記錄 firstUseConfirmedAt） */}
      {pendingEnable && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-line bg-panel p-5 shadow-xl">
            <div className="text-sm font-semibold mb-2">啟用「{pendingEnable.name}」前確認</div>
            <p className="text-sm text-t2 mb-1">
              確認診所**冇其他渠道**（Apricot / SMS / 人手 WhatsApp）發預約確認／提醒？
            </p>
            <p className="text-xs text-t3 mb-4">
              如果已有其他渠道發 → 唔好啟用呢條規則（重複騷擾）。之後發現有 → 直接 disable 規則就得。
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPendingEnable(null)}
                disabled={busy === pendingEnable.id}
                className="rounded-full border border-line px-3 py-1.5 text-sm text-t2 hover:bg-panel-2 disabled:opacity-40"
              >
                取消
              </button>
              <button
                onClick={confirmB1Enable}
                disabled={busy === pendingEnable.id}
                className="rounded-full bg-brand px-3 py-1.5 text-sm font-medium text-panel hover:opacity-90 disabled:opacity-40"
              >
                確認冇其他渠道，啟用
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

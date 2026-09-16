"use client";
/**
 * /admin/followups client（followup-v2 MD §4）— 三 tab：待跟進隊列 / 規則 / Template。
 * 全繁體 UI；零臨床全文顯示（contextJson 只係顯示用結構化數據）。
 */
import { useCallback, useEffect, useState } from "react";

type Tab = "queue" | "rules" | "templates";

interface TaskRow {
  id: string;
  ruleName: string | null;
  trigger: string | null;
  level: string | null;
  templateName: string | null;
  templateApproved: boolean | null;
  dueAt: string;
  status: string;
  cancelReason: string | null;
  patientName: string | null;
  salutation: string | null;
  optOut: boolean;
  contextJson: Record<string, unknown> | null;
  templateVars: Record<string, unknown> | null;
}
interface RuleRow {
  id: string;
  name: string;
  enabled: boolean;
  trigger: string;
  delayValue: number;
  delayUnit: string;
  minAmount: number | null;
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
  BEFORE_APPOINTMENT: "診前提醒",
  AFTER_NO_SHOW: "爽約跟進",
  OUTSTANDING_BALANCE: "欠款提醒",
  AFTER_TREATMENT: "術後關懷（P4）",
  RECALL_NO_REPEAT: "定期召回（P4）",
  QUOTED_NOT_BOOKED: "報價未成交（P4）",
};
const STATUS_LABEL: Record<string, string> = {
  SCHEDULED: "已排程",
  DUE: "到期",
  SENT: "已發送",
  SKIPPED: "跳過",
  CANCELLED: "已取消",
  COMPLETED: "已完成",
};

function fmtTs(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleString("zh-HK", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** contextJson 顯示用摘要（只結構化數據：日期/金額/時間） */
function ctxSummary(t: TaskRow): string {
  const c = (t.contextJson ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (c.apptDate) parts.push(`預約 ${String(c.apptDate)} ${String(c.apptTime ?? "")}`);
  if (c.osAmt !== undefined && c.osAmt !== null) parts.push(`欠款 $${String(c.osAmt)}`);
  if (c.idleDays !== undefined) parts.push(`靜默 ${String(c.idleDays)} 日`);
  if (c.noShow) parts.push("（爽約）");
  return parts.join(" · ") || "—";
}

export default function FollowupsClient() {
  const [tab, setTab] = useState<Tab>("queue");
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [tq, rl, tp] = await Promise.all([
        fetch("/api/followups/tasks?limit=100").then((r) => (r.ok ? r.json() : { tasks: [] })),
        fetch("/api/admin/followups/rules").then((r) => (r.ok ? r.json() : { rules: [] })),
        fetch("/api/admin/followups/templates").then((r) => (r.ok ? r.json() : { templates: [] })),
      ]);
      setTasks(tq.tasks ?? []);
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

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold">主動跟進</h1>
        <p className="text-sm text-t2">
          引擎每 10 分鐘掃規則建 task；L1 入隊列等人撳（AI_ADOPTED），L2 到期自動發（AI_AUTO）。窗口過咗只發已審批 template。
        </p>
      </div>

      <div className="flex gap-2 border-b border-line">
        {(
          [
            ["queue", "待跟進隊列"],
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

      {tab === "queue" && (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="bg-panel-2 text-left text-xs text-t2">
              <tr>
                <th className="px-3 py-2">到期</th>
                <th className="px-3 py-2">規則</th>
                <th className="px-3 py-2">對象</th>
                <th className="px-3 py-2">摘要</th>
                <th className="px-3 py-2">Template</th>
                <th className="px-3 py-2">狀態</th>
                <th className="px-3 py-2 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {tasks.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-t2">
                    隊列空（無到期 task — 引擎每 10 分鐘掃）
                  </td>
                </tr>
              )}
              {tasks.map((t) => (
                <tr key={t.id} className="border-t border-line">
                  <td className="px-3 py-2 whitespace-nowrap">{fmtTs(t.dueAt)}</td>
                  <td className="px-3 py-2">
                    {t.ruleName ?? "—"}
                    <div className="text-xs text-t2">{TRIGGER_LABEL[t.trigger ?? ""] ?? t.trigger}</div>
                  </td>
                  <td className="px-3 py-2">
                    {t.patientName ?? "（未配對對話）"}
                    {t.salutation ? <span className="text-xs text-t2">（{t.salutation}）</span> : null}
                    {t.optOut && <div className="text-xs text-danger-text">已 opt-out</div>}
                  </td>
                  <td className="px-3 py-2 text-t2">{ctxSummary(t)}</td>
                  <td className="px-3 py-2 text-xs">
                    {t.templateName ?? "—"}
                    {t.templateApproved === false && <div className="text-warn-text">未審批</div>}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {STATUS_LABEL[t.status] ?? t.status}
                    {t.cancelReason ? <div className="text-t2">{t.cancelReason}</div> : null}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {(t.status === "DUE" || t.status === "SCHEDULED") && (
                      <span className="inline-flex gap-1">
                        <button
                          disabled={busy === t.id}
                          onClick={() =>
                            act(t.id, async () => {
                              const r = await fetch(`/api/followups/tasks/${t.id}`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ action: "send" }),
                              });
                              if (!r.ok) throw new Error(`send ${r.status}`);
                            }, "已排隊發送（outbound worker 處理）")
                          }
                          className="rounded bg-primary px-2 py-1 text-xs text-white disabled:opacity-50"
                        >
                          發送
                        </button>
                        <button
                          disabled={busy === t.id}
                          onClick={() =>
                            act(t.id, async () => {
                              const r = await fetch(`/api/followups/tasks/${t.id}`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ action: "cancel" }),
                              });
                              if (!r.ok) throw new Error(`cancel ${r.status}`);
                            }, "已取消")
                          }
                          className="rounded border border-line px-2 py-1 text-xs text-t2 disabled:opacity-50"
                        >
                          取消
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "rules" && (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="bg-panel-2 text-left text-xs text-t2">
              <tr>
                <th className="px-3 py-2">規則</th>
                <th className="px-3 py-2">類型</th>
                <th className="px-3 py-2">延遲</th>
                <th className="px-3 py-2">門檻</th>
                <th className="px-3 py-2">級別</th>
                <th className="px-3 py-2">Template</th>
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
                  <td className="px-3 py-2 text-xs">{r.minAmount ? `$${r.minAmount} 以上` : "—"}</td>
                  <td className="px-3 py-2">
                    <select
                      value={r.level}
                      disabled={busy === r.id}
                      onChange={(e) =>
                        act(r.id, async () => {
                          const res = await fetch(`/api/admin/followups/rules/${r.id}`, {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ level: e.target.value }),
                          });
                          if (!res.ok) throw new Error(`patch ${res.status}`);
                        }, "級別已更新")
                      }
                      className="rounded border border-line bg-panel px-1 py-0.5 text-xs"
                    >
                      <option value="L1">L1（入隊列）</option>
                      <option value="L2">L2（自動發）</option>
                    </select>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.templateName}
                    {r.templateApproved ? null : <span className="text-warn-text">（未審批）</span>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      disabled={busy === r.id}
                      onChange={(e) =>
                        act(r.id, async () => {
                          const res = await fetch(`/api/admin/followups/rules/${r.id}`, {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ enabled: e.target.checked }),
                          });
                          if (!res.ok) throw new Error(`patch ${res.status}`);
                        }, "規則狀態已更新")
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-line bg-panel-2 px-3 py-2 text-xs text-t2">
            取消條件（發送前每次重跑）：OPT_OUT（永遠）/ 病人已回覆 / 期間新預約 / 已到店 / 對話已解決 / 欠款已清 — 可喺規則 JSON 調校（cancelOn* 旗）。
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
                        未審批（窗口過唔會發）
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
            變數佔位：{"{{salutation}}"} 稱呼 / {"{{clinicName}}"} 診所名 / {"{{apptDate}}"}・{"{{apptTime}}"} 預約 / {"{{providerName}}"} 醫生 /
            {"{{osAmt}}"} 欠款金額。出廠 6 條 draft 全部未審批（老細審批中）— 審批前實運行時 task 會 SKIPPED(NO_TEMPLATE) 唔會真發。
          </p>
        </div>
      )}
    </div>
  );
}

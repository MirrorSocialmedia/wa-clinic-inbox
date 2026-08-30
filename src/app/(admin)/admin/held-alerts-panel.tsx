/**
 * /admin 「線上已佔（HELD）監看」（providerslot-20260830 T3 — MD §六）
 *
 * 數據 = workforce held API（逐 clinic fail-soft）— 🔴 零病人 PII（workforce 層只出
 * provider/date/時段/齡；本地 FlowHoldEvent 嘅病人資料唔 join 入呢張表）。
 * 齡 > 12h = MEDIUM、> holdTimeoutHours(24) = HIGH（MD §六；數值由 clinic 設定帶出）。
 * sweep（cron hold-sweep，每 5 分鐘）負責落 Alert 行 + auto-resolve — 呢度係 live 快照。
 */
import { getHeldAlertSnapshot, minToHHmm } from "@/lib/flows/hold-sweep";

const SEV_CLS: Record<string, string> = {
  HIGH: "bg-danger text-panel",
  MEDIUM: "bg-warn text-warn-text",
  OK: "bg-panel-2 text-t2",
};

export async function HeldAlertsPanel() {
  const snap = await getHeldAlertSnapshot();

  if (snap.allFailed) {
    return (
      <div className="rounded-xl bg-panel-2 p-5 text-sm text-t2 text-center">
        clinic-workforce 未接通（{snap.failedClinics.length} 間店全部讀唔到 held 數據）
      </div>
    );
  }

  if (snap.rows.length === 0) {
    return (
      <p className="text-sm text-t2">
        ✅ 冇線上已佔（HELD / IN_APRICOT）— sweep 每 5 分鐘自動對返 + 逾時落警報行
      </p>
    );
  }

  return (
    <div>
      <table className="w-full text-sm">
        <thead className="text-left border-b border-line">
          <tr>
            <th className="py-2 text-[11px] uppercase tracking-[0.08em] text-t2 font-semibold">店</th>
            <th className="py-2 text-[11px] uppercase tracking-[0.08em] text-t2 font-semibold">醫生</th>
            <th className="py-2 text-[11px] uppercase tracking-[0.08em] text-t2 font-semibold">時段</th>
            <th className="py-2 text-[11px] uppercase tracking-[0.08em] text-t2 font-semibold">齡</th>
            <th className="py-2 text-[11px] uppercase tracking-[0.08em] text-t2 font-semibold">狀態</th>
            <th className="py-2 text-[11px] uppercase tracking-[0.08em] text-t2 font-semibold">評級</th>
          </tr>
        </thead>
        <tbody>
          {snap.rows.map((r) => (
            <tr key={r.holdId} className="border-b border-line last:border-0 hover:bg-black/[.04]">
              <td className="py-2 font-mono text-t1">{r.clinicCode}</td>
              <td className="py-2 text-t1">{r.providerName}</td>
              <td className="py-2 text-t2 font-mono">
                {r.date} {minToHHmm(r.startMin)}–{minToHHmm(r.endMin)}
                {r.appointmentPast && <span className="ml-1.5 text-[10px] text-warn-text">（預約時間已過）</span>}
              </td>
              <td className="py-2 text-t1 font-mono">{r.ageHours}h</td>
              <td className="py-2">
                <span className="text-[10.5px] font-semibold px-2 py-0.5 rounded-full bg-panel-2 text-t2">{r.status}</span>
              </td>
              <td className="py-2">
                <span className={`text-[10.5px] font-semibold px-2 py-0.5 rounded-full ${SEV_CLS[r.severity] ?? SEV_CLS.OK}`}>
                  {r.severity}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {snap.failedClinics.length > 0 && (
        <p className="mt-2 text-xs text-warn-text">
          注意：{snap.failedClinics.join("、")} 讀唔到（workforce 離線或 key 失效）
        </p>
      )}
      <p className="mt-2 text-xs text-t3">
        評級門檻：HELD &gt; 12h = MEDIUM、&gt; {snap.holdTimeoutHours ?? 24}h（holdTimeoutHours）= HIGH — 由
        hold-sweep 每 5 分鐘落「警報（未解決）」行；病人資料唔顯示（workforce 端零 PII）。
      </p>
    </div>
  );
}

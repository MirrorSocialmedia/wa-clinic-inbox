import { unauthorized, forbidden } from "next/navigation";
import { getServerSession } from "@/lib/session-server";
import { listMessageTemplates, type MessageTemplate } from "@/lib/wa/graph";

/**
 * /admin/templates — WhatsApp message template 審批狀態監察（App Review §2A，ADMIN-only，read-only）。
 *
 * - 頂部註明：Template 喺 WhatsApp Manager 建立，此處監察審批狀態。
 * - 零寫入功能 — read-only 已足夠證明 management 用途（screencast 幕 5 用）。
 * - mock mode（WA_MOCK=1）：graph.ts 返 3 fixture（APPROVED/PENDING/REJECTED 各一）。
 * - real mode：GET /{WA_WABA_ID}/message_templates（10s timeout）。
 * - 非 ADMIN → 403（App Review 驗收；layout 已 fail-closed，呢度係防線二）。
 */
export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, string> = {
  APPROVED: "bg-ok-soft text-ok-text border-ok/40", // 綠
  PENDING: "bg-warn-soft text-warn-text border-warn/40", // 琥珀
  REJECTED: "bg-danger-soft text-danger-text border-danger/40", // 紅
};

function statusBadge(status: string) {
  const cls = STATUS_STYLE[status] ?? "bg-panel-2 text-t2 border-line-strong";
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${cls}`}>
      {status}
    </span>
  );
}

export default async function TemplatesPage() {
  const session = await getServerSession();
  if (!session) unauthorized(); // 防線二：layout 已把 unauth 導去 /login
  if (session.role !== "ADMIN") forbidden(); // 非 ADMIN → 403（App Review 驗收）

  const wabaId = process.env.WA_WABA_ID ?? "";
  let templates: MessageTemplate[] = [];
  let error: string | null = null;
  if (wabaId) {
    try {
      templates = await listMessageTemplates(wabaId);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-panel rounded-lg border border-line p-5 text-sm text-t2">
        <h2 className="text-lg font-semibold text-t1">WhatsApp Templates</h2>
        <p className="mt-1">
          Template 喺 <span className="text-t1">WhatsApp Manager</span> 建立，此處監察審批狀態（read-only，零寫入）。
        </p>
        {!wabaId && (
          <p className="mt-3 rounded-md bg-warn-soft border border-warn/40 px-3 py-2 text-warn-text">
            未設 <span className="font-mono">WA_WABA_ID</span>（.env）— FB Dashboard → WhatsApp → API Setup 攞 test WABA id 填入。
          </p>
        )}
        {error && (
          <p className="mt-3 rounded-md bg-danger-soft border border-danger/40 px-3 py-2 text-danger-text">
            載入失敗：{error}
          </p>
        )}
      </div>

      <table className="w-full text-sm bg-panel rounded-lg border border-line overflow-hidden">
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-t3">
            <th className="px-4 py-2.5">Name</th>
            <th className="px-4 py-2.5">Language</th>
            <th className="px-4 py-2.5">Category</th>
            <th className="px-4 py-2.5">Status</th>
          </tr>
        </thead>
        <tbody>
          {templates.length === 0 && !error ? (
            <tr>
              <td colSpan={4} className="px-4 py-6 text-center text-t3">
                （無 template — 喺 WhatsApp Manager 建立）
              </td>
            </tr>
          ) : (
            templates.map((t) => (
              <tr key={`${t.name}-${t.language}`} className="border-b border-line last:border-0">
                <td className="px-4 py-2.5 font-mono text-xs">{t.name}</td>
                <td className="px-4 py-2.5">{t.language}</td>
                <td className="px-4 py-2.5">{t.category}</td>
                <td className="px-4 py-2.5">{statusBadge(t.status)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

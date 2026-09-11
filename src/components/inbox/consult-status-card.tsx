"use client";

/**
 * ★ consult v2.1 C5（MD §8.2）：對話側欄 CONSULT 狀態卡。
 *
 * 鐵律（§8.0）：店員畫面**零技術詞** — slot/stage/rule/positioning/candidate/workflow/action/code
 * 名全部唔准出現；stage 全中文（DISCOVER=了解需求中…）；問句式標籤。
 *
 * 資料：GET /api/conversations/:id/consult-sessions（active session + convHumanTookOver live 旗
 * + maxTurns — server 端 effective 設定）。只有 active（terminal=null）session 先顯示卡。
 * 動作（店員改動 → audit CONSULT_STATE_EDITED，MD §8.2）：
 *   [標記為已評估] PATCH op=assess（臨床適合度 — 鐵律：只有店員可改臨床判斷）
 *   [重設]         PATCH op=reset（stage 返 DISCOVER / slots 清空）
 *   已知 chip 撳 × = PATCH op=clearSlot（店員改 slot）
 *   [交返 AI 繼續] PATCH op=resume（只喺 AI 已暫停時出現 — §8.4）
 * refresh：conversationId / refreshKey 變 + 5s poll（輕量 — 單對話兩行）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RotateCcw, Stethoscope } from "lucide-react";

// ── 全中文 label 表（零技術詞 — 畫面只出現呢啲字） ─────────────────────

const WORKFLOW_ZH: Record<string, string> = {
  ORTHODONTIC_CONSULT: "箍牙",
  IMPLANT_CONSULT: "植牙",
};

const STAGE_ZH: Record<string, string> = {
  DISCOVER: "了解需求中",
  EDUCATE: "講解方案中",
  PRESENT_OPTIONS: "介紹方案中",
  CONSULTATION: "建議評估",
  BOOKING: "安排預約中",
};

const SLOT_ZH: Record<string, string> = {
  treatmentGoal: "治療目標",
  appearancePriority: "重視外觀",
  speedPriority: "想快啲",
  budgetSensitivity: "預算敏感",
  statedBudget: "講咗預算",
  customerProductInterest: "指定咗方案",
  previousOrtho: "箍過牙",
  timeline: "時間要求",
  missingCount: "缺牙數",
  missingDuration: "缺牙時長",
  hasSeenDentist: "睇過牙醫",
  customerBrandInterest: "品牌興趣",
  clinicalSuitability: "臨床適合度",
};

const DIRECTION_ZH: Record<string, string> = {
  CLEAR_ALIGNER: "隱形方案（未指定邊款）",
  FIXED: "固定方案",
};

const OBJECTION_ZH: Record<string, string> = {
  PRICE: "價格",
  TIME: "時間",
  PAIN: "痛",
  APPEARANCE: "外觀",
  TRUST: "信任",
  FEAR: "擔心",
  COMPARISON: "比較",
  UNCERTAINTY: "猶豫",
};

const OBJ_STATUS_ZH: Record<string, string> = {
  OPEN: "處理緊",
  HANDLED: "已處理",
  RECURRED: "再提起",
};

interface SessionRow {
  id: string;
  workflow: string;
  stage: string;
  terminal: string | null;
  active: boolean;
  slots: Record<string, unknown>;
  objections: { type: string; status?: string; count?: number }[];
  candidateCategory: string | null;
  askedSlots: string[];
  turnCount: number;
  purchaseIntent: number;
  humanTookOver: boolean;
}

interface CardData {
  active: SessionRow | null;
  convHumanTookOver: boolean;
  maxTurns: number;
}

function intentDots(intent: number): { filled: number; total: number } {
  const total = 5;
  return { filled: Math.min(total, Math.max(0, Math.round(intent * total))), total };
}

export function ConsultStatusCard({
  conversationId,
  refreshKey,
}: {
  conversationId: string | null;
  refreshKey?: number;
}) {
  const [data, setData] = useState<CardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!conversationId) {
      setData(null);
      return;
    }
    try {
      const res = await fetch(`/api/conversations/${conversationId}/consult-sessions`, { signal });
      if (!res.ok) {
        setData(null);
        return;
      }
      const j = (await res.json()) as { active: SessionRow | null; convHumanTookOver: boolean; maxTurns: number };
      setData({ active: j.active ?? null, convHumanTookOver: !!j.convHumanTookOver, maxTurns: j.maxTurns ?? 8 });
    } catch {
      /* 網絡錯 — 唔渲染卡（fail-soft，唔擋側欄其餘內容） */
    }
  }, [conversationId]);

  useEffect(() => {
    setLoading(true);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    void load(ac.signal).finally(() => setLoading(false));
    const t = window.setInterval(() => void load(), 5000);
    return () => {
      window.clearInterval(t);
      ac.abort();
    };
  }, [load, refreshKey]);

  const patch = useCallback(
    async (op: string, slotKey?: string) => {
      const s = data?.active;
      if (!conversationId || !s || busy) return;
      setBusy(op + (slotKey ?? ""));
      try {
        const res = await fetch(`/api/conversations/${conversationId}/consult-sessions`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: s.id, op, ...(slotKey ? { slotKey } : {}) }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => null)) as { message?: string } | null;
          window.alert(j?.message ?? "操作失敗");
        }
        await load();
      } finally {
        setBusy(null);
      }
    },
    [conversationId, data, busy, load]
  );

  if (!conversationId) return null;

  if (loading && !data) {
    return (
      <div className="bg-panel-2 rounded-[16px] p-3 flex items-center gap-2 text-t3 text-xs">
        <Loader2 size={13} className="animate-spin" /> 載入中…
      </div>
    );
  }

  const s = data?.active;
  if (!s) return null; // 冇 active 銷售對話 → 唔顯示卡

  const paused = s.humanTookOver || data!.convHumanTookOver;
  const slots = (s.slots && typeof s.slots === "object" ? s.slots : {}) as Record<string, unknown>;
  const knownKeys = Object.keys(slots).filter((k) => k !== "meta" && k !== "clinicalSuitability");
  const assessed = slots.clinicalSuitability === "ASSESSED";
  const dots = intentDots(s.purchaseIntent);

  return (
    <div className="bg-panel-2 rounded-[16px] p-3" data-testid="consult-status-card">
      {/* 標題行：銷售對話 · 療程 + [重設] */}
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-t2">
          銷售對話 · {WORKFLOW_ZH[s.workflow] ?? "諮詢"}
        </div>
        <button
          onClick={() => {
            if (window.confirm("重設呢個銷售對話？（已知資料會清空）")) void patch("reset");
          }}
          disabled={busy !== null}
          data-testid="c5-card-reset"
          className="inline-flex items-center gap-1 text-[11px] text-t3 hover:text-danger-text disabled:opacity-50"
        >
          <RotateCcw size={11} strokeWidth={2.5} /> 重設
        </button>
      </div>

      {/* 階段 + 意向 */}
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="text-xs text-t1" data-testid="c5-card-stage">
          階段：<span className="font-medium">{STAGE_ZH[s.stage] ?? "了解需求中"}</span>
        </div>
        <div className="flex items-center gap-1" title="意向程度">
          <span className="text-[11px] text-t3">意向</span>
          {Array.from({ length: dots.total }, (_, i) => (
            <span
              key={i}
              className={`inline-block w-2 h-2 rounded-full ${i < dots.filled ? "bg-brand" : "bg-line"}`}
            />
          ))}
        </div>
      </div>

      {/* 已知（chip 可撳清 = 店員改 slot） */}
      {knownKeys.length > 0 && (
        <div className="mt-2">
          <div className="text-[11px] text-t3 mb-1">已知</div>
          <div className="flex flex-wrap gap-1">
            {knownKeys.map((k) => (
              <button
                key={k}
                onClick={() => void patch("clearSlot", k)}
                title="撳一下清除呢項（改錯用）"
                data-testid="c5-card-slot"
                data-slot={k}
                className="inline-flex items-center gap-1 text-[11px] bg-brand-soft text-brand-text rounded-full px-2 py-0.5 hover:bg-danger-soft hover:text-danger-text"
              >
                {SLOT_ZH[k] ?? k}
                <span className="text-[9px] opacity-60">✕</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 方向 */}
      <div className="mt-2 text-xs text-t1">
        方向：<span className="font-medium">{s.candidateCategory ? DIRECTION_ZH[s.candidateCategory] ?? "未指定" : "未指定"}</span>
      </div>

      {/* 臨床適合度 */}
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="text-xs text-t1">
          臨床適合度：
          <span className={assessed ? "text-brand font-medium" : "text-t3"}>{assessed ? "已評估" : "未評估"}</span>
        </div>
        {!assessed && (
          <button
            onClick={() => void patch("assess")}
            disabled={busy !== null}
            data-testid="c5-card-assess"
            className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full bg-brand text-panel font-medium disabled:opacity-50"
          >
            <Stethoscope size={11} strokeWidth={2.5} /> 標記為已評估
          </button>
        )}
      </div>

      {/* 疑慮 */}
      {Array.isArray(s.objections) && s.objections.length > 0 && (
        <div className="mt-2 text-xs text-t1">
          疑慮：
          {s.objections
            .map((o) => `${OBJECTION_ZH[o.type] ?? o.type} ×${o.count ?? 1}（${OBJ_STATUS_ZH[o.status ?? "OPEN"] ?? "處理緊"}）`)
            .join(" · ")}
        </div>
      )}

      {/* 已問 + 輪數 */}
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="text-[11px] text-t3">
          已問：
          {s.askedSlots.length === 0
            ? "—"
            : s.askedSlots.map((k) => `${SLOT_ZH[k] ?? k} ✓`).join("  ")}
        </div>
        <div className="text-[11px] text-t3 shrink-0">
          對話輪數：{s.turnCount} / {data!.maxTurns}
        </div>
      </div>

      {/* AI 已暫停 → 交返 */}
      {paused && (
        <div className="mt-3 border-t border-line pt-2 flex items-center justify-between gap-2" data-testid="c5-card-paused">
          <span className="text-[11px] text-warn-text">AI 已暫停</span>
          <button
            onClick={() => void patch("resume")}
            disabled={busy !== null}
            data-testid="c5-card-resume"
            className="text-[11px] px-2.5 py-1 rounded-full bg-brand text-panel font-medium disabled:opacity-50"
          >
            交返 AI 繼續
          </button>
        </div>
      )}
    </div>
  );
}

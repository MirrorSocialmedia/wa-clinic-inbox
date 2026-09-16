"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import FollowupHubTab from "./followup-hub-tab";

/**
 * ★ cwi-hub-b-20260914（Part B B.2/B.3/B.5）：AI 流程 hub client。
 *
 * 布局（B.2）：頂部系統健康列（紅底先顯示）→ 上半沙盤 → 下半七步狀態列。
 * 沙盤（B.3/B.5）：對話式輸入、逐輪七步（✓/⏸/✗/—）、右側常駐 session 狀態卡、
 *   [重新開始]（清 Redis key）、[加入測試集]（建 GoldenCase 預填）、[再試下一句]。
 * 七步列（B.2）：每行 = 序號·名·現況摘要·警示·[調較]；撳行跳 anchor（B.1）。
 *
 * 零 client 端邏輯分支：所有數字/摘要/警示由 GET /api/admin/ai 即時算回傳（T360 口徑）；
 * 沙盤結果由 POST /api/admin/ai-sandbox/run 回傳（鐵律：零副作用喺 server 端）。
 */

interface HubStep {
  n: number;
  name: string;
  summary: string;
  warnings: string[];
  anchor: string;
  detail: Record<string, unknown>;
}
interface HealthItem {
  id: string;
  ok: boolean;
  reason: string;
}
interface HubSummary {
  steps: HubStep[];
  health: HealthItem[];
  swVersion: string;
  demoQuestions: string[];
  clinics: { id: string; code: string; name: string }[];
}
interface SandboxStep {
  n: number;
  name: string;
  status: "ok" | "paused" | "fail" | "skip";
  summary: string;
  detail: Record<string, unknown>;
}
interface SessionSnapshot {
  workflow: string;
  stage: string;
  terminal: string | null;
  turnCount: number;
  purchaseIntent: number;
  lastAction: string | null;
  askedSlots: string[];
  slots: Record<string, unknown>;
}
interface RunResult {
  sandboxId: string;
  turn: number;
  steps: SandboxStep[];
  draft: string | null;
  draftMode: string | null;
  intent: string;
  urgency: string;
  needsHuman: boolean;
  consultTrigger: string | null;
  sessionSnapshot: SessionSnapshot | null;
  sendVerdict: { level: string; willAutoSend: boolean; blocks: string[] };
  latencyMs: number;
  llmCalls: number;
}
interface TurnRecord {
  key: number;
  message: string;
  result?: RunResult;
  error?: string;
}

const STATUS_META: Record<SandboxStep["status"], { ch: string; cls: string }> = {
  ok: { ch: "✓", cls: "text-ok-text" },
  paused: { ch: "⏸", cls: "text-warn-text" },
  fail: { ch: "✗", cls: "text-danger-text" },
  skip: { ch: "—", cls: "text-t3" },
};

const HEALTH_LABEL: Record<string, string> = {
  sglang: "sglang",
  redis: "Redis",
  workforce: "workforce",
  meta: "Meta token",
  vapid: "VAPID",
  sw: "SW",
  followup: "跟進 template",
};

export default function AiHub({ role }: { role: string }) {
  const isAdmin = role === "ADMIN";
  const [summary, setSummary] = useState<HubSummary | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [swStale, setSwStale] = useState<string | null>(null);

  // ── 沙盤 state ──
  const [clinicId, setClinicId] = useState<string>("");
  const [input, setInput] = useState("");
  const [sandboxId, setSandboxId] = useState<string | null>(null);
  const [turns, setTurns] = useState<TurnRecord[]>([]);
  const [running, setRunning] = useState(false);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [demoIdx, setDemoIdx] = useState(0);
  const [goldenMsg, setGoldenMsg] = useState<string | null>(null);
  // ★ cwi-followup-p4 S6（MD §5.4）：hub 第二 tab「主動跟進」（三步 + 健康警示 5 項）
  const [tab, setTab] = useState<"flow" | "followup">("flow");
  const logRef = useRef<HTMLDivElement>(null);
  const keyRef = useRef(0);

  // ── 載入 hub 摘要（即時算 — 每次 mount + 每輪沙盤後 refresh）──
  const loadSummary = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/ai", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as HubSummary;
      setSummary(data);
      setLoadErr(null);
      if (!clinicId && data.clinics.length > 0) setClinicId(data.clinics[0].id);
    } catch (err) {
      setLoadErr(err instanceof Error ? err.message : String(err));
    }
  }, [clinicId]);

  useEffect(() => {
    void loadSummary();
    // SW 過舊檢查：browser 實際行緊嘅 controller script 版本 vs server 端 public/sw.js 版本
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .getRegistration()
        .then(async (reg) => {
          const script = reg?.active?.scriptURL ?? reg?.waiting?.scriptURL ?? null;
          if (!script) return;
          const src = await (await fetch(script, { cache: "no-store" })).text();
          const m = src.match(/SW_VERSION\s*=\s*"([^"]+)"/);
          if (m) window.dispatchEvent(new CustomEvent("hub-sw-check", { detail: { fileVersion: m[1] } }));
        })
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const h = (e: Event) => {
      const fileVersion = (e as CustomEvent).detail?.fileVersion as string;
      const expected = summary?.swVersion;
      if (expected && fileVersion && fileVersion !== expected) setSwStale(fileVersion);
    };
    window.addEventListener("hub-sw-check", h);
    return () => window.removeEventListener("hub-sw-check", h);
  }, [summary]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [turns, running]);

  // ── 沙盤 run（POST /api/admin/ai-sandbox/run — 鐵律：server 端零副作用）──
  const runTurn = useCallback(
    async (message: string) => {
      const msg = message.trim();
      if (!msg || !clinicId || running) return;
      setRunning(true);
      setRunErr(null);
      setGoldenMsg(null);
      keyRef.current += 1;
      const key = keyRef.current;
      setTurns((t) => [...t, { key, message: msg }]);
      setInput("");
      try {
        const res = await fetch("/api/admin/ai-sandbox/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clinicId, message: msg, sandboxId: sandboxId ?? undefined }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
        const r = data as RunResult;
        setSandboxId(r.sandboxId);
        setTurns((t) => t.map((x) => (x.key === key ? { ...x, result: r } : x)));
        void loadSummary(); // 七步摘要 refresh（沙盤零寫入 → 摘要通常不變，但照 B.2「每次載入即時算」）
      } catch (err) {
        setTurns((t) => t.map((x) => (x.key === key ? { ...x, error: err instanceof Error ? err.message : String(err) } : x)));
      } finally {
        setRunning(false);
      }
    },
    [clinicId, running, sandboxId, loadSummary]
  );

  // [重新開始] — POST /reset 清 Redis key（state 永不落 DB → 冇 DB 殘留）
  const restart = useCallback(async () => {
    if (!sandboxId) return;
    try {
      await fetch("/api/admin/ai-sandbox/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sandboxId }),
      });
    } catch {
      /* 重啟失敗不阻 — 下次 run 會覆蓋 state */
    }
    setSandboxId(null);
    setTurns([]);
    setRunErr(null);
    setDemoIdx(0);
  }, [sandboxId]);

  // [加入測試集] — 建 GoldenCase（預填：最後一句 utterance + 當前判斷）
  const addGolden = useCallback(async () => {
    const last = [...turns].reverse().find((t) => t.result);
    if (!last?.result || !clinicId) return;
    const r = last.result;
    const idx = turns.findIndex((t) => t.key === last.key);
    const contextBefore = turns.slice(Math.max(0, idx - 2), idx).map((t) => t.message);
    const rfStep = r.steps.find((s) => s.n === 1);
    const docStep = r.steps.find((s) => s.n === 4);
    const priceDocId = typeof docStep?.detail.citedPriceDocId === "string" ? docStep.detail.citedPriceDocId : null;
    try {
      const res = await fetch("/api/golden-cases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clinicId,
          utterance: last.message,
          contextBefore,
          expectIntent: r.intent,
          expectRedFlag: rfStep?.detail.hit === true,
          expectAutoOk: r.sendVerdict.willAutoSend,
          expectDocIds: priceDocId ? [priceDocId] : [],
          note: `AI 沙盤加入（sandbox ${r.sandboxId.slice(0, 8)} turn ${r.turn}）`,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setGoldenMsg("已加入測試集（GoldenCase）");
    } catch (err) {
      setRunErr(`加入測試集失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [turns, clinicId]);

  const lastResult = [...turns].reverse().find((t) => t.result)?.result ?? null;

  // ── 渲染 ──
  const healthBad = (summary?.health ?? []).filter((h) => !h.ok);
  const swBad = swStale !== null;

  return (
    <div className="flex flex-col gap-5">
      {/* ── cwi-followup-p4 S6（MD §5.4）：tab 切換 — 病人嚟訊（七步） | 主動跟進（三步）── */}
      <div className="flex gap-1 border-b border-line" role="tablist" data-e2e="hub-tabs">
        <button
          role="tab"
          aria-selected={tab === "flow"}
          onClick={() => setTab("flow")}
          data-e2e="hub-tab-flow"
          className={`px-4 py-2 text-[13px] border-b-2 -mb-px font-medium ${
            tab === "flow" ? "border-brand text-t1" : "border-transparent text-t3 hover:text-t2"
          }`}
        >
          病人嚟訊（七步）
        </button>
        <button
          role="tab"
          aria-selected={tab === "followup"}
          onClick={() => setTab("followup")}
          data-e2e="hub-tab-followup"
          className={`px-4 py-2 text-[13px] border-b-2 -mb-px font-medium ${
            tab === "followup" ? "border-brand text-t1" : "border-transparent text-t3 hover:text-t2"
          }`}
        >
          主動跟進（三步）
        </button>
      </div>
      {tab === "followup" ? (
        <FollowupHubTab />
      ) : (
      <>
      {/* ── 頂部：系統健康列（B-4 — 紅底先顯示；全部正常 = 整列唔 render）── */}
      {(healthBad.length > 0 || swBad) && (
        <div className="flex flex-wrap gap-2" role="alert">
          {healthBad.map((h) => (
            <span key={h.id} className="px-3 py-1.5 rounded-full bg-danger-soft text-danger-text text-[12px] font-semibold border border-danger/20">
              ⚠ {HEALTH_LABEL[h.id] ?? h.id}：{h.reason}
            </span>
          ))}
          {swBad && (
            <span className="px-3 py-1.5 rounded-full bg-danger-soft text-danger-text text-[12px] font-semibold border border-danger/20">
              ⚠ SW 過舊（browser {swStale} / 現行 {summary?.swVersion}）
            </span>
          )}
        </div>
      )}

      {/* ── 上半：沙盤（B.3/B.5）── */}
      <section className="bg-panel border border-line rounded-3xl p-5">
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <h2 className="font-display text-[17px] text-t1">AI 沙盤</h2>
          <span className="text-[11px] text-t3">走真 pipeline 同款邏輯 · 零副作用（唔寫 DB / 唔發訊息 / 唔推通知）</span>
          {isAdmin && summary && summary.clinics.length > 0 && (
            <select
              value={clinicId}
              onChange={(e) => {
                setClinicId(e.target.value);
                void restart(); // 換店 = 新 sandbox（避免跨店 state 混合）
              }}
              className="ml-auto text-[12px] font-semibold bg-panel-2 border border-line rounded-full px-3 py-1.5 text-t1"
              aria-label="沙盤診所"
            >
              {summary.clinics.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}（{c.code}）
                </option>
              ))}
            </select>
          )}
          {isAdmin && sandboxId && (
            <button
              onClick={() => void restart()}
              className={`text-[12px] font-semibold rounded-full px-3 py-1.5 border ${isAdmin && summary?.clinics.length ? "ml-0" : "ml-auto"} bg-panel-2 border-line text-t2 hover:text-t1`}
            >
              重新開始
            </button>
          )}
        </div>

        {!isAdmin ? (
          <p className="text-[13px] text-t3">沙盤輸入區只限 ADMIN（你而家係 {role} 唯讀視圖 — 下面七步狀態照樣睇到）。</p>
        ) : (
          <div className="grid md:grid-cols-[1fr_250px] gap-4">
            {/* 左：對話 log + 輸入 */}
            <div className="flex flex-col min-w-0">
              <div ref={logRef} className="flex flex-col gap-3 max-h-[420px] overflow-y-auto rounded-2xl bg-panel-2/50 border border-line p-3">
                {turns.length === 0 && (
                  <div className="flex flex-col items-center gap-3 py-8 text-center">
                    <p className="text-[13px] text-t3">撳下面一句開始試（每療程一條 placeholder — 待核）：</p>
                    <div className="flex flex-wrap justify-center gap-2 max-w-[440px]">
                      {summary?.demoQuestions.map((q, i) => (
                        <button
                          key={i}
                          disabled={running}
                          onClick={() => void runTurn(q)}
                          className="text-[12px] px-3 py-1.5 rounded-full bg-brand-soft text-brand-text font-semibold border border-brand/15 hover:opacity-80 disabled:opacity-40"
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {turns.map((t) => (
                  <div key={t.key} className="flex flex-col gap-2">
                    {/* 病人句 */}
                    <div className="self-end max-w-[85%] bg-brand text-panel text-[13px] rounded-2xl rounded-br-md px-3.5 py-2.5">{t.message}</div>
                    {!t.result && !t.error && running && <div className="self-start text-[12px] text-t3">AI 處理緊…（真 LLM call）</div>}
                    {t.error && (
                      <div className="self-start text-[12px] text-danger-text bg-danger-soft rounded-2xl px-3 py-2">✗ {t.error}</div>
                    )}
                    {t.result && (
                      <div className="self-start w-full flex flex-col gap-1.5">
                        {/* 逐輪七步（✓/⏸/✗/— 各配一句摘要） */}
                        <div className="rounded-2xl bg-panel border border-line px-3.5 py-2.5 flex flex-col gap-1">
                          {t.result.steps.map((s) => {
                            const m = STATUS_META[s.status];
                            return (
                              <div key={s.n} className="flex items-start gap-2 text-[12px] leading-5">
                                <span className={`flex-none font-bold ${m.cls}`} aria-label={s.status}>
                                  {m.ch}
                                </span>
                                <span className="text-t3 flex-none w-[64px]">{s.name}</span>
                                <span className="text-t2 min-w-0 break-words">{s.summary}</span>
                              </div>
                            );
                          })}
                          <div className="text-[10.5px] text-t3 pt-1 border-t border-line mt-1">
                            {t.result.latencyMs}ms · {t.result.llmCalls} 次 LLM call · {t.result.sendVerdict.level}
                          </div>
                        </div>
                        {/* 沙盤草稿（OUT — 只係沙盤，未發） */}
                        {t.result.draft !== null ? (
                          <div className="bg-ok-soft border border-ok/15 rounded-2xl rounded-tl-md px-3.5 py-2.5 text-[13px] text-t1">
                            <div className="text-[10px] font-bold text-ok-text mb-1">沙盤草稿（未發）· {t.result.draftMode}</div>
                            {t.result.draft}
                          </div>
                        ) : (
                          <div className="text-[11.5px] text-t3 self-start">（本輪無草稿 — {t.result.steps.find((s) => s.n === 6)?.summary}）</div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* 輸入行 */}
              <div className="flex gap-2 mt-3">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) void runTurn(input);
                  }}
                  placeholder="以病人口吻講一句…（例：我想cool牙，幾錢？）"
                  disabled={running || !clinicId}
                  className="flex-1 text-[13px] bg-panel-2 border border-line rounded-full px-4 py-2.5 text-t1 placeholder:text-t3 disabled:opacity-50"
                  maxLength={4000}
                />
                <button
                  onClick={() => void runTurn(input)}
                  disabled={running || !input.trim() || !clinicId}
                  className="text-[13px] font-semibold bg-brand text-panel rounded-full px-5 py-2.5 disabled:opacity-40"
                >
                  {running ? "…" : "執行"}
                </button>
              </div>

              {/* 底部操作列（B.5） */}
              <div className="flex flex-wrap items-center gap-2 mt-2.5">
                <button
                  onClick={() => void addGolden()}
                  disabled={!lastResult}
                  className="text-[12px] font-semibold rounded-full px-3 py-1.5 border border-line bg-panel-2 text-t2 hover:text-t1 disabled:opacity-40"
                >
                  加入測試集
                </button>
                <button
                  onClick={() => {
                    if (!summary || summary.demoQuestions.length === 0) return;
                    const q = summary.demoQuestions[demoIdx % summary.demoQuestions.length];
                    setDemoIdx((i) => i + 1);
                    void runTurn(q);
                  }}
                  disabled={running || !summary || summary.demoQuestions.length === 0}
                  className="text-[12px] font-semibold rounded-full px-3 py-1.5 border border-line bg-panel-2 text-t2 hover:text-t1 disabled:opacity-40"
                >
                  再試下一句
                </button>
                {goldenMsg && <span className="text-[12px] text-ok-text font-semibold">{goldenMsg}</span>}
                {runErr && <span className="text-[12px] text-danger-text">{runErr}</span>}
              </div>
              {/* [再試下一句] 進度指示 */}
              {summary && summary.demoQuestions.length > 0 && turns.length > 0 && (
                <div className="text-[10.5px] text-t3 mt-1">
                  示範問題 {((demoIdx % summary.demoQuestions.length) + 1)}/{summary.demoQuestions.length}
                </div>
              )}
            </div>

            {/* 右：常駐 session 狀態卡（B.5） */}
            <SessionCard snap={lastResult?.sessionSnapshot ?? null} />
          </div>
        )}
      </section>

      {/* ── 下半：七步狀態列（B.2 — 摘要每次載入即時算）── */}
      <section className="bg-panel border border-line rounded-3xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-line flex items-center gap-3">
          <h2 className="font-display text-[15px] text-t1">流程七步現況</h2>
          <span className="text-[11px] text-t3">撳任何一行 → 跳對應設定頁</span>
          <button onClick={() => void loadSummary()} className="ml-auto text-[11.5px] font-semibold text-t3 hover:text-t1">
            重新載入
          </button>
        </div>
        {loadErr && (
          <div className="px-5 py-3 text-[12px] text-danger-text">
            載入失敗：{loadErr}
          </div>
        )}
        <div className="flex flex-col divide-y divide-line">
          {(summary?.steps ?? []).map((s) => (
            <a
              key={s.n}
              href={s.anchor}
              className="flex items-center gap-3 px-5 py-3 hover:bg-panel-2/60 transition-colors"
              title={s.anchor}
            >
              <span className="flex-none w-[26px] h-[26px] rounded-full bg-brand-soft text-brand-text grid place-items-center text-[12px] font-bold">
                {s.n}
              </span>
              <span className="flex-none w-[76px] text-[13px] font-semibold text-t1">{s.name}</span>
              <span className="text-[12.5px] text-t2 min-w-0 truncate">{s.summary}</span>
              {s.warnings.length > 0 && (
                <span
                  className="flex-none max-w-[320px] truncate px-2.5 py-1 rounded-full bg-warn-soft text-warn-text text-[11px] font-semibold border border-warn/20"
                  title={s.warnings.join("；")}
                >
                  ⚠ {s.warnings.join("；")}
                </span>
              )}
              <span className="ml-auto flex-none text-[11px] font-semibold text-brand-text">調較 →</span>
            </a>
          ))}
          {!summary && !loadErr && <div className="px-5 py-6 text-[12.5px] text-t3">載入中…</div>}
        </div>
      </section>
      </>
      )}
    </div>
  );
}

// ── 右側常駐 session 狀態卡（B.5）─────────────────────────────────────

function SessionCard({ snap }: { snap: SessionSnapshot | null }) {
  return (
    <aside className="rounded-2xl bg-panel-2/60 border border-line p-4 h-fit md:sticky md:top-4">
      <div className="text-[11px] font-bold tracking-wide text-t3 uppercase mb-2.5">Session 狀態</div>
      {!snap ? (
        <p className="text-[12px] text-t3 leading-5">無 consult session（未命中觸發詞 — 例如「cool牙/箍牙」會開 ortho CONSULT）</p>
      ) : (
        <div className="flex flex-col gap-2 text-[12px]">
          <Row k="workflow" v={snap.workflow} />
          <Row k="stage" v={`${snap.stage}${snap.terminal ? `（終止：${snap.terminal}）` : ""}`} />
          <Row k="turn" v={String(snap.turnCount)} />
          <Row k="purchaseIntent" v={snap.purchaseIntent.toFixed(3)} />
          <Row k="lastAction" v={snap.lastAction ?? "—"} />
          {snap.askedSlots.length > 0 && <Row k="askedSlots" v={snap.askedSlots.join("、")} />}
          <div className="mt-1 pt-2 border-t border-line">
            <div className="text-[10.5px] text-t3 mb-1">slots</div>
            {Object.keys(snap.slots).length === 0 ? (
              <span className="text-t3">（空）</span>
            ) : (
              <div className="flex flex-col gap-0.5">
                {Object.entries(snap.slots).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-2 text-[11.5px]">
                    <span className="text-t3">{k}</span>
                    <span className="text-t2 font-semibold text-right">{String(v)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-t3">{k}</span>
      <span className="text-t2 font-semibold text-right min-w-0 break-words">{v}</span>
    </div>
  );
}

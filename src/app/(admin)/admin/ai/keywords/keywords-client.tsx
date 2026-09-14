"use client";

import { useCallback, useEffect, useState } from "react";
import { LEXICON_DEFAULTS } from "@/lib/workflow/definitions";

/**
 * ★ cwi-hub-b-20260914（Part B B.4）：關鍵詞中心 client。
 *
 * 四來源交叉 view：一詞一行 + 右邊 chip（邊幾層用緊）：
 *   口語表（lexicon → canonical）/ 觸發詞 FLOOR（🔒 鎖定）+ 附加 / 路由規則 / 知識庫（唯讀）/ 紅旗附加（警示色）
 * 改/刪口語表 → 彈交叉警示（GET /impact 列受影響項目）→ 確認後行既有
 *   PUT /api/admin/workflows/lexicon（draft）+ POST .../publish（生效）— 唔另開 store。
 * 搜尋 = 單詞版沙盤（撳詞睇佢喺邊幾層生效）。
 */

interface KeywordRow {
  term: string;
  lexicon: { canonical: string; source: "default" | "global" | "clinic"; clinicId: string | null } | null;
  floorTrigger: string[];
  extraTrigger: string[];
  routing: { ruleId: string; ruleName: string; clinicId: string | null }[];
  knowledge: { docId: string; title: string; kind: string; clinicId: string | null }[];
  redFlagExtra: { category: string; clinicId: string | null }[];
}
interface KeywordView {
  rows: KeywordRow[];
  total: number;
  q: string | null;
  counts: { lexicon: number; floorTrigger: number; extraTrigger: number; routing: number; knowledge: number };
}
interface KeywordImpact {
  term: string;
  locked: { redFlagFloor: boolean; consultFloor: boolean };
  lexicon: { canonical: string; source: "global" | "clinic"; clinicId: string | null } | null;
  affected: {
    routingRules: { ruleId: string; ruleName: string; clinicId: string | null; matchedKeyword: string }[];
    knowledgeDocs: { docId: string; title: string; kind: string; clinicId: string | null; matchedKeyword: string }[];
    redFlagTerms: { category: string; source: "floor" | "extra"; clinicId: string | null }[];
    consultTriggerFloor: string[];
    extraTriggerClinics: string[];
  };
}

export default function KeywordsClient({ role }: { role: string }) {
  const isAdmin = role === "ADMIN";
  const [view, setView] = useState<KeywordView | null>(null);
  const [q, setQ] = useState("");
  const [input, setInput] = useState("");
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 編輯彈層（改 canonical / 刪詞）
  const [editRow, setEditRow] = useState<KeywordRow | null>(null);
  const [newCanonical, setNewCanonical] = useState("");
  const [mode, setMode] = useState<"edit" | "delete">("edit");
  const [impact, setImpact] = useState<KeywordImpact | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (query: string) => {
    setLoading(true);
    setLoadErr(null);
    try {
      const res = await fetch(`/api/admin/ai/keywords${query ? `?q=${encodeURIComponent(query)}` : ""}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setView((await res.json()) as KeywordView);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(q);
  }, [q, load]);

  const openEdit = useCallback(async (row: KeywordRow, m: "edit" | "delete") => {
    setEditRow(row);
    setMode(m);
    setNewCanonical(row.lexicon?.canonical ?? "");
    setImpact(null);
    setMsg(null);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/ai/keywords/impact?term=${encodeURIComponent(row.term)}`, { cache: "no-store" });
      if (res.ok) setImpact((await res.json()) as KeywordImpact);
    } catch {
      /* impact 失敗唔阻編輯 — 彈層顯示「影響分析載入失敗」 */
    }
  }, []);

  // 改/刪口語表 → 既有 workflows API（draft + publish）
  const saveLexicon = useCallback(async () => {
    if (!editRow?.lexicon) return;
    const targetClinicId = editRow.lexicon.clinicId; // 改邊個 row 就寫邊個（global/店）
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      // 1. 讀該 row 現行 entries（全量替換口徑 — 同 Workflow 頁一致）
      const wres = await fetch(`/api/admin/workflows${targetClinicId ? `?clinicId=${targetClinicId}` : ""}`, { cache: "no-store" });
      if (!wres.ok) throw new Error(`HTTP ${wres.status}`);
      const wdata = (await wres.json()) as { workflows: { key: string; active: { params?: { entries?: { term: string; canonical: string }[] } } }[] };
      const lexWf = wdata.workflows.find((w) => w.key === "lexicon");
      const current: { term: string; canonical: string }[] = lexWf?.active?.params?.entries?.map((e) => ({ term: e.term, canonical: e.canonical })) ?? [];
      // code 預設詞（source=default）：getLexicon 語義 — 一但有 global row，defaults 完全被取代（唔合併）。
      // 所以首次改預設詞 = 開 global row 時先把整份 defaults 搬入（避免偷走其餘預設詞）。
      const base = current.length === 0 && editRow.lexicon?.source === "default"
        ? LEXICON_DEFAULTS.entries.map((e) => ({ term: e.term, canonical: e.canonical }))
        : current;
      const next =
        mode === "delete"
          ? base.filter((e) => e.term !== editRow.term)
          : base.map((e) => (e.term === editRow.term ? { ...e, canonical: newCanonical.trim() } : e));
      if (next.length > 60) throw new Error("口語表超過 60 條上限");
      // 2. PUT draft（回 { id, version }）
      const pres = await fetch(`/api/admin/workflows/lexicon`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clinicId: targetClinicId, params: { entries: next } }),
      });
      if (!pres.ok) {
        const d = await pres.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error ?? `HTTP ${pres.status}`);
      }
      // 3. publish（生效）— publish 口徑 = { defId }（草稿 id，唔係 clinicId）
      const { id: draftId } = (await pres.json()) as { id: string };
      const bres = await fetch(`/api/admin/workflows/lexicon/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defId: draftId }),
      });
      if (!bres.ok) {
        const d = await bres.json().catch(() => ({}));
        throw new Error(`草稿已存但發佈失敗：${(d as { error?: string }).error ?? `HTTP ${bres.status}`}`);
      }
      setMsg(mode === "delete" ? `已刪除「${editRow.term}」並發佈` : `「${editRow.term}」→ ${newCanonical.trim()} 已發佈`);
      setEditRow(null);
      void load(q);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [editRow, mode, newCanonical, q, load]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-[18px] text-t1">關鍵詞中心</h1>
        <span className="text-[11.5px] text-t3">四來源交叉 — 一個詞用緊邊幾層一睇就看到</span>
        <div className="ml-auto flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                setQ(input.trim());
                void load(input.trim());
              }
            }}
            placeholder="搜詞（例：箍牙）— 單詞版沙盤"
            className="w-[240px] text-[12.5px] bg-panel-2 border border-line rounded-full px-4 py-2 text-t1 placeholder:text-t3"
          />
          <button
            onClick={() => {
              setQ(input.trim());
              void load(input.trim());
            }}
            className="text-[12.5px] font-semibold bg-brand text-panel rounded-full px-4 py-2"
          >
            搜尋
          </button>
        </div>
      </div>

      {view && (
        <div className="flex flex-wrap gap-2 text-[11.5px]">
          <Chip label="口語表" n={view.counts.lexicon} cls="bg-brand-soft text-brand-text" />
          <Chip label="觸發詞 FLOOR 🔒" n={view.counts.floorTrigger} cls="bg-line text-t2" />
          <Chip label="觸發詞 附加" n={view.counts.extraTrigger} cls="bg-line text-t2" />
          <Chip label="路由規則" n={view.counts.routing} cls="bg-ok-soft text-ok-text" />
          <Chip label="知識庫（唯讀）" n={view.counts.knowledge} cls="bg-warn-soft text-warn-text" />
          <span className="text-t3 self-center">共 {view.total} 詞</span>
        </div>
      )}

      <div className="bg-panel border border-line rounded-3xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-[10.5px] tracking-wide uppercase text-t3 border-b border-line">
                <th className="px-4 py-2.5 font-semibold">詞</th>
                <th className="px-4 py-2.5 font-semibold">邊幾層用緊（chip）</th>
                {isAdmin && <th className="px-4 py-2.5 font-semibold text-right">口語表</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {view?.rows.map((r) => (
                <tr key={r.term} className="hover:bg-panel-2/40">
                  <td className="px-4 py-2.5 font-semibold text-t1 whitespace-nowrap">{r.term}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1.5">
                      {r.lexicon && (
                        <span className="px-2 py-0.5 rounded-full bg-brand-soft text-brand-text text-[11px] font-semibold" title="口語表（lexicon）">
                          口語表 → {r.lexicon.canonical}（{r.lexicon.source === "global" ? "全局" : r.lexicon.source === "clinic" ? "店" : "code 預設"}）
                        </span>
                      )}
                      {r.floorTrigger.length > 0 && (
                        <span className="px-2 py-0.5 rounded-full bg-line text-t2 text-[11px] font-semibold" title="CONSULT_TRIGGER_FLOOR（code 常數 — 唔可刪）">
                          觸發 🔒 {r.floorTrigger.join("、")}
                        </span>
                      )}
                      {r.extraTrigger.length > 0 && (
                        <span className="px-2 py-0.5 rounded-full bg-line text-t2 text-[11px]" title="附加觸發詞（ConsultSetting advanced）">
                          觸發+ {r.extraTrigger.length} 店
                        </span>
                      )}
                      {r.routing.map((x) => (
                        <span key={x.ruleId} className="px-2 py-0.5 rounded-full bg-ok-soft text-ok-text text-[11px]" title={`RoutingRule ${x.clinicId ?? "global"}`}>
                          路由：{x.ruleName}
                        </span>
                      ))}
                      {r.knowledge.length > 0 && (
                        <span
                          className="px-2 py-0.5 rounded-full bg-warn-soft text-warn-text text-[11px]"
                          title={r.knowledge.map((k) => `${k.title}（${k.kind}）`).join("\n")}
                        >
                          知識庫 ×{r.knowledge.length}：{r.knowledge.slice(0, 2).map((k) => k.title).join("、")}
                          {r.knowledge.length > 2 ? "…" : ""}
                        </span>
                      )}
                      {r.redFlagExtra.length > 0 && (
                        <span className="px-2 py-0.5 rounded-full bg-danger-soft text-danger-text text-[11px] font-semibold" title="紅旗附加詞（pain-triage params）">
                          紅旗+（{[...new Set(r.redFlagExtra.map((x) => x.category))].join("、")}）
                        </span>
                      )}
                      {!r.lexicon && r.floorTrigger.length === 0 && r.extraTrigger.length === 0 && r.routing.length === 0 && r.knowledge.length === 0 && r.redFlagExtra.length === 0 && (
                        <span className="text-t3 text-[11px]">（浮詞 — 無層引用）</span>
                      )}
                    </div>
                  </td>
                  {isAdmin && (
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      {r.lexicon ? (
                        <span className="inline-flex gap-1.5">
                          <button onClick={() => void openEdit(r, "edit")} className="text-[11.5px] font-semibold text-brand-text hover:underline">
                            改
                          </button>
                          <button onClick={() => void openEdit(r, "delete")} className="text-[11.5px] font-semibold text-danger-text hover:underline">
                            刪
                          </button>
                        </span>
                      ) : (
                        <span className="text-t3 text-[11px]">—</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {view && view.rows.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-t3">
                    無匹配（{q ? `搜尋「${q}」` : "scope 內無詞"}）
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {loadErr && <div className="px-4 py-3 text-[12px] text-danger-text">載入失敗：{loadErr}</div>}
        {loading && <div className="px-4 py-2 text-[11.5px] text-t3">載入中…</div>}
      </div>

      {/* ── 改/刪口語表彈層（B.4 交叉警示）── */}
      {editRow && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-[520px] bg-panel border border-line rounded-3xl p-5 shadow-xl">
            <h3 className="font-display text-[15px] text-t1 mb-3">
              {mode === "edit" ? "改口語表" : "刪口語表詞"}：{editRow.term}
            </h3>
            {mode === "edit" && (
              <div className="flex items-center gap-2 mb-3">
                <span className="text-[12.5px] text-t3">canonical</span>
                <input
                  value={newCanonical}
                  onChange={(e) => setNewCanonical(e.target.value)}
                  className="flex-1 text-[13px] bg-panel-2 border border-line rounded-full px-3.5 py-2 text-t1"
                />
              </div>
            )}
            {mode === "delete" && <p className="text-[12.5px] text-t3 mb-3">刪咗之後，「{editRow.term}」唔會再 canonical 化（= 原字入 pipeline）。</p>}
            {editRow.lexicon?.source === "default" && (
              <p className="text-[12px] text-warn-text mb-3">
                ⚠ 呢個詞而家走緊 code 預設（DB 零 row）— 儲存會開 global 口語表（預設全表搬入 + 你嘅改動）；之後口語表改以 global row 為準。
              </p>
            )}

            {/* 交叉警示（B.4 — 受影響項目列） */}
            {impact ? (
              <div className="rounded-2xl bg-panel-2/60 border border-line p-3.5 mb-3 flex flex-col gap-2 text-[12px]">
                {(impact.locked.redFlagFloor || impact.locked.consultFloor) && (
                  <div className="text-danger-text font-semibold">
                    🔒 呢個詞係內建鎖定詞（{[impact.locked.redFlagFloor && "紅旗 FLOOR", impact.locked.consultFloor && "觸發 FLOOR"].filter(Boolean).join("、")}）— 改 canonical 會直接影響安全閘/觸發行為
                  </div>
                )}
                {impact.affected.routingRules.length > 0 && (
                  <div>
                    <b>路由規則（matchRule 雙比對會受影響）：</b>
                    <ul className="list-disc pl-4 text-t2">
                      {impact.affected.routingRules.map((x) => (
                        <li key={x.ruleId}>
                          {x.ruleName}（keyword「{x.matchedKeyword}」，{x.clinicId ? "店規則" : "全局規則"}）
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {impact.affected.knowledgeDocs.length > 0 && (
                  <div>
                    <b>知識庫 doc（RAG keyword 檢索會受影響）：</b>
                    <ul className="list-disc pl-4 text-t2">
                      {impact.affected.knowledgeDocs.map((x) => (
                        <li key={x.docId}>
                          {x.title}（{x.kind}，keyword「{x.matchedKeyword}」）
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {impact.affected.redFlagTerms.length > 0 && (
                  <div>
                    <b className="text-danger-text">紅旗詞（canonical 化後匹配 — 改動即影響安全閘 recall）：</b>
                    <ul className="list-disc pl-4 text-t2">
                      {impact.affected.redFlagTerms.map((x, i) => (
                        <li key={i}>
                          {x.category}（{x.source === "floor" ? "FLOOR 🔒" : "附加詞"}{x.clinicId ? "，店" : ""}）
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {impact.affected.consultTriggerFloor.length > 0 && (
                  <div>
                    <b>consult 觸發 FLOOR（{impact.affected.consultTriggerFloor.join("、")}）🔒 — 觸發口徑會受影響</b>
                  </div>
                )}
                {impact.affected.extraTriggerClinics.length > 0 && (
                  <div>
                    <b>附加觸發詞</b>（{impact.affected.extraTriggerClinics.length} 店行緊呢個詞）
                  </div>
                )}
                {impact.affected.routingRules.length === 0 &&
                  impact.affected.knowledgeDocs.length === 0 &&
                  impact.affected.redFlagTerms.length === 0 &&
                  impact.affected.consultTriggerFloor.length === 0 &&
                  impact.affected.extraTriggerClinics.length === 0 && <span className="text-t3">無其他層引用 — 改動只影響口語表本身。</span>}
              </div>
            ) : (
              <p className="text-[12px] text-t3 mb-3">影響分析載入中…（載唔到都可以先存，但建議等佢出）</p>
            )}

            {msg && <p className="text-[12px] text-ok-text font-semibold mb-3">{msg}</p>}
            {err && <p className="text-[12px] text-danger-text mb-3">{err}</p>}
            <div className="flex justify-end gap-2">
              <button onClick={() => setEditRow(null)} className="text-[12.5px] font-semibold rounded-full px-4 py-2 border border-line text-t2">
                取消
              </button>
              <button
                onClick={() => void saveLexicon()}
                disabled={busy || (mode === "edit" && !newCanonical.trim())}
                className="text-[12.5px] font-semibold rounded-full px-4 py-2 bg-brand text-panel disabled:opacity-40"
              >
                {busy ? "…" : mode === "edit" ? "儲存 + 發佈" : "確認刪除 + 發佈"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Chip({ label, n, cls }: { label: string; n: number; cls: string }) {
  return <span className={`px-2.5 py-1 rounded-full font-semibold ${cls}`}>{label} {n}</span>;
}

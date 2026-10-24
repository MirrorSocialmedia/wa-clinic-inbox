"use client";

/**
 * ★ cwi-consult-history-20261018（擁有人拍板）：診症及處方歷史
 *
 * 病歷要齊：CWM 直接逐頁問 Apricot（每頁 8 筆，新→舊；唔經到診索引 — walk-in／一年前都有）。
 * 最新 2 筆直接展開，其餘摺埋（撳先開）；〔載入更早記錄〕逐頁加。
 * 🔴 臨床全文：CWM 每頁回傳前 audit（EXTERNAL_CONSULTATIONS_VIEWED）；wa-inbox 唔存、唔寫 localStorage。
 */
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Pill } from "lucide-react";
import type { NoteText, PatientAdviceInfo } from "./types";
import { fmtDateShort } from "@/lib/patient-record-state";
import { WLoading } from "@/components/ui/w-loader";

export interface ConsultationItem {
  noteId: string;
  date: string;
  conTime: string | null;
  clinicCode: string | null;
  providerCode: string | null;
  providerName: string | null;
  isDraft: boolean;
  note: NoteText;
}

/** 最新幾筆直接展開 */
const AUTO_EXPAND = 2;

function firstLine(note: NoteText): string {
  const cands = note.kind === "STANDARD" ? [note.complaints, note.findings, note.diagnosis, note.actions] : note.blocks.map((b) => b.text);
  const raw = cands.find((t) => t && t.trim()) ?? "";
  const line = raw.split(/\r?\n/).map((x) => x.trim()).find(Boolean) ?? "";
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

/**
 * ★ cwi-advice-20261024：醫生建議句標黃 — 同 CWM findAdvice 同一口徑（換行／；／。切段；
 *   排除字成段唔計；觸發字前後唔係英文字母）。純顯示（唔存唔傳）。
 */
function adviceRe(kw: string): RegExp {
  const body = kw.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![a-z])${body}(?![a-z])`, "i");
}
export function HighlightAdvice({ text, advice }: { text: string; advice: PatientAdviceInfo | null }) {
  if (!advice || !advice.keywords.length || !text) return <>{text}</>;
  const res = advice.keywords.map(adviceRe);
  const exs = advice.excludeKeywords.map((x) => x.toLowerCase().replace(/\s+/g, " ").trim()).filter(Boolean);
  const parts = text.split(/([\n\r;；。]+)/);
  return (
    <>
      {parts.map((seg, i) => {
        if (i % 2 === 1 || !seg.trim()) return <span key={i}>{seg}</span>;
        const low = seg.toLowerCase().replace(/\s+/g, " ");
        const hit = !exs.some((x) => low.includes(x)) && res.some((r) => r.test(seg));
        return hit ? (
          <mark key={i} className="bg-warn-soft text-t1 rounded px-0.5" data-e2e="p2-advice-mark">
            {seg}
          </mark>
        ) : (
          <span key={i}>{seg}</span>
        );
      })}
    </>
  );
}

export function ConsultationHistory({
  conversationId,
  patientKey,
  advice = null,
}: {
  conversationId: string;
  patientKey: string;
  advice?: PatientAdviceInfo | null;
}) {
  const [items, setItems] = useState<ConsultationItem[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** 使用者手動開／收（覆蓋預設：頭 2 筆開） */
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const loadPage = useCallback(
    async (p: number) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/conversations/${conversationId}/patient-record/consultations?page=${p}`);
        if (!res.ok) throw new Error(res.status === 503 ? "Apricot 未接通 — 稍後再試" : "暫時攞唔到診症記錄 — 稍後再試");
        const j = (await res.json()) as { hasMore: boolean; consultations: ConsultationItem[] };
        setItems((prev) => (p === 0 ? j.consultations : [...prev, ...j.consultations.filter((c) => !prev.some((x) => x.noteId === c.noteId))]));
        setHasMore(j.hasMore);
        setPage(p);
        setLoaded(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "暫時攞唔到診症記錄");
      } finally {
        setLoading(false);
      }
    },
    [conversationId],
  );

  // 對話／目前病人一換 → 由第一頁重新攞
  useEffect(() => {
    setItems([]);
    setToggled({});
    setLoaded(false);
    setHasMore(false);
    void loadPage(0);
  }, [conversationId, patientKey, loadPage]);

  if (!loaded && loading) {
    return (
      <div className="flex justify-center py-8" data-e2e="p2-consult-loading">
        <WLoading size="inline" label="由 Apricot 攞診症記錄…" />
      </div>
    );
  }
  if (!loaded && error) {
    return (
      <div className="text-center py-8 text-[12px]" data-e2e="p2-consult-error">
        <div className="text-danger-text">{error}</div>
        <button type="button" onClick={() => void loadPage(0)} className="mt-2 px-2 py-0.5 rounded-md border border-line text-[11px] text-t2 hover:bg-panel-2">
          重試
        </button>
      </div>
    );
  }
  if (loaded && items.length === 0) {
    return (
      <div className="text-center py-10" data-e2e="p2-consult-empty">
        <Pill size={20} className="mx-auto mb-2 opacity-40 text-t3" />
        <div className="text-[12px] text-t2">Apricot 冇呢位病人嘅診症記錄</div>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-e2e="p2-consult-list">
      {items.map((c, i) => {
        const open = toggled[c.noteId] ?? i < AUTO_EXPAND;
        return (
          <div key={c.noteId} className="bg-panel border border-line rounded-xl p-2.5" data-e2e="p2-consult-card" data-open={open ? "1" : "0"}>
            <button
              type="button"
              onClick={() => setToggled((t) => ({ ...t, [c.noteId]: !open }))}
              className="w-full text-left"
              data-e2e="p2-consult-toggle"
            >
              <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
                <span className="font-medium text-t1">{c.date ? fmtDateShort(c.date) : "—"}</span>
                {c.clinicCode ? (
                  <>
                    <span className="text-t3">·</span>
                    <span className="text-t2">{c.clinicCode}</span>
                  </>
                ) : null}
                <span className="text-t3">·</span>
                <span className="text-t2">{c.providerName ?? c.providerCode ?? "—"}</span>
                {c.isDraft ? <span className="px-1.5 py-0.5 rounded text-[10px] bg-warn-soft text-warn-text">草稿</span> : null}
                {(() => {
                  // ★ cwi-advice-20261024：呢日診症已出醫生建議跟進 → 「已入待跟進」／「已跟進」
                  const t = advice?.tasks.find((x) => x.visitDate === c.date);
                  if (!t) return null;
                  const pending = t.status === "SUGGESTED";
                  return (
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] ${pending ? "bg-brand-soft text-brand-text" : "bg-panel-2 text-t2"}`}
                      data-e2e="p2-advice-chip"
                    >
                      {pending ? "已入待跟進" : "已跟進"}
                    </span>
                  );
                })()}
                {c.note.rx && c.note.rx.length > 0 ? (
                  <span className="inline-flex items-center gap-0.5 text-[10px] text-brand-text">
                    <Pill size={10} /> {c.note.rx.length}
                  </span>
                ) : null}
                <span className="ml-auto text-t3">{open ? <ChevronUp size={12} strokeWidth={2.75} /> : <ChevronDown size={12} strokeWidth={2.75} />}</span>
              </div>
              {!open ? <div className="mt-1 text-[12px] text-t1 truncate">{firstLine(c.note) || "（冇文字記錄）"}</div> : null}
            </button>
            {open ? (
              <div className="mt-2 border-t border-line pt-2">
                <NoteBody note={c.note} warn={false} advice={advice} />
              </div>
            ) : null}
          </div>
        );
      })}
      {error ? <div className="text-[11px] text-danger-text text-center">{error}</div> : null}
      {hasMore ? (
        <button
          type="button"
          disabled={loading}
          onClick={() => void loadPage(page + 1)}
          className="w-full py-1.5 rounded-lg border border-line text-[11px] text-t2 hover:bg-panel-2 disabled:opacity-60"
          data-e2e="p2-consult-more"
        >
          {loading ? "載入緊…" : "載入更早記錄"}
        </button>
      ) : null}
      <p className="text-[10px] text-t3 text-center" data-e2e="p2-note-warn">
        呢啲係醫生臨床記錄，請勿轉發
      </p>
    </div>
  );
}

/** 兩種樣板渲染（MD §0.3 — 自訂樣板 Tx 原文保留換行）。 */
export function NoteBody({ note, warn = true, advice = null }: { note: NoteText; warn?: boolean; advice?: PatientAdviceInfo | null }) {
  return (
    <div data-e2e="p2-note" data-kind={note.kind}>
      {note.kind === "STANDARD" ? (
        /* ★ cwi-walkin-20261018：Apricot 四欄（Complaints／Findings／Diagnosis／Actions）全部列出 — 空欄顯示「—」 */
        <dl className="space-y-1.5">
          {[
            ["主訴", note.complaints],
            ["檢查所見", note.findings],
            ["診斷", note.diagnosis],
            ["治療處理", note.actions],
          ].map(([label, text]) => (
            <div key={label} className="text-[12px]">
              <dt className="text-t3">{label}</dt>
              <dd className={`whitespace-pre-wrap ${text?.trim() ? "text-t1" : "text-t3"}`}>{text?.trim() ? <HighlightAdvice text={text} advice={advice} /> : "—"}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="space-y-1.5">
          {note.templateName ? <div className="text-[10px] text-t3">樣板：{note.templateName}</div> : null}
          {note.blocks.map((b, i) => (
            <div key={i} className="text-[12px]">
              <span className="text-t3">{b.label}：</span>
              <span className="text-t1 whitespace-pre-wrap"><HighlightAdvice text={b.text} advice={advice} /></span>
            </div>
          ))}
        </div>
      )}
      {/* ★ cwi-walkin-20261018：處方（Prescription）— 冇處方都講明 */}
      <div className="mt-2 pt-1.5 border-t border-line" data-e2e="p2-note-rx">
        <div className="text-[12px] text-t3">處方</div>
        {note.rx && note.rx.length > 0 ? (
          <ul className="mt-0.5 space-y-0.5">
            {note.rx.map((r, i) => (
              <li key={i} className="text-[12px] flex gap-1.5">
                <Pill size={12} className="text-brand-text shrink-0 mt-0.5" />
                <span>
                  <span className="text-t1">{r.name}</span>
                  {r.detail ? <span className="block text-[11px] text-t2">{r.detail}</span> : null}
                  {r.caution ? <span className="block text-[11px] text-warn-text">⚠ {r.caution}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-[12px] text-t3">—（冇處方）</div>
        )}
      </div>
      {warn ? <p className="mt-2 text-[10px] text-t3" data-e2e="p2-note-warn">
        呢啲係醫生臨床記錄，請勿轉發
      </p> : null}
    </div>
  );
}



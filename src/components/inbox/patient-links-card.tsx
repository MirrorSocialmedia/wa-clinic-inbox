"use client";

/**
 * ★ cwi-multi-patient-20261018（擁有人拍板）：「此電話嘅病人」— 一個 WhatsApp 號碼連幾個病人檔
 * （本人／年老父母／子女共用一個電話聯絡）。
 *
 * - 已加入病人：關係（本人／父母／子女…）、〔設為目前〕（= 釘住；病人記錄／代落單跟佢）、〔移除〕
 * - 電話配對（未加入）：Apricot 用呢個電話搵到嘅病人檔 → 〔加入〕
 * - 〔＋ 加入病人〕：搜編號／姓名／電話（全部 Apricot 帳號）→ 〔加入〕／〔加入並設為目前〕
 * 權限：所有員工（擁有人拍板）— server 端 assertCanWriteConversation；搜尋結果 server 記低先准加入。
 */
import { useCallback, useEffect, useState } from "react";
import { Search, UserPlus, X } from "lucide-react";
import type { PatientMatch } from "./types";

const RELATIONS: { v: string; label: string }[] = [
  { v: "", label: "關係（未填）" },
  { v: "SELF", label: "本人" },
  { v: "PARENT", label: "父母" },
  { v: "CHILD", label: "子女" },
  { v: "SPOUSE", label: "配偶" },
  { v: "SIBLING", label: "兄弟姊妹" },
  { v: "OTHER", label: "其他" },
];

interface Link {
  patientApricotId: string;
  patientCode: string | null;
  patientName: string | null;
  relation: string | null;
  source: string;
}
interface Hit {
  patientApricotId: string;
  patientCode: string;
  patientName: string;
  clinicLabel: string;
  linked: boolean;
}

export function PatientLinksCard({
  conversationId,
  activePatientApricotId,
  phoneMatches,
  onChanged,
}: {
  conversationId: string;
  activePatientApricotId: string | null;
  /** 電話配對（patient-context matches）— 未加入嘅顯示〔加入〕 */
  phoneMatches: PatientMatch[] | null;
  /** 加入／設為目前／移除之後 — parent 重拉 patient-context */
  onChanged: () => void;
}) {
  const [links, setLinks] = useState<Link[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [newRelation, setNewRelation] = useState("");

  const loadLinks = useCallback(async () => {
    try {
      const res = await fetch(`/api/conversations/${conversationId}/patient-links`);
      if (res.ok) setLinks(((await res.json()) as { links: Link[] }).links);
    } catch {
      /* 下次重拉 */
    }
  }, [conversationId]);

  useEffect(() => {
    setLinks(null);
    setHits(null);
    setQ("");
    setSearchOpen(false);
    setError(null);
    void loadLinks();
  }, [conversationId, loadLinks]);
  // 釘住（舊卡〔釘住〕／其他 staff）都會自動加入連結 → 目前病人一變就重拉
  useEffect(() => {
    void loadLinks();
  }, [activePatientApricotId, loadLinks]);

  async function call(key: string, url: string, init: RequestInit): Promise<boolean> {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `HTTP ${res.status}`);
      }
      await loadLinks();
      onChanged();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  const add = (patientApricotId: string, setActive: boolean) =>
    call(`add:${patientApricotId}`, `/api/conversations/${conversationId}/patient-links`, {
      method: "POST",
      body: JSON.stringify({ patientApricotId, relation: newRelation || null, setActive }),
    }).then((ok) => {
      if (ok) setHits((h) => h?.map((x) => (x.patientApricotId === patientApricotId ? { ...x, linked: true } : x)) ?? null);
    });
  const setActive = (patientApricotId: string) =>
    call(`active:${patientApricotId}`, `/api/conversations/${conversationId}/patient-links`, {
      method: "POST",
      body: JSON.stringify({ patientApricotId, setActive: true }),
    });
  const setRelation = (patientApricotId: string, relation: string) =>
    call(`rel:${patientApricotId}`, `/api/conversations/${conversationId}/patient-links/${encodeURIComponent(patientApricotId)}`, {
      method: "PATCH",
      body: JSON.stringify({ relation: relation || null }),
    });
  const remove = (l: Link) => {
    if (!window.confirm(`由呢個電話移除「${l.patientName ?? l.patientCode ?? "病人"}」？（Apricot 病人檔唔受影響）`)) return;
    void call(`rm:${l.patientApricotId}`, `/api/conversations/${conversationId}/patient-links/${encodeURIComponent(l.patientApricotId)}`, {
      method: "DELETE",
    });
  };

  async function runSearch() {
    const term = q.trim();
    if (term.length < 2) {
      setError("請輸入最少 2 個字（編號／姓名／電話）");
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/patient-search?q=${encodeURIComponent(term)}`);
      const j = (await res.json().catch(() => null)) as { patients?: Hit[]; error?: string } | null;
      if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`);
      setHits(j?.patients ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  }

  const linkedIds = new Set((links ?? []).map((l) => l.patientApricotId));
  const unlinkedMatches = (phoneMatches ?? []).filter((m) => !linkedIds.has(m.patientApricotId));

  return (
    <div className="rounded-[18px] bg-panel border border-line p-3 text-xs space-y-2 mb-2" data-e2e="patient-links-card">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] text-t3">此電話嘅病人{links && links.length > 1 ? `（${links.length} 位）` : ""}</div>
        <button
          type="button"
          onClick={() => setSearchOpen((v) => !v)}
          className="inline-flex items-center gap-1 text-[11px] text-brand hover:underline"
          data-e2e="patient-links-add"
        >
          {searchOpen ? <X size={12} /> : <UserPlus size={12} />} {searchOpen ? "收埋" : "加入病人"}
        </button>
      </div>
      {error && <div className="text-[10px] text-danger-text">⚠ {error}</div>}

      {links === null ? (
        <div className="text-[11px] text-t3">載入緊…</div>
      ) : links.length === 0 ? (
        <div className="text-[11px] text-t3">未加入病人 — 由下面電話配對加入，或者撳〔加入病人〕搜編號／姓名／電話</div>
      ) : (
        <div className="space-y-1.5">
          {links.map((l) => {
            const active = l.patientApricotId === activePatientApricotId;
            return (
              <div
                key={l.patientApricotId}
                className={`rounded-xl border px-2 py-1.5 ${active ? "border-brand bg-brand-soft/40" : "border-line"}`}
                data-e2e="patient-link-row"
                data-active={active ? "1" : "0"}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-t1 font-medium truncate">
                      {l.patientName ?? "—"}
                      {active && <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-[9px] bg-brand text-panel align-middle">目前</span>}
                    </div>
                    <div className="text-[10px] text-t3 truncate">{l.patientCode ?? "—"}</div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {!active && (
                      <button
                        type="button"
                        onClick={() => void setActive(l.patientApricotId)}
                        disabled={busy !== null}
                        className="text-[10px] px-2 py-0.5 rounded-full bg-brand hover:bg-brand-hover text-panel disabled:opacity-50"
                      >
                        {busy === `active:${l.patientApricotId}` ? "設定中…" : "設為目前"}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => remove(l)}
                      disabled={busy !== null}
                      title="由呢個電話移除"
                      className="text-[10px] px-1.5 py-0.5 rounded-full text-t3 hover:text-danger-text disabled:opacity-50"
                    >
                      移除
                    </button>
                  </div>
                </div>
                <select
                  value={l.relation ?? ""}
                  onChange={(e) => void setRelation(l.patientApricotId, e.target.value)}
                  disabled={busy !== null}
                  className="mt-1 text-[10px] bg-panel-2 border border-line rounded-md px-1 py-0.5 text-t2"
                  aria-label="同 WhatsApp 用戶嘅關係"
                >
                  {RELATIONS.map((r) => (
                    <option key={r.v} value={r.v}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      )}

      {unlinkedMatches.length > 0 && (
        <div className="space-y-1 pt-1 border-t border-line">
          <div className="text-[10px] text-t3">電話配對（未加入）</div>
          {unlinkedMatches.map((m) => (
            <div key={m.patientApricotId} className="flex items-center justify-between gap-2">
              <div className="min-w-0 text-[11px] text-t1 truncate">{m.patientName}</div>
              <button
                type="button"
                onClick={() => void add(m.patientApricotId, false)}
                disabled={busy !== null}
                className="shrink-0 text-[10px] px-2 py-0.5 rounded-full border border-line text-t1 hover:bg-panel-2 disabled:opacity-50"
              >
                {busy === `add:${m.patientApricotId}` ? "加入中…" : "加入"}
              </button>
            </div>
          ))}
        </div>
      )}

      {searchOpen && (
        <div className="space-y-1.5 pt-1 border-t border-line" data-e2e="patient-links-search">
          <div className="flex gap-1">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runSearch();
              }}
              placeholder="病人編號／姓名／電話"
              className="flex-1 min-w-0 text-[11px] bg-panel-2 border border-line rounded-lg px-2 py-1"
              data-e2e="patient-links-q"
            />
            <button
              type="button"
              onClick={() => void runSearch()}
              disabled={searching}
              className="shrink-0 inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-brand text-panel disabled:opacity-50"
            >
              <Search size={11} /> {searching ? "搜緊…" : "搜尋"}
            </button>
          </div>
          <select
            value={newRelation}
            onChange={(e) => setNewRelation(e.target.value)}
            className="text-[10px] bg-panel-2 border border-line rounded-md px-1 py-0.5 text-t2"
            aria-label="新加入病人嘅關係"
          >
            {RELATIONS.map((r) => (
              <option key={r.v} value={r.v}>
                {r.v ? `加入做：${r.label}` : "關係（加入時填，可留空）"}
              </option>
            ))}
          </select>
          {hits !== null &&
            (hits.length === 0 ? (
              <div className="text-[11px] text-t3">搵唔到 — 試下完整編號或者另一個寫法</div>
            ) : (
              hits.map((h) => (
                <div key={h.patientApricotId} className="flex items-center justify-between gap-2" data-e2e="patient-links-hit">
                  <div className="min-w-0">
                    <div className="text-[11px] text-t1 truncate">{h.patientName}</div>
                    <div className="text-[10px] text-t3 truncate">
                      {h.patientCode} · {h.clinicLabel}
                    </div>
                  </div>
                  {h.linked ? (
                    <span className="shrink-0 text-[10px] text-ok-text">已加入</span>
                  ) : (
                    <div className="flex gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => void add(h.patientApricotId, false)}
                        disabled={busy !== null}
                        className="text-[10px] px-2 py-0.5 rounded-full border border-line text-t1 hover:bg-panel-2 disabled:opacity-50"
                      >
                        加入
                      </button>
                      <button
                        type="button"
                        onClick={() => void add(h.patientApricotId, true)}
                        disabled={busy !== null}
                        className="text-[10px] px-2 py-0.5 rounded-full bg-brand text-panel disabled:opacity-50"
                      >
                        {busy === `add:${h.patientApricotId}` ? "…" : "加入並設為目前"}
                      </button>
                    </div>
                  )}
                </div>
              ))
            ))}
        </div>
      )}
    </div>
  );
}

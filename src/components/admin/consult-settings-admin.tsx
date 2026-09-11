"use client";

/**
 * ★ consult v2.1 C5（MD §8.1）：AI 傾偈設定 — 三 tab（方案資料 ｜ AI 會點傾 ｜ 進階）。
 *
 * 鐵律（MD §8.0）：
 *   - 畫面禁詞：slot/stage/rule/positioning/candidate/workflow/action/code 名（ORTHO-001 等）
 *   - 問句式標籤 + 💡 灰色提示；全部預填 §7 seed（醫生只審核／微調）
 *   - 儲存 = 即時（無「儲存」掣兩層）→ toast「已更新 · AI 下一次回覆即刻生效」
 *
 * Tab 1 方案資料：療程切換 + 診所範圍 + 未簽署 badge + 方案 chip（✓/⚠）+ 五格表單
 *   （植牙 +4 格）+ positioning 自動同步（唔入表單）+ 簽署列 + 即時預覽區（真 pipeline，
 *   唔存 session／唔發送／唔計 usage — POST /api/admin/consult/preview）。
 * Tab 2 AI 會點傾：白話規則行（開關/🔒）+ 發現問題兩條（可改+開關+拖序）+ 問預算（預設關）。
 * Tab 3 進階：細字入口（唔係大 tab），ADMIN 先見到 — maxTurns/ctaAfterTurns/sessionIdleHours/
 *   觸發詞（FLOOR 灰鎖+附加）/意向分數/claim-guard 唯讀八條。
 *
 * SUPERVISOR：見 Tab 1/2 但寫入 403（API requireAdmin 底線；UI 顯示提示）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, GripVertical, Lock, Plus, RefreshCw, X } from "lucide-react";
import {
  CONSULT_RULE_ROWS,
  DEFAULT_DISCOVERY_QUESTIONS,
  CONSULT_SETTING_DEFAULTS,
  type RulesValue,
  type DiscoveryValue,
  type AdvancedValue,
} from "@/lib/sessions/consult-settings";
import { CONSULT_TRIGGER_FLOOR } from "@/lib/sessions/consult-trigger";

type Workflow = "ORTHODONTIC_CONSULT" | "IMPLANT_CONSULT";

interface ProductRow {
  id: string;
  clinicId: string | null;
  workflow: string;
  code: string;
  displayName: string;
  brand: string | null;
  model: string | null;
  material: string | null;
  surface: string | null;
  approvedWording: string;
  timeWording: string | null;
  warrantyNote: string | null;
  avoidPhrases: string[];
  priceDocTitle: string | null;
  enabled: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
}

interface PriceDoc {
  id: string;
  title: string;
  priceMin: number | null;
  priceMax: number | null;
}

interface PreviewResult {
  draft: string;
  blocked: boolean;
  cgCode: string | null;
  cgCodes: string[];
  checks: { label: string; pass: boolean; reason: string | null }[];
  usableProducts: number;
  unapprovedCount: number;
  mock: boolean;
  demoQuestion: string;
}

interface SettingsState {
  rules: RulesValue;
  discovery: DiscoveryValue;
  advanced: AdvancedValue;
}

const DEMO_QUESTIONS: Record<Workflow, string> = {
  ORTHODONTIC_CONSULT: "我想箍牙，唔想俾人見到，又想快啲",
  IMPLANT_CONSULT: "我想做植牙，想多了解下",
};

/** Tab 3 claim-guard 唯讀八條（白話；code 只入 tooltip 供 trace 對照 — 畫面禁詞鐵律）。 */
const CG_READONLY_ROWS: { code: string; label: string }[] = [
  { code: "CG-001", label: "唔做醫療診斷（唔會講「你係蛀牙」呢類）" },
  { code: "CG-002", label: "唔做保證（唔會講「一定」「保證」）" },
  { code: "CG-003", label: "未評估唔俾個人化建議（唔會答「邊款最適合你」）" },
  { code: "CG-004", label: "唔講冇根據嘅療程時間" },
  { code: "CG-005", label: "唔講成功率／百分數" },
  { code: "CG-006", label: "唔贬低其他品牌" },
  { code: "CG-008", label: "唔杜撰具體日期時段" },
  { code: "CG-009", label: "「唔准講嘅嘢」逐句攔截" },
];

const INTENT_SCORE_ROWS: { label: string; delta: string }[] = [
  { label: "講「約」「幾時有位」呢類", delta: "+0.4" },
  { label: "講「決定咗」「做下啦」呢類", delta: "+0.4" },
  { label: "問價（第一次）", delta: "+0.1" },
  { label: "問價（再問）", delta: "+0.15" },
  { label: "講貴 / 預算敏感", delta: "−0.1" },
  { label: "猶豫（「諗下」「唔確定」）", delta: "−0.2" },
];

function fmtPriceRange(min: number | null, max: number | null): string {
  if (min == null && max == null) return "";
  if (min != null && max != null) return `$${min.toLocaleString()} – $${max.toLocaleString()}`;
  return `$${(min ?? max)!.toLocaleString()} 起`;
}

export default function ConsultSettingsAdmin({ role }: { role: "ADMIN" | "SUPERVISOR" }) {
  const canWrite = role === "ADMIN";
  const [workflow, setWorkflow] = useState<Workflow>("ORTHODONTIC_CONSULT");
  const [scope, setScope] = useState<string>("global"); // "global" | clinicId
  const [tab, setTab] = useState<"products" | "rules" | "advanced">("products");

  const [clinics, setClinics] = useState<{ id: string; code: string; name: string }[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [priceDocs, setPriceDocs] = useState<PriceDoc[]>([]);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [approveName, setApproveName] = useState("");
  const [newPhrase, setNewPhrase] = useState("");
  const [newWord, setNewWord] = useState("");

  // form（selected product 嘅 editable 欄）
  const [form, setForm] = useState<{
    displayName: string;
    approvedWording: string;
    timeWording: string;
    avoidPhrases: string[];
    priceDocTitle: string;
    model: string;
    material: string;
    surface: string;
    warrantyNote: string;
  } | null>(null);

  const toastTimer = useRef<number | null>(null);
  const saveTimer = useRef<number | null>(null);
  const formRef = useRef<typeof form>(null);
  const productsRef = useRef(products);
  productsRef.current = products;

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const scopeClinicId = scope === "global" ? null : scope;

  // ── loaders ─────────────────────────────────────────────────────────

  const loadProducts = useCallback(async () => {
    const qs = new URLSearchParams({ workflow });
    if (scopeClinicId) qs.set("clinicId", scopeClinicId);
    try {
      const res = await fetch(`/api/admin/consult-products?${qs.toString()}`);
      if (!res.ok) return;
      const j = (await res.json()) as { products: ProductRow[] };
      // 範圍過濾：global = 全局行；店 = 該店行（shop 範圍唔混入全局行）
      const rows = j.products.filter((p) => (scope === "global" ? p.clinicId === null : p.clinicId === scope));
      setProducts(rows);
      setSelectedId((prev) => (prev && rows.some((p) => p.id === prev) ? prev : rows[0]?.id ?? null));
    } catch {
      /* fail-soft */
    }
  }, [workflow, scope, scopeClinicId]);

  const loadPriceDocs = useCallback(async () => {
    const qs = new URLSearchParams();
    if (scopeClinicId) qs.set("clinicId", scopeClinicId);
    try {
      const res = await fetch(`/api/admin/knowledge?${qs.toString()}`);
      if (!res.ok) return;
      const j = (await res.json()) as { docs: (PriceDoc & { kind: string; enabled: boolean })[] };
      setPriceDocs(j.docs.filter((d) => d.kind === "PRICE" && d.enabled));
    } catch {
      /* fail-soft */
    }
  }, [scopeClinicId]);

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/consult-settings?clinicId=${scopeClinicId ?? ""}`);
      if (!res.ok) return;
      const j = (await res.json()) as { effective: SettingsState };
      setSettings({
        rules: j.effective.rules,
        discovery: j.effective.discovery,
        advanced: j.effective.advanced,
      });
    } catch {
      /* fail-soft — UI 顯示 default */
    }
  }, [scopeClinicId]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/admin/clinics");
        if (res.ok) {
          const j = (await res.json()) as { id: string; code: string; name: string }[];
          setClinics(j.map((c) => ({ id: c.id, code: c.code, name: c.name })));
        }
      } catch {
        /* fail-soft */
      }
    })();
  }, []);

  useEffect(() => {
    void loadProducts();
  }, [loadProducts]);
  useEffect(() => {
    void loadPriceDocs();
  }, [loadPriceDocs]);
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // form sync（selected product 變 → 填入；§7 seed 預填 = 產品本身嘅值）
  const selected = products.find((p) => p.id === selectedId) ?? null;
  useEffect(() => {
    if (!selected) {
      setForm(null);
      return;
    }
    setForm({
      displayName: selected.displayName,
      approvedWording: selected.approvedWording,
      timeWording: selected.timeWording ?? "",
      avoidPhrases: [...selected.avoidPhrases],
      priceDocTitle: selected.priceDocTitle ?? "",
      model: selected.model ?? "",
      material: selected.material ?? "",
      surface: selected.surface ?? "",
      warrantyNote: selected.warrantyNote ?? "",
    });
    formRef.current = null;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
  }, [selectedId, workflow, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 即時預覽（真 pipeline — 唔存 session／唔發送／唔計 usage） ──────────

  const runPreview = useCallback(async () => {
    setPreviewLoading(true);
    try {
      const res = await fetch("/api/admin/consult/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow, clinicId: scopeClinicId }),
      });
      const j = (await res.json().catch(() => null)) as (PreviewResult & { error?: string }) | null;
      if (res.ok && j && !j.error) setPreview(j);
      else setPreview(null);
    } catch {
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }, [workflow, scopeClinicId]);

  useEffect(() => {
    void runPreview();
  }, [runPreview]);

  // ── Tab 1 表單：改動 → 即時 PUT（debounce 600ms）+ toast ──────────────

  const flushProductSave = useCallback(
    (f: NonNullable<typeof formRef.current>, pid: string) => {
      const cur = productsRef.current.find((p) => p.id === pid);
      if (!cur) return;
      const payload: Record<string, unknown> = {};
      if (f.displayName.trim() && f.displayName !== cur.displayName) payload.displayName = f.displayName.trim();
      if (f.approvedWording.trim() && f.approvedWording !== cur.approvedWording) payload.approvedWording = f.approvedWording.trim();
      if ((f.timeWording || null) !== (cur.timeWording ?? null)) payload.timeWording = f.timeWording.trim() || null;
      if (JSON.stringify(f.avoidPhrases) !== JSON.stringify(cur.avoidPhrases)) payload.avoidPhrases = f.avoidPhrases;
      if ((f.priceDocTitle || null) !== (cur.priceDocTitle ?? null)) payload.priceDocTitle = f.priceDocTitle || null;
      if (workflow === "IMPLANT_CONSULT") {
        if ((f.model || null) !== (cur.model ?? null)) payload.model = f.model.trim() || null;
        if ((f.material || null) !== (cur.material ?? null)) payload.material = f.material.trim() || null;
        if ((f.surface || null) !== (cur.surface ?? null)) payload.surface = f.surface.trim() || null;
        if ((f.warrantyNote || null) !== (cur.warrantyNote ?? null)) payload.warrantyNote = f.warrantyNote.trim() || null;
      }
      if (Object.keys(payload).length === 0) return;
      void (async () => {
        const res = await fetch(`/api/admin/consult-products/${pid}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          showToast("已更新 · AI 下一次回覆即刻生效");
          void loadProducts();
          void runPreview();
        } else {
          const j = (await res.json().catch(() => null)) as { message?: string } | null;
          showToast(`更新失敗：${j?.message ?? res.status}`);
        }
      })();
    },
    [showToast, loadProducts, runPreview, workflow]
  );

  const updateForm = useCallback(
    (patch: Partial<NonNullable<typeof form>>) => {
      setForm((prev) => {
        if (!prev) return prev;
        const next = { ...prev, ...patch };
        formRef.current = next;
        if (saveTimer.current) window.clearTimeout(saveTimer.current);
        const pid = selectedId;
        if (pid) saveTimer.current = window.setTimeout(() => flushProductSave(next, pid), 600);
        return next;
      });
    },
    [selectedId, flushProductSave]
  );

  // ── 簽署 ────────────────────────────────────────────────────────────

  const doApprove = useCallback(async () => {
    if (!selected) return;
    const res = await fetch(`/api/admin/consult-products/${selected.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvedBy: approveName.trim() || "診所管理員" }),
    });
    if (res.ok) {
      showToast("已確認 · AI 即刻可以用呢個方案");
      void loadProducts();
      void runPreview();
    } else {
      const j = (await res.json().catch(() => null)) as { message?: string } | null;
      showToast(`確認失敗：${j?.message ?? res.status}`);
    }
  }, [selected, approveName, showToast, loadProducts, runPreview]);

  const doCreateProduct = useCallback(async () => {
    const code = `CUSTOM-${Date.now().toString(36).toUpperCase().slice(-6)}`;
    const res = await fetch("/api/admin/consult-products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clinicId: scopeClinicId,
        workflow,
        code,
        displayName: workflow === "IMPLANT_CONSULT" ? "新植牙方案" : "新箍牙方案",
        category: workflow === "IMPLANT_CONSULT" ? "IMPLANT" : "CLEAR_ALIGNER",
        positioning: "（待填寫）",
        approvedWording: "（待填寫）",
        avoidPhrases: [],
      }),
    });
    if (res.ok) {
      const j = (await res.json()) as { id?: string };
      void loadProducts();
      if (j.id) setSelectedId(j.id);
      showToast("已新增方案 · 填完內容要醫生確認");
    }
  }, [scopeClinicId, workflow, loadProducts, showToast]);

  // ── Tab 2/3 settings 寫入（即時 PUT + toast） ─────────────────────────

  const saveSetting = useCallback(
    async (key: "rules" | "discovery" | "advanced", value: unknown) => {
      const res = await fetch("/api/admin/consult-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clinicId: scopeClinicId, key, value }),
      });
      if (res.ok) {
        const j = (await res.json()) as { effective: SettingsState };
        setSettings((prev) => (prev ? { ...prev, [key]: j.effective[key] } : prev));
        showToast("已更新 · AI 下一次回覆即刻生效");
      } else {
        const j = (await res.json().catch(() => null)) as { message?: string } | null;
        showToast(`更新失敗：${j?.message ?? res.status}`);
      }
    },
    [scopeClinicId, showToast]
  );

  const s: SettingsState = settings ?? {
    rules: { ...CONSULT_SETTING_DEFAULTS.rules } as RulesValue,
    discovery: { questions: DEFAULT_DISCOVERY_QUESTIONS.map((q) => ({ ...q })), askBudget: false },
    advanced: { ...CONSULT_SETTING_DEFAULTS.advanced, extraTriggerWords: [] } as AdvancedValue,
  };

  const toggleRule = (key: string | null, next: boolean) => {
    if (!key) return;
    void saveSetting("rules", { ...s.rules, [key]: next } as RulesValue);
  };

  const setQuestion = (idx: number, patch: Partial<{ text: string; enabled: boolean }>) => {
    const questions = s.discovery.questions.map((q, i) => (i === idx ? { ...q, ...patch } : q));
    void saveSetting("discovery", { ...s.discovery, questions } as DiscoveryValue);
  };

  const reorderQuestions = (from: number, to: number) => {
    const questions = [...s.discovery.questions];
    const [m] = questions.splice(from, 1);
    questions.splice(to, 0, m);
    void saveSetting("discovery", { ...s.discovery, questions } as DiscoveryValue);
  };

  const setAdvanced = (patch: Partial<AdvancedValue>) => {
    void saveSetting("advanced", { ...s.advanced, ...patch });
  };

  const unapprovedCount = products.filter((p) => p.approvedAt === null).length;
  const isImplant = workflow === "IMPLANT_CONSULT";

  // ── render ──────────────────────────────────────────────────────────

  return (
    <div className="p-5 max-w-[1100px] mx-auto space-y-4" data-testid="c5-root">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-display font-semibold text-t1">AI 傾偈設定</h1>
        {unapprovedCount > 0 && (
          <div className="text-[11px] bg-warn-soft text-warn-text rounded-full px-2.5 py-1" title="有方案未由醫生確認 — AI 唔會同病人提起">
            ⚠ {unapprovedCount} 個方案未確認
          </div>
        )}
      </div>

      {/* 頂部控制：療程切換 + 診所範圍 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-full border border-line bg-panel p-0.5">
          {(
            [
              { key: "ORTHODONTIC_CONSULT", label: "箍牙" },
              { key: "IMPLANT_CONSULT", label: "植牙" },
            ] as { key: Workflow; label: string }[]
          ).map((t) => (
            <button
              key={t.key}
              onClick={() => setWorkflow(t.key)}
              className={`px-3.5 py-1.5 rounded-full text-xs font-medium transition-colors ${
                workflow === t.key ? "bg-brand text-panel" : "text-t2 hover:text-t1"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          className="text-xs rounded-full border border-line bg-panel px-3 py-2 text-t1 focus:outline-none"
        >
          <option value="global">全部診所通用</option>
          {clinics.map((c) => (
            <option key={c.id} value={c.id}>
              只限 {c.name}
            </option>
          ))}
        </select>
        {/* tab 列（進階 = 右邊細字連結，ADMIN 先見到） */}
        <div className="ml-auto flex items-center gap-3">
          {(
            [
              { key: "products", label: "方案資料" },
              { key: "rules", label: "AI 會點傾" },
            ] as { key: "products" | "rules"; label: string }[]
          ).map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`text-xs font-medium border-b-2 pb-0.5 transition-colors ${
                tab === t.key ? "border-brand text-brand" : "border-transparent text-t3 hover:text-t1"
              }`}
            >
              {t.label}
            </button>
          ))}
          {role === "ADMIN" && (
            <button
              onClick={() => setTab(tab === "advanced" ? "products" : "advanced")}
              title="管理員進階設定"
              className={`text-[11px] underline decoration-dotted underline-offset-2 ${
                tab === "advanced" ? "text-brand" : "text-t3 hover:text-t2"
              }`}
            >
              進階設定
            </button>
          )}
        </div>
      </div>

      {!canWrite && (
        <div className="text-[11px] bg-panel-2 text-t3 rounded-[12px] px-3 py-2">
          你嘅角色可以睇呢度嘅設定，但改動需要管理員權限。
        </div>
      )}

      {/* ══ Tab 1：方案資料 ══ */}
      {tab === "products" && (
        <div className="space-y-3">
          {/* 方案 chip 列 */}
          <div className="flex flex-wrap gap-1.5" data-testid="c5-products">
            {products.map((p) => (
              <button
                key={p.id}
                onClick={() => setSelectedId(p.id)}
                className={`inline-flex items-center gap-1.5 text-xs rounded-full px-3 py-1.5 border transition-colors ${
                  p.approvedAt
                    ? "border-brand bg-brand-soft text-brand-text font-medium"
                    : "border-warn text-warn-text bg-panel"
                } ${selectedId === p.id ? "ring-2 ring-brand/40" : ""}`}
                title={p.approvedAt ? "已確認 — AI 可以用" : "未確認 — AI 唔會同病人提起"}
              >
                <span>{p.approvedAt ? "✓" : "⚠"}</span>
                {p.displayName}
              </button>
            ))}
            <button
              onClick={() => void doCreateProduct()}
              className="inline-flex items-center gap-1 text-xs rounded-full px-3 py-1.5 border border-dashed border-line text-t3 hover:text-brand hover:border-brand"
            >
              <Plus size={11} strokeWidth={2.5} /> 新增方案
            </button>
          </div>

          {selected && form ? (
            <div className="grid lg:grid-cols-[1fr_360px] gap-3">
              {/* 五格表單（植牙 +4 格） */}
              <div className="bg-panel-2 rounded-[16px] p-4 space-y-3.5">
                <Field label="方案名（病人會見到）">
                  <input
                    value={form.displayName}
                    onChange={(e) => updateForm({ displayName: e.target.value })}
                    disabled={!canWrite}
                    data-testid="c5-displayName"
                    className="w-full bg-panel border border-line rounded-[10px] px-3 py-2 text-sm text-t1 focus:outline-none focus:border-brand"
                  />
                </Field>
                <Field label="呢個方案係咩？（AI 會照呢句講）" hint="💡 寫你平時會同病人講嗰句就得">
                  <textarea
                    value={form.approvedWording}
                    onChange={(e) => updateForm({ approvedWording: e.target.value })}
                    disabled={!canWrite}
                    rows={3}
                    data-testid="c5-approvedWording"
                    className="w-full bg-panel border border-line rounded-[10px] px-3 py-2 text-sm text-t1 focus:outline-none focus:border-brand"
                  />
                  <div className="mt-1 text-[10px] text-t3">AI 內部嘅方案講法會跟呢句自動同步（唔使另外填）</div>
                </Field>
                <Field label="療程時間點講？" hint="💡 留空 = AI 唔會講療程時間">
                  <input
                    value={form.timeWording}
                    onChange={(e) => updateForm({ timeWording: e.target.value })}
                    disabled={!canWrite}
                    className="w-full bg-panel border border-line rounded-[10px] px-3 py-2 text-sm text-t1 focus:outline-none focus:border-brand"
                  />
                </Field>
                <Field label="唔准講嘅嘢" hint="💡 呢啲講法 AI 一定唔會用">
                  <div className="flex flex-wrap gap-1">
                    {form.avoidPhrases.map((ph) => (
                      <span
                        key={ph}
                        className="inline-flex items-center gap-1 text-[11px] bg-danger-soft text-danger-text rounded-full pl-2 pr-1 py-0.5"
                      >
                        {ph}
                        {canWrite && (
                          <button
                            onClick={() => updateForm({ avoidPhrases: form.avoidPhrases.filter((x) => x !== ph) })}
                            aria-label={`刪除 ${ph}`}
                            className="opacity-70 hover:opacity-100"
                          >
                            <X size={10} strokeWidth={2.75} />
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                  {canWrite && (
                    <input
                      value={newPhrase}
                      onChange={(e) => setNewPhrase(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && newPhrase.trim()) {
                          e.preventDefault();
                          if (!form.avoidPhrases.includes(newPhrase.trim()))
                            updateForm({ avoidPhrases: [...form.avoidPhrases, newPhrase.trim()] });
                          setNewPhrase("");
                        }
                      }}
                      placeholder="+ 加一句（Enter 確認）"
                      className="mt-1.5 w-full text-xs rounded-full border border-dashed border-line-strong bg-transparent px-3 py-1.5 text-t1 placeholder:text-t3 focus:outline-none focus:border-brand"
                    />
                  )}
                </Field>
                <Field label="收費" hint="💡 由價目表自動拎，改價請去價目表">
                  <select
                    value={form.priceDocTitle}
                    onChange={(e) => updateForm({ priceDocTitle: e.target.value })}
                    disabled={!canWrite}
                    className="w-full bg-panel border border-line rounded-[10px] px-3 py-2 text-sm text-t1 focus:outline-none focus:border-brand"
                  >
                    <option value="">（唔綁價目表）</option>
                    {priceDocs.map((d) => (
                      <option key={d.id} value={d.title}>
                        {d.title}
                        {fmtPriceRange(d.priceMin, d.priceMax) ? `（${fmtPriceRange(d.priceMin, d.priceMax)}）` : ""}
                      </option>
                    ))}
                  </select>
                </Field>

                {/* 植牙額外四格 */}
                {isImplant && (
                  <>
                    <Field label="型號" hint="💡 例：Hiossen / Straumann">
                      <input value={form.model} onChange={(e) => updateForm({ model: e.target.value })} disabled={!canWrite} className="w-full bg-panel border border-line rounded-[10px] px-3 py-2 text-sm text-t1 focus:outline-none focus:border-brand" />
                    </Field>
                    <Field label="材料" hint="💡 例：鈦合金 / 氧化鋯">
                      <input value={form.material} onChange={(e) => updateForm({ material: e.target.value })} disabled={!canWrite} className="w-full bg-panel border border-line rounded-[10px] px-3 py-2 text-sm text-t1 focus:outline-none focus:border-brand" />
                    </Field>
                    <Field label="表面處理" hint="💡 例：噴砂酸蝕">
                      <input value={form.surface} onChange={(e) => updateForm({ surface: e.target.value })} disabled={!canWrite} className="w-full bg-panel border border-line rounded-[10px] px-3 py-2 text-sm text-t1 focus:outline-none focus:border-brand" />
                    </Field>
                    <Field label="保養年期" hint="💡 例：10 年">
                      <input value={form.warrantyNote} onChange={(e) => updateForm({ warrantyNote: e.target.value })} disabled={!canWrite} className="w-full bg-panel border border-line rounded-[10px] px-3 py-2 text-sm text-t1 focus:outline-none focus:border-brand" />
                    </Field>
                  </>
                )}

                {/* 簽署列 */}
                <div className="pt-2 border-t border-line space-y-1.5" data-testid="c5-signrow">
                  {selected.approvedAt ? (
                    <div className="text-xs text-brand">
                      ✓ 已由 {selected.approvedBy} 確認 · {new Date(selected.approvedAt).toLocaleDateString("zh-HK")}
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-t2">醫生確認：</span>
                      <input
                        value={approveName}
                        onChange={(e) => setApproveName(e.target.value)}
                        placeholder="你嘅名"
                        disabled={!canWrite}
                        className="text-xs w-28 bg-panel border border-line rounded-full px-3 py-1.5 text-t1 placeholder:text-t3 focus:outline-none focus:border-brand"
                      />
                      <button
                        onClick={() => void doApprove()}
                        disabled={!canWrite}
                        data-testid="c5-approve-btn"
                        className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-full bg-brand text-panel font-medium disabled:opacity-50"
                      >
                        <Check size={12} strokeWidth={2.75} /> 確認呢個方案內容
                      </button>
                    </div>
                  )}
                  {!selected.approvedAt && (
                    <div className="text-[11px] text-warn-text">⚠ 未確認嘅方案，AI 唔會同病人提起</div>
                  )}
                </div>
              </div>

              {/* 即時預覽區 */}
              <div className="bg-panel-2 rounded-[16px] p-4 h-fit" data-testid="c5-preview">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-t2">即時預覽</div>
                  <button
                    onClick={() => void runPreview()}
                    className="inline-flex items-center gap-1 text-[11px] text-t3 hover:text-brand"
                    title="重新預覽"
                  >
                    <RefreshCw size={11} strokeWidth={2.5} className={previewLoading ? "animate-spin" : ""} /> 重新預覽
                  </button>
                </div>
                <div className="mt-2 text-[11px] text-t3">
                  病人問：「{preview?.demoQuestion ?? DEMO_QUESTIONS[workflow]}」
                </div>
                <div className="mt-2 rounded-[12px] bg-panel border border-line px-3 py-2.5 text-[13px] text-t1 whitespace-pre-wrap min-h-[96px]" data-testid="c5-preview-draft">
                  {previewLoading ? (
                    <span className="text-t3">AI 思考緊…</span>
                  ) : preview ? (
                    preview.draft
                  ) : (
                    <span className="text-t3">（預覽載入中／失敗）</span>
                  )}
                </div>
                {preview && preview.mock && (
                  <div className="mt-1.5 text-[10px] text-t3">預覽模式：模擬回覆（未接 AI 時嘅示範文案）</div>
                )}
                {preview && preview.unapprovedCount > 0 && (
                  <div className="mt-1.5 text-[11px] text-warn-text">
                    ⚠ 有 {preview.unapprovedCount} 個未確認方案 — AI 唔會同病人提起
                  </div>
                )}
                {preview && !previewLoading && (
                  <div className="mt-2.5 space-y-1">
                    {preview.checks.map((c) => (
                      <div key={c.label} className={`text-xs flex items-start gap-1.5 ${c.pass ? "text-brand" : "text-danger-text"}`}>
                        <span className="shrink-0">{c.pass ? "✓" : "✗"}</span>
                        <span>
                          {c.label}
                          {!c.pass && c.reason ? <span className="text-[11px]">（{c.reason}）</span> : null}
                        </span>
                      </div>
                    ))}
                    {preview.blocked && (
                      <div className="text-[11px] text-danger-text">
                        預覽被安全檢查攔截（{preview.cgCode}）— 實際對話會轉人手處理
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-panel-2 rounded-[16px] p-6 text-center text-xs text-t3">
              呢個範圍仲未有方案 — 撳「新增方案」開頭（全局層有預填嘅話，揀「全部診所通用」會見到）
            </div>
          )}
        </div>
      )}

      {/* ══ Tab 2：AI 會點傾 ══ */}
      {tab === "rules" && (
        <div className="space-y-3" data-testid="c5-tab2">
          <div className="bg-panel-2 rounded-[16px] p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-t2">AI 會點反應</div>
            <div className="mt-2.5 divide-y divide-line">
              {CONSULT_RULE_ROWS.map((r) => {
                const on = r.key ? s.rules[r.key as keyof RulesValue] : null;
                return (
                  <div key={r.label} className="py-2.5 flex items-center justify-between gap-3">
                    <div className="text-[13px] text-t1 leading-snug">
                      {r.label}
                      {r.locked && (
                        <span className="ml-1.5 inline-flex items-center gap-0.5 text-t3" title="為咗病人安全，呢條唔可以關">
                          <Lock size={10} strokeWidth={2.5} />
                        </span>
                      )}
                    </div>
                    {r.key ? (
                      <button
                        onClick={() => toggleRule(r.key, !on)}
                        disabled={!canWrite || on === null}
                        aria-label={`${r.label} 開關`}
                        className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
                          on ? "bg-brand" : "bg-line"
                        } disabled:opacity-50`}
                      >
                        <span
                          className={`absolute top-0.5 w-4 h-4 rounded-full bg-panel shadow transition-all ${
                            on ? "left-[18px]" : "left-0.5"
                          }`}
                        />
                      </button>
                    ) : (
                      <span className="text-[11px] text-t3 shrink-0">鎖定</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* 發現問題 */}
          <div className="bg-panel-2 rounded-[16px] p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-t2">AI 會問病人嘅問題</div>
            <div className="mt-2.5 space-y-2">
              {s.discovery.questions.map((q, idx) => (
                <div
                  key={q.id}
                  draggable={canWrite}
                  onDragStart={(e) => e.dataTransfer.setData("text/idx", String(idx))}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = Number(e.dataTransfer.getData("text/idx"));
                    if (!Number.isNaN(from) && from !== idx) reorderQuestions(from, idx);
                  }}
                  className="flex items-start gap-2 bg-panel border border-line rounded-[12px] px-3 py-2.5"
                >
                  <span className="mt-2 text-t3 cursor-grab" title="拖住改順序">
                    <GripVertical size={13} strokeWidth={2} />
                  </span>
                  <textarea
                    value={q.text}
                    rows={2}
                    disabled={!canWrite}
                    onChange={(e) => setQuestion(idx, { text: e.target.value })}
                    className="flex-1 bg-transparent text-[13px] text-t1 focus:outline-none resize-none"
                  />
                  <button
                    onClick={() => setQuestion(idx, { enabled: !q.enabled })}
                    disabled={!canWrite}
                    aria-label="問題開關"
                    className={`relative w-9 h-5 rounded-full transition-colors shrink-0 mt-1.5 ${
                      q.enabled ? "bg-brand" : "bg-line"
                    } disabled:opacity-50`}
                  >
                    <span
                      className={`absolute top-0.5 w-4 h-4 rounded-full bg-panel shadow transition-all ${
                        q.enabled ? "left-[18px]" : "left-0.5"
                      }`}
                    />
                  </button>
                </div>
              ))}
              {/* 問預算 — 預設關 + 診所選擇唔問（鎖定） */}
              <div className="flex items-center justify-between gap-3 bg-panel border border-dashed border-line rounded-[12px] px-3 py-2.5 opacity-80">
                <div className="text-[13px] text-t2">
                  問病人預算
                  <span className="ml-1.5 text-[11px] text-t3">診所選擇唔問</span>
                  <span className="ml-1.5 inline-flex items-center gap-0.5 text-t3" title="為咗病人安全，呢條唔可以關">
                    <Lock size={10} strokeWidth={2.5} />
                  </span>
                </div>
                <span className="text-[11px] text-t3">關閉</span>
              </div>
            </div>
            <div className="mt-2.5 text-[11px] text-t3">問完就會介紹方案，唔會連珠炮發問🫶🏻</div>
          </div>
        </div>
      )}

      {/* ══ Tab 3：進階（ADMIN） ══ */}
      {tab === "advanced" && role === "ADMIN" && (
        <div className="space-y-3" data-testid="c5-tab3">
          <div className="bg-panel-2 rounded-[16px] p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-t2">對話節奏</div>
            <div className="mt-2.5 grid sm:grid-cols-3 gap-3">
              <Field label="AI 最多傾幾多輪？" hint={`💡 預設 ${CONSULT_SETTING_DEFAULTS.advanced.maxTurns} — 到咗會建議親身評估`}>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={s.advanced.maxTurns}
                  onChange={(e) => setAdvanced({ maxTurns: Number(e.target.value) || CONSULT_SETTING_DEFAULTS.advanced.maxTurns })}
                  className="w-full bg-panel border border-line rounded-[10px] px-3 py-2 text-sm text-t1 focus:outline-none focus:border-brand"
                />
              </Field>
              <Field label="第幾輪開始推約評估？" hint={`💡 預設 ${CONSULT_SETTING_DEFAULTS.advanced.ctaAfterTurns}`}>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={s.advanced.ctaAfterTurns}
                  onChange={(e) => setAdvanced({ ctaAfterTurns: Number(e.target.value) || CONSULT_SETTING_DEFAULTS.advanced.ctaAfterTurns })}
                  className="w-full bg-panel border border-line rounded-[10px] px-3 py-2 text-sm text-t1 focus:outline-none focus:border-brand"
                />
              </Field>
              <Field label="幾多個鐘冇回應算作結束？" hint={`💡 預設 ${CONSULT_SETTING_DEFAULTS.advanced.sessionIdleHours}`}>
                <input
                  type="number"
                  min={1}
                  max={168}
                  value={s.advanced.sessionIdleHours}
                  onChange={(e) => setAdvanced({ sessionIdleHours: Number(e.target.value) || CONSULT_SETTING_DEFAULTS.advanced.sessionIdleHours })}
                  className="w-full bg-panel border border-line rounded-[10px] px-3 py-2 text-sm text-t1 focus:outline-none focus:border-brand"
                />
              </Field>
            </div>
          </div>

          <div className="bg-panel-2 rounded-[16px] p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-t2">邊啲詞會叫醒 AI</div>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {(CONSULT_TRIGGER_FLOOR[workflow] ?? []).map((w) => (
                <span
                  key={w}
                  className="inline-flex items-center gap-1 text-[11px] bg-panel border border-line text-t3 rounded-full px-2 py-0.5"
                  title="系統內建 — 唔可以刪"
                >
                  <Lock size={9} strokeWidth={2.5} /> {w}
                </span>
              ))}
              {s.advanced.extraTriggerWords.map((w) => (
                <span key={w} className="inline-flex items-center gap-1 text-[11px] bg-brand-soft text-brand-text rounded-full pl-2 pr-1 py-0.5">
                  {w}
                  <button onClick={() => setAdvanced({ extraTriggerWords: s.advanced.extraTriggerWords.filter((x) => x !== w) })} aria-label={`刪除 ${w}`}>
                    <X size={10} strokeWidth={2.75} />
                  </button>
                </span>
              ))}
              <input
                value={newWord}
                onChange={(e) => setNewWord(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newWord.trim()) {
                    e.preventDefault();
                    if (!s.advanced.extraTriggerWords.includes(newWord.trim()))
                      setAdvanced({ extraTriggerWords: [...s.advanced.extraTriggerWords, newWord.trim()] });
                    setNewWord("");
                  }
                }}
                placeholder="+ 加個詞"
                className="text-[11px] w-24 bg-transparent border border-dashed border-line-strong rounded-full px-2 py-0.5 text-t1 placeholder:text-t3 focus:outline-none focus:border-brand"
              />
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <div className="bg-panel-2 rounded-[16px] p-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-t2">意向訊號分數</div>
              <div className="mt-2.5 divide-y divide-line">
                {INTENT_SCORE_ROWS.map((r) => (
                  <div key={r.label} className="py-1.5 flex items-center justify-between gap-2 text-[12px]">
                    <span className="text-t1">{r.label}</span>
                    <span className={`font-mono text-[11px] ${r.delta.startsWith("+") ? "text-brand" : "text-warn-text"}`}>{r.delta}</span>
                  </div>
                ))}
              </div>
              <div className="mt-2 text-[10px] text-t3">分數 0–1 · 0.6 以上會轉入「安排預約」</div>
            </div>
            <div className="bg-panel-2 rounded-[16px] p-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-t2">安全檢查（一直開緊）</div>
              <div className="mt-2.5 divide-y divide-line">
                {CG_READONLY_ROWS.map((r) => (
                  <div key={r.code} className="py-1.5 flex items-center justify-between gap-2 text-[12px]" title={r.code}>
                    <span className="text-t1">{r.label}</span>
                    <span className="text-[11px] text-brand shrink-0 inline-flex items-center gap-0.5">
                      <Check size={10} strokeWidth={2.75} /> 開緊
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-2 text-[10px] text-t3">收費引用跟「知識庫」價目表範圍（改價請去知識庫）</div>
            </div>
          </div>
        </div>
      )}

      {/* toast */}
      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 bg-t1 text-panel text-xs rounded-full px-4 py-2 shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

/** 問句式欄位包裹（label + 💡 hint + 內容）。 */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[12px] font-medium text-t2 mb-1">{label}</div>
      {children}
      {hint && <div className="mt-1 text-[11px] text-t3">{hint}</div>}
    </div>
  );
}

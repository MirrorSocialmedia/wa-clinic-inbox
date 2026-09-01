"use client";

/**
 * ClinicSelect — 診所選擇器（cwi-sched-20260901 §5 修復）
 *
 * 🔴 舊版 bug（零 fetch、零 network）：server component 內 `<form method="GET">` 包住
 * 唔帶 submit 掣／onChange 嘅 `<select>` — 換 store 冇 submit 事件 → URL 唔變 → 零 fetch。
 * 修：client 組件，onChange 即刻 `router.replace` 帶齊 clinic param（+ view 保持）。
 *
 * 用家：/schedule 頁 header（T-A 過渡版 + T-B 合併頁共用）。
 */
import { useRouter } from "next/navigation";

export interface ClinicOptLite {
  id: string;
  code: string;
  name: string;
}

interface Props {
  clinics: ClinicOptLite[];
  /** 目前選定 clinic code（= URL param 值） */
  value: string;
  /** 要一齊帶住嘅 view param（保持 view 唔斷） */
  view?: string;
  /** URL param 名（T-A = clinicId；T-B = clinic） */
  paramName?: string;
  /** 選單第一格 placeholder（唔 selectable） */
  placeholder?: string;
}

export function ClinicSelect({
  clinics,
  value,
  view,
  paramName = "clinicId",
  placeholder = "揀一間店",
}: Props) {
  const router = useRouter();

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const code = e.target.value.trim();
    if (!code || code === value) return;
    const p = new URLSearchParams();
    p.set(paramName, code);
    if (view) p.set("view", view);
    // replace（唔 push）— 換店唔想爆 history；URL 同步即 T151 防回歸斷言位
    router.replace(`/schedule?${p.toString()}`);
  }

  return (
    <select
      value={value}
      onChange={onChange}
      className="px-2 py-1 rounded bg-panel border border-line text-t1"
      aria-label="診所"
    >
      {value === "" && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {clinics.map((c) => (
        <option key={c.id} value={c.code}>
          {c.name}（{c.code}）
        </option>
      ))}
    </select>
  );
}

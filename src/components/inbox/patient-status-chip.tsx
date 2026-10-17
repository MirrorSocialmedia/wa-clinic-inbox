/**
 * ★ cwi-patient-identify-20261017：新客／舊客 chip（列表 row、對話頂部、病人卡共用）。
 * EXISTING 舊客（多個病人檔 → 「舊客 ×N」）／NEW 新客／UNKNOWN 未確定（Apricot 查唔到 — 唔當新客）；null = 未判定（唔顯示）。
 */
export function PatientStatusChip({
  status,
  count,
  size = "sm",
}: {
  status: string | null | undefined;
  count?: number | null;
  size?: "xs" | "sm";
}) {
  if (!status) return null;
  const base = `${size === "xs" ? "text-[10px] px-1.5" : "text-[11px] px-2"} py-0.5 rounded-full font-semibold whitespace-nowrap`;
  if (status === "EXISTING") {
    return (
      <span className={`${base} bg-ok-soft text-ok-text`} title="Apricot 有病人檔" data-testid="patient-status" data-status="EXISTING">
        舊客{count && count > 1 ? ` ×${count}` : ""}
      </span>
    );
  }
  if (status === "NEW") {
    return (
      <span className={`${base} bg-brand-soft text-brand-text border border-brand/40`} title="全部 Apricot 帳號都冇呢個電話" data-testid="patient-status" data-status="NEW">
        新客
      </span>
    );
  }
  return (
    <span className={`${base} bg-warn-soft text-warn-text`} title="Apricot 暫時查唔到 — 稍後自動再試" data-testid="patient-status" data-status="UNKNOWN">
      未確定
    </span>
  );
}

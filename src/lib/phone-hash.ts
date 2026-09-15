import { createHmac } from "node:crypto";
export function normalizePhone(raw: string): string {
  const d = raw.replace(/\D/g, "");
  return d.startsWith("852") && d.length === 11 ? d.slice(3) : d;   // HK 取尾 8；海外全碼
}
export function phoneHash(raw: string): string {
  return createHmac("sha256", process.env.PHONE_HASH_KEY!).update(normalizePhone(raw)).digest("hex");
}

/**
 * ★ cwi-followup-p0-20260915（MD §1.2）：多號 E.164 正規化 + 多 hash — follow-up 索引配對用。
 *
 * 與 CWM `src/lib/phone.ts`（workforce 側）**同算法同 spec**（原始 Apricot 電話唔過界，
 * 所以兩邊各有一份；改一邊必改另一邊 + 對齊 pinned vectors）。
 * 舊 `phoneHash`（8 位 format）保留 — 現有 patient-lookup 配對行為 P0 唔變；
 * P1 索引上線後 pairing 轉用 `phoneHashes`（hasSome）。
 */
export function normalizeHkPhones(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\/,;、\s]+/)
    .map((s) => s.replace(/[^\d+]/g, ""))
    .flatMap((s) => {
      if (/^\+852\d{8}$/.test(s)) return [s];
      if (/^852\d{8}$/.test(s)) return [`+${s}`];
      if (/^\d{8}$/.test(s) && /^[2-9]/.test(s)) return [`+852${s}`]; // 香港本地 8 位
      if (/^\+\d{8,15}$/.test(s)) return [s]; // 其他國家保留
      return []; // 唔合法 → 丟
    })
    .filter((v, i, a) => a.indexOf(v) === i);
}

export function phoneHashes(raw: string | null | undefined, key?: string): string[] {
  const k = key ?? process.env.PHONE_HASH_KEY!;
  return normalizeHkPhones(raw).map((p) => createHmac("sha256", k).update(p).digest("hex"));
}

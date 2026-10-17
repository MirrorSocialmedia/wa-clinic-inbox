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
/** 一段（已去除空格／符號，只剩數字同 +）→ E.164；唔合法 → null。 */
function classifyPhone(s: string): string | null {
  if (/^\+852\d{8}$/.test(s)) return s;
  if (/^852\d{8}$/.test(s)) return `+${s}`;
  if (/^[2-9]\d{7}$/.test(s)) return `+852${s}`; // 香港本地 8 位
  // ★ cwi-patient-identify-20261017：內地手機 — 86 開頭（無 +）／冇國碼 11 位（1 開頭；香港號只有 8 位唔會撞）
  if (/^861\d{10}$/.test(s)) return `+${s}`;
  if (/^1\d{10}$/.test(s)) return `+86${s}`;
  if (/^\+\d{8,15}$/.test(s)) return s; // 其他國家保留
  return null;
}

/** 一段入面用空格分隔咗幾個號（「85291234567 61234567」「9123 4567 6123 4567」）→ 由左至右，
 *  每次試最長嘅連續幾段合併（最多 4 段）可以成為合法號碼。 */
function splitSpacedNumbers(seg: string): string[] {
  const toks = seg.split(/\s+/).map((t) => t.replace(/[^\d+]/g, "")).filter(Boolean);
  const out: string[] = [];
  let i = 0;
  while (i < toks.length) {
    let used = 0;
    for (let n = Math.min(4, toks.length - i); n >= 1; n--) {
      const c = classifyPhone(toks.slice(i, i + n).join(""));
      if (c) {
        out.push(c);
        used = n;
        break;
      }
    }
    i += used || 1;
  }
  return out;
}

/**
 * ★ cwi-patient-identify-20261017（同 CWM src/lib/phone.ts 逐字同步）：
 *   號內空格／橫線／括號照收；一格多號（分隔符或空格）拆得出；內地手機 +86／86／冇國碼 11 位 → +86。
 *   WhatsApp waId（國碼 + 號碼、冇 +）：852… → +852…；86… → +86…。
 */
export function normalizeHkPhones(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const seg of raw.split(/[\/,;、|]+/)) {
    const whole = classifyPhone(seg.replace(/[^\d+]/g, ""));
    if (whole) out.push(whole);
    else out.push(...splitSpacedNumbers(seg));
  }
  return out.filter((v, i, a) => a.indexOf(v) === i);
}

export function phoneHashes(raw: string | null | undefined, key?: string): string[] {
  const k = key ?? process.env.PHONE_HASH_KEY!;
  return normalizeHkPhones(raw).map((p) => createHmac("sha256", k).update(p).digest("hex"));
}

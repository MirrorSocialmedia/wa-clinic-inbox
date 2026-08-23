import { createHmac } from "node:crypto";
export function normalizePhone(raw: string): string {
  const d = raw.replace(/\D/g, "");
  return d.startsWith("852") && d.length === 11 ? d.slice(3) : d;   // HK 取尾 8；海外全碼
}
export function phoneHash(raw: string): string {
  return createHmac("sha256", process.env.PHONE_HASH_KEY!).update(normalizePhone(raw)).digest("hex");
}

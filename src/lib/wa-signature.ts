import { createHmac, timingSafeEqual } from "crypto";

/**
 * Meta Cloud API `x-hub-signature-256` 驗簽（框架 MD §6.1）
 *
 * 用法：webhook route 同 smoke-test 共用呢一個實現（唔好兩邊各寫一份 — 避免行為漂移）。
 *
 * - header 可能含多個 signature（comma 分隔，e.g. "sha1=...,sha256=..."）→ 攞 sha256= 嗰份
 * - timingSafeEqual 要求 buffer 等長 → 長度唔等直接 false（唔好俾佢 throw）
 * - 無 secret / 無 header / 搵唔到 sha256 part → false（fail closed）
 */
export function verifyWaSignature(
  rawBody: string,
  header: string | null | undefined,
  appSecret?: string
): boolean {
  if (!appSecret || !header) return false;

  const sha256Part = header
    .split(",")
    .map((s) => s.trim())
    .find((s) => s.startsWith("sha256="));
  if (!sha256Part) return false;

  const expected =
    "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");

  const a = Buffer.from(sha256Part);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

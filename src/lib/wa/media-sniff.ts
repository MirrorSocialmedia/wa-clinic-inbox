/**
 * ★ cwi-final S6-9④（audit3 P2-03）：outbound 附件類型偵測 — 以檔頭 magic bytes 判斷，
 * 唔信 client 傳嘅 MIME／副檔名（.exe 改名 .pdf 一律擋；副檔名只係顯示層）。
 *
 * 第一版範圍（spec 表）：JPEG / PNG（5 MB，Meta 圖片上限）/ PDF（10 MB，自訂上限）。
 * HEIC／Word／Excel／影片：回 null → route 415（前端提示「請用 JPG／PNG 或者 PDF」）。
 */

export type OutboundMediaKind =
  | { kind: "image"; mime: "image/jpeg" | "image/png"; ext: "jpg" | "png"; max: number }
  | { kind: "document"; mime: "application/pdf"; ext: "pdf"; max: number };

export function sniffOutboundMedia(buf: Buffer): OutboundMediaKind | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return { kind: "image", mime: "image/jpeg", ext: "jpg", max: 5 * 1024 * 1024 };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { kind: "image", mime: "image/png", ext: "png", max: 5 * 1024 * 1024 };
  if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-")
    return { kind: "document", mime: "application/pdf", ext: "pdf", max: 10 * 1024 * 1024 };
  return null;
}

/** 顯示名清洗：去路徑、控制字元，限 80 字，強制 .pdf 結尾。 */
export function cleanDocName(raw: string | null | undefined): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const s = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").trim().slice(0, 80);
  const name = s || "document";
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

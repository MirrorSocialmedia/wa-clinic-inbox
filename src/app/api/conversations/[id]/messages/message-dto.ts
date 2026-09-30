/**
 * ★ cwi-qa FX-24（QA-24，已重現）：messages API 回傳 DTO 單一來源。
 *
 * `GET .../messages` 同 `GET .../bundle` 兩條 route 必須經呢度（防兩處漂移）：
 * - 剷 `waMediaId` — server-side Graph /media 上載 id（30 日有效、重試沿用）—
 *   純 server 實現細節，回 client 只有洩露面冇用途（QA-24：bundle JSON 見咗呢欄）。
 * - `mediaPath` 唔回碟上絕對路徑（`/srv/wa-media/…`、dev `/tmp/wa-media/…` —
 *   路徑結構 + 部署形態洩露）→ 一律換 `/api/media/<mediaKey>`（client 讀返嘅唯一正門）。
 *   冇 mediaKey（壞行/legacy）→ null（唔回絕對路徑 = 唔洩露）。
 *
 * 其餘欄（mediaName 顯示名 / mediaStatus 等）原样回（UI 需要）。
 * shallow spread（Date 欄傳引用，同原 row 行為一致）。
 */
export type MessageDto = Record<string, unknown> & {
  id: string;
  conversationId: string;
  mediaPath: string | null;
};

export function toMessageDto<T extends object>(m: T): MessageDto {
  const r = { ...m } as Record<string, unknown>;
  delete r.waMediaId; // ★ FX-24：server-side Graph media id 唔回 client
  const mediaKey = r.mediaKey;
  r.mediaPath =
    typeof mediaKey === "string" && mediaKey.length > 0
      ? `/api/media/${mediaKey}` // ★ FX-24：絕對路徑 → API URL
      : null;
  return r as MessageDto;
}

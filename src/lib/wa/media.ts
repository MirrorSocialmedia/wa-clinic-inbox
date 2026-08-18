/**
 * 媒體下載（框架 MD §6.2）。
 *
 * GET graph.facebook.com/v23.0/{media_id} 攞 URL → 下載落
 * `${WA_MEDIA_DIR|/srv/wa-media}/{wamid}.{ext}`（fallback /tmp/wa-media）。
 *
 * - URL 幾分鐘過期：攞到即刻下載，唔存 URL 入 DB（mediaPath 存本地路徑）
 * - MOCK MODE（WA_MOCK=1）：無真 Media API → 跳過下載，回 null（worker 照寫 Message）
 * - 大小上限 50MB（WA 媒體上限以內；防意外大檔塞滿 disk）
 *
 * ★ PII 鐵律：log 只帶 wamid / mediaId / bytes / path，唔帶任何內容。
 */
import { mkdir, writeFile, stat } from "node:fs/promises";
import { existsSync, accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import log from "@/lib/log";
import { getMediaInfo, waMock } from "@/lib/wa/graph";

const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "audio/ogg": "ogg",
  "audio/ogq": "ogg", // WhatsApp voice notes = ogg/opus
  "application/pdf": "pdf",
  "application/vnd.ms-excel": "xls",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

/** 可寫目錄選擇：/srv/wa-media（prod）→ /tmp/wa-media（本地 fallback）。 */
function mediaDir(): string {
  const preferred = process.env.WA_MEDIA_DIR || "/srv/wa-media";
  try {
    if (existsSync(preferred)) {
      accessSync(preferred, fsConstants.W_OK);
      return preferred;
    }
  } catch {
    /* 無權 / 不存在 → fallback */
  }
  return "/tmp/wa-media";
}

async function canWrite(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export interface MediaDownloadResult {
  mediaPath: string | null;
  skipped: boolean;
  reason?: string;
}

/**
 * 下載 WA 媒體落本地。回 mediaPath（成功）或 null（跳過/失敗 — Message 照寫）。
 * 失敗唔 throw：媒體落地失敗唔應該阻塞整條 inbound pipeline（訊息本身要入 inbox）。
 */
export async function downloadWaMedia(opts: {
  mediaId: string;
  wamid: string;
}): Promise<MediaDownloadResult> {
  const { mediaId, wamid } = opts;

  if (waMock()) {
    log.info({ mediaId, wamid, mock: true }, "media: mock mode — download skipped");
    return { mediaPath: null, skipped: true, reason: "mock" };
  }

  try {
    const info = await getMediaInfo(mediaId);
    const ext = MIME_EXT[info.mimeType] ?? "bin";
    const dir = mediaDir();
    if (!(await canWrite(dir))) {
      log.warn({ mediaId, wamid }, "media: no writable media dir");
      return { mediaPath: null, skipped: true, reason: "no-media-dir" };
    }
    const filePath = path.join(dir, `${wamid}.${ext}`);

    const res = await fetch(info.url);
    if (!res.ok) {
      log.warn({ mediaId, wamid, httpStatus: res.status }, "media: download HTTP error");
      return { mediaPath: null, skipped: true, reason: `http-${res.status}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_MEDIA_BYTES) {
      log.warn({ mediaId, wamid, bytes: buf.byteLength }, "media: file too large, skipped");
      return { mediaPath: null, skipped: true, reason: "too-large" };
    }

    // 冪等：已存在且大小相同 → 唔重寫（webhook 重發場景）
    try {
      const st = await stat(filePath);
      if (st.size === buf.byteLength) {
        return { mediaPath: filePath, skipped: true, reason: "exists" };
      }
    } catch {
      /* 唔存在，照寫 */
    }

    await writeFile(filePath, buf);
    log.info({ mediaId, wamid, bytes: buf.byteLength, path: filePath }, "media: saved");
    return { mediaPath: filePath, skipped: false };
  } catch (err) {
    log.warn(
      { mediaId, wamid, err: err instanceof Error ? err.message : String(err) },
      "media: download failed"
    );
    return { mediaPath: null, skipped: true, reason: "error" };
  }
}

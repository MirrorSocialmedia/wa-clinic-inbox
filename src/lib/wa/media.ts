/**
 * 媒體下載 + at-rest 加密（框架 MD §6.2 + 安全審計 C-1）。
 *
 * GET graph.facebook.com/v23.0/{media_id} 攞 URL → 下載落
 * `${WA_MEDIA_DIR|/srv/wa-media}/{wamid}.{ext}`。
 *
 * 安全（安全審計 C-1，上真機前必修）：
 * - ★ Fail-fast：production 時 media dir 唔存在 / 不可寫 → throw（MediaDirError）。
 *   唔准靜默 fallback /tmp/wa-media（病人相落入未加密、人人可路過嘅 /tmp 係 A 級資料事故）。
 *   dev/mock mode 保留 fallback（sandbox 寫唔到 /srv）但要響亮 log warning。
 * - ★ Per-file AES-256-GCM：寫入落地時加密、serve 時解密（對 call site 透明）。
 *   key = env `MEDIA_ENC_KEY`（32 bytes hex，openssl rand -hex 32）：
 *   - production 冇 key / key 壞 → throw（MediaKeyError）— 寧願 media 唔落地都唔得明文
 *   - dev/mock 冇 key → 明文 + 響亮 warning（e2e sandbox 要照行）
 *   格式：`WA1|<iv hex>|<tag hex>|<cipher hex>`（magic 前綴自帶版本）—
 *   明文舊檔冇 magic → 偵測到，按 legacy 明文處理（dev 冇 key 環境 + 上線過渡期舊檔）。
 * - 目錄 0700、檔案 0600（app user 獨享）。
 *
 * - URL 幾分鐘過期：攞到即刻下載，唔存 URL 入 DB（mediaPath 存本地路徑）
 * - MOCK MODE（WA_MOCK=1）：無真 Media API → 跳過下載，回 null（worker 照寫 Message）
 * - 大小上限 50MB（WA 媒體上限以內；防意外大檔塞滿 disk）
 *
 * ★ PII 鐵律：log 只帶 wamid / mediaId / bytes / path / reason，唔帶任何內容。
 */
import { mkdir, writeFile, stat, chmod } from "node:fs/promises";
import { existsSync, accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
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

// ── 錯誤類型（call site 可辨認 fail-fast 原因） ────────────────────────────

/** media dir 唔存在 / 不可寫（production 禁 fallback — fail-fast）。 */
export class MediaDirError extends Error {
  constructor(dir: string, cause?: string) {
    super(`media dir not writable: ${dir}${cause ? ` (${cause})` : ""}`);
    this.name = "MediaDirError";
  }
}

/** MEDIA_ENC_KEY 缺失（production）或格式壞。 */
export class MediaKeyError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "MediaKeyError";
  }
}

// ── Per-file AES-256-GCM（C-1b） ──────────────────────────────────────────
//
// 格式（全 ASCII hex，方便 hexdump 排查）：
//   WA1|<iv 12B hex=24>|<tag 16B hex=32>|<ciphertext hex>
// - magic `WA1` = 版本 1；之後改格式加 `WA2`（舊版仍可解）
// - AES-GCM 定長 overhead：ciphertext 長 = plaintext 長 → 冪等檢查可用 disk size 對照
// - 同一段 plaintext 加密後 size 一定 → webhook 重發冪等語義同明文時代一致

const MEDIA_MAGIC = "WA1|";
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

let warnedNoKey = false;

/**
 * 讀 MEDIA_ENC_KEY（每次 call 讀 env — 方便 E2E 子 process 改 env 測試）。
 * - production 冇 key → throw（媒體唔准明文落碟）
 * - key 格式壞（唔係 64 hex）→ throw（兩邊都係 config 錯，寧早爆）
 * - dev 冇 key → null + 響亮 warning（一次性）
 */
export function getMediaKey(): Buffer | null {
  const raw = (process.env.MEDIA_ENC_KEY ?? "").trim();
  if (!raw) {
    if (isProduction()) {
      throw new MediaKeyError(
        "MEDIA_ENC_KEY missing in production — media 必須 per-file 加密（32 bytes hex: openssl rand -hex 32）"
      );
    }
    if (!warnedNoKey) {
      warnedNoKey = true;
      log.warn(
        { env: process.env.NODE_ENV ?? "development" },
        "media: MEDIA_ENC_KEY 未設 — 媒體以【明文】落地（dev/mock only；production 會 throw，上線前必須設）"
      );
    }
    return null;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new MediaKeyError("MEDIA_ENC_KEY 格式壞 — 要 32 bytes hex（64 個 0-9a-f 字符）");
  }
  return Buffer.from(raw, "hex");
}

/** 加密明文 → `WA1|iv|tag|cipher`（hex）。 */
export function encryptMedia(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.from(
    `${MEDIA_MAGIC}${iv.toString("hex")}|${tag.toString("hex")}|${ct.toString("hex")}`,
    "utf8"
  );
}

/** 偵測加密格式（magic prefix）。 */
export function isEncryptedMedia(buf: Buffer): boolean {
  return buf.length > MEDIA_MAGIC.length && buf.subarray(0, MEDIA_MAGIC.length).toString("utf8") === MEDIA_MAGIC;
}

/** 解密 `WA1|iv|tag|cipher` → 明文（auth tag 驗證失敗 → throw = 檔被改/鍵錯）。 */
export function decryptMedia(enc: Buffer, key: Buffer): Buffer {
  const s = enc.toString("utf8");
  const parts = s.split("|");
  if (parts.length !== 4 || parts[0] !== "WA1") {
    throw new MediaKeyError("media: 唔係合法加密格式（magic/欄位數錯）");
  }
  const iv = Buffer.from(parts[1], "hex");
  const tag = Buffer.from(parts[2], "hex");
  const ct = Buffer.from(parts[3], "hex");
  if (iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES) {
    throw new MediaKeyError("media: iv/tag 長度錯");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ── 目錄解析（fail-fast，C-1a） ───────────────────────────────────────────

/**
 * mkdir 帶 timeout — 某些 container/overlay 環境對特殊路徑（例 /proc）嘅 mkdir syscall
 * 會 hang；fail-fast 路徑絕唔准 hang（5s 內要出結果，超時 = 當失敗 throw）。
 */
function mkdirWithTimeout(dir: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`mkdir ${dir} timeout after ${timeoutMs}ms`)),
      timeoutMs
    );
    mkdir(dir, { recursive: true, mode: 0o700 }).then(
      () => { clearTimeout(t); resolve(); },
      (err) => { clearTimeout(t); reject(err); }
    );
  });
}

/** 目標目錄（WA_MEDIA_DIR 覆蓋；預設 /srv/wa-media）。 */
export function mediaDirPreferred(): string {
  return (process.env.WA_MEDIA_DIR ?? "").trim() || "/srv/wa-media";
}

let warnedFallbackDir = false;

/**
 * 確保目錄存在（0700）+ 可寫，回實際用嘅目錄。
 * - production：失敗 → throw MediaDirError（禁 /tmp fallback — fail-fast，
 *   配 healthz boot assertion 令「media 死咗」冇得靜默）
 * - dev：失敗 → fallback /tmp/wa-media + 響亮 warning（sandbox 寫唔到 /srv 嘅現實）
 */
export async function ensureMediaDir(): Promise<string> {
  const preferred = mediaDirPreferred();
  try {
    await mkdirWithTimeout(preferred, 5000);
    // 已存在嘅目錄 mkdir 唔會改 mode → 顯式收緊（0700 = 只 owner 入出）
    await chmod(preferred, 0o700).catch(() => undefined);
    accessSync(preferred, fsConstants.W_OK);
    return preferred;
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    if (isProduction()) {
      log.error(
        { dir: preferred, err: cause },
        "media: PRODUCTION fail-fast — media dir 唔存在/不可寫（唔 fallback /tmp；修目錄或設 WA_MEDIA_DIR 先）"
      );
      throw new MediaDirError(preferred, cause);
    }
    if (!warnedFallbackDir) {
      warnedFallbackDir = true;
      log.warn(
        { preferred, fallback: "/tmp/wa-media", err: cause },
        "media: ⚠️ dev fallback — 目標目錄唔可用，改用 /tmp/wa-media（/tmp 無加密、重啟清空；production 呢個行為係 throw）"
      );
    }
    await mkdirWithTimeout("/tmp/wa-media", 5000);
    return "/tmp/wa-media";
  }
}

/**
 * boot assertion（server 啟動 + /healthz 共用）— 非 throw 版探查。
 * - production：dir 唔可用 → status="error"（配 log ERROR，唔准靜默）
 * - dev：唔可用 → "dev-fallback"（會行 /tmp fallback）
 */
export async function checkMediaBoot(): Promise<{ status: "ok" | "dev-fallback" | "error"; dir: string }> {
  const preferred = mediaDirPreferred();
  let ok = false;
  try {
    if (existsSync(preferred)) {
      accessSync(preferred, fsConstants.W_OK);
      ok = true;
    } else {
      // 唔存在：試建（boot 時建一次係合理嘅）
      await mkdirWithTimeout(preferred, 5000);
      ok = true;
    }
  } catch {
    ok = false;
  }
  if (ok) return { status: "ok", dir: preferred };
  return { status: isProduction() ? "error" : "dev-fallback", dir: preferred };
}

// ── 落盤 / 讀取（加密透明層） ─────────────────────────────────────────────

/**
 * 寫媒體檔（落地即加密）。回文件路徑。
 * - 有 key → AES-256-GCM 密文落碟；冇 key（dev）→ 明文
 * - 冪等：已存在且 disk size 相同 → 唔重寫（AES-GCM size 定長映射，語義同明文時代一致；
 *   legacy 明文舊檔 size 同密文唔同 → 會重寫成密文，自然遷移）
 * - 檔案 0600
 */
export async function saveMediaFile(fileName: string, plain: Buffer): Promise<string> {
  const dir = await ensureMediaDir();
  const filePath = path.join(dir, path.basename(fileName));
  const key = getMediaKey(); // production 冇 key → throw（落碟前就爆，唔留明文）
  const diskBuf = key ? encryptMedia(plain, key) : plain;

  try {
    const st = await stat(filePath);
    if (st.size === diskBuf.length) {
      return filePath; // 冪等：已存在（webhook 重發場景）
    }
  } catch {
    /* 唔存在，照寫 */
  }

  await writeFile(filePath, diskBuf);
  await chmod(filePath, 0o600).catch(() => undefined);
  return filePath;
}

/**
 * 讀媒體檔（serve 時解密）— 對 call site 透明，回明文。
 * - 有 magic → 解密（key 必需；auth 失敗 → throw = 檔損/鍵錯）
 * - 冇 magic → legacy 明文（dev 冇 key 環境；production 有 key 時 = 上線前舊檔，
 *   照 serve 但響亮 warn 一次 — 新檔全部會係密文，舊檔隨時間自然被覆蓋）
 */
export async function readMediaFile(fileName: string): Promise<Buffer> {
  const dir = mediaDirPreferred();
  const filePath = path.join(dir, path.basename(fileName));
  let buf: Buffer;
  try {
    const { readFile } = await import("node:fs/promises");
    buf = await readFile(filePath);
  } catch {
    throw new MediaDirError(filePath, "read failed");
  }

  if (isEncryptedMedia(buf)) {
    const key = getMediaKey();
    if (!key) {
      // 檔係密文但冇 key（dev 環境遺忘 / key 洩漏後 rotation 中）
      log.error({ file: fileName }, "media: 檔案係密文但 MEDIA_ENC_KEY 未設 — 解唔到");
      throw new MediaKeyError("file is encrypted but MEDIA_ENC_KEY is not set");
    }
    return decryptMedia(buf, key);
  }

  // legacy 明文
  if (getMediaKeyStrictOrNull() !== null) {
    if (!warnedLegacy) {
      warnedLegacy = true;
      log.warn({ file: fileName }, "media: 偵測到 legacy 明文檔（無 magic prefix）— 有 key 環境下新檔會係密文");
    }
  }
  return buf;
}

let warnedLegacy = false;

/** 只為 legacy 偵測 warn 用：key 有無（唔 throw — 偵測路徑唔應該改行為）。 */
function getMediaKeyStrictOrNull(): Buffer | null {
  const raw = (process.env.MEDIA_ENC_KEY ?? "").trim();
  if (!raw) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new MediaKeyError("MEDIA_ENC_KEY 格式壞 — 要 32 bytes hex（64 個 0-9a-f 字符）");
  return Buffer.from(raw, "hex");
}

// ── boot 總檢查（server.ts 啟動時調） ─────────────────────────────────────

/**
 * 啟動時 security assertion（安全審計 C-1「未加密碟冇得靜默」）：
 * - production + DISK_ENCRYPTED=1 未設 → log ERROR（碟級加密未確認；LUKS/雲碟加密做完先設）
 * - production + media dir 唔可用 → log ERROR（fail-fast 生效中 — 媒體下載會全部 skip）
 * - dev + 冇 MEDIA_ENC_KEY → log WARN（明文模式提示）
 */
export async function bootMediaSecurityCheck(): Promise<void> {
  if (isProduction()) {
    if (process.env.DISK_ENCRYPTED !== "1") {
      log.error(
        {},
        "boot: ⚠️ DISK_ENCRYPTED=1 未設 — production 碟級 at-rest 加密未確認（開 LUKS/雲碟加密先設呢個 env；見 deploy runbook）"
      );
    }
  }
  const media = await checkMediaBoot();
  if (media.status === "error") {
    log.error(
      { dir: media.dir },
      "boot: ⚠️ media dir 唔可用（production fail-fast — 媒體下載會全部 skip，直到目錄修好）"
    );
  } else if (media.status === "ok" && !isProduction() && !(process.env.MEDIA_ENC_KEY ?? "").trim()) {
    // dev 明文提示（getMediaKey 首次寫入時亦會再 warn 一次）
    log.warn({ dir: media.dir }, "boot: dev mode + MEDIA_ENC_KEY 未設 — 媒體明文落地（sandbox 可接受）");
  }
}

/**
 * 下載 WA 媒體落本地（落地即加密 — 見 saveMediaFile）。
 * 回 mediaPath（成功）或 null（跳過/失敗 — Message 照寫）。
 * 失敗唔 throw：媒體落地失敗唔應該阻塞整條 inbound pipeline（訊息本身要入 inbox）—
 * 但 production fail-fast（MediaDirError/MediaKeyError）要 log ERROR 級（唔准静默）。
 */
export async function downloadWaMedia(opts: {
  mediaId: string;
  wamid: string;
}): Promise<{ mediaPath: string | null; skipped: boolean; reason?: string }> {
  const { mediaId, wamid } = opts;

  if (waMock()) {
    log.info({ mediaId, wamid, mock: true }, "media: mock mode — download skipped");
    return { mediaPath: null, skipped: true, reason: "mock" };
  }

  try {
    const info = await getMediaInfo(mediaId);
    const ext = MIME_EXT[info.mimeType] ?? "bin";

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

    const filePath = await saveMediaFile(`${wamid}.${ext}`, buf);
    log.info({ mediaId, wamid, bytes: buf.byteLength, path: filePath, encrypted: getMediaKey() !== null }, "media: saved");
    return { mediaPath: filePath, skipped: false };
  } catch (err) {
    if (err instanceof MediaDirError || err instanceof MediaKeyError) {
      // fail-fast 條件（production 目錄/key）— ERROR 級：呢個係需要人處理嘅部署問題
      log.error(
        { mediaId, wamid, err: err.message },
        "media: fail-fast（dir/key 部署問題）— 媒體 skip 落碟，inbox 唔受阻"
      );
      return { mediaPath: null, skipped: true, reason: "media-fail-fast" };
    }
    log.warn(
      { mediaId, wamid, err: err instanceof Error ? err.message : String(err) },
      "media: download failed"
    );
    return { mediaPath: null, skipped: true, reason: "error" };
  }
}

/**
 * unit-wa-media.ts — WhatsApp inbound 媒體 id + MIME 副檔名（零 DB / 零 network）
 *
 * 2026-10-25 回歸：真 webhook 用 `id`（唔係 `media_id`）；語音 mime 帶參數 "audio/ogg; codecs=opus"。
 */
import assert from "node:assert";
import { mediaIdOf } from "../src/lib/wa/media-id";
import { mediaExt } from "../src/lib/wa/media";

/** webhook message 原樣（測試用寬鬆型別） */
const wa = (o: Record<string, unknown>) => o as { type?: string };

let pass = 0;
function t(name: string, fn: () => void): void {
  fn();
  pass++;
  console.log(`  ✓ ${name}`);
}

console.log("[unit-wa-media] mediaIdOf");
t("真 webhook 語音：audio.id", () => {
  assert.strictEqual(mediaIdOf(wa({ type: "audio", audio: { id: "123", mime_type: "audio/ogg; codecs=opus", voice: true } })), "123");
});
t("真 webhook 相片／文件：image.id / document.id", () => {
  assert.strictEqual(mediaIdOf(wa({ type: "image", image: { id: "img1", mime_type: "image/jpeg" } })), "img1");
  assert.strictEqual(mediaIdOf(wa({ type: "document", document: { id: "doc1", filename: "a.pdf" } })), "doc1");
});
t("舊 fixture media_id 兼容", () => {
  assert.strictEqual(mediaIdOf(wa({ type: "image", image: { media_id: "old1" } })), "old1");
});
t("非媒體／冇 id → undefined", () => {
  assert.strictEqual(mediaIdOf(wa({ type: "text", text: { body: "hi" } })), undefined);
  assert.strictEqual(mediaIdOf(wa({ type: "audio", audio: {} })), undefined);
});

console.log("[unit-wa-media] mediaExt");
t("WhatsApp 語音 mime 帶參數 → ogg", () => {
  assert.strictEqual(mediaExt("audio/ogg; codecs=opus"), "ogg");
  assert.strictEqual(mediaExt("AUDIO/OGG;codecs=opus"), "ogg");
});
t("其他語音格式", () => {
  assert.strictEqual(mediaExt("audio/mpeg"), "mp3");
  assert.strictEqual(mediaExt("audio/mp4"), "m4a");
  assert.strictEqual(mediaExt("audio/aac"), "aac");
  assert.strictEqual(mediaExt("audio/amr"), "amr");
});
t("相片 / pdf / 未知", () => {
  assert.strictEqual(mediaExt("image/jpeg"), "jpg");
  assert.strictEqual(mediaExt("application/pdf"), "pdf");
  assert.strictEqual(mediaExt("application/x-weird"), "bin");
  assert.strictEqual(mediaExt(null), "bin");
});

console.log(`\n[unit-wa-media] ${pass} passed`);

/**
 * gen-notify-urgent — 合成 public/notify-urgent.mp3（Part B B.3）。
 *
 * 規格：
 * - 0.7s 三聲（880Hz → 1318.5Hz → 1318.5Hz；與 message/notice 單聲 chime 明確不同）
 * - peak ≈ 0.05 — 對齊 playChime WebAudio gain 0.04（MD「音量一致」）
 * - 44100Hz mono 128kbps MP3（lamejs）
 *
 * 用法：node scripts/gen-notify-urgent.mjs  → public/notify-urgent.mp3
 *（一次性資產生成；音檔入 repo，唔要每次 build 重生成）
 *
 * 依賴：@breezystack/lamejs（唔係 repo 正式依賴 — 重生成時：
 *   mkdir -p /tmp/mp3gen && cd /tmp/mp3gen && npm init -y >/dev/null && npm i @breezystack/lamejs
 *   然後 repo 內：mkdir -p node_modules/@breezystack && ln -s /tmp/mp3gen/node_modules/@breezystack/lamejs node_modules/@breezystack/lamejs
 *   或直接：npm i -D @breezystack/lamejs（生成完可卸，音檔已入 repo））
 */
import { Mp3Encoder } from "@breezystack/lamejs";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SR = 44100;
const PEAK = 0.05; // ≈ playChime gain 0.04（WebAudio 正弦）
const BEEPS = [
  { t: 0.0, dur: 0.15, f: 880.0 },
  { t: 0.3, dur: 0.15, f: 1318.5 },
  { t: 0.55, dur: 0.15, f: 1318.5 },
];
const TOTAL = 0.7;
const N = Math.floor(TOTAL * SR);

const samples = new Float64Array(N);
for (const b of BEEPS) {
  const start = Math.floor(b.t * SR);
  const len = Math.floor(b.dur * SR);
  const atk = Math.floor(0.005 * SR); // 5ms attack/decay — 防 click
  for (let i = 0; i < len && start + i < N; i++) {
    const env =
      i < atk ? i / atk : i > len - atk ? Math.max(0, (len - i) / atk) : 1;
    samples[start + i] += PEAK * env * Math.sin(2 * Math.PI * b.f * (i / SR));
  }
}

// 16-bit PCM
const pcm = new Int16Array(N);
let maxAbs = 0;
for (let i = 0; i < N; i++) {
  const s = Math.max(-1, Math.min(1, samples[i]));
  pcm[i] = Math.round(s * 32767);
  maxAbs = Math.max(maxAbs, Math.abs(pcm[i]));
}

const enc = new Mp3Encoder(1, SR, 128);
const chunks = [];
const BLOCK = 1152;
for (let i = 0; i < N; i += BLOCK) {
  const block = pcm.subarray(i, Math.min(i + BLOCK, N));
  const mp3buf = enc.encodeBuffer(block);
  if (mp3buf.length > 0) chunks.push(Buffer.from(mp3buf));
}
const tail = enc.flush();
if (tail.length > 0) chunks.push(Buffer.from(tail));

const out =
  process.env.OUT_MP3 ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "notify-urgent.mp3");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat(chunks));
console.log(
  `NOTIFY-URGENT-OK bytes=${Buffer.concat(chunks).length} peak=${(maxAbs / 32767).toFixed(3)} dur=${TOTAL}s`
);

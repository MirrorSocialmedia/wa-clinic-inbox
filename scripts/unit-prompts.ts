/**
 * unit-prompts — msgLine unit tests
 *
 * 範圍（零 DB / 零網絡 — 只 pure 邏輯）：
 *   1. msgLine guard：channel=INTERNAL → `[internal-note]`（零內容出 prompt）
 *   2. msgLine guard：type=note → `[internal-note]`（第二重：就算 channel 唔係 INTERNAL）
 *   3. 回歸：普通 IN text 訊息格式（★ W-S4-7 P2-09：一行一條 JSON.stringify({dir, ts, text})）
 *   4. 回歸：非 text 但非 note（media）text 欄 `[type body]` 格式保留
 *
 * 用法（repo root）：pnpm test:unit-prompts
 * 退出碼：0 = 全過；1 = 有 fail
 */
import { msgLine } from "../src/lib/ai/prompts";
import type { AiContextMessage } from "../src/lib/ai/types";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ts = new Date("2026-08-25T10:20:30Z");
const base: AiContextMessage = {
  direction: "IN",
  channel: "WHATSAPP",
  type: "text",
  body: "你哋幾點開門",
  waTimestamp: ts,
};

console.log("[1] msgLine guard — INTERNAL/note 零內容出 prompt");
check(
  "channel=INTERNAL → [internal-note]（零內容）",
  msgLine({ ...base, channel: "INTERNAL", type: "note", body: "備註：投訴處理中 內部討論" }) ===
    JSON.stringify({ dir: "out", ts: null, text: "[internal-note]" }),
  msgLine({ ...base, channel: "INTERNAL", type: "note", body: "備註：投訴處理中 內部討論" })
);
check(
  "type=note（channel 唔係 INTERNAL 都擋 — 第二重）→ [internal-note]",
  msgLine({ ...base, type: "note", body: "內部討論：投訴" }) ===
    JSON.stringify({ dir: "out", ts: null, text: "[internal-note]" }),
  msgLine({ ...base, type: "note", body: "內部討論：投訴" })
);
check(
  "note body 含「投訴」都唔 leak 出",
  !msgLine({ ...base, channel: "INTERNAL", type: "note", body: "投訴" }).includes("投訴")
);

console.log("[2] 回歸 — ★ W-S4-7（P2-09）：一行一條 JSON.stringify({dir, ts, text})");
check(
  "IN text → {dir:in, ts, text}",
  msgLine(base) === JSON.stringify({ dir: "in", ts: "2026-08-25 10:20", text: "你哋幾點開門" }),
  msgLine(base)
);
check(
  "OUT text → {dir:out, ts, text}",
  msgLine({ ...base, direction: "OUT" }) ===
    JSON.stringify({ dir: "out", ts: "2026-08-25 10:20", text: "你哋幾點開門" }),
  msgLine({ ...base, direction: "OUT" })
);
check(
  "非 text 非 note（media）→ text 欄 [image body] 格式保留",
  msgLine({ ...base, direction: "IN", type: "image", body: "photo.jpg" }) ===
    JSON.stringify({ dir: "in", ts: "2026-08-25 10:20", text: "[image photo.jpg]" }),
  msgLine({ ...base, direction: "IN", type: "image", body: "photo.jpg" })
);
check(
  "text body=null → text 空字串 唔 crash",
  msgLine({ ...base, body: null }) === JSON.stringify({ dir: "in", ts: "2026-08-25 10:20", text: "" })
);

if (failures > 0) {
  console.error(`\nunit-prompts: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nunit-prompts: ALL PASS");

/**
 * unit-reopen-reply — cwi-consult-d1-20260913（consult-audit §4 D-1 拍板 (b)）pure unit tests
 *
 * 範圍（零 DB / 零網絡 — 只 pure 邏輯）：
 *   1. isReopenedFirstReply 首句判斷（reopenedAt vs lastOutboundAt；null 邊界 + string 輸入）
 *   2. hasComplaintSignal ③ 訊號詞（拍板 5 詞齊核 — 含 cwi-consult-d1 補齊嘅「之前講過」）
 *   3. isReopenedFirstReplySafe 三條件決策（齊 → safe；任一唔中 → block + reasons token）
 *
 * 用法（repo root）：pnpm test:unit-reopen-reply
 * 退出碼：0 = 全過；1 = 有 fail
 */
import {
  REOPEN_COMPLAINT_SIGNALS,
  REOPEN_AUTO_REPLY_MIN_DAYS,
  isReopenedFirstReply,
  hasComplaintSignal,
  isReopenedFirstReplySafe,
} from "../src/lib/reopen-reply";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passes++;
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── fixtures（now 固定 — 決定性） ─────────────────────────────────────
const NOW = new Date("2026-09-13T06:00:00.000Z");
const D = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

// ── [1] isReopenedFirstReply：首句判斷 ────────────────────────────────
console.log("\n[1] isReopenedFirstReply（reopenedAt vs lastOutboundAt）");
{
  check("reopenedAt=null（新對話）→ false（閘唔生效）", isReopenedFirstReply({ reopenedAt: null, lastOutboundAt: null }) === false);
  check("翻開 + 未發過 OUT（lastOutboundAt=null）→ true（首句）", isReopenedFirstReply({ reopenedAt: D(0), lastOutboundAt: null }) === true);
  check("lastOutboundAt < reopenedAt → true（首句未覆）", isReopenedFirstReply({ reopenedAt: D(0), lastOutboundAt: D(1) }) === true);
  check("lastOutboundAt == reopenedAt → true（邊界：未有任何 OUT 嚴格喺翻開後）", isReopenedFirstReply({ reopenedAt: D(0), lastOutboundAt: D(0) }) === true);
  check("lastOutboundAt > reopenedAt → false（第二句起 — 閘失效）", isReopenedFirstReply({ reopenedAt: D(0), lastOutboundAt: D(0).replace("T06", "T07") }) === false);
  // string 輸入（DB 讀返係 Date；API 層可能傳 string — 都要正確）
  const rs = { reopenedAt: "2026-09-10T06:00:00.000Z", lastOutboundAt: "2026-09-09T06:00:00.000Z" } as { reopenedAt: Date | string | null; lastOutboundAt: Date | string | null };
  check("string 輸入（ISO）→ true", isReopenedFirstReply(rs) === true);
}

// ── [2] hasComplaintSignal ③：拍板 5 詞齊核 ──────────────────────────
console.log("\n[2] hasComplaintSignal（拍板清單 = 5 詞，每詞獨立命中）");
{
  check("清單 = 5 詞（上次/點解/仲未/都話咗/之前講過）", REOPEN_COMPLAINT_SIGNALS.length === 5 && ["上次", "點解", "仲未", "都話咗", "之前講過"].every((s) => (REOPEN_COMPLAINT_SIGNALS as readonly string[]).includes(s)), JSON.stringify(REOPEN_COMPLAINT_SIGNALS));
  for (const s of ["上次", "點解", "仲未", "都話咗", "之前講過"]) {
    check(`raw 含「${s}」→ true`, hasComplaintSignal(`我問你哋${s}啊`) === true);
  }
  check("raw=null → false", hasComplaintSignal(null) === false);
  check("raw='' → false", hasComplaintSignal("") === false);
  check("無訊號（純 QUESTION 口吻）→ false", hasComplaintSignal("你哋幾點閂門？") === false);
  check("訊號詞只喺 canonical（raw 唔中）→ true（雙比對）", hasComplaintSignal("I want to ask again about last time closing hours", "上次你哋話幾點閂門") === true);
  check("raw 命中 + canonical 唔命中 → true（任一分支）", hasComplaintSignal("上次嘅回覆好慢", "closing hours query") === true);
  check("子串匹配（詞嵌喺句中間）→ true", hasComplaintSignal("上次我問過一次") === true);
  check("唔含任何訊號詞子串 → false", hasComplaintSignal("想預約下週有冇位") === false);
}

// ── [3] isReopenedFirstReplySafe：三條件決策 ─────────────────────────
console.log("\n[3] isReopenedFirstReplySafe（三條件齊 → safe；任一唔中 → block）");
{
  const base = { intent: "QUESTION", lastResolvedAt: D(10), raw: "你哋幾點閂門？", now: NOW };
  check("三條件齊（QUESTION + 10日 + 無訊號）→ safe，reasons 空", isReopenedFirstReplySafe(base).safe === true && isReopenedFirstReplySafe(base).reasons.length === 0, JSON.stringify(isReopenedFirstReplySafe(base)));

  // ① intent：QUESTION 以外一律 block（PAIN/BOOKING/COMPLAINT/URGENT 全部）
  for (const intent of ["BOOKING_REQUEST", "PAIN", "COMPLAINT", "URGENT_PAIN", "OUT_OF_SCOPE", "OTHER"]) {
    const r = isReopenedFirstReplySafe({ ...base, intent });
    check(`① intent=${intent} → block（reasons 含 intent）`, r.safe === false && r.reasons.includes("intent"), JSON.stringify(r.reasons));
  }

  // ② 距離：strict > 7 日
  check(`② 恰 7 日 → block（strict >，reasons 含 age）`, isReopenedFirstReplySafe({ ...base, lastResolvedAt: D(REOPEN_AUTO_REPLY_MIN_DAYS) }).safe === false);
  const d7plus = new Date(NOW.getTime() - (7 * 86_400_000 + 1));
  check("② 7 日 + 1ms（手算 Date）→ safe", isReopenedFirstReplySafe({ ...base, lastResolvedAt: d7plus }).safe === true);
  check("② 2 日 → block（age）", isReopenedFirstReplySafe({ ...base, lastResolvedAt: D(2) }).safe === false);
  const unk = isReopenedFirstReplySafe({ ...base, lastResolvedAt: null });
  check("② lastResolvedAt=null（不可導出）→ block（age-unknown — 保守 DRAFT）", unk.safe === false && unk.reasons.includes("age-unknown"), JSON.stringify(unk.reasons));

  // ③ 訊號詞（每詞獨立 block）
  for (const s of ["上次", "點解", "仲未", "都話咗", "之前講過"]) {
    const r = isReopenedFirstReplySafe({ ...base, raw: `你哋${s}幾點閂門？` });
    check(`③ 訊號「${s}」→ block（reasons 含 signal）`, r.safe === false && r.reasons.includes("signal"), JSON.stringify(r.reasons));
  }

  // 組合：多條唔中 → 多 reasons（唔早退）
  const combo = isReopenedFirstReplySafe({ intent: "PAIN", lastResolvedAt: D(1), raw: "上次話仲未好" });
  check("組合（PAIN + 1日 + 雙訊號）→ 3 reasons（intent+age+signal）", combo.safe === false && combo.reasons.length === 3, JSON.stringify(combo.reasons));
}

// ── summary ───────────────────────────────────────────────────────────
console.log(`\n${passes + failures} checks: ${passes} pass / ${failures} fail`);
process.exit(failures > 0 ? 1 : 0);

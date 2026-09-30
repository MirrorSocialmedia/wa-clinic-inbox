/**
 * FX-11 unit test — booking-card 寫入態 banner / 主動作掣決定（QA-11：MANUAL_RECONCILE 黃卡）
 *
 * 運行：TZ=UTC npx tsx --test src/components/inbox/booking-card.test.ts
 *   （pure function — 零 DB / 零 Redis / 零 DOM）
 *
 * 背景：workforce 502 + code MANUAL_RECONCILE（F 側自己未能確認結果 — 有冇寫到 Apricot
 * 要人手核對）→ 卡上舊版落入通用 FAILED 紅字「落單失敗 — 可撳〔重試（同一單號）〕」+
 * 顯示重試掣 = 誤導（先入 Apricot 核對先講得落單/重試）。
 * 修：writeError==="MANUAL_RECONCILE" → 黃卡「Apricot 狀態要人手核對 — 先入 Apricot 睇有冇呢位病人」
 * + 唔顯示普通〔重試〕掣（顯示「要人手核對」提示）。
 *
 * 決定邏輯抽成 pure（bookingWriteBanner / bookingPrimaryAction）— repo 慣例
 * （同 formatMmSs / rollbackButtonVisible）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bookingWriteBanner, bookingPrimaryAction } from "./booking-card";

// ── banner ─────────────────────────────────────────────────────────────

test("banner：WRITING → writing（轉圈）", () => {
  assert.deepEqual(bookingWriteBanner("WRITING", null), { kind: "writing" });
});

test("banner：UNKNOWN → unknown（黃 — 唔好人手落單，可重試）", () => {
  assert.deepEqual(bookingWriteBanner("UNKNOWN", "timeout"), { kind: "unknown" });
});

test("banner：FAILED + MANUAL_RECONCILE → manual_reconcile（黃卡 — 唔係通用 FAILED 紅字）", () => {
  assert.deepEqual(bookingWriteBanner("FAILED", "MANUAL_RECONCILE"), { kind: "manual_reconcile" });
});

test("banner：FAILED + WRITE_DISABLED → write_disabled（黃 — 舊語義）", () => {
  assert.deepEqual(bookingWriteBanner("FAILED", "WRITE_DISABLED"), { kind: "write_disabled" });
});

test("banner：FAILED + SLOT_TAKEN → none（卡頭已經係撞單陶土變體 — 呢度唔再出帶）", () => {
  assert.deepEqual(bookingWriteBanner("FAILED", "SLOT_TAKEN"), { kind: "none" });
});

test("banner：FAILED + 其他 code（timeout / HTTP_500…）→ failed（紅字 + code）", () => {
  assert.deepEqual(bookingWriteBanner("FAILED", "timeout"), { kind: "failed", code: "timeout" });
  assert.deepEqual(bookingWriteBanner("FAILED", "HTTP_500"), { kind: "failed", code: "HTTP_500" });
});

test("banner：null / null → none", () => {
  assert.deepEqual(bookingWriteBanner(null, null), { kind: "none" });
});

// ── 主動作掣 ───────────────────────────────────────────────────────────

test("primary：pinned + UNKNOWN → retry（重試（同一單號））", () => {
  assert.equal(bookingPrimaryAction(true, "UNKNOWN", "timeout"), "retry");
});

test("primary：pinned + FAILED + MANUAL_RECONCILE → manual_reconcile（唔係 retry — 唔顯示重試掣）", () => {
  assert.equal(bookingPrimaryAction(true, "FAILED", "MANUAL_RECONCILE"), "manual_reconcile");
});

test("primary：pinned + FAILED + 其他 code → retry", () => {
  assert.equal(bookingPrimaryAction(true, "FAILED", "timeout"), "retry");
});

test("primary：pinned + FAILED + WRITE_DISABLED → create（提示已人手落單 — 舊語義）", () => {
  assert.equal(bookingPrimaryAction(true, "FAILED", "WRITE_DISABLED"), "create");
});

test("primary：pinned + null/null → create（幫我喺 Apricot 落單）", () => {
  assert.equal(bookingPrimaryAction(true, null, null), "create");
});

test("primary：pinned + WRITING → create 掣但 disabled（writing 由 JSX disabled 管）— 決定值 = create", () => {
  assert.equal(bookingPrimaryAction(true, "WRITING", null), "create");
});

test("primary：未 pinned → unpinned（提示先釘 — 任何 writeState）", () => {
  assert.equal(bookingPrimaryAction(false, "UNKNOWN", "timeout"), "unpinned");
  assert.equal(bookingPrimaryAction(false, "FAILED", "MANUAL_RECONCILE"), "unpinned");
});

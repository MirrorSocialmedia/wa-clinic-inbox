/**
 * unit-session-engine — Phase C（cwi-sess-20260824-c1）slot-filling engine pure unit tests
 *
 * 範圍（零 DB / 零網絡 — 只 pure 邏輯）：
 *   1. 逃生口四連：URGENT / HUMAN / CANCEL / turns=12
 *   2. noProgress 三次 → HANDOFF
 *   3. mergeSlots：模糊對應（includes/去空格/大小寫不敏感）命中/唔命中；null 唔覆蓋舊值
 *   4. validateSelection：過去日期 / 非開診日 / slot-taken / 窗口外
 *   5. 齊料 → CONFIRMING + confirmLine 文字 fixture
 *   6. CONFIRMING + CONFIRM 三態（L3 卡 / L4+pinned 自動落單 / L4 無 pinned 降 L3）
 *   7. CONFIRMING + 改主意 → 重確認 / 跌返 ACTIVE
 *   8. degraded NONE → SEND_FLOW + ABANDONED；STALE_* → 照行 + 免責尾句
 *   9. candidateText ≤5 個、只列 open、filter 已揀 provider
 *   10. parseSessionOutput：壞 JSON / 壞 date 格式 → null 化；壞 action → CONTINUE
 *   11. buildReply（事實鐵律兜底）：數字時間 / >2 句 → 棄用
 *   12. automation resolveLevel：exact > star > legacy 三級 fallback；cap 壓頂
 *
 * 用法（repo root）：pnpm test:unit-session-engine（repo 慣例 = tsx 跑 scripts/unit-*.ts）
 * 退出碼：0 = 全過；1 = 有 fail
 */
import {
  step,
  mergeSlots,
  didProgress,
  validateSelection,
  candidateText,
  confirmLine,
  buildReply,
  fmtDateShort,
  fmtDateFull,
  MAX_TURNS,
  type StepCtx,
  type StepResult,
} from "../src/lib/booking/session-engine";
import { resolveLevel, globalCap, minLevel, asLevel } from "../src/lib/ai/automation";
import { SESSION_DEFAULTS } from "../src/lib/workflow/definitions";
import { parseSessionOutput } from "../src/lib/ai";
import { AiCallError } from "../src/lib/ai/types";
import type { SessionAiOutput, SessionSlots } from "../src/lib/ai/session-types";
import type { GetSlotsResult, SlotRow } from "../src/lib/availability";

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

// ── fixtures ─────────────────────────────────────────────────────────
const TODAY = "2026-08-31"; // hkToday mock 錨
const PROVIDERS = [
  { apricotId: "p1", name: "陳明軒 (owner)" },
  { apricotId: "p2", name: "李婉如" },
];

function row(providerApricotId: string, date: string, startTime: string, over: Partial<SlotRow> = {}): SlotRow {
  return {
    providerApricotId,
    date,
    startTime,
    endTime: "10:30",
    bookedCount: 0,
    isOpen: true,
    ...over,
  };
}

function slotsData(over: Partial<GetSlotsResult> = {}): GetSlotsResult {
  return {
    slots: [
      row("p1", "2026-09-01", "10:00"),
      row("p1", "2026-09-01", "10:30", { isOpen: false }), // 滿位（mock：isOpen=false = taken）
      row("p1", "2026-09-01", "15:00"),
      row("p1", "2026-09-01", "16:00", { bookedCount: 1 }), // mock 填位形态：isOpen=true 但已滿（bookedCount>0）
      row("p2", "2026-09-01", "10:00"),
      row("p1", "2026-09-02", "15:00"),
      row("p1", "2026-09-02", "10:00", { isOpen: false }),
    ],
    degraded: null,
    fromCache: false,
    window: { start: "2026-09-01", end: "2026-09-30" },
    ...over,
  };
}

function ai(out: Partial<SessionAiOutput> = {}): SessionAiOutput {
  return {
    slotUpdates: { providerName: null, date: null, time: null, timeOfDay: null },
    action: "CONTINUE",
    reply: "收到！",
    ...out,
  };
}

function sess(slots: SessionSlots, over: Partial<{ status: string; turns: number; noProgress: number }> = {}) {
  return {
    slots,
    status: over.status ?? "ACTIVE",
    turns: over.turns ?? 0,
    noProgress: over.noProgress ?? 0,
  };
}

const emptySlots: SessionSlots = { providerApricotId: null, providerName: null, date: null, time: null, timeOfDay: null };
const completeSlots: SessionSlots = {
  providerApricotId: "p1",
  providerName: "陳明軒 (owner)",
  date: "2026-09-01",
  time: "15:00",
  timeOfDay: null,
};

function ctx(over: Partial<StepCtx> = {}): StepCtx {
  return { todayHk: TODAY, level: "L3", providers: PROVIDERS, pinnedPatient: false, ...over };
}

const effectsOf = (r: StepResult) => r.effects.map((e) => e.kind);

// ── 1. 逃生口四連 ─────────────────────────────────────────────────────
console.log("[1] 逃生口四連（URGENT / HUMAN / CANCEL / turns 超限）");
{
  const r = step(sess(emptySlots), ai({ action: "URGENT" }), slotsData(), ctx());
  check("URGENT → HANDOFF", r.patch.status === "HANDOFF");
  check("URGENT → URGENT_ESCALATE", effectsOf(r).includes("URGENT_ESCALATE"));
  check("URGENT → 唔覆（replyText null）", r.replyText === null);

  const r2 = step(sess(emptySlots), ai({ action: "HUMAN" }), slotsData(), ctx());
  check("HUMAN → HANDOFF + NOTIFY_STAFF", r2.patch.status === "HANDOFF" && effectsOf(r2).includes("NOTIFY_STAFF"));
  check("HUMAN → 覆「職員好快覆你」", r2.replyText === "收到，我哋職員好快覆你 🙏");

  const r3 = step(sess(emptySlots), ai({ action: "CANCEL" }), slotsData(), ctx());
  check("CANCEL → CANCELLED + 零 effect", r3.patch.status === "CANCELLED" && r3.effects.length === 0);
  check("CANCEL → 有覆（禮貌收尾）", r3.replyText !== null);

  const r4 = step(sess(emptySlots, { turns: MAX_TURNS - 1 }), ai(), slotsData(), ctx());
  check(`turns=${MAX_TURNS} → HANDOFF + NOTIFY_STAFF`, r4.patch.status === "HANDOFF" && effectsOf(r4).includes("NOTIFY_STAFF"));
}

// ── 2. noProgress 三次 → HANDOFF ──────────────────────────────────────
console.log("[2] noProgress 三次 → HANDOFF");
{
  const r = step(sess(emptySlots, { noProgress: 2 }), ai({ reply: "明白～" }), slotsData(), ctx());
  check("noProgress 3 → HANDOFF", r.patch.status === "HANDOFF");
  check("noProgress 3 → NOTIFY_STAFF（冇進展）", effectsOf(r).includes("NOTIFY_STAFF"));
  const r2 = step(
    sess(emptySlots, { noProgress: 2 }),
    ai({ slotUpdates: { providerName: null, date: "2026-09-01", time: null, timeOfDay: null } }),
    slotsData(),
    ctx()
  );
  check("有 slot 更新 → noProgress 重置（唔 HANDOFF）", r2.patch.noProgress === 0 && r2.patch.status !== "HANDOFF");
}

// ── 3. mergeSlots：模糊對應 / 唔命中 / null 唔覆蓋 ────────────────────
console.log("[3] mergeSlots");
{
  const m1 = mergeSlots(emptySlots, { providerName: "陳明軒", date: null, time: null, timeOfDay: null }, PROVIDERS);
  check("全名「陳明軒」命中「陳明軒 (owner)」", m1.providerApricotId === "p1" && m1.providerName === "陳明軒 (owner)");

  const m1b = mergeSlots(emptySlots, { providerName: "陳 明 軒", date: null, time: null, timeOfDay: null }, PROVIDERS);
  check("去空格後命中", m1b.providerApricotId === "p1");

  const m2 = mergeSlots(emptySlots, { providerName: "陳醫生", date: null, time: null, timeOfDay: null }, PROVIDERS);
  check("對唔到 roster（includes 匹唔中）→ 唔寫", m2.providerApricotId == null && m2.providerName == null);

  const en = [{ apricotId: "e1", name: "Dr. Wong Ka-Fai" }];
  const m3 = mergeSlots(emptySlots, { providerName: "dr. wong", date: null, time: null, timeOfDay: null }, en);
  check("大小寫不敏感命中", m3.providerApricotId === "e1");

  const m4 = mergeSlots({ ...completeSlots }, { providerName: null, date: null, time: null, timeOfDay: null }, PROVIDERS);
  check("null 唔覆蓋舊值", m4.providerName === "陳明軒 (owner)" && m4.date === "2026-09-01" && m4.time === "15:00");

  check("didProgress：null→有值", didProgress(emptySlots, { ...emptySlots, date: "2026-09-01" }) === true);
  check("didProgress：重講一樣 = false", didProgress(completeSlots, { ...completeSlots }) === false);
}

// ── 4. validateSelection：過去 / 非開診 / slot-taken / 窗口外 ─────────
console.log("[4] validateSelection");
{
  const v1 = validateSelection({ ...emptySlots, date: "2026-08-30" }, slotsData(), TODAY);
  check("過去日期 → invalid-date", v1.kind === "invalid-date");
  const v2 = validateSelection({ ...emptySlots, date: "2026-09-03" }, slotsData(), TODAY);
  check("非開診日（無 row）→ invalid-date", v2.kind === "invalid-date");
  const v3 = validateSelection({ ...emptySlots, date: "2026-10-15" }, slotsData(), TODAY);
  check("超出窗口尾 → invalid-date", v3.kind === "invalid-date");
  const v4 = validateSelection(
    { ...emptySlots, providerApricotId: "p1", date: "2026-09-01", time: "10:30" },
    slotsData(),
    TODAY
  );
  check("滿位（isOpen=false）→ slot-taken", v4.kind === "slot-taken");
  const v5 = validateSelection(
    { ...emptySlots, providerApricotId: "p1", date: "2026-09-01", time: "15:00" },
    slotsData(),
    TODAY
  );
  check("open slot → ok", v5.kind === "ok");
  const v6 = validateSelection(
    { ...emptySlots, providerApricotId: "p1", date: "2026-09-01", time: "16:00" },
    slotsData(),
    TODAY
  );
  check("bookedCount>0（isOpen 但已滿）→ slot-taken", v6.kind === "slot-taken");

  // 全 step：slot-taken → 覆「滿咗」+ time 清返 null + 重列候選
  const r = step(
    sess({ ...emptySlots, providerApricotId: "p1", providerName: "陳明軒 (owner)", date: "2026-09-01" }),
    ai({ slotUpdates: { providerName: null, date: null, time: "10:30", timeOfDay: null } }),
    slotsData(),
    ctx()
  );
  check("slot-taken → 覆含「滿咗」", r.replyText !== null && r.replyText.includes("滿咗"));
  check("slot-taken → time 清返 null", r.patch.slots.time === null);
  check("slot-taken → session 續行（ACTIVE）", r.patch.status === "ACTIVE");

  // 全 step：過去日期 → 覆含原因 + 重列候選（清咗無效 date，唔係假象「暫無」）
  const r2 = step(
    sess(emptySlots),
    ai({ slotUpdates: { providerName: null, date: "2026-08-30", time: null, timeOfDay: null } }),
    slotsData(),
    ctx()
  );
  check("過去日期 → 覆含「已過」+ 仍列得出候選", r2.replyText !== null && r2.replyText.includes("已過") && r2.replyText.includes("10:00"));
}

// ── 5. 齊料 → CONFIRMING + confirmLine fixture ───────────────────────
console.log("[5] 齊料 → CONFIRMING + confirmLine");
{
  const r = step(
    sess({ ...emptySlots, providerApricotId: "p1", providerName: "陳明軒 (owner)", date: "2026-09-01" }),
    ai({ slotUpdates: { providerName: null, date: null, time: "15:00", timeOfDay: null } }),
    slotsData(),
    ctx()
  );
  check("齊料 → CONFIRMING", r.patch.status === "CONFIRMING");
  check(
    "confirmLine 入 reply",
    r.replyText !== null && r.replyText.includes("同你確認一次：9月1日 15:00 陳明軒 (owner)，啱唔啱？"),
    r.replyText ?? ""
  );
  check("confirmLine 獨立 fixture", confirmLine(completeSlots) === "同你確認一次：9月1日 15:00 陳明軒 (owner)，啱唔啱？");
  check("fmtDateShort", fmtDateShort("2026-09-01") === "9月1日");
  check("fmtDateFull", fmtDateFull("2026-09-01") === "9月1日(二)");
}

// ── 6. CONFIRMING + CONFIRM 三態 ──────────────────────────────────────
console.log("[6] CONFIRMING + CONFIRM");
{
  const base = sess(completeSlots, { status: "CONFIRMING", turns: 3 });
  const r3 = step(base, ai({ action: "CONFIRM" }), slotsData(), ctx({ level: "L3" }));
  check("L3 → COMPLETED + CREATE_CARD", r3.patch.status === "COMPLETED" && effectsOf(r3).includes("CREATE_CARD"));
  check("L3 → 覆「職員會好快幫你確認」", r3.replyText === "收到！職員會好快幫你確認 🙂");

  const r4a = step(base, ai({ action: "CONFIRM" }), slotsData(), ctx({ level: "L4", pinnedPatient: true }));
  check("L4+pinned → COMPLETED + AUTO_BOOK", r4a.patch.status === "COMPLETED" && effectsOf(r4a).includes("AUTO_BOOK"));
  check("L4+pinned → 唔覆（確認訊息由 confirm-core 出）", r4a.replyText === null);

  const r4b = step(base, ai({ action: "CONFIRM" }), slotsData(), ctx({ level: "L4", pinnedPatient: false }));
  check("L4 無 pinned → 降 L3 出 CREATE_CARD", effectsOf(r4b).includes("CREATE_CARD") && !effectsOf(r4b).includes("AUTO_BOOK"));
}

// ── 7. CONFIRMING + 改主意 ────────────────────────────────────────────
console.log("[7] CONFIRMING + 改主意");
{
  // 改去 09-02（有效 + 齊料）→ 重新確認
  const r = step(
    sess(completeSlots, { status: "CONFIRMING", turns: 3 }),
    ai({ slotUpdates: { providerName: null, date: "2026-09-02", time: null, timeOfDay: null } }),
    slotsData(),
    ctx()
  );
  check("改 date（仍齊料）→ 重新 CONFIRMING", r.patch.status === "CONFIRMING" && r.patch.slots.date === "2026-09-02");
  check("重新確認句用新日期", r.replyText !== null && r.replyText.includes("9月2日"));

  // 改去 09-03（非開診日）→ invalid-date → 跌返 ACTIVE 續收
  const r2 = step(
    sess(completeSlots, { status: "CONFIRMING", turns: 3 }),
    ai({ slotUpdates: { providerName: null, date: "2026-09-03", time: null, timeOfDay: null } }),
    slotsData(),
    ctx()
  );
  check("改 date（非開診日）→ 跌返 ACTIVE", r2.patch.status === "ACTIVE");
}

// ── 8. degraded NONE / STALE ──────────────────────────────────────────
console.log("[8] degraded NONE / STALE");
{
  const r = step(
    sess(emptySlots),
    ai({ slotUpdates: { providerName: "陳明軒", date: null, time: null, timeOfDay: null } }),
    slotsData({ degraded: "NONE", slots: null }),
    ctx()
  );
  check("NONE → ABANDONED + SEND_FLOW", r.patch.status === "ABANDONED" && effectsOf(r).includes("SEND_FLOW"));
  check("NONE → 唔覆（Flow 接力）", r.replyText === null);

  const r2 = step(
    sess({ ...emptySlots, providerApricotId: "p1", providerName: "陳明軒 (owner)" }),
    ai({ slotUpdates: { providerName: null, date: null, time: null, timeOfDay: null } }),
    slotsData({ degraded: "STALE_SOURCE" }),
    ctx()
  );
  check("STALE → 照行（ACTIVE）", r2.patch.status === "ACTIVE");
  check("STALE → candidateText 加免責尾句", r2.replyText !== null && r2.replyText.includes("（時段以最終確認為準）"));
}

// ── 9. candidateText ──────────────────────────────────────────────────
console.log("[9] candidateText");
{
  const t = candidateText(emptySlots, slotsData(), PROVIDERS);
  const lines = t.split("\n").filter((l) => /^\d/.test(l));
  check("≤5 個候選", lines.length <= 5 && lines.length >= 1, `got ${lines.length}`);
  check("只列 open（10:30 滿位唔出現）", !t.includes("10:30"));
  check("bookedCount>0 唔入候選（16:00 已滿）", !t.includes("16:00"));
  check("isOpen=false 唔出現（09-02 10:00）", !/9月2日\(三\) 10:00/.test(t));
  check("第一行 = 最近 open", lines[0] === "1️⃣ 9月1日(二) 10:00 陳明軒 (owner)", lines[0] ?? "");

  const t2 = candidateText({ ...emptySlots, providerApricotId: "p2" }, slotsData(), PROVIDERS);
  check("filter 已揀 provider（只李婉如）", t2.includes("李婉如") && !t2.includes("陳明軒"));

  const t3 = candidateText({ ...emptySlots, date: "2026-09-03" }, slotsData(), PROVIDERS);
  check("該日無 row → 兜底句", t3.includes("暫無空餘時段"));

  const t4 = candidateText({ ...emptySlots, timeOfDay: "AFTERNOON" }, slotsData(), PROVIDERS);
  check("timeOfDay filter（只 15:00）", t4.includes("15:00") && !t4.includes("10:00"));

  // ★ Fix C（cwi-fix-20260825-f1）：candidateCount=8（zod max）→ 行頭唔出 "undefined"、行數=8
  //   修前 NUM_EMOJI 只 5 個 → 第 6 行起 `NUM_EMOJI[i]` = undefined → "undefined 9月..." 行頭。
  const open8: SlotRow[] = [];
  for (const d of ["2026-09-01", "2026-09-02"]) {
    for (const t of ["10:00", "11:00", "14:00", "15:00"]) open8.push(row("p1", d, t));
  }
  const t8 = candidateText(emptySlots, slotsData({ slots: open8 }), PROVIDERS, { ...SESSION_DEFAULTS, candidateCount: 8 });
  const lines8 = t8.split("\n").filter((l) => /^\d/.test(l));
  check("candidateCount=8：零 undefined 字串", !t8.includes("undefined"), t8.slice(0, 200));
  check("candidateCount=8：行數 = 8", lines8.length === 8, `got ${lines8.length}`);
  check("candidateCount=8：第 8 行行頭 = 8️⃣", lines8[7]?.startsWith("8️⃣"), lines8[7] ?? "<missing>");
}

// ── 10. parseSessionOutput ────────────────────────────────────────────
console.log("[10] parseSessionOutput");
{
  let threw = false;
  try {
    parseSessionOutput("冇 JSON 嘅文字");
  } catch (e) {
    threw = e instanceof AiCallError;
  }
  check("壞 JSON（無 {}）→ AiCallError", threw);

  let threw2 = false;
  try {
    parseSessionOutput('{"action": "CONFIRM", "broken";');
  } catch (e) {
    threw2 = e instanceof AiCallError;
  }
  check("壞 JSON（截斷）→ AiCallError", threw2);

  const p1 = parseSessionOutput(
    '{"slotUpdates":{"providerName":null,"date":"2026-13-99","time":"15.30","timeOfDay":"MORNING"},"action":"CONFIRM","reply":"好呀"}'
  );
  check("壞 date 格式 → null", p1.slotUpdates.date === null);
  check("壞 time 格式 → null", p1.slotUpdates.time === null);
  check("timeOfDay 合法保留", p1.slotUpdates.timeOfDay === "MORNING");
  check("action 合法保留", p1.action === "CONFIRM");

  const p2 = parseSessionOutput(
    '{"slotUpdates":{"providerName":"陳明軒","date":"2026-09-01","time":"15:00","timeOfDay":null},"action":"FOO","reply":"x"}'
  );
  check("壞 action → CONTINUE", p2.action === "CONTINUE");
  check("合法 slot 保留", p2.slotUpdates.date === "2026-09-01" && p2.slotUpdates.time === "15:00");

  const long = "y".repeat(250);
  const p3 = parseSessionOutput(
    `{"slotUpdates":{"providerName":null,"date":null,"time":null,"timeOfDay":null},"action":"CONTINUE","reply":"${long}"}`
  );
  check("reply 截 200", p3.reply.length === 200);
}

// ── 11. buildReply（事實鐵律兜底）─────────────────────────────────────
console.log("[11] buildReply");
{
  check("正常語氣句 + 無事實 → 只出語氣", buildReply("收到！", null) === "收到！");
  check("含數字時間 → 棄用語氣，只出事實", buildReply("15:00 有位嘅", "候選 X") === "候選 X");
  check("3 句 → 棄用", buildReply("收到！9月1日得。我幫你查下。", null) === null);
  check("2 句 → 保留", buildReply("收到！我幫你睇下。", null) === "收到！我幫你睇下。");
  check("語氣 + 事實 join", buildReply("收到！", "候選 Y") === "收到！ 候選 Y");
}

// ── 12. automation（C0 unit）──────────────────────────────────────────
console.log("[12] automation resolveLevel / cap");
{
  check(
    "exact > star",
    resolveLevel(
      [
        { category: "BOOKING_REQUEST", level: "L3" },
        { category: "*", level: "L4" },
      ],
      "BOOKING_REQUEST",
      "DRAFT"
    ) === "L3"
  );
  check("star > legacy", resolveLevel([{ category: "*", level: "L4" }], "BOOKING_REQUEST", "DRAFT") === "L4");
  check("legacy DRAFT → L1", resolveLevel([], "BOOKING_REQUEST", "DRAFT") === "L1");
  check("legacy AUTO → L2", resolveLevel([], "QUESTION", "AUTO") === "L2");
  check("壞 level 值 → 跌 legacy", resolveLevel([{ category: "BOOKING_REQUEST", level: "L9" }], "BOOKING_REQUEST", "AUTO") === "L2");
  check("minLevel 壓頂", minLevel("L3", "L2") === "L2");
  check("asLevel 壞值 → null", asLevel("L9") === null && asLevel("L4") === "L4");

  const saved = process.env.AI_GLOBAL_MAX_LEVEL;
  process.env.AI_GLOBAL_MAX_LEVEL = "L2";
  check("cap L2 生效", globalCap() === "L2");
  delete process.env.AI_GLOBAL_MAX_LEVEL;
  check("cap 預設 L4", globalCap() === "L4");
  if (saved === undefined) delete process.env.AI_GLOBAL_MAX_LEVEL;
  else process.env.AI_GLOBAL_MAX_LEVEL = saved;
}

if (failures > 0) {
  console.error(`\nUNIT FAIL ❌（${failures} 項 / ${passes} 過）`);
  process.exit(1);
}
console.log(`\nUNIT PASS ✅（session-engine unit，${passes} 項）`);

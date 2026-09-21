/**
 * e2e-s13-t726 — cwi-final S1-13（D-6）T726：automation-stats EXPIRED 計入 pure unit test
 *
 * 範圍（spec S1-13 測試 T726）：
 *   `aggregateDraftRows`（src/lib/ops/automation-stats.ts）— EXPIRED 計入 `draftCount`、
 *   唔計 adopted（asIs/edited）／discarded／autoSent。
 *   零 DB / 零網絡（pure 函數）。
 *
 * 期望語義（spec 註）：
 *   - draftCount = 全部 status 總和（PROPOSED / EXPIRED 都計 — 只係尚未裁決 / 被擠出）
 *   - EXPIRED = 只計 draftCount（switch case "EXPIRED": break）— 不增任何採用/棄用欄
 *   - 對照組：PROPOSED 同樣只計 draftCount（水位一致）
 *
 * 用法（repo root）：pnpm tsx scripts/e2e-s13-t726.ts
 * 退出碼：0 = 全過；1 = 有 fail
 */
import { aggregateDraftRows, type DraftAggInput } from "../src/lib/ops/automation-stats";

let passes = 0;
let failures = 0;
function ok(msg: string): void {
  passes++;
  console.log(`  ✅ ${msg}`);
}
function fail(msg: string): void {
  failures++;
  console.log(`  ❌ ${msg}`);
}
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) ok(label);
  else fail(`${label}${detail !== undefined ? `（${JSON.stringify(detail)}）` : ""}`);
}

const CLINIC = "clinic-e2e-t726";
const CAT = "QUESTION";

function row(status: DraftAggInput["status"], intent: string | null = CAT, clinicId: string = CLINIC): DraftAggInput {
  return { clinicId, intent, status };
}

function main(): void {
  console.log("[T726] automation-stats：EXPIRED 計入 draftCount、唔計 adopted/discarded（pure unit）");

  // ── case 1：EXPIRED-only batch — 只 draftCount +N，其餘全 0 ────────────────
  {
    const agg = aggregateDraftRows([row("EXPIRED"), row("EXPIRED")]);
    const a = agg.get(`${CLINIC}|${CAT}`);
    check("c1: EXPIRED×2 → draftCount=2", a?.draftCount === 2, a);
    check("c1: EXPIRED 唔計 adoptedAsIs", a?.adoptedAsIs === 0, a);
    check("c1: EXPIRED 唔計 adoptedEdited", a?.adoptedEdited === 0, a);
    check("c1: EXPIRED 唔計 discarded", a?.discarded === 0, a);
    check("c1: EXPIRED 唔計 autoSent", a?.autoSent === 0, a);
  }

  // ── case 2：全 status 混合 — draftCount = 總和；各採用/棄用欄只計自己 ──────
  {
    const rows: DraftAggInput[] = [
      row("PROPOSED"),
      row("EXPIRED"),
      row("EXPIRED"),
      row("SENT_AS_IS"),
      row("SENT_EDITED"),
      row("DISCARDED"),
      row("SENT_AUTO"),
    ];
    const agg = aggregateDraftRows(rows);
    const a = agg.get(`${CLINIC}|${CAT}`);
    check("c2: 7 rows（含 2 EXPIRED + 1 PROPOSED）→ draftCount=7", a?.draftCount === 7, a);
    check("c2: SENT_AS_IS → adoptedAsIs=1", a?.adoptedAsIs === 1, a);
    check("c2: SENT_EDITED → adoptedEdited=1", a?.adoptedEdited === 1, a);
    check("c2: DISCARDED → discarded=1", a?.discarded === 1, a);
    check("c2: SENT_AUTO → autoSent=1", a?.autoSent === 1, a);
  }

  // ── case 3：EXPIRED 同 adopted/discarded 同類混算 — 隔離性（EXPIRED 唔污染）──
  {
    const rows: DraftAggInput[] = [
      row("EXPIRED"),
      row("SENT_AS_IS"),
      row("DISCARDED"),
    ];
    const agg = aggregateDraftRows(rows);
    const a = agg.get(`${CLINIC}|${CAT}`);
    check("c3: EXPIRED+SENT_AS_IS+DISCARDED → draftCount=3", a?.draftCount === 3, a);
    check("c3: adoptedAsIs 仍恰 1（EXPIRED 唔計入）", a?.adoptedAsIs === 1, a);
    check("c3: discarded 仍恰 1（EXPIRED 唔計入）", a?.discarded === 1, a);
    check("c3: adoptedEdited=0 / autoSent=0", a?.adoptedEdited === 0 && a?.autoSent === 0, a);
  }

  // ── case 4：意圖分組隔離 — EXPIRED 跟 intent 入各自類（null → UNKNOWN）─────
  {
    const rows: DraftAggInput[] = [row("EXPIRED", "BOOKING_REQUEST"), row("EXPIRED", null), row("EXPIRED")];
    const agg = aggregateDraftRows(rows);
    check("c4: BOOKING_REQUEST 類 draftCount=1", agg.get(`${CLINIC}|BOOKING_REQUEST`)?.draftCount === 1, agg);
    check("c4: null intent → UNKNOWN 類 draftCount=1", agg.get(`${CLINIC}|UNKNOWN`)?.draftCount === 1, agg);
    check("c4: QUESTION 類 draftCount=1", agg.get(`${CLINIC}|${CAT}`)?.draftCount === 1, agg);
    check("c4: 所有類 adopted/discarded 全 0", [...agg.values()].every((a) => a.adoptedAsIs === 0 && a.adoptedEdited === 0 && a.discarded === 0 && a.autoSent === 0), agg);
  }

  // ── case 5：對照水位 — PROPOSED 同 EXPIRED 一樣只計 draftCount ─────────────
  {
    const agg = aggregateDraftRows([row("PROPOSED"), row("EXPIRED")]);
    const a = agg.get(`${CLINIC}|${CAT}`);
    check("c5: PROPOSED+EXPIRED → draftCount=2 且其餘全 0", a?.draftCount === 2 && a.adoptedAsIs === 0 && a.adoptedEdited === 0 && a.discarded === 0 && a.autoSent === 0, a);
  }

  // ── case 6：多店隔離 — 各店獨立計 ─────────────────────────────────────────
  {
    const rows: DraftAggInput[] = [row("EXPIRED", CAT, "clinic-A"), row("EXPIRED", CAT, "clinic-B")];
    const agg = aggregateDraftRows(rows);
    check("c6: clinic-A draftCount=1", agg.get("clinic-A|QUESTION")?.draftCount === 1, agg);
    check("c6: clinic-B draftCount=1", agg.get("clinic-B|QUESTION")?.draftCount === 1, agg);
  }

  console.log(failures === 0 ? `\nT726-OK（${passes} 項全綠）` : `\nT726-FAIL（${failures} 項紅 / ${passes} 綠）`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

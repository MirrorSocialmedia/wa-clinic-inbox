/**
 * unit-automation-agg — Phase E（cwi-ai-20260825-t5）聚合映射（pure — 零 DB）
 *
 * 範圍：
 *   1. 五個 DraftStatus → 六欄映射（draftCount = 全部總和；PROPOSED 只計 draftCount）
 *   2. intent null → "UNKNOWN"（歷史 row 唔 backfill）
 *   3. (clinicId, category) 分組
 *   4. WeekAgg 輸出 shape 只有五個聚合欄 — **complaints/rollbacks 唔喺度**
 *      （呢兩欄係 E4 即時記帳欄，upsert update 白名單唔郁 — DB 層断喺 e2e）
 *
 * 用法（repo root）：pnpm tsx scripts/unit-automation-agg.ts
 */
import { aggregateDraftRows, type WeekAgg } from "../src/lib/ops/automation-stats";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("[1] 五個 DraftStatus → 欄映射");
{
  const rows = [
    { clinicId: "c1", intent: "QUESTION", status: "PROPOSED" as const },
    { clinicId: "c1", intent: "QUESTION", status: "SENT_AS_IS" as const },
    { clinicId: "c1", intent: "QUESTION", status: "SENT_EDITED" as const },
    { clinicId: "c1", intent: "QUESTION", status: "DISCARDED" as const },
    { clinicId: "c1", intent: "QUESTION", status: "SENT_AUTO" as const },
  ];
  const m = aggregateDraftRows(rows);
  const a = m.get("c1|QUESTION");
  check("五類各一 → draftCount=5", a?.draftCount === 5, JSON.stringify(a));
  check("adoptedAsIs=1", a?.adoptedAsIs === 1);
  check("adoptedEdited=1", a?.adoptedEdited === 1);
  check("discarded=1", a?.discarded === 1);
  check("autoSent=1", a?.autoSent === 1);
}

console.log("[2] intent null → UNKNOWN");
{
  const m = aggregateDraftRows([
    { clinicId: "c1", intent: null, status: "SENT_AS_IS" },
    { clinicId: "c1", intent: null, status: "PROPOSED" },
  ]);
  check("null intent 落 UNKNOWN 組", m.has("c1|UNKNOWN"));
  check("唔會落 null 組", !m.has("c1|null"));
  check("UNKNOWN draftCount=2", m.get("c1|UNKNOWN")?.draftCount === 2);
}

console.log("[3] (clinicId, category) 分組");
{
  const m = aggregateDraftRows([
    { clinicId: "c1", intent: "QUESTION", status: "PROPOSED" },
    { clinicId: "c1", intent: "BOOKING_REQUEST", status: "PROPOSED" },
    { clinicId: "c2", intent: "QUESTION", status: "SENT_AUTO" },
  ]);
  check("三組", m.size === 3, JSON.stringify([...m.keys()]));
  check("c2 QUESTION autoSent=1", m.get("c2|QUESTION")?.autoSent === 1);
}

console.log("[4] WeekAgg shape（complaints/rollbacks 唔喺度）");
{
  const m = aggregateDraftRows([{ clinicId: "c1", intent: "QUESTION", status: "PROPOSED" }]);
  const a = m.get("c1|QUESTION") as WeekAgg;
  const keys = Object.keys(a).sort();
  check(
    "只有五個聚合欄",
    JSON.stringify(keys) === JSON.stringify(["adoptedAsIs", "adoptedEdited", "autoSent", "discarded", "draftCount"]),
    JSON.stringify(keys)
  );
  check("空輸入 → 空 map", aggregateDraftRows([]).size === 0);
}

console.log(failures === 0 ? "\n✅ unit-automation-agg 全過" : `\n❌ ${failures} 個 fail`);
process.exit(failures === 0 ? 0 : 1);

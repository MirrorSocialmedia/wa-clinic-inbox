/**
 * unit-workforce-mock-json — [cwi-qa FX-15] T741e 回歸：workforce mock JSON 檔讀取容錯
 *
 * 背景（T741e，sim#1 fresh DB CI 模擬）：`GET /api/conversations?ids=` → server 500
 * `SyntaxError: Unexpected end of JSON input` — 根因排查指向 `src/lib/workforce/client.ts`
 * 11 處 `JSON.parse(readFileSync(...))` mock 檔讀取（0-byte / 部分寫入 / malformed →
 * SyntaxError 喺 request 中 throw → route 500）。
 *
 * ★ 驗證聲明（2026-09-29 實測，HEAD 2f625e6）：11 處位點**全部已喺 try/catch 內**
 * （parse 失敗 / 缺檔 → 各 fallback），全 repo 無其他 `JSON.parse(readFileSync)` 位點
 * → 本 commit 對 client.ts **零改動**（無缺口可修；改動 = 純 churn）。
 * 本腳本 = 容錯行為回歸鎖：0-byte / malformed 必返回 fallback 唔 throw（兩個代表位點），
 * 加 valid 文件 control 證明正常路徑語義不變。日後若有人移除 try/catch → 呢度必紅。
 *
 * 受測位點（task 指定兩類代表）：
 *  - claims file reader：`readClaimStore`（MOCK_CLAIMS_FILE，client.ts:2310）
 *      → 經 `getBookableSlots`（hold 扣 seat）+ `getHeld`（store → HeldItem）
 *  - flag reader：`readStaticHolds`（MOCK_HELD_FLAG，client.ts:2237）
 *      → 經 `getHeld`
 *
 * 隔離：mock 檔路徑係 `path.resolve(process.cwd(), ...)`（call time）→
 * `process.chdir(tmp)` 後全部 I/O 落 tmp，repo `.dev/`（e2e 實檔）零觸碰。
 * `WORKFORCE_MOCK=1` → 純 in-process mock：零 DB、零網絡、零 port。
 * 決定性基線：mock 規則（djb2）喺 client.ts 內 — 此處重實現用於對數（容量 3 /
 * 09:00–13:00 / 2 醫生 / 休診日 djb2(clinic|date)%7===3）。
 *
 * 用法（repo root）：pnpm test:unit-workforce-mock-json
 * 退出碼：0 = 全過；1 = 有 fail
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getBookableSlots,
  getHeld,
  MOCK_CLAIMS_FILE,
  MOCK_HELD_FLAG,
  type BookableSlotsResult,
  type HeldResult,
} from "../src/lib/workforce/client";

// mock 分支判断係 call time（wfGet/wfSend 內）— 入度 set 先保險（import 後、call 前都 ok）
process.env.WORKFORCE_MOCK = "1";

let passes = 0;
let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passes++;
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── 決定性基線重實現（同 client.ts mockBaseDay 同規則；對數用）─────────────────
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}
const MIN = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
const CAP = 3; // MOCK_CAPACITY
const P0 = 540; // MOCK_START_MIN 09:00
const P1 = 780; // MOCK_END_MIN 13:00（唔含）
const NPROV = 2; // MOCK_PROVIDER_NAMES.length（extra-providers flag 缺檔 = 0）

interface BaseSlot {
  key: string;
  seatsFree: number;
}
function baselineDay(clinic: string, date: string): { closed: boolean; slots: BaseSlot[] } {
  const closed = djb2(`${clinic}|${date}`) % 7 === 3;
  if (closed) return { closed: true, slots: [] };
  const slots: BaseSlot[] = [];
  for (let p = 0; p < NPROV; p++) {
    for (let s = P0; s < P1; s += 30) {
      slots.push({
        key: `mock|${clinic}|${date}|${MIN(s)}|mock-pract-${clinic}-${p}`,
        seatsFree: 1 + (djb2(`${clinic}|${date}|${s}|${p}`) % CAP),
      });
    }
  }
  return { closed: false, slots };
}
/** 對數：返回日 == 基線日（slotKey 集合 + 各自 seatsFree 完全一致）。 */
function matchesBaseline(res: BookableSlotsResult, clinic: string, dates: string[]): { ok: boolean; detail: string } {
  if (res.days.length !== dates.length) return { ok: false, detail: `days=${res.days.length} 預期 ${dates.length}` };
  for (let i = 0; i < dates.length; i++) {
    const day = res.days[i];
    const base = baselineDay(clinic, dates[i]);
    if (day.date !== dates[i]) return { ok: false, detail: `days[${i}].date=${day.date}` };
    if (day.closed !== base.closed) return { ok: false, detail: `days[${i}].closed=${day.closed} 預期 ${base.closed}` };
    if (day.slots.length !== base.slots.length)
      return { ok: false, detail: `days[${i}] slots=${day.slots.length} 預期 ${base.slots.length}` };
    const baseMap = new Map(base.slots.map((s) => [s.key, s.seatsFree]));
    for (const s of day.slots) {
      const want = baseMap.get(s.slotKey);
      if (want === undefined || want !== s.seatsFree)
        return { ok: false, detail: `days[${i}] ${s.slotKey} seatsFree=${s.seatsFree} 預期 ${want ?? "缺席"}` };
    }
  }
  return { ok: true, detail: "" };
}

// ── hermetic sandbox（tmp cwd — repo .dev/ 零觸碰）─────────────────────────────
const repoCwd = process.cwd();
const tmp = mkdtempSync(path.join(tmpdir(), "cwi-wmj-"));
mkdirSync(path.dirname(path.resolve(tmp, MOCK_CLAIMS_FILE)), { recursive: true });
const claimsPath = path.resolve(tmp, MOCK_CLAIMS_FILE);
const heldPath = path.resolve(tmp, MOCK_HELD_FLAG);
const setClaims = (content: string | null) => (content === null ? rmSync(claimsPath, { force: true }) : writeFileSync(claimsPath, content));
const setHeld = (content: string | null) => (content === null ? rmSync(heldPath, { force: true }) : writeFileSync(heldPath, content));

const CLINIC = "TKW";
const DATES = ["2026-10-01", "2026-10-02", "2026-10-03"];
const VALID_CLAIMS = JSON.stringify(
  [
    {
      holdId: "mock-hold-tmptest",
      flowToken: "flowtoken0123456789",
      slotKey: `mock|${CLINIC}|${DATES[0]}|09:00|mock-pract-${CLINIC}-0`,
      clinicCode: CLINIC,
      providerId: `mock-pract-${CLINIC}-0`,
      providerName: "mock 陳醫師",
      date: DATES[0],
      startMin: 540,
      endMin: 570,
      status: "HELD",
      createdAt: "2026-10-01T08:00:00.000Z",
    },
  ],
  null,
  1
);
const VALID_HELD = JSON.stringify(
  // 全 shape（同 mock-e2e.sh:5878 真 e2e 寫入口徑 — 6-field 短 shape 會被 HeldResponse.parse 拒）
  [
    {
      holdId: "static-hold-tmp",
      clinicCode: CLINIC,
      providerId: `mock-pract-${CLINIC}-1`,
      providerName: "mock 李醫師",
      date: DATES[0],
      startMin: 540,
      endMin: 570,
      status: "HELD",
      source: "e2e_flag",
      createdAt: "2026-10-01T00:00:00.000Z",
      ageHours: 0,
      appointmentPast: false,
    },
  ],
  null,
  1
);

async function main(): Promise<void> {
  process.chdir(tmp);
  try {
    // WMJ1 — claims 0-byte（代表位點 A：readClaimStore，client.ts:2310）
    //   0-byte 檔 = readFileSync 返 "" → JSON.parse throw → catch → []（= 缺檔 fallback）
    setClaims("");
    setHeld(null);
    check("WMJ1 setup: claims 檔 0-byte 已落 tmp", existsSync(claimsPath));
    let r1: BookableSlotsResult | null = null;
    let e1: unknown = null;
    try {
      r1 = await getBookableSlots(CLINIC, DATES[0], DATES[2]);
    } catch (e) {
      e1 = e;
    }
    check(
      "WMJ1 claims 0-byte → getBookableSlots 唔 throw",
      e1 === null && r1 !== null,
      e1 instanceof Error ? e1.message : String(e1)
    );
    if (r1) {
      const m = matchesBaseline(r1, CLINIC, DATES);
      check("WMJ1 claims 0-byte → slots = 基線（hold 未扣 = 缺檔 fallback 語義）", m.ok, m.detail);
    }

    // WMJ2 — held flag 0-byte（代表位點 B：readStaticHolds，client.ts:2237）
    setClaims(null);
    setHeld("");
    let r2: HeldResult | null = null;
    let e2: unknown = null;
    try {
      r2 = await getHeld(CLINIC);
    } catch (e) {
      e2 = e;
    }
    check("WMJ2 held flag 0-byte → getHeld 唔 throw", e2 === null && r2 !== null, e2 instanceof Error ? e2.message : String(e2));
    if (r2) check("WMJ2 held flag 0-byte → holds 空（fallback）", r2.holds.length === 0, `holds=${r2.holds.length}`);

    // WMJ3 — claims malformed（部分寫入形態：截斷 JSON 陣列）→ 同 fallback
    setClaims('[{"holdId": "x", "flowToken": "abcdef');
    let e3: unknown = null;
    let r3: BookableSlotsResult | null = null;
    try {
      r3 = await getBookableSlots(CLINIC, DATES[0], DATES[2]);
    } catch (e) {
      e3 = e;
    }
    check("WMJ3 claims malformed（截斷 JSON）→ 唔 throw", e3 === null && r3 !== null, e3 instanceof Error ? e3.message : String(e3));
    if (r3) {
      const m = matchesBaseline(r3, CLINIC, DATES);
      check("WMJ3 claims malformed → slots = 基線", m.ok, m.detail);
    }

    // WMJ4 — control：valid claims 檔 → 語義唔變（store 條目 → HeldItem）
    setClaims(VALID_CLAIMS);
    setHeld(null);
    let r4: HeldResult | null = null;
    let e4: unknown = null;
    try {
      r4 = await getHeld(CLINIC);
    } catch (e) {
      e4 = e;
    }
    check("WMJ4 control: valid claims → getHeld 唔 throw", e4 === null && r4 !== null, e4 instanceof Error ? e4.message : String(e4));
    if (r4) {
      check(
        "WMJ4 control: valid claims → 1 hold（holdId/HELD 保留）",
        r4.holds.length === 1 && r4.holds[0].holdId === "mock-hold-tmptest" && r4.holds[0].status === "HELD",
        JSON.stringify(r4.holds.map((h) => h.holdId))
      );
    }

    // WMJ5 — control：valid held flag → 語義唔變（靜態 hold 入列表）
    setClaims(null);
    setHeld(VALID_HELD);
    let r5: HeldResult | null = null;
    let e5: unknown = null;
    try {
      r5 = await getHeld(CLINIC);
    } catch (e) {
      e5 = e;
    }
    check("WMJ5 control: valid held flag → getHeld 唔 throw", e5 === null && r5 !== null, e5 instanceof Error ? e5.message : String(e5));
    if (r5) {
      check(
        "WMJ5 control: valid held flag → 1 靜態 hold",
        r5.holds.length === 1 && r5.holds[0].holdId === "static-hold-tmp",
        JSON.stringify(r5.holds.map((h) => h.holdId))
      );
    }
  } finally {
    process.chdir(repoCwd);
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\nunit-workforce-mock-json: ${passes} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("unit-workforce-mock-json: 腳本自身崩 —", e);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});

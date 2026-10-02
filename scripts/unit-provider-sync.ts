/**
 * unit-provider-sync — cwi-roster-20261001：醫生名錄自動同步（workforce → inbox）unit tests
 *
 * 範圍（施工單 §3 表 10 case）：
 *   T0  fixture contract — sha256 錨定 + ProvidersResponse.parse(fixture) + MOCK fetchProviders（含 clinicCode 篩）
 *   T1  首次同步 — Provider 建立、ProviderClinic 連好、sourceProviderId 寫入
 *   T2  同一醫生兩個帳號（MF 用 id A、TY 用 id B，同 providerId）— 兩行 Provider；A 只連 MF、B 只連 TY；sourceProviderId 一樣
 *   T3  醫生改名 — name 更新
 *   T4  醫生唔再喺某店（remote fresh、非空）— 該店 ProviderClinic 刪；冇其他店 → active=false，行唔刪
 *   T5  remote stale=true — 只加唔刪
 *   T6  remote providers: [] — 只加唔刪
 *   T7  有 PENDING BookingRequest / 進行中 BookingSession 嘅醫生 — 唔刪，pruneDeferred +1
 *   T8  remote clinicCode 對唔到 inbox Clinic — unmatchedClinics 有、乜都唔郁
 *   T9  fetch 失敗 / clinics 空 — 回 ok:false，DB 零改動
 *   T10 連跑兩次 — 第二次 linksAdded/linksPruned = 0（冪等）
 *
 * hermetic 設計：
 * - 臨時 clinic（RMTMF/RMTTY — 決定性 id，唔係 seeded TKW/MF/WTC）— 零 seeded provider／零 Booking 殘留，
 *   dev DB 同 CI fresh DB 同一套斷言；cleanup 全數洗走（clinic 刪 → ProviderClinic cascade）。
 * - sync 邏輯經 DI fetch（syncProvidersFromWorkforce({ fetch })）注入每 case 嘅決定性 remote —
 *   真 client 嘅 fixture 讀取由 T0 覆蓋（WORKFORCE_MOCK=1 直讀 test/fixtures/external-v1-providers.json）。
 * - TZ 口徑（fix07 教訓）：stale/syncedAt 全部用固定日期（2026-10-01T02:00:00.000Z）— 零 now() 相對日界斷言。
 *
 * 跑喺任何 migrated+seeded DB（本地 dev 15432 / CI fresh postgres）。
 * 用法（repo root）：pnpm tsx scripts/unit-provider-sync.ts
 * 退出碼：0 = 全過；1 = 有 fail。
 */

const envPath = new URL("../.env", import.meta.url).pathname;
try {
  process.loadEnvFile(envPath);
} catch {
  /* 靠 process env */
}
process.env.WORKFORCE_MOCK = "1"; // T0 用 — 決定性 fixture

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fetchProviders, ProvidersResponse, type ProvidersResult } from "../src/lib/workforce/client";
import { syncProvidersFromWorkforce } from "../src/lib/provider-sync";
import prisma from "../src/lib/prisma";

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

// ── 決定性 fixtures ─────────────────────────────────────────────────────────
// 臨時 clinic（決定性 id — 重跑清理可精準定位；唔係 seeded 店）
const MF_ID = "unitfup0rmtmf000000000001";
const TY_ID = "unitfup0rmtty000000000001";
// apricotId（fixture 同構：64f…=MAIN/MF 帳號、65a…=TY 帳號；A、B 同一個 workforce 醫生）
const A = "64f000000000000000000001"; // 王醫生 @MF（MAIN）
const B = "65a0000000000000000000001"; // 王醫生 @TY
const C = "65a0000000000000000000009"; // Dr. New @TY（workforce 未綁 → providerId null）
const D = "65a0000000000000000000010"; // Dr. Old @MF（本地獨有 — stale/空 case 嘅 prune 候選）
const E = "65a0000000000000000000011"; // Dr. Pending @TY（PENDING BookingRequest 保護）
const F = "65a0000000000000000000012"; // Dr. Session @TY（進行中 BookingSession 保護）
const G = "65a0000000000000000000013"; // Dr. StaleNew @MF（stale 店新增 — 只加唔刪嘅「加」）
const PROV_WONG = "prov-wong";
const ALL_TEST_APRICOT_IDS = [A, B, C, D, E, F, G];

// 固定日期（TZ 口徑：唔用 now() 相對 — CI UTC 同 HKT 日界都唔會撞）
const SYNCED_AT = "2026-10-01T02:00:00.000Z";

type RemoteProvider = { apricotId: string; name: string; providerId: string | null };
type RemoteClinic = { clinicId: string; clinicCode: string; apricotAccount: string; syncedAt: string | null; stale: boolean; providers: RemoteProvider[] };

function remote(clinics: RemoteClinic[]): ProvidersResult {
  return { v: 1, clinics };
}
const MF = (stale: boolean, providers: RemoteProvider[]): RemoteClinic => ({
  clinicId: MF_ID,
  clinicCode: "RMTMF",
  apricotAccount: "MAIN",
  syncedAt: SYNCED_AT,
  stale,
  providers,
});
const TY = (stale: boolean, providers: RemoteProvider[]): RemoteClinic => ({
  clinicId: TY_ID,
  clinicCode: "RMTTY",
  apricotAccount: "TY",
  syncedAt: SYNCED_AT,
  stale,
  providers,
});
const P = (apricotId: string, name: string, providerId: string | null = null): RemoteProvider => ({ apricotId, name, providerId });
const fakeFetch = (clinics: RemoteClinic[]) => async (): Promise<ProvidersResult> => remote(clinics);

const fixturePath = path.resolve(process.cwd(), "test/fixtures/external-v1-providers.json");
const FIXTURE_SHA = "4efbeda074f23325553f2e1bbf2aa08f88a3685df8c8430019cd1b0164114bf3";

async function providerByApricotId(apricotId: string) {
  return prisma.provider.findUnique({ where: { apricotId } });
}
async function linksOf(providerId: string): Promise<string[]> {
  const rows = await prisma.providerClinic.findMany({ where: { providerId } });
  return rows.map((r) => r.clinicId).sort();
}

async function main(): Promise<void> {
  // ── 清理舊殘留（crash 重跑安全 — 決定性 id 精準定位）────────────────
  await prisma.bookingRequest.deleteMany({ where: { id: "unitfup0bmreq0000000001" } });
  await prisma.bookingSession.deleteMany({ where: { id: "unitfup0bmses00000000001" } });
  await prisma.providerClinic.deleteMany({ where: { clinicId: { in: [MF_ID, TY_ID] } } });
  await prisma.provider.deleteMany({ where: { apricotId: { in: ALL_TEST_APRICOT_IDS } } });
  await prisma.clinic.deleteMany({ where: { id: { in: [MF_ID, TY_ID] } } });
  // 臨時 clinic（hermetic — 零 seeded 醫生、零 Booking 殘留）
  await prisma.clinic.create({
    data: { id: MF_ID, code: "RMTMF", name: "RMTMF 測試店（unit temp）", waPhoneNumberId: `unitfup0rmtmf000000000001`, waDisplayNumber: "+852 0000 0001" },
  });
  await prisma.clinic.create({
    data: { id: TY_ID, code: "RMTTY", name: "RMTTY 測試店（unit temp）", waPhoneNumberId: `unitfup0rmtty0000000000001`, waDisplayNumber: "+852 0000 0002" },
  });

  // ── T0 fixture contract（sha256 錨定 + zod + MOCK client）─────────────
  console.log("\n[T0] fixture contract");
  const raw = readFileSync(fixturePath);
  const sha = createHash("sha256").update(raw).digest("hex");
  check("T0 fixture sha256 錨定（同 workforce 側 byte-identical）", sha === FIXTURE_SHA, sha);
  const fixture = JSON.parse(raw.toString("utf8"));
  const parsed = ProvidersResponse.safeParse(fixture);
  check("T0 ProvidersResponse.parse(fixture) 過", parsed.success, parsed.success ? "" : JSON.stringify(parsed.error?.issues));
  const mockAll = await fetchProviders();
  check("T0 MOCK fetchProviders() = fixture 兩間店（MF/TY）", mockAll.clinics.length === 2 && mockAll.clinics.map((c) => c.clinicCode).sort().join(",") === "MF,TY", JSON.stringify(mockAll.clinics.map((c) => c.clinicCode)));
  const mockTy = await fetchProviders("TY");
  check("T0 MOCK fetchProviders('TY') 篩到 1 間", mockTy.clinics.length === 1 && mockTy.clinics[0].clinicCode === "TY", JSON.stringify(mockTy.clinics.map((c) => c.clinicCode)));

  // ── T1 首次同步 ───────────────────────────────────────────────────────
  console.log("\n[T1] 首次同步");
  const r1 = await syncProvidersFromWorkforce({
    fetch: fakeFetch([MF(false, [P(A, "王醫生", PROV_WONG)]), TY(false, [P(C, "Dr. New", null), P(B, "王醫生", PROV_WONG)])]),
  });
  check("T1 sync ok", r1.ok, r1.ok ? "" : r1.error);
  if (!r1.ok) return finish();
  check("T1 providersUpserted=3 / linksAdded=3 / linksPruned=0", r1.summary.providersUpserted === 3 && r1.summary.linksAdded === 3 && r1.summary.linksPruned === 0, JSON.stringify(r1.summary));
  check("T1 clinicsMatched=2 / unmatched=0 / stale=0", r1.summary.clinicsMatched === 2 && r1.summary.unmatchedClinics.length === 0 && r1.summary.staleClinics.length === 0, JSON.stringify(r1.summary));
  const pa = await providerByApricotId(A);
  const pb = await providerByApricotId(B);
  const pc = await providerByApricotId(C);
  check("T1 Provider 建立 + active", !!pa && !!pb && !!pc && pa.active && pb.active && pc.active);
  if (!pa || !pb || !pc) return finish();
  check("T1 sourceProviderId 寫入（A/B=prov-wong、C=null）", pa?.sourceProviderId === PROV_WONG && pb?.sourceProviderId === PROV_WONG && pc?.sourceProviderId === null, JSON.stringify({ a: pa?.sourceProviderId, b: pb?.sourceProviderId, c: pc?.sourceProviderId }));
  check("T1 ProviderClinic 連好（A→RMTMF、B/C→RMTTY）", (await linksOf(pa!.id)).join() === MF_ID && (await linksOf(pb!.id)).join() === TY_ID && (await linksOf(pc!.id)).join() === TY_ID);

  // ── T2 同一醫生兩個帳號 ───────────────────────────────────────────────
  console.log("\n[T2] 同一醫生兩個帳號");
  check("T2 兩行 Provider（A 同 B 都存在）", !!pa && !!pb && pa.id !== pb.id);
  check("T2 A 只連 RMTMF、B 只連 RMTTY", (await linksOf(pa.id)).join() === MF_ID && (await linksOf(pb.id)).join() === TY_ID, JSON.stringify({ a: await linksOf(pa.id), b: await linksOf(pb.id) }));
  check("T2 sourceProviderId 一樣（認返同一個人）", pa.sourceProviderId === pb.sourceProviderId && pa.sourceProviderId === PROV_WONG);
  check("T2 apricotId 唔同（兩帳號各一個 id）", pa.apricotId !== pb.apricotId);

  // ── T3 醫生改名 ───────────────────────────────────────────────────────
  console.log("\n[T3] 醫生改名");
  const r3 = await syncProvidersFromWorkforce({
    fetch: fakeFetch([MF(false, [P(A, "王醫生（改名）", PROV_WONG)]), TY(false, [P(C, "Dr. New", null), P(B, "王醫生", PROV_WONG)])]),
  });
  check("T3 sync ok + linksAdded=0（冇新 link）", r3.ok && r3.summary.linksAdded === 0, r3.ok ? JSON.stringify(r3.summary) : r3.error);
  check("T3 name 更新", (await providerByApricotId(A))?.name === "王醫生（改名）");
  check("T3 改名唔會串店（A 仍然只連 RMTMF）", (await linksOf(pa.id)).join() === MF_ID);

  // ── T4 醫生唔再喺某店（remote fresh、非空）→ prune + 停用 ────────────
  console.log("\n[T4] 醫生唔再喺某店");
  const r4 = await syncProvidersFromWorkforce({
    fetch: fakeFetch([MF(false, [P(A, "王醫生（改名）", PROV_WONG)]), TY(false, [P(C, "Dr. New", null)])]), // B 唔喺 RMTTY
  });
  check("T4 sync ok + linksPruned=1", r4.ok && r4.summary.linksPruned === 1, r4.ok ? JSON.stringify(r4.summary) : r4.error);
  const pbAfter = await providerByApricotId(B);
  check("T4 B 行唔刪（apricotId 字串對返名要保住）", pbAfter !== null);
  check("T4 B 冇 link → active=false", pbAfter?.active === false);
  check("T4 A/C 照樣 active", (await providerByApricotId(A))?.active === true && (await providerByApricotId(C))?.active === true);
  check("T4 providersDeactivated=1", r4.ok && r4.summary.providersDeactivated === 1);

  // ── T5 remote stale=true → 只加唔刪 ───────────────────────────────────
  console.log("\n[T5] stale → 只加唔刪");
  // 本地獨有醫生 D 連 RMTMF（fresh remote 會 prune 佢；stale 必須保住佢）
  const pd = await prisma.provider.create({ data: { apricotId: D, name: "Dr. Old", active: true } });
  await prisma.providerClinic.create({ data: { providerId: pd.id, clinicId: MF_ID } });
  const r5 = await syncProvidersFromWorkforce({
    fetch: fakeFetch([MF(true, [P(A, "王醫生（改名）", PROV_WONG), P(G, "Dr. StaleNew", null)]), TY(false, [P(C, "Dr. New", null)])]),
  });
  check("T5 sync ok + staleClinics=[RMTMF]", r5.ok && JSON.stringify(r5.summary.staleClinics) === '["RMTMF"]', r5.ok ? JSON.stringify(r5.summary.staleClinics) : r5.error);
  check("T5 只加：G 新增連上 RMTMF", (await providerByApricotId(G))?.name === "Dr. StaleNew" && (await linksOf((await providerByApricotId(G))!.id)).join() === MF_ID);
  check("T5 唔刪：D 嘅 link 保住（stale 唔 prune）", (await linksOf(pd.id)).join() === MF_ID && (await providerByApricotId(D))?.active === true);
  check("T5 linksPruned=0", r5.ok && r5.summary.linksPruned === 0, r5.ok ? JSON.stringify(r5.summary) : r5.error);

  // ── T6 remote providers: [] → 只加唔刪 ────────────────────────────────
  console.log("\n[T6] providers 空 → 只加唔刪");
  const r6 = await syncProvidersFromWorkforce({
    fetch: fakeFetch([MF(false, []), TY(false, [])]),
  });
  check("T6 sync ok（空店唔係 error — 只係唔 prune）", r6.ok, r6.ok ? "" : r6.error);
  check("T6 linksPruned=0 + providersUpserted=0", r6.ok && r6.summary.linksPruned === 0 && r6.summary.providersUpserted === 0, r6.ok ? JSON.stringify(r6.summary) : r6.error);
  check("T6 D 照樣連住 + active（空 remote 唔刪）", (await linksOf(pd.id)).join() === MF_ID && (await providerByApricotId(D))?.active === true);

  // ── T7 有未完結預約嘅醫生 → prune deferred（唔刪）────────────────────
  console.log("\n[T7] PENDING BookingRequest / 進行中 BookingSession 保護");
  const pe = await prisma.provider.create({ data: { apricotId: E, name: "Dr. Pending", active: true } });
  await prisma.providerClinic.create({ data: { providerId: pe.id, clinicId: TY_ID } });
  const pf = await prisma.provider.create({ data: { apricotId: F, name: "Dr. Session", active: true } });
  await prisma.providerClinic.create({ data: { providerId: pf.id, clinicId: TY_ID } });
  await prisma.bookingRequest.create({
    data: {
      id: "unitfup0bmreq0000000001",
      conversationId: "unitfup0conv0000000000000001",
      clinicId: TY_ID,
      flowToken: "unit-fup0-bmreq-flow-token-1",
      providerApricotId: E,
      providerName: "Dr. Pending",
      requestedDate: "2026-10-01",
      status: "PENDING",
    },
  });
  await prisma.bookingSession.create({
    data: {
      id: "unitfup0bmses00000000001",
      conversationId: "unitfup0conv0000000000000002",
      clinicId: TY_ID,
      status: "ACTIVE",
      slots: { providerApricotId: F, providerName: "Dr. Session" },
      expiresAt: new Date("2026-10-02T02:00:00.000Z"),
    },
  });
  const r7 = await syncProvidersFromWorkforce({
    fetch: fakeFetch([MF(false, [P(A, "王醫生（改名）", PROV_WONG), P(D, "Dr. Old", null), P(G, "Dr. StaleNew", null)]), TY(false, [P(C, "Dr. New", null)])]), // E/F 唔喺 remote
  });
  check("T7 sync ok + pruneDeferred=2（E 有 PENDING、F 有 ACTIVE session）", r7.ok && r7.summary.pruneDeferred === 2, r7.ok ? JSON.stringify(r7.summary) : r7.error);
  check("T7 linksPruned=0（兩個都保住）", r7.ok && r7.summary.linksPruned === 0, r7.ok ? JSON.stringify(r7.summary) : r7.error);
  check("T7 E link 保住 + active", (await linksOf(pe.id)).join() === TY_ID && (await providerByApricotId(E))?.active === true);
  check("T7 F link 保住 + active", (await linksOf(pf.id)).join() === TY_ID && (await providerByApricotId(F))?.active === true);

  // ── T8 remote clinicCode 對唔到 inbox Clinic → 乜都唔郁 ───────────────
  console.log("\n[T8] 對唔到嘅 clinicCode");
  const before8 = await prisma.provider.count();
  const before8links = await prisma.providerClinic.count();
  const r8 = await syncProvidersFromWorkforce({
    fetch: fakeFetch([{ clinicId: "cl-nope", clinicCode: "RMTNOPE", apricotAccount: "MAIN", syncedAt: SYNCED_AT, stale: false, providers: [P("65a0000000000000000000999", "Dr. Nowhere", "prov-nowhere")] }]),
  });
  check("T8 sync ok + unmatchedClinics=[RMTNOPE]", r8.ok && JSON.stringify(r8.summary.unmatchedClinics) === '["RMTNOPE"]', r8.ok ? JSON.stringify(r8.summary.unmatchedClinics) : r8.error);
  check("T8 providersUpserted=0 / linksAdded=0（對唔到唔郁）", r8.ok && r8.summary.providersUpserted === 0 && r8.summary.linksAdded === 0, r8.ok ? JSON.stringify(r8.summary) : r8.error);
  check("T8 DB 零改動", (await prisma.provider.count()) === before8 && (await prisma.providerClinic.count()) === before8links);

  // ── T9 fetch 失敗 / clinics 空 → ok:false + DB 零改動 ────────────────
  console.log("\n[T9] fetch 失敗 / clinics 空");
  const before9 = await prisma.provider.count();
  const before9links = await prisma.providerClinic.count();
  const r9a = await syncProvidersFromWorkforce({ fetch: async () => { throw new Error("workforce 500"); } });
  check("T9 fetch 失敗 → ok:false", r9a.ok === false, r9a.ok ? "" : (r9a as { error: string }).error);
  const r9b = await syncProvidersFromWorkforce({ fetch: fakeFetch([]) });
  check("T9 clinics 空 → ok:false", r9b.ok === false, r9b.ok ? "" : (r9b as { error: string }).error);
  check("T9 DB 零改動", (await prisma.provider.count()) === before9 && (await prisma.providerClinic.count()) === before9links);

  // ── T10 連跑兩次 → 冪等（linksAdded/linksPruned = 0）─────────────────
  console.log("\n[T10] 冪等");
  const stableRemote = () => [MF(false, [P(A, "王醫生（改名）", PROV_WONG), P(D, "Dr. Old", null), P(G, "Dr. StaleNew", null)]), TY(false, [P(C, "Dr. New", null), P(E, "Dr. Pending", null), P(F, "Dr. Session", null)])];
  const r10a = await syncProvidersFromWorkforce({ fetch: fakeFetch(stableRemote()) });
  check("T10 第一次（基線）ok", r10a.ok, r10a.ok ? "" : r10a.error);
  const r10b = await syncProvidersFromWorkforce({ fetch: fakeFetch(stableRemote()) });
  check("T10 第二次 linksAdded=0 + linksPruned=0（冪等）", r10b.ok && r10b.summary.linksAdded === 0 && r10b.summary.linksPruned === 0, r10b.ok ? JSON.stringify(r10b.summary) : r10b.error);

  // ── cleanup ───────────────────────────────────────────────────────────
  console.log("\n[cleanup]");
  await prisma.bookingRequest.deleteMany({ where: { id: "unitfup0bmreq0000000001" } });
  await prisma.bookingSession.deleteMany({ where: { id: "unitfup0bmses00000000001" } });
  await prisma.providerClinic.deleteMany({ where: { clinicId: { in: [MF_ID, TY_ID] } } });
  await prisma.provider.deleteMany({ where: { apricotId: { in: ALL_TEST_APRICOT_IDS } } });
  await prisma.clinic.deleteMany({ where: { id: { in: [MF_ID, TY_ID] } } });
  const leftProviders = await prisma.provider.count({ where: { apricotId: { in: ALL_TEST_APRICOT_IDS } } });
  const leftClinics = await prisma.clinic.count({ where: { id: { in: [MF_ID, TY_ID] } } });
  const leftBr = await prisma.bookingRequest.count({ where: { id: "unitfup0bmreq0000000001" } });
  const leftBs = await prisma.bookingSession.count({ where: { id: "unitfup0bmses00000000001" } });
  check("cleanup 全洗走（providers/clinics/booking 殘留 = 0）", leftProviders === 0 && leftClinics === 0 && leftBr === 0 && leftBs === 0, JSON.stringify({ leftProviders, leftClinics, leftBr, leftBs }));
}

function finish(): void {
  console.log(`\n[unit-provider-sync] ${passes} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

main()
  .then(() => finish())
  .catch((e) => {
    console.error("[unit-provider-sync] FATAL", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

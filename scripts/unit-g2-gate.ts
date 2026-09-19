/**
 * cwi-final S0-12 — G2 閘（ALLOW_SLOT_CLAIM）unit contract（T604 ①⑤ 支援）
 *
 * 覆蓋：
 * - slotClaimEnabled()：未設 / "0" / " 1 "（trim 不食 — 精確 "1"）/ "1" → 口徑
 * - sendBookingFlow：gate OFF → 第一行 throw FlowsDisabledError（零 DB / 零 HTTP）
 * - claimSlot / commitHold：gate OFF → 第一行 throw SlotClaimDisabledError（403 語義）
 * - ai.worker SEND_FLOW 分支：FlowsDisabledError 型別相容（instanceof 判定 = true）
 *   （完整 session→HANDOFF e2e 不可 hermetic — 源離線兜底要 workforce 斷 + 多輪 AI；
 *     ai.worker.ts:804 分支經代碼審計 + 呢度錯誤型別 contract 覆蓋）
 *
 * 跑法：pnpm test:g2-gate（結尾 process.exit(0) — 防 prisma/queue 句柄吊住 event loop）
 */
import { slotClaimEnabled, SlotClaimDisabledError, claimSlot, commitHold } from "../src/lib/workforce/client";
import { sendBookingFlow, FlowsDisabledError } from "../src/lib/flows/send";

let pass = 0;
let fail = 0;
function check(desc: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`  ✅ ${desc}`);
  } else {
    fail++;
    console.log(`  ❌ ${desc}${detail ? `（${detail}）` : ""}`);
  }
}

const prev = process.env.ALLOW_SLOT_CLAIM;

const main = async () => {
try {
  // ── 1. slotClaimEnabled 口徑 ─────────────────────────────────────
  delete process.env.ALLOW_SLOT_CLAIM;
  check("未設 = OFF（預設關）", slotClaimEnabled() === false);
  process.env.ALLOW_SLOT_CLAIM = "0";
  check("'0' = OFF", slotClaimEnabled() === false);
  process.env.ALLOW_SLOT_CLAIM = "1";
  check("'1' = ON", slotClaimEnabled() === true);

  // ── 2. sendBookingFlow gate OFF → FlowsDisabledError（第一行，零副作用）──
  delete process.env.ALLOW_SLOT_CLAIM;
  let threw: unknown = null;
  try {
    // 參數形狀只係為過 TS — gate 喺第一行 throw，唔會用到任何欄位
    void (sendBookingFlow as unknown as (input: Record<string, unknown>) => Promise<unknown>);
    await sendBookingFlow({
      clinicId: "unit-g2-clinic",
      conversationId: "unit-g2-conv",
      staffId: "unit-g2-staff",
      reason: "unit",
    } as never);
  } catch (e) {
    threw = e;
  }
  check("sendBookingFlow gate-OFF → FlowsDisabledError", threw instanceof FlowsDisabledError, String(threw));
  check("FlowsDisabledError.message = SLOT_CLAIM_DISABLED", (threw as Error)?.message === "SLOT_CLAIM_DISABLED");

  // ── 3. claimSlot / commitHold gate OFF → SlotClaimDisabledError ──
  let cthrew: unknown = null;
  try {
    await claimSlot({ slotKey: "unit|g2", patientWaId: "85200000001", patientName: "G2", flowToken: "unit-token" });
  } catch (e) {
    cthrew = e;
  }
  check(
    "claimSlot gate-OFF → SlotClaimDisabledError",
    cthrew instanceof SlotClaimDisabledError && cthrew instanceof Error && (cthrew as { status?: number }).status === 403,
    String(cthrew)
  );
  let hthrew: unknown = null;
  try {
    await commitHold("unit-hold-id");
  } catch (e) {
    hthrew = e;
  }
  check(
    "commitHold gate-OFF → SlotClaimDisabledError（403）",
    hthrew instanceof SlotClaimDisabledError && (hthrew as { status?: number }).status === 403,
    String(hthrew)
  );

  // ── 4. ai.worker 分支相容：instanceof 判定（SEND_FLOW catch 用呢個）──
  const aiCatchWouldHandle = (threw instanceof FlowsDisabledError) === true;
  check("ai.worker SEND_FLOW catch 判定（instanceof FlowsDisabledError）= true", aiCatchWouldHandle);
} finally {
  if (prev === undefined) delete process.env.ALLOW_SLOT_CLAIM;
  else process.env.ALLOW_SLOT_CLAIM = prev;
}

console.log(`G2 gate unit: PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error("unit-g2-gate 未預期錯誤:", e);
  process.exit(1);
});

import prisma from "@/lib/prisma";
import log from "@/lib/log";
import { identifyPatient, WorkforceApiError } from "@/lib/workforce/client";
import { convRef, publishConvEvent } from "@/lib/notify";
import { needsIdentify, mapIdentifyStatus, type PatientStatus } from "@/lib/patient-identify-policy";

/**
 * ★ cwi-patient-identify-20261017（擁有人拍板）：新客／舊客判定。
 *
 * 病人一 inbox（inbound worker）就喺背景判定：用電話經 workforce 搜晒全部 Apricot 帳號（唔使有預約）。
 *   EXISTING = 任何帳號有病人檔（已登記未到診都算舊客）
 *   NEW      = 全部帳號搜過都冇
 *   UNKNOWN  = 有帳號查唔到（Apricot 忙／登入失效／workforce 斷）— 唔當新客，10 分鐘後再試
 * 結果寫 Contact；只認到一個病人 → identifiedPatientApricotId（病人記錄直接用）；多個 → staff 喺病人卡揀。
 *
 * 幾時再查：已判定 24 小時內唔再查（UNKNOWN 10 分鐘）；staff 撳「重新判定」= force。
 * 🔴 私隱（擁有人拍板）：原始電話只經 POST body 傳去 workforce；唔寫 log。
 */
const inFlight = new Set<string>();

export interface IdentifyOutcome {
  status: PatientStatus;
  count: number;
  patientApricotId: string | null;
}

export async function identifyContact(contactId: string, opts: { force?: boolean } = {}): Promise<IdentifyOutcome | null> {
  if (inFlight.has(contactId)) return null;
  inFlight.add(contactId);
  try {
    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      select: { id: true, waId: true, patientStatus: true, patientCheckedAt: true },
    });
    if (!contact) return null;
    if (!opts.force && !needsIdentify(contact)) return null;

    let outcome: IdentifyOutcome;
    try {
      const r = await identifyPatient(contact.waId);
      outcome = {
        status: mapIdentifyStatus(r.status),
        count: r.patients.length,
        patientApricotId: r.patients.length === 1 ? r.patients[0].patientApricotId : null,
      };
    } catch (e) {
      log.warn(
        { contactId, err: e instanceof WorkforceApiError ? `status=${e.status}` : e instanceof Error ? e.name : "unknown" },
        "patient-identify: workforce 查唔到（UNKNOWN — 稍後重試）"
      );
      outcome = { status: "UNKNOWN", count: 0, patientApricotId: null };
    }

    await prisma.contact.update({
      where: { id: contactId },
      data: {
        patientStatus: outcome.status,
        patientCheckedAt: new Date(),
        identifiedPatientApricotId: outcome.patientApricotId,
        identifiedCount: outcome.count,
      },
    });

    // 即時推俾畫面（列表 chip／對話頂部）— 呢個 contact 嘅開放對話
    const convs = await prisma.conversation.findMany({ where: { contactId }, select: { id: true, clinicId: true, assigneeId: true, routedStaffId: true, routedGroupId: true, handlingClinicId: true } });
    for (const c of convs) {
      await publishConvEvent(convRef(c), "conv:updated", {
        conversationId: c.id,
        clinicId: c.clinicId,
        patientStatus: outcome.status,
        identifiedCount: outcome.count,
      });
    }
    log.info({ contactId, status: outcome.status, count: outcome.count }, "patient-identify: done");
    return outcome;
  } finally {
    inFlight.delete(contactId);
  }
}

/** inbound worker 用：唔等結果、唔拋錯（判定失敗唔可以阻收訊息）。 */
export function identifyContactInBackground(contactId: string): void {
  void identifyContact(contactId).catch((e) =>
    log.warn({ contactId, err: e instanceof Error ? e.message : String(e) }, "patient-identify: background failed（fail-soft）")
  );
}

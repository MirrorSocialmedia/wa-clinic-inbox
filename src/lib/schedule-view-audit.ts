/**
 * cwi-sched-20260901 §4 — 時間表跨店瀏覽審計（SCHEDULE_VIEW）
 *
 * 只記 STAFF 睇**非自己主店**嘅時間表（ADMIN 天然跨店，唔記；自己店唔記）。
 * meta 只記 clinicCode（零 PII — 時間表本身就只有醫生名 + 席數）。
 * fail-soft：寫 audit 失敗只係 log warn，絕唔阻擋讀取。
 */
import prisma from "@/lib/prisma";
import log from "@/lib/log";

export async function auditScheduleView(
  ctx: { staff: { id: string; role: "ADMIN" | "STAFF" }; clinicId: string | null },
  targetClinicId: string,
  clinicCode: string
): Promise<void> {
  if (ctx.staff.role !== "STAFF") return;
  if (!ctx.clinicId || ctx.clinicId === targetClinicId) return;
  try {
    await prisma.auditLog.create({
      data: {
        staffId: ctx.staff.id,
        action: "SCHEDULE_VIEW",
        entity: "Clinic",
        entityId: targetClinicId,
        meta: { clinicCode } as object,
      },
    });
  } catch (err) {
    log.warn(
      { staffId: ctx.staff.id, clinicCode, err: err instanceof Error ? err.message : String(err) },
      "schedule-view: audit 寫入失敗（fail-soft）"
    );
  }
}

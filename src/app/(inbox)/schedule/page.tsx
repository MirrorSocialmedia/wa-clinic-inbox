import Link from "next/link";
import { redirect } from "next/navigation";
import prisma from "@/lib/prisma";
import { getServerSession } from "@/lib/session-server";
import { fetchDutyRoster, hkToday, type DutyEntry } from "@/lib/duty/client";
import { getBookableSlots, getHeld } from "@/lib/workforce/client";
import { SlotsBoard, type SlotsData } from "@/components/inbox/slots-board";
import { ArrowLeft, CalendarDays } from "lucide-react";

/**
 * /schedule — 醫生時間表（兩個 view）：
 * - 當值週表（預設）：七日當值（MD「輪一收尾」§C；detail-pane「睇成週 →」link 落點）
 * - 可約時段表（?view=slots）：workforce bookable-slots 四態格（providerslot-20260830 T3；
 *   admin 側欄「醫生時間表」落點）
 *
 * Scope（同 /api/duty-roster 一致 — fail-closed）：
 * - STAFF：只見自己店（?clinicId= 唔一致 → 照舊自己店，唔會洩其他店）。
 * - ADMIN：?clinicId=<clinic code> 選店；唔帶 → 店選單（唔 fetch 任何店數據）。
 *
 * 數據：服務端 for 今日..今日+6（HK 日期）→ fetchDutyRoster(code, d)（5 分鐘 cache；
 * fail-soft：workforce 離線 / 壞 shape → null → 「未有資料」— 頁照起）。
 *
 * 欄位白名單（MD §9.2）：只顯示 staffName / role / shiftStart / shiftEnd — 薪酬/打卡永遠掂唔到。
 */
export const dynamic = "force-dynamic";

/** 今日 + n 日嘅 HK 日期（en-CA + Asia/Hong_Kong — 同 hkToday 慣例）。 */
function hkDateOffset(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() + days * 86_400_000).toLocaleDateString("en-CA", {
    timeZone: "Asia/Hong_Kong",
  });
}

/** YYYY-MM-DD（HK wall-clock）→ 星期幾 short（確定性 — Intl，唔受 server TZ 影響）。 */
function weekdayShort(dateStr: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Hong_Kong", weekday: "short" }).format(
    new Date(`${dateStr}T00:00:00+08:00`)
  );
}

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getServerSession();
  if (!session) redirect("/login");

  const sp = await searchParams;
  const clinicParam = typeof sp.clinicId === "string" ? sp.clinicId.trim() : "";
  const view: "duty" | "slots" = sp.view === "slots" ? "slots" : "duty";
  const isStaff = session.role === "STAFF";

  // 店清單（選單用）：STAFF = 自己店；ADMIN = 全部
  const clinics = isStaff
    ? await prisma.clinic.findMany({
        where: { id: session.clinicId! },
        select: { id: true, code: true, name: true },
      })
    : await prisma.clinic.findMany({ orderBy: { code: "asc" }, select: { id: true, code: true, name: true } });

  // 目標店解析（fail-closed）
  const own = clinics.find((c) => c.id === session.clinicId) ?? null;
  let clinic: { id: string; code: string; name: string } | null;
  let clinicMissing = false;
  if (isStaff) {
    // STAFF：param 唔一致 → 照舊自己店（同 route 403 嘅 fail-closed 語義 — 頁唔會洩其他店）
    clinic = own;
  } else {
    if (!clinicParam) {
      clinic = null; // → 店選單
    } else {
      clinic = clinics.find((c) => c.code === clinicParam) ?? null;
      clinicMissing = clinic === null;
    }
  }

  // 兩 view 各自 fetch（fail-soft）：duty = 七日當值；slots = 可約時段（today..today+6）+ held
  let week: { date: string; entries: DutyEntry[] | null }[] = [];
  let slotsInitial: SlotsData | null = null;
  if (clinic) {
    if (view === "duty") {
      // 七日數據（平行 fetch — 最壞情況 = 一個 3s timeout，唔會 7 倍串行）
      const dates = Array.from({ length: 7 }, (_, i) => hkDateOffset(i));
      week = await Promise.all(
        dates.map(async (d) => ({
          date: d,
          entries: await fetchDutyRoster(clinic.code, d).catch(() => null),
        }))
      );
    } else {
      // 可約時段：workforce bookable-slots（from ≥ today 契約）+ held（四態格「已佔」橙）
      const today = hkToday();
      const to6 = hkDateOffset(6);
      const [slotsRes, heldRes] = await Promise.all([
        getBookableSlots(clinic.code, today, to6).catch(() => null),
        getHeld(clinic.code).catch(() => null),
      ]);
      slotsInitial = {
        connected: slotsRes !== null,
        slots: slotsRes,
        held: heldRes?.holds ?? [],
        holdTimeoutHours: heldRes?.holdTimeoutHours ?? null,
        fetchedAt: new Date().toISOString(),
      };
    }
  }
  const allEmpty = view === "duty" && week.length > 0 && week.every((d) => d.entries === null);
  const clinicQuery = clinicParam ? `?clinicId=${encodeURIComponent(clinicParam)}` : "";

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto p-4 space-y-3">
        {/* header：返回 inbox + 標題 + （ADMIN）店選單 */}
        <div className="flex items-center gap-3 flex-wrap">
          <Link
            href="/inbox"
            className="inline-flex items-center gap-1 text-xs text-t2 hover:text-t1 px-2 py-1 rounded hover:bg-panel-2"
          >
            <ArrowLeft size={13} /> 返回 inbox
          </Link>
          <h1 className="text-lg font-semibold text-t1 inline-flex items-center gap-1.5">
            <CalendarDays size={17} className="text-brand-text" />
            {view === "slots" ? "醫生時間表" : "當值週表"}
            {clinic ? (
              <span className="text-sm font-normal text-t2">
                · {clinic.name}（{clinic.code}）
              </span>
            ) : null}
          </h1>
          {/* view 切換（providerslot-20260830 T3：可約時段四態格） */}
          <div className="flex items-center gap-0.5 bg-panel-2 rounded-full p-0.5">
            <a
              href={`/schedule${clinicQuery}`}
              className={`text-xs px-2.5 py-1 rounded-full font-medium ${
                view === "duty" ? "bg-brand text-panel" : "text-t2 hover:text-t1"
              }`}
            >
              當值週表
            </a>
            <a
              href={`/schedule?view=slots${clinicParam ? `&clinicId=${encodeURIComponent(clinicParam)}` : ""}`}
              className={`text-xs px-2.5 py-1 rounded-full font-medium ${
                view === "slots" ? "bg-brand text-panel" : "text-t2 hover:text-t1"
              }`}
            >
              可約時段
            </a>
          </div>
          {!isStaff && clinics.length > 0 && (
            <form method="GET" action="/schedule" className="ml-auto flex items-center gap-1.5 text-xs">
              <span className="text-t2">店：</span>
              <select
                name="clinicId"
                defaultValue={clinic?.code ?? ""}
                className="px-2 py-1 rounded bg-panel border border-line text-t1"
              >
                <option value="" disabled>
                  揀一間店
                </option>
                {clinics.map((c) => (
                  <option key={c.id} value={c.code}>
                    {c.name}（{c.code}）
                  </option>
                ))}
              </select>
            </form>
          )}
        </div>

        {/* 空狀態：全週冇數據 / 搵唔到店 */}
        {clinicMissing ? (
          <div className="rounded-xl bg-panel-2 p-6 text-sm text-t2 text-center">
            搵唔到店（{clinicParam}）— 用上面選單重揀。
          </div>
        ) : !clinic ? (
          <div className="rounded-xl bg-panel-2 p-6 text-sm text-t2 text-center">
            揀一間店先睇{view === "slots" ? "醫生時間表" : "當值週表"}。
          </div>
        ) : view === "slots" ? (
          <SlotsBoard
            clinics={clinics}
            isStaff={isStaff}
            initialClinicCode={clinic.code}
            initialView="week"
            initialData={slotsInitial}
            today={hkToday()}
          />
        ) : allEmpty ? (
          <div className="rounded-xl bg-panel-2 p-8 text-center space-y-1">
            <div className="text-sm text-t1 font-medium">未有資料</div>
            <div className="text-xs text-t3">當值資料嚟自 clinic-workforce（未接入或本週無排更）</div>
          </div>
        ) : (
          // 七欄 grid（小螢幕橫向 scroll — min-w 保住每欄可讀）
          <div className="overflow-x-auto">
            <div className="min-w-[760px] grid grid-cols-7 gap-2">
              {week.map((day, i) => (
                <div
                  key={day.date}
                  className={`rounded-xl p-2.5 space-y-2 ${
                    i === 0 ? "bg-brand-soft/60" : "bg-panel-2"
                  }`}
                >
                  <div className="text-[11px] font-semibold text-t1 flex items-center gap-1">
                    {weekdayShort(day.date)} {day.date.slice(5).replace("-", "/")}
                    {i === 0 && (
                      <span className="text-[9px] px-1 rounded bg-brand-soft text-brand-text">今日</span>
                    )}
                  </div>
                  {day.entries && day.entries.length > 0 ? (
                    <div className="space-y-1.5 text-[11px]">
                      {day.entries.map((e) => (
                        <div key={`${e.staffName}-${e.shiftStart}`} className="rounded bg-canvas/60 p-1.5">
                          <div className="text-t1">
                            {e.staffName}
                            {e.role ? <span className="text-t3">（{e.role}）</span> : null}
                          </div>
                          <div className="text-t2 font-mono">
                            {e.shiftStart}–{e.shiftEnd}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-[11px] text-t3 py-2">未有資料</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

import Link from "next/link";
import { redirect } from "next/navigation";
import prisma from "@/lib/prisma";
import { getServerSession } from "@/lib/session-server";
import { hkToday } from "@/lib/duty/client";
import { buildFlowSlots } from "@/lib/flow-slots";
import { ScheduleBoard } from "@/components/inbox/schedule-board";
import { ClinicSelect } from "@/components/inbox/clinic-select";
import { auditScheduleView } from "@/lib/schedule-view-audit";
import { ArrowLeft, CalendarDays } from "lucide-react";

/**
 * /schedule — 醫生時間表（cwi-sched-20260901 §1 單入口；取代舊兩 tab）
 *
 * URL state（分享 / refresh 保持位置）：
 *   /schedule?clinic=<code>&view=week|day&date=YYYY-MM-DD&provider=<id>
 *   - clinic 缺省 = 用戶 primary clinic（STAFF 自己店；ADMIN 無 → 店選單）
 *   - view 缺省 = week（週視圖 default）
 *   - date 只係 view=day 用；provider 只係日視圖 chips 用（都可以缺省）
 *   - ⚠️ CEO 指令：URL 參數用 `clinic`（新）；同時接受舊 `clinicId` 作**只讀 fallback**
 *     （detail-pane「睇成週 →」等舊 link 唔斷）— `clinic` 優先。
 *
 * Scope（§4 全店唯讀）：任何 active 員工可睇任何店時間表（非敏感：醫生名 + 席數，
 * 零病人資料）。落單 / claim / commit 一律唔受影響（繼續 assertConversationAccess）。
 * 跨店瀏覽 → SCHEDULE_VIEW audit（meta 只記 clinicCode，零 PII）。
 *
 * 數據：服務端 buildFlowSlots（duty + slots 一次過回 — 同一 syncedAt；全程 fail-soft）。
 */
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 今日 + n 日嘅 HK 日期（en-CA + Asia/Hong_Kong — 同 hkToday 慣例）。 */
function hkDateOffset(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() + days * 86_400_000).toLocaleDateString("en-CA", {
    timeZone: "Asia/Hong_Kong",
  });
}

/** 任意 base 日期 + n 日（純日曆日運算 — UTC 午夜慣例，同 board addDays 一致）。 */
function hkDateOffsetFrom(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getServerSession();
  if (!session) redirect("/login");

  const sp = await searchParams;
  // clinic（新）優先；clinicId（舊 link）只讀 fallback
  const rawClinic =
    (typeof sp.clinic === "string" ? sp.clinic.trim() : "") ||
    (typeof sp.clinicId === "string" ? sp.clinicId.trim() : "");
  const view: "week" | "day" = sp.view === "day" ? "day" : "week";
  const providerParam = typeof sp.provider === "string" ? sp.provider.trim() : "";
  const isStaff = session.role === "STAFF";
  const today = hkToday();
  const maxDate = hkDateOffset(20);

  // date 參數校驗（week 視圖 = 窗口首日；day 視圖 = 該日）：合法 + 今日..+20 → 否則 fallback today
  let date = today;
  {
    const d = typeof sp.date === "string" ? sp.date.trim() : "";
    if (DATE_RE.test(d) && d >= today && d <= maxDate) date = d;
  }

  // 店清單（選單用 — §4：所有 STAFF 見晒啟用中診所）
  const clinics = await prisma.clinic.findMany({
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true },
  });

  // 目標店解析（§4 全店唯讀：任何店都得；STAFF 無 param → 自己 primary 店）
  const own = clinics.find((c) => c.id === session.clinicId) ?? null;
  let clinic: { id: string; code: string; name: string } | null;
  let clinicMissing = false;
  if (!rawClinic) {
    clinic = isStaff ? own : null; // STAFF = 自己店；ADMIN → 店選單
  } else {
    clinic = clinics.find((c) => c.code === rawClinic) ?? null;
    clinicMissing = clinic === null;
  }

  // SSR 初始數據（buildFlowSlots fail-soft — workforce 離線 → connected=false → UI「未接通」）
  let slotsInitial: Awaited<ReturnType<typeof buildFlowSlots>> | null = null;
  if (clinic) {
    const from = date; // week = 窗口首日；day = 該日
    const to = view === "day" ? date : hkDateOffsetFrom(date, 6);
    slotsInitial = await buildFlowSlots(clinic.code, from, to, view).catch(() => null);
    // 跨店瀏覽審計（SSR 讀路徑；fail-soft）
    if (isStaff && session.clinicId && session.clinicId !== clinic.id) {
      void auditScheduleView(
        { staff: { id: session.staffId, role: "STAFF" as const }, clinicId: session.clinicId },
        clinic.id,
        clinic.code
      );
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto p-4 space-y-3">
        {/* header：返回 inbox + 標題 + 店選單（所有角色 — §4 全店唯讀） */}
        <div className="flex items-center gap-3 flex-wrap">
          <Link
            href="/inbox"
            className="inline-flex items-center gap-1 text-xs text-t2 hover:text-t1 px-2 py-1 rounded hover:bg-panel-2"
          >
            <ArrowLeft size={13} /> 返回 inbox
          </Link>
          <h1 className="text-lg font-semibold text-t1 inline-flex items-center gap-1.5">
            <CalendarDays size={17} className="text-brand-text" />
            醫生時間表
            {clinic ? (
              <span className="text-sm font-normal text-t2">
                · {clinic.name}（{clinic.code}）
              </span>
            ) : null}
          </h1>
          <span className="ml-auto inline-flex items-center gap-1.5 text-xs">
            <span className="text-t2">店：</span>
            {/* §5 修復（T-A）：client select onChange → router.replace 帶 clinic + view 保持 */}
            <ClinicSelect clinics={clinics} value={clinic?.code ?? ""} view={view} paramName="clinic" />
          </span>
        </div>

        {/* 空狀態：搵唔到店 / 揀店 */}
        {clinicMissing ? (
          <div className="rounded-xl bg-panel-2 p-6 text-sm text-t2 text-center">
            搵唔到店（{rawClinic}）— 用上面選單重揀。
          </div>
        ) : !clinic ? (
          <div className="rounded-xl bg-panel-2 p-6 text-sm text-t2 text-center">
            揀一間店先睇醫生時間表。
          </div>
        ) : (
          <ScheduleBoard
            clinics={clinics}
            clinicCode={clinic.code}
            view={view}
            date={date}
            provider={providerParam}
            initialData={slotsInitial}
            today={today}
          />
        )}
      </div>
    </div>
  );
}

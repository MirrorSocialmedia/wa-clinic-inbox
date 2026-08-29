"use client";

import { usePathname } from "next/navigation";
import {
  ArrowLeft,
  Bot,
  Building2,
  FileText,
  LayoutDashboard,
  Lightbulb,
  LogOut,
  MessageCircle,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";

/**
 * /admin Organic 分組側欄殼（2026-08-29 P2，README 第 3 步 — 客戶點名項）。
 *
 * 舊版：header 一行 9 條平鋪連結。新版：244px 左側欄（五組：監控/診所/團隊/AI/接入）
 * + 右側內容區，整體包喺 rounded-[32px] bg-panel shadow-md 面板入面。
 *
 * 注意：導覽項只連真實存在嘅 route（警報/醫生時間表/今日當值/安全/兩步驟
 * 冇獨立頁 — 警報+TOTP 喺 /admin 總覽、時間表未畫）→ 唔放 dead link。
 */

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
}

const SECTION_NAMES: Record<string, string> = {
  "/admin": "總覽",
  "/admin/clinics": "診所設定",
  "/admin/staff": "員工帳號",
  "/admin/onboarding": "WhatsApp 接入",
  "/admin/templates": "訊息範本",
  "/admin/workflows": "Workflow",
  "/admin/automation": "AI 自動化",
  "/admin/suggestions": "AI 建議",
};

export function AdminShell({
  userName,
  clinicCount,
  pendingSuggestions,
  children,
}: {
  userName: string;
  clinicCount: number;
  pendingSuggestions: number;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const section = SECTION_NAMES[pathname] ?? "設定";

  const groups: { title: string; items: NavItem[] }[] = [
    {
      title: "監控",
      items: [{ href: "/admin", label: "總覽", icon: LayoutDashboard }],
    },
    {
      title: "診所",
      items: [{ href: "/admin/clinics", label: "診所設定", icon: Building2 }],
    },
    {
      title: "團隊",
      items: [{ href: "/admin/staff", label: "員工帳號", icon: Users }],
    },
    {
      title: "AI",
      items: [
        { href: "/admin/automation", label: "AI 自動化", icon: Bot },
        {
          href: "/admin/suggestions",
          label: "AI 建議",
          icon: Lightbulb,
          badge: pendingSuggestions,
        },
        { href: "/admin/workflows", label: "Workflow", icon: Workflow },
      ],
    },
    {
      title: "接入",
      items: [
        { href: "/admin/onboarding", label: "WhatsApp 接入", icon: MessageCircle },
        { href: "/admin/templates", label: "訊息範本", icon: FileText },
      ],
    },
  ];

  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* cookie 清唔清都得，一律去登入頁 */
    }
    window.location.href = "/login";
  }

  return (
    <div className="max-w-[1180px] mx-auto">
      <div className="flex flex-col md:flex-row bg-panel border border-line rounded-[32px] shadow-md overflow-hidden min-h-[calc(100vh-32px)]">
        {/* ── 左側欄 244px（bg-panel-2） ── */}
        <aside className="w-full md:w-[244px] md:flex-none bg-panel-2 flex flex-col gap-5 px-3.5 py-4 md:py-5 border-b md:border-b-0 md:border-r border-line">
          {/* 品牌記號 */}
          <div className="flex items-center gap-2.5 px-1.5">
            <div className="w-[34px] h-[34px] flex-none rounded-full bg-brand grid place-items-center font-display text-[16px] text-panel">
              W
            </div>
            <div className="min-w-0">
              <div className="font-display text-[15px] leading-tight text-t1">WA Clinic</div>
              <div className="text-[10.5px] text-t3">{clinicCount} 店共用 inbox</div>
            </div>
          </div>

          {/* 分組導覽 */}
          <nav className="flex flex-col gap-4 overflow-auto min-h-0 flex-1" aria-label="管理導覽">
            {groups.map((g) => (
              <div key={g.title} className="flex flex-col gap-0.5">
                <div className="font-semibold text-[9.5px] tracking-[0.14em] uppercase text-t3 px-3 pb-1.5">
                  {g.title}
                </div>
                {g.items.map((it) => {
                  const active = pathname === it.href;
                  const Icon = it.icon;
                  return (
                    <a
                      key={it.href}
                      href={it.href}
                      aria-current={active ? "page" : undefined}
                      className={`flex items-center gap-2.5 px-3 py-2 rounded-full text-[13px] font-semibold transition-colors ${
                        active ? "bg-brand-soft text-brand-text" : "text-t2 hover:bg-black/[.04]"
                      }`}
                    >
                      <Icon size={15} strokeWidth={2.75} className="flex-none" />
                      <span className="truncate">{it.label}</span>
                      {typeof it.badge === "number" && it.badge > 0 && (
                        <span
                          className="ml-auto min-w-[19px] h-[19px] px-1.5 rounded-full bg-brand-soft border border-line-strong grid place-items-center text-[10.5px] font-semibold text-brand-text flex-none"
                          title={`待審 ${it.badge} 條`}
                        >
                          {it.badge}
                        </span>
                      )}
                    </a>
                  );
                })}
              </div>
            ))}
          </nav>

          {/* 使用者膠囊（28px 頭像 + 姓名 + ADMIN · 全店 + 登出） */}
          <div className="rounded-full bg-panel border border-line px-3 py-2 flex items-center gap-2.5">
            <div className="w-7 h-7 flex-none rounded-full bg-brand-soft text-brand-text grid place-items-center text-[12px] font-bold">
              {(userName || "A").slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-semibold text-t1 truncate">{userName}</div>
              <div className="text-[10px] text-t3">ADMIN · 全店</div>
            </div>
            <button
              onClick={() => void logout()}
              title="登出"
              className="text-t3 hover:text-danger-text flex-none p-1"
            >
              <LogOut size={15} strokeWidth={2.75} />
            </button>
          </div>
        </aside>

        {/* ── 右側內容區（麵包屑 + 頁面內容） ── */}
        <main className="flex-1 min-w-0 p-5 md:p-7">
          <div className="flex items-center justify-between gap-3 mb-5">
            <nav className="text-[11px] text-t2" aria-label="麵包屑">
              設定 <span className="mx-1 text-t3">/</span>{" "}
              <span className="font-semibold text-t1">{section}</span>
            </nav>
            <a
              href="/inbox"
              className="flex items-center gap-1.5 text-[11px] font-semibold text-t2 hover:text-brand-text flex-none"
            >
              <ArrowLeft size={12} strokeWidth={2.75} /> 回到 Inbox
            </a>
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}

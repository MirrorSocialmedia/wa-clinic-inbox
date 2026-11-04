"use client";

/**
 * ★ cwi-workgroup-20261104：工作群頁（桌面：左群組列 + 右對話；手機：列表 → 入群，有返回）。
 * - 只顯示自己係成員嘅群；老闆（集團管理員）多「管理群組」
 * - Enter 發送（Shift+Enter 換行）；打 @ 揀成員；分享嘅對話卡按自己權限顯示
 * - socket `workgroup:message`（零內文）→ 重拉；`workgroup:changed` → 重拉群組列
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { io } from "socket.io-client";
import { ArrowLeft, Archive, MessageSquareShare, Send, Settings2, Users } from "lucide-react";
import { WLoading } from "@/components/ui/w-loader";
import { WorkgroupManageDialog } from "./manage-dialog";

interface GroupRow {
  id: string;
  name: string;
  archived: boolean;
  memberCount: number;
  lastMessageAt: string | null;
  lastPreview: string | null;
  unread: number;
  mentionUnread: number;
}
interface Card {
  conversationId: string;
  allowed: boolean;
  name: string | null;
  patientCode: string | null;
  clinicCode: string | null;
  salesIntent: string | null;
  lastAt: string | null;
}
interface Msg {
  id: string;
  senderId: string;
  senderName: string;
  mine: boolean;
  body: string;
  mentions: { id: string; name: string }[];
  card: Card | null;
  createdAt: string;
}
interface GroupDetail {
  id: string;
  name: string;
  archived: boolean;
  members: { id: string; name: string; active: boolean }[];
}

const INTENT: Record<string, { t: string; cls: string }> = {
  HIGH: { t: "意向高", cls: "bg-danger-soft text-danger-text font-semibold" },
  MEDIUM: { t: "意向中", cls: "bg-warn-soft text-warn-text font-semibold" },
  LOW: { t: "意向低", cls: "bg-panel-2 text-t2" },
};

function hm(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  const t = d.toLocaleTimeString("zh-HK", { hour: "2-digit", minute: "2-digit", hour12: false });
  return same ? t : `${d.getMonth() + 1}/${d.getDate()} ${t}`;
}

function newKey(): string {
  try {
    return crypto.randomUUID().replace(/-/g, "");
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }
}

/** 內文：@名 高亮（只限真係被 @ 嘅人） */
function Body({ text, mentions }: { text: string; mentions: { name: string }[] }) {
  if (!mentions.length) return <>{text}</>;
  const names = [...new Set(mentions.map((m) => m.name))].sort((a, b) => b.length - a.length);
  const re = new RegExp(`(@(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}))`, "g");
  return (
    <>
      {text.split(re).map((part, i) =>
        re.test(part) && part.startsWith("@") ? (
          <span key={i} className="font-semibold text-brand-text">
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function ConvCard({ card }: { card: Card }) {
  if (!card.allowed)
    return (
      <div className="mt-1.5 rounded-xl border border-line bg-panel px-3 py-2 text-xs text-t3" data-e2e="wg-card-denied">
        💬 分享咗一個對話（你冇權睇呢間店嘅對話）
      </div>
    );
  const it = card.salesIntent ? INTENT[card.salesIntent] : null;
  return (
    <Link
      href={`/inbox?conv=${encodeURIComponent(card.conversationId)}`}
      className="mt-1.5 block rounded-xl border border-line bg-panel px-3 py-2 text-xs hover:bg-panel-2"
      data-e2e="wg-card"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-semibold text-t1">💬 {card.name ?? "病人"}</span>
        {card.patientCode && <span className="rounded-full bg-panel-2 px-1.5 py-0.5 text-[10px] text-t2">{card.patientCode}</span>}
        {card.clinicCode && <span className="rounded-full bg-panel-2 px-1.5 py-0.5 text-[10px] text-t2">{card.clinicCode}</span>}
        {it && <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${it.cls}`}>{it.t}</span>}
      </div>
      <div className="mt-1 font-semibold text-brand-text">打開對話 →</div>
    </Link>
  );
}

export default function WorkgroupsClient({ meId, canManage, initialGroupId }: { meId: string; canManage: boolean; initialGroupId: string | null }) {
  const [groups, setGroups] = useState<GroupRow[] | null>(null);
  const [sel, setSel] = useState<string | null>(initialGroupId);
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [text, setText] = useState("");
  const [mentionIds, setMentionIds] = useState<Map<string, string>>(new Map()); // id → name
  const [picker, setPicker] = useState<string | null>(null); // @ 之後打咗嘅字
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const pendingKey = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const selRef = useRef(sel);
  selRef.current = sel;

  const loadGroups = useCallback(async () => {
    try {
      const r = await fetch("/api/workgroups");
      if (!r.ok) return;
      const d = (await r.json()) as { groups: GroupRow[] };
      setGroups(d.groups);
      if (selRef.current && !d.groups.some((g) => g.id === selRef.current)) {
        // 被移出群組 → 即時收返
        setSel(null);
        setDetail(null);
        setMsgs([]);
      }
    } catch {
      /* 下次再拉 */
    }
  }, []);

  const markRead = useCallback(
    async (gid: string) => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      await fetch(`/api/workgroups/${encodeURIComponent(gid)}/read`, { method: "POST" }).catch(() => {});
      setGroups((prev) => prev?.map((g) => (g.id === gid ? { ...g, unread: 0, mentionUnread: 0 } : g)) ?? prev);
    },
    [],
  );

  const loadMsgs = useCallback(
    async (gid: string, before?: string) => {
      setLoadingMsgs(true);
      try {
        const r = await fetch(`/api/workgroups/${encodeURIComponent(gid)}/messages${before ? `?before=${encodeURIComponent(before)}` : ""}`);
        if (!r.ok) {
          if (r.status === 404) {
            setSel(null);
            void loadGroups();
          }
          return;
        }
        const d = (await r.json()) as { group: GroupDetail; messages: Msg[]; hasMore: boolean };
        if (selRef.current !== gid) return;
        setDetail(d.group);
        setHasMore(d.hasMore);
        setMsgs((prev) => {
          if (before) return [...d.messages, ...prev.filter((m) => !d.messages.some((x) => x.id === m.id))];
          // 最新一頁：同已載入嘅舊訊息合併
          const ids = new Set(d.messages.map((m) => m.id));
          const older = prev.filter((m) => !ids.has(m.id) && (d.messages[0] ? m.createdAt < d.messages[0].createdAt : true));
          return [...older, ...d.messages];
        });
        if (!before) {
          void markRead(gid);
          requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: "end" }));
        }
      } finally {
        setLoadingMsgs(false);
      }
    },
    [loadGroups, markRead],
  );

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  useEffect(() => {
    setMsgs([]);
    setDetail(null);
    setText("");
    setMentionIds(new Map());
    setErr(null);
    if (sel) void loadMsgs(sel);
  }, [sel, loadMsgs]);

  useEffect(() => {
    const socket = io({ withCredentials: true, transports: ["websocket", "polling"] });
    socket.on("workgroup:message", (p: { groupId?: string }) => {
      if (p?.groupId && p.groupId === selRef.current) void loadMsgs(p.groupId);
      void loadGroups();
    });
    socket.on("workgroup:changed", () => {
      void loadGroups();
      if (selRef.current) void loadMsgs(selRef.current);
    });
    const onVis = () => {
      if (document.visibilityState === "visible" && selRef.current) void markRead(selRef.current);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      socket.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loadGroups, loadMsgs, markRead]);

  const pickerList = useMemo(() => {
    if (picker === null || !detail) return [];
    const q = picker.toLowerCase();
    return detail.members.filter((m) => m.id !== meId && m.active && m.name.toLowerCase().includes(q)).slice(0, 8);
  }, [picker, detail, meId]);

  function onText(v: string) {
    setText(v);
    const m = /@([^\s@]{0,20})$/.exec(v);
    setPicker(m ? m[1] : null);
  }
  function pickMember(id: string, name: string) {
    setText((t) => t.replace(/@([^\s@]{0,20})$/, `@${name} `));
    setMentionIds((prev) => new Map(prev).set(id, name));
    setPicker(null);
  }

  async function send() {
    if (!sel || sending) return;
    const body = text.trim();
    if (!body) return;
    setSending(true);
    setErr(null);
    pendingKey.current ??= newKey();
    // 只保留內文仲有 @名 嘅人
    const mentions = [...mentionIds.entries()].filter(([, n]) => body.includes(`@${n}`)).map(([id]) => id);
    try {
      const r = await fetch(`/api/workgroups/${encodeURIComponent(sel)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, mentions, clientKey: pendingKey.current }),
      });
      const d = (await r.json().catch(() => null)) as { message?: string } | null;
      if (!r.ok) {
        setErr(d?.message ?? "發送失敗");
        if (r.status < 500 && r.status !== 429) pendingKey.current = null;
        return;
      }
      pendingKey.current = null;
      setText("");
      setMentionIds(new Map());
      await loadMsgs(sel);
    } catch {
      setErr("網絡錯誤 — 再撳一次會重試（唔會重複發）");
    } finally {
      setSending(false);
    }
  }

  const current = groups?.find((g) => g.id === sel) ?? null;
  const archived = detail?.archived ?? current?.archived ?? false;

  return (
    <div className="flex h-full min-h-0 bg-canvas">
      {/* 群組列 */}
      <aside className={`w-full md:w-[300px] shrink-0 md:border-r border-line bg-panel flex-col min-h-0 ${sel ? "hidden md:flex" : "flex"}`} data-e2e="wg-list">
        <div className="flex items-center gap-2 px-4 pt-4 pb-2">
          <h1 className="text-[20px] font-normal text-t1">工作群</h1>
          {canManage && (
            <button
              type="button"
              onClick={() => setManageOpen(true)}
              className="ml-auto inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-xs text-t1 hover:bg-panel-2"
              data-e2e="wg-manage-open"
            >
              <Settings2 className="h-3.5 w-3.5" aria-hidden /> 管理群組
            </button>
          )}
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-2.5 pb-24 md:pb-3">
          {groups === null ? (
            <WLoading />
          ) : groups.length === 0 ? (
            <div className="px-3 py-10 text-center text-sm text-t3">
              你未加入任何工作群
              <div className="mt-1 text-xs">{canManage ? "撳「管理群組」開第一個群" : "請老闆加你入群"}</div>
            </div>
          ) : (
            groups.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => setSel(g.id)}
                className={`mb-1 flex w-full items-center gap-2.5 rounded-2xl px-2.5 py-2 text-left ${sel === g.id ? "bg-brand-soft" : "hover:bg-panel-2"} ${g.archived ? "opacity-60" : ""}`}
                data-e2e="wg-group-row"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand text-[13px] font-semibold text-panel">{g.name.slice(0, 2)}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 text-[13.5px] font-semibold text-t1">
                    <span className="truncate">{g.name}</span>
                    {g.archived && <Archive className="h-3 w-3 shrink-0 text-t3" aria-label="已封存" />}
                  </span>
                  <span className="block truncate text-[11.5px] text-t2">{g.lastPreview ?? "未有訊息"}</span>
                </span>
                {g.mentionUnread > 0 ? (
                  <span className="shrink-0 rounded-full bg-danger px-1.5 py-0.5 text-[10.5px] font-semibold text-panel" data-e2e="wg-mention-badge">
                    @{g.mentionUnread}
                  </span>
                ) : g.unread > 0 ? (
                  <span className="shrink-0 rounded-full bg-brand px-1.5 py-0.5 text-[10.5px] text-panel" data-e2e="wg-unread-badge">
                    {g.unread}
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
      </aside>

      {/* 對話 */}
      <section className={`flex-1 min-w-0 flex-col min-h-0 ${sel ? "flex" : "hidden md:flex"}`} data-e2e="wg-chat">
        {!sel ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-t3">
            <Users className="h-7 w-7" aria-hidden />
            <div className="text-sm">揀一個群組開始</div>
          </div>
        ) : (
          <>
            <header className="flex items-center gap-2 border-b border-line bg-panel px-3 py-2.5 md:px-4">
              <button type="button" onClick={() => setSel(null)} className="md:hidden rounded-full p-1 hover:bg-panel-2" aria-label="返回群組列表">
                <ArrowLeft className="h-5 w-5" aria-hidden />
              </button>
              <div className="min-w-0">
                <div className="truncate text-[15px] font-semibold text-t1">{detail?.name ?? current?.name ?? ""}</div>
                {detail && (
                  <div className="truncate text-[11px] text-t3" title={detail.members.map((m) => m.name).join("、")}>
                    {detail.members.length} 人：{detail.members.map((m) => m.name).join("、")}
                  </div>
                )}
              </div>
            </header>
            {archived && <div className="bg-panel-2 px-4 py-1.5 text-center text-xs text-t2">呢個群組已封存 — 只可以睇，唔可以再發訊息</div>}
            <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 md:px-5" data-e2e="wg-messages">
              {hasMore && (
                <div className="mb-2 text-center">
                  <button
                    type="button"
                    disabled={loadingMsgs}
                    onClick={() => msgs[0] && sel && void loadMsgs(sel, msgs[0].id)}
                    className="rounded-full border border-line px-3 py-1 text-xs text-t2 hover:bg-panel-2"
                  >
                    載入更早訊息
                  </button>
                </div>
              )}
              {msgs.length === 0 && !loadingMsgs && <div className="py-10 text-center text-sm text-t3">未有訊息 — 打個招呼啦</div>}
              <div className="flex flex-col gap-2.5">
                {msgs.map((m) => (
                  <div key={m.id} className={`max-w-[85%] md:max-w-[70%] rounded-2xl px-3 py-2 text-[13.5px] ${m.mine ? "self-end bg-brand-soft" : "self-start bg-panel"}`} data-e2e="wg-msg">
                    {!m.mine && <div className="mb-0.5 text-[11px] font-semibold text-t2">{m.senderName}</div>}
                    {m.body && (
                      <div className="whitespace-pre-wrap break-words text-t1">
                        <Body text={m.body} mentions={m.mentions} />
                      </div>
                    )}
                    {m.card && <ConvCard card={m.card} />}
                    <div className="mt-0.5 text-right text-[10.5px] text-t3">{hm(m.createdAt)}</div>
                  </div>
                ))}
              </div>
              <div ref={bottomRef} />
            </div>
            <div className="relative border-t border-line bg-panel px-3 py-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom))] md:px-4">
              {pickerList.length > 0 && (
                <div className="absolute bottom-full left-3 mb-1 w-56 overflow-hidden rounded-xl border border-line bg-panel shadow-lg" data-e2e="wg-mention-picker">
                  {pickerList.map((m) => (
                    <button key={m.id} type="button" onClick={() => pickMember(m.id, m.name)} className="block w-full px-3 py-2 text-left text-sm hover:bg-panel-2">
                      @{m.name}
                    </button>
                  ))}
                </div>
              )}
              {err && <div className="mb-1 text-xs text-danger-text">{err}</div>}
              <div className="flex items-end gap-2">
                <textarea
                  value={text}
                  disabled={archived || sending}
                  onChange={(e) => onText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  rows={1}
                  maxLength={2000}
                  placeholder={archived ? "已封存" : "輸入訊息…（打 @ 揀同事）"}
                  className="max-h-32 min-h-[40px] flex-1 resize-none rounded-2xl border border-line bg-panel-2 px-3 py-2 text-sm text-t1 disabled:opacity-60"
                  data-e2e="wg-input"
                />
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={archived || sending || !text.trim()}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand text-panel disabled:opacity-40"
                  aria-label="發送"
                  data-e2e="wg-send"
                >
                  <Send className="h-4 w-4" aria-hidden />
                </button>
              </div>
              <div className="mt-1 hidden text-[10.5px] text-t3 md:block">
                <MessageSquareShare className="mr-1 inline h-3 w-3" aria-hidden />
                分享病人對話：喺對話頂部 ⋯ → 分享去工作群
              </div>
            </div>
          </>
        )}
      </section>
      {canManage && manageOpen && (
        <WorkgroupManageDialog
          onClose={() => setManageOpen(false)}
          onChanged={() => {
            void loadGroups();
            if (selRef.current) void loadMsgs(selRef.current);
          }}
        />
      )}
    </div>
  );
}

"use client";

/**
 * ★ cwi-workgroup-20261104：工作群頁（桌面：左群組列 + 右對話；手機：列表 → 入群，有返回）。
 * - 只顯示自己係成員嘅群；老闆（集團管理員）多「管理群組」
 * - Enter 發送（Shift+Enter 換行）；打 @ 揀成員；分享嘅對話卡按自己權限顯示
 * - socket `workgroup:message`（零內文）→ 重拉；`workgroup:changed` → 重拉群組列
 *
 * ★ 第 2 期（cwi-workgroup-p2-20261105）：
 * - 分頁「群組」／「外部對話」（Lab／供應商 WhatsApp — 撳入 = 收件箱對話畫面覆）
 * - 對話卡「我接」（分享並放手）、相片／PDF 附件、置頂（每群最多 3 條）、已讀人數（自己發嘅）、搜尋
 * - socket `workgroup:read` → 更新已讀人數；`message:new`／`conv:updated` → 外部對話列表重拉
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { io } from "socket.io-client";
import { ArrowLeft, Archive, FileText, MessageSquareShare, Paperclip, Pin, PinOff, Search, Send, Settings2, Users, X } from "lucide-react";
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
  assigneeName: string | null;
}
interface Msg {
  id: string;
  senderId: string;
  senderName: string;
  mine: boolean;
  body: string;
  mentions: { id: string; name: string }[];
  card: Card | null;
  released: boolean;
  claimedByName: string | null;
  claimedAt: string | null;
  claimable: boolean;
  attachment: { key: string; name: string; mime: string; size: number } | null;
  pinned: boolean;
  read: { count: number; total: number; names: string[] } | null;
  createdAt: string;
}
interface PinnedRow {
  id: string;
  senderName: string;
  preview: string;
  pinnedAt: string;
}
interface GroupDetail {
  id: string;
  name: string;
  archived: boolean;
  members: { id: string; name: string; active: boolean }[];
}
interface ExtRow {
  conversationId: string;
  name: string;
  org: string | null;
  clinicCode: string | null;
  lastMessageAt: string;
  lastPreview: string | null;
  lastFromThem: boolean;
  unread: number;
  assigneeName: string | null;
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

function kb(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
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

function ConvCard({ m, onClaim, claiming }: { m: Msg; onClaim: (m: Msg) => void; claiming: boolean }) {
  const card = m.card!;
  if (!card.allowed)
    return (
      <div className="mt-1.5 rounded-xl border border-line bg-panel px-3 py-2 text-xs text-t3" data-e2e="wg-card-denied">
        💬 分享咗一個對話（你冇權睇呢間店嘅對話）
      </div>
    );
  const it = card.salesIntent ? INTENT[card.salesIntent] : null;
  let state: { t: string; cls: string } | null = null;
  if (m.released) {
    if (m.claimedByName) state = { t: `${m.claimedByName} 已接手${m.claimedAt ? ` ${hm(m.claimedAt)}` : ""}`, cls: "bg-ok-soft text-ok-text" };
    else if (m.claimable) state = { t: "已放手 · 等人接", cls: "bg-warn-soft text-warn-text font-semibold" };
    else if (card.assigneeName) state = { t: `${card.assigneeName} 跟緊`, cls: "bg-panel-2 text-t2" };
  }
  return (
    <div className="mt-1.5 rounded-xl border border-line bg-panel px-3 py-2 text-xs" data-e2e="wg-card">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-semibold text-t1">💬 {card.name ?? "病人"}</span>
        {card.patientCode && <span className="rounded-full bg-panel-2 px-1.5 py-0.5 text-[10px] text-t2">{card.patientCode}</span>}
        {card.clinicCode && <span className="rounded-full bg-panel-2 px-1.5 py-0.5 text-[10px] text-t2">{card.clinicCode}</span>}
        {it && <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${it.cls}`}>{it.t}</span>}
        {state && (
          <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${state.cls}`} data-e2e="wg-card-state">
            {state.t}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {m.claimable && (
          <button
            type="button"
            disabled={claiming}
            onClick={() => onClaim(m)}
            className="rounded-full bg-brand px-3 py-1 text-[11.5px] font-semibold text-panel disabled:opacity-50"
            data-e2e="wg-claim"
          >
            {claiming ? "接緊…" : "我接"}
          </button>
        )}
        <Link href={`/inbox?conv=${encodeURIComponent(card.conversationId)}`} className="font-semibold text-brand-text hover:underline" data-e2e="wg-card-open">
          打開對話 →
        </Link>
      </div>
    </div>
  );
}

function Attachment({ a }: { a: NonNullable<Msg["attachment"]> }) {
  const url = `/api/workgroups/files/${encodeURIComponent(a.key)}`;
  if (a.mime.startsWith("image/"))
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="mt-1 block" data-e2e="wg-attach-img">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={a.name} className="max-h-60 max-w-full rounded-xl border border-line object-contain" loading="lazy" />
      </a>
    );
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1 flex items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2 text-xs hover:bg-panel-2"
      data-e2e="wg-attach-file"
    >
      <FileText className="h-4 w-4 shrink-0 text-t2" aria-hidden />
      <span className="min-w-0 flex-1 truncate font-semibold text-t1">{a.name}</span>
      <span className="shrink-0 text-t3">{kb(a.size)}</span>
    </a>
  );
}

function Bubble({
  m,
  archived,
  onClaim,
  claiming,
  onPin,
}: {
  m: Msg;
  archived: boolean;
  onClaim: (m: Msg) => void;
  claiming: boolean;
  onPin: (m: Msg) => void;
}) {
  return (
    <div className={`group relative max-w-[85%] md:max-w-[70%] rounded-2xl px-3 py-2 text-[13.5px] ${m.mine ? "self-end bg-brand-soft" : "self-start bg-panel"}`} data-e2e="wg-msg">
      {!m.mine && <div className="mb-0.5 text-[11px] font-semibold text-t2">{m.senderName}</div>}
      {m.body && (
        <div className="whitespace-pre-wrap break-words text-t1">
          <Body text={m.body} mentions={m.mentions} />
        </div>
      )}
      {m.attachment && <Attachment a={m.attachment} />}
      {m.card && <ConvCard m={m} onClaim={onClaim} claiming={claiming} />}
      <div className="mt-0.5 flex items-center justify-end gap-1.5 text-[10.5px] text-t3">
        {m.pinned && <Pin className="h-3 w-3" aria-label="已置頂" />}
        {m.read && m.read.total > 0 && (
          <span title={m.read.names.length ? `已讀：${m.read.names.join("、")}` : "未有人讀"} data-e2e="wg-read">
            {m.read.count >= m.read.total ? "全部已讀" : `已讀 ${m.read.count}/${m.read.total}`}
          </span>
        )}
        <span>{hm(m.createdAt)}</span>
        {!archived && (
          <button
            type="button"
            onClick={() => onPin(m)}
            className="rounded-full p-0.5 text-t3 hover:bg-panel-2 hover:text-t1 md:opacity-0 md:group-hover:opacity-100"
            aria-label={m.pinned ? "取消置頂" : "置頂"}
            title={m.pinned ? "取消置頂" : "置頂"}
            data-e2e="wg-pin"
          >
            {m.pinned ? <PinOff className="h-3 w-3" aria-hidden /> : <Pin className="h-3 w-3" aria-hidden />}
          </button>
        )}
      </div>
    </div>
  );
}

export default function WorkgroupsClient({
  meId,
  canManage,
  initialGroupId,
  initialTab = "groups",
}: {
  meId: string;
  canManage: boolean;
  initialGroupId: string | null;
  initialTab?: "groups" | "external";
}) {
  const [tab, setTab] = useState<"groups" | "external">(initialGroupId ? "groups" : initialTab);
  const [groups, setGroups] = useState<GroupRow[] | null>(null);
  const [ext, setExt] = useState<ExtRow[] | null>(null);
  const [sel, setSel] = useState<string | null>(initialGroupId);
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [pinned, setPinned] = useState<PinnedRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [text, setText] = useState("");
  const [mentionIds, setMentionIds] = useState<Map<string, string>>(new Map()); // id → name
  const [picker, setPicker] = useState<string | null>(null); // @ 之後打咗嘅字
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Msg[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const pendingKey = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const selRef = useRef(sel);
  selRef.current = sel;
  const tabRef = useRef(tab);
  tabRef.current = tab;

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

  const loadExt = useCallback(async () => {
    try {
      const r = await fetch("/api/workgroups/external");
      if (!r.ok) return;
      const d = (await r.json()) as { items: ExtRow[] };
      setExt(d.items);
    } catch {
      /* 下次再拉 */
    }
  }, []);

  const markRead = useCallback(async (gid: string) => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    await fetch(`/api/workgroups/${encodeURIComponent(gid)}/read`, { method: "POST" }).catch(() => {});
    setGroups((prev) => prev?.map((g) => (g.id === gid ? { ...g, unread: 0, mentionUnread: 0 } : g)) ?? prev);
  }, []);

  const loadMsgs = useCallback(
    async (gid: string, before?: string, opts?: { noRead?: boolean }) => {
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
        const d = (await r.json()) as { group: GroupDetail; messages: Msg[]; pinned: PinnedRow[]; hasMore: boolean };
        if (selRef.current !== gid) return;
        setDetail(d.group);
        setPinned(d.pinned ?? []);
        if (!before) setHasMore(d.hasMore);
        else setHasMore(d.hasMore);
        setMsgs((prev) => {
          if (before) return [...d.messages, ...prev.filter((m) => !d.messages.some((x) => x.id === m.id))];
          // 最新一頁：同已載入嘅舊訊息合併（新一頁覆蓋同 id 嘅舊版本 — 已讀／接手狀態更新）
          const ids = new Set(d.messages.map((m) => m.id));
          const older = prev.filter((m) => !ids.has(m.id) && (d.messages[0] ? m.createdAt < d.messages[0].createdAt : true));
          return [...older, ...d.messages];
        });
        if (!before) {
          if (!opts?.noRead) void markRead(gid);
          if (!opts?.noRead) requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: "end" }));
        }
      } finally {
        setLoadingMsgs(false);
      }
    },
    [loadGroups, markRead],
  );

  useEffect(() => {
    void loadGroups();
    void loadExt();
  }, [loadGroups, loadExt]);

  useEffect(() => {
    setMsgs([]);
    setPinned([]);
    setDetail(null);
    setText("");
    setMentionIds(new Map());
    setErr(null);
    setFile(null);
    setSearchOpen(false);
    setResults(null);
    setQ("");
    if (sel) void loadMsgs(sel);
  }, [sel, loadMsgs]);

  useEffect(() => {
    const socket = io({ withCredentials: true, transports: ["websocket", "polling"] });
    socket.on("workgroup:message", (p: { groupId?: string }) => {
      if (p?.groupId && p.groupId === selRef.current) void loadMsgs(p.groupId);
      void loadGroups();
    });
    socket.on("workgroup:changed", (p: { groupId?: string }) => {
      void loadGroups();
      if (selRef.current && (!p?.groupId || p.groupId === selRef.current)) void loadMsgs(selRef.current, undefined, { noRead: true });
    });
    // 已讀人數：只係重拉（唔再 markRead — 防兩邊互相觸發）
    socket.on("workgroup:read", (p: { groupId?: string }) => {
      if (p?.groupId && p.groupId === selRef.current) void loadMsgs(p.groupId, undefined, { noRead: true });
    });
    // 外部對話：新訊息／標記變動 → 重拉（輕量；只喺睇緊外部分頁先拉）
    let extTimer: number | null = null;
    const bumpExt = () => {
      if (extTimer !== null) return;
      extTimer = window.setTimeout(() => {
        extTimer = null;
        void loadExt();
      }, 800);
    };
    socket.on("message:new", bumpExt);
    socket.on("conv:updated", bumpExt);
    const onVis = () => {
      if (document.visibilityState === "visible") {
        if (selRef.current) void markRead(selRef.current);
        if (tabRef.current === "external") void loadExt();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      socket.disconnect();
      if (extTimer !== null) window.clearTimeout(extTimer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loadGroups, loadMsgs, markRead, loadExt]);

  const pickerList = useMemo(() => {
    if (picker === null || !detail) return [];
    const ql = picker.toLowerCase();
    return detail.members.filter((m) => m.id !== meId && m.active && m.name.toLowerCase().includes(ql)).slice(0, 8);
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
    if (!body && !file) return;
    setSending(true);
    setErr(null);
    pendingKey.current ??= newKey();
    // 只保留內文仲有 @名 嘅人
    const mentions = [...mentionIds.entries()].filter(([, n]) => body.includes(`@${n}`)).map(([id]) => id);
    try {
      let r: Response;
      if (file) {
        const fd = new FormData();
        fd.set("file", file);
        fd.set("body", body);
        fd.set("clientKey", pendingKey.current);
        r = await fetch(`/api/workgroups/${encodeURIComponent(sel)}/attachments`, { method: "POST", body: fd });
      } else {
        r = await fetch(`/api/workgroups/${encodeURIComponent(sel)}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body, mentions, clientKey: pendingKey.current }),
        });
      }
      const d = (await r.json().catch(() => null)) as { message?: string } | null;
      if (!r.ok) {
        setErr(d?.message ?? "發送失敗");
        if (r.status < 500 && r.status !== 429) pendingKey.current = null;
        return;
      }
      pendingKey.current = null;
      setText("");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      setMentionIds(new Map());
      await loadMsgs(sel);
    } catch {
      setErr("網絡錯誤 — 再撳一次會重試（唔會重複發）");
    } finally {
      setSending(false);
    }
  }

  async function claim(m: Msg) {
    if (!sel || claimingId) return;
    setClaimingId(m.id);
    setErr(null);
    try {
      const r = await fetch(`/api/workgroups/${encodeURIComponent(sel)}/messages/${encodeURIComponent(m.id)}/claim`, { method: "POST" });
      const d = (await r.json().catch(() => null)) as { message?: string; conversationId?: string } | null;
      if (!r.ok) setErr(d?.message ?? "接唔到");
      await loadMsgs(sel, undefined, { noRead: true });
    } catch {
      setErr("網絡錯誤，請再試");
    } finally {
      setClaimingId(null);
    }
  }

  async function togglePin(m: Msg) {
    if (!sel) return;
    setErr(null);
    const r = await fetch(`/api/workgroups/${encodeURIComponent(sel)}/messages/${encodeURIComponent(m.id)}/pin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: !m.pinned }),
    }).catch(() => null);
    if (!r) return setErr("網絡錯誤，請再試");
    if (!r.ok) {
      const d = (await r.json().catch(() => null)) as { message?: string } | null;
      setErr(d?.message ?? "置頂失敗");
    }
    await loadMsgs(sel, undefined, { noRead: true });
  }

  async function runSearch() {
    if (!sel || !q.trim() || searching) return;
    setSearching(true);
    try {
      const r = await fetch(`/api/workgroups/${encodeURIComponent(sel)}/search?q=${encodeURIComponent(q.trim())}`);
      const d = (await r.json().catch(() => null)) as { messages?: Msg[]; message?: string } | null;
      if (!r.ok) {
        setErr(d?.message ?? "搵唔到");
        return;
      }
      setResults(d?.messages ?? []);
    } finally {
      setSearching(false);
    }
  }

  function pickFile(f: File | null) {
    setErr(null);
    if (!f) return setFile(null);
    if (f.size > 10 * 1024 * 1024) {
      setErr("檔案太大（最多 10MB）");
      return;
    }
    if (!/^(image\/(jpeg|png)|application\/pdf)$/.test(f.type) && !/\.(jpe?g|png|pdf)$/i.test(f.name)) {
      setErr("只支援 JPG／PNG 相片或者 PDF");
      return;
    }
    pendingKey.current = null;
    setFile(f);
  }

  const current = groups?.find((g) => g.id === sel) ?? null;
  const archived = detail?.archived ?? current?.archived ?? false;
  const extUnread = (ext ?? []).filter((x) => x.unread > 0).length;
  const groupUnread = (groups ?? []).filter((g) => !g.archived).reduce((n, g) => n + g.unread, 0);

  return (
    <div className="flex h-full min-h-0 bg-canvas">
      {/* 群組列 */}
      <aside className={`w-full md:w-[300px] shrink-0 md:border-r border-line bg-panel flex-col min-h-0 ${sel ? "hidden md:flex" : "flex"}`} data-e2e="wg-list">
        <div className="flex items-center gap-2 px-4 pt-4 pb-2">
          <h1 className="text-[20px] font-normal text-t1">工作群</h1>
          {canManage && tab === "groups" && (
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
        <div className="flex gap-1.5 px-4 pb-2" role="tablist" data-e2e="wg-tabs">
          {(
            [
              ["groups", "群組", groupUnread],
              ["external", "外部對話", extUnread],
            ] as const
          ).map(([k, label, n]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => {
                setTab(k);
                if (k === "external") void loadExt();
              }}
              className={`rounded-full px-3 py-1 text-xs ${tab === k ? "bg-t1 font-semibold text-panel" : "bg-panel-2 text-t2"}`}
              data-e2e={`wg-tab-${k}`}
            >
              {label}
              {n > 0 ? ` ${n}` : ""}
            </button>
          ))}
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-2.5 pb-24 md:pb-3">
          {tab === "external" ? (
            ext === null ? (
              <WLoading />
            ) : ext.length === 0 ? (
              <div className="px-3 py-10 text-center text-sm text-t3">
                未有外部對話
                <div className="mt-1 text-xs leading-relaxed">Lab 師傅、供應商 WhatsApp 嚟：喺收件箱對話頂部 ⋯ →「標記做外部人 → 移去工作群」</div>
              </div>
            ) : (
              ext.map((x) => (
                <Link
                  key={x.conversationId}
                  href={`/inbox?conv=${encodeURIComponent(x.conversationId)}`}
                  className="mb-1 flex w-full items-center gap-2.5 rounded-2xl px-2.5 py-2 text-left hover:bg-panel-2"
                  data-e2e="wg-ext-row"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ok-soft text-[13px] font-semibold text-ok-text">{x.name.slice(0, 1)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1 text-[13.5px] font-semibold text-t1">
                      <span className="truncate">{x.name}</span>
                      {x.clinicCode && <span className="shrink-0 rounded-full bg-panel-2 px-1.5 text-[10px] font-normal text-t2">{x.clinicCode}</span>}
                    </span>
                    <span className="block truncate text-[11.5px] text-t2">
                      {x.org ? `${x.org} · ` : ""}
                      {x.lastPreview ? `${x.lastFromThem ? "" : "你哋："}${x.lastPreview}` : "未有訊息"}
                    </span>
                  </span>
                  {x.unread > 0 && <span className="shrink-0 rounded-full bg-brand px-1.5 py-0.5 text-[10.5px] text-panel">{x.unread}</span>}
                </Link>
              ))
            )
          ) : groups === null ? (
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
            <div className="text-sm">{tab === "external" ? "撳左邊外部對話 — 會喺收件箱畫面打開" : "揀一個群組開始"}</div>
          </div>
        ) : (
          <>
            <header className="flex items-center gap-2 border-b border-line bg-panel px-3 py-2.5 md:px-4">
              <button type="button" onClick={() => setSel(null)} className="md:hidden rounded-full p-1 hover:bg-panel-2" aria-label="返回群組列表">
                <ArrowLeft className="h-5 w-5" aria-hidden />
              </button>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-semibold text-t1">{detail?.name ?? current?.name ?? ""}</div>
                {detail && (
                  <div className="truncate text-[11px] text-t3" title={detail.members.map((m) => m.name).join("、")}>
                    {detail.members.length} 人：{detail.members.map((m) => m.name).join("、")}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  setSearchOpen((v) => !v);
                  setResults(null);
                }}
                className={`shrink-0 rounded-full p-1.5 hover:bg-panel-2 ${searchOpen ? "bg-panel-2" : ""}`}
                aria-label="搜尋訊息"
                data-e2e="wg-search-open"
              >
                <Search className="h-4 w-4 text-t2" aria-hidden />
              </button>
            </header>
            {searchOpen && (
              <div className="border-b border-line bg-panel px-3 py-2 md:px-4" data-e2e="wg-search">
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    value={q}
                    maxLength={50}
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) void runSearch();
                    }}
                    placeholder="搵訊息或者檔名…"
                    className="min-w-0 flex-1 rounded-full border border-line bg-panel-2 px-3 py-1.5 text-sm"
                    data-e2e="wg-search-input"
                  />
                  <button type="button" onClick={() => void runSearch()} disabled={!q.trim() || searching} className="rounded-full bg-brand px-3 py-1.5 text-xs text-panel disabled:opacity-50">
                    {searching ? "搵緊…" : "搵"}
                  </button>
                </div>
                {results && (
                  <div className="mt-2 max-h-72 overflow-y-auto" data-e2e="wg-search-results">
                    {results.length === 0 ? (
                      <div className="py-3 text-center text-xs text-t3">搵唔到</div>
                    ) : (
                      results.map((m) => (
                        <div key={m.id} className="border-b border-line py-1.5 text-[12.5px]" data-e2e="wg-search-hit">
                          <div className="text-[11px] text-t3">
                            {m.senderName} · {hm(m.createdAt)}
                          </div>
                          {m.body && <div className="whitespace-pre-wrap break-words text-t1">{m.body}</div>}
                          {m.attachment && <div className="text-t2">📎 {m.attachment.name}</div>}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
            {pinned.length > 0 && (
              <div className="border-b border-line bg-warn-soft/60 px-3 py-1.5 md:px-4" data-e2e="wg-pinned">
                {pinned.map((p) => (
                  <div key={p.id} className="flex items-center gap-1.5 truncate text-[12px] text-t1">
                    <Pin className="h-3 w-3 shrink-0 text-warn-text" aria-hidden />
                    <span className="shrink-0 font-semibold">{p.senderName}：</span>
                    <span className="truncate">{p.preview}</span>
                  </div>
                ))}
              </div>
            )}
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
                  <Bubble key={m.id} m={m} archived={archived} onClaim={(x) => void claim(x)} claiming={claimingId === m.id} onPin={(x) => void togglePin(x)} />
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
              {err && <div className="mb-1 text-xs text-danger-text" data-e2e="wg-error">{err}</div>}
              {file && (
                <div className="mb-1.5 flex items-center gap-2 rounded-xl border border-line bg-panel-2 px-2.5 py-1.5 text-xs" data-e2e="wg-file-chip">
                  <Paperclip className="h-3.5 w-3.5 shrink-0 text-t2" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{file.name}</span>
                  <span className="shrink-0 text-t3">{kb(file.size)}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setFile(null);
                      if (fileRef.current) fileRef.current.value = "";
                    }}
                    className="rounded-full p-0.5 hover:bg-panel"
                    aria-label="移除檔案"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
              )}
              <div className="flex items-end gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,application/pdf"
                  className="hidden"
                  onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                  data-e2e="wg-file-input"
                />
                <button
                  type="button"
                  disabled={archived || sending}
                  onClick={() => fileRef.current?.click()}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line text-t2 hover:bg-panel-2 disabled:opacity-40"
                  aria-label="附件（相片／PDF）"
                  data-e2e="wg-attach"
                >
                  <Paperclip className="h-4 w-4" aria-hidden />
                </button>
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
                  placeholder={archived ? "已封存" : file ? "加句說明（可以唔寫）" : "輸入訊息…（打 @ 揀同事）"}
                  className="max-h-32 min-h-[40px] flex-1 resize-none rounded-2xl border border-line bg-panel-2 px-3 py-2 text-sm text-t1 disabled:opacity-60"
                  data-e2e="wg-input"
                />
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={archived || sending || (!text.trim() && !file)}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand text-panel disabled:opacity-40"
                  aria-label="發送"
                  data-e2e="wg-send"
                >
                  <Send className="h-4 w-4" aria-hidden />
                </button>
              </div>
              <div className="mt-1 hidden text-[10.5px] text-t3 md:block">
                <MessageSquareShare className="mr-1 inline h-3 w-3" aria-hidden />
                分享病人對話：喺對話頂部 ⋯ → 分享去工作群（可以揀「分享並放手」）
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

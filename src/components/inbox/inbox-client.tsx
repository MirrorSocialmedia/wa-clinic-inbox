"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  ClinicInfo,
  ConversationItem,
  ConvStatus,
  ConvUpdatedEvent,
  MessageItem,
  MessageStatusEvent,
  NewMessageEvent,
  StaffInfo,
  UserCtx,
} from "./types";
import { ConversationList } from "./conversation-list";
import { ChatPane } from "./chat-pane";
import { DetailPane } from "./detail-pane";

const PAGE_SIZE = 50;
const WINDOW_MS = 24 * 3600 * 1000;

interface ContactSearchHit {
  id: string;
  waId: string;
  profileName: string | null;
  labels: string[];
  clinicId: string;
}

/**
 * Inbox 主 client（MD §6.4 三欄）。
 *
 * Socket.IO：
 * - login 後即連（iron-session cookie 自動帶，server hub 驗 session 先 join room）
 * - message:new / message:status / conv:updated 實時更新
 * - 斷線重連 → 用 lastMessageAt 拉 backlog 補漏（GET /api/conversations/[id]/messages?after=...）
 */
export function InboxClient({
  user,
  initialClinics,
  initialConversations,
  initialStaff,
}: {
  user: UserCtx;
  initialClinics: ClinicInfo[];
  initialConversations: ConversationItem[];
  initialStaff: StaffInfo[];
}) {
  const clinics = initialClinics;
  const staff = initialStaff;
  const [conversations, setConversations] = useState<ConversationItem[]>(initialConversations);
  const [activeClinicId, setActiveClinicId] = useState<string | "all">(
    user.role === "STAFF" ? (user.clinicId ?? "all") : "all"
  );
  const [statusFilter, setStatusFilter] = useState<ConvStatus | "ALL">("ALL");
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<ConversationItem[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const lastMsgTsRef = useRef<number>(0); // 斷線前最後訊息時間（backlog cursor）
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesRef = useRef<MessageItem[]>([]);
  const activeClinicRef = useRef<string | "all">(activeClinicId);
  selectedIdRef.current = selectedConvId;
  messagesRef.current = messages;
  activeClinicRef.current = activeClinicId;

  // ── socket ────────────────────────────────────────────────────────────
  useEffect(() => {
    const socket = io({ withCredentials: true, transports: ["websocket", "polling"] });
    socketRef.current = socket;

    socket.on("message:new", (e: NewMessageEvent) => {
      if (e.message.waTimestamp) {
        lastMsgTsRef.current = Math.max(lastMsgTsRef.current, new Date(e.message.waTimestamp).getTime());
      }
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.id === e.conversationId);
        const msg = e.message;
        const isOut = msg.direction === "OUT";
        const existing = idx >= 0 ? prev[idx] : null;
        const item: ConversationItem = {
          id: e.conversationId,
          clinicId: e.clinicId,
          contactId: e.contact?.id ?? existing?.contactId ?? "",
          status: e.conversation.status,
          assigneeId: existing?.assigneeId ?? null,
          assigneeName: existing?.assigneeName ?? null,
          unreadCount: isOut ? (existing?.unreadCount ?? 0) : e.conversation.unreadCount,
          lastInboundAt: isOut
            ? existing?.lastInboundAt ?? null
            : (e.conversation.lastInboundAt ?? null),
          lastMessageAt: msg.waTimestamp,
          intent: existing?.intent ?? null,
          contact: e.contact ?? existing?.contact ?? null,
          window: windowFromLastInbound(
            isOut ? (existing?.lastInboundAt ?? null) : (e.conversation.lastInboundAt ?? null)
          ),
          preview: msg.body ?? `[${msg.type}]`,
        };
        if (idx === -1) {
          // 新對話：insert 排頭（按 lastMessageAt desc 大致排序）
          const next = [item, ...prev];
          next.sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());
          return next;
        }
        const next = [...prev];
        next[idx] = item;
        return next;
      });

      if (selectedIdRef.current === e.conversationId) {
        const msg = e.message;
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id || (msg.waMessageId && m.waMessageId === msg.waMessageId))) return prev;
          return [...prev, msg].sort((a, b) => new Date(a.waTimestamp).getTime() - new Date(b.waTimestamp).getTime());
        });
      }
    });

    socket.on("message:status", (e: MessageStatusEvent) => {
      if (selectedIdRef.current !== e.conversationId) return;
      setMessages((prev) =>
        prev.map((m) => (m.waMessageId === e.waMessageId || m.id === e.waMessageId ? { ...m, status: e.status, errorCode: e.errorCode } : m))
      );
    });

    socket.on("conv:updated", (e: ConvUpdatedEvent) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === e.conversationId
            ? {
                ...c,
                status: e.status,
                assigneeId: e.assigneeId,
                assigneeName: e.assigneeId ? staffRef.current.find((s) => s.id === e.assigneeId)?.name ?? null : null,
                unreadCount: e.unreadCount,
              }
            : c
        )
      );
    });

    // 斷線重連 → backlog 補漏
    let wasDisconnected = false;
    socket.on("disconnect", () => {
      wasDisconnected = true;
    });
    socket.on("connect", () => {
      if (wasDisconnected) {
        wasDisconnected = false;
        // 1) 刷新對話列表
        void fetchConversations(activeClinicRef.current);
        // 2) 選中對話用 after= 補漏
        if (selectedIdRef.current && lastMsgTsRef.current > 0) {
          void fetchMessagesAfter(selectedIdRef.current, lastMsgTsRef.current);
        }
      }
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // staffRef：socket handler 要最新 staff 名（assigneeName 顯示）
  const staffRef = useRef<StaffInfo[]>(initialStaff);
  staffRef.current = staff;

  // ── data fetchers ─────────────────────────────────────────────────────
  const fetchConversations = useCallback(async (clinicId: string | "all") => {
    try {
      const qs = clinicId !== "all" ? `?clinicId=${clinicId}` : "";
      const res = await fetch(`/api/conversations${qs}`);
      if (!res.ok) return;
      const data = (await res.json()) as ConversationItem[];
      setConversations(data);
    } catch {
      /* UI 會喺下次 action 補齊 */
    }
  }, []);

  const fetchMessagesLatest = useCallback(async (convId: string) => {
    try {
      const res = await fetch(`/api/conversations/${convId}/messages?limit=${PAGE_SIZE}`);
      if (!res.ok) return;
      const data = (await res.json()) as { messages: MessageItem[]; hasMore: boolean };
      setMessages(data.messages);
      setHasMore(data.hasMore);
      if (data.messages.length > 0) {
        lastMsgTsRef.current = Math.max(lastMsgTsRef.current, new Date(data.messages[data.messages.length - 1].waTimestamp).getTime());
      }
    } catch {
      /* ignore */
    }
  }, []);

  const fetchMessagesAfter = useCallback(async (convId: string, afterMs: number) => {
    try {
      const res = await fetch(
        `/api/conversations/${convId}/messages?after=${new Date(afterMs).toISOString()}&limit=${PAGE_SIZE}`
      );
      if (!res.ok) return;
      const data = (await res.json()) as { messages: MessageItem[] };
      setMessages((prev) => {
        const ids = new Set(prev.map((m) => m.id));
        const added = data.messages.filter((m) => !ids.has(m.id));
        return [...prev, ...added].sort((a, b) => new Date(a.waTimestamp).getTime() - new Date(b.waTimestamp).getTime());
      });
    } catch {
      /* ignore */
    }
  }, []);

  const loadOlder = useCallback(async () => {
    const convId = selectedIdRef.current;
    if (!convId || loadingOlder) return;
    const oldest = messagesRef.current[0];
    if (!oldest) return;
    setLoadingOlder(true);
    try {
      const res = await fetch(
        `/api/conversations/${convId}/messages?before=${encodeURIComponent(oldest.waTimestamp)}&limit=${PAGE_SIZE}`
      );
      if (!res.ok) return;
      const data = (await res.json()) as { messages: MessageItem[]; hasMore: boolean };
      setMessages((prev) => {
        const ids = new Set(prev.map((m) => m.id));
        const added = data.messages.filter((m) => !ids.has(m.id));
        return [...added, ...prev];
      });
      setHasMore(data.hasMore);
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder]);

  // ── select conversation（markRead + 載入最新訊息） ───────────────────
  const selectConversation = useCallback(
    async (id: string) => {
      if (id.startsWith("contact:")) {
        // search 結果 stub：呢個 contact 未確定有冇對話 → 查返
        const contactId = id.slice("contact:".length);
        try {
          const res = await fetch("/api/conversations");
          if (res.ok) {
            const all = (await res.json()) as ConversationItem[];
            const match = all.find((c) => c.contactId === contactId);
            if (match) {
              setSelectedConvId(match.id);
              void fetchMessagesLatest(match.id);
              void markRead(match.id);
              setSearchResults(null);
              setSearch("");
              return;
            }
          }
        } catch {
          /* fallthrough */
        }
        setNotice("呢個聯絡人仲未有任何對話記錄");
        return;
      }
      setSelectedConvId(id);
      setNotice(null);
      void fetchMessagesLatest(id);
      void markRead(id);
    },
    [fetchMessagesLatest]
  );

  async function markRead(id: string) {
    try {
      await fetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markRead: true }),
      });
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, unreadCount: 0 } : c)));
    } catch {
      /* ignore */
    }
  }

  // ── composer ──────────────────────────────────────────────────────────
  const sendMessage = useCallback(
    async (body: string): Promise<{ ok: boolean; error?: string }> => {
      const convId = selectedIdRef.current;
      if (!convId) return { ok: false, error: "未選擇對話" };
      try {
        const res = await fetch("/api/messages/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId: convId, body }),
        });
        const data = (await res.json().catch(() => null)) as {
          ok?: boolean;
          messageId?: string;
          error?: string;
          message?: string;
        } | null;
        if (res.status === 422) {
          return { ok: false, error: data?.message ?? "窗口已過，只可發 template" };
        }
        if (!res.ok) {
          return { ok: false, error: data?.error ?? `發送失敗（${res.status}）` };
        }
        // 樂觀更新：QUEUED 氣泡（worker 發完會 push message:new 帶真 wamid）
        const optimistic: MessageItem = {
          id: data?.messageId ?? `optimistic-${Date.now()}`,
          conversationId: convId,
          waMessageId: null,
          direction: "OUT",
          channel: "API",
          type: "text",
          body,
          mediaPath: null,
          status: "QUEUED",
          errorCode: null,
          sentByStaffId: user.staffId,
          waTimestamp: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, optimistic]);
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId
              ? { ...c, lastMessageAt: optimistic.waTimestamp, preview: body, status: c.status === "RESOLVED" ? "OPEN" : c.status }
              : c
          )
        );
        return { ok: true };
      } catch {
        return { ok: false, error: "網絡錯誤" };
      }
    },
    [user.staffId]
  );

  // ── 側欄 patch ────────────────────────────────────────────────────────
  const patchConversation = useCallback(
    async (body: { status?: ConvStatus; assigneeId?: string | null }) => {
      const convId = selectedIdRef.current;
      if (!convId) return;
      try {
        const res = await fetch(`/api/conversations/${convId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          const data = (await res.json()) as Partial<ConversationItem>;
          setConversations((prev) =>
            prev.map((c) =>
              c.id === convId
                ? { ...c, status: (data.status as ConvStatus) ?? c.status, assigneeId: data.assigneeId ?? c.assigneeId }
                : c
            )
          );
        }
      } catch {
        /* ignore */
      }
    },
    []
  );

  // ── search（debounce 300ms） ─────────────────────────────────────────
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!search.trim()) {
      setSearchResults(null);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      try {
        const clinicQs = activeClinicId !== "all" ? `&clinicId=${activeClinicId}` : "";
        const res = await fetch(`/api/search?type=contact&q=${encodeURIComponent(search.trim())}${clinicQs}`);
        if (!res.ok) {
          setSearchResults([]);
          return;
        }
        const data = (await res.json()) as { results: ContactSearchHit[] };
        const items: ConversationItem[] = data.results.map((hit) => {
          const existing = conversations.find((c) => c.contactId === hit.id);
          if (existing) return existing;
          return {
            id: `contact:${hit.id}`,
            clinicId: hit.clinicId,
            contactId: hit.id,
            status: "OPEN",
            assigneeId: null,
            assigneeName: null,
            unreadCount: 0,
            lastInboundAt: null,
            lastMessageAt: new Date(0).toISOString(),
            intent: null,
            contact: { id: hit.id, waId: hit.waId, profileName: hit.profileName, labels: hit.labels },
            window: { open: false, remainingMs: 0, remainingHours: 0, tone: "red" },
            preview: "（未開始對話）",
          };
        });
        setSearchResults(items);
      } catch {
        setSearchResults([]);
      }
    }, 300);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [search, activeClinicId, conversations]);

  // ── 隊列列表 filter（client 端：activeClinicId + statusFilter 喺 component 內做） ──
  const visibleConversations = useMemo(() => {
    if (user.role === "STAFF") return conversations; // 已 scoped
    if (activeClinicId === "all") return conversations;
    return conversations.filter((c) => c.clinicId === activeClinicId);
  }, [conversations, activeClinicId, user.role]);

  const selectedConv = useMemo(
    () => conversations.find((c) => c.id === selectedConvId) ?? null,
    [conversations, selectedConvId]
  );

  return (
    <div className="h-[calc(100vh-3rem)] flex min-h-0">
      <ConversationList
        userRole={user.role}
        clinics={clinics}
        activeClinicId={activeClinicId}
        onActiveClinic={(id) => {
          setActiveClinicId(id);
          setSearchResults(null);
          setSearch("");
          void fetchConversations(id);
        }}
        statusFilter={statusFilter}
        onStatusFilter={setStatusFilter}
        conversations={visibleConversations}
        selectedId={selectedConvId}
        onSelect={(id) => void selectConversation(id)}
        search={search}
        onSearch={setSearch}
        searchResults={searchResults}
        onClearSearch={() => {
          setSearch("");
          setSearchResults(null);
        }}
      />

      <ChatPane
        conversation={selectedConv}
        messages={messages}
        hasMore={hasMore}
        loadingOlder={loadingOlder}
        onScrollTop={() => void loadOlder()}
        window={selectedConv?.window ?? null}
        onSend={sendMessage}
        staffName={user.name}
      />

      <DetailPane conversation={selectedConv} staff={staff} onPatch={patchConversation} />

      {notice && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-neutral-900 text-white text-sm px-4 py-2 rounded-lg shadow-lg z-50">
          {notice}
          <button onClick={() => setNotice(null)} className="ml-3 text-neutral-400 hover:text-white">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

function windowFromLastInbound(lastInboundAt: string | null | undefined) {
  const lastIn = lastInboundAt ? new Date(lastInboundAt).getTime() : null;
  const remainingMs = lastIn === null ? 0 : Math.max(0, lastIn + WINDOW_MS - Date.now());
  return {
    open: remainingMs > 0,
    remainingMs,
    remainingHours: remainingMs / 3600000,
    tone: (!remainingMs ? "red" : remainingMs < 6 * 3600 * 1000 ? "yellow" : "green") as "red" | "yellow" | "green",
  };
}

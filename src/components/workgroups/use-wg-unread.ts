"use client";

/** ★ cwi-workgroup：導航「工作群」badge — 每 30 秒拉一次 + 返到前台即刻拉（輕量；唔開第二條 socket） */
import { useEffect, useState } from "react";

export function useWorkgroupUnread(): { unread: number; mention: number } {
  const [v, setV] = useState({ unread: 0, mention: 0 });
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/workgroups/unread")
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { unread?: number; mention?: number } | null) => {
          if (!cancelled && d && typeof d.unread === "number") setV({ unread: d.unread, mention: d.mention ?? 0 });
        })
        .catch(() => {});
    };
    load();
    const t = window.setInterval(load, 30_000);
    const onVis = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
  return v;
}

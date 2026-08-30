"use client";

/**
 * "Background tasks" — the right-hand activity column on the chat page,
 * Claude-Code style: every pipeline step the server runs for this enquiry
 * (client/deal ID issuance, Drive workspace, funnel row, file uploads)
 * shows up here live, with running / completed / failed status.
 *
 * The Chat client owns the session id; this panel follows it through
 * sessionStorage plus three window events Chat dispatches:
 *   xor:session  (CustomEvent<string>) — session created/resumed
 *   xor:busy     — a server call just started  → poll fast (running states)
 *   xor:activity — a server call just finished → refresh, back to slow poll
 * The slow poll (while any task exists) also catches cron-retry recoveries.
 * Renders nothing until the session has at least one task.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { TaskRow } from "@/lib/supabase";

const SESSION_KEY = "xor_session_id";

export default function TasksPanel() {
  // Lazy initializer: throws (and yields null) during SSR, reads the stored
  // session in the browser. Initial output is null either way (no tasks yet),
  // so hydration stays consistent.
  const [sessionId, setSessionId] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(SESSION_KEY);
    } catch {
      return null;
    }
  });
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [showDone, setShowDone] = useState(true);
  // Panel width preference (small/big) — sticky per browser.
  const [big, setBig] = useState<boolean>(() => {
    try {
      return localStorage.getItem("xor_tasks_size") === "big";
    } catch {
      return false;
    }
  });
  // Rows expanded to show their full detail line (long research queries).
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
  const toggleOpen = useCallback((id: string) => {
    setOpenIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const toggleSize = useCallback(() => {
    setBig((v) => {
      try {
        localStorage.setItem("xor_tasks_size", v ? "small" : "big");
      } catch {
        // preference just won't stick
      }
      return !v;
    });
  }, []);

  // Tracks the session the feed belongs to. Chat announces xor:session on
  // EVERY (re)open — including the reload of the same conversation — and
  // wiping the feed for the same session left the panel empty and unpolled
  // ("status is not visible after refresh"). Clear only on a real switch.
  const sidRef = useRef<string | null>(null);
  useEffect(() => {
    sidRef.current = sessionId;
    // run once after the lazy initializer — keep ref/state in sync
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const onSession = (e: Event) => {
      const next = (e as CustomEvent<string>).detail ?? null;
      if (sidRef.current === next) return; // same conversation — keep the feed
      sidRef.current = next;
      setTasks([]); // a fresh/switched enquiry starts with a clean feed
      setSessionId(next);
    };
    window.addEventListener("xor:session", onSession);
    return () => window.removeEventListener("xor:session", onSession);
  }, []);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    const t = await fetchTasks(sessionId);
    if (t) setTasks(t);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    void (async () => {
      const t = await fetchTasks(sessionId);
      if (alive && t) setTasks(t);
    })();
    const onBusy = () => setChatBusy(true);
    const onActivity = () => {
      setChatBusy(false);
      void refresh();
    };
    window.addEventListener("xor:busy", onBusy);
    window.addEventListener("xor:activity", onActivity);
    return () => {
      alive = false;
      window.removeEventListener("xor:busy", onBusy);
      window.removeEventListener("xor:activity", onActivity);
    };
  }, [sessionId, refresh]);

  const anyRunning = tasks.some((t) => t.status === "running");
  useEffect(() => {
    if (!sessionId) return;
    if (!chatBusy && !anyRunning && tasks.length === 0) return; // nothing to watch yet
    const ms = chatBusy || anyRunning ? 1500 : 12000;
    const id = setInterval(() => void refresh(), ms);
    return () => clearInterval(id);
  }, [sessionId, chatBusy, anyRunning, tasks.length, refresh]);

  if (!tasks.length) return null;

  const running = tasks.filter((t) => t.status === "running");
  const done = tasks.filter((t) => t.status !== "running");

  return (
    <aside className={`tasks-panel${big ? " big" : ""}`} aria-label="Background tasks">
      <div className="tp-head">
        <span>Background tasks</span>
        <span className="tp-head-right">
          {running.length > 0 && (
            <span className="tp-live" aria-live="polite">
              {running.length} running
            </span>
          )}
          <button
            type="button"
            className="tp-size"
            onClick={toggleSize}
            aria-label={big ? "Shrink the panel" : "Widen the panel"}
            title={big ? "Small panel" : "Big panel"}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              {big ? (
                <path
                  d="M9 5 3 12l6 7M21 12H4"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ) : (
                <path
                  d="m15 5 6 7-6 7M3 12h17"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
            </svg>
          </button>
        </span>
      </div>
      <div className="tp-scroll">
        {running.map((t) => (
          <TaskCard key={t.id} t={t} open={openIds.has(t.id)} onToggle={toggleOpen} />
        ))}
        {done.length > 0 && (
          <button
            type="button"
            className="tp-finished"
            aria-expanded={showDone}
            onClick={() => setShowDone((v) => !v)}
          >
            <span className="tp-chev" aria-hidden="true">
              {showDone ? "▾" : "▸"}
            </span>
            Finished {done.length}
          </button>
        )}
        {showDone &&
          [...done].reverse().map((t) => (
            <TaskCard key={t.id} t={t} open={openIds.has(t.id)} onToggle={toggleOpen} />
          ))}
      </div>
    </aside>
  );
}

/** One feed fetch; null on any failure — the next poll gets it. */
async function fetchTasks(sessionId: string): Promise<TaskRow[] | null> {
  try {
    const r = await fetch(`/api/tasks?session=${encodeURIComponent(sessionId)}`);
    if (!r.ok) return null;
    const body = (await r.json()) as { tasks?: TaskRow[] };
    return body.tasks ?? [];
  } catch {
    return null;
  }
}

const STATUS_TEXT: Record<TaskRow["status"], string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
};

function TaskCard({
  t,
  open,
  onToggle,
}: {
  t: TaskRow;
  open: boolean;
  onToggle: (id: string) => void;
}) {
  // Long detail lines (live research queries) truncate; a click expands the
  // row in place instead of the panel growing wider.
  const expandable = Boolean(t.detail && t.detail.length > 40);
  return (
    <div
      className={`tp-card${open ? " open" : ""}${expandable ? " expandable" : ""}`}
      onClick={expandable ? () => onToggle(t.id) : undefined}
      title={expandable && !open ? "Click to see the full line" : undefined}
    >
      <div className="tp-label">{t.label}</div>
      <div className={`tp-status ${t.status}`}>
        <i aria-hidden="true" />
        {STATUS_TEXT[t.status]}
        {t.detail ? <span className="tp-detail"> · {t.detail}</span> : null}
      </div>
    </div>
  );
}

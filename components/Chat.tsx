"use client";

/**
 * XOR Assist chat client — React port of reference/web/index.html.
 *
 * Transport: everything conversational goes through POST /api/chat with the
 * ChatIn envelope; files never do. Uploads are three steps:
 *   1. POST /api/upload-url   → { url, token, storage_path } (4xx → { detail })
 *   2. PUT the raw bytes to url (relative in mock mode, absolute for Supabase)
 *   3. POST /api/upload-complete → ChatOut, rendered like any other turn
 *
 * The session id lives in state + sessionStorage ("xor_session_id") so a
 * reload resumes the same conversation via {kind:"open", session_id}.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";

import { getAccessToken } from "@/lib/client-auth";
import type { ChatIn, ChatOut, ChecklistItemDef, SessionState, Widget } from "@/lib/widgets";
import { WidgetView } from "./widgets";

const SESSION_KEY = "xor_session_id";

const STATE_LABELS: Record<SessionState, string> = {
  DISCOVER: "understanding your need",
  TRACK_CONFIRM: "confirming track",
  CONTACT: "contact details",
  CLIENT_INDUSTRY: "about your company",
  CLIENT_ORGSIZE: "about your company",
  ODM_SLOTS: "requirement capture",
  ODM_REVIEW: "review",
  EMS_CHECKLIST: "build package",
  EMS_DETAILS: "build details",
  PRODUCT_CATEGORY: "product enquiry",
  PRODUCT_DETAILS: "product enquiry",
  DONE: "logged ✓",
};

type Who = "bot" | "user" | "sys";

type Entry =
  | { id: number; kind: "msg"; who: Who; text: string }
  | { id: number; kind: "widgets"; widgets: Widget[]; frozen: boolean };

export default function Chat() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [awaiting, setAwaiting] = useState(false); // typing dots (chat posts only)
  const [status, setStatus] = useState("online");
  const [draft, setDraft] = useState("");

  const busyRef = useRef(false);
  const sessionRef = useRef<string | null>(null);
  const idRef = useRef(0);
  const openedRef = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ── transcript helpers ──────────────────────────────────────────────────
  const addMsg = useCallback((text: string, who: Who) => {
    const id = ++idRef.current;
    setEntries((es) => [...es, { id, kind: "msg", who, text }]);
  }, []);

  /** Dim + disable every live widget zone (used or superseded by a new turn). */
  const freezeAll = useCallback(() => {
    setEntries((es) =>
      es.map((e) => (e.kind === "widgets" && !e.frozen ? { ...e, frozen: true } : e)),
    );
  }, []);

  const render = useCallback((res: ChatOut) => {
    sessionRef.current = res.session_id;
    try {
      sessionStorage.setItem(SESSION_KEY, res.session_id);
    } catch {
      // private mode — session just won't survive a reload
    }
    const additions: Entry[] = [];
    for (const m of res.messages) {
      additions.push({ id: ++idRef.current, kind: "msg", who: "bot", text: m });
    }
    if (res.widgets.length) {
      additions.push({ id: ++idRef.current, kind: "widgets", widgets: res.widgets, frozen: false });
    }
    if (additions.length) setEntries((es) => [...es, ...additions]);

    const label = STATE_LABELS[res.meta.state] ?? "online";
    setStatus(
      res.meta.progress
        ? `${label} · ${res.meta.progress.done}/${res.meta.progress.total} ${res.meta.progress.label}`
        : label,
    );
  }, []);

  // ── transport ───────────────────────────────────────────────────────────
  const post = useCallback(
    async (payload: Omit<ChatIn, "session_id">, sessionOverride?: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setAwaiting(true);
      try {
        const body: ChatIn = {
          session_id: sessionOverride ?? sessionRef.current ?? undefined,
          ...payload,
        };
        const token = await getAccessToken();
        const r = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`bad status ${r.status}`);
        render((await r.json()) as ChatOut);
      } catch {
        addMsg("Connection hiccup — please try that again.", "sys");
      } finally {
        busyRef.current = false;
        setBusy(false);
        setAwaiting(false);
        inputRef.current?.focus();
      }
    },
    [addMsg, render],
  );

  // Open (or resume) the session on mount.
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    let stored: string | undefined;
    try {
      stored = sessionStorage.getItem(SESSION_KEY) ?? undefined;
    } catch {
      stored = undefined;
    }
    void post({ kind: "open" }, stored);
  }, [post]);

  // Auto-scroll on new content.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, awaiting]);

  // ── user actions ────────────────────────────────────────────────────────
  const sendText = useCallback(() => {
    const t = draft.trim();
    if (!t || busyRef.current) return;
    addMsg(t, "user");
    freezeAll();
    setDraft("");
    if (inputRef.current) inputRef.current.style.height = "46px";
    void post({ kind: "text", text: t });
  }, [draft, addMsg, freezeAll, post]);

  const onChip = useCallback(
    (chipId: string) => {
      if (busyRef.current) return;
      freezeAll();
      void post({ kind: "chip", chip_id: chipId });
    },
    [freezeAll, post],
  );

  const onForm = useCallback(
    (formId: string, values: Record<string, string>, summary: string) => {
      if (busyRef.current) return;
      freezeAll();
      addMsg(summary, "user");
      void post({ kind: "form", form: { form_id: formId, values } });
    },
    [addMsg, freezeAll, post],
  );

  const onSkip = useCallback(
    (itemKey: string) => {
      if (busyRef.current) return;
      freezeAll();
      void post({ kind: "chip", chip_id: `skip:${itemKey}` });
    },
    [freezeAll, post],
  );

  /** Three-step upload — the file itself never goes through /api/chat. */
  const onFile = useCallback(
    async (item: ChecklistItemDef, file: File) => {
      if (busyRef.current || !sessionRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const token = await getAccessToken();
        const auth: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
        // 1. reserve a signed upload slot
        const init = await fetch("/api/upload-url", {
          method: "POST",
          headers: { "content-type": "application/json", ...auth },
          body: JSON.stringify({
            session_id: sessionRef.current,
            item_key: item.key,
            filename: file.name,
            bytes: file.size,
          }),
        });
        if (!init.ok) {
          const err = (await init.json().catch(() => ({}))) as { detail?: string };
          addMsg(err.detail || "That file didn't go through — try again?", "sys");
          return;
        }
        const { url, storage_path } = (await init.json()) as {
          url: string;
          token: string;
          storage_path: string;
        };

        // 2. PUT the raw bytes (relative mock URL or absolute Supabase URL).
        // x-upsert lets a retried upload overwrite the earlier object.
        const put = await fetch(url, {
          method: "PUT",
          headers: {
            "content-type": file.type || "application/octet-stream",
            "x-upsert": "true",
          },
          body: file,
        });
        if (!put.ok) {
          addMsg("That file didn't go through — try again?", "sys");
          return;
        }

        // 3. tell the orchestrator; it answers with the next turn
        const done = await fetch("/api/upload-complete", {
          method: "POST",
          headers: { "content-type": "application/json", ...auth },
          body: JSON.stringify({
            session_id: sessionRef.current,
            item_key: item.key,
            storage_path,
            filename: file.name,
            bytes: file.size,
          }),
        });
        if (!done.ok) {
          const err = (await done.json().catch(() => ({}))) as { detail?: string };
          addMsg(err.detail || "That file didn't go through — try again?", "sys");
          return;
        }
        freezeAll();
        addMsg(`📎 ${file.name}`, "user");
        render((await done.json()) as ChatOut);
      } catch {
        addMsg("Connection hiccup during upload — try again?", "sys");
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [addMsg, freezeAll, render],
  );

  // ── composer ────────────────────────────────────────────────────────────
  const onDraftChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    const ta = e.target;
    ta.style.height = "46px";
    ta.style.height = `${Math.min(ta.scrollHeight, 124)}px`;
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendText();
    }
  };

  // ── render ──────────────────────────────────────────────────────────────
  return (
    <div className="chat">
      <div className="chat-head">
        <div className="avatar" aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element -- tiny static asset, no optimization needed */}
          <img src="/xor-mark.png" alt="" width={24} height={14} />
        </div>
        <div>
          <div className="t">XOR Assist</div>
          <div className="s">Elecbits intake</div>
        </div>
        <div className="status" aria-live="polite">
          {status}
        </div>
      </div>

      <div className="log" ref={logRef} role="log" aria-live="polite">
        {entries.map((e) =>
          e.kind === "msg" ? (
            e.who === "bot" ? (
              <div key={e.id} className="brow">
                <span className="eb-av" aria-hidden="true">
                  Eb
                </span>
                <div className="msg bot">{e.text}</div>
              </div>
            ) : (
              <div key={e.id} className={`msg ${e.who}`}>
                {e.text}
              </div>
            )
          ) : (
            <div key={e.id} className={`wzone${e.frozen ? " frozen" : ""}`} inert={e.frozen}>
              {e.widgets.map((w, i) => (
                <WidgetView key={i} w={w} h={{ busy, onChip, onForm, onSkip, onFile }} />
              ))}
            </div>
          ),
        )}
        {awaiting && (
          <div className="brow" aria-label="XOR Assist is typing">
            <span className="eb-av" aria-hidden="true">
              Eb
            </span>
            <div className="msg bot typing">
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
      </div>

      <div className="composer">
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          onChange={onDraftChange}
          onKeyDown={onKey}
          placeholder="Describe what you're building…"
          aria-label="Message"
        />
        <button
          type="button"
          className="send"
          onClick={sendText}
          disabled={busy}
          aria-label="Send message"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M4 12h15M12 5l7 7-7 7"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      <div className="foot">
        Your details go straight to the Elecbits sales engineering team — no spam.
      </div>
    </div>
  );
}

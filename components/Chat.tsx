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

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";

import { getAccessToken } from "@/lib/client-auth";
import { ATTACHMENT_ITEM } from "@/lib/flows";

// Minimal Web Speech API surface (not in TS's DOM lib; Chrome/Edge/Safari
// expose it, mostly under the webkit prefix).
interface SpeechRec {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  start(): void;
  stop(): void;
}

function speechCtor(): (new () => SpeechRec) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRec;
    webkitSpeechRecognition?: new () => SpeechRec;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}
import type { ChatIn, ChatOut, ChecklistItemDef, SessionState, Widget } from "@/lib/widgets";
import { WidgetView } from "./widgets";

const SESSION_KEY = "xor_session_id";

/** Notify listeners (the Background-tasks panel) — best-effort, never throws. */
function emit(name: string, detail?: string) {
  try {
    window.dispatchEvent(
      detail === undefined ? new Event(name) : new CustomEvent(name, { detail }),
    );
  } catch {
    // no listeners / SSR — irrelevant
  }
}

const STATE_LABELS: Record<SessionState, string> = {
  DISCOVER: "understanding your need",
  TRACK_CONFIRM: "confirming track",
  CONTACT: "contact details",
  CLIENT_INDUSTRY: "about your company",
  CLIENT_ORGSIZE: "about your company",
  ODM_SLOTS: "requirement capture",
  ODM_REVIEW: "review",
  ODM_BENCH_REVIEW: "defining your product",
  ODM_LLD_REVIEW: "refining your LLD",
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
  const [uiState, setUiState] = useState<SessionState | null>(null); // last meta.state

  const busyRef = useRef(false);
  const sessionRef = useRef<string | null>(null);
  const idRef = useRef(0);
  const openedRef = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const attachRef = useRef<HTMLInputElement>(null);
  // Voice conversation loop (speak → send → reply spoken → listen again).
  const voiceRef = useRef(false);
  const speakRef = useRef<((text: string) => void) | null>(null);
  const listenRef = useRef<() => void>(() => undefined);

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
    if (sessionRef.current !== res.session_id) emit("xor:session", res.session_id);
    sessionRef.current = res.session_id;
    try {
      // localStorage so the conversation survives a full browser restart,
      // not just a reload (retention is a product requirement).
      localStorage.setItem(SESSION_KEY, res.session_id);
      sessionStorage.setItem(SESSION_KEY, res.session_id);
    } catch {
      // private mode — session just won't survive a reload
    }
    // A resumed session arrives with its stored transcript — render it
    // first (only into an empty pane, i.e. the mount-time open).
    const hist: Entry[] = (res.history ?? []).map((m) => ({
      id: ++idRef.current,
      kind: "msg",
      who: m.role === "user" ? "user" : "bot",
      text: m.content,
    }));
    const additions: Entry[] = [];
    for (const m of res.messages) {
      additions.push({ id: ++idRef.current, kind: "msg", who: "bot", text: m });
    }
    if (res.widgets.length) {
      additions.push({ id: ++idRef.current, kind: "widgets", widgets: res.widgets, frozen: false });
    }
    if (hist.length || additions.length) {
      setEntries((es) => (es.length === 0 ? [...hist, ...additions] : [...es, ...additions]));
    }
    // Voice mode: the reply is read aloud; when it finishes, listening resumes.
    if (voiceRef.current && res.messages.length) {
      speakRef.current?.(res.messages.join(" "));
    }

    setUiState(res.meta.state);
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
      emit("xor:busy");
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
        emit("xor:activity");
        inputRef.current?.focus();
      }
    },
    [addMsg, render],
  );

  // Open (or resume) the session on mount. ?new=1 forces a fresh session
  // (used by "+ New enquiry" links) and is stripped from the URL.
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    let stored: string | undefined;
    try {
      stored =
        localStorage.getItem(SESSION_KEY) ?? sessionStorage.getItem(SESSION_KEY) ?? undefined;
    } catch {
      stored = undefined;
    }
    try {
      const params = new URLSearchParams(window.location.search);
      // A sidebar row reopens ITS conversation: /?resume=<session_id>.
      const resume = params.get("resume");
      if (resume) {
        stored = resume;
        params.delete("resume");
      }
      if (params.get("new") === "1") {
        stored = undefined;
        try {
          localStorage.removeItem(SESSION_KEY);
          sessionStorage.removeItem(SESSION_KEY);
        } catch {
          // nothing stored to clear
        }
        params.delete("new");
        const qs = params.toString();
        window.history.replaceState(
          {},
          "",
          window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
        );
      }
    } catch {
      // URL parsing is best-effort — a normal open still happens
    }
    void post({ kind: "open" }, stored);
  }, [post]);

  // A sidebar click switches to that deal's conversation in place — a
  // same-route ?resume= navigation never remounts this component, so the
  // Sidebar dispatches xor:resume and we re-open the pane ourselves.
  useEffect(() => {
    const onResume = (e: Event) => {
      const sid = (e as CustomEvent<string>).detail;
      if (!sid || sid === sessionRef.current || busyRef.current) return;
      setEntries([]);
      try {
        const params = new URLSearchParams(window.location.search);
        params.set("resume", sid);
        window.history.replaceState(
          {},
          "",
          `${window.location.pathname}?${params.toString()}${window.location.hash}`,
        );
      } catch {
        // URL update is cosmetic — the switch itself still happens
      }
      void post({ kind: "open" }, sid);
    };
    window.addEventListener("xor:resume", onResume);
    return () => window.removeEventListener("xor:resume", onResume);
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
    void post({ kind: "text", text: t, channel: "text" });
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

  /**
   * Three-step upload — the file itself never goes through /api/chat.
   * Shared by the checklist dropzones (onFile) and the ad-hoc attachment
   * paths (paperclip + paste); only item.key reaches the wire.
   */
  const uploadFile = useCallback(
    async (item: Pick<ChecklistItemDef, "key">, file: File) => {
      if (busyRef.current || !sessionRef.current) return;
      busyRef.current = true;
      setBusy(true);
      emit("xor:busy");
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
        emit("xor:activity");
      }
    },
    [addMsg, freezeAll, render],
  );

  /** Attach an arbitrary file to the enquiry, whatever the current state. */
  const sendAttachment = useCallback(
    (file: File) => {
      let named = file;
      if (!file.name) {
        // Pasted screenshots arrive nameless — synthesize screenshot-<HHMMSS>.
        const t = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const stamp = `${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
        const ext = file.type.split("/")[1]?.toLowerCase() || "png";
        named = new File([file], `screenshot-${stamp}.${ext}`, { type: file.type });
      }
      void uploadFile(ATTACHMENT_ITEM, named);
    },
    [uploadFile],
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

  const onAttachPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // the same file can be attached again later
    if (file) sendAttachment(file);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const file = e.clipboardData?.files?.[0];
    if (!file) return; // plain text pastes flow into the draft as usual
    e.preventDefault();
    sendAttachment(file);
  };

  // ── voice conversation (Web Speech API: hear the visitor, speak back,
  //    listen again — a real back-and-forth; no backend, no keys) ─────────
  const recRef = useRef<SpeechRec | null>(null);
  const [micOk, setMicOk] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  const [hearing, setHearing] = useState(false);
  // The speaker governs XoR's voice OUTPUT independently of the mic: mute
  // it and replies stay silent (any speech in progress stops immediately)
  // while the mic keeps taking the visitor's voice input.
  const [speakerOn, setSpeakerOn] = useState(true);
  const speakerRef = useRef(true);
  useEffect(() => {
    let alive = true;
    // async so the lint-guarded "no sync setState in effect" holds; also
    // avoids an SSR/client hydration mismatch on the button.
    void Promise.resolve().then(() => {
      if (alive) setMicOk(Boolean(speechCtor()));
    });
    return () => {
      alive = false;
      voiceRef.current = false;
      recRef.current?.stop();
      try {
        window.speechSynthesis?.cancel();
      } catch {
        // no synthesis on this browser
      }
    };
  }, []);

  const sendVoice = useCallback(
    (text: string) => {
      if (busyRef.current) return;
      addMsg(text, "user");
      freezeAll();
      void post({ kind: "text", text, channel: "voice" });
    },
    [addMsg, freezeAll, post],
  );

  /** One utterance: listen until the visitor pauses, then send what was heard. */
  const listenOnce = useCallback(() => {
    if (!voiceRef.current || busyRef.current || recRef.current) return;
    const Ctor = speechCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = "en-IN";
    rec.continuous = false; // end-of-utterance = end of the visitor's turn
    rec.interimResults = true;
    let heard = "";
    let fatal = false;
    rec.onresult = (ev) => {
      heard = "";
      for (let i = 0; i < ev.results.length; i++) heard += ev.results[i][0]?.transcript ?? "";
      setDraft(heard); // live feedback while they speak
    };
    rec.onerror = (ev) => {
      // Permission refused / no mic: stop the loop instead of retrying forever.
      if (ev.error === "not-allowed" || ev.error === "audio-capture") fatal = true;
    };
    rec.onend = () => {
      recRef.current = null;
      setHearing(false);
      const text = heard.trim();
      setDraft("");
      if (fatal || !voiceRef.current) {
        if (fatal) {
          voiceRef.current = false;
          setVoiceOn(false);
        }
        return;
      }
      if (text) {
        sendVoice(text); // reply arrives → spoken → listening resumes
      } else {
        window.setTimeout(() => listenRef.current(), 350); // silence — keep the ear open
      }
    };
    try {
      rec.start();
      recRef.current = rec;
      setHearing(true);
    } catch {
      // double-start during the permission prompt — ignore
    }
  }, [sendVoice]);
  useEffect(() => {
    listenRef.current = listenOnce;
  }, [listenOnce]);

  /** Read a reply aloud; when it finishes, hand the turn back to the visitor. */
  const speak = useCallback(
    (text: string) => {
      // Speaker muted: stay silent, but in a voice conversation the turn
      // still comes back to the visitor right away.
      if (!speakerRef.current) {
        if (voiceRef.current) listenOnce();
        return;
      }
      try {
        const synth = window.speechSynthesis;
        if (!synth) {
          listenOnce();
          return;
        }
        synth.cancel();
        // Bullets and markdown read terribly aloud — speak plain prose.
        const spoken = text.replace(/^[\s]*[-•*]\s+/gm, "").replace(/[*_#`]/g, "");
        const u = new SpeechSynthesisUtterance(spoken);
        const voices = synth.getVoices();
        u.voice =
          voices.find((v) => v.lang === "en-IN") ??
          voices.find((v) => v.lang?.startsWith("en")) ??
          null;
        u.rate = 1.04;
        u.onend = () => {
          if (voiceRef.current) listenOnce();
        };
        u.onerror = u.onend;
        synth.speak(u);
      } catch {
        if (voiceRef.current) listenOnce();
      }
    },
    [listenOnce],
  );
  useEffect(() => {
    speakRef.current = speak;
  }, [speak]);

  const toggleVoice = () => {
    if (voiceOn) {
      voiceRef.current = false;
      setVoiceOn(false);
      setHearing(false);
      recRef.current?.stop();
      try {
        window.speechSynthesis?.cancel();
      } catch {
        // fine — nothing was speaking
      }
      return;
    }
    voiceRef.current = true;
    setVoiceOn(true);
    listenOnce();
  };

  /** Mute/unmute XoR's voice; muting cuts off any reply mid-sentence. */
  const toggleSpeaker = () => {
    const next = !speakerRef.current;
    speakerRef.current = next;
    setSpeakerOn(next);
    if (!next) {
      try {
        window.speechSynthesis?.cancel();
      } catch {
        // nothing was speaking
      }
      // The cancelled utterance's onend does not fire reliably everywhere —
      // hand the turn back to the visitor ourselves (no-op if already listening).
      if (voiceRef.current) listenOnce();
    }
  };

  // ── render ──────────────────────────────────────────────────────────────
  return (
    <div className="chat">
      <div className="chat-top">
        <div className="chat-top-inner">
          {/* eslint-disable-next-line @next/next/no-img-element -- tiny static asset, no optimization needed */}
          <img src="/xor-mark.png" alt="" width={20} height={12} aria-hidden="true" />
          <span className="chat-top-name">XOR Assist</span>
          <div className="status" aria-live="polite">
            {status}
          </div>
          <Link className="chat-top-acct" href="/account">
            My projects →
          </Link>
        </div>
      </div>

      <div className="log" ref={logRef} role="log" aria-live="polite">
        <div className="log-col">
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
                  <WidgetView key={i} w={w} h={{ busy, onChip, onForm, onSkip, onFile: uploadFile }} />
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
      </div>

      <div className="composer">
        <div className="composer-col">
          {uiState && uiState !== "DISCOVER" && uiState !== "DONE" && (
            <button
              type="button"
              className="chat-back"
              onClick={() => onChip("back")}
              disabled={busy}
              aria-label="Go back a step"
            >
              ← Back
            </button>
          )}
          <div className="composer-box">
            <button
              type="button"
              className="attach"
              onClick={() => attachRef.current?.click()}
              disabled={busy}
              aria-label="Attach a file"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <input
              ref={attachRef}
              type="file"
              hidden
              accept={ATTACHMENT_ITEM.accept}
              onChange={onAttachPick}
              tabIndex={-1}
              aria-hidden="true"
            />
            <textarea
              ref={inputRef}
              rows={1}
              value={draft}
              onChange={onDraftChange}
              onKeyDown={onKey}
              onPaste={onPaste}
              placeholder={
                voiceOn
                  ? hearing
                    ? "Listening — just talk…"
                    : "Voice conversation on — I'll listen after each reply"
                  : "Describe what you're building…"
              }
              aria-label="Message"
            />
            {micOk && (
              <button
                type="button"
                className={`mic spk${speakerOn ? "" : " off"}`}
                onClick={toggleSpeaker}
                aria-label={speakerOn ? "Mute XoR's voice" : "Unmute XoR's voice"}
                aria-pressed={!speakerOn}
                title={speakerOn ? "XoR speaks replies — click to mute" : "XoR is muted — click to unmute"}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M11 5 6.5 9H3v6h3.5L11 19V5Z"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinejoin="round"
                  />
                  {speakerOn ? (
                    <path
                      d="M15 9a4 4 0 0 1 0 6M17.5 6.5a8 8 0 0 1 0 11"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  ) : (
                    <path
                      d="m15.5 9.5 5 5m0-5-5 5"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  )}
                </svg>
              </button>
            )}
            {micOk && (
              <button
                type="button"
                className={`mic${voiceOn ? " rec" : ""}`}
                onClick={toggleVoice}
                aria-label={voiceOn ? "End the voice conversation" : "Start a voice conversation"}
                aria-pressed={voiceOn}
                title={voiceOn ? "Voice conversation on — click to end" : "Talk to XoR"}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <rect x="9" y="2.5" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="2" />
                  <path
                    d="M5 11a7 7 0 0 0 14 0M12 18v3.5"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            )}
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
            Your details go straight to the Elecbits engineering team — no spam.
          </div>
        </div>
      </div>
    </div>
  );
}

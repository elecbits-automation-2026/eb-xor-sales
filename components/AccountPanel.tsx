"use client";

/**
 * The /account experience.
 *
 * Signed OUT (or finishing a password recovery) → the shared <LoginView/>.
 * Signed IN → an app shell: the shared <Sidebar/> (projects list, account
 * footer) and a main pane with the selected enquiry's detail. Selection is
 * client-side; ?deal=<id> picks the initial row. A 401 from the API drops
 * back to the login view.
 *
 * All auth goes through the lib/client-auth facade — this component never
 * knows whether it is talking to Supabase or the demo mock.
 */

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";

import LoginView, { GateLoading, useAuthGate } from "@/components/LoginView";
import Sidebar, { enquiryKey } from "@/components/Sidebar";
import { getAccessToken, signOut, type AuthUser } from "@/lib/client-auth";

// ── /api/me/enquiries contract ────────────────────────────────────────────
interface Enquiry {
  deal_id: string | null;
  lead_ref: string;
  track: string | null;
  track_label: string | null;
  summary: string | null;
  quantity: string | null;
  timeline: string | null;
  created_at: string;
  status: string | null;
  lld_url: string | null;
}

interface MeOut {
  client: { client_code: string | null; company: string | null } | null;
  enquiries: Enquiry[];
}

export default function AccountPanel() {
  const gate = useAuthGate();

  const doSignOut = async () => {
    try {
      await signOut();
    } catch {
      // local state clears regardless
    }
    try {
      sessionStorage.removeItem("xor_session_id");
    } catch {
      // nothing stored
    }
    gate.setNotice("");
    gate.signedOut();
  };

  if (gate.recovery) return <LoginView gate={gate} />;
  if (gate.phase.kind === "loading") return <GateLoading />;
  if (gate.phase.kind === "out") return <LoginView gate={gate} />;
  return <ProjectsView user={gate.phase.user} onExpired={gate.signedOut} onSignOut={doSignOut} />;
}

// ── signed-in shell ───────────────────────────────────────────────────────
/**
 * Fetches /api/me/enquiries on mount (and again on Retry via `attempt`).
 * Mounted exactly while the panel is signed in, so entering the signed-in
 * phase — sign-in, sign-up, another tab, recovery finished — always loads.
 */
function ProjectsView({
  user,
  onExpired,
  onSignOut,
}: {
  user: AuthUser;
  onExpired: () => void;
  onSignOut: () => void;
}) {
  const [me, setMe] = useState<MeOut | null>(null);
  const [meErr, setMeErr] = useState("");
  const [attempt, setAttempt] = useState(0);
  // Initial selection honors ?deal=…; anything unknown falls back to the
  // first enquiry when the list arrives (see `selected` below).
  const [sel, setSel] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return new URLSearchParams(window.location.search).get("deal");
    } catch {
      return null;
    }
  });

  useEffect(() => {
    let alive = true;
    void (async () => {
      const token = await getAccessToken();
      if (!alive) return;
      if (!token) {
        onExpired();
        return;
      }
      try {
        const r = await fetch("/api/me/enquiries", {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!alive) return;
        if (r.status === 401) {
          // token expired server-side — drop the stale session
          await signOut().catch(() => undefined);
          if (alive) onExpired();
          return;
        }
        if (!r.ok) throw new Error(`bad status ${r.status}`);
        const data = (await r.json()) as MeOut;
        if (!alive) return;
        setMe({ client: data.client ?? null, enquiries: data.enquiries ?? [] });
      } catch {
        if (alive) setMeErr("Couldn't load your enquiries — check your connection and try again.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [attempt, onExpired]);

  const enqs = me?.enquiries ?? null;
  const selected = enqs ? (enqs.find((q) => enquiryKey(q) === sel) ?? enqs[0] ?? null) : null;

  return (
    <div className="app">
      <Sidebar
        page="account"
        email={user.email}
        clientCode={me?.client?.client_code ?? null}
        enquiries={enqs}
        selected={selected ? enquiryKey(selected) : null}
        onSelect={setSel}
        onSignOut={onSignOut}
      />
      <section className="app-main">
        {meErr ? (
          <div className="pv-empty">
            <p className="pv-quiet">{meErr}</p>
            <button
              type="button"
              className="pv-cta"
              onClick={() => {
                setMeErr("");
                setMe(null);
                setAttempt((a) => a + 1);
              }}
            >
              Retry
            </button>
          </div>
        ) : me === null ? (
          <div className="pv-loading" role="status">
            Loading your enquiries…
          </div>
        ) : selected === null ? (
          <div className="pv-empty">
            <Image src="/xor-mark.png" alt="" aria-hidden width={56} height={34} />
            <h2>Start your first enquiry</h2>
            <p className="pv-quiet">
              Tell XOR Assist what you&apos;re building — it lands here, tracked end-to-end.
            </p>
            <Link className="pv-cta" href="/">
              New enquiry
            </Link>
          </div>
        ) : (
          <EnquiryDetail q={selected} company={me.client?.company ?? null} />
        )}
      </section>
    </div>
  );
}

/** The stored chat behind an enquiry — read-only, login-scoped. */
function Transcript({ dealRef }: { dealRef: string }) {
  const [msgs, setMsgs] = useState<{ role: string; content: string }[] | "error" | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const token = await getAccessToken();
        const r = await fetch(`/api/me/transcript?deal=${encodeURIComponent(dealRef)}`, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        if (!alive) return;
        if (!r.ok) throw new Error(`bad status ${r.status}`);
        const b = (await r.json()) as { messages?: { role: string; content: string }[] };
        if (alive) setMsgs(b.messages ?? []);
      } catch {
        if (alive) setMsgs("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [dealRef]);

  if (msgs === null) return <p className="pv-quiet">Loading the conversation…</p>;
  if (msgs === "error") return <p className="pv-quiet">Couldn&apos;t load the conversation.</p>;
  if (!msgs.length) return <p className="pv-quiet">No messages stored for this enquiry.</p>;
  return (
    <details className="pv-convo">
      <summary className="pv-convo-line">
        <svg
          className="pv-convo-chev"
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="m9 5.5 7 6.5-7 6.5"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        View the conversation
        <span className="pv-convo-n">
          · {msgs.length} message{msgs.length === 1 ? "" : "s"}
        </span>
      </summary>
      <div className="pv-chat">
        {msgs.map((m, i) => (
          <div key={i} className={`pv-msg ${m.role === "user" ? "user" : "bot"}`}>
            {m.content}
          </div>
        ))}
      </div>
    </details>
  );
}

// ── the status journey ────────────────────────────────────────────────────
/**
 * The five stages an enquiry moves through once it lands with the team.
 * `note` is the one-line reassurance shown while that stage is the active
 * one — written for the person who is waiting, not for the team.
 */
const JOURNEY: { label: string; note?: string }[] = [
  { label: "Received" },
  {
    label: "Sales engineering review",
    note: "Your sales engineer is reviewing this — typically within one working day.",
  },
  { label: "Scoping call", note: "The team will reach out to set up a scoping call." },
  { label: "Proposal", note: "A commercial proposal is being prepared for you." },
  { label: "Project sanction", note: "Final sign-off — your project is about to kick off." },
];

/**
 * Which stage is ACTIVE for a stored status (everything before it is done).
 * Today the API only distinguishes "Received" and "Filed" — both mean the
 * enquiry is captured and sitting with sales engineering — so both resolve
 * to stage 1. New statuses just need a row here.
 */
const STAGE_BY_STATUS: Record<string, number> = { Received: 1, Filed: 1 };
function journeyStage(status: string | null): number {
  return STAGE_BY_STATUS[status ?? ""] ?? 1;
}

// ── one enquiry, full detail ──────────────────────────────────────────────
function EnquiryDetail({ q, company }: { q: Enquiry; company: string | null }) {
  const ref = q.deal_id || q.lead_ref;
  const parsed = q.created_at ? new Date(q.created_at) : null;
  const date =
    parsed && !Number.isNaN(parsed.getTime())
      ? parsed.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
      : "—";
  const filed = q.status === "Filed";
  const active = journeyStage(q.status);
  // Two-tone display ID: the final segment carries the accent.
  const cut = ref.lastIndexOf("-");
  const [refHead, refTail] = cut > 0 ? [ref.slice(0, cut + 1), ref.slice(cut + 1)] : [ref, ""];

  return (
    <article className="pv">
      <header className="pv-hero">
        <p className="pv-meta">
          <span>Created {date}</span>
          <span className="pv-meta-sep" aria-hidden="true">
            ·
          </span>
          <span>Reference {q.lead_ref}</span>
        </p>
        <h1 className="pv-id">
          {refHead}
          {refTail ? <span className="pv-id-tail">{refTail}</span> : null}
        </h1>
        <div className="pv-tags">
          {company ? <span className="pv-pill">{company}</span> : null}
          {q.track_label ? <span className="pv-pill acc">{q.track_label}</span> : null}
          {q.status ? (
            <span className={`pv-pill ${filed ? "ok" : "live"}`}>
              <i className="pv-pill-dot" aria-hidden="true" />
              {q.status}
            </span>
          ) : null}
        </div>
        {q.summary ? <p className="pv-lede">{q.summary}</p> : null}
      </header>

      <section className="pv-journey" aria-label="Where this enquiry stands">
        <ol className="pv-steps">
          {JOURNEY.map((s, i) => {
            const state = i < active ? "done" : i === active ? "active" : "ahead";
            return (
              <li key={s.label} className={`pv-step ${state}`}>
                <span className="pv-step-dot" aria-hidden="true">
                  {i < active ? (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path
                        d="m5 12.5 4.5 4.5L19 7.5"
                        stroke="currentColor"
                        strokeWidth="3.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : null}
                </span>
                <span className="pv-step-label">
                  {s.label}
                  {i === active ? <span className="pv-sr">(current stage)</span> : null}
                </span>
              </li>
            );
          })}
        </ol>
        {JOURNEY[active]?.note ? <p className="pv-journey-note">{JOURNEY[active].note}</p> : null}
      </section>

      <dl className="pv-stats">
        <div className="pv-stat">
          <dt>Quantity</dt>
          <dd>{q.quantity || "—"}</dd>
        </div>
        <div className="pv-stat">
          <dt>Timeline</dt>
          <dd>{q.timeline || "—"}</dd>
        </div>
        <div className="pv-stat">
          <dt>Created</dt>
          <dd>{date}</dd>
        </div>
        <div className="pv-stat">
          <dt>Reference</dt>
          <dd className="pv-stat-mono">{q.lead_ref}</dd>
        </div>
      </dl>

      <section className="pv-sec">
        <h2 className="pv-h">Documents</h2>
        {q.lld_url ? (
          <a className="pv-file" href={q.lld_url} download>
            <span className="pv-file-icon" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path
                  d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinejoin="round"
                />
                <path d="M14 3v5h5" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                <path
                  d="M9 13.5h6M9 17h6"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <span className="pv-file-body">
              <span className="pv-file-name">Low-level design draft</span>
              <span className="pv-file-kind">Markdown draft · generated from this enquiry</span>
            </span>
            <span className="pv-file-get" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5M5 20h14"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </a>
        ) : (
          <p className="pv-file-empty">
            Nothing to download just yet — the moment your sales engineer drafts a document for
            this enquiry, it will appear right here.
          </p>
        )}
        <p className="pv-docnote">Uploaded files are with the sales engineering team.</p>
      </section>

      <section className="pv-sec">
        <Transcript key={ref} dealRef={ref} />
      </section>

      <footer className="pv-foot">
        <span>Questions meanwhile?</span>
        <a href="mailto:sales@elecbits.in">sales@elecbits.in</a>
      </footer>
    </article>
  );
}

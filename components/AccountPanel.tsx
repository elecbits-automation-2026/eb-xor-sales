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
          <EnquiryDetail q={selected} />
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
    <div className="pv-chat">
      {msgs.map((m, i) => (
        <div key={i} className={`pv-msg ${m.role === "user" ? "user" : "bot"}`}>
          {m.content}
        </div>
      ))}
    </div>
  );
}

// ── one enquiry, full detail ──────────────────────────────────────────────
function EnquiryDetail({ q }: { q: Enquiry }) {
  const ref = q.deal_id || q.lead_ref;
  const parsed = q.created_at ? new Date(q.created_at) : null;
  const date =
    parsed && !Number.isNaN(parsed.getTime()) ? parsed.toLocaleDateString("en-GB") : "—";
  const filed = q.status === "Filed";
  return (
    <div className="pv">
      <header className="pv-head">
        <h1>{ref}</h1>
        {q.track_label ? <span className="pv-pill">{q.track_label}</span> : null}
        {q.status ? <span className={`pv-pill${filed ? " ok" : ""}`}>{q.status}</span> : null}
      </header>

      <div className="pv-card">
        <div className="pv-cell">
          <span className="pv-k">Summary</span>
          <span className="pv-v">{q.summary || "—"}</span>
        </div>
        <div className="pv-cells">
          <div className="pv-cell">
            <span className="pv-k">Quantity</span>
            <span className="pv-v">{q.quantity || "—"}</span>
          </div>
          <div className="pv-cell">
            <span className="pv-k">Timeline</span>
            <span className="pv-v">{q.timeline || "—"}</span>
          </div>
          <div className="pv-cell">
            <span className="pv-k">Created</span>
            <span className="pv-v">{date}</span>
          </div>
          <div className="pv-cell">
            <span className="pv-k">Reference</span>
            <span className="pv-v pv-mono">{q.lead_ref}</span>
          </div>
        </div>
      </div>

      <section className="pv-sec">
        <h2 className="pv-k">Documents</h2>
        {q.lld_url ? (
          <a className="pv-dl" href={q.lld_url} download>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5M4 20h16"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Download LLD draft
          </a>
        ) : (
          <p className="pv-quiet">Your LLD draft will appear here once generated.</p>
        )}
      </section>

      <section className="pv-sec">
        <h2 className="pv-k">Conversation</h2>
        <Transcript key={ref} dealRef={ref} />
      </section>

      <section className="pv-sec">
        <h2 className="pv-k">What happens next</h2>
        <ol className="pv-next">
          <li>
            <i>1</i> Sales engineering review
          </li>
          <li>
            <i>2</i> Scoping call
          </li>
          <li>
            <i>3</i> Proposal
          </li>
        </ol>
      </section>
    </div>
  );
}

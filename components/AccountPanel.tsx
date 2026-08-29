"use client";

/**
 * Client account panel for /account.
 *
 * Signed OUT → a card with Sign in / Create account tabs, plus the reset,
 * reset-sent, confirm-email and set-new-password (PASSWORD_RECOVERY) views.
 * Signed IN → <ProjectsView/>: header row (title, client-code pill, sign out)
 * and the list of enquiries from GET /api/me/enquiries; a 401 there means the
 * token expired, so the panel drops back to signed-out.
 *
 * All auth goes through the lib/client-auth facade — this component never
 * knows whether it is talking to Supabase or the demo mock.
 */

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import {
  authMode,
  authReturnError,
  currentUser,
  getAccessToken,
  onAuthChange,
  resetPassword,
  setPassword,
  signIn,
  signOut,
  signUp,
  type AuthUser,
} from "@/lib/client-auth";

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

type Phase = { kind: "loading" } | { kind: "out" } | { kind: "in"; user: AuthUser };

type OutView =
  | { v: "tabs" }
  | { v: "reset" }
  | { v: "resetSent"; email: string }
  | { v: "confirmSent"; email: string };

function errMsg(ex: unknown, fallback: string): string {
  return ex instanceof Error && ex.message ? ex.message : fallback;
}

export default function AccountPanel() {
  const uid = useId();
  const demo = authMode() === "demo";

  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [view, setView] = useState<OutView>({ v: "tabs" });
  const [tab, setTab] = useState<"signin" | "signup">("signin");
  const [recovery, setRecovery] = useState(false); // PASSWORD_RECOVERY landing
  const [notice, setNotice] = useState(""); // returned-link error copy
  const [err, setErr] = useState(""); // inline form error
  const [busy, setBusy] = useState(false);

  // controlled fields
  const [siEmail, setSiEmail] = useState("");
  const [siPass, setSiPass] = useState("");
  const [suName, setSuName] = useState("");
  const [suCompany, setSuCompany] = useState("");
  const [suEmail, setSuEmail] = useState("");
  const [suPass, setSuPass] = useState("");
  const [rsEmail, setRsEmail] = useState("");
  const [newPass, setNewPass] = useState("");

  const signinTabRef = useRef<HTMLButtonElement>(null);
  const signupTabRef = useRef<HTMLButtonElement>(null);

  // ── session bootstrap ───────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    // Subscribe BEFORE the Supabase client parses the URL hash so a
    // PASSWORD_RECOVERY landing is never missed.
    const unsub = onAuthChange((user, event) => {
      if (!alive) return;
      if (event === "PASSWORD_RECOVERY") {
        setRecovery(true);
        setPhase(user ? { kind: "in", user } : { kind: "out" });
        return;
      }
      if (event === "SIGNED_OUT") {
        setRecovery(false);
        setPhase({ kind: "out" });
        return;
      }
      if (event === "SIGNED_IN" && user) {
        // e.g. signed in from another tab — never leave a stale logged-out view
        setPhase((p) => (p.kind === "in" ? p : { kind: "in", user }));
      }
    });
    // Read the URL synchronously — before the Supabase client can consume the
    // hash — but apply the state after the await so the effect body stays pure.
    const linkErr = authReturnError();
    const recoveryHash =
      typeof window !== "undefined" && /type=recovery/.test(window.location.hash);
    void (async () => {
      const u = await currentUser();
      // The URL was consumed above (one-shot) — apply it even if StrictMode's
      // simulated unmount raced us; setState after unmount is a safe no-op.
      if (linkErr) setNotice(linkErr);
      if (recoveryHash) setRecovery(true);
      if (!alive) return;
      setPhase(u ? { kind: "in", user: u } : { kind: "out" });
    })();
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  // ── actions ─────────────────────────────────────────────────────────────
  const doSignIn = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setErr("");
    setNotice("");
    setBusy(true);
    try {
      const email = siEmail.trim();
      await signIn(email, siPass);
      const u = await currentUser();
      setSiPass("");
      setPhase({ kind: "in", user: u ?? { email, name: "" } });
    } catch (ex) {
      setErr(errMsg(ex, "Sign-in failed — please try again."));
    } finally {
      setBusy(false);
    }
  };

  const doSignUp = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setErr("");
    setNotice("");
    if (suPass.length < 8) {
      setErr("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      const email = suEmail.trim();
      const { needsEmailConfirm } = await signUp({
        name: suName.trim(),
        company: suCompany.trim(),
        email,
        password: suPass,
      });
      setSuPass("");
      if (needsEmailConfirm) {
        setView({ v: "confirmSent", email });
      } else {
        const u = await currentUser();
        setPhase({ kind: "in", user: u ?? { email, name: suName.trim() } });
      }
    } catch (ex) {
      setErr(errMsg(ex, "Couldn't create the account — please try again."));
    } finally {
      setBusy(false);
    }
  };

  const doReset = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setErr("");
    setBusy(true);
    try {
      const email = rsEmail.trim();
      await resetPassword(email);
      setView({ v: "resetSent", email });
    } catch (ex) {
      setErr(errMsg(ex, "Couldn't send the reset email — please try again."));
    } finally {
      setBusy(false);
    }
  };

  const doRecovery = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setErr("");
    if (newPass.length < 8) {
      setErr("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      await setPassword(newPass);
      setNewPass("");
      setRecovery(false);
      const u = await currentUser();
      setPhase(u ? { kind: "in", user: u } : { kind: "out" });
    } catch (ex) {
      setErr(errMsg(ex, "Couldn't set the new password — please try again."));
    } finally {
      setBusy(false);
    }
  };

  const doSignOut = useCallback(async () => {
    try {
      await signOut();
    } catch {
      // local state clears regardless
    }
    setRecovery(false);
    setTab("signin");
    setView({ v: "tabs" });
    setErr("");
    setNotice("");
    setPhase({ kind: "out" });
  }, []);

  /** The bearer token was rejected (expired) — drop back to signed-out. */
  const onExpired = useCallback(() => {
    setPhase({ kind: "out" });
  }, []);

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = tab === "signin" ? "signup" : "signin";
    setTab(next);
    setErr("");
    (next === "signin" ? signinTabRef : signupTabRef).current?.focus();
  };

  // ── render ──────────────────────────────────────────────────────────────
  if (recovery) {
    return (
      <div className="card auth-card">
        <h2 className="auth-title">Set a new password</h2>
        <p className="auth-sub">
          You followed a reset link — choose a new password
          {phase.kind === "in" && phase.user.email ? (
            <>
              {" "}
              for <span className="mono-em">{phase.user.email}</span>
            </>
          ) : null}
          .
        </p>
        <form onSubmit={doRecovery}>
          <div className="field">
            <label htmlFor={`${uid}-newpass`}>New password</label>
            <input
              id={`${uid}-newpass`}
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              placeholder="At least 8 characters"
              value={newPass}
              onChange={(e) => setNewPass(e.target.value)}
            />
          </div>
          {err && (
            <p className="form-err" role="alert">
              {err}
            </p>
          )}
          <div className="auth-actions">
            <button type="submit" className="btn" disabled={busy}>
              {busy ? "Saving…" : "Save new password"}
            </button>
          </div>
        </form>
      </div>
    );
  }

  if (phase.kind === "loading") {
    return (
      <div className="acct-loading" role="status">
        Checking your session…
      </div>
    );
  }

  if (phase.kind === "in") {
    return <ProjectsView onExpired={onExpired} onSignOut={doSignOut} />;
  }

  // signed out
  return (
    <div className="card auth-card">
      {view.v === "tabs" && (
        <>
          <div
            className="auth-tabs"
            role="tablist"
            aria-label="Sign in or create account"
            onKeyDown={onTabKey}
          >
            <button
              ref={signinTabRef}
              type="button"
              role="tab"
              id={`${uid}-tab-signin`}
              aria-selected={tab === "signin"}
              aria-controls={`${uid}-panel-signin`}
              tabIndex={tab === "signin" ? 0 : -1}
              className="auth-tab"
              onClick={() => {
                setTab("signin");
                setErr("");
              }}
            >
              Sign in
            </button>
            <button
              ref={signupTabRef}
              type="button"
              role="tab"
              id={`${uid}-tab-signup`}
              aria-selected={tab === "signup"}
              aria-controls={`${uid}-panel-signup`}
              tabIndex={tab === "signup" ? 0 : -1}
              className="auth-tab"
              onClick={() => {
                setTab("signup");
                setErr("");
              }}
            >
              Create account
            </button>
          </div>
          {notice && (
            <p className="form-err" role="alert">
              {notice}
            </p>
          )}
          {tab === "signin" ? (
            <div role="tabpanel" id={`${uid}-panel-signin`} aria-labelledby={`${uid}-tab-signin`}>
              <form onSubmit={doSignIn}>
                <div className="field">
                  <label htmlFor={`${uid}-si-email`}>Work email</label>
                  <input
                    id={`${uid}-si-email`}
                    type="email"
                    required
                    autoComplete="email"
                    placeholder="you@company.com"
                    value={siEmail}
                    onChange={(e) => setSiEmail(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`${uid}-si-pass`}>Password</label>
                  <input
                    id={`${uid}-si-pass`}
                    type="password"
                    required
                    autoComplete="current-password"
                    placeholder="Your password"
                    value={siPass}
                    onChange={(e) => setSiPass(e.target.value)}
                  />
                </div>
                {err && (
                  <p className="form-err" role="alert">
                    {err}
                  </p>
                )}
                <div className="auth-actions">
                  <button type="submit" className="btn" disabled={busy}>
                    {busy ? "Signing in…" : "Sign in"}
                  </button>
                  {!demo && (
                    <button
                      type="button"
                      className="linkbtn"
                      onClick={() => {
                        setView({ v: "reset" });
                        setErr("");
                        setRsEmail(siEmail);
                      }}
                    >
                      Forgot password?
                    </button>
                  )}
                </div>
              </form>
            </div>
          ) : (
            <div role="tabpanel" id={`${uid}-panel-signup`} aria-labelledby={`${uid}-tab-signup`}>
              <form onSubmit={doSignUp}>
                <div className="field">
                  <label htmlFor={`${uid}-su-name`}>Name</label>
                  <input
                    id={`${uid}-su-name`}
                    type="text"
                    required
                    autoComplete="name"
                    placeholder="Your name"
                    value={suName}
                    onChange={(e) => setSuName(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`${uid}-su-company`}>Company</label>
                  <input
                    id={`${uid}-su-company`}
                    type="text"
                    required
                    autoComplete="organization"
                    placeholder="Company name"
                    value={suCompany}
                    onChange={(e) => setSuCompany(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`${uid}-su-email`}>Work email</label>
                  <input
                    id={`${uid}-su-email`}
                    type="email"
                    required
                    autoComplete="email"
                    placeholder="you@company.com"
                    value={suEmail}
                    onChange={(e) => setSuEmail(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`${uid}-su-pass`}>Password</label>
                  <input
                    id={`${uid}-su-pass`}
                    type="password"
                    required
                    minLength={8}
                    autoComplete="new-password"
                    placeholder="At least 8 characters"
                    value={suPass}
                    onChange={(e) => setSuPass(e.target.value)}
                  />
                </div>
                {err && (
                  <p className="form-err" role="alert">
                    {err}
                  </p>
                )}
                <div className="auth-actions">
                  <button type="submit" className="btn" disabled={busy}>
                    {busy ? "Creating account…" : "Create account"}
                  </button>
                </div>
              </form>
            </div>
          )}
        </>
      )}

      {view.v === "reset" && (
        <>
          <h2 className="auth-title">Reset your password</h2>
          <p className="auth-sub">
            We&apos;ll email you a link that brings you back here to choose a new one.
          </p>
          <form onSubmit={doReset}>
            <div className="field">
              <label htmlFor={`${uid}-rs-email`}>Work email</label>
              <input
                id={`${uid}-rs-email`}
                type="email"
                required
                autoComplete="email"
                placeholder="you@company.com"
                value={rsEmail}
                onChange={(e) => setRsEmail(e.target.value)}
              />
            </div>
            {err && (
              <p className="form-err" role="alert">
                {err}
              </p>
            )}
            <div className="auth-actions">
              <button type="submit" className="btn" disabled={busy}>
                {busy ? "Sending…" : "Send reset link"}
              </button>
              <button
                type="button"
                className="linkbtn"
                onClick={() => {
                  setView({ v: "tabs" });
                  setErr("");
                }}
              >
                Back to sign in
              </button>
            </div>
          </form>
        </>
      )}

      {view.v === "resetSent" && (
        <>
          <h2 className="auth-title">Check your inbox</h2>
          <p className="auth-sub">
            We sent a password-reset link to <span className="mono-em">{view.email}</span>.
            It&apos;s one-time and short-lived, so use it soon.
          </p>
          <button type="button" className="linkbtn" onClick={() => setView({ v: "tabs" })}>
            Back to sign in
          </button>
        </>
      )}

      {view.v === "confirmSent" && (
        <>
          <h2 className="auth-title">Confirm your email</h2>
          <p className="auth-sub">
            We sent a link to <span className="mono-em">{view.email}</span>. Click it and
            you&apos;ll land back here, signed in.
          </p>
          <button
            type="button"
            className="linkbtn"
            onClick={() => {
              setView({ v: "tabs" });
              setTab("signin");
            }}
          >
            Back to sign in
          </button>
        </>
      )}
    </div>
  );
}

// ── signed-in view ────────────────────────────────────────────────────────
/**
 * Fetches /api/me/enquiries on mount (and again on Retry via `attempt`).
 * Mounted exactly while the panel is signed in, so entering the signed-in
 * phase — sign-in, sign-up, another tab, recovery finished — always loads.
 */
function ProjectsView({
  onExpired,
  onSignOut,
}: {
  onExpired: () => void;
  onSignOut: () => void;
}) {
  const [me, setMe] = useState<MeOut | null>(null);
  const [meErr, setMeErr] = useState("");
  const [attempt, setAttempt] = useState(0);

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

  return (
    <>
      <div className="acct-head">
        <h1>Your projects</h1>
        {me?.client?.client_code ? <span className="code-pill">{me.client.client_code}</span> : null}
        <button type="button" className="btn-ghost" onClick={onSignOut}>
          Sign out
        </button>
      </div>
      {meErr ? (
        <div className="card acct-empty">
          <div className="body">{meErr}</div>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setMeErr("");
              setAttempt((a) => a + 1);
            }}
          >
            Retry
          </button>
        </div>
      ) : me === null ? (
        <div className="acct-loading" role="status">
          Loading your enquiries…
        </div>
      ) : me.enquiries.length === 0 ? (
        <div className="card acct-empty">
          <h4>No enquiries yet</h4>
          <div className="body">
            Tell XOR Assist what you&apos;re building — it captures everything the Elecbits team
            needs in one chat.
          </div>
          <Link className="btn" href="/">
            Start with XOR Assist
          </Link>
        </div>
      ) : (
        <div className="enq-list">
          {me.enquiries.map((q, i) => (
            <EnquiryCard key={q.deal_id ?? q.lead_ref ?? i} q={q} />
          ))}
        </div>
      )}
    </>
  );
}

// ── one enquiry ───────────────────────────────────────────────────────────
function EnquiryCard({ q }: { q: Enquiry }) {
  const ref = q.deal_id || q.lead_ref;
  const parsed = q.created_at ? new Date(q.created_at) : null;
  const date = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toLocaleDateString("en-GB") : "";
  const filed = q.status === "Filed";
  const hasMeta = Boolean(q.quantity || q.timeline || q.status);
  return (
    <article className="enq">
      <div className="enq-top">
        <span className="enq-ref">{ref}</span>
        {q.track_label ? <span className="pill">{q.track_label}</span> : null}
        {date ? <span className="enq-date">{date}</span> : null}
      </div>
      {q.summary ? <p className="enq-sum">{q.summary}</p> : null}
      {hasMeta && (
        <div className="enq-meta">
          {q.quantity ? <span>Qty {q.quantity}</span> : null}
          {q.timeline ? <span>Timeline {q.timeline}</span> : null}
          {q.status ? <span className={`pill${filed ? " ok" : ""}`}>{q.status}</span> : null}
        </div>
      )}
      {q.lld_url ? (
        <a className="enq-dl" href={q.lld_url} download>
          Download LLD draft
        </a>
      ) : null}
    </article>
  );
}

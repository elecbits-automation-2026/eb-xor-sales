"use client";

/**
 * The one login experience, shared by "/" and /account.
 *
 * useAuthGate() owns the client auth phase (loading → out/in) plus the
 * PASSWORD_RECOVERY landing and returned-link notices; <GateLoading/> is the
 * minimal splash shown while the phase resolves; <LoginView/> renders the
 * Claude-style split login — editorial headline, one minimal card (Google →
 * OR → email), branded gradient panel — and flips the gate to signed-in on
 * success. Reset / reset-sent / confirm-email / set-new-password all swap
 * the card body in place.
 *
 * All auth goes through the lib/client-auth facade — these components never
 * know whether they are talking to Supabase or the demo mock.
 */

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";

import {
  authMode,
  authReturnError,
  currentUser,
  onAuthChange,
  resetPassword,
  setPassword,
  signIn,
  signInWithGoogle,
  signUp,
  type AuthUser,
} from "@/lib/client-auth";

export type GatePhase = { kind: "loading" } | { kind: "out" } | { kind: "in"; user: AuthUser };

export interface AuthGate {
  phase: GatePhase;
  /** A password-reset link landed — show the set-new-password card. */
  recovery: boolean;
  /** Quiet, informational copy under the card (never styled as an error). */
  notice: string;
  setNotice: (s: string) => void;
  setRecovery: (v: boolean) => void;
  signedIn: (user: AuthUser) => void;
  signedOut: () => void;
}

/** Client auth phase for a gated page. Subscribe once, at the page root. */
export function useAuthGate(): AuthGate {
  const [phase, setPhase] = useState<GatePhase>({ kind: "loading" });
  const [recovery, setRecovery] = useState(false);
  const [notice, setNotice] = useState("");

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

  const signedIn = useCallback((user: AuthUser) => setPhase({ kind: "in", user }), []);
  const signedOut = useCallback(() => {
    setRecovery(false);
    setPhase({ kind: "out" });
  }, []);

  return { phase, recovery, notice, setNotice, setRecovery, signedIn, signedOut };
}

/** Minimal centered splash while the auth phase resolves — no view flash. */
export function GateLoading() {
  return (
    <div className="gate-loading" role="status" aria-label="Checking your session">
      <Image src="/xor-mark.png" alt="" aria-hidden width={56} height={34} priority />
    </div>
  );
}

type CardView =
  | { v: "auth" }
  | { v: "reset" }
  | { v: "resetSent"; email: string }
  | { v: "confirmSent"; email: string };

function errMsg(ex: unknown, fallback: string): string {
  return ex instanceof Error && ex.message ? ex.message : fallback;
}

/** A fresh login starts a fresh chat — drop any stored chat session. */
function clearChatSession() {
  try {
    sessionStorage.removeItem("xor_session_id");
  } catch {
    // nothing stored
  }
}

export default function LoginView({ gate }: { gate: AuthGate }) {
  const uid = useId();
  const demo = authMode() === "demo";
  const { notice, setNotice } = gate;

  const [view, setView] = useState<CardView>({ v: "auth" });
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // controlled fields — email/password survive a sign-in ↔ create toggle
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [rsEmail, setRsEmail] = useState("");
  const [newPass, setNewPass] = useState("");

  // ── actions ─────────────────────────────────────────────────────────────
  const doGoogle = async () => {
    if (busy) return;
    setErr("");
    setBusy(true);
    try {
      // Supabase mode redirects the page — a resolved call means it's underway.
      await signInWithGoogle();
    } catch (ex) {
      // Informational (demo mode), shown as the quiet notice under the card.
      setNotice(errMsg(ex, "Google sign-in isn't available right now."));
      setBusy(false);
    }
  };

  const doSignIn = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setErr("");
    setNotice("");
    setBusy(true);
    try {
      const em = email.trim();
      await signIn(em, pass);
      const u = await currentUser();
      setPass("");
      clearChatSession();
      gate.signedIn(u ?? { email: em, name: "" });
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
    if (pass.length < 8) {
      setErr("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      const em = email.trim();
      const { needsEmailConfirm } = await signUp({ name: name.trim(), email: em, password: pass });
      setPass("");
      if (needsEmailConfirm) {
        setView({ v: "confirmSent", email: em });
      } else {
        const u = await currentUser();
        clearChatSession();
        gate.signedIn(u ?? { email: em, name: name.trim() });
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
      const em = rsEmail.trim();
      await resetPassword(em);
      setView({ v: "resetSent", email: em });
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
      gate.setRecovery(false);
      const u = await currentUser();
      if (u) gate.signedIn(u);
      else gate.signedOut();
    } catch (ex) {
      setErr(errMsg(ex, "Couldn't set the new password — please try again."));
    } finally {
      setBusy(false);
    }
  };

  // ── card body ───────────────────────────────────────────────────────────
  let card: React.ReactNode;

  if (gate.recovery) {
    card = (
      <>
        <h2 className="lg-t">Set a new password</h2>
        <p className="lg-s">
          You followed a reset link — choose a new password
          {gate.phase.kind === "in" && gate.phase.user.email ? (
            <>
              {" "}
              for <span className="lg-em">{gate.phase.user.email}</span>
            </>
          ) : null}
          .
        </p>
        <form className="lg-form" onSubmit={doRecovery}>
          <input
            id={`${uid}-newpass`}
            className="lg-input"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="New password (8+ characters)"
            aria-label="New password"
            value={newPass}
            onChange={(e) => setNewPass(e.target.value)}
          />
          {err && (
            <p className="lg-err" role="alert">
              {err}
            </p>
          )}
          <button type="submit" className="lg-primary" disabled={busy}>
            {busy ? "Saving…" : "Save new password"}
          </button>
        </form>
      </>
    );
  } else if (view.v === "reset") {
    card = (
      <>
        <h2 className="lg-t">Reset your password</h2>
        <p className="lg-s">We&apos;ll email you a link that brings you back here to choose a new one.</p>
        <form className="lg-form" onSubmit={doReset}>
          <input
            id={`${uid}-rs-email`}
            className="lg-input"
            type="email"
            required
            autoComplete="email"
            placeholder="Enter your work email"
            aria-label="Work email"
            value={rsEmail}
            onChange={(e) => setRsEmail(e.target.value)}
          />
          {err && (
            <p className="lg-err" role="alert">
              {err}
            </p>
          )}
          <button type="submit" className="lg-primary" disabled={busy}>
            {busy ? "Sending…" : "Send reset link"}
          </button>
        </form>
        <button
          type="button"
          className="lg-back"
          onClick={() => {
            setView({ v: "auth" });
            setErr("");
          }}
        >
          Back to sign in
        </button>
      </>
    );
  } else if (view.v === "resetSent") {
    card = (
      <>
        <h2 className="lg-t">Check your inbox</h2>
        <p className="lg-s">
          We sent a password-reset link to <span className="lg-em">{view.email}</span>. It&apos;s
          one-time and short-lived, so use it soon.
        </p>
        <button type="button" className="lg-back" onClick={() => setView({ v: "auth" })}>
          Back to sign in
        </button>
      </>
    );
  } else if (view.v === "confirmSent") {
    card = (
      <>
        <h2 className="lg-t">Confirm your email</h2>
        <p className="lg-s">
          We sent a link to <span className="lg-em">{view.email}</span>. Click it and you&apos;ll
          land back here, signed in.
        </p>
        <button
          type="button"
          className="lg-back"
          onClick={() => {
            setView({ v: "auth" });
            setMode("signin");
          }}
        >
          Back to sign in
        </button>
      </>
    );
  } else {
    const signin = mode === "signin";
    card = (
      <>
        <button type="button" className="lg-gbtn" onClick={doGoogle} disabled={busy}>
          <GoogleG />
          Continue with Google
        </button>
        <div className="lg-or" aria-hidden="true">
          OR
        </div>
        <form className="lg-form" onSubmit={signin ? doSignIn : doSignUp}>
          {!signin && (
            <input
              id={`${uid}-name`}
              className="lg-input"
              type="text"
              required
              autoComplete="name"
              placeholder="Your name"
              aria-label="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
          <input
            id={`${uid}-email`}
            className="lg-input"
            type="email"
            required
            autoComplete="email"
            placeholder="Enter your work email"
            aria-label="Work email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            id={`${uid}-pass`}
            className="lg-input"
            type="password"
            required
            minLength={signin ? undefined : 8}
            autoComplete={signin ? "current-password" : "new-password"}
            placeholder={signin ? "Enter your password" : "Create a password (8+ characters)"}
            aria-label="Password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
          />
          {signin && !demo && (
            <div className="lg-forgot-row">
              <button
                type="button"
                className="lg-forgot"
                onClick={() => {
                  setView({ v: "reset" });
                  setErr("");
                  setRsEmail(email);
                }}
              >
                Forgot password?
              </button>
            </div>
          )}
          {err && (
            <p className="lg-err" role="alert">
              {err}
            </p>
          )}
          <button type="submit" className="lg-primary" disabled={busy}>
            {busy ? "One moment…" : "Continue"}
          </button>
        </form>
      </>
    );
  }

  return (
    <div className="lg">
      <div className="lg-left">
        <Link className="lg-brand" href="/" aria-label="XoR — home">
          <Image src="/xor-mark.png" alt="" aria-hidden width={40} height={24} priority />
          <span className="lg-wordmark">
            X<b>o</b>R
          </span>
        </Link>
        <div className="lg-body">
          <h1 className="lg-h">From brief to board.</h1>
          <p className="lg-tag">Track every enquiry, quote and build — one login.</p>
          <div className="lg-card">{card}</div>
          {notice && <p className="lg-note">{notice}</p>}
          {!gate.recovery && view.v === "auth" && (
            <p className="lg-switch">
              {mode === "signin" ? (
                <>
                  New to XoR?{" "}
                  <button
                    type="button"
                    onClick={() => {
                      setMode("signup");
                      setErr("");
                    }}
                  >
                    Create an account
                  </button>
                </>
              ) : (
                <>
                  Already have an account?{" "}
                  <button
                    type="button"
                    onClick={() => {
                      setMode("signin");
                      setErr("");
                    }}
                  >
                    Sign in
                  </button>
                </>
              )}
            </p>
          )}
        </div>
      </div>

      <aside className="lg-right">
        <div className="lg-right-inner">
          <Image
            src="/elecbits-xor-lockup-dark.png"
            alt="Elecbits × XOR"
            width={320}
            height={46}
            priority
            className="lg-lockup"
          />
          <ul className="lg-feats">
            <li>
              <FeatCheck />
              Every enquiry tracked end-to-end
            </li>
            <li>
              <FeatCheck />
              LLD drafts you can download
            </li>
            <li>
              <FeatCheck />
              One thread with the sales engineering team
            </li>
          </ul>
        </div>
        <p className="lg-right-foot">R&amp;D · Rapid prototyping · SMT — one roof</p>
      </aside>
    </div>
  );
}

function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

function FeatCheck() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

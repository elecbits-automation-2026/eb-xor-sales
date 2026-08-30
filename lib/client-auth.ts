/**
 * lib/client-auth.ts — browser-side auth facade for the client account.
 *
 * One API over two backends, chosen at RUNTIME by GET /api/config (so the
 * deployment needs no NEXT_PUBLIC_ build-time vars — plain SUPABASE_URL /
 * SUPABASE_ANON_KEY on the server are enough):
 *  - "supabase": /api/config returns a url + anon key → @supabase/supabase-js
 *    runs in the browser for AUTH ONLY (data always goes through our API
 *    routes with the session's bearer token).
 *  - "demo": config empty → POST /api/mock-auth; the opaque token persists in
 *    localStorage("xor_demo_token") and no email flows exist.
 *
 * Every failure throws an Error whose .message is safe to show to the user.
 * Error copy for returned auth links is ported from the Elecbits PMS
 * (elecbits-pms-odm2/src/lib/auth.js → authReturnError).
 */

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

export interface AuthUser {
  email: string;
  name: string;
}

const DEMO_TOKEN_KEY = "xor_demo_token";
const DEMO_USER_KEY = "xor_demo_user"; // companion record so currentUser() works offline

// ── runtime config (fetched once; a failed fetch retries on the next call
//    instead of silently locking a production visitor into demo mode) ──────
interface ClientCfg {
  url: string | null;
  anonKey: string | null;
}

let cfgPromise: Promise<ClientCfg> | null = null;

function clientCfg(): Promise<ClientCfg> {
  if (!cfgPromise) {
    cfgPromise = fetch("/api/config")
      .then((r) => {
        if (!r.ok) throw new Error(`config ${r.status}`);
        return r.json() as Promise<{
          supabase_url?: string | null;
          supabase_anon_key?: string | null;
        }>;
      })
      .then((b) => ({ url: b.supabase_url ?? null, anonKey: b.supabase_anon_key ?? null }))
      .catch(() => {
        cfgPromise = null; // transient — try again on the next call
        return { url: null, anonKey: null };
      });
  }
  return cfgPromise;
}

/** Which backend this deployment talks to (resolved from /api/config). */
export async function authMode(): Promise<"supabase" | "demo"> {
  const c = await clientCfg();
  return c.url && c.anonKey ? "supabase" : "demo";
}

// ── supabase singleton (only ever constructed in supabase mode) ───────────
let client: SupabaseClient | null = null;

async function sb(): Promise<SupabaseClient> {
  if (!client) {
    const c = await clientCfg();
    client = createClient(c.url || "", c.anonKey || "", {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  }
  return client;
}

/** Translate the few cryptic Supabase messages; pass the rest through. */
function friendly(message: string): string {
  if (/failed to fetch|network|load failed/i.test(message))
    return "Couldn't reach the server — check your connection and try again.";
  if (/invalid login credentials/i.test(message))
    return "That email and password don't match — try again, or reset your password.";
  if (/already registered/i.test(message))
    return "That email already has an account — sign in instead.";
  return message;
}

function userFromSession(session: Session | null): AuthUser | null {
  const u = session?.user;
  if (!u) return null;
  const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
  return { email: u.email ?? "", name: typeof meta.name === "string" ? meta.name : "" };
}

// ── demo-mode storage (in-memory fallback keeps private windows working) ──
let memToken: string | null = null;
let memUser: AuthUser | null = null;

function demoToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(DEMO_TOKEN_KEY) ?? memToken;
  } catch {
    return memToken;
  }
}

function demoUser(): AuthUser | null {
  if (!demoToken()) return null;
  try {
    const raw = window.localStorage.getItem(DEMO_USER_KEY);
    if (raw) {
      const u = JSON.parse(raw) as Partial<AuthUser>;
      return { email: typeof u.email === "string" ? u.email : "", name: typeof u.name === "string" ? u.name : "" };
    }
  } catch {
    // fall through to the in-memory copy
  }
  return memUser ?? { email: "", name: "" };
}

function storeDemo(token: string, user: AuthUser): void {
  memToken = token;
  memUser = user;
  try {
    window.localStorage.setItem(DEMO_TOKEN_KEY, token);
    window.localStorage.setItem(DEMO_USER_KEY, JSON.stringify(user));
  } catch {
    // private mode — the session lives for this page view only
  }
}

function clearDemo(): void {
  memToken = null;
  memUser = null;
  try {
    window.localStorage.removeItem(DEMO_TOKEN_KEY);
    window.localStorage.removeItem(DEMO_USER_KEY);
  } catch {
    // ignore
  }
}

async function mockAuth(
  payload: Record<string, string>,
): Promise<{ token: string; user: { id: string; email: string; name: string } }> {
  let res: Response;
  try {
    res = await fetch("/api/mock-auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error("Couldn't reach the server — check your connection and try again.");
  }
  const body = (await res.json().catch(() => ({}))) as {
    token?: string;
    user?: { id: string; email: string; name: string };
    detail?: string;
  };
  if (!res.ok || !body.token || !body.user) {
    throw new Error(body.detail || "Something went wrong — please try again.");
  }
  return { token: body.token, user: body.user };
}

// ── public API ────────────────────────────────────────────────────────────

export async function signUp(i: {
  name: string;
  company?: string;
  email: string;
  password: string;
}): Promise<{ needsEmailConfirm: boolean }> {
  if ((await authMode()) === "supabase") {
    const { data, error } = await (await sb()).auth.signUp({
      email: i.email,
      password: i.password,
      options: { data: { name: i.name, company: i.company ?? "" } },
    });
    if (error) throw new Error(friendly(error.message));
    // No session back ⇒ Supabase wants the email confirmed first.
    return { needsEmailConfirm: !data.session };
  }
  const { token, user } = await mockAuth({
    action: "signup",
    email: i.email,
    password: i.password,
    name: i.name,
    company: i.company ?? "",
  });
  storeDemo(token, { email: user.email, name: user.name });
  return { needsEmailConfirm: false };
}

/**
 * Google OAuth. Supabase mode: kicks off the provider redirect (the page
 * navigates away — a resolved call means the redirect is underway) and lands
 * back on /account. Demo mode: not available; throws a friendly notice.
 */
export async function signInWithGoogle(): Promise<void> {
  if ((await authMode()) === "supabase") {
    const { error } = await (await sb()).auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin + "/account" },
    });
    if (error) throw new Error(friendly(error.message));
    return;
  }
  throw new Error("Google sign-in goes live with the production setup — use email below for now.");
}

export async function signIn(email: string, password: string): Promise<void> {
  if ((await authMode()) === "supabase") {
    const { error } = await (await sb()).auth.signInWithPassword({ email, password });
    if (error) throw new Error(friendly(error.message));
    return;
  }
  const { token, user } = await mockAuth({ action: "signin", email, password });
  storeDemo(token, { email: user.email, name: user.name });
}

export async function signOut(): Promise<void> {
  if ((await authMode()) === "supabase") {
    await (await sb()).auth.signOut();
    return;
  }
  clearDemo();
}

/** Supabase mode only — emails a link that lands back on /account. */
export async function resetPassword(email: string): Promise<void> {
  if ((await authMode()) !== "supabase") {
    throw new Error("Password reset isn't available in demo mode.");
  }
  const redirectTo =
    typeof window !== "undefined" ? `${window.location.origin}/account` : undefined;
  const { error } = await (await sb()).auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw new Error(friendly(error.message));
}

/** Supabase mode only — sets a new password on the recovery session. */
export async function setPassword(password: string): Promise<void> {
  if ((await authMode()) !== "supabase") {
    throw new Error("Password reset isn't available in demo mode.");
  }
  const { error } = await (await sb()).auth.updateUser({ password });
  if (error) throw new Error(friendly(error.message));
}

/** Bearer token for API calls, or null when signed out. Never throws. */
export async function getAccessToken(): Promise<string | null> {
  if ((await authMode()) === "supabase") {
    try {
      const { data } = await (await sb()).auth.getSession();
      return data.session?.access_token ?? null;
    } catch {
      return null;
    }
  }
  return demoToken();
}

export async function currentUser(): Promise<AuthUser | null> {
  if ((await authMode()) === "supabase") {
    try {
      const { data } = await (await sb()).auth.getSession();
      return userFromSession(data.session);
    } catch {
      return null;
    }
  }
  return demoUser();
}

/**
 * Subscribe to auth changes; returns the unsubscribe function. Supabase mode
 * relays onAuthStateChange (events include "PASSWORD_RECOVERY" when a reset
 * link lands); demo mode watches cross-tab localStorage changes and reports
 * "SIGNED_IN" / "SIGNED_OUT".
 */
export function onAuthChange(cb: (user: AuthUser | null, event: string) => void): () => void {
  // The mode is resolved asynchronously (runtime config), so the actual
  // subscription attaches once it's known; the returned unsubscriber works
  // whether it fires before or after that happens.
  let disposed = false;
  let cleanup: () => void = () => undefined;
  void (async () => {
    if ((await authMode()) === "supabase") {
      if (disposed) return;
      const { data } = (await sb()).auth.onAuthStateChange((event, session) => {
        cb(userFromSession(session), event);
      });
      cleanup = () => data.subscription.unsubscribe();
      if (disposed) cleanup();
      return;
    }
    if (typeof window === "undefined" || disposed) return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== DEMO_TOKEN_KEY) return; // null = storage.clear()
      const user = demoUser();
      cb(user, user ? "SIGNED_IN" : "SIGNED_OUT");
    };
    window.addEventListener("storage", onStorage);
    cleanup = () => window.removeEventListener("storage", onStorage);
    if (disposed) cleanup();
  })();
  return () => {
    disposed = true;
    cleanup();
  };
}

/*
 * A reset or confirmation link can come back refusing to work — most often
 * because it has already been used or has timed out. Supabase says so in the
 * URL fragment, where nobody reads it; without this the person lands on a
 * blank login page with a frightening address bar and no idea what happened.
 * (Ported from the Elecbits PMS auth.js.) Returns "" when there is no error;
 * otherwise clears the URL and returns copy safe to show inline.
 */
export function authReturnError(): string {
  if (typeof window === "undefined") return "";
  const read = (str: string) => new URLSearchParams(str.replace(/^[#?]/, ""));
  const frag = read(window.location.hash);
  const query = read(window.location.search);
  const code =
    frag.get("error_code") || query.get("error_code") || frag.get("error") || query.get("error");
  if (!code) return "";
  const desc = (frag.get("error_description") || query.get("error_description") || "").replace(
    /\+/g,
    " ",
  );
  // clear it, or it reappears on every reload of this tab
  try {
    window.history.replaceState({}, "", window.location.pathname);
  } catch {
    // ignore — worst case the message shows again on reload
  }
  if (/otp_expired|expired/i.test(`${code} ${desc}`))
    return "That link has expired — they are one-time and short-lived. Put your email in below and send yourself a fresh one.";
  if (/access_denied/i.test(code))
    return "That link is no longer valid — it may already have been used. Send yourself a fresh one below.";
  return desc || "That link didn't work. Send yourself a fresh one below.";
}

/**
 * Server-side auth: resolve the verified user behind a request's bearer
 * token. Two backends, mirroring the data layer:
 *
 *  - Supabase Auth (real mode): the browser signs up/in against Supabase
 *    directly (anon key); API routes verify the access token here with the
 *    service client. Only CONFIRMED emails count — an unconfirmed signup
 *    must never unlock another person's enquiry list.
 *  - Memory auth (demo/tests, when Supabase is absent): users live in
 *    process memory behind /api/mock-auth; tokens are random bearer strings.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "crypto";

import { cfg } from "./config";
import { usingMemoryDb } from "./supabase";

export interface AuthUser {
  id: string;
  email: string; // lowercased, verified
  name: string;
  /** Elecbits sales agent chosen at signup (core.people), if any. */
  sales_agent?: string | null;
  /** B2B profile captured at signup — prefills the intake contact card. */
  company?: string | null;
  phone?: string | null;
  designation?: string | null;
  website?: string | null;
}

/** Extra signup profile fields (stored as auth metadata). */
export interface SignupProfile {
  company?: string;
  phone?: string;
  designation?: string;
  website?: string;
}

// ── memory backend ────────────────────────────────────────────────────────
interface MemAuthState {
  users: Map<
    string,
    {
      id: string;
      email: string;
      name: string;
      sales_agent?: string | null;
      company?: string | null;
      phone?: string | null;
      designation?: string | null;
      website?: string | null;
      passHash: string;
    }
  >;
  tokens: Map<string, string>; // token -> user id
}

function memAuth(): MemAuthState {
  const g = globalThis as { __xorMemAuth?: MemAuthState };
  if (!g.__xorMemAuth) g.__xorMemAuth = { users: new Map(), tokens: new Map() };
  return g.__xorMemAuth;
}

/** Test hook: wipe demo users/tokens. */
export function resetMemoryAuth(): void {
  delete (globalThis as { __xorMemAuth?: MemAuthState }).__xorMemAuth;
}

// Demo-only hashing — real deployments use Supabase Auth.
function hash(password: string): string {
  return createHash("sha256").update(`xor-demo:${password}`).digest("hex");
}

export function memorySignUp(
  email: string,
  password: string,
  name: string,
  salesAgent = "",
  profile: SignupProfile = {},
): { token: string; user: AuthUser } | { error: string; status: number } {
  const s = memAuth();
  const key = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(key)) return { error: "enter a valid email", status: 400 };
  if ((password ?? "").length < 8) return { error: "password must be at least 8 characters", status: 400 };
  if ([...s.users.values()].some((u) => u.email === key)) {
    return { error: "an account with this email already exists — sign in instead", status: 409 };
  }
  const user: AuthUser = {
    id: randomUUID(),
    email: key,
    name: (name ?? "").trim(),
    sales_agent: salesAgent.trim() || null,
    company: profile.company?.trim() || null,
    phone: profile.phone?.trim() || null,
    designation: profile.designation?.trim() || null,
    website: profile.website?.trim() || null,
  };
  s.users.set(user.id, { ...user, passHash: hash(password) });
  const token = randomUUID() + randomUUID().replace(/-/g, "");
  s.tokens.set(token, user.id);
  return { token, user };
}

export function memorySignIn(
  email: string,
  password: string,
): { token: string; user: AuthUser } | { error: string; status: number } {
  const s = memAuth();
  const key = email.trim().toLowerCase();
  const rec = [...s.users.values()].find((u) => u.email === key);
  if (!rec || rec.passHash !== hash(password ?? "")) {
    return { error: "wrong email or password", status: 401 };
  }
  const token = randomUUID() + randomUUID().replace(/-/g, "");
  s.tokens.set(token, rec.id);
  return { token, user: { id: rec.id, email: rec.email, name: rec.name } };
}

function memoryUser(token: string): AuthUser | null {
  const s = memAuth();
  const id = s.tokens.get(token);
  if (!id) return null;
  const rec = s.users.get(id);
  return rec
    ? {
        id: rec.id,
        email: rec.email,
        name: rec.name,
        sales_agent: rec.sales_agent ?? null,
        company: rec.company ?? null,
        phone: rec.phone ?? null,
        designation: rec.designation ?? null,
        website: rec.website ?? null,
      }
    : null;
}

// ── Supabase backend ──────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let authClient: SupabaseClient<any, any, any, any, any> | null = null;

function serviceAuth() {
  if (!authClient) {
    authClient = createClient(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return authClient;
}

/** Verified user behind the request's Authorization header, or null. */
export async function getUserFromRequest(req: Request): Promise<AuthUser | null> {
  const authz = req.headers.get("authorization") ?? "";
  if (!authz.startsWith("Bearer ")) return null;
  const token = authz.slice(7).trim();
  if (!token) return null;

  if (usingMemoryDb()) return memoryUser(token);

  try {
    const { data, error } = await serviceAuth().auth.getUser(token);
    if (error || !data.user?.email) return null;
    const u = data.user;
    // Require a confirmed email — the enquiry list keys on this address.
    if (!u.email_confirmed_at && !u.confirmed_at) return null;
    const meta = (k: string): string | null => {
      const v = u.user_metadata?.[k];
      return typeof v === "string" && v.trim() ? v.trim() : null;
    };
    return {
      id: u.id,
      email: u.email!.toLowerCase(),
      name: meta("name") ?? "",
      sales_agent: meta("sales_agent"),
      company: meta("company"),
      phone: meta("phone"),
      designation: meta("designation"),
      website: meta("website"),
    };
  } catch (err) {
    console.error("auth token verification failed:", err);
    return null;
  }
}

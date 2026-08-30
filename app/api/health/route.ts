/**
 * Liveness + configuration visibility. In real-Drive mode it also resolves
 * (and thereby warms) the three Google bindings — register, accounts folder,
 * funnel — so a wrong or missing binding shows up HERE, before a customer
 * ever hits it.
 *
 * This route must NEVER 500: whatever breaks (a crashing import, a bad key,
 * an unexposed schema) comes back as an error STRING in the JSON, because a
 * blank error page is exactly the situation this endpoint exists to avoid.
 */
import { NextResponse } from "next/server";

import { cfg } from "@/lib/config";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type BindingReport = { id: string; name: string; created?: boolean } | { error: string };

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function report(
  r: PromiseSettledResult<{ id: string; name: string; created?: boolean }>,
): BindingReport {
  return r.status === "fulfilled" ? r.value : { error: errText(r.reason) };
}

export async function GET() {
  const body: {
    ok: boolean;
    mock_llm: boolean;
    mock_drive: boolean;
    db: "supabase" | "memory";
    auth: "supabase" | "demo";
    google?:
      | { register: BindingReport; accounts_folder: BindingReport; funnel: BindingReport }
      | { error: string };
  } = {
    ok: true,
    mock_llm: cfg.mockLlm,
    mock_drive: cfg.mockDrive,
    // Which drivers this deploy actually resolved — a typo'd env var shows
    // up here as "memory"/"demo" instead of failing silently.
    db: cfg.supabaseUrl && cfg.supabaseServiceRoleKey ? "supabase" : "memory",
    auth: cfg.supabaseUrl && cfg.supabaseAnonKey ? "supabase" : "demo",
  };

  try {
    if (!cfg.mockDrive && cfg.googleServiceAccountB64) {
      const { resolveRegister, resolveAccountsFolder, resolveFunnel } = await import(
        "@/lib/gtargets"
      );
      const [register, folder, funnel] = await Promise.allSettled([
        resolveRegister(),
        resolveAccountsFolder(),
        resolveFunnel(),
      ]);
      body.google = {
        register: report(register),
        accounts_folder: report(folder),
        funnel: report(funnel),
      };
    }
  } catch (e) {
    body.google = { error: errText(e) };
  }

  return NextResponse.json(body);
}

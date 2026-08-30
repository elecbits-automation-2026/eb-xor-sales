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
import { NextRequest, NextResponse } from "next/server";

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

export async function GET(req: NextRequest) {
  const body: {
    ok: boolean;
    mock_llm: boolean;
    mock_drive: boolean;
    db: "supabase" | "memory";
    auth: "supabase" | "demo";
    llm?: { ok: true; model: string } | { error: string };
    google?:
      | { register: BindingReport; accounts_folder: BindingReport; funnel: BindingReport }
      | { error: string };
    write_probe?: "ok" | { error: string };
    retries?: { pending: number; last_error?: string } | { error: string };
  } = {
    ok: true,
    mock_llm: cfg.mockLlm,
    mock_drive: cfg.mockDrive,
    // Which drivers this deploy actually resolved — a typo'd env var shows
    // up here as "memory"/"demo" instead of failing silently.
    db: cfg.supabaseUrl && cfg.supabaseServiceRoleKey ? "supabase" : "memory",
    auth: cfg.supabaseUrl && cfg.supabaseAnonKey ? "supabase" : "demo",
  };

  // Real 1-token ping so an invalid key / empty credits is VISIBLE here
  // instead of silently degrading the chat to canned fallbacks.
  if (!cfg.mockLlm && cfg.anthropicApiKey) {
    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: cfg.anthropicApiKey });
      await client.messages.create({
        model: cfg.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      });
      body.llm = { ok: true, model: cfg.model };
    } catch (e) {
      body.llm = { error: errText(e) };
    }
  }

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

  // ?deep=1 — the expensive truths: an ACTUAL file-content write into the
  // accounts tree (catches the service-account-in-My-Drive quota refusal
  // that plain folder checks can't see) and the handoff retry queue with
  // Google's verbatim last error.
  if (new URL(req.url).searchParams.get("deep")) {
    if (!cfg.mockDrive && cfg.googleServiceAccountB64) {
      try {
        const { driveWriteProbe } = await import("@/lib/drive");
        const err = await driveWriteProbe();
        body.write_probe = err ? { error: err } : "ok";
      } catch (e) {
        body.write_probe = { error: errText(e) };
      }
    }
    try {
      const { getDb } = await import("@/lib/supabase");
      const rows = await getDb().unresolvedHandoffRetries();
      const last = rows.length
        ? rows.reduce((a, b) => (Date.parse(a.created_at) > Date.parse(b.created_at) ? a : b))
        : null;
      body.retries = {
        pending: rows.length,
        ...(last?.last_error ? { last_error: String(last.last_error).slice(0, 400) } : {}),
      };
    } catch (e) {
      body.retries = { error: errText(e) };
    }
  }

  return NextResponse.json(body);
}

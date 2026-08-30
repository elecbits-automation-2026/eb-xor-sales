/**
 * Liveness + configuration visibility. In real-Drive mode it also resolves
 * (and thereby warms) the three Google bindings — register, accounts folder,
 * funnel — so a wrong or missing binding shows up HERE, before a customer
 * ever hits it. Errors come back as strings, never a 500.
 */
import { NextResponse } from "next/server";

import { cfg } from "@/lib/config";

export const maxDuration = 30;

type BindingReport = { id: string; name: string; created?: boolean } | { error: string };

function report(r: PromiseSettledResult<{ id: string; name: string; created?: boolean }>): BindingReport {
  if (r.status === "fulfilled") return r.value;
  const reason = r.reason as { message?: string };
  return { error: String(reason?.message ?? r.reason) };
}

export async function GET() {
  const body: {
    ok: boolean;
    mock_llm: boolean;
    mock_drive: boolean;
    google?: { register: BindingReport; accounts_folder: BindingReport; funnel: BindingReport };
  } = { ok: true, mock_llm: cfg.mockLlm, mock_drive: cfg.mockDrive };

  if (!cfg.mockDrive && cfg.googleServiceAccountB64) {
    const { resolveRegister, resolveAccountsFolder, resolveFunnel } = await import("@/lib/gtargets");
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

  return NextResponse.json(body);
}

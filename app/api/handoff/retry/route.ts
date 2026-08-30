/**
 * Cron/manual entry point for the Drive/Sheets handoff retry flush — the
 * loop itself lives in lib/handoff-flush.ts, shared with the opportunistic
 * in-app trigger so queued folders land without waiting for cron cadence.
 */
import { NextRequest, NextResponse } from "next/server";

import { cfg } from "@/lib/config";
import { flushHandoffRetries } from "@/lib/handoff-flush";

export const maxDuration = 800; // plan ceiling — big backfills need the room

export async function POST(req: NextRequest) {
  if (!cfg.cronSecret) {
    return NextResponse.json({ detail: "CRON_SECRET is not configured" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${cfg.cronSecret}`) {
    return NextResponse.json({ detail: "unauthorized" }, { status: 401 });
  }

  const res = await flushHandoffRetries();
  return NextResponse.json({ ok: true, ...res });
}

// Vercel Cron invokes with GET (Authorization: Bearer CRON_SECRET is
// injected automatically when the env var exists); manual runs use POST.
export { POST as GET };

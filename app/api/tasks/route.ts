/**
 * Read feed for the "Background tasks" column on the chat page: the pipeline
 * steps recorded for one session, oldest first. Access model is the same as
 * /api/chat — knowing the (unguessable) session id IS the capability; the
 * feed contains nothing the chat itself doesn't already tell the visitor.
 *
 * This poll is also the app's heartbeat, so it nudges the Drive/Sheets
 * handoff retry queue (throttled + capped in lib/handoff-flush) — queued
 * folders land while someone is actually looking, not on the next cron.
 */
import { NextRequest, NextResponse } from "next/server";

import { cfg } from "@/lib/config";
import { getDb } from "@/lib/supabase";

export const maxDuration = 120; // poll + up to 3 nudged retries

export async function GET(req: NextRequest) {
  const session = req.nextUrl.searchParams.get("session") ?? "";
  if (!/^[0-9a-f][0-9a-f-]{14,62}[0-9a-f]$/i.test(session)) {
    return NextResponse.json({ tasks: [] });
  }
  let tasks: unknown[] = [];
  try {
    tasks = await getDb().tasksForSession(session);
  } catch {
    // a bad/unknown id (e.g. non-uuid against Postgres) is just an empty feed
    return NextResponse.json({ tasks: [] });
  }
  if (!cfg.mockDrive) {
    const { opportunisticFlush } = await import("@/lib/handoff-flush");
    await opportunisticFlush(); // never throws; no-op inside the throttle
  }
  return NextResponse.json({ tasks });
}

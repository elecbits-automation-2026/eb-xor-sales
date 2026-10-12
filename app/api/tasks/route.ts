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
import { getDb, type TaskRow } from "@/lib/supabase";

export const maxDuration = 120; // poll + up to 3 nudged retries

/** No serverless window outlives this — a running row this quiet was cut
 *  off (dropped connection, killed invocation) and will never finish. */
const STALE_RUNNING_MS = 15 * 60_000;

export async function GET(req: NextRequest) {
  const session = req.nextUrl.searchParams.get("session") ?? "";
  if (!/^[0-9a-f][0-9a-f-]{14,62}[0-9a-f]$/i.test(session)) {
    return NextResponse.json({ tasks: [] });
  }
  let tasks: TaskRow[] = [];
  try {
    tasks = await getDb().tasksForSession(session);
  } catch {
    // a bad/unknown id (e.g. non-uuid against Postgres) is just an empty feed
    return NextResponse.json({ tasks: [] });
  }
  // Sweep orphans: live long-runs keep bumping updated_at via their stage
  // narration, so only a genuinely dead run trips this. The write is
  // conditional on status=running — a real completion landing concurrently
  // is never overwritten — and the advice matches the row: generations have
  // a retry chip in the chat; infrastructure steps are retried by the
  // system on its own.
  const { GEN_LABELS } = await import("@/lib/tasks");
  const now = Date.now();
  for (const t of tasks) {
    const last = Date.parse(t.updated_at || t.created_at);
    if (t.status === "running" && Number.isFinite(last) && now - last > STALE_RUNNING_MS) {
      t.status = "failed";
      t.detail = GEN_LABELS.test(t.label)
        ? "cut off mid-run (connection or time window) — hit the chip in the chat to run it again"
        : "cut off mid-run — the system retries this step automatically";
      void getDb()
        .failTaskIfStillRunning(t.id, t.detail)
        .catch(() => undefined);
    }
  }
  if (!cfg.mockDrive) {
    const { opportunisticFlush } = await import("@/lib/handoff-flush");
    await opportunisticFlush(); // never throws; no-op inside the throttle
  }
  return NextResponse.json({ tasks });
}

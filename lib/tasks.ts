/**
 * Bookkeeping for the "Background tasks" activity column on the chat page.
 *
 * trackTask wraps one pipeline step in a task row (running → completed /
 * failed) so the panel can show it live; noteTask records a step that is
 * already finished (an upload, a mock-mode step). The feed is cosmetic:
 * every write here is best-effort and must NEVER break the step itself —
 * the step's own result/exception always passes through untouched.
 *
 * Failure details are client-facing, so trackTask writes the caller's
 * `failDetail` (or a generic line), never the raw error — that goes to the
 * server log where it already lands today.
 */
import { getDb, type TaskRow } from "./supabase";

export async function trackTask<T>(
  sessionId: string | null | undefined,
  label: string,
  fn: (progress: (detail: string) => void) => Promise<T>,
  opts?: {
    detail?: (result: T) => string | null;
    /** Static line, or derive one from the error — shown on the failed row. */
    failDetail?: string | ((err: unknown) => string);
  },
): Promise<T> {
  if (!sessionId) return fn(() => undefined);
  const db = getDb();
  let task: TaskRow | null = null;
  try {
    task = await db.insertTask(sessionId, label);
  } catch (err) {
    console.error(`task insert failed (${label})`, err);
  }
  // Live sub-stage line on the RUNNING row ("web research: …", "rendering
  // the branded PDF") — the panel polls every 1.5s while anything runs, so
  // updates show up as they happen. Fire-and-forget by design.
  const progress = (detail: string): void => {
    if (task) void db.updateTask(task.id, { detail }).catch(() => undefined);
  };
  try {
    const result = await fn(progress);
    if (task) {
      await db
        .updateTask(task.id, { status: "completed", detail: opts?.detail?.(result) ?? null })
        .catch(() => undefined);
    } else {
      // The "running" insert failed — the step must STILL leave a record;
      // a step that ran with no row is indistinguishable from one skipped.
      await getDb()
        .insertTask(sessionId, label, "completed", opts?.detail?.(result) ?? null)
        .catch((err) => console.error(`task record failed (${label})`, err));
    }
    return result;
  } catch (err) {
    const failDetail =
      (typeof opts?.failDetail === "function" ? opts.failDetail(err) : opts?.failDetail) ??
      "temporary hiccup — the team is on it";
    if (task) {
      await db
        .updateTask(task.id, { status: "failed", detail: failDetail })
        .catch(() => undefined);
    } else {
      await getDb()
        .insertTask(sessionId, label, "failed", failDetail)
        .catch(() => undefined);
    }
    throw err;
  }
}

/** Record an already-finished step (an upload, a mock-mode pipeline step). */
export async function noteTask(
  sessionId: string | null | undefined,
  label: string,
  status: "completed" | "failed",
  detail?: string | null,
): Promise<void> {
  if (!sessionId) return;
  try {
    await getDb().insertTask(sessionId, label, status, detail ?? null);
  } catch (err) {
    console.error(`task note failed (${label})`, err);
  }
}

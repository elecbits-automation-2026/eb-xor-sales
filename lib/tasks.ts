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
  fn: () => Promise<T>,
  opts?: {
    detail?: (result: T) => string | null;
    failDetail?: string;
  },
): Promise<T> {
  if (!sessionId) return fn();
  const db = getDb();
  let task: TaskRow | null = null;
  try {
    task = await db.insertTask(sessionId, label);
  } catch (err) {
    console.error(`task insert failed (${label})`, err);
  }
  try {
    const result = await fn();
    if (task) {
      await db
        .updateTask(task.id, { status: "completed", detail: opts?.detail?.(result) ?? null })
        .catch(() => undefined);
    }
    return result;
  } catch (err) {
    if (task) {
      await db
        .updateTask(task.id, {
          status: "failed",
          detail: opts?.failDetail ?? "temporary hiccup — the team is on it",
        })
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

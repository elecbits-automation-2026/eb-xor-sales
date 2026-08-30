/**
 * The Drive/Sheets handoff retry flush — shared by the cron endpoint
 * (/api/handoff/retry) and the opportunistic in-app trigger below.
 *
 * A row is eligible on its first retry immediately, then after
 * (2^attempts) * 15 minutes; after 8 attempts it is left for a human
 * (logged loudly — alerting is wired on that log line).
 *
 * Why the opportunistic trigger exists: the platform's cron cadence can be
 * as slow as daily, and a customer who just filed a deal should not wait a
 * day for their folder. Any signed-in activity (the tasks panel polls
 * continuously) nudges the queue at most once per five minutes.
 */
import { driveHandoff, type DriveHandoffPayload } from "@/lib/drive";
import { appendFunnelRow } from "@/lib/sheets";
import { getDb } from "@/lib/supabase";

const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 15 * 60_000;

export interface FlushResult {
  processed: number;
  resolved: number;
  failed: number;
  skipped: number;
}

export async function flushHandoffRetries(maxRows = Infinity): Promise<FlushResult> {
  const db = getDb();
  const rows = await db.unresolvedHandoffRetries();

  const res: FlushResult = { processed: 0, resolved: 0, failed: 0, skipped: 0 };
  for (const r of rows) {
    if (res.processed >= maxRows) break;
    if (r.attempts >= MAX_ATTEMPTS) {
      console.error(
        `HANDOFF RETRY EXHAUSTED: retry ${r.id} (lead ${r.lead_id}, kind ${r.kind}) ` +
          `failed ${r.attempts} times — NEEDS HUMAN ATTENTION. last_error: ${r.last_error}`,
      );
      res.skipped++;
      continue;
    }
    const eligible =
      r.attempts === 0 ||
      Date.now() - Date.parse(r.created_at) > 2 ** r.attempts * BASE_DELAY_MS;
    if (!eligible) {
      res.skipped++;
      continue;
    }

    res.processed++;
    try {
      if (r.kind === "drive") {
        const payload = r.payload as unknown as DriveHandoffPayload;
        const result = await driveHandoff(payload);
        await db.updateLead(r.lead_id, {
          drive_folder_id: result.folder_id,
          drive_folder_url: result.folder_url,
          drive_committed: true,
        });
        if (payload.deal_id) {
          try {
            const { register } = await import("@/lib/register");
            await register().setDealFolderLink(payload.deal_id, result.folder_url);
          } catch (e2) {
            console.error(`register folder-link write failed deal=${payload.deal_id}`, e2);
          }
        }
      } else {
        const row = (r.payload as { row?: (string | number)[] }).row ?? [];
        // The Drive Folder cell (index 11) may have been empty at finalize
        // time (drive failed first) — refresh it from the lead, which a
        // drive retry earlier in this run may just have committed.
        if (row.length > 11 && !row[11]) {
          const lead = await db.getLead(r.lead_id);
          if (lead?.drive_folder_url) row[11] = lead.drive_folder_url;
        }
        await appendFunnelRow(row);
        await db.updateLead(r.lead_id, { sheet_appended: true });
      }
      await db.recordHandoffAttempt(r.id, true);
      res.resolved++;
      await markTaskRecovered(
        db,
        r.lead_id,
        r.kind === "drive" ? "Create Drive workspace" : "Log to sales funnel",
      );
    } catch (e) {
      res.failed++;
      const message = e instanceof Error ? e.message : String(e);
      console.error(`handoff retry ${r.id} (lead ${r.lead_id}, kind ${r.kind}) failed:`, e);
      try {
        await db.recordHandoffAttempt(r.id, false, message);
      } catch (e2) {
        console.error(`handoff retry ${r.id}: could not record attempt:`, e2);
      }
    }
  }
  return res;
}

/**
 * Flip the matching failed row in the session's "Background tasks" feed to
 * completed once its retry lands — purely cosmetic, so best-effort.
 */
async function markTaskRecovered(
  db: ReturnType<typeof getDb>,
  leadId: string,
  label: string,
): Promise<void> {
  try {
    const lead = await db.getLead(leadId);
    if (!lead?.session_id) return;
    const tasks = await db.tasksForSession(lead.session_id);
    const t = tasks.filter((x) => x.label === label && x.status === "failed").pop();
    if (t) await db.updateTask(t.id, { status: "completed", detail: "recovered by retry" });
  } catch (e) {
    console.error(`task recovery mark failed (lead ${leadId}, ${label})`, e);
  }
}

// ── opportunistic trigger ─────────────────────────────────────────────────
let lastOpportunistic = 0;

/**
 * Nudge the retry queue from live app traffic: at most once per 5 minutes
 * per instance, capped at 3 rows so no poll request balloons. Never throws.
 */
export async function opportunisticFlush(): Promise<void> {
  if (Date.now() - lastOpportunistic < 5 * 60_000) return;
  lastOpportunistic = Date.now();
  try {
    const res = await flushHandoffRetries(3);
    if (res.processed > 0) {
      console.info(
        `opportunistic handoff flush: processed=${res.processed} resolved=${res.resolved} failed=${res.failed}`,
      );
    }
  } catch (err) {
    console.error("opportunistic handoff flush failed", err);
  }
}

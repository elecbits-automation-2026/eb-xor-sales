/**
 * Cron: retry failed Drive/Sheets handoffs with exponential backoff.
 * A row is eligible on its first retry immediately, then after
 * (2^attempts) * 15 minutes; after 8 attempts it is left for a human
 * (logged loudly — alerting is wired on that log line).
 */
import { NextRequest, NextResponse } from "next/server";

import { cfg } from "@/lib/config";
import { driveHandoff, type DriveHandoffPayload } from "@/lib/drive";
import { appendFunnelRow } from "@/lib/sheets";
import { getDb } from "@/lib/supabase";

export const maxDuration = 60;

const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 15 * 60_000;

export async function POST(req: NextRequest) {
  if (!cfg.cronSecret) {
    return NextResponse.json({ detail: "CRON_SECRET is not configured" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${cfg.cronSecret}`) {
    return NextResponse.json({ detail: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const rows = await db.unresolvedHandoffRetries();

  let processed = 0;
  let resolved = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of rows) {
    if (r.attempts >= MAX_ATTEMPTS) {
      console.error(
        `HANDOFF RETRY EXHAUSTED: retry ${r.id} (lead ${r.lead_id}, kind ${r.kind}) ` +
          `failed ${r.attempts} times — NEEDS HUMAN ATTENTION. last_error: ${r.last_error}`,
      );
      skipped++;
      continue;
    }
    const eligible =
      r.attempts === 0 ||
      Date.now() - Date.parse(r.created_at) > 2 ** r.attempts * BASE_DELAY_MS;
    if (!eligible) {
      skipped++;
      continue;
    }

    processed++;
    try {
      if (r.kind === "drive") {
        const result = await driveHandoff(r.payload as unknown as DriveHandoffPayload);
        await db.updateLead(r.lead_id, {
          drive_folder_id: result.folder_id,
          drive_folder_url: result.folder_url,
          drive_committed: true,
        });
      } else {
        const row = (r.payload as { row?: (string | number)[] }).row ?? [];
        await appendFunnelRow(row);
        await db.updateLead(r.lead_id, { sheet_appended: true });
      }
      await db.recordHandoffAttempt(r.id, true);
      resolved++;
    } catch (e) {
      failed++;
      const message = e instanceof Error ? e.message : String(e);
      console.error(`handoff retry ${r.id} (lead ${r.lead_id}, kind ${r.kind}) failed:`, e);
      try {
        await db.recordHandoffAttempt(r.id, false, message);
      } catch (e2) {
        console.error(`handoff retry ${r.id}: could not record attempt:`, e2);
      }
    }
  }

  return NextResponse.json({ ok: true, processed, resolved, failed, skipped });
}

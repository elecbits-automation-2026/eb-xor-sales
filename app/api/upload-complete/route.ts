/**
 * Step 3 of the upload flow: after the browser PUT the file to the signed
 * URL, verify the object actually exists in Storage, record the lead_files
 * row, and advance the checklist state machine.
 */
import { NextRequest, NextResponse } from "next/server";

import { cfg } from "@/lib/config";
import { ATTACHMENT_ITEM, checkExtension, EMS_CHECKLIST } from "@/lib/flows";
import * as orchestrator from "@/lib/orchestrator";
import { clientKey, rateLimitOk } from "@/lib/ratelimit";
import { getDb } from "@/lib/supabase";
import { noteTask } from "@/lib/tasks";
import { istTimestamp } from "@/lib/util";
import { sanitizeFilename } from "@/lib/util";

export async function POST(req: NextRequest) {
  if (!rateLimitOk(clientKey(req))) {
    return NextResponse.json({ detail: "too many requests — slow down a little" }, { status: 429 });
  }

  let body: {
    session_id?: string;
    item_key?: string;
    storage_path?: string;
    filename?: string;
    bytes?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "invalid JSON" }, { status: 400 });
  }

  // "attachment" is the ad-hoc slot (paperclip / paste), valid in any state.
  const item =
    body.item_key === ATTACHMENT_ITEM.key
      ? ATTACHMENT_ITEM
      : EMS_CHECKLIST.find((i) => i.key === body.item_key);
  if (!item) {
    return NextResponse.json({ detail: "unknown checklist item" }, { status: 400 });
  }

  const db = getDb();
  const s = body.session_id ? await db.getSession(body.session_id) : null;
  if (!s) {
    return NextResponse.json({ detail: "unknown session" }, { status: 404 });
  }

  const safe = sanitizeFilename(body.filename ?? "");
  const extError = checkExtension(item, safe);
  if (extError) {
    return NextResponse.json({ detail: extError }, { status: 415 });
  }

  // The path must be the one upload-url issued for this session + item —
  // never accept an arbitrary storage location.
  const expected = `${s.id}/${item.key}--${safe}`;
  if (body.storage_path !== expected) {
    return NextResponse.json({ detail: "storage path mismatch" }, { status: 400 });
  }

  const stat = await db.statObject(expected);
  if (!stat) {
    return NextResponse.json(
      { detail: "upload not found in storage — please retry the file" },
      { status: 400 },
    );
  }

  // Enforce the size limit against the ACTUAL stored object, not the
  // client-declared byte count from upload-url.
  if (stat.bytes > cfg.maxUploadMb * 1024 * 1024) {
    return NextResponse.json(
      { detail: `File exceeds ${cfg.maxUploadMb} MB` },
      { status: 413 },
    );
  }

  await db.insertLeadFile({
    session_id: s.id,
    lead_id: s.data.lead_id,
    item_key: item.key,
    filename: safe,
    storage_path: expected,
    bytes: stat.bytes || Number(body.bytes) || null,
    drive_file_id: null,
  });

  // Deal folder already exists (IDs are issued early)? Deliver the file to
  // Drive right now — best-effort; a failure leaves it staged and the
  // finalize handoff (with its retry queue) delivers it instead. The folder
  // must belong to THIS deal — a session can file more than one deal, and a
  // stale folder ref would land the file in the previous deal's workspace.
  let taskDetail = item.label;
  const drive = s.data.drive;
  if (!cfg.mockDrive && drive?.folder_id && drive.deal_id === s.data.deal_id) {
    try {
      const { uploadStagedFile } = await import("@/lib/drive");
      const stamp = istTimestamp().replace(":", "");
      const driveId = await uploadStagedFile(
        drive.folder_id,
        `${stamp} ${item.key}--${safe}`,
        expected,
      );
      if (driveId) {
        await db.markLeadFileDelivered(s.id, expected, driveId);
        taskDetail = `${item.label} → Drive`;
      }
    } catch (err) {
      console.error(`immediate drive delivery failed session=${s.id} file=${safe}`, err);
      taskDetail = `${item.label} — staged, delivers with the handoff`;
    }
  }
  await noteTask(s.id, `Receive ${safe}`, "completed", taskDetail);
  const res = await orchestrator.handleUpload(s, item.key, safe);
  return NextResponse.json(res);
}

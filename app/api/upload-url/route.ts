/**
 * Step 1 of the upload flow: validate the file's name/extension/size against
 * the checklist item, then issue a short-lived signed upload URL. The file
 * itself NEVER passes through Vercel (≈4.5 MB body limit) — the browser PUTs
 * directly to Supabase Storage (or /api/mock-upload with the memory driver).
 */
import { NextRequest, NextResponse } from "next/server";

import { bucket, cfg } from "@/lib/config";
import { checkExtension, EMS_CHECKLIST } from "@/lib/flows";
import { clientKey, rateLimitOk } from "@/lib/ratelimit";
import { getDb } from "@/lib/supabase";
import { sanitizeFilename } from "@/lib/util";

export async function POST(req: NextRequest) {
  if (!rateLimitOk(clientKey(req))) {
    return NextResponse.json({ detail: "too many requests — slow down a little" }, { status: 429 });
  }

  let body: { session_id?: string; item_key?: string; filename?: string; bytes?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "invalid JSON" }, { status: 400 });
  }

  const item = EMS_CHECKLIST.find((i) => i.key === body.item_key);
  if (!item) {
    return NextResponse.json({ detail: "unknown checklist item" }, { status: 400 });
  }

  const safe = sanitizeFilename(body.filename ?? "");
  const extError = checkExtension(item, safe);
  if (extError) {
    return NextResponse.json({ detail: extError }, { status: 415 });
  }

  const bytes = Number(body.bytes ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return NextResponse.json({ detail: "missing file size" }, { status: 400 });
  }
  if (bytes > cfg.maxUploadMb * 1024 * 1024) {
    return NextResponse.json(
      { detail: `File exceeds ${cfg.maxUploadMb} MB` },
      { status: 413 },
    );
  }

  const db = getDb();
  const s = body.session_id ? await db.getSession(body.session_id) : null;
  if (!s) {
    return NextResponse.json({ detail: "unknown session" }, { status: 404 });
  }

  const storage_path = `${s.id}/${item.key}--${safe}`;
  try {
    const { url, token } = await db.signedUploadUrl(storage_path);
    // signedUrl is the published contract name; url is kept as an alias.
    return NextResponse.json({ signedUrl: url, url, token, storage_path, filename: safe });
  } catch (err) {
    // Storage misconfiguration (bucket missing, bad creds) must read as a
    // clear service condition, not a blank 500 the visitor retries forever.
    console.error(`upload-url: storage unavailable (bucket "${bucket()}")`, err);
    return NextResponse.json(
      { detail: "Uploads are temporarily unavailable — skip this file for now; the team will collect it from you directly." },
      { status: 503 },
    );
  }
}

/**
 * Cron: sync the knowledge base from the Drive source folders into
 * kb_documents / kb_chunks (with embeddings). Re-extracts only files whose
 * modifiedTime changed since the last sync; files that disappeared from the
 * source folders are marked "removed".
 */
import { NextRequest, NextResponse } from "next/server";

import { cfg } from "@/lib/config";
import { exportKbFileText, listKbFiles } from "@/lib/drive";
import { embed, embeddingsAvailable } from "@/lib/embeddings";
import { getDb, type KbChunkInput } from "@/lib/supabase";

export const maxDuration = 300;

const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;
const EMBED_BATCH = 64;

/**
 * ~1500-char chunks split on paragraph boundaries: split on \n\n, pack
 * paragraphs greedily; a paragraph longer than the chunk size splits hard
 * with a 200-char overlap.
 */
function chunkText(text: string): string[] {
  const paragraphs = text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current) chunks.push(current);
    current = "";
  };
  for (const p of paragraphs) {
    if (p.length > CHUNK_SIZE) {
      flush();
      let start = 0;
      for (;;) {
        chunks.push(p.slice(start, start + CHUNK_SIZE));
        if (start + CHUNK_SIZE >= p.length) break;
        start += CHUNK_SIZE - CHUNK_OVERLAP;
      }
      continue;
    }
    if (current && current.length + 2 + p.length > CHUNK_SIZE) flush();
    current = current ? `${current}\n\n${p}` : p;
  }
  flush();
  return chunks;
}

/** Compare Drive's RFC3339 modifiedTime with the stored timestamp by value. */
function sameInstant(a: string | null, b: string | null): boolean {
  if (!a || !b) return a === b;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a === b;
  return ta === tb;
}

export async function POST(req: NextRequest) {
  if (!cfg.cronSecret) {
    return NextResponse.json({ detail: "CRON_SECRET is not configured" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${cfg.cronSecret}`) {
    return NextResponse.json({ detail: "unauthorized" }, { status: 401 });
  }
  if (cfg.mockDrive) {
    return NextResponse.json({ ok: false, reason: "MOCK_DRIVE" });
  }
  if (!embeddingsAvailable()) {
    return NextResponse.json({ ok: false, reason: "embeddings not configured" });
  }

  const files = await listKbFiles();
  const db = getDb();
  const existing = await db.kbListDocuments();
  const existingByDriveId = new Map(existing.map((d) => [d.drive_file_id, d]));

  let updated = 0;
  let skipped = 0;
  for (const f of files) {
    const prev = existingByDriveId.get(f.id);
    const doc = await db.kbUpsertDocument({
      drive_file_id: f.id,
      name: f.name,
      mime_type: f.mimeType || null,
      source_folder: f.sourceFolder,
      modified_at: f.modifiedTime || null,
    });
    const unchanged =
      prev?.synced_at && sameInstant(prev.modified_at, f.modifiedTime || null);
    if (unchanged) continue;

    try {
      const text = await exportKbFileText(f);
      if (!text || !text.trim()) {
        skipped++;
        continue;
      }
      const chunks = chunkText(text);
      const inputs: KbChunkInput[] = [];
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const batch = chunks.slice(i, i + EMBED_BATCH);
        const vectors = await embed(batch);
        batch.forEach((content, j) => {
          inputs.push({ chunk_no: i + j, content, embedding: vectors[j] });
        });
      }
      await db.kbReplaceChunks(doc.id, inputs);
      await db.kbSetSynced(doc.id);
      updated++;
    } catch (e) {
      skipped++;
      console.error(`kb sync: failed to process "${f.name}" (${f.id}):`, e);
    }
  }

  const listedIds = new Set(files.map((f) => f.id));
  const removedIds = existing
    .filter((d) => d.status === "active" && !listedIds.has(d.drive_file_id))
    .map((d) => d.drive_file_id);
  if (removedIds.length) await db.kbSetStatus(removedIds, "removed");

  return NextResponse.json({
    ok: true,
    documents: files.length,
    updated,
    skipped,
    removed: removedIds.length,
  });
}

// Vercel Cron invokes with GET (Authorization: Bearer CRON_SECRET is
// injected automatically when the env var exists); manual runs use POST.
export { POST as GET };

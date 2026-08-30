/**
 * The "brain" — lightweight, embeddings-free grounding for the chat LLM.
 *
 * Reads the company's own reference documents (SOPs etc.) straight out of
 * Google Drive, concatenates their text under per-doc/total caps, caches the
 * result in the settings store for an hour, and hands the prompt builders one
 * stable block of text. No routes, no cron, no vectors — and it NEVER
 * throws: any failure logs and falls back to the cached text (or "").
 *
 * Source folder, in order of preference (nothing is ever created):
 *   1. a Drive folder named exactly "XOR-Knowledge"
 *   2. otherwise the central "Eb-Central-ULM" folder
 */
import { cfg } from "@/lib/config";
import { exportKbFileText, type KbSourceFile } from "@/lib/drive";
import { ULM_HINT, search } from "@/lib/gtargets";
import { getDb } from "@/lib/supabase";

const BRAIN_FOLDER = "XOR-Knowledge";
const SETTINGS_KEY = "google:brain";
const TTL_MS = 60 * 60 * 1000; // refetch at most hourly
const PER_DOC_CHARS = 6000;
const TOTAL_CHARS = 24000;

const FOLDER_MIME = "application/vnd.google-apps.folder";
/** The text-bearing types exportKbFileText can extract. */
const TEXT_MIMES = new Set([
  "application/vnd.google-apps.document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/pdf",
  "text/plain",
  "text/markdown",
]);

interface BrainCache {
  text: string;
  fetched_at: string; // ISO timestamp of the successful fetch
}

async function readCache(): Promise<BrainCache | null> {
  try {
    const raw = await getDb().getSetting(SETTINGS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BrainCache;
    if (typeof parsed.text !== "string" || typeof parsed.fetched_at !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** One pull from Drive: discover the folder, extract every text-bearing doc. */
async function fetchBrainText(): Promise<string> {
  let folder = (await search(`name = '${BRAIN_FOLDER}' and mimeType = '${FOLDER_MIME}'`))[0];
  if (!folder) {
    folder = (await search(`name contains '${ULM_HINT}' and mimeType = '${FOLDER_MIME}'`))[0];
  }
  if (!folder) {
    console.warn(
      `xor brain: no "${BRAIN_FOLDER}" or "${ULM_HINT}" folder is visible — no brain context`,
    );
    return "";
  }

  // Newest 25 items of that folder (search appends `and trashed = false`).
  const files = await search(`'${folder.id}' in parents`);
  let out = "";
  for (const f of files) {
    if (out.length >= TOTAL_CHARS) break;
    if (!TEXT_MIMES.has(f.mimeType)) continue; // sub-folders, images, sheets…
    const src: KbSourceFile = {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      modifiedTime: "",
      sourceFolder: folder.id,
    };
    let text: string | null;
    try {
      text = await exportKbFileText(src);
    } catch (err) {
      console.error(`xor brain: extraction failed for "${f.name}" — skipping:`, err);
      continue;
    }
    if (!text?.trim()) continue;
    const piece = `\n\n### ${f.name}\n${text.trim().slice(0, PER_DOC_CHARS)}`;
    out += piece.slice(0, TOTAL_CHARS - out.length);
  }
  return out;
}

/** Fetch + cache; on failure log and serve the given fallback (never throw). */
async function refetch(fallback: string): Promise<string> {
  try {
    const text = await fetchBrainText();
    const entry: BrainCache = { text, fetched_at: new Date().toISOString() };
    try {
      await getDb().setSetting(SETTINGS_KEY, JSON.stringify(entry));
    } catch (err) {
      console.error("xor brain: cache write failed (continuing):", err);
    }
    return text;
  } catch (err) {
    console.error("xor brain: fetch failed — serving cached/empty context:", err);
    return fallback;
  }
}

/**
 * The company-document text for the system prompts. Real mode only (mock
 * modes and a missing service account return "" immediately); cached in the
 * settings store for an hour; never throws — a failed refresh serves the
 * last cached text, so the chat cannot break because of the brain.
 */
export async function brainContext(): Promise<string> {
  if (cfg.mockLlm || cfg.mockDrive || !cfg.googleServiceAccountB64) return "";
  const hit = await readCache();
  if (hit && Date.now() - Date.parse(hit.fetched_at) < TTL_MS) return hit.text;
  return refetch(hit?.text ?? "");
}

/** Same fetch, ignoring the TTL (for a future admin/cron refresh hook). */
export async function refreshBrain(): Promise<string> {
  if (cfg.mockLlm || cfg.mockDrive || !cfg.googleServiceAccountB64) return "";
  const hit = await readCache();
  return refetch(hit?.text ?? "");
}

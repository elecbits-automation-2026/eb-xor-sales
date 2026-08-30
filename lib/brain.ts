/**
 * The "brain" — lightweight, embeddings-free grounding for the chat LLM.
 *
 * Builds knowledge from the COMPLETE Drive the bot can see (ops directive:
 * no special folder required). Two name searches pick the docs: priority
 * hits (SOP / LLD / Charter / Checklist / Collateral / Register in the
 * name) and then the newest text documents overall; text is concatenated
 * under per-doc/total caps, cached in the settings store for an hour, and
 * handed to the prompt builders as one stable block. No routes, no cron,
 * no vectors — and it NEVER throws: any failure logs and falls back to the
 * cached text (or "").
 */
import { cfg } from "@/lib/config";
import { exportKbFileText, type KbSourceFile } from "@/lib/drive";
import { search } from "@/lib/gtargets";
import { getDb } from "@/lib/supabase";

const SETTINGS_KEY = "google:brain:v2"; // v2: whole-Drive crawl
const TTL_MS = 60 * 60 * 1000; // refetch at most hourly
const PER_DOC_CHARS = 5000;
const TOTAL_CHARS = 60000;
const MAX_DOCS = 18; // extraction time guard (health route has 30s)

/** The text-bearing types exportKbFileText can extract. */
const TEXT_MIMES = [
  "application/vnd.google-apps.document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/pdf",
  "text/plain",
  "text/markdown",
];
const TEXT_MIME_Q = `(${TEXT_MIMES.map((m) => `mimeType = '${m}'`).join(" or ")})`;
const PRIORITY_Q =
  "(name contains 'SOP' or name contains 'LLD' or name contains 'Charter' " +
  "or name contains 'Checklist' or name contains 'Collateral' or name contains 'Register')";

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

/**
 * One pull from Drive: priority-named documents first (SOPs, the LLD
 * reference library, sales collateral…), then the newest text documents
 * from anywhere in the visible Drive, de-duplicated, extracted under caps.
 */
async function fetchBrainText(): Promise<string> {
  const priority = await search(`${PRIORITY_Q} and ${TEXT_MIME_Q}`);
  const recent = await search(TEXT_MIME_Q);

  const seen = new Set<string>();
  const docs = [...priority, ...recent]
    .filter((f) => {
      if (seen.has(f.id)) return false;
      seen.add(f.id);
      return true;
    })
    .slice(0, MAX_DOCS);

  let out = "";
  for (const f of docs) {
    if (out.length >= TOTAL_CHARS) break;
    const src: KbSourceFile = {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      modifiedTime: "",
      sourceFolder: "",
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
  if (!out) console.warn("xor brain: no text documents visible — no brain context");
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

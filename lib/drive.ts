/**
 * Google Drive integration via a service account.
 *
 * Every finalized intake produces an account folder "<lead_ref> <company>"
 * under ACCOUNTS_PARENT_FOLDER_ID with the standard sub-folders, and the
 * customer's uploads + intake summary (+ LLD draft) land in 00-Intake/.
 * Also: template links for the chat, and the KB source-folder walker used by
 * the /api/kb/sync cron.
 *
 * Setup: create a service account, enable the Drive + Sheets APIs, and share
 * the accounts parent folder AND the funnel spreadsheet with the service
 * account's client_email as Editor. supportsAllDrives is set on every call so
 * Shared Drives work too.
 */
import { Readable } from "stream";

import { google, type drive_v3, type sheets_v4 } from "googleapis";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

import { ACCOUNT_SUBFOLDERS, cfg } from "@/lib/config";
import { getDb } from "@/lib/supabase";

const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
];

const FOLDER_MIME = "application/vnd.google-apps.folder";
const GDOC_MIME = "application/vnd.google-apps.document";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// ── lazy singletons (never constructed at import time) ────────────────────
function buildAuth() {
  const b64 = cfg.googleServiceAccountB64;
  if (!b64) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_B64 is not set — cannot talk to Google Drive/Sheets",
    );
  }
  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
  } catch {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_B64 is not valid base64-encoded service-account JSON",
    );
  }
  // With GOOGLE_IMPERSONATED_USER set (Workspace domain-wide delegation),
  // every Drive/Sheets call runs AS that user — full access to whatever the
  // user can see, and created files belong to them, not the service account.
  const subject = cfg.googleImpersonatedUser;
  return new google.auth.GoogleAuth({
    credentials,
    scopes: SCOPES,
    ...(subject ? { clientOptions: { subject } } : {}),
  });
}

let googleAuth: ReturnType<typeof buildAuth> | null = null;
let driveClient: drive_v3.Drive | null = null;
let sheetsClient: sheets_v4.Sheets | null = null;

function auth() {
  if (!googleAuth) googleAuth = buildAuth();
  return googleAuth;
}

function drive(): drive_v3.Drive {
  if (!driveClient) driveClient = google.drive({ version: "v3", auth: auth() });
  return driveClient;
}

/** Shared Sheets v4 client (used by lib/sheets.ts). */
export function sheets(): sheets_v4.Sheets {
  if (!sheetsClient) sheetsClient = google.sheets({ version: "v4", auth: auth() });
  return sheetsClient;
}

// ── folders + uploads ─────────────────────────────────────────────────────
function escapeQuery(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Find-or-create, so a replayed handoff (retry cron) converges on ONE
 * "<lead_ref> <Company>" tree instead of creating duplicates.
 */
async function ensureFolder(name: string, parent: string): Promise<string> {
  const existing = await drive().files.list({
    q:
      `name='${escapeQuery(name)}' and '${escapeQuery(parent)}' in parents ` +
      `and mimeType='${FOLDER_MIME}' and trashed=false`,
    fields: "files(id)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const found = existing.data.files?.[0]?.id;
  if (found) return found;
  const res = await drive().files.create({
    requestBody: { name, mimeType: FOLDER_MIME, parents: [parent] },
    fields: "id",
    supportsAllDrives: true,
  });
  const id = res.data.id;
  if (!id) throw new Error(`drive: folder create returned no id for "${name}"`);
  return id;
}

/** Names already present in a folder — replays skip files that landed. */
async function listChildNames(parent: string): Promise<Set<string>> {
  const names = new Set<string>();
  let pageToken: string | undefined;
  do {
    const res = await drive().files.list({
      q: `'${escapeQuery(parent)}' in parents and trashed=false`,
      fields: "nextPageToken, files(name)",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files ?? []) if (f.name) names.add(f.name);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return names;
}

async function uploadBytes(
  parent: string,
  name: string,
  bytes: Uint8Array,
  mimeType: string,
): Promise<string> {
  const res = await drive().files.create({
    requestBody: { name, parents: [parent] },
    media: { mimeType, body: Readable.from(Buffer.from(bytes)) },
    fields: "id",
    supportsAllDrives: true,
  });
  const id = res.data.id;
  if (!id) throw new Error(`drive: upload returned no id for "${name}"`);
  return id;
}

export interface HandoffFileRef {
  storage_path: string;
  filename: string;
}

export interface DriveHandoffPayload {
  lead_ref: string;
  company: string;
  files: HandoffFileRef[];
  summary_md: string;
  lld: { filename: string; storage_path: string } | null;
}

export interface DriveResult {
  folder_id: string;
  folder_url: string;
  file_ids: Record<string, string>;
}

/**
 * Create the account folder tree and place every intake artifact in
 * 00-Intake/. A missing storage object is logged and skipped — one lost file
 * must not sink the whole handoff.
 */
export async function driveHandoff(p: DriveHandoffPayload): Promise<DriveResult> {
  const parent = cfg.accountsParentFolderId;
  if (!parent) throw new Error("ACCOUNTS_PARENT_FOLDER_ID is not set");

  const rootId = await ensureFolder(`${p.lead_ref} ${p.company}`.trim(), parent);
  const subfolders: Record<string, string> = {};
  for (const sub of ACCOUNT_SUBFOLDERS) {
    subfolders[sub] = await ensureFolder(sub, rootId);
  }
  const intakeId = subfolders["00-Intake"];
  const already = await listChildNames(intakeId);

  const db = getDb();
  const fileIds: Record<string, string> = {};
  for (const f of p.files) {
    if (already.has(f.filename)) continue; // a previous attempt delivered it
    const bytes = await db.getObject(f.storage_path);
    if (!bytes) {
      console.error(
        `drive handoff ${p.lead_ref}: storage object missing for ${f.storage_path} — skipping "${f.filename}"`,
      );
      continue;
    }
    fileIds[f.filename] = await uploadBytes(
      intakeId,
      f.filename,
      bytes,
      "application/octet-stream",
    );
  }

  const summaryName = `${p.lead_ref}-intake-summary.md`;
  if (!already.has(summaryName)) {
    fileIds[summaryName] = await uploadBytes(
      intakeId,
      summaryName,
      Buffer.from(p.summary_md, "utf-8"),
      "text/markdown",
    );
  }

  if (p.lld && !already.has(p.lld.filename)) {
    const bytes = await db.getObject(p.lld.storage_path);
    if (!bytes) {
      console.error(
        `drive handoff ${p.lead_ref}: storage object missing for LLD ${p.lld.storage_path} — skipping "${p.lld.filename}"`,
      );
    } else {
      fileIds[p.lld.filename] = await uploadBytes(
        intakeId,
        p.lld.filename,
        bytes,
        "text/markdown",
      );
    }
  }

  return {
    folder_id: rootId,
    folder_url: `https://drive.google.com/drive/folders/${rootId}`,
    file_ids: fileIds,
  };
}

// ── templates the bot can offer ───────────────────────────────────────────
/** Nice-to-have links; must never break the chat — any failure returns []. */
export async function fetchTemplates(): Promise<{ name: string; url: string }[]> {
  if (cfg.mockDrive) {
    // Canned list so mock demos still show the "Handy templates" card
    // (parity with the Python reference's MockDrive).
    return [
      { name: "Level-wise BoM template", url: "#" },
      { name: "Supplier self-assessment", url: "#" },
      { name: "RFI FAQ", url: "#" },
    ];
  }
  const tid = cfg.templatesFolderId;
  if (!tid) return [];
  try {
    const res = await drive().files.list({
      q: `'${tid}' in parents and trashed=false`,
      fields: "files(id,name,webViewLink)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    return (res.data.files ?? []).map((f) => ({
      name: f.name ?? "(untitled)",
      url: f.webViewLink ?? "#",
    }));
  } catch (e) {
    console.error("fetchTemplates failed:", e);
    return [];
  }
}

// ── knowledge-base source walker ──────────────────────────────────────────
export interface KbSourceFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  sourceFolder: string;
}

/**
 * Recursively walk every KB source folder (subfolders included) and return
 * all non-folder files; sourceFolder is the top-level folder each came from.
 * The sentinel "root" (or "*") walks the ENTIRE My Drive of the acting
 * account — meaningful with GOOGLE_IMPERSONATED_USER; curate before using
 * it, since indexed content grounds a customer-facing bot.
 */
export async function listKbFiles(): Promise<KbSourceFile[]> {
  const out: KbSourceFile[] = [];
  for (const rawId of cfg.kbSourceFolderIds) {
    const topId = rawId === "*" ? "root" : rawId;
    const queue = [topId];
    while (queue.length) {
      const folderId = queue.shift()!;
      let pageToken: string | undefined;
      do {
        const res = await drive().files.list({
          q: `'${folderId}' in parents and trashed=false`,
          fields: "nextPageToken, files(id,name,mimeType,modifiedTime)",
          pageSize: 1000,
          pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        for (const f of res.data.files ?? []) {
          if (!f.id) continue;
          if (f.mimeType === FOLDER_MIME) {
            queue.push(f.id);
          } else {
            out.push({
              id: f.id,
              name: f.name ?? "(untitled)",
              mimeType: f.mimeType ?? "",
              modifiedTime: f.modifiedTime ?? "",
              sourceFolder: topId,
            });
          }
        }
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
    }
  }
  return out;
}

async function downloadBinary(fileId: string): Promise<Buffer> {
  const res = await drive().files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" },
  );
  return Buffer.from(res.data as unknown as ArrayBuffer);
}

/** Extract plain text from a KB file; null when the type is unsupported. */
export async function exportKbFileText(f: KbSourceFile): Promise<string | null> {
  if (f.mimeType === GDOC_MIME) {
    const res = await drive().files.export(
      { fileId: f.id, mimeType: "text/plain" },
      { responseType: "text" },
    );
    return String(res.data ?? "");
  }
  if (f.mimeType === "application/pdf") {
    const buf = await downloadBinary(f.id);
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }
  if (f.mimeType === DOCX_MIME) {
    const buf = await downloadBinary(f.id);
    const result = await mammoth.extractRawText({ buffer: buf });
    return result.value;
  }
  if (f.mimeType === "text/plain" || f.mimeType === "text/markdown") {
    const res = await drive().files.get(
      { fileId: f.id, alt: "media", supportsAllDrives: true },
      { responseType: "text" },
    );
    return String(res.data ?? "");
  }
  return null;
}

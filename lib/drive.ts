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
// NOTE: pdf-parse is imported lazily inside exportKbFileText — its pdfjs
// core touches browser globals (DOMMatrix) at load time, which crashes any
// serverless route that merely imports this module (e.g. Google discovery).

import { ACCOUNT_SUBFOLDERS, cfg } from "@/lib/config";
import { getDb } from "@/lib/supabase";

const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
];

const FOLDER_MIME = "application/vnd.google-apps.folder";
const GDOC_MIME = "application/vnd.google-apps.document";
export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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
/** The Drive API client — exported for the name-discovery layer (gtargets). */
export function driveApi(): drive_v3.Drive {
  return drive();
}

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

/**
 * Prove the acting identity can create FILE CONTENT (not just folders) in
 * the accounts tree. This is exactly where a service account writing into a
 * personal My Drive dies: folders are 0-byte and succeed, anything carrying
 * bytes is refused (no storage quota of its own) — so the register fills and
 * folders appear while every upload "mysteriously" fails. Creates + deletes
 * a tiny probe file; returns null on success or the verbatim Google error.
 */
export async function driveWriteProbe(): Promise<string | null> {
  const { resolveAccountsFolder } = await import("./gtargets");
  const parent = (await resolveAccountsFolder()).id;
  try {
    const id = await uploadBytes(
      parent,
      "xor-write-probe.txt",
      Buffer.from("XOR write probe — safe to delete", "utf-8"),
      "text/plain",
    );
    await drive()
      .files.delete({ fileId: id, supportsAllDrives: true })
      .catch(() => undefined);
    return null;
  } catch (err) {
    return String(err).slice(0, 500);
  }
}

export interface HandoffFileRef {
  storage_path: string;
  filename: string;
}

export interface DriveHandoffPayload {
  lead_ref: string;
  /** EbZ-<client_code>-NN — names the deal folder. */
  deal_id?: string | null;
  /** PL03-001 — names the client folder ("<client_code> <Company>"). */
  client_code?: string | null;
  /** Known client folder id (reused; skips the find-or-create lookup). */
  client_folder_id?: string | null;
  company: string;
  files: HandoffFileRef[];
  summary_md: string;
  lld: { filename: string; storage_path: string } | null;
  /**
   * Capture timestamp ("YYYY-MM-DD HHmm" IST), computed once at finalize and
   * carried in the payload so a retried handoff writes the SAME names
   * (skip-existing idempotency). Prefixes the generated summary; the
   * orchestrator already prefixes files/lld with it.
   */
  stamp?: string | null;
}

export interface DriveResult {
  client_folder_id: string | null;
  client_folder_url: string | null;
  /** The DEAL folder — where this enquiry's artifacts live. */
  folder_id: string;
  folder_url: string;
  file_ids: Record<string, string>;
}

/**
 * Create the client → deal folder hierarchy and place every intake artifact
 * in the deal's 00-Intake/:
 *
 *   <accounts parent>/"<client_code> <Company>"/<deal_id>/00-Intake…
 *
 * This structure exists BEFORE any downstream (ULM) process picks the lead
 * up. Legacy payloads without client_code fall back to the old flat
 * "<lead_ref> <Company>" layout so queued retries keep working. A missing
 * storage object is logged and skipped — one lost file must not sink the
 * whole handoff.
 */
/**
 * SOP layout (Law 5: folder = the ID alone): client folder EB-C-YY-nnnn in
 * the Sales container, deal folder EB-C-…-Dss inside it — a LIGHT folder with
 * no blueprint tree; the full project tree belongs to the project ULM opens
 * at sanction, never to the deal. Find-or-create throughout, so the early
 * (mid-chat) provisioning and the finalize handoff converge on ONE tree.
 */
export async function provisionDealFolders(p: {
  client_code: string;
  deal_id: string;
  client_folder_id?: string | null;
}): Promise<{
  client_folder_id: string;
  client_folder_url: string;
  folder_id: string;
  folder_url: string;
}> {
  const { resolveAccountsFolder } = await import("./gtargets");
  const parent = (await resolveAccountsFolder()).id;
  const clientFolderId = p.client_folder_id ?? (await ensureFolder(p.client_code, parent));
  const folderId = await ensureFolder(p.deal_id, clientFolderId);
  return {
    client_folder_id: clientFolderId,
    client_folder_url: `https://drive.google.com/drive/folders/${clientFolderId}`,
    folder_id: folderId,
    folder_url: `https://drive.google.com/drive/folders/${folderId}`,
  };
}

/**
 * Deliver ONE staged upload into a deal folder right when it arrives
 * (skip-existing, so finalize replays stay idempotent). Returns the Drive
 * file id, or null when the object is missing/already delivered.
 */
/**
 * Create a document in a Drive folder, or push a NEW VERSION onto an
 * existing one (same file id, Drive keeps version history) — how the living
 * LLD/benchmark DOCX stays a single file through revisions. A stale id
 * (file trashed/deleted by a human) falls back to a fresh create.
 */
export async function uploadOrUpdateDoc(
  folderId: string,
  existingFileId: string | null,
  name: string,
  bytes: Buffer,
  mimeType: string,
): Promise<string> {
  if (existingFileId) {
    try {
      await drive().files.update({
        fileId: existingFileId,
        media: { mimeType, body: Readable.from(bytes) },
        supportsAllDrives: true,
      });
      return existingFileId;
    } catch (err) {
      console.error(`doc version update failed (${name}) — creating fresh`, err);
    }
  }
  return uploadBytes(folderId, name, bytes, mimeType);
}

export async function uploadStagedFile(
  folderId: string,
  name: string,
  storagePath: string,
): Promise<string | null> {
  const already = await listChildNames(folderId);
  if (already.has(name)) return null;
  const bytes = await getDb().getObject(storagePath);
  if (!bytes) {
    console.error(`drive: storage object missing for ${storagePath} — skipping "${name}"`);
    return null;
  }
  return uploadBytes(folderId, name, bytes, "application/octet-stream");
}

export async function driveHandoff(p: DriveHandoffPayload): Promise<DriveResult> {
  const { resolveAccountsFolder } = await import("./gtargets");
  const parent = (await resolveAccountsFolder()).id;

  let clientFolderId: string | null = null;
  let rootId: string;
  let intakeId: string;
  if (p.client_code) {
    const refs = await provisionDealFolders({
      client_code: p.client_code,
      deal_id: p.deal_id ?? p.lead_ref,
      client_folder_id: p.client_folder_id,
    });
    clientFolderId = refs.client_folder_id;
    rootId = refs.folder_id;
    intakeId = rootId;
  } else {
    // Legacy layout for handoff payloads queued before the SOP alignment.
    rootId = await ensureFolder(`${p.lead_ref} ${p.company}`.trim(), parent);
    const subfolders: Record<string, string> = {};
    for (const sub of ACCOUNT_SUBFOLDERS) {
      subfolders[sub] = await ensureFolder(sub, rootId);
    }
    intakeId = subfolders["00-Intake"];
  }
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

  const summaryName = `${p.stamp ? `${p.stamp} ` : ""}${p.lead_ref}-intake-summary.md`;
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
        p.lld.filename.endsWith(".docx")
          ? DOCX_MIME
          : p.lld.filename.endsWith(".pdf")
            ? "application/pdf"
            : "text/markdown",
      );
    }
  }

  return {
    client_folder_id: clientFolderId,
    client_folder_url: clientFolderId
      ? `https://drive.google.com/drive/folders/${clientFolderId}`
      : null,
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

/** Text-bearing types the KB can extract (mirrors exportKbFileText). */
const KB_TEXT_MIMES = [GDOC_MIME, DOCX_MIME, "application/pdf", "text/plain", "text/markdown"];
const KB_WHOLE_DRIVE_MAX = 300;

/**
 * Zero-config source: every text-bearing file the acting account can SEE
 * (owned or shared), newest first, capped. This is what makes "the bot
 * studies the whole Drive" true without a single env var.
 */
async function listWholeDriveText(): Promise<KbSourceFile[]> {
  const q =
    `(${KB_TEXT_MIMES.map((m) => `mimeType = '${m}'`).join(" or ")}) and trashed = false`;
  const out: KbSourceFile[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive().files.list({
      q,
      orderBy: "modifiedTime desc",
      fields: "nextPageToken, files(id,name,mimeType,modifiedTime)",
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files ?? []) {
      if (!f.id) continue;
      out.push({
        id: f.id,
        name: f.name ?? "(untitled)",
        mimeType: f.mimeType ?? "",
        modifiedTime: f.modifiedTime ?? "",
        sourceFolder: "drive",
      });
      if (out.length >= KB_WHOLE_DRIVE_MAX) return out;
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

/**
 * Recursively walk every KB source folder (subfolders included) and return
 * all non-folder files; sourceFolder is the top-level folder each came from.
 * The sentinel "root" (or "*") walks the ENTIRE My Drive of the acting
 * account — meaningful with GOOGLE_IMPERSONATED_USER; curate before using
 * it, since indexed content grounds a customer-facing bot.
 *
 * With NO folders configured, the whole visible Drive's text documents are
 * the source (newest first, capped) — zero-config, like the rest of the
 * Google discovery.
 */
export async function listKbFiles(): Promise<KbSourceFile[]> {
  if (!cfg.kbSourceFolderIds.length) return listWholeDriveText();
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
    const { PDFParse } = await import("pdf-parse");
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

// ─────────────── house LLD templates (Sales Collateral / LLD) ──────────────
// The LLD generator mirrors the REAL Elecbits LLD templates — structure,
// headings, tone — not an invented shape. They live in Drive under
// "Sales Collateral / LLD"; cached in settings so generation never waits on
// a cold Drive walk twice in the same window.

const LLD_TPL_KEY = "kb:lld_templates";
const LLD_TPL_TTL_MS = 6 * 3_600_000;

async function findLldTemplateFolder(): Promise<string | null> {
  const d = drive();
  const shared = { supportsAllDrives: true, includeItemsFromAllDrives: true } as const;
  // "contains", not "=": the house convention prefixes folders with numbers
  // ("Eb-07-Sales", "01-Accounts"), so "Sales Collateral" may really be
  // "03-Sales-Collateral" — and Drive's contains matches word prefixes.
  const sc = await d.files.list({
    q: `name contains 'Collateral' and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: "files(id,name)",
    pageSize: 10,
    ...shared,
  });
  for (const f of sc.data.files ?? []) {
    if (!f.id) continue;
    const kid = await d.files.list({
      q: `'${f.id}' in parents and name contains 'LLD' and mimeType = '${FOLDER_MIME}' and trashed = false`,
      fields: "files(id,name)",
      pageSize: 5,
      ...shared,
    });
    const hit = kid.data.files?.find((k) => k.id);
    if (hit?.id) return hit.id;
  }
  // Fallback: any folder with LLD in its name — prefer the plainest match.
  const any = await d.files.list({
    q: `name contains 'LLD' and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: "files(id,name)",
    pageSize: 10,
    ...shared,
  });
  const folders = (any.data.files ?? []).filter((f) => f.id);
  folders.sort((a, b) => (a.name?.length ?? 99) - (b.name?.length ?? 99));
  return folders[0]?.id ?? null;
}

async function fetchLldTemplatesUncached(): Promise<string> {
  const folderId = await findLldTemplateFolder();
  if (!folderId) return "";
  const kids = await drive().files.list({
    q: `'${folderId}' in parents and trashed = false`,
    orderBy: "modifiedTime desc",
    fields: "files(id,name,mimeType,modifiedTime)",
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const parts: string[] = [];
  for (const f of kids.data.files ?? []) {
    if (!f.id || f.mimeType === FOLDER_MIME) continue;
    try {
      const text = await exportKbFileText({
        id: f.id,
        name: f.name ?? "(untitled)",
        mimeType: f.mimeType ?? "",
        modifiedTime: f.modifiedTime ?? "",
        sourceFolder: "lld-templates",
      });
      if (text && text.trim().length > 400) {
        parts.push(`--- TEMPLATE: ${f.name} ---\n${text.trim().slice(0, 15_000)}`);
      }
    } catch (err) {
      console.error(`LLD template read failed: ${f.name}`, err);
    }
    if (parts.length >= 2) break; // two complete house templates is plenty
  }
  return parts.join("\n\n").slice(0, 30_000);
}

/** House LLD template text, settings-cached 6h; "" when unavailable. */
export async function lldTemplatesText(): Promise<string> {
  if (cfg.mockDrive) return "";
  const db = getDb();
  let stale = "";
  try {
    const cached = await db.getSetting(LLD_TPL_KEY);
    if (cached) {
      const { at, text } = JSON.parse(cached) as { at: number; text: string };
      stale = text ?? "";
      if (stale && Date.now() - at < LLD_TPL_TTL_MS) return stale;
    }
  } catch {
    // unreadable cache — refetch below
  }
  try {
    const text = await fetchLldTemplatesUncached();
    if (text) {
      await db
        .setSetting(LLD_TPL_KEY, JSON.stringify({ at: Date.now(), text }))
        .catch(() => undefined);
      return text;
    }
    return stale; // an empty walk never clobbers a known-good template
  } catch (err) {
    console.error("LLD template fetch failed — using cached/none", err);
    return stale;
  }
}

/**
 * Zero-config Google wiring — the bot finds its own anchors.
 *
 * The three Google anchors the pipeline needs are resolved BY NAME at
 * runtime, so the only required Google env var is the service-account key:
 *
 *   - the Eb-Master Register — a native Google Sheet whose name contains
 *     "Eb-Master_Register", with the SOP "Clients" and "Deals" tabs
 *   - the accounts parent folder — "Eb-07-Sales", created inside the
 *     central "Eb-Central-ULM" folder when it doesn't exist yet
 *   - the funnel spreadsheet — "XOR-Sales-Funnel", created when missing
 *
 * Resolution order: explicit env ID (always wins) → binding cached in the
 * db settings store (stable across deploys and renames) → name discovery
 * over everything the service account / impersonated user can see, newest
 * modified first. /api/health reports what got bound, so a wrong pick is
 * visible and can be overridden by setting the env var.
 */
import { cfg } from "./config";
import { driveApi, sheets } from "./drive";
import { getDb } from "./supabase";

const REGISTER_HINT = "Eb-Master_Register";
/** Central folder hint — shared with the Drive-doc brain (lib/brain.ts). */
export const ULM_HINT = "Eb-Central-ULM";
const SALES_FOLDER = "Eb-07-Sales";
const FUNNEL_NAME = "XOR-Sales-Funnel";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface Binding {
  id: string;
  name: string;
  /** true when the bot created the item itself (folder / funnel sheet). */
  created?: boolean;
}

// ── settings-store cache (best-effort; discovery still works without it) ──
async function cached(key: string): Promise<Binding | null> {
  try {
    const raw = await getDb().getSetting(key);
    return raw ? (JSON.parse(raw) as Binding) : null;
  } catch {
    return null;
  }
}

async function remember(key: string, b: Binding): Promise<void> {
  try {
    await getDb().setSetting(key, JSON.stringify(b));
  } catch (err) {
    console.error(`google binding cache write failed (${key})`, err);
  }
}

interface DriveHit {
  id: string;
  name: string;
  mimeType: string;
}

/**
 * Name search over everything the bot's identity can see, newest first
 * (`and trashed = false` is appended). Also used by lib/brain.ts.
 */
export async function search(q: string): Promise<DriveHit[]> {
  const res = await driveApi().files.list({
    q: `${q} and trashed = false`,
    fields: "files(id, name, mimeType, modifiedTime)",
    orderBy: "modifiedTime desc",
    pageSize: 25,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
  });
  return (res.data.files ?? []) as DriveHit[];
}

// ── the register ──────────────────────────────────────────────────────────
export async function resolveRegister(): Promise<Binding> {
  if (cfg.masterRegisterSpreadsheetId) {
    return { id: cfg.masterRegisterSpreadsheetId, name: "(pinned by env)" };
  }
  const hit = await cached("google:register");
  if (hit) return hit;

  const files = await search(`name contains '${REGISTER_HINT}'`);
  const native = files.filter((f) => f.mimeType === SHEET_MIME);
  if (!native.length) {
    if (files.length) {
      throw new Error(
        `The register "${files[0].name}" is an Excel file — the Sheets API cannot write ` +
          `into .xlsx. Open it in Drive and use File → Save as Google Sheets; the bot ` +
          `picks up the converted sheet automatically on the next attempt.`,
      );
    }
    throw new Error(
      `No spreadsheet named like "${REGISTER_HINT}" is visible to the bot — share the ` +
        `central ULM folder (or the register itself) with the service account as Editor, ` +
        `or pin it with MASTER_REGISTER_SPREADSHEET_ID.`,
    );
  }

  const pick = native[0]; // newest modified — the live register, not an old draft
  const meta = await sheets().spreadsheets.get({
    spreadsheetId: pick.id,
    fields: "sheets(properties(title))",
  });
  const tabs = (meta.data.sheets ?? []).map((s) => s.properties?.title ?? "");
  for (const t of ["Clients", "Deals"]) {
    if (!tabs.includes(t)) {
      throw new Error(
        `Register "${pick.name}" has no "${t}" tab — expected the Eb-Master Register ` +
          `layout (tabs "Clients" and "Deals", headers on row 2).`,
      );
    }
  }

  const b: Binding = { id: pick.id, name: pick.name };
  await remember("google:register", b);
  console.info(`xor google: bound register → "${b.name}" (${b.id})`);
  return b;
}

// ── the accounts parent folder (client folders live here) ─────────────────
// v2 cache key: client folders bind to the "01-Accounts / Clients" subfolder
// INSIDE Eb-07-Sales (the sales tree keeps charters/pipeline as siblings),
// falling back to creating that subfolder when it doesn't exist yet.
const ACCOUNTS_KEY = "google:accounts_folder:v2";
const ACCOUNTS_SUBFOLDER = "01-Accounts / Clients";

async function createFolder(name: string, parent: string): Promise<string> {
  const created = await driveApi().files.create({
    requestBody: { name, mimeType: FOLDER_MIME, parents: [parent] },
    fields: "id",
    supportsAllDrives: true,
  });
  return created.data.id as string;
}

export async function resolveAccountsFolder(): Promise<Binding> {
  if (cfg.accountsParentFolderId) {
    return { id: cfg.accountsParentFolderId, name: "(pinned by env)" };
  }
  const hit = await cached(ACCOUNTS_KEY);
  if (hit) return hit;

  // 1. the Eb-07-Sales container (found, or created inside the ULM folder)
  let sales: { id: string; name: string };
  const existing = await search(`name = '${SALES_FOLDER}' and mimeType = '${FOLDER_MIME}'`);
  if (existing.length) {
    sales = existing[0];
  } else {
    const ulm = await search(`name contains '${ULM_HINT}' and mimeType = '${FOLDER_MIME}'`);
    if (!ulm.length) {
      throw new Error(
        `Neither an "${SALES_FOLDER}" folder nor the central "${ULM_HINT}" folder is ` +
          `visible to the bot — share the ULM folder with the service account as Editor, ` +
          `or pin a folder with ACCOUNTS_PARENT_FOLDER_ID.`,
      );
    }
    sales = { id: await createFolder(SALES_FOLDER, ulm[0].id), name: SALES_FOLDER };
    console.info(`xor google: created "${SALES_FOLDER}" inside "${ulm[0].name}"`);
  }

  // 2. client folders live in the Accounts subfolder, never at the root
  const children = await search(`'${sales.id}' in parents and mimeType = '${FOLDER_MIME}'`);
  let acct = children.find((c) => /accounts/i.test(c.name));
  let created = false;
  if (!acct) {
    acct = {
      id: await createFolder(ACCOUNTS_SUBFOLDER, sales.id),
      name: ACCOUNTS_SUBFOLDER,
      mimeType: FOLDER_MIME,
    };
    created = true;
  }
  const b: Binding = { id: acct.id, name: `${sales.name} / ${acct.name}`, created };
  await remember(ACCOUNTS_KEY, b);
  console.info(`xor google: bound accounts folder → "${b.name}" (${b.id})`);
  return b;
}

// ── the funnel spreadsheet ────────────────────────────────────────────────
export async function resolveFunnel(): Promise<Binding> {
  if (cfg.funnelSpreadsheetId) {
    return { id: cfg.funnelSpreadsheetId, name: "(pinned by env)" };
  }
  const hit = await cached("google:funnel");
  if (hit) return hit;

  const existing = await search(`name = '${FUNNEL_NAME}' and mimeType = '${SHEET_MIME}'`);
  if (existing.length) {
    const b: Binding = { id: existing[0].id, name: existing[0].name };
    await remember("google:funnel", b);
    console.info(`xor google: bound funnel → "${b.name}" (${b.id})`);
    return b;
  }

  // Create it, with the intake tab ready, next to the register (ULM folder
  // when visible, otherwise the accounts folder).
  const created = await sheets().spreadsheets.create({
    requestBody: {
      properties: { title: FUNNEL_NAME },
      sheets: [{ properties: { title: cfg.funnelSheetTab } }],
    },
    fields: "spreadsheetId",
  });
  const id = created.data.spreadsheetId as string;
  try {
    const ulm = await search(`name contains '${ULM_HINT}' and mimeType = '${FOLDER_MIME}'`);
    const parent = ulm.length ? ulm[0].id : (await resolveAccountsFolder()).id;
    await driveApi().files.update({ fileId: id, addParents: parent, supportsAllDrives: true });
  } catch (err) {
    console.error("funnel created but could not be filed into a folder", err);
  }
  const b: Binding = { id, name: FUNNEL_NAME, created: true };
  await remember("google:funnel", b);
  console.info(`xor google: created funnel sheet "${FUNNEL_NAME}" (${id})`);
  return b;
}

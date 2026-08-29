/**
 * Central configuration. Everything is env-driven (see .env.example); getters
 * read process.env at access time so tests can set env before importing.
 */

const truthy = new Set(["1", "true", "yes", "on"]);

function bool(name: string, dflt: boolean): boolean {
  const v = process.env[name];
  return v === undefined ? dflt : truthy.has(v.trim().toLowerCase());
}

function num(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
}

export const cfg = {
  // Modes — with both true, the whole app is demoable with no external keys.
  get mockLlm() {
    return bool("MOCK_LLM", true);
  },
  get mockDrive() {
    return bool("MOCK_DRIVE", true);
  },

  // LLM
  get anthropicApiKey() {
    return process.env.ANTHROPIC_API_KEY || "";
  },
  get model() {
    return process.env.XOR_BOT_MODEL || "claude-sonnet-4-5";
  },
  get triageConfidence() {
    return num("TRIAGE_CONFIDENCE", 0.75);
  },
  get maxProbeTurns() {
    return num("MAX_PROBE_TURNS", 3);
  },

  // Uploads
  get maxUploadMb() {
    return num("MAX_UPLOAD_MB", 50);
  },

  // Supabase (server-only; the browser never sees these)
  get supabaseUrl() {
    return process.env.SUPABASE_URL || "";
  },
  get supabaseServiceRoleKey() {
    return process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  },

  // Google (base64-encoded service-account JSON — never a file in the repo)
  get googleServiceAccountB64() {
    return process.env.GOOGLE_SERVICE_ACCOUNT_B64 || "";
  },
  /**
   * Optional Workspace user to impersonate via domain-wide delegation.
   * When set, the bot acts AS this user and can reach every folder that
   * user can (full-Drive access, no per-folder sharing); files it creates
   * are owned by this user, not the service account. Requires DWD to be
   * granted to the service account in the Google Admin console.
   */
  get googleImpersonatedUser() {
    return process.env.GOOGLE_IMPERSONATED_USER || "";
  },
  get accountsParentFolderId() {
    return process.env.ACCOUNTS_PARENT_FOLDER_ID || "";
  },
  get funnelSpreadsheetId() {
    return process.env.FUNNEL_SPREADSHEET_ID || "";
  },
  get funnelSheetTab() {
    return process.env.FUNNEL_SHEET_TAB || "XOR Intake";
  },
  get templatesFolderId() {
    return process.env.TEMPLATES_FOLDER_ID || "";
  },
  /**
   * The Eb-Master Register Google Sheet (lives in Eb-Central-ULM). The
   * register is the ISSUING AUTHORITY for every identifier (SOP Law 6: no
   * register row, no folder) — the bot writes Clients/Deals rows there
   * before creating anything in Drive.
   */
  get masterRegisterSpreadsheetId() {
    return process.env.MASTER_REGISTER_SPREADSHEET_ID || "";
  },

  // Knowledge base
  get kbSourceFolderIds(): string[] {
    return (process.env.KB_SOURCE_FOLDER_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  },
  get embeddingsProvider() {
    return process.env.EMBEDDINGS_PROVIDER || "openai";
  },
  get embeddingsApiKey() {
    return process.env.EMBEDDINGS_API_KEY || "";
  },
  get embeddingsModel() {
    return process.env.EMBEDDINGS_MODEL || "text-embedding-3-small";
  },
  get embeddingsDim() {
    return num("EMBEDDINGS_DIM", 1536);
  },

  // Cron auth
  get cronSecret() {
    return process.env.CRON_SECRET || "";
  },
} as const;

/**
 * All Postgres objects live in a dedicated schema so this app can share a
 * Supabase project with other Elecbits repos without name collisions.
 * The schema must be added to "Exposed schemas" in the Supabase API settings.
 */
export const DB_SCHEMA = "xor";

/** Supabase Storage bucket for customer uploads + generated artifacts. */
export function bucket(): string {
  return process.env.SUPABASE_BUCKET || "intake-uploads";
}

/** Sub-folders created inside every new Drive account folder. */
export const ACCOUNT_SUBFOLDERS = [
  "00-Intake",
  "01-Research",
  "02-MoM",
  "03-Contracts",
  "04-Quotes-Orders",
];

/** Columns of the funnel row (header auto-written if the tab is empty). */
export const FUNNEL_COLUMNS = [
  "Timestamp (IST)",
  "Lead ID",
  "Company",
  "Contact",
  "Email",
  "Phone",
  "Track",
  "Summary",
  "Quantity",
  "Timeline",
  "Files",
  "Drive Folder",
  "Source",
  "Stage",
];

export const TRACK_LABELS: Record<string, string> = {
  ODM: "New product design (ODM)",
  EMS: "Manufacturing (EMS)",
  PRODUCT: "Ready products",
};

/** Ready-product categories shown on the Product track (ids are stable). */
export const PRODUCT_CATEGORIES: [string, string][] = [
  ["iot", "IoT & smart devices"],
  ["it_hw", "IT hardware"],
  ["power", "Power electronics (supplies, adapters, chargers)"],
  ["epay", "E-payment devices (PoS, soundbox)"],
  ["ev", "EV electronics"],
  ["other", "Something else"],
];

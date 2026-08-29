/**
 * The Eb-Master Register — the issuing authority for every identifier
 * (Eb-SOP_Project-Creation-and-ID-Creation_v1.2).
 *
 * Law 6: no register row, no folder. The bot writes the Clients/Deals row
 * FIRST, then creates Drive folders, then writes the folder link back.
 *
 * Real mode targets the register Google Sheet (MASTER_REGISTER_SPREADSHEET_ID,
 * in Eb-Central-ULM). Serials are computed from the register itself — the
 * same source the registrar's Issuer script uses — and every issue is
 * verified after the append; on a duplicate (someone issued concurrently)
 * the bot corrects ITS OWN row to the next free serial, exactly as the SOP
 * instructs for the newer of two colliding rows.
 *
 * Register layout (v1.2): each tab has a title row (1), a header row (2),
 * data from row 3. Clients columns A..J:
 *   Client ID | Legacy ID | Organisation Name | Sector | Org Size | Status |
 *   Date Added | Added By | Point of Contact | Notes
 * Deals columns A..L:
 *   Deal ID | Client ID | Deal Name | Status | Deal Value | Currency |
 *   Deal Owner | Date Opened | Date Closed | Converted to Project ID |
 *   Loss Reason | Drive Folder Link
 *
 * Mock/offline mode (MOCK_DRIVE, or the register/creds not configured)
 * issues from the data layer's atomic counters so the whole flow — IDs
 * included — works with zero external services.
 */
import { cfg } from "./config";
import { dealIdFor, formatEbId } from "./flows";
import { getDb } from "./supabase";

const ADDED_BY = "XOR Bot";
const DATA_START_ROW = 3;

export interface IssueClientInput {
  company: string;
  sector: string;
  orgSize: string;
  contactName: string;
}

export interface Register {
  /** Writes the Clients-tab row and returns the new EB-C-YY-nnnn. */
  issueClient(input: IssueClientInput): Promise<string>;
  /** Writes the Deals-tab row (Status=Open) and returns the new EB-D-…-ss. */
  issueDeal(clientId: string, dealName: string): Promise<string>;
  /** Fills the Deals-tab Drive Folder Link column for an issued deal. */
  setDealFolderLink(dealId: string, url: string): Promise<void>;
}

/** Two-digit issue year, IST — matches the register's Current Year cell. */
function currentYY(): string {
  const year = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
  }).format(new Date());
  return year.slice(-2);
}

function todayISO(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// ── Sheets-backed register ────────────────────────────────────────────────
class SheetsRegister implements Register {
  private async values(range: string): Promise<string[][]> {
    const { sheets } = await import("./drive");
    const res = await sheets().spreadsheets.values.get({
      spreadsheetId: cfg.masterRegisterSpreadsheetId,
      range,
    });
    return (res.data.values ?? []) as string[][];
  }

  private async append(range: string, row: (string | number)[]): Promise<void> {
    const { sheets } = await import("./drive");
    await sheets().spreadsheets.values.append({
      spreadsheetId: cfg.masterRegisterSpreadsheetId,
      range,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    });
  }

  private async update(range: string, row: (string | number)[]): Promise<void> {
    const { sheets } = await import("./drive");
    await sheets().spreadsheets.values.update({
      spreadsheetId: cfg.masterRegisterSpreadsheetId,
      range,
      valueInputOption: "RAW",
      requestBody: { values: [row] },
    });
  }

  /**
   * Issue on a tab: compute next serial from the live column, append, then
   * re-read and — if a concurrent issuer took the same serial — repair OUR
   * row (the newest occurrence) to the next free one. Bounded retries.
   */
  private async issueWithRepair(
    tab: string,
    candidateFor: (ids: string[]) => string,
    rowFor: (id: string) => (string | number)[],
    idColWidth: string,
  ): Promise<string> {
    const colA = () =>
      this.values(`${tab}!A${DATA_START_ROW}:A`).then((rows) => rows.map((r) => r[0] ?? ""));

    let id = candidateFor(await colA());
    await this.append(`${tab}!A1:${idColWidth}1`, rowFor(id));

    for (let attempt = 0; attempt < 3; attempt++) {
      const ids = await colA();
      const dupes = ids.filter((v) => v === id);
      if (dupes.length <= 1) return id;
      // Concurrent issue took our serial. Ours is the NEWER row (last
      // occurrence) — per the SOP, correct the newer of the two.
      const ourRowIndex = ids.lastIndexOf(id) + DATA_START_ROW;
      id = candidateFor(ids.filter((_, i) => i !== ids.lastIndexOf(id)));
      await this.update(`${tab}!A${ourRowIndex}`, [id]);
    }
    throw new Error(`register: could not issue a unique id on ${tab} after retries`);
  }

  async issueClient(input: IssueClientInput): Promise<string> {
    const yy = currentYY();
    const prefix = `EB-C-${yy}-`;
    return this.issueWithRepair(
      "Clients",
      (ids) => {
        const max = ids
          .filter((v) => v.startsWith(prefix))
          .reduce((m, v) => Math.max(m, parseInt(v.slice(prefix.length), 10) || 0), 0);
        return formatEbId("C", yy, max + 1);
      },
      (id) => [
        id,
        "",
        input.company,
        input.sector,
        input.orgSize,
        "Active",
        todayISO(),
        ADDED_BY,
        input.contactName,
        "Created by the XOR intake bot",
      ],
      "J",
    );
  }

  async issueDeal(clientId: string, dealName: string): Promise<string> {
    const dealPrefix = `${clientId.replace(/^EB-C-/, "EB-D-")}-`;
    return this.issueWithRepair(
      "Deals",
      (ids) => {
        const max = ids
          .filter((v) => v.startsWith(dealPrefix))
          .reduce((m, v) => Math.max(m, parseInt(v.slice(dealPrefix.length), 10) || 0), 0);
        return dealIdFor(clientId, max + 1);
      },
      (id) => [id, clientId, dealName, "Open", "", "INR", ADDED_BY, todayISO(), "", "", "", ""],
      "L",
    );
  }

  async setDealFolderLink(dealId: string, url: string): Promise<void> {
    const ids = (await this.values(`Deals!A${DATA_START_ROW}:A`)).map((r) => r[0] ?? "");
    const idx = ids.indexOf(dealId);
    if (idx === -1) {
      throw new Error(`register: deal ${dealId} not found on the Deals tab`);
    }
    await this.update(`Deals!L${idx + DATA_START_ROW}`, [url]);
  }
}

// ── Offline register (mock mode / register not configured) ────────────────
class OfflineRegister implements Register {
  async issueClient(): Promise<string> {
    const yy = currentYY();
    const n = await getDb().nextSeq(`register:EB-C:${yy}`);
    return formatEbId("C", yy, n);
  }

  async issueDeal(clientId: string): Promise<string> {
    const n = await getDb().nextSeq(`register:EB-D:${clientId}`);
    return dealIdFor(clientId, n);
  }

  async setDealFolderLink(): Promise<void> {
    // no register to write back to
  }
}

let sheetsRegister: SheetsRegister | null = null;
const offlineRegister = new OfflineRegister();

export function registerConfigured(): boolean {
  return Boolean(
    !cfg.mockDrive && cfg.masterRegisterSpreadsheetId && cfg.googleServiceAccountB64,
  );
}

export function register(): Register {
  if (registerConfigured()) {
    if (!sheetsRegister) sheetsRegister = new SheetsRegister();
    return sheetsRegister;
  }
  return offlineRegister;
}

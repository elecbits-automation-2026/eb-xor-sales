/**
 * Zero-config Google discovery: the register/folder/funnel bindings resolve
 * by name, prefer native Google Sheets, validate the SOP tabs, create what's
 * missing, cache in the settings store, and honor env pins. Drive/Sheets
 * clients are mocked — no network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.MOCK_LLM = "true";
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.MASTER_REGISTER_SPREADSHEET_ID;
delete process.env.ACCOUNTS_PARENT_FOLDER_ID;
delete process.env.FUNNEL_SPREADSHEET_ID;

const filesList = vi.fn();
const filesCreate = vi.fn();
const filesUpdate = vi.fn();
const sheetsGet = vi.fn();
const sheetsCreate = vi.fn();

vi.mock("@/lib/drive", () => ({
  driveApi: () => ({ files: { list: filesList, create: filesCreate, update: filesUpdate } }),
  sheets: () => ({ spreadsheets: { get: sheetsGet, create: sheetsCreate } }),
}));

import { resolveAccountsFolder, resolveFunnel, resolveRegister } from "@/lib/gtargets";
import { resetMemoryDb } from "@/lib/supabase";

const SHEET = "application/vnd.google-apps.spreadsheet";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const FOLDER = "application/vnd.google-apps.folder";

function listReturns(...pages: { id: string; name: string; mimeType: string }[][]) {
  for (const files of pages) filesList.mockResolvedValueOnce({ data: { files } });
}

beforeEach(() => {
  resetMemoryDb();
  filesList.mockReset();
  filesCreate.mockReset();
  filesUpdate.mockReset();
  sheetsGet.mockReset();
  sheetsCreate.mockReset();
});

describe("register discovery", () => {
  it("picks the newest native sheet, validates tabs, and caches the binding", async () => {
    listReturns([
      { id: "live", name: "Eb-Master_Register_v2.0", mimeType: SHEET },
      { id: "old", name: "Eb-Master_Register_v1 draft", mimeType: XLSX },
    ]);
    sheetsGet.mockResolvedValue({
      data: { sheets: [{ properties: { title: "Clients" } }, { properties: { title: "Deals" } }] },
    });

    const b = await resolveRegister();
    expect(b.id).toBe("live");

    // second call comes from the settings cache — no new Drive search
    const again = await resolveRegister();
    expect(again.id).toBe("live");
    expect(filesList).toHaveBeenCalledTimes(1);
  });

  it("explains the .xlsx trap when only an Excel register exists", async () => {
    listReturns([{ id: "x", name: "Eb-Master_Register_v2.0.xlsx", mimeType: XLSX }]);
    await expect(resolveRegister()).rejects.toThrow(/Save as Google Sheets/);
  });

  it("rejects a sheet without the SOP tabs", async () => {
    listReturns([{ id: "s", name: "Eb-Master_Register_v2.0", mimeType: SHEET }]);
    sheetsGet.mockResolvedValue({ data: { sheets: [{ properties: { title: "Clients" } }] } });
    await expect(resolveRegister()).rejects.toThrow(/"Deals" tab/);
  });

  it("honors the env pin without touching Drive", async () => {
    process.env.MASTER_REGISTER_SPREADSHEET_ID = "pinned-id";
    try {
      const b = await resolveRegister();
      expect(b.id).toBe("pinned-id");
      expect(filesList).not.toHaveBeenCalled();
    } finally {
      delete process.env.MASTER_REGISTER_SPREADSHEET_ID;
    }
  });
});

describe("accounts folder discovery", () => {
  it("creates Eb-07-Sales inside the ULM folder when it doesn't exist", async () => {
    listReturns(
      [], // no Eb-07-Sales yet
      [{ id: "ulm", name: "Eb-Central-ULM ", mimeType: FOLDER }],
    );
    filesCreate.mockResolvedValue({ data: { id: "sales-folder" } });

    const b = await resolveAccountsFolder();
    expect(b).toMatchObject({ id: "sales-folder", name: "Eb-07-Sales", created: true });
    expect(filesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({ name: "Eb-07-Sales", parents: ["ulm"] }),
      }),
    );

    // cached thereafter
    await resolveAccountsFolder();
    expect(filesList).toHaveBeenCalledTimes(2);
  });

  it("binds an existing Eb-07-Sales directly", async () => {
    listReturns([{ id: "existing", name: "Eb-07-Sales", mimeType: FOLDER }]);
    const b = await resolveAccountsFolder();
    expect(b.id).toBe("existing");
    expect(filesCreate).not.toHaveBeenCalled();
  });
});

describe("funnel discovery", () => {
  it("creates the funnel with the intake tab and files it into the ULM folder", async () => {
    listReturns(
      [], // no XOR-Sales-Funnel yet
      [{ id: "ulm", name: "Eb-Central-ULM", mimeType: FOLDER }],
    );
    sheetsCreate.mockResolvedValue({ data: { spreadsheetId: "funnel-1" } });
    filesUpdate.mockResolvedValue({ data: { id: "funnel-1" } });

    const b = await resolveFunnel();
    expect(b).toMatchObject({ id: "funnel-1", created: true });
    expect(sheetsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          sheets: [{ properties: { title: "XOR Intake" } }],
        }),
      }),
    );
    expect(filesUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: "funnel-1", addParents: "ulm" }),
    );
  });
});

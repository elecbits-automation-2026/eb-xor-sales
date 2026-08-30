/**
 * The Drive-doc "brain" (lib/brain.ts): crawls the COMPLETE visible Drive
 * (priority-named docs first, then newest text docs), concatenates under the
 * per-doc/total caps, caches the result in the settings store for an hour,
 * never throws, and short-circuits to "" in mock mode. The prompt builders
 * inject the brain ahead of the volatile excerpts. Drive is mocked — no
 * network.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const SAVED_ENV = {
  MOCK_LLM: process.env.MOCK_LLM,
  MOCK_DRIVE: process.env.MOCK_DRIVE,
  GOOGLE_SERVICE_ACCOUNT_B64: process.env.GOOGLE_SERVICE_ACCOUNT_B64,
};
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const filesList = vi.fn();
const exportText = vi.fn();

vi.mock("@/lib/drive", () => ({
  driveApi: () => ({ files: { list: filesList } }),
  sheets: () => ({ spreadsheets: {} }),
  exportKbFileText: (f: unknown) => exportText(f),
}));

import { brainContext, refreshBrain } from "@/lib/brain";
import { SYSTEM_QA, SYSTEM_TRIAGE, buildQaSystem, buildTriageSystem } from "@/lib/prompts";
import { getDb, resetMemoryDb, type KbMatch } from "@/lib/supabase";

const GDOC = "application/vnd.google-apps.document";

function listReturns(...pages: { id: string; name: string; mimeType: string }[][]) {
  for (const files of pages) filesList.mockResolvedValueOnce({ data: { files } });
}

beforeEach(() => {
  resetMemoryDb();
  filesList.mockReset();
  exportText.mockReset();
  // Real mode — the brain is a no-op in mock mode / without a key.
  process.env.MOCK_LLM = "false";
  process.env.MOCK_DRIVE = "false";
  process.env.GOOGLE_SERVICE_ACCOUNT_B64 = Buffer.from("{}").toString("base64");
});

afterAll(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("brainContext", () => {
  it("merges priority-named docs with recent docs, de-duplicated, per-doc capped", async () => {
    listReturns(
      [
        { id: "sop", name: "Eb-SOP Project Setup", mimeType: GDOC },
        { id: "lld", name: "EbODM_LLDReferenceLibrary sample", mimeType: GDOC },
      ], // priority search
      [
        { id: "sop", name: "Eb-SOP Project Setup", mimeType: GDOC }, // duplicate
        { id: "big", name: "Big Handbook", mimeType: "text/plain" },
      ], // recent search
    );
    exportText.mockImplementation(async (f: { id: string }) =>
      f.id === "big" ? "x".repeat(10_000) : `body of ${f.id}`,
    );

    const text = await brainContext();
    expect(text).toContain("### Eb-SOP Project Setup\nbody of sop");
    expect(text).toContain("### EbODM_LLDReferenceLibrary sample\nbody of lld");
    // duplicate never re-exported; per-doc cap clips the handbook to 5000
    expect(exportText).toHaveBeenCalledTimes(3);
    expect(text.split("### Big Handbook\n")[1]).toHaveLength(5000);
    // both searches are name/mime queries over the whole visible Drive
    expect(filesList).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ q: expect.stringContaining("name contains 'SOP'") }),
    );
    expect(filesList).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ q: expect.stringContaining("mimeType = '") }),
    );
  });

  it("stops at the 60000-char total cap", async () => {
    listReturns(
      [],
      Array.from({ length: 15 }, (_, i) => ({ id: `d${i}`, name: `Doc-${i}`, mimeType: GDOC })),
    );
    exportText.mockResolvedValue("a".repeat(5000));

    const text = await brainContext();
    expect(text).toHaveLength(60_000);
    // the budget filled before the 13th doc — it is never even exported
    expect(exportText).toHaveBeenCalledTimes(12);
  });

  it("serves the cached text within the TTL without touching Drive again", async () => {
    listReturns([], [{ id: "sop", name: "Sales SOP", mimeType: GDOC }]);
    exportText.mockResolvedValue("SOP body.");

    const first = await brainContext();
    expect(first).toContain("### Sales SOP\nSOP body.");
    expect(filesList).toHaveBeenCalledTimes(2); // priority + recent

    const second = await brainContext();
    expect(second).toBe(first);
    expect(filesList).toHaveBeenCalledTimes(2); // cache hit — no new calls
  });

  it("returns empty immediately in mock mode or without a service account", async () => {
    process.env.MOCK_DRIVE = "true";
    expect(await brainContext()).toBe("");

    process.env.MOCK_DRIVE = "false";
    process.env.MOCK_LLM = "true";
    expect(await brainContext()).toBe("");

    process.env.MOCK_LLM = "false";
    process.env.GOOGLE_SERVICE_ACCOUNT_B64 = "";
    expect(await brainContext()).toBe("");

    expect(filesList).not.toHaveBeenCalled();
  });

  it("serves the stale cached text when the refresh fails — and never throws", async () => {
    const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await getDb().setSetting(
      "google:brain:v2",
      JSON.stringify({ text: "old brain", fetched_at: staleAt }),
    );
    filesList.mockRejectedValue(new Error("drive down"));

    expect(await brainContext()).toBe("old brain");
  });

  it("returns empty on failure when nothing is cached", async () => {
    filesList.mockRejectedValue(new Error("drive down"));
    expect(await brainContext()).toBe("");
  });

  it("refreshBrain refetches inside the TTL and updates the cache", async () => {
    listReturns([], [{ id: "sop", name: "Sales SOP", mimeType: GDOC }]);
    exportText.mockResolvedValue("v1");
    await brainContext();
    expect(filesList).toHaveBeenCalledTimes(2);

    listReturns([], [{ id: "sop", name: "Sales SOP", mimeType: GDOC }]);
    exportText.mockResolvedValue("v2");
    const refreshed = await refreshBrain();
    expect(refreshed).toContain("v2");
    expect(filesList).toHaveBeenCalledTimes(4);

    // the fresh text is what the TTL cache now serves
    expect(await brainContext()).toBe(refreshed);
    expect(filesList).toHaveBeenCalledTimes(4);
  });
});

describe("prompt wiring", () => {
  const chunk: KbMatch = { content: "CHUNK-TEXT", document_name: "Doc", similarity: 0.9 };

  it("leaves both prompts unchanged when the brain is empty", () => {
    expect(buildTriageSystem([], "")).toBe(SYSTEM_TRIAGE);
    expect(buildQaSystem([], "")).toBe(SYSTEM_QA);
  });

  it("injects the delimited brain section before the volatile excerpts", () => {
    for (const sys of [
      buildTriageSystem([chunk], "BRAIN-TEXT"),
      buildQaSystem([chunk], "BRAIN-TEXT"),
    ]) {
      expect(sys).toContain(
        "Company reference documents (internal SOPs — use for accurate answers, never quote IDs/pricing as promises):\nBRAIN-TEXT",
      );
      expect(sys.indexOf("BRAIN-TEXT")).toBeLessThan(sys.indexOf("CHUNK-TEXT"));
    }
    expect(buildQaSystem([], "BRAIN-TEXT")).toContain("BRAIN-TEXT");
  });
});

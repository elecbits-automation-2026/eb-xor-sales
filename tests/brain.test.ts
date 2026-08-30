/**
 * The Drive-doc "brain" (lib/brain.ts): discovers the XOR-Knowledge folder
 * (falling back to Eb-Central-ULM), concatenates text-bearing docs under the
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

const FOLDER = "application/vnd.google-apps.folder";
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
  it("concatenates the XOR-Knowledge docs with the per-doc cap", async () => {
    listReturns(
      [{ id: "kn", name: "XOR-Knowledge", mimeType: FOLDER }],
      [
        { id: "sop", name: "Sales SOP", mimeType: GDOC },
        { id: "big", name: "Big Handbook", mimeType: "text/plain" },
        { id: "logo", name: "logo.png", mimeType: "image/png" }, // filtered out
        { id: "sub", name: "Archive", mimeType: FOLDER }, // filtered out
      ],
    );
    exportText.mockImplementation(async (f: { id: string }) =>
      f.id === "sop" ? "Always issue EB-C codes from the register." : "x".repeat(10_000),
    );

    const text = await brainContext();
    expect(text).toContain("### Sales SOP\nAlways issue EB-C codes from the register.");
    // per-doc cap: the 10k-char handbook is clipped to 6000
    expect(text.split("### Big Handbook\n")[1]).toHaveLength(6000);
    // non-text types are never exported
    expect(exportText).toHaveBeenCalledTimes(2);
    // children come from the discovered folder, newest first
    expect(filesList).toHaveBeenLastCalledWith(
      expect.objectContaining({
        q: expect.stringContaining("'kn' in parents"),
        orderBy: "modifiedTime desc",
      }),
    );
  });

  it("stops at the 24000-char total cap", async () => {
    listReturns(
      [{ id: "kn", name: "XOR-Knowledge", mimeType: FOLDER }],
      [1, 2, 3, 4, 5].map((n) => ({ id: `d${n}`, name: `Doc-${n}`, mimeType: GDOC })),
    );
    exportText.mockResolvedValue("a".repeat(6000));

    const text = await brainContext();
    expect(text).toHaveLength(24_000);
    // the budget was full before the 5th doc — it is never even exported
    expect(exportText).toHaveBeenCalledTimes(4);
    expect(text).not.toContain("Doc-5");
  });

  it("serves the cached text within the TTL without touching Drive again", async () => {
    listReturns(
      [{ id: "kn", name: "XOR-Knowledge", mimeType: FOLDER }],
      [{ id: "sop", name: "Sales SOP", mimeType: GDOC }],
    );
    exportText.mockResolvedValue("SOP body.");

    const first = await brainContext();
    expect(first).toContain("### Sales SOP\nSOP body.");
    expect(filesList).toHaveBeenCalledTimes(2); // folder search + children

    const second = await brainContext();
    expect(second).toBe(first);
    expect(filesList).toHaveBeenCalledTimes(2); // cache hit — no new calls
  });

  it("falls back to the Eb-Central-ULM folder when XOR-Knowledge is absent", async () => {
    listReturns(
      [], // no XOR-Knowledge folder
      [{ id: "ulm", name: "Eb-Central-ULM", mimeType: FOLDER }],
      [{ id: "c", name: "Central SOP", mimeType: GDOC }],
    );
    exportText.mockResolvedValue("Central body.");

    const text = await brainContext();
    expect(text).toContain("### Central SOP\nCentral body.");
    expect(filesList).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ q: expect.stringContaining("'ulm' in parents") }),
    );
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
      "google:brain",
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
    listReturns(
      [{ id: "kn", name: "XOR-Knowledge", mimeType: FOLDER }],
      [{ id: "sop", name: "Sales SOP", mimeType: GDOC }],
    );
    exportText.mockResolvedValue("v1");
    await brainContext();
    expect(filesList).toHaveBeenCalledTimes(2);

    listReturns(
      [{ id: "kn", name: "XOR-Knowledge", mimeType: FOLDER }],
      [{ id: "sop", name: "Sales SOP", mimeType: GDOC }],
    );
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

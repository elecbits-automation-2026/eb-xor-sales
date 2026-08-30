/**
 * Full ODM two-outcome journey in mock mode — Outcome A (Product Definition
 * & Benchmark Report) iterated and locked, then Outcome B (LLD) iterated and
 * filed. One continuous session driven through the real route handlers;
 * asserts every state hop, both PDF deliverables via /api/download, the
 * review-chip changes after the bench is locked, and the DB side-effects
 * (deal/lead identity, tasks feed, drive retry payload) on the memory driver.
 */
import { beforeEach, describe, expect, it } from "vitest";

process.env.MOCK_LLM = "true";
process.env.MOCK_DRIVE = "true";
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { NextRequest } from "next/server";

import { POST as chatPost } from "@/app/api/chat/route";
import { GET as downloadGet } from "@/app/api/download/[session]/[file]/route";
import { getDb, resetMemoryDb, type HandoffRetryRow } from "@/lib/supabase";
import type { ChatIn, ChatOut, Widget } from "@/lib/widgets";

let ipCounter = 0;
let ip = "10.7.0.1";

function jsonReq(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://test${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
  });
}

async function chat(payload: Partial<ChatIn>): Promise<ChatOut> {
  const res = await chatPost(jsonReq("/api/chat", "POST", payload));
  expect(res.status).toBe(200);
  return (await res.json()) as ChatOut;
}

type CardWidget = Extract<Widget, { type: "card" }>;
type ChipsWidget = Extract<Widget, { type: "chips" }>;

function cards(res: ChatOut): CardWidget[] {
  return res.widgets.filter((w): w is CardWidget => w.type === "card");
}

function chipIds(res: ChatOut): string[] {
  return res.widgets
    .filter((w): w is ChipsWidget => w.type === "chips")
    .flatMap((w) => w.options.map((o) => o.id));
}

function downloadLinks(res: ChatOut): { label: string; url: string }[] {
  return cards(res)
    .flatMap((w) => w.links)
    .filter((l) => l.url.includes("/api/download/"));
}

/** Fetch a /api/download/<session>/<file> link through the real handler. */
async function download(url: string): Promise<Response> {
  const [, , sessionPart, filePart] = new URL(`http://test${url}`).pathname
    .split("/")
    .filter(Boolean);
  return downloadGet(new NextRequest(`http://test${url}`), {
    params: Promise.resolve({ session: sessionPart, file: filePart }),
  });
}

async function expectPdf(url: string): Promise<Buffer> {
  const dl = await download(url);
  expect(dl.status).toBe(200);
  expect(dl.headers.get("content-type")).toBe("application/pdf");
  const body = Buffer.from(await dl.arrayBuffer());
  expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(body.length).toBeGreaterThan(1000);
  return body;
}

const CONTACT = {
  name: "Priya Raghavan",
  company: "TrackSense Labs",
  email: "priya@tracksense.in",
  phone: "+91 9812345678",
};

const SLOT_ANSWERS = [
  "a BLE asset-tracking beacon for warehouse pallets and crates",
  "BLE 5.2, accelerometer motion wake, 2-year coin-cell battery life, IP65 housing",
  "10k units pilot run, then around 100k per year",
  "under Rs 600 per unit at volume",
  "working prototypes in 10 weeks, production by next quarter",
  "India first then EU — BIS for sure, CE next, maybe FCC later",
  "similar to Tile Pro and the Minew E8, we also have an old internal spec doc",
];

// The journey is one continuous session: state (sid / latest response) is
// shared across the sequential tests below. Only the FIRST test resets the
// db; each test gets its own IP so the per-IP token bucket never trips.
let sid = "";
let cur: ChatOut;

beforeEach(() => {
  ip = `10.7.0.${++ipCounter}`;
});

describe("ODM two-outcome journey (bench → LLD → DONE)", () => {
  it("locks the ODM track through contact, sector and org size", async () => {
    resetMemoryDb();
    const opened = await chat({ kind: "open" });
    expect(opened.meta.state).toBe("DISCOVER");
    expect(opened.widgets[0].type).toBe("chips");
    sid = opened.session_id;

    cur = await chat({
      session_id: sid,
      kind: "text",
      text: "we have an idea for a new product — design and develop a BLE asset tracker from scratch",
    });
    expect(cur.meta.state).toBe("TRACK_CONFIRM");
    expect(cur.meta.track).toBeNull(); // not locked until confirmed

    cur = await chat({ session_id: sid, kind: "chip", chip_id: "confirm:yes" });
    expect(cur.meta.state).toBe("CONTACT");
    expect(cur.meta.track).toBe("ODM");

    cur = await chat({
      session_id: sid,
      kind: "form",
      form: { form_id: "contact", values: CONTACT },
    });
    // New client → the two register company questions.
    expect(cur.meta.state).toBe("CLIENT_INDUSTRY");
    expect(chipIds(cur)).toContain("sec:4"); // IoT & Connected Devices

    cur = await chat({ session_id: sid, kind: "chip", chip_id: "sec:4" });
    expect(cur.meta.state).toBe("CLIENT_ORGSIZE");
    expect(chipIds(cur)).toContain("org:0");

    cur = await chat({ session_id: sid, kind: "chip", chip_id: "org:0" });
    expect(cur.meta.state).toBe("ODM_SLOTS");
    // Identity-first: the deal is filed before the questions start.
    expect(cur.messages.join(" ")).toMatch(/Filed as EB-C-\d{2}-\d{4}-D\d{2}/);
  });

  it("answers all seven slots with realistic text to reach ODM_REVIEW", async () => {
    for (const answer of SLOT_ANSWERS) {
      expect(cur.meta.state).toBe("ODM_SLOTS");
      cur = await chat({ session_id: sid, kind: "text", text: answer });
    }
    expect(cur.meta.state).toBe("ODM_REVIEW");
    expect(cur.meta.progress).toEqual({ done: 7, total: 7, label: "questions" });

    const review = cards(cur).find((c) => c.title === "Your requirement");
    expect(review, "requirement summary card missing").toBeDefined();
    expect(review!.body).toContain(SLOT_ANSWERS[0]);

    const ids = chipIds(cur);
    expect(ids).toContain("bench:generate");
    expect(ids).toContain("lld:generate");
  });

  it("bench:generate → ODM_BENCH_REVIEW with a real downloadable PDF", async () => {
    cur = await chat({ session_id: sid, kind: "chip", chip_id: "bench:generate" });
    expect(cur.meta.state).toBe("ODM_BENCH_REVIEW");

    const links = downloadLinks(cur);
    expect(links.length, "bench download link missing").toBeGreaterThan(0);
    expect(links[0].url).toContain(`/api/download/${sid}/`);
    await expectPdf(links[0].url);

    const ids = chipIds(cur);
    expect(ids).toContain("bench:accept");
    expect(ids).toContain("bench:file");
  });

  it("a text revision rewrites the bench and stays in ODM_BENCH_REVIEW", async () => {
    cur = await chat({
      session_id: sid,
      kind: "text",
      text: "Add Tile Pro street pricing to the bench table and tighten the target specs section",
    });
    expect(cur.meta.state).toBe("ODM_BENCH_REVIEW");

    const revised = cards(cur).find((c) => c.title.includes("revised"));
    expect(revised, "revised bench card missing").toBeDefined();
    const links = downloadLinks(cur);
    expect(links.length).toBeGreaterThan(0);
    await expectPdf(links[0].url);
    expect(chipIds(cur)).toContain("bench:accept");
  });

  it("bench:accept → ODM_REVIEW whose chips EXCLUDE bench:generate", async () => {
    cur = await chat({ session_id: sid, kind: "chip", chip_id: "bench:accept" });
    expect(cur.meta.state).toBe("ODM_REVIEW");
    const ids = chipIds(cur);
    expect(ids).not.toContain("bench:generate");
    expect(ids).toContain("lld:generate");
  });

  it("lld:generate → ODM_LLD_REVIEW with a real downloadable PDF", async () => {
    cur = await chat({ session_id: sid, kind: "chip", chip_id: "lld:generate" });
    expect(cur.meta.state).toBe("ODM_LLD_REVIEW");

    const links = downloadLinks(cur);
    expect(links.length, "LLD download link missing").toBeGreaterThan(0);
    await expectPdf(links[0].url);

    const ids = chipIds(cur);
    expect(ids).toContain("lld:accept");
    expect(ids).toContain("lld:regen");
  });

  it("a text revision rewrites the LLD, then lld:accept files it as DONE", async () => {
    cur = await chat({
      session_id: sid,
      kind: "text",
      text: "In section 3 add an explicit functional requirement for 2-year battery life",
    });
    expect(cur.meta.state).toBe("ODM_LLD_REVIEW");
    const revised = cards(cur).find((c) => c.title.includes("revised"));
    expect(revised, "revised LLD card missing").toBeDefined();
    await expectPdf(downloadLinks(cur)[0].url);

    cur = await chat({ session_id: sid, kind: "chip", chip_id: "lld:accept" });
    // The closing question of every ODM filing: apply for project sanction?
    expect(cur.meta.state).toBe("ODM_SANCTION");
    cur = await chat({ session_id: sid, kind: "chip", chip_id: "sanction:yes" });
    expect(cur.meta.state).toBe("DONE");
    expect(cur.meta.track).toBe("ODM");
  });

  it("DONE widgets carry BOTH deliverable download links, each a live PDF", async () => {
    const links = downloadLinks(cur);
    expect(links.length, "expected bench + LLD links on the DONE card").toBe(2);

    const benchLink = links.find((l) => l.label.includes("Benchmark"));
    const lldLink = links.find((l) => l.label.includes("LLD"));
    expect(benchLink, "bench download link missing from DONE card").toBeDefined();
    expect(lldLink, "LLD download link missing from DONE card").toBeDefined();
    await expectPdf(benchLink!.url);
    await expectPdf(lldLink!.url);
  });

  it("session data holds the issued identity and both PDF deliverables", async () => {
    const db = getDb();
    const s = await db.getSession(sid);
    expect(s).not.toBeNull();
    const d = s!.data;

    expect(d.deal_id).toMatch(/^EB-C-\d{2}-\d{4}-D01$/);
    expect(d.lead_ref).toMatch(/^XOR-\d{8}-\d{3}$/);
    expect(d.lld_file?.endsWith(".pdf"), `lld_file=${d.lld_file}`).toBe(true);
    expect(d.bench_file?.endsWith(".pdf"), `bench_file=${d.bench_file}`).toBe(true);
    expect(d.finalized).toBe(true);

    // The lead row exists, on the ODM track, tied to this deal.
    const lead = await db.getLead(d.lead_id!);
    expect(lead?.track).toBe("ODM");
    expect(lead?.company).toBe(CONTACT.company);
    expect(lead?.deal_id).toBe(d.deal_id);
  });

  it("the tasks feed shows both drafts and both revisions, completed", async () => {
    const tasks = await getDb().tasksForSession(sid);
    for (const label of [
      "Draft the benchmark report",
      "Revise the benchmark report",
      "Draft the LLD",
      "Revise the LLD",
    ]) {
      const rows = tasks.filter((t) => t.label === label);
      expect(rows.length, `task "${label}" missing`).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.status, `task "${label}" not completed`).toBe("completed");
      }
    }
  });

  it("the drive retry payload carries the bench file in files[] and the LLD", async () => {
    const retries = (
      (globalThis as Record<string, unknown>).__xorMemDb as { retries: HandoffRetryRow[] }
    ).retries;
    const driveRows = retries.filter((r) => r.kind === "drive");
    expect(driveRows.length).toBe(1);

    const row = driveRows[0];
    expect(row.resolved_at, "MOCK_DRIVE handoff should be pre-resolved").not.toBeNull();

    const s = await getDb().getSession(sid);
    const d = s!.data;
    const payload = row.payload as {
      lead_ref: string;
      deal_id: string;
      client_code: string;
      files: { storage_path: string; filename: string }[];
      lld: { filename: string; storage_path: string } | null;
      summary_md: string;
    };
    expect(payload.lead_ref).toBe(d.lead_ref);
    expect(payload.deal_id).toBe(d.deal_id);
    expect(payload.client_code).toMatch(/^EB-C-\d{2}-\d{4}$/);

    // Outcome A's report travels in files[] (stamped copy of the bench PDF).
    const benchEntry = payload.files.find((f) => f.storage_path === d.bench_path);
    expect(benchEntry, "bench file missing from drive payload files[]").toBeDefined();
    expect(benchEntry!.filename.endsWith(d.bench_file!)).toBe(true);

    // The LLD rides in its own slot of the payload.
    expect(payload.lld).not.toBeNull();
    expect(payload.lld!.storage_path).toBe(d.lld_path);
    expect(payload.lld!.filename.endsWith(d.lld_file!)).toBe(true);
  });
});

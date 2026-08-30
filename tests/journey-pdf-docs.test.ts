/**
 * Deliverables deep-check — the branded PDFs a customer actually downloads.
 *
 * Runs a minimal ODM journey to DONE, fetches the LLD (and, separately, the
 * Product Definition & Benchmark Report) through the real download route and
 * inspects the PDF bytes: DejaVu embedding (FontFile2 + TrueType sfnt bytes
 * in the inflated font stream), page count, content-disposition, and the
 * markdown source stored alongside in Storage. Also proves the storeDoc
 * fallback: when brandedPdf throws, the flow must still complete and serve
 * the markdown deliverable with a text/markdown content type.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import zlib from "zlib";

process.env.MOCK_LLM = "true";
process.env.MOCK_DRIVE = "true";
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { NextRequest } from "next/server";

import { POST as chatPost } from "@/app/api/chat/route";
import { GET as downloadGet } from "@/app/api/download/[session]/[file]/route";
import { getDb, resetMemoryDb } from "@/lib/supabase";
import type { ChatIn, ChatOut, Widget } from "@/lib/widgets";

// Toggle for the ONE fallback test: everywhere else brandedPdf passes through
// to the real renderer, so the deep-check tests exercise genuine PDF bytes.
const pdfMock = vi.hoisted(() => ({ fail: false }));

vi.mock("@/lib/lld-pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lld-pdf")>();
  return {
    brandedPdf: async (
      ...args: Parameters<typeof actual.brandedPdf>
    ): Promise<Buffer> => {
      if (pdfMock.fail) throw new Error("simulated pdf renderer failure");
      return actual.brandedPdf(...args);
    },
  };
});

let ipCounter = 0;
let ip = "10.9.0.1";

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

const CONTACT = {
  name: "Arjun Mehta",
  company: "Acme Devices",
  email: "arjun@acme.in",
  phone: "+91 9876543210",
};

const ODM_ANSWERS = [
  "smart energy meter for housing societies",
  "LTE, tamper detection, class 1 accuracy",
  "5k first run, 50k per year",
  "under Rs 1500",
  "prototypes in 8 weeks",
  "India first, BIS",
  "similar to existing meters on IndiaMART",
];

/** Minimal ODM run: open → confirm track → contact → slots → ODM_REVIEW. */
async function odmToReview(): Promise<{ sid: string; cur: ChatOut }> {
  const opened = await chat({ kind: "open" });
  const sid = opened.session_id;
  const res = await chat({
    session_id: sid,
    kind: "text",
    text: "we have an idea for a smart energy meter, want you to design it",
  });
  expect(res.meta.state).toBe("TRACK_CONFIRM");
  const confirmed = await chat({ session_id: sid, kind: "chip", chip_id: "confirm:yes" });
  expect(confirmed.meta.state).toBe("CONTACT");
  let cur = await chat({
    session_id: sid,
    kind: "form",
    form: { form_id: "contact", values: CONTACT },
  });
  if (cur.meta.state === "CLIENT_INDUSTRY") {
    cur = await chat({ session_id: sid, kind: "chip", chip_id: "sec:4" });
    expect(cur.meta.state).toBe("CLIENT_ORGSIZE");
    cur = await chat({ session_id: sid, kind: "chip", chip_id: "org:0" });
  }
  expect(cur.meta.state).toBe("ODM_SLOTS");
  for (const ans of ODM_ANSWERS) {
    cur = await chat({ session_id: sid, kind: "text", text: ans });
  }
  expect(cur.meta.state).toBe("ODM_REVIEW");
  return { sid, cur };
}

function downloadLinks(res: ChatOut): { label: string; url: string }[] {
  return res.widgets
    .filter((w): w is Extract<Widget, { type: "card" }> => w.type === "card")
    .flatMap((w) => w.links)
    .filter((l) => l.url.includes("/api/download/"));
}

async function fetchDownload(url: string): Promise<Response> {
  const [, , sessionPart, filePart] = new URL(`http://test${url}`).pathname
    .split("/")
    .filter(Boolean);
  return downloadGet(new NextRequest(`http://test${url}`), {
    params: Promise.resolve({ session: sessionPart, file: filePart }),
  });
}

// ── PDF byte-level helpers ────────────────────────────────────────────────
/** Raw `stream…endstream` payloads, EOL-trimmed per the PDF spec. */
function extractStreams(buf: Buffer): Buffer[] {
  const found: Buffer[] = [];
  let pos = 0;
  for (;;) {
    const s = buf.indexOf("stream", pos);
    if (s === -1) break;
    // Skip the "stream" inside "endstream".
    if (buf.subarray(Math.max(0, s - 3), s).toString("latin1") === "end") {
      pos = s + 6;
      continue;
    }
    let dataStart = s + 6;
    if (buf[dataStart] === 0x0d) dataStart++;
    if (buf[dataStart] === 0x0a) dataStart++;
    const e = buf.indexOf("endstream", dataStart);
    if (e === -1) break;
    let dataEnd = e;
    if (dataEnd > dataStart && buf[dataEnd - 1] === 0x0a) dataEnd--;
    if (dataEnd > dataStart && buf[dataEnd - 1] === 0x0d) dataEnd--;
    found.push(buf.subarray(dataStart, dataEnd));
    pos = e + 9;
  }
  return found;
}

/** Every stream that zlib can inflate (pdfkit FlateDecodes them all). */
function inflatedStreams(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (const s of extractStreams(buf)) {
    try {
      out.push(zlib.inflateSync(s));
    } catch {
      // not a Flate stream — ignore
    }
  }
  return out;
}

/** Page objects in the raw PDF (`/Type /Page`, excluding the `/Pages` tree). */
function pageCount(buf: Buffer): number {
  return (buf.toString("latin1").match(/\/Type \/Page(?!s)/g) ?? []).length;
}

interface PdfCheck {
  body: Buffer;
  raw: string;
  inflated: Buffer[];
}

async function readPdf(res: Response): Promise<PdfCheck> {
  const body = Buffer.from(await res.arrayBuffer());
  return { body, raw: body.toString("latin1"), inflated: inflatedStreams(body) };
}

/** The common deep assertions both branded deliverables must satisfy. */
function expectBrandedPdf(pdf: PdfCheck): void {
  expect(pdf.body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  // DejaVu embedding: FontDescriptor with an embedded TrueType program …
  expect(pdf.raw).toContain("/FontFile2");
  expect(pdf.raw).toContain("DejaVuSans");
  // … whose inflated FontFile2 bytes start with a TrueType sfnt magic —
  // 0x00010000 or 'true' (fontkit's subsetter emits the Apple magic).
  const sfnt = pdf.inflated.some(
    (b) =>
      b.length > 4 &&
      (b.readUInt32BE(0) === 0x00010000 || b.readUInt32BE(0) === 0x74727565),
  );
  expect(sfnt, "no inflated stream carries TrueType (sfnt) font bytes").toBe(true);
  // At least one page object, and at least one drawable content stream that
  // actually places text (BT/ET blocks with a Tf font selection).
  expect(pageCount(pdf.body)).toBeGreaterThanOrEqual(1);
  const content = pdf.inflated.map((b) => b.toString("latin1")).join("\n");
  expect(content).toContain("BT");
  expect(content).toContain("Tf");
}

beforeEach(() => {
  resetMemoryDb();
  pdfMock.fail = false;
  ip = `10.9.0.${++ipCounter}`;
});

describe("LLD PDF deliverable", () => {
  it("serves a DejaVu-embedded branded PDF and keeps the markdown source in storage", async () => {
    const { sid } = await odmToReview();
    let cur = await chat({ session_id: sid, kind: "chip", chip_id: "lld:generate" });
    expect(cur.meta.state).toBe("ODM_LLD_REVIEW");
    cur = await chat({ session_id: sid, kind: "chip", chip_id: "lld:accept" });
    expect(cur.meta.state).toBe("DONE");

    const links = downloadLinks(cur);
    expect(links.length, "LLD download link missing on DONE").toBeGreaterThan(0);
    const lldLink = links.find((l) => l.label.toLowerCase().includes("lld")) ?? links[0];
    const fname = decodeURIComponent(lldLink.url.split("/").pop()!);
    expect(fname).toMatch(/^LLD-draft-XOR-\d{8}-\d{3}\.pdf$/);

    const dl = await fetchDownload(lldLink.url);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("application/pdf");
    expect(dl.headers.get("content-disposition")).toBe(
      `attachment; filename="${fname}"`,
    );

    const pdf = await readPdf(dl);
    expectBrandedPdf(pdf);

    // Markdown source stored alongside the PDF, distinct path, readable.
    const db = getDb();
    const s = await db.getSession(sid);
    expect(s?.data.lld_file).toBe(fname);
    expect(s?.data.lld_path).toMatch(/\.pdf$/);
    expect(s?.data.lld_md_path).toMatch(/\.md$/);
    expect(s?.data.lld_md_path).not.toBe(s?.data.lld_path);
    const mdBytes = await db.getObject(s!.data.lld_md_path!);
    expect(mdBytes, "lld_md_path not readable from storage").not.toBeNull();
    const md = new TextDecoder().decode(mdBytes!);
    expect(md).toContain("LLD Draft");
    expect(md).toContain(s!.data.lead_ref!);
  });
});

describe("Benchmark report PDF deliverable", () => {
  it("renders the pipe-table report as a branded PDF with the markdown source stored", async () => {
    const { sid } = await odmToReview();
    let cur = await chat({ session_id: sid, kind: "chip", chip_id: "bench:generate" });
    expect(cur.meta.state).toBe("ODM_BENCH_REVIEW");
    cur = await chat({ session_id: sid, kind: "chip", chip_id: "bench:file" });
    expect(cur.meta.state).toBe("DONE");

    const links = downloadLinks(cur);
    const benchLink = links.find((l) =>
      l.url.includes(encodeURIComponent("Product-Definition")),
    );
    expect(benchLink, "benchmark report download link missing on DONE").toBeDefined();
    const fname = decodeURIComponent(benchLink!.url.split("/").pop()!);
    expect(fname).toMatch(/^Product-Definition-XOR-\d{8}-\d{3}\.pdf$/);

    const dl = await fetchDownload(benchLink!.url);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("application/pdf");
    expect(dl.headers.get("content-disposition")).toBe(
      `attachment; filename="${fname}"`,
    );

    const pdf = await readPdf(dl);
    expectBrandedPdf(pdf);
    // The template carries three pipe tables; the grid renderer plus two
    // embedded DejaVu subsets keep a real render comfortably above 15 KB.
    expect(pdf.body.length).toBeGreaterThan(15000);

    // Markdown source in storage: template title and an actual pipe table.
    const db = getDb();
    const s = await db.getSession(sid);
    expect(s?.data.bench_file).toBe(fname);
    const mdBytes = await db.getObject(s!.data.bench_md_path!);
    expect(mdBytes, "bench_md_path not readable from storage").not.toBeNull();
    const md = new TextDecoder().decode(mdBytes!);
    expect(md).toContain("Product Definition & Benchmark Report");
    expect(md).toMatch(/\|---\|/);
  });
});

describe("storeDoc pdf-failure fallback", () => {
  it("still completes the flow and serves the markdown deliverable when brandedPdf throws", async () => {
    const { sid } = await odmToReview();
    pdfMock.fail = true;
    try {
      let cur = await chat({ session_id: sid, kind: "chip", chip_id: "lld:generate" });
      expect(cur.meta.state).toBe("ODM_LLD_REVIEW");
      cur = await chat({ session_id: sid, kind: "chip", chip_id: "lld:accept" });
      expect(cur.meta.state).toBe("DONE");

      const links = downloadLinks(cur);
      expect(links.length, "deliverable link missing on DONE").toBeGreaterThan(0);
      const fname = decodeURIComponent(links[0].url.split("/").pop()!);
      expect(fname).toMatch(/^LLD-draft-XOR-\d{8}-\d{3}\.md$/);

      const db = getDb();
      const s = await db.getSession(sid);
      expect(s?.data.lld_file).toBe(fname);
      expect(s?.data.lld_path).toMatch(/\.md$/);

      const dl = await fetchDownload(links[0].url);
      expect(dl.status).toBe(200);
      expect(dl.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      expect(dl.headers.get("content-disposition")).toBe(
        `attachment; filename="${fname}"`,
      );
      const md = Buffer.from(await dl.arrayBuffer()).toString("utf-8");
      expect(md).toContain("LLD Draft");
      expect(md.startsWith("%PDF-")).toBe(false);
    } finally {
      pdfMock.fail = false;
    }
  });
});

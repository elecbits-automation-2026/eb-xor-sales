/**
 * End-to-end tests in mock mode — no keys, no network. Drives all three
 * tracks through the real route handlers and asserts the DB side-effects
 * (leads, lead_files, logged handoffs) on the in-memory driver.
 */
import { beforeEach, describe, expect, it } from "vitest";

process.env.MOCK_LLM = "true";
process.env.MOCK_DRIVE = "true";
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { NextRequest } from "next/server";

import { POST as chatPost } from "@/app/api/chat/route";
import { GET as downloadGet } from "@/app/api/download/[session]/[file]/route";
import { PUT as mockUploadPut } from "@/app/api/mock-upload/route";
import { POST as uploadCompletePost } from "@/app/api/upload-complete/route";
import { POST as uploadUrlPost } from "@/app/api/upload-url/route";
import { getDb, resetMemoryDb } from "@/lib/supabase";
import type { ChatIn, ChatOut, Widget } from "@/lib/widgets";

let ipCounter = 0;
let ip = "10.0.0.1";

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

async function start(text: string): Promise<{ sid: string; res: ChatOut }> {
  const opened = await chat({ kind: "open" });
  expect(opened.messages.length).toBeGreaterThan(0);
  expect(opened.widgets[0].type).toBe("chips");
  const sid = opened.session_id;
  const res = await chat({ session_id: sid, kind: "text", text });
  return { sid, res };
}

async function throughContact(
  sid: string,
  res: ChatOut,
  contact: Record<string, string> = CONTACT,
): Promise<ChatOut> {
  expect(res.meta.state).toBe("TRACK_CONFIRM");
  const confirmed = await chat({ session_id: sid, kind: "chip", chip_id: "confirm:yes" });
  expect(confirmed.meta.state).toBe("CONTACT");
  let cur = await chat({
    session_id: sid,
    kind: "form",
    form: { form_id: "contact", values: contact },
  });
  // New clients answer two company questions (sector + org size — register
  // columns per the ID SOP); returning clients skip straight to the track.
  if (cur.meta.state === "CLIENT_INDUSTRY") {
    cur = await chat({ session_id: sid, kind: "chip", chip_id: "sec:4" });
    expect(cur.meta.state).toBe("CLIENT_ORGSIZE");
    cur = await chat({ session_id: sid, kind: "chip", chip_id: "org:0" });
  }
  return cur;
}

async function uploadFile(
  sid: string,
  itemKey: string,
  filename: string,
  content = "fake-bytes",
): Promise<{ status: number; out?: ChatOut; detail?: string }> {
  const urlRes = await uploadUrlPost(
    jsonReq("/api/upload-url", "POST", {
      session_id: sid,
      item_key: itemKey,
      filename,
      bytes: content.length,
    }),
  );
  if (urlRes.status !== 200) {
    return { status: urlRes.status, detail: (await urlRes.json()).detail };
  }
  const { url, storage_path } = await urlRes.json();
  const putRes = await mockUploadPut(
    new NextRequest(`http://test${url}`, {
      method: "PUT",
      body: content,
      headers: { "content-type": "application/octet-stream" },
    }),
  );
  expect(putRes.status).toBe(200);
  const doneRes = await uploadCompletePost(
    jsonReq("/api/upload-complete", "POST", {
      session_id: sid,
      item_key: itemKey,
      storage_path,
      filename,
      bytes: content.length,
    }),
  );
  if (doneRes.status !== 200) {
    return { status: doneRes.status, detail: (await doneRes.json()).detail };
  }
  return { status: 200, out: (await doneRes.json()) as ChatOut };
}

interface MemRetry {
  kind: string;
  payload: Record<string, unknown>;
  resolved_at: string | null;
}

function memRetries(): MemRetry[] {
  return ((globalThis as Record<string, unknown>).__xorMemDb as { retries: MemRetry[] }).retries;
}

beforeEach(() => {
  resetMemoryDb();
  ip = `10.0.0.${++ipCounter}`;
});

describe("ODM flow", () => {
  it("produces an LLD, a leads row and a logged funnel row", async () => {
    const { sid, res } = await start(
      "we have an idea for a smart energy meter, want you to design it",
    );
    expect(res.meta.track).toBeNull(); // not locked until confirmed
    let cur = await throughContact(sid, res);
    expect(cur.meta.state).toBe("ODM_SLOTS");

    const answers = [
      "smart energy meter for housing societies",
      "LTE, tamper detection, class 1 accuracy",
      "5k first run, 50k per year",
      "under Rs 1500",
      "prototypes in 8 weeks",
      "India first, BIS",
      "similar to existing meters on IndiaMART",
    ];
    for (const ans of answers) {
      cur = await chat({ session_id: sid, kind: "text", text: ans });
    }
    expect(cur.meta.state).toBe("ODM_REVIEW");
    expect(cur.widgets.some((w: Widget) => w.type === "card")).toBe(true);

    cur = await chat({ session_id: sid, kind: "chip", chip_id: "lld:generate" });
    // The draft is now reviewable/editable before filing.
    expect(cur.meta.state).toBe("ODM_LLD_REVIEW");
    cur = await chat({ session_id: sid, kind: "chip", chip_id: "lld:accept" });
    expect(cur.meta.state).toBe("DONE");

    const links = cur.widgets
      .filter((w): w is Extract<Widget, { type: "card" }> => w.type === "card")
      .flatMap((w) => w.links)
      .filter((l) => l.url.includes("/api/download/"));
    expect(links.length, "LLD download link missing").toBeGreaterThan(0);

    const [, , sessionPart, filePart] = new URL(`http://test${links[0].url}`).pathname
      .split("/")
      .filter(Boolean);
    const dl = await downloadGet(
      new NextRequest(`http://test${links[0].url}`),
      { params: Promise.resolve({ session: sessionPart, file: filePart }) },
    );
    expect(dl.status).toBe(200);
    // The deliverable is the branded .docx (a ZIP: leading "PK") with the
    // Word content type; markdown only serves as the docx-failure fallback.
    expect(dl.headers.get("content-type")).toContain("wordprocessingml");
    const body = Buffer.from(await dl.arrayBuffer());
    expect(body.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(body.length).toBeGreaterThan(5000);

    // leads row exists with a well-formed ref
    const db = getDb();
    const s = await db.getSession(sid);
    expect(s?.data.lead_ref).toMatch(/^XOR-\d{8}-\d{3}$/);
    const lead = await db.getLead(s!.data.lead_id!);
    expect(lead?.company).toBe("Acme Devices");
    expect(lead?.track).toBe("ODM");

    // funnel row logged (MOCK_DRIVE: recorded in the DB, pre-resolved)
    const sheetRows = memRetries().filter((r) => r.kind === "sheet");
    expect(sheetRows.length).toBe(1);
    expect(JSON.stringify(sheetRows[0].payload)).toContain("New product design (ODM)");
    expect(sheetRows[0].resolved_at).not.toBeNull();
  });
});

describe("EMS flow", () => {
  it("collects files via the signed-URL flow, then details", async () => {
    const { sid, res } = await start(
      "I have gerbers and BoM ready, need PCB assembly for 5000 units",
    );
    let cur = await throughContact(sid, res);
    expect(cur.meta.state).toBe("EMS_CHECKLIST");
    expect(
      cur.widgets.some((w) => w.type === "upload" && w.item.key === "bom"),
    ).toBe(true);

    // wrong extension refused with a clear error
    const bad = await uploadFile(sid, "bom", "virus.exe");
    expect(bad.status).toBe(415);

    const bom = await uploadFile(sid, "bom", "acme-bom.xlsx");
    expect(bom.status).toBe(200);
    expect(
      bom.out!.widgets.some((w) => w.type === "upload" && w.item.key === "gerber"),
    ).toBe(true);

    const gerber = await uploadFile(sid, "gerber", "fab_rev3.zip");
    expect(gerber.status).toBe(200);

    cur = gerber.out!;
    for (const key of ["pnp", "assembly", "cad", "test_fw"]) {
      cur = await chat({ session_id: sid, kind: "chip", chip_id: `skip:${key}` });
    }
    expect(cur.meta.state).toBe("EMS_DETAILS");

    cur = await chat({
      session_id: sid,
      kind: "form",
      form: {
        form_id: "ems_details",
        values: {
          quantity: "5,000 + 25k/yr",
          target_date: "pilot by November",
          notes: "ENIG finish, 4 layers",
        },
      },
    });
    expect(cur.meta.state).toBe("DONE");

    // lead_files rows exist and are linked to the lead
    const db = getDb();
    const s = await db.getSession(sid);
    const files = await db.leadFiles(sid);
    expect(files.map((f) => f.filename).sort()).toEqual(["acme-bom.xlsx", "fab_rev3.zip"]);
    expect(files.every((f) => f.lead_id === s!.data.lead_id)).toBe(true);

    // drive handoff logged with the summary flagging the skipped-required items
    const driveRows = memRetries().filter((r) => r.kind === "drive");
    expect(driveRows.length).toBe(1);
    const summary = (driveRows[0].payload as { summary_md: string }).summary_md;
    expect(summary).toContain("uploaded");
    expect(summary).toContain("skipped");
    const sheetRow = JSON.stringify(memRetries().filter((r) => r.kind === "sheet")[0].payload);
    expect(sheetRow).toContain("Manufacturing (EMS)");
  });
});

describe("PRODUCT flow", () => {
  it("category chip → details → DONE", async () => {
    const { sid, res } = await start("do you sell soundbox devices off the shelf");
    let cur = await throughContact(sid, res);
    expect(cur.meta.state).toBe("PRODUCT_CATEGORY");
    cur = await chat({ session_id: sid, kind: "chip", chip_id: "cat:epay" });
    expect(cur.meta.state).toBe("PRODUCT_DETAILS");
    cur = await chat({
      session_id: sid,
      kind: "form",
      form: {
        form_id: "product_details",
        values: { quantity: "500", timeline: "8 weeks", customization: "white-label branding" },
      },
    });
    expect(cur.meta.state).toBe("DONE");
    const sheetRow = JSON.stringify(memRetries().filter((r) => r.kind === "sheet")[0].payload);
    expect(sheetRow).toContain("Ready products");
    expect(sheetRow).toContain("E-payment");
  });
});

describe("QUESTION + manual track", () => {
  it("answers a capability question, then accepts a manual track pick", async () => {
    const opened = await chat({ kind: "open" });
    const sid = opened.session_id;
    const res = await chat({
      session_id: sid,
      kind: "text",
      text: "what certifications do you have",
    });
    expect(res.widgets.some((w) => w.type === "chips")).toBe(true);
    const picked = await chat({ session_id: sid, kind: "chip", chip_id: "track:ODM" });
    expect(picked.meta.state).toBe("CONTACT");
  });
});

describe("contact validation", () => {
  it("rejects a bad email and re-presents the form", async () => {
    const { sid, res } = await start(
      "please design and develop a new smart plug product for us",
    );
    expect(res.meta.state).toBe("TRACK_CONFIRM");
    await chat({ session_id: sid, kind: "chip", chip_id: "confirm:yes" });
    const bad = await chat({
      session_id: sid,
      kind: "form",
      form: { form_id: "contact", values: { ...CONTACT, email: "not-an-email" } },
    });
    expect(bad.messages[0]).toContain("valid email");
    expect(bad.widgets.some((w) => w.type === "form")).toBe(true);
  });
});

/**
 * PRODUCT-track journey tests in mock mode — no keys, no network.
 *
 * Covers: the chip-picked PRODUCT track end to end (open → track chip →
 * contact → sector → org size → category → details → DONE) with the DB
 * side-effects (lead + deal issued, funnel row queued); the QUESTION path in
 * DISCOVER (answer + track chips again, no state advance, then a product
 * description routes onward); and client reuse — a second enquiry from the
 * same contact email files under the same client with deal -D02.
 */
import { beforeEach, describe, expect, it } from "vitest";

process.env.MOCK_LLM = "true";
process.env.MOCK_DRIVE = "true";
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { NextRequest } from "next/server";

import { POST as chatPost } from "@/app/api/chat/route";
import { PRODUCT_CATEGORIES } from "@/lib/config";
import { ORG_SIZES, SECTORS } from "@/lib/flows";
import { getDb, resetMemoryDb } from "@/lib/supabase";
import type { ChatIn, ChatOut, Widget } from "@/lib/widgets";

let ipCounter = 100; // distinct block from other suites' counters
let ip = "10.0.1.1";

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
  name: "Priya Sharma",
  company: "ZenPay Retail",
  email: "priya@zenpay.in",
  phone: "+91 9812345678",
};

function chipIds(out: ChatOut): string[] {
  return out.widgets
    .filter((w): w is Extract<Widget, { type: "chips" }> => w.type === "chips")
    .flatMap((w) => w.options.map((o) => o.id));
}

function hasForm(out: ChatOut, formId: string): boolean {
  return out.widgets.some((w) => w.type === "form" && w.form_id === formId);
}

interface MemRetry {
  kind: string;
  payload: Record<string, unknown>;
  resolved_at: string | null;
}

function memDb(): { retries: MemRetry[]; clients: Map<string, unknown> } {
  return (globalThis as Record<string, unknown>).__xorMemDb as {
    retries: MemRetry[];
    clients: Map<string, unknown>;
  };
}

function memRetries(): MemRetry[] {
  return memDb().retries;
}

/**
 * Drives one full NEW-client PRODUCT enquiry (track chip, not free text)
 * through to DONE and returns the session id plus the final turn.
 */
async function fileNewClientProductEnquiry(): Promise<{ sid: string; done: ChatOut }> {
  const opened = await chat({ kind: "open" });
  expect(opened.meta.state).toBe("DISCOVER");
  const sid = opened.session_id;

  let cur = await chat({ session_id: sid, kind: "chip", chip_id: "track:PRODUCT" });
  expect(cur.meta.state).toBe("CONTACT");
  expect(cur.meta.track).toBe("PRODUCT");

  cur = await chat({
    session_id: sid,
    kind: "form",
    form: { form_id: "contact", values: CONTACT },
  });
  expect(cur.meta.state).toBe("CLIENT_INDUSTRY");
  cur = await chat({ session_id: sid, kind: "chip", chip_id: "sec:4" });
  expect(cur.meta.state).toBe("CLIENT_ORGSIZE");
  cur = await chat({ session_id: sid, kind: "chip", chip_id: "org:0" });
  expect(cur.meta.state).toBe("PRODUCT_CATEGORY");

  cur = await chat({ session_id: sid, kind: "chip", chip_id: "cat:epay" });
  expect(cur.meta.state).toBe("PRODUCT_DETAILS");
  cur = await chat({
    session_id: sid,
    kind: "form",
    form: {
      form_id: "product_details",
      values: { quantity: "1,000 units", timeline: "6 weeks", customization: "custom logo" },
    },
  });
  expect(cur.meta.state).toBe("DONE");
  return { sid, done: cur };
}

beforeEach(() => {
  resetMemoryDb();
  ip = `10.0.1.${++ipCounter % 250}`;
});

describe("PRODUCT journey (chip-picked track)", () => {
  it("walks open → track chip → contact → sector → org → category → details → DONE", async () => {
    const opened = await chat({ kind: "open" });
    expect(opened.meta.state).toBe("DISCOVER");
    expect(opened.widgets[0].type).toBe("chips");
    expect(chipIds(opened)).toContain("track:PRODUCT");
    const sid = opened.session_id;

    // Track chip locks the track immediately (no TRACK_CONFIRM detour).
    let cur = await chat({ session_id: sid, kind: "chip", chip_id: "track:PRODUCT" });
    expect(cur.meta.state).toBe("CONTACT");
    expect(cur.meta.track).toBe("PRODUCT");
    expect(cur.messages[0]).toContain("find you the right product");
    expect(hasForm(cur, "contact")).toBe(true);

    // New client → the two company questions (register columns).
    cur = await chat({
      session_id: sid,
      kind: "form",
      form: { form_id: "contact", values: CONTACT },
    });
    expect(cur.meta.state).toBe("CLIENT_INDUSTRY");
    expect(cur.messages[0]).toContain("Which sector fits ZenPay Retail best?");
    expect(chipIds(cur)).toEqual(SECTORS.map((_, i) => `sec:${i}`));

    cur = await chat({ session_id: sid, kind: "chip", chip_id: "sec:4" });
    expect(cur.meta.state).toBe("CLIENT_ORGSIZE");
    expect(chipIds(cur)).toEqual(ORG_SIZES.map((_, i) => `org:${i}`));

    // Org size answered → identity issued early (client + deal), then the
    // category chips.
    cur = await chat({ session_id: sid, kind: "chip", chip_id: "org:0" });
    expect(cur.meta.state).toBe("PRODUCT_CATEGORY");
    expect(cur.messages[0]).toMatch(/Filed as EB-C-\d{2}-\d{4}-D01\./);
    expect(cur.messages[0]).toContain("Thanks Priya.");
    expect(chipIds(cur)).toEqual(PRODUCT_CATEGORIES.map(([cid]) => `cat:${cid}`));

    cur = await chat({ session_id: sid, kind: "chip", chip_id: "cat:epay" });
    expect(cur.meta.state).toBe("PRODUCT_DETAILS");
    expect(cur.messages[0]).toContain("E-payment devices");
    expect(hasForm(cur, "product_details")).toBe(true);

    cur = await chat({
      session_id: sid,
      kind: "form",
      form: {
        form_id: "product_details",
        values: {
          quantity: "1,000 units",
          timeline: "6 weeks",
          customization: "white-label branding",
        },
      },
    });
    expect(cur.meta.state).toBe("DONE");
    expect(cur.meta.track).toBe("PRODUCT");

    // ── DB side-effects ────────────────────────────────────────────────────
    const db = getDb();
    const s = await db.getSession(sid);
    const d = s!.data;
    expect(s!.state).toBe("DONE");
    expect(d.finalized).toBe(true);
    expect(d.lead_ref).toMatch(/^XOR-\d{8}-\d{3}$/);
    expect(d.client_code).toMatch(/^EB-C-\d{2}-\d{4}$/);
    expect(d.deal_id).toBe(`${d.client_code}-D01`);

    const lead = await db.getLead(d.lead_id!);
    expect(lead).not.toBeNull();
    expect(lead!.track).toBe("PRODUCT");
    expect(lead!.company).toBe("ZenPay Retail");
    expect(lead!.contact_name).toBe("Priya Sharma");
    expect(lead!.email).toBe("priya@zenpay.in");
    expect(lead!.client_id).toBe(d.client_id);
    expect(lead!.deal_id).toBe(d.deal_id);
    // finalize upgrades the provisional summary to the real one.
    expect(lead!.summary).toContain("Ready product: E-payment devices");
    expect(lead!.summary).toContain("white-label branding");
    expect(lead!.quantity).toBe("1,000 units");
    expect(lead!.timeline).toBe("6 weeks");

    const client = await db.findClientByEmail(CONTACT.email);
    expect(client).not.toBeNull();
    expect(client!.client_code).toBe(d.client_code);
    expect(client!.sector).toBe(SECTORS[4]); // "IoT & Connected Devices"
    expect(client!.org_size).toBe(ORG_SIZES[0]); // "Proto-Level Startup (PL)"

    // Funnel row queued (MOCK_DRIVE: recorded in the DB, pre-resolved).
    const sheetRows = memRetries().filter((r) => r.kind === "sheet");
    expect(sheetRows).toHaveLength(1);
    expect(sheetRows[0].resolved_at).not.toBeNull();
    const row = (sheetRows[0].payload as { row: (string | number)[] }).row;
    expect(row[1]).toBe(d.deal_id); // Lead ID column carries the deal ref
    expect(row[2]).toBe("ZenPay Retail");
    expect(row[4]).toBe("priya@zenpay.in");
    expect(row[6]).toBe("Ready products");
    expect(String(row[7])).toContain("E-payment devices");
    expect(row[8]).toBe("1,000 units");
    expect(row[9]).toBe("6 weeks");
    expect(row[12]).toBe("XOR Bot");
    expect(row[13]).toBe("New MQL");

    // Drive handoff also logged pre-resolved in mock mode.
    const driveRows = memRetries().filter((r) => r.kind === "drive");
    expect(driveRows).toHaveLength(1);
    expect(driveRows[0].resolved_at).not.toBeNull();

    // ── DONE message sanity ────────────────────────────────────────────────
    const msg = cur.messages[0];
    expect(msg).toContain("All set, Priya");
    expect(msg).toContain(`logged as ${d.deal_id}`);
    expect(msg).toContain("catalogue and pricing");
    expect(msg).toContain(CONTACT.email);
    expect(msg).not.toMatch(/undefined|\bnull\b|NaN/);
    expect(msg).not.toContain("hiccup"); // no handoff trouble in mock mode

    const doneCard = cur.widgets.find(
      (w): w is Extract<Widget, { type: "card" }> => w.type === "card",
    );
    expect(doneCard?.title).toBe("What happens next");
    // PRODUCT track produces no LLD/bench downloads — only the account link.
    expect(doneCard?.links).toEqual([{ label: "Track this in your account", url: "/account" }]);
    expect(chipIds(cur)).toContain("restart");
  });
});

describe("QUESTION path in DISCOVER", () => {
  it("answers a capability question without advancing, then routes a product description", async () => {
    const opened = await chat({ kind: "open" });
    const sid = opened.session_id;

    const q = await chat({
      session_id: sid,
      kind: "text",
      text: "what certifications do you handle?",
    });
    // An actual answer (mock Q&A copy), not a probe…
    expect(q.messages[0]).toContain("Elecbits");
    // …the track chips are re-presented…
    expect(chipIds(q)).toEqual(["track:ODM", "track:EMS", "track:PRODUCT", "ask"]);
    // …and the state has NOT advanced.
    expect(q.meta.state).toBe("DISCOVER");
    expect(q.meta.track).toBeNull();
    const stored = await getDb().getSession(sid);
    expect(stored!.state).toBe("DISCOVER");
    expect(stored!.track).toBeNull();

    // A follow-up product description now routes onward to TRACK_CONFIRM.
    const follow = await chat({
      session_id: sid,
      kind: "text",
      text: "we want to buy your soundbox off the shelf for our stores",
    });
    expect(follow.meta.state).toBe("TRACK_CONFIRM");
    expect(follow.meta.track).toBeNull(); // not locked until confirmed
    expect(follow.messages[0]).toContain("Have I got that right?");
    const fids = chipIds(follow);
    expect(fids[0]).toBe("confirm:yes");
    expect(fids).toContain("track:ODM");
    expect(fids).toContain("track:EMS");
    expect(fids).not.toContain("track:PRODUCT"); // the proposed track is not re-offered

    const confirmed = await chat({ session_id: sid, kind: "chip", chip_id: "confirm:yes" });
    expect(confirmed.meta.state).toBe("CONTACT");
    expect(confirmed.meta.track).toBe("PRODUCT");
    expect(hasForm(confirmed, "contact")).toBe(true);
  });
});

describe("returning client (same contact email)", () => {
  it("reuses the client record and issues deal -D02 on the second enquiry", async () => {
    const first = await fileNewClientProductEnquiry();
    const db = getDb();
    const s1 = await db.getSession(first.sid);
    const clientCode = s1!.data.client_code!;
    expect(s1!.data.deal_id).toBe(`${clientCode}-D01`);

    // Second enquiry: fresh session, same contact email.
    const opened = await chat({ kind: "open" });
    const sid2 = opened.session_id;
    expect(sid2).not.toBe(first.sid);

    let cur = await chat({ session_id: sid2, kind: "chip", chip_id: "track:PRODUCT" });
    expect(cur.meta.state).toBe("CONTACT");
    cur = await chat({
      session_id: sid2,
      kind: "form",
      form: { form_id: "contact", values: CONTACT },
    });
    // Recognised by email → company questions skipped, filed under the same
    // client with the next deal serial.
    expect(cur.meta.state).toBe("PRODUCT_CATEGORY");
    expect(cur.messages[0]).toContain(`Welcome back — filing this under client ID ${clientCode}.`);
    expect(cur.messages[0]).toContain(`Filed as ${clientCode}-D02.`);

    cur = await chat({ session_id: sid2, kind: "chip", chip_id: "cat:iot" });
    expect(cur.meta.state).toBe("PRODUCT_DETAILS");
    cur = await chat({
      session_id: sid2,
      kind: "form",
      form: {
        form_id: "product_details",
        values: { quantity: "250", timeline: "next quarter", customization: "" },
      },
    });
    expect(cur.meta.state).toBe("DONE");
    expect(cur.messages[0]).toContain(`logged as ${clientCode}-D02`);

    const s2 = await db.getSession(sid2);
    expect(s2!.data.client_code).toBe(clientCode);
    expect(s2!.data.client_id).toBe(s1!.data.client_id);
    expect(s2!.data.deal_id).toBe(`${clientCode}-D02`);

    const lead1 = await db.getLead(s1!.data.lead_id!);
    const lead2 = await db.getLead(s2!.data.lead_id!);
    expect(lead2!.id).not.toBe(lead1!.id);
    expect(lead2!.client_id).toBe(lead1!.client_id);
    expect(lead2!.deal_id).toBe(`${clientCode}-D02`);
    expect(lead2!.summary).toContain("IoT & smart devices");

    // Still exactly ONE client record behind both enquiries.
    expect(memDb().clients.size).toBe(1);

    // One funnel row per enquiry; the second carries the -D02 ref.
    const sheetRows = memRetries().filter((r) => r.kind === "sheet");
    expect(sheetRows).toHaveLength(2);
    expect(sheetRows.every((r) => r.resolved_at !== null)).toBe(true);
    const row2 = (sheetRows[1].payload as { row: (string | number)[] }).row;
    expect(row2[1]).toBe(`${clientCode}-D02`);
  });
});

/**
 * EMS track journey, end to end, in mock mode (no keys, no network):
 *   open → chip track:EMS → contact form → sector chip → org-size chip →
 *   EMS_CHECKLIST (signed-URL uploads + skip chips) → EMS_DETAILS → DONE.
 *
 * Asserts the identity issuance (EB-C-YY-nnnn client, …-D01 deal), the early
 * lead row, checklist statuses, the mock drive/sheet handoff rows, and that a
 * duplicate details-form submit cannot double-finalize.
 */
import { beforeEach, describe, expect, it } from "vitest";

process.env.MOCK_LLM = "true";
process.env.MOCK_DRIVE = "true";
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { NextRequest } from "next/server";

import { POST as chatPost } from "@/app/api/chat/route";
import { PUT as mockUploadPut } from "@/app/api/mock-upload/route";
import { POST as uploadCompletePost } from "@/app/api/upload-complete/route";
import { POST as uploadUrlPost } from "@/app/api/upload-url/route";
import { getDb, resetMemoryDb, type LeadRow } from "@/lib/supabase";
import type { ChatIn, ChatOut, Widget } from "@/lib/widgets";

let ipCounter = 0;
let ip = "10.0.7.1";

const CLIENT_CODE_RE = /^EB-C-\d{2}-\d{4}$/;
const DEAL_ID_RE = /^EB-C-\d{2}-\d{4}-D\d{2}$/;
const FIRST_DEAL_RE = /^EB-C-\d{2}-\d{4}-D01$/;

function jsonReq(url: string, body?: unknown): NextRequest {
  return new NextRequest(`http://test${url}`, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
  });
}

async function chat(payload: Partial<ChatIn>): Promise<ChatOut> {
  const res = await chatPost(jsonReq("/api/chat", payload));
  expect(res.status).toBe(200);
  return (await res.json()) as ChatOut;
}

const CONTACT = {
  name: "Priya Nair",
  company: "Voltline Systems",
  email: "priya@voltline.in",
  phone: "+91 9812345678",
};

function chipIds(out: ChatOut): string[] {
  return out.widgets
    .filter((w): w is Extract<Widget, { type: "chips" }> => w.type === "chips")
    .flatMap((w) => w.options.map((o) => o.id));
}

function uploadKeys(out: ChatOut): string[] {
  return out.widgets
    .filter((w): w is Extract<Widget, { type: "upload" }> => w.type === "upload")
    .map((w) => w.item.key);
}

function checklistItems(
  out: ChatOut,
): { key: string; label: string; status: string; required: boolean }[] {
  const w = out.widgets.find(
    (x): x is Extract<Widget, { type: "checklist" }> => x.type === "checklist",
  );
  return w?.items ?? [];
}

/** open → track:EMS chip → contact → sector → org size → EMS_CHECKLIST. */
async function reachEmsChecklist(): Promise<{ sid: string; entry: ChatOut }> {
  const opened = await chat({ kind: "open" });
  const sid = opened.session_id;
  expect(opened.meta.state).toBe("DISCOVER");
  expect(chipIds(opened)).toContain("track:EMS");

  const picked = await chat({ session_id: sid, kind: "chip", chip_id: "track:EMS" });
  expect(picked.meta.state).toBe("CONTACT");
  expect(picked.meta.track).toBe("EMS");
  expect(
    picked.widgets.some((w) => w.type === "form" && w.form_id === "contact"),
  ).toBe(true);

  const afterContact = await chat({
    session_id: sid,
    kind: "form",
    form: { form_id: "contact", values: CONTACT },
  });
  expect(afterContact.meta.state).toBe("CLIENT_INDUSTRY");
  expect(chipIds(afterContact)).toContain("sec:3"); // Electronics Manufacturing

  const afterSector = await chat({ session_id: sid, kind: "chip", chip_id: "sec:3" });
  expect(afterSector.meta.state).toBe("CLIENT_ORGSIZE");
  expect(chipIds(afterSector)).toContain("org:3"); // EMS (EM)

  const entry = await chat({ session_id: sid, kind: "chip", chip_id: "org:3" });
  expect(entry.meta.state).toBe("EMS_CHECKLIST");
  return { sid, entry };
}

async function uploadFile(
  sid: string,
  itemKey: string,
  filename: string,
  content = "fake-bytes",
): Promise<{ status: number; out?: ChatOut; detail?: string }> {
  const urlRes = await uploadUrlPost(
    jsonReq("/api/upload-url", {
      session_id: sid,
      item_key: itemKey,
      filename,
      bytes: content.length,
    }),
  );
  if (urlRes.status !== 200) {
    return { status: urlRes.status, detail: (await urlRes.json()).detail };
  }
  const issued = await urlRes.json();
  // The issued path is deterministic and session-scoped.
  expect(issued.storage_path).toBe(`${sid}/${itemKey}--${filename}`);
  expect(issued.filename).toBe(filename);
  expect(issued.url).toContain("/api/mock-upload?token=");

  const putRes = await mockUploadPut(
    new NextRequest(`http://test${issued.url}`, {
      method: "PUT",
      body: content,
      headers: { "content-type": "application/octet-stream" },
    }),
  );
  expect(putRes.status).toBe(200);

  const doneRes = await uploadCompletePost(
    jsonReq("/api/upload-complete", {
      session_id: sid,
      item_key: itemKey,
      storage_path: issued.storage_path,
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

interface MemShape {
  retries: MemRetry[];
  leads: Map<string, LeadRow>;
}

function mem(): MemShape {
  return (globalThis as Record<string, unknown>).__xorMemDb as MemShape;
}

beforeEach(() => {
  resetMemoryDb();
  ip = `10.0.7.${++ipCounter}`;
});

describe("EMS journey — chip-driven entry", () => {
  it("issues the client + D01 deal and the early lead on entering the checklist", async () => {
    const { sid, entry } = await reachEmsChecklist();

    // Checklist UI: templates card, checklist widget (all pending), bom upload.
    expect(entry.widgets.some((w) => w.type === "card" && w.title === "Handy templates")).toBe(
      true,
    );
    const items = checklistItems(entry);
    expect(items.map((i) => i.key)).toEqual([
      "bom",
      "gerber",
      "pnp",
      "assembly",
      "cad",
      "test_fw",
    ]);
    expect(items.every((i) => i.status === "pending")).toBe(true);
    expect(uploadKeys(entry)).toEqual(["bom"]);
    expect(entry.meta.progress).toEqual({ done: 0, total: 6, label: "files" });

    // Identity first (ops directive): client code, deal id, lead all exist NOW.
    const db = getDb();
    const s = await db.getSession(sid);
    expect(s!.data.client_code).toMatch(CLIENT_CODE_RE);
    expect(s!.data.deal_id).toMatch(FIRST_DEAL_RE);
    expect(s!.data.deal_id).toBe(`${s!.data.client_code}-D01`);
    expect(entry.messages[0]).toContain(`Filed as ${s!.data.deal_id}`);

    expect(s!.data.lead_ref).toMatch(/^XOR-\d{8}-\d{3}$/);
    const lead = await db.getLead(s!.data.lead_id!);
    expect(lead).not.toBeNull();
    expect(lead!.track).toBe("EMS");
    expect(lead!.company).toBe("Voltline Systems");
    expect(lead!.deal_id).toBe(s!.data.deal_id);
    expect(lead!.summary).toBe("Manufacturing (EMS) — Voltline Systems");

    // Nothing is finalized yet — no handoff rows before the details form.
    expect(mem().retries.length).toBe(0);
    expect(s!.data.finalized).toBe(false);
  });

  it("uploads, skips, details form → DONE with queued mock handoffs; a re-submit cannot double-finalize", async () => {
    const { sid } = await reachEmsChecklist();
    const db = getDb();

    // gerber only accepts archives — the checklist item's rule is enforced.
    const wrong = await uploadFile(sid, "gerber", "layout.xlsx");
    expect(wrong.status).toBe(415);
    expect(wrong.detail).toContain("Gerber");

    const bom = await uploadFile(sid, "bom", "voltline-bom.xlsx");
    expect(bom.status).toBe(200);
    expect(bom.out!.meta.state).toBe("EMS_CHECKLIST");
    expect(bom.out!.meta.progress).toEqual({ done: 1, total: 6, label: "files" });
    expect(uploadKeys(bom.out!)).toEqual(["gerber"]);

    const gerber = await uploadFile(sid, "gerber", "fab-outputs.zip");
    expect(gerber.status).toBe(200);
    expect(uploadKeys(gerber.out!)).toEqual(["pnp"]);

    // Both staged files are already tied to the early lead.
    const leadId = (await db.getSession(sid))!.data.lead_id!;
    const staged = await db.leadFiles(sid);
    expect(staged.map((f) => f.filename).sort()).toEqual([
      "fab-outputs.zip",
      "voltline-bom.xlsx",
    ]);
    expect(staged.every((f) => f.lead_id === leadId)).toBe(true);
    expect(staged.every((f) => f.bytes === "fake-bytes".length)).toBe(true);

    // Skip every optional item via the skip chips.
    let cur = gerber.out!;
    for (const key of ["pnp", "assembly", "cad", "test_fw"]) {
      cur = await chat({ session_id: sid, kind: "chip", chip_id: `skip:${key}` });
    }
    expect(cur.meta.state).toBe("EMS_DETAILS");
    expect(cur.meta.progress).toEqual({ done: 6, total: 6, label: "files" });
    expect(cur.widgets.some((w) => w.type === "form" && w.form_id === "ems_details")).toBe(true);
    const statuses = Object.fromEntries(checklistItems(cur).map((i) => [i.key, i.status]));
    expect(statuses).toEqual({
      bom: "uploaded",
      gerber: "uploaded",
      pnp: "skipped",
      assembly: "skipped",
      cad: "skipped",
      test_fw: "skipped",
    });

    // Details form with a missing required field re-presents the form.
    const incomplete = await chat({
      session_id: sid,
      kind: "form",
      form: { form_id: "ems_details", values: { quantity: "3,000", target_date: "" } },
    });
    expect(incomplete.meta.state).toBe("EMS_DETAILS");
    expect(
      incomplete.widgets.some((w) => w.type === "form" && w.form_id === "ems_details"),
    ).toBe(true);

    const details = {
      quantity: "3,000 pilot + 20k/yr",
      target_date: "pilot by January",
      notes: "ENIG finish, 6 layers",
    };
    const done = await chat({
      session_id: sid,
      kind: "form",
      form: { form_id: "ems_details", values: details },
    });
    expect(done.meta.state).toBe("DONE");
    expect(done.meta.progress).toBeNull();

    const s = await db.getSession(sid);
    const dealId = s!.data.deal_id!;
    expect(dealId).toMatch(FIRST_DEAL_RE);
    expect(done.messages[0]).toContain(`logged as ${dealId}`);
    expect(s!.data.finalized).toBe(true);
    expect(s!.state).toBe("DONE");

    // Checklist statuses recorded on the session record itself.
    expect(s!.data.checklist).toEqual({
      bom: { status: "uploaded", filename: "voltline-bom.xlsx" },
      gerber: { status: "uploaded", filename: "fab-outputs.zip" },
      pnp: { status: "skipped" },
      assembly: { status: "skipped" },
      cad: { status: "skipped" },
      test_fw: { status: "skipped" },
    });

    // The single lead now carries the real summary and details.
    const lead = await db.getLead(s!.data.lead_id!);
    expect(lead!.summary).toBe("PCBA/build RFQ — 2 files received");
    expect(lead!.quantity).toBe(details.quantity);
    expect(lead!.timeline).toBe(details.target_date);
    expect(mem().leads.size).toBe(1);

    // MOCK_DRIVE handoffs: one drive + one sheet row, both pre-resolved.
    const driveRows = mem().retries.filter((r) => r.kind === "drive");
    expect(driveRows.length).toBe(1);
    expect(driveRows[0].resolved_at).not.toBeNull();
    const drivePayload = driveRows[0].payload as {
      deal_id: string;
      files: { filename: string }[];
      summary_md: string;
    };
    expect(drivePayload.deal_id).toBe(dealId);
    expect(drivePayload.files.length).toBe(2);
    expect(drivePayload.files.some((f) => f.filename.includes("bom--voltline-bom.xlsx"))).toBe(
      true,
    );
    expect(
      drivePayload.files.some((f) => f.filename.includes("gerber--fab-outputs.zip")),
    ).toBe(true);
    expect(drivePayload.summary_md).toContain("**uploaded**");
    expect(drivePayload.summary_md).toContain("**skipped**");
    expect(drivePayload.summary_md).toContain(details.quantity);

    const sheetRows = mem().retries.filter((r) => r.kind === "sheet");
    expect(sheetRows.length).toBe(1);
    expect(sheetRows[0].resolved_at).not.toBeNull();
    const sheetJson = JSON.stringify(sheetRows[0].payload);
    expect(sheetJson).toContain("Manufacturing (EMS)");
    expect(sheetJson).toContain(dealId);
    expect(sheetJson).toContain(details.quantity);

    // Re-submitting the SAME details form must not double-finalize.
    const again = await chat({
      session_id: sid,
      kind: "form",
      form: { form_id: "ems_details", values: details },
    });
    expect(again.meta.state).toBe("DONE");
    expect(chipIds(again)).toContain("restart");

    expect(mem().leads.size).toBe(1); // no second lead
    expect(mem().retries.filter((r) => r.kind === "drive").length).toBe(1);
    expect(mem().retries.filter((r) => r.kind === "sheet").length).toBe(1);
    const after = await db.getSession(sid);
    expect(after!.data.finalized).toBe(true);
    expect(after!.data.deal_id).toBe(dealId); // no second deal issued
  });

  it("skipping required items still completes, flagging them for the team", async () => {
    const { sid, entry } = await reachEmsChecklist();

    // Skip everything, required items included.
    let cur = entry;
    const skippedRequired = await chat({ session_id: sid, kind: "chip", chip_id: "skip:bom" });
    expect(skippedRequired.messages[0]).toContain("before a firm quote");
    cur = skippedRequired;
    for (const key of ["gerber", "pnp", "assembly", "cad", "test_fw"]) {
      cur = await chat({ session_id: sid, kind: "chip", chip_id: `skip:${key}` });
    }
    expect(cur.meta.state).toBe("EMS_DETAILS");

    const done = await chat({
      session_id: sid,
      kind: "form",
      form: {
        form_id: "ems_details",
        values: { quantity: "500", target_date: "6 weeks", notes: "" },
      },
    });
    expect(done.meta.state).toBe("DONE");

    const db = getDb();
    const s = await db.getSession(sid);
    expect(Object.values(s!.data.checklist).every((v) => v.status === "skipped")).toBe(true);
    const lead = await db.getLead(s!.data.lead_id!);
    expect(lead!.summary).toBe("PCBA/build RFQ — 0 files received");

    const driveRows = mem().retries.filter((r) => r.kind === "drive");
    expect(driveRows.length).toBe(1);
    const payload = driveRows[0].payload as { files: unknown[]; summary_md: string };
    expect(payload.files.length).toBe(0);
    // Required-but-missing items are flagged in the team summary.
    expect(payload.summary_md).toContain("required — needed for quote");
  });

  it("issues D02 for a returning client's second EMS enquiry", async () => {
    const first = await reachEmsChecklist();
    const firstDeal = (await getDb().getSession(first.sid))!.data.deal_id!;
    expect(firstDeal).toMatch(FIRST_DEAL_RE);

    // Same contact email, fresh session: recognised at the contact step and
    // filed under the SAME client code with the next deal serial.
    const opened = await chat({ kind: "open" });
    const sid = opened.session_id;
    const picked = await chat({ session_id: sid, kind: "chip", chip_id: "track:EMS" });
    expect(picked.meta.state).toBe("CONTACT");
    const entry = await chat({
      session_id: sid,
      kind: "form",
      form: { form_id: "contact", values: CONTACT },
    });
    // Returning clients skip the sector/org-size questions entirely.
    expect(entry.meta.state).toBe("EMS_CHECKLIST");
    expect(entry.messages[0]).toContain("Welcome back");

    const s = await getDb().getSession(sid);
    expect(s!.data.deal_id).toMatch(DEAL_ID_RE);
    expect(s!.data.client_code).toBe(firstDeal.replace(/-D\d{2}$/, ""));
    expect(s!.data.deal_id).toBe(`${s!.data.client_code}-D02`);
  });
});

/**
 * Security & isolation journey — two signed-up users must never see each
 * other's data:
 *  - A (signed in) runs an ODM intake to DONE (LLD generated & downloadable)
 *  - B (different login) sees zero of A's enquiries via /api/me/enquiries
 *  - the transcript route refuses B on A's deal (404 — knowing a deal id is
 *    never enough), and 401s without a verified login
 *  - /api/download 404s on (wrong session id, right filename) and
 *    (right session, wrong filename)
 *  - unauthenticated /api/me/* is 401
 *  - retention contract: enquiries rows carry session_id + created_at
 *  - register-first: the lead row appears EARLY (mid-flow right after the
 *    org-size answer, before finalize) and finalize does not duplicate it
 */
import { beforeEach, describe, expect, it } from "vitest";

process.env.MOCK_LLM = "true";
process.env.MOCK_DRIVE = "true";
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

import { POST as chatPost } from "@/app/api/chat/route";
import { GET as downloadGet } from "@/app/api/download/[session]/[file]/route";
import { DELETE as enquiriesDelete, GET as enquiriesGet } from "@/app/api/me/enquiries/route";
import { GET as transcriptGet } from "@/app/api/me/transcript/route";
import { POST as mockAuthPost } from "@/app/api/mock-auth/route";
import { resetMemoryAuth } from "@/lib/auth-server";
import { resetMemoryDb } from "@/lib/supabase";
import type { ChatIn, ChatOut } from "@/lib/widgets";

// Each actor gets its own source IP so the per-IP rate limiter (burst 20)
// never trips inside a single test.
let ipCounter = 0;
function nextIp(): string {
  return `10.0.3.${++ipCounter}`;
}

function jsonReq(
  url: string,
  body: unknown,
  ip: string,
  token?: string,
): NextRequest {
  return new NextRequest(`http://test${url}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

async function chat(payload: Partial<ChatIn>, ip: string, token?: string): Promise<ChatOut> {
  const res = await chatPost(jsonReq("/api/chat", payload, ip, token));
  expect(res.status).toBe(200);
  return (await res.json()) as ChatOut;
}

async function signup(email: string, ip: string, name = "Test User"): Promise<string> {
  const res = await mockAuthPost(
    jsonReq("/api/mock-auth", { action: "signup", email, password: "hunter2hunter2", name }, ip),
  );
  expect(res.status).toBe(200);
  return (await res.json()).token as string;
}

function meEnquiries(token?: string): ReturnType<typeof enquiriesGet> {
  return enquiriesGet(
    new NextRequest("http://test/api/me/enquiries", {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
  );
}

function meTranscript(deal: string, token?: string): ReturnType<typeof transcriptGet> {
  return transcriptGet(
    new NextRequest(`http://test/api/me/transcript?deal=${encodeURIComponent(deal)}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
  );
}

function download(session: string, file: string): ReturnType<typeof downloadGet> {
  return downloadGet(
    new NextRequest(`http://test/api/download/${session}/${encodeURIComponent(file)}`),
    { params: Promise.resolve({ session, file: encodeURIComponent(file) }) },
  );
}

const ODM_ANSWERS = [
  "smart energy meter for housing societies",
  "LTE, tamper detection, class 1 accuracy",
  "5k first run, 50k per year",
  "under Rs 1500",
  "prototypes in 8 weeks",
  "India first, BIS",
  "similar to existing meters on IndiaMART",
];

/** Signed-in intake through contact + the two company questions. */
async function throughOrgSize(
  email: string,
  ip: string,
  token: string,
  contactName = "Arjun Mehta",
  company = "Acme Devices",
  track: "ODM" | "PRODUCT" = "ODM",
): Promise<{ sid: string; res: ChatOut }> {
  const opened = await chat({ kind: "open" }, ip, token);
  const sid = opened.session_id;
  let res = await chat({ session_id: sid, kind: "chip", chip_id: `track:${track}` }, ip, token);
  expect(res.meta.state).toBe("CONTACT");
  res = await chat(
    {
      session_id: sid,
      kind: "form",
      form: {
        form_id: "contact",
        values: { name: contactName, company, email, phone: "+91 9876543210" },
      },
    },
    ip,
    token,
  );
  expect(res.meta.state).toBe("CLIENT_INDUSTRY");
  res = await chat({ session_id: sid, kind: "chip", chip_id: "sec:4" }, ip, token);
  expect(res.meta.state).toBe("CLIENT_ORGSIZE");
  res = await chat({ session_id: sid, kind: "chip", chip_id: "org:0" }, ip, token);
  return { sid, res };
}

/** Full ODM run to DONE (LLD generated + filed). */
async function odmToDone(
  email: string,
  ip: string,
  token: string,
): Promise<{ sid: string }> {
  const { sid, res } = await throughOrgSize(email, ip, token);
  expect(res.meta.state).toBe("ODM_SLOTS");
  let cur = res;
  for (const ans of ODM_ANSWERS) {
    cur = await chat({ session_id: sid, kind: "text", text: ans }, ip, token);
  }
  expect(cur.meta.state).toBe("ODM_REVIEW");
  cur = await chat({ session_id: sid, kind: "chip", chip_id: "lld:generate" }, ip, token);
  expect(cur.meta.state).toBe("ODM_LLD_REVIEW");
  cur = await chat({ session_id: sid, kind: "chip", chip_id: "lld:accept" }, ip, token);
  expect(cur.meta.state).toBe("ODM_SANCTION");
  cur = await chat({ session_id: sid, kind: "chip", chip_id: "sanction:yes" }, ip, token);
  expect(cur.meta.state).toBe("DONE");
  return { sid };
}

/** Quick PRODUCT intake to DONE for the second user. */
async function productToDone(email: string, ip: string, token: string): Promise<{ sid: string }> {
  const { sid, res } = await throughOrgSize(email, ip, token, "Meera Shah", "Bolt Devices", "PRODUCT");
  expect(res.meta.state).toBe("PRODUCT_CATEGORY");
  let cur = await chat({ session_id: sid, kind: "chip", chip_id: "cat:iot" }, ip, token);
  expect(cur.meta.state).toBe("PRODUCT_DETAILS");
  cur = await chat(
    {
      session_id: sid,
      kind: "form",
      form: {
        form_id: "product_details",
        values: { quantity: "250", timeline: "Q1", customization: "" },
      },
    },
    ip,
    token,
  );
  expect(cur.meta.state).toBe("DONE");
  return { sid };
}

interface EnquiryRow {
  session_id: string | null;
  deal_id: string | null;
  lead_ref: string;
  track: string;
  created_at: string | null;
  status: string;
  lld_url: string | null;
}

beforeEach(() => {
  resetMemoryDb();
  resetMemoryAuth();
});

describe("unauthenticated /api/me/*", () => {
  it("401s with no token and with a bogus bearer token", async () => {
    expect((await meEnquiries()).status).toBe(401);
    expect((await meTranscript("EB-C-26-0001-D01")).status).toBe(401);

    // A made-up token is not a login either.
    expect((await meEnquiries("not-a-real-token")).status).toBe(401);
    expect((await meTranscript("EB-C-26-0001-D01", "not-a-real-token")).status).toBe(401);
  });
});

describe("register-first: the enquiry exists mid-flow", () => {
  it("shows the lead (with session_id + created_at) right after org-size, before finalize", async () => {
    const ip = nextIp();
    const token = await signup("arjun@acme.in", ip);
    const { sid, res } = await throughOrgSize("arjun@acme.in", ip, token);

    // Mid-flow: the intake has NOT finished…
    expect(res.meta.state).toBe("ODM_SLOTS");

    // …yet the enquiry is already listed under the login.
    const listing = await meEnquiries(token);
    expect(listing.status).toBe(200);
    const body = (await listing.json()) as { client: { client_code: string }; enquiries: EnquiryRow[] };
    expect(body.client?.client_code).toMatch(/^EB-C-\d{2}-\d{4}$/);
    expect(body.enquiries.length).toBe(1);

    const row = body.enquiries[0];
    expect(row.deal_id).toBe(`${body.client.client_code}-D01`);
    // Retention contract: every row names its chat session and its date.
    expect(row.session_id).toBe(sid);
    expect(row.created_at).toBeTruthy();
    expect(Number.isFinite(Date.parse(row.created_at!))).toBe(true);
    // Not filed yet — finalize hasn't run.
    expect(row.status).toBe("Received");
    expect(row.lld_url).toBeNull();
  }, 20_000);
});

describe("cross-user isolation after A completes an ODM intake", () => {
  it("B sees zero of A's data; transcript and download refuse wrong owners/combos", async () => {
    // ── A: signed up, full ODM intake to DONE ─────────────────────────────
    const ipA = nextIp();
    const tokenA = await signup("arjun@acme.in", ipA, "Arjun Mehta");
    const { sid: sidA } = await odmToDone("arjun@acme.in", ipA, tokenA);

    const aRes = await meEnquiries(tokenA);
    expect(aRes.status).toBe(200);
    const aBody = (await aRes.json()) as {
      client: { client_code: string };
      enquiries: EnquiryRow[];
    };
    // Finalize upgraded the early lead — it did not duplicate it.
    expect(aBody.enquiries.length).toBe(1);
    const aRow = aBody.enquiries[0];
    // Retention contract on the finished row too.
    expect(aRow.session_id).toBe(sidA);
    expect(aRow.created_at).toBeTruthy();
    expect(Number.isFinite(Date.parse(aRow.created_at!))).toBe(true);
    expect(aRow.deal_id).toMatch(/^EB-C-\d{2}-\d{4}-D01$/);
    expect(aRow.lld_url).toContain(`/api/download/${sidA}/`);

    const lldFile = decodeURIComponent(aRow.lld_url!.split("/").pop()!);

    // ── B: different login, own PRODUCT intake ────────────────────────────
    const ipB = nextIp();
    const tokenB = await signup("meera@bolt.in", ipB, "Meera Shah");
    const { sid: sidB } = await productToDone("meera@bolt.in", ipB, tokenB);

    const bRes = await meEnquiries(tokenB);
    expect(bRes.status).toBe(200);
    const bBody = (await bRes.json()) as {
      client: { client_code: string };
      enquiries: EnquiryRow[];
    };
    // B's view holds only B's enquiry — nothing of A's leaks through.
    expect(bBody.enquiries.length).toBe(1);
    expect(bBody.enquiries[0].session_id).toBe(sidB);
    expect(bBody.enquiries.some((e) => e.session_id === sidA)).toBe(false);
    expect(bBody.client.client_code).not.toBe(aBody.client.client_code);
    expect(bBody.enquiries[0].deal_id).not.toBe(aRow.deal_id);

    // ── transcript scoping ────────────────────────────────────────────────
    const own = await meTranscript(aRow.deal_id!, tokenA);
    expect(own.status).toBe(200);
    const ownBody = (await own.json()) as { messages: { role: string; content: string }[] };
    expect(ownBody.messages.length).toBeGreaterThan(0);

    // B (has a client record of their own) on A's deal: refused.
    const cross = await meTranscript(aRow.deal_id!, tokenB);
    expect([403, 404]).toContain(cross.status);

    // C (signed up, never enquired) on A's deal: refused too.
    const tokenC = await signup("nosy@other.in", nextIp(), "Nosy Person");
    const crossC = await meTranscript(aRow.deal_id!, tokenC);
    expect([403, 404]).toContain(crossC.status);

    // No token: 401.
    expect((await meTranscript(aRow.deal_id!)).status).toBe(401);

    // ── download scoping ──────────────────────────────────────────────────
    // Sanity: the rightful combination serves the PDF…
    const ok = await download(sidA, lldFile);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/pdf");

    // …wrong session id + right filename: 404 (existing foreign session).
    expect((await download(sidB, lldFile)).status).toBe(404);
    // …wrong session id + right filename: 404 (nonexistent session).
    expect((await download(randomUUID(), lldFile)).status).toBe(404);
    // …right session + wrong filename: 404.
    expect((await download(sidA, "LLD-draft-XOR-99999999-999.pdf")).status).toBe(404);
    expect((await download(sidA, "nope.pdf")).status).toBe(404);
  }, 40_000);
});

describe("enquiry deletion", () => {
  it("owner-only: forecloses cross-account deletes, then removes everything", async () => {
    const ipA = nextIp();
    const ipB = nextIp();
    const tokenA = await signup("owner@acme.in", ipA, "Owner A");
    const tokenB = await signup("intruder@rival.in", ipB, "Intruder B");
    const { sid } = await throughOrgSize("owner@acme.in", ipA, tokenA);

    const listed = await (await meEnquiries(tokenA)).json();
    expect(listed.enquiries.length).toBe(1);
    const leadRef = listed.enquiries[0].lead_ref as string;

    const del = (token: string | undefined, lead_ref: string) =>
      enquiriesDelete(
        new NextRequest("http://test/api/me/enquiries", {
          method: "DELETE",
          body: JSON.stringify({ lead_ref }),
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        }),
      );

    // No token → 401; another account → 404; A's list survives both.
    expect((await del(undefined, leadRef)).status).toBe(401);
    expect((await del(tokenB, leadRef)).status).toBe(404);
    expect(
      ((await (await meEnquiries(tokenA)).json()) as { enquiries: unknown[] }).enquiries.length,
    ).toBe(1);

    // The owner's delete removes the row AND the conversation behind it.
    expect((await del(tokenA, leadRef)).status).toBe(200);
    expect(
      ((await (await meEnquiries(tokenA)).json()) as { enquiries: unknown[] }).enquiries.length,
    ).toBe(0);
    const db = (await import("@/lib/supabase")).getDb();
    expect(await db.getSession(sid)).toBeNull();
    expect((await db.recentMessages(sid, 10)).length).toBe(0);

    // Deleting it again: cleanly gone.
    expect((await del(tokenA, leadRef)).status).toBe(404);
  }, 30_000);
});

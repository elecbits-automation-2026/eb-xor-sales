/**
 * Client accounts (demo-mode auth) + the ClientID/DealID system:
 *  - signup → signin → chat with a bearer token → finalize → the enquiry
 *    appears under /api/me/enquiries for THAT login only
 *  - SOP-compliant IDs (Eb-SOP v1.2): clients EB-C-YY-nnnn, deals
 *    EB-C-YY-nnnn-Dss (client ID verbatim + D-marked per-client sequence)
 *  - returning clients (same contact email) skip the company questions and
 *    reuse the client code; deal sequence increments
 */
import { beforeEach, describe, expect, it } from "vitest";

process.env.MOCK_LLM = "true";
process.env.MOCK_DRIVE = "true";
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { NextRequest } from "next/server";

import { POST as chatPost } from "@/app/api/chat/route";
import { GET as enquiriesGet } from "@/app/api/me/enquiries/route";
import { POST as mockAuthPost } from "@/app/api/mock-auth/route";
import { resetMemoryAuth } from "@/lib/auth-server";
import { getDb, resetMemoryDb } from "@/lib/supabase";
import type { ChatIn, ChatOut } from "@/lib/widgets";

let ipCounter = 200;
let ip = "10.0.2.1";

function jsonReq(url: string, body?: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://test${url}`, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers },
  });
}

async function chat(payload: Partial<ChatIn>, token?: string): Promise<ChatOut> {
  const res = await chatPost(
    jsonReq("/api/chat", payload, token ? { authorization: `Bearer ${token}` } : {}),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as ChatOut;
}

async function signup(email: string, name = "Test User"): Promise<string> {
  const res = await mockAuthPost(
    jsonReq("/api/mock-auth", { action: "signup", email, password: "hunter2hunter2", name }),
  );
  expect(res.status).toBe(200);
  return (await res.json()).token as string;
}

async function runProductIntake(
  email: string,
  token?: string,
  expectNewClient = true,
): Promise<string> {
  const opened = await chat({ kind: "open" }, token);
  const sid = opened.session_id;
  let res = await chat({ session_id: sid, kind: "chip", chip_id: "track:PRODUCT" }, token);
  expect(res.meta.state).toBe("CONTACT");
  res = await chat(
    {
      session_id: sid,
      kind: "form",
      form: {
        form_id: "contact",
        values: { name: "Meera Shah", company: "Bolt Devices", email, phone: "+91 9111111111" },
      },
    },
    token,
  );
  if (expectNewClient) {
    expect(res.meta.state).toBe("CLIENT_INDUSTRY");
    res = await chat({ session_id: sid, kind: "chip", chip_id: "sec:4" }, token);
    expect(res.meta.state).toBe("CLIENT_ORGSIZE");
    res = await chat({ session_id: sid, kind: "chip", chip_id: "org:0" }, token);
  } else {
    // returning client — company questions skipped, client code reused
    expect(res.meta.state).toBe("PRODUCT_CATEGORY");
    expect(res.messages[0]).toContain("Welcome back");
  }
  expect(res.meta.state).toBe("PRODUCT_CATEGORY");
  res = await chat({ session_id: sid, kind: "chip", chip_id: "cat:iot" }, token);
  res = await chat(
    {
      session_id: sid,
      kind: "form",
      form: {
        form_id: "product_details",
        values: { quantity: "250", timeline: "Q1", customization: "" },
      },
    },
    token,
  );
  expect(res.meta.state).toBe("DONE");
  return sid;
}

beforeEach(() => {
  resetMemoryDb();
  resetMemoryAuth();
  ip = `10.0.2.${++ipCounter}`;
});

describe("client IDs and deal IDs", () => {
  it("issues SOP-compliant identifiers and nests deals under the client", async () => {
    const sid = await runProductIntake("meera@bolt.in");
    const db = getDb();
    const s = await db.getSession(sid);
    expect(s?.data.client_code).toMatch(/^EB-C-\d{2}-\d{4}$/);
    // Eb-SOP v2.0: deal = client ID verbatim + D-marked per-client sequence.
    expect(s?.data.deal_id).toBe(`${s!.data.client_code}-D01`);

    // second enquiry, same contact email → same client, next deal number
    const sid2 = await runProductIntake("meera@bolt.in", undefined, false);
    const s2 = await db.getSession(sid2);
    expect(s2?.data.client_code).toBe(s?.data.client_code);
    expect(s2?.data.deal_id).toBe(`${s!.data.client_code}-D02`);

    // the drive handoff payload carries the client/deal hierarchy
    const retries = (
      (globalThis as Record<string, unknown>).__xorMemDb as {
        retries: { kind: string; payload: Record<string, unknown> }[];
      }
    ).retries.filter((r) => r.kind === "drive");
    expect(retries[0].payload.client_code).toBe(s?.data.client_code);
    expect(retries[0].payload.deal_id).toBe(s?.data.deal_id);
  });
});

describe("account view", () => {
  it("lists only the verified login's enquiries", async () => {
    const token = await signup("meera@bolt.in");
    await runProductIntake("meera@bolt.in", token);

    const mine = await enquiriesGet(
      new NextRequest("http://test/api/me/enquiries", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(mine.status).toBe(200);
    const body = await mine.json();
    expect(body.client.client_code).toMatch(/^EB-C-\d{2}-\d{4}$/);
    expect(body.enquiries.length).toBe(1);
    expect(body.enquiries[0].deal_id).toMatch(/^EB-C-\d{2}-\d{4}-D01$/);
    expect(body.enquiries[0].track).toBe("PRODUCT");

    // a different login sees nothing of it
    const stranger = await signup("attacker@other.in");
    const theirs = await enquiriesGet(
      new NextRequest("http://test/api/me/enquiries", {
        headers: { authorization: `Bearer ${stranger}` },
      }),
    );
    expect((await theirs.json()).enquiries ?? []).toHaveLength(0);

    // and no token is a 401
    const anon = await enquiriesGet(new NextRequest("http://test/api/me/enquiries"));
    expect(anon.status).toBe(401);
  });

  it("attaches enquiries by verified email even when made logged-out", async () => {
    await runProductIntake("meera@bolt.in"); // anonymous intake
    const token = await signup("meera@bolt.in"); // later signs up with same email
    const res = await enquiriesGet(
      new NextRequest("http://test/api/me/enquiries", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    const body = await res.json();
    expect(body.enquiries.length).toBe(1);
  });
});

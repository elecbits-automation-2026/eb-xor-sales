/**
 * Handoff failure path: a Drive error must land in handoff_retries with the
 * full payload, the visitor UX must still complete, and the retry route must
 * replay and resolve it. Google modules are mocked — no network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.MOCK_LLM = "true";
process.env.CRON_SECRET = "test-cron-secret";
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

vi.mock("@/lib/drive", () => ({
  driveHandoff: vi.fn(),
  fetchTemplates: vi.fn(async () => []),
  listKbFiles: vi.fn(async () => []),
  exportKbFileText: vi.fn(async () => null),
}));
vi.mock("@/lib/sheets", () => ({
  appendFunnelRow: vi.fn(async () => undefined),
}));

import { NextRequest } from "next/server";

import { POST as chatPost } from "@/app/api/chat/route";
import { POST as retryPost } from "@/app/api/handoff/retry/route";
import { driveHandoff } from "@/lib/drive";
import { getDb, resetMemoryDb } from "@/lib/supabase";
import type { ChatIn, ChatOut } from "@/lib/widgets";

let ipCounter = 100;
let ip = "10.0.1.1";

function jsonReq(url: string, body?: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://test${url}`, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers },
  });
}

async function chat(payload: Partial<ChatIn>): Promise<ChatOut> {
  const res = await chatPost(jsonReq("/api/chat", payload));
  expect(res.status).toBe(200);
  return (await res.json()) as ChatOut;
}

async function runProductIntake(): Promise<string> {
  const opened = await chat({ kind: "open" });
  const sid = opened.session_id;
  let res = await chat({ session_id: sid, kind: "chip", chip_id: "track:PRODUCT" });
  expect(res.meta.state).toBe("CONTACT");
  res = await chat({
    session_id: sid,
    kind: "form",
    form: {
      form_id: "contact",
      values: {
        name: "Priya Rao",
        company: "Nimbus Retail",
        email: "priya@nimbus.in",
        phone: "+91 9000000000",
      },
    },
  });
  expect(res.meta.state).toBe("CLIENT_INDUSTRY");
  res = await chat({ session_id: sid, kind: "chip", chip_id: "sec:4" });
  expect(res.meta.state).toBe("CLIENT_ORGSIZE");
  res = await chat({ session_id: sid, kind: "chip", chip_id: "org:0" });
  expect(res.meta.state).toBe("PRODUCT_CATEGORY");
  res = await chat({ session_id: sid, kind: "chip", chip_id: "cat:iot" });
  res = await chat({
    session_id: sid,
    kind: "form",
    form: {
      form_id: "product_details",
      values: { quantity: "1000", timeline: "Q4", customization: "" },
    },
  });
  expect(res.meta.state).toBe("DONE");
  return sid;
}

beforeEach(() => {
  resetMemoryDb();
  vi.mocked(driveHandoff).mockReset();
  ip = `10.0.1.${++ipCounter}`;
  process.env.MOCK_DRIVE = "false";
});

describe("handoff failure path", () => {
  it("records the retry, completes the visitor UX, and the retry route resolves it", async () => {
    vi.mocked(driveHandoff).mockRejectedValueOnce(new Error("Drive is down"));
    vi.mocked(driveHandoff).mockResolvedValue({
      client_folder_id: "client-folder-1",
      client_folder_url: "https://drive.google.com/drive/folders/client-folder-1",
      folder_id: "folder-123",
      folder_url: "https://drive.google.com/drive/folders/folder-123",
      file_ids: {},
    });

    const sid = await runProductIntake(); // visitor UX completed despite failure

    const db = getDb();
    const s = await db.getSession(sid);
    const leadId = s!.data.lead_id!;
    let lead = await db.getLead(leadId);
    expect(lead?.drive_committed).toBe(false);
    expect(lead?.sheet_appended).toBe(true); // sheets mock succeeded

    const open = await db.unresolvedHandoffRetries();
    expect(open.length).toBe(1);
    expect(open[0].kind).toBe("drive");
    expect(open[0].payload).toHaveProperty("summary_md");

    // wrong/missing auth is refused
    const unauthorized = await retryPost(jsonReq("/api/handoff/retry"));
    expect(unauthorized.status).toBe(401);

    // authorized retry replays and resolves
    const ok = await retryPost(
      jsonReq("/api/handoff/retry", undefined, {
        authorization: `Bearer ${process.env.CRON_SECRET}`,
      }),
    );
    expect(ok.status).toBe(200);

    expect((await db.unresolvedHandoffRetries()).length).toBe(0);
    lead = await db.getLead(leadId);
    expect(lead?.drive_committed).toBe(true);
    expect(lead?.drive_folder_url).toContain("folder-123");
  });
});

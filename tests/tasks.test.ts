/**
 * The "Background tasks" activity feed: every finalize pipeline step lands
 * in the feed with the right status, GET /api/tasks serves it per session,
 * and a successful handoff retry flips the failed step to completed.
 * Google modules are mocked — no network.
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
import { GET as tasksGet } from "@/app/api/tasks/route";
import { driveHandoff } from "@/lib/drive";
import { resetMemoryDb, type TaskRow } from "@/lib/supabase";
import type { ChatIn, ChatOut } from "@/lib/widgets";

let ipCounter = 300;
let ip = "10.0.3.1";

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
  res = await chat({
    session_id: sid,
    kind: "form",
    form: {
      form_id: "contact",
      values: {
        name: "Dev Patel",
        company: "Arka Motion",
        email: "dev@arka.in",
        phone: "+91 9222222222",
      },
    },
  });
  res = await chat({ session_id: sid, kind: "chip", chip_id: "sec:4" });
  res = await chat({ session_id: sid, kind: "chip", chip_id: "org:0" });
  res = await chat({ session_id: sid, kind: "chip", chip_id: "cat:iot" });
  res = await chat({
    session_id: sid,
    kind: "form",
    form: {
      form_id: "product_details",
      values: { quantity: "500", timeline: "Q2", customization: "" },
    },
  });
  expect(res.meta.state).toBe("DONE");
  return sid;
}

async function feed(sid: string): Promise<TaskRow[]> {
  const res = await tasksGet(new NextRequest(`http://test/api/tasks?session=${sid}`));
  expect(res.status).toBe(200);
  return ((await res.json()) as { tasks: TaskRow[] }).tasks;
}

beforeEach(() => {
  resetMemoryDb();
  vi.mocked(driveHandoff).mockReset();
  ip = `10.0.3.${++ipCounter}`;
  process.env.MOCK_DRIVE = "false";
});

describe("background tasks feed", () => {
  it("records every pipeline step, exposes it per session, and marks retry recovery", async () => {
    vi.mocked(driveHandoff).mockRejectedValueOnce(new Error("Drive is down"));
    vi.mocked(driveHandoff).mockResolvedValue({
      client_folder_id: "client-folder-1",
      client_folder_url: "https://drive.google.com/drive/folders/client-folder-1",
      folder_id: "folder-123",
      folder_url: "https://drive.google.com/drive/folders/folder-123",
      file_ids: {},
    });

    const sid = await runProductIntake();

    const byLabel = new Map((await feed(sid)).map((t) => [t.label, t]));
    expect(byLabel.get("Issue client ID")?.status).toBe("completed");
    expect(byLabel.get("Issue client ID")?.detail).toMatch(/^EB-C-\d{2}-\d{4}$/);
    expect(byLabel.get("Register deal")?.status).toBe("completed");
    expect(byLabel.get("Register deal")?.detail).toMatch(/^EB-C-\d{2}-\d{4}-D01$/);
    expect(byLabel.get("Log to sales funnel")?.status).toBe("completed");
    // client-facing failure detail: the retry promise, never the raw error
    const drive = byLabel.get("Create Drive workspace");
    expect(drive?.status).toBe("failed");
    expect(drive?.detail).toBe("queued for automatic retry");
    expect(drive?.detail).not.toContain("Drive is down");

    // the retry route resolves the handoff AND flips the feed row
    const ok = await retryPost(
      jsonReq("/api/handoff/retry", undefined, {
        authorization: `Bearer ${process.env.CRON_SECRET}`,
      }),
    );
    expect(ok.status).toBe(200);
    const after = new Map((await feed(sid)).map((t) => [t.label, t]));
    expect(after.get("Create Drive workspace")?.status).toBe("completed");
    expect(after.get("Create Drive workspace")?.detail).toBe("recovered by retry");

    // another session sees nothing of it
    expect(await feed("00000000-0000-4000-8000-000000000000")).toHaveLength(0);
    // and a malformed id is an empty feed, not an error
    expect(await feed("not-a-session")).toHaveLength(0);
  });

  it("notes the pipeline as demo-mode steps when Drive is mocked", async () => {
    process.env.MOCK_DRIVE = "true";
    const sid = await runProductIntake();
    const labels = (await feed(sid)).map((t) => `${t.label}:${t.status}`);
    expect(labels).toContain("Issue client ID:completed");
    expect(labels).toContain("Register deal:completed");
    expect(labels).toContain("Create Drive workspace:completed");
    expect(labels).toContain("Log to sales funnel:completed");
  });
});

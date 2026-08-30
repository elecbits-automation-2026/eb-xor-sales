/**
 * Ad-hoc attachments (composer paperclip / pasted screenshots): the
 * "attachment" item is accepted at ANY state via the same signed-URL flow,
 * records a lead_files row, delivers to Drive when the deal folder exists,
 * and never advances the checklist state machine. Google modules are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.MOCK_LLM = "true";
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

vi.mock("@/lib/drive", () => ({
  driveHandoff: vi.fn(),
  provisionDealFolders: vi.fn(),
  uploadStagedFile: vi.fn(async () => "drive-file-9"),
  fetchTemplates: vi.fn(async () => []),
  listKbFiles: vi.fn(async () => []),
  exportKbFileText: vi.fn(async () => null),
}));
vi.mock("@/lib/sheets", () => ({
  appendFunnelRow: vi.fn(async () => undefined),
}));

import { NextRequest } from "next/server";

import { POST as chatPost } from "@/app/api/chat/route";
import { PUT as mockUploadPut } from "@/app/api/mock-upload/route";
import { POST as uploadCompletePost } from "@/app/api/upload-complete/route";
import { POST as uploadUrlPost } from "@/app/api/upload-url/route";
import { uploadStagedFile } from "@/lib/drive";
import { getDb, resetMemoryDb } from "@/lib/supabase";
import type { ChatIn, ChatOut } from "@/lib/widgets";

let ipCounter = 100;
let ip = "10.0.2.1";

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

async function uploadFile(
  sid: string,
  itemKey: string,
  filename: string,
  content = "fake-bytes",
): Promise<{ status: number; out?: ChatOut; detail?: string }> {
  const urlRes = await uploadUrlPost(
    jsonReq("/api/upload-url", { session_id: sid, item_key: itemKey, filename, bytes: content.length }),
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
    jsonReq("/api/upload-complete", {
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

/** Drive a fresh session to EMS_CHECKLIST (new client, both company chips). */
async function reachEmsChecklist(): Promise<string> {
  const opened = await chat({ kind: "open" });
  const sid = opened.session_id;
  let cur = await chat({
    session_id: sid,
    kind: "text",
    text: "I have gerbers and BoM ready, need PCB assembly for 5000 units",
  });
  expect(cur.meta.state).toBe("TRACK_CONFIRM");
  cur = await chat({ session_id: sid, kind: "chip", chip_id: "confirm:yes" });
  cur = await chat({
    session_id: sid,
    kind: "form",
    form: {
      form_id: "contact",
      values: {
        name: "Arjun Mehta",
        company: "Acme Devices",
        email: "arjun@acme.in",
        phone: "+91 9876543210",
      },
    },
  });
  expect(cur.meta.state).toBe("CLIENT_INDUSTRY");
  cur = await chat({ session_id: sid, kind: "chip", chip_id: "sec:4" });
  cur = await chat({ session_id: sid, kind: "chip", chip_id: "org:0" });
  expect(cur.meta.state).toBe("EMS_CHECKLIST");
  return sid;
}

beforeEach(() => {
  resetMemoryDb();
  vi.mocked(uploadStagedFile).mockClear();
  ip = `10.0.2.${++ipCounter}`;
  process.env.MOCK_DRIVE = "true";
});

describe("upload-url for attachments", () => {
  it("accepts a .png in any state and rejects an .exe with 415", async () => {
    const opened = await chat({ kind: "open" }); // fresh session — DISCOVER
    const sid = opened.session_id;

    const ok = await uploadUrlPost(
      jsonReq("/api/upload-url", {
        session_id: sid,
        item_key: "attachment",
        filename: "board-photo.png",
        bytes: 10,
      }),
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()).storage_path).toBe(`${sid}/attachment--board-photo.png`);

    const bad = await uploadUrlPost(
      jsonReq("/api/upload-url", {
        session_id: sid,
        item_key: "attachment",
        filename: "payload.exe",
        bytes: 10,
      }),
    );
    expect(bad.status).toBe(415);
    expect((await bad.json()).detail).toContain("Attachment");
  });
});

describe("attachment roundtrip", () => {
  it("records the lead_files row and does not change state at DISCOVER", async () => {
    const opened = await chat({ kind: "open" });
    const sid = opened.session_id;

    const res = await uploadFile(sid, "attachment", "screenshot-142530.png");
    expect(res.status).toBe(200);
    expect(res.out!.meta.state).toBe("DISCOVER");
    expect(res.out!.messages[0]).toContain("screenshot-142530.png is attached");

    const db = getDb();
    const files = await db.leadFiles(sid);
    expect(files.length).toBe(1);
    expect(files[0].item_key).toBe("attachment");
    expect(files[0].storage_path).toBe(`${sid}/attachment--screenshot-142530.png`);

    const s = await db.getSession(sid);
    expect(s!.data.checklist).toEqual({}); // no checklist state invented
    const tasks = await db.tasksForSession(sid);
    expect(tasks.some((t) => t.label === "Receive screenshot-142530.png")).toBe(true);
  });

  it("mid-checklist: keeps EMS un-advanced and delivers straight to Drive", async () => {
    const sid = await reachEmsChecklist();

    // Deal folder already provisioned → immediate delivery path.
    const db = getDb();
    const s = await db.getSession(sid);
    s!.data.drive = { folder_id: "deal-folder-1" };
    await db.saveSession(s!);
    process.env.MOCK_DRIVE = "false";

    const res = await uploadFile(sid, "attachment", "pinout.png");
    expect(res.status).toBe(200);
    expect(res.out!.meta.state).toBe("EMS_CHECKLIST");
    expect(res.out!.meta.progress?.done).toBe(0); // checklist untouched
    // The resume widget still asks for the FIRST checklist item.
    expect(
      res.out!.widgets.some((w) => w.type === "upload" && w.item.key === "bom"),
    ).toBe(true);
    expect((await db.getSession(sid))!.data.checklist).toEqual({});

    expect(uploadStagedFile).toHaveBeenCalledTimes(1);
    const [folderId, name, path] = vi.mocked(uploadStagedFile).mock.calls[0];
    expect(folderId).toBe("deal-folder-1");
    expect(name).toContain("attachment--pinout.png");
    expect(path).toBe(`${sid}/attachment--pinout.png`);
    const attachment = (await db.leadFiles(sid)).find((f) => f.item_key === "attachment");
    expect(attachment?.drive_file_id).toBe("drive-file-9");

    // Checklist keys still advance exactly as before.
    const bom = await uploadFile(sid, "bom", "acme-bom.xlsx");
    expect(bom.status).toBe(200);
    expect(
      bom.out!.widgets.some((w) => w.type === "upload" && w.item.key === "gerber"),
    ).toBe(true);
    expect((await db.getSession(sid))!.data.checklist.bom).toEqual({
      status: "uploaded",
      filename: "acme-bom.xlsx",
    });
  });
});

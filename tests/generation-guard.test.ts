/**
 * One generation at a time + honest status while it runs:
 *  - text sent during a running revision ("are you making changes") gets a
 *    status reply and must NOT spawn a second concurrent generation
 *  - the generate chips are guarded the same way
 *  - a resume/open in a review state re-presents the draft's download card
 */
import { beforeEach, describe, expect, it } from "vitest";

process.env.MOCK_LLM = "true";
process.env.MOCK_DRIVE = "true";
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { NextRequest } from "next/server";

import { POST as chatPost } from "@/app/api/chat/route";
import { getDb, resetMemoryDb } from "@/lib/supabase";
import type { ChatIn, ChatOut, Widget } from "@/lib/widgets";

let ipCounter = 0;
let ip = "10.0.7.1";

function jsonReq(body: unknown): NextRequest {
  return new NextRequest("http://test/api/chat", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
  });
}

async function chat(payload: Partial<ChatIn>): Promise<ChatOut> {
  const res = await chatPost(jsonReq(payload));
  expect(res.status).toBe(200);
  return (await res.json()) as ChatOut;
}

async function reachLldReview(): Promise<string> {
  const opened = await chat({ kind: "open" });
  const sid = opened.session_id;
  let cur = await chat({
    session_id: sid,
    kind: "text",
    text: "design a smart energy meter for housing societies",
  });
  cur = await chat({ session_id: sid, kind: "chip", chip_id: "confirm:yes" });
  cur = await chat({
    session_id: sid,
    kind: "form",
    form: {
      form_id: "contact",
      values: { name: "A", company: "Acme", email: "a@acme.in", phone: "+91 9876543210" },
    },
  });
  if (cur.meta.state === "CLIENT_INDUSTRY") {
    cur = await chat({ session_id: sid, kind: "chip", chip_id: "sec:4" });
    cur = await chat({ session_id: sid, kind: "chip", chip_id: "org:0" });
  }
  for (const ans of ["meter", "LTE", "5k", "Rs 1500", "8 weeks", "BIS", "IndiaMART"]) {
    cur = await chat({ session_id: sid, kind: "text", text: ans });
  }
  expect(cur.meta.state).toBe("ODM_REVIEW");
  cur = await chat({ session_id: sid, kind: "chip", chip_id: "lld:generate" });
  expect(cur.meta.state).toBe("ODM_LLD_REVIEW");
  return sid;
}

beforeEach(() => {
  resetMemoryDb();
  ip = `10.0.7.${++ipCounter}`;
});

describe("concurrent-generation guard", () => {
  it("status question during a running revision gets a status reply, not a second rewrite", async () => {
    const sid = await reachLldReview();
    const db = getDb();
    await db.insertTask(sid, "Revise the LLD", "running", "web research: …");
    const before = (await db.tasksForSession(sid)).length;

    const res = await chat({ session_id: sid, kind: "text", text: "are you making changes ?" });
    expect(res.messages[0]).toContain("running right now");
    expect(res.meta.state).toBe("ODM_LLD_REVIEW"); // state untouched

    const after = await db.tasksForSession(sid);
    expect(after.length).toBe(before); // no new generation task spawned
    expect(after.filter((t) => t.label === "Revise the LLD" && t.status === "running").length).toBe(1);
  });

  it("the regen chip is guarded too, and a reopen re-presents the draft card", async () => {
    const sid = await reachLldReview();
    const db = getDb();
    await db.insertTask(sid, "Revise the LLD", "running", "writing the document");

    const res = await chat({ session_id: sid, kind: "chip", chip_id: "lld:regen" });
    expect(res.messages[0]).toContain("running right now");

    // Reopen (reconnect path): the LLD download card must come back.
    const reopened = await chat({ session_id: sid, kind: "open" });
    const cards = reopened.widgets.filter(
      (w): w is Extract<Widget, { type: "card" }> => w.type === "card",
    );
    expect(
      cards.some((c) => c.links.some((l) => l.url.includes("/api/download/"))),
      "draft download card missing on reopen",
    ).toBe(true);
  });
});

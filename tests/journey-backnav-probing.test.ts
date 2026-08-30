/**
 * Conversation-robustness journey — mock mode, no keys, no network:
 *  - TRACK_CONFIRM: a typed "yes that's right, …" advances (never loops) and,
 *    for a recognised client who lands straight in ODM_SLOTS, the same
 *    message seeds product_concept (mock extractSlots fills the asked slot
 *    with the raw text)
 *  - chip "back": steps to the previous ODM slot, pops the last slot from
 *    ODM_REVIEW, returns ODM_LLD_REVIEW → ODM_REVIEW; issued identities
 *    (deal_id, client_code) survive every back
 *  - the slot PROBE path: unreachable through the public API in mock mode
 *    (mock extractSlots force-fills), so a controlled llm mock flips
 *    extractSlots into "nothing extracted" mode and drives the re-ask /
 *    third-strike-verbatim behaviour through the real handlers
 *  - chip "restart": a brand-new session; the old one stays intact
 *  - kind "open" on an existing session: history[] replays the stored
 *    transcript in order, without duplication
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.MOCK_LLM = "true";
process.env.MOCK_DRIVE = "true";
process.env.MAX_PROBE_TURNS = "3"; // pin the default so the 3-strike test is exact
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { NextRequest } from "next/server";

import { POST as chatPost } from "@/app/api/chat/route";
import { POST as mockAuthPost } from "@/app/api/mock-auth/route";
import { resetMemoryAuth } from "@/lib/auth-server";
import { getDb, resetMemoryDb } from "@/lib/supabase";
import type { ChatIn, ChatOut, Msg, SessionData, Widget } from "@/lib/widgets";

// In mock mode llm.extractSlots always force-fills the asked slot with the
// raw text, so odmSlots' probe (re-ask) branch can never trigger through the
// chat API. This wrapper passes through to the real implementation unless a
// test flips `active`, in which case it extracts nothing — exactly the
// "gibberish / off-topic" judgement the real model would make.
const probeCtl = vi.hoisted(() => ({ active: false, calls: 0 }));
vi.mock("@/lib/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm")>();
  const extractSlots: typeof actual.extractSlots = async (...args) => {
    if (probeCtl.active) {
      probeCtl.calls += 1;
      return { updates: {}, ack: "Hmm — that doesn't tell me what you're building." };
    }
    return actual.extractSlots(...args);
  };
  return { ...actual, extractSlots };
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let ipCounter = 0;
let ip = "10.0.7.1";

function jsonReq(url: string, method: string, body?: unknown, token?: string): NextRequest {
  return new NextRequest(`http://test${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

async function chat(payload: Partial<ChatIn>, token?: string): Promise<ChatOut> {
  const res = await chatPost(jsonReq("/api/chat", "POST", payload, token));
  expect(res.status).toBe(200);
  return (await res.json()) as ChatOut;
}

async function signup(email: string, name: string): Promise<string> {
  const res = await mockAuthPost(
    jsonReq("/api/mock-auth", "POST", {
      action: "signup",
      email,
      password: "hunter2hunter2",
      name,
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()).token as string;
}

const CONTACT = {
  name: "Arjun Mehta",
  company: "Acme Devices",
  email: "arjun@acme.in",
  phone: "+91 9876543210",
};

// mock triage: "idea" + "design" → ODM, confidence 0.9 → TRACK_CONFIRM
const ODM_TRIGGER = "we have an idea for a GPS tracker, want you to design it";
// matches the typed-affirmation regex AND carries substance (8 words > 4)
const AFFIRM_WITH_SUBSTANCE = "yes that's right, a GPS tracker for buses";

const ODM_ANSWERS = [
  "a 4G GPS tracker for city buses",
  "LTE, GPS + IRNSS, CAN bus reading, IP67",
  "2k pilot, 20k per year",
  "under Rs 2000",
  "prototypes in 10 weeks",
  "India, AIS-140",
  "similar to existing AIS-140 trackers on IndiaMART",
];

interface ProbedData extends SessionData {
  slot_probes?: Record<string, number>;
}

async function sessionData(sid: string): Promise<ProbedData> {
  const s = await getDb().getSession(sid);
  expect(s, `session ${sid} should exist`).not.toBeNull();
  return s!.data as ProbedData;
}

function chipIds(res: ChatOut): string[] {
  return res.widgets
    .filter((w): w is Extract<Widget, { type: "chips" }> => w.type === "chips")
    .flatMap((w) => w.options.map((o) => o.id));
}

function cardBodies(res: ChatOut): string {
  return res.widgets
    .filter((w): w is Extract<Widget, { type: "card" }> => w.type === "card")
    .map((w) => `${w.title}\n${w.body}`)
    .join("\n");
}

/** Anonymous new-client intake driven to the first ODM question. */
async function odmToSlots(): Promise<{ sid: string; res: ChatOut }> {
  const opened = await chat({ kind: "open" });
  const sid = opened.session_id;
  let res = await chat({ session_id: sid, kind: "text", text: ODM_TRIGGER });
  expect(res.meta.state).toBe("TRACK_CONFIRM");
  res = await chat({ session_id: sid, kind: "chip", chip_id: "confirm:yes" });
  expect(res.meta.state).toBe("CONTACT");
  res = await chat({
    session_id: sid,
    kind: "form",
    form: { form_id: "contact", values: CONTACT },
  });
  expect(res.meta.state).toBe("CLIENT_INDUSTRY");
  res = await chat({ session_id: sid, kind: "chip", chip_id: "sec:4" });
  expect(res.meta.state).toBe("CLIENT_ORGSIZE");
  res = await chat({ session_id: sid, kind: "chip", chip_id: "org:0" });
  expect(res.meta.state).toBe("ODM_SLOTS");
  return { sid, res };
}

beforeEach(() => {
  resetMemoryDb();
  resetMemoryAuth();
  ip = `10.0.7.${++ipCounter}`;
  probeCtl.active = false;
  probeCtl.calls = 0;
});

describe("TRACK_CONFIRM free-text affirmation", () => {
  it("advances an anonymous visitor to CONTACT — no re-confirm loop", async () => {
    const opened = await chat({ kind: "open" });
    const sid = opened.session_id;
    let res = await chat({ session_id: sid, kind: "text", text: ODM_TRIGGER });
    expect(res.meta.state).toBe("TRACK_CONFIRM");
    expect(res.meta.track).toBeNull(); // not locked until confirmed

    res = await chat({ session_id: sid, kind: "text", text: AFFIRM_WITH_SUBSTANCE });
    // The typed "yes" must behave exactly like tapping confirm:yes — the
    // track locks and the flow moves on instead of asking again.
    expect(res.meta.state).toBe("CONTACT");
    expect(res.meta.track).toBe("ODM");
    expect(res.widgets.some((w) => w.type === "form" && w.form_id === "contact")).toBe(true);

    const d = await sessionData(sid);
    expect(d.proposed_track).toBe("ODM");
  });

  it("carries the substance into product_concept for a recognised client", async () => {
    const token = await signup("ravi@transitco.in", "Ravi Kumar");

    // Enquiry #1 binds a client record to this login (created at the moment
    // the intake reaches the track — no need to finish the flow).
    const s1 = await chat({ kind: "open" }, token);
    let res = await chat({ session_id: s1.session_id, kind: "chip", chip_id: "track:ODM" }, token);
    expect(res.meta.state).toBe("CONTACT");
    res = await chat(
      {
        session_id: s1.session_id,
        kind: "form",
        form: {
          form_id: "contact",
          values: { name: "Ravi Kumar", company: "TransitCo", email: "ravi@transitco.in", phone: "+91 9000000001" },
        },
      },
      token,
    );
    expect(res.meta.state).toBe("CLIENT_INDUSTRY");
    res = await chat({ session_id: s1.session_id, kind: "chip", chip_id: "sec:4" }, token);
    res = await chat({ session_id: s1.session_id, kind: "chip", chip_id: "org:0" }, token);
    expect(res.meta.state).toBe("ODM_SLOTS");
    const d1 = await sessionData(s1.session_id);
    expect(d1.deal_id).toMatch(/^EB-C-\d{2}-\d{4}-D01$/);

    // Enquiry #2: the recognised client skips CONTACT, so the affirmation
    // text lands directly in ODM_SLOTS and must be fed through the flow.
    const s2 = await chat({ kind: "open" }, token);
    const sid = s2.session_id;
    expect(sid).not.toBe(s1.session_id);
    res = await chat({ session_id: sid, kind: "text", text: ODM_TRIGGER }, token);
    expect(res.meta.state).toBe("TRACK_CONFIRM");

    res = await chat({ session_id: sid, kind: "text", text: AFFIRM_WITH_SUBSTANCE }, token);
    // Advanced INTO the track, greeted as a returning client, and the very
    // message that confirmed the track answered question 1 — mock
    // extractSlots fills the asked slot with the raw text, so the intake is
    // already 1/7 done and asking question 2.
    expect(res.meta.state).toBe("ODM_SLOTS");
    expect(res.meta.track).toBe("ODM");
    expect(res.messages.join("\n")).toContain("Welcome back");
    expect(res.messages.join("\n")).toContain("must-have features");
    expect(res.meta.progress).toEqual({ done: 1, total: 7, label: "questions" });

    const d2 = await sessionData(sid);
    expect(d2.slots.product_concept).toBe(AFFIRM_WITH_SUBSTANCE);
    expect(d2.expected_slot).toBe("key_features");
    // Same client identity, next deal in that client's sequence.
    expect(d2.client_code).toBe(d1.client_code);
    expect(d2.deal_id).toMatch(/-D02$/);
  }, 20_000);
});

describe("chip back navigation", () => {
  it("steps back within ODM_SLOTS, then out to the company questions; re-answers overwrite", async () => {
    const { sid } = await odmToSlots();
    const d0 = await sessionData(sid);
    expect(d0.deal_id).toMatch(/^EB-C-\d{2}-\d{4}-D01$/);
    expect(d0.expected_slot).toBe("product_concept");

    let res = await chat({ session_id: sid, kind: "text", text: ODM_ANSWERS[0] });
    expect(res.meta.progress).toEqual({ done: 1, total: 7, label: "questions" });

    // back inside ODM_SLOTS: the answered slot pops and Q1 is re-presented
    res = await chat({ session_id: sid, kind: "chip", chip_id: "back" });
    expect(res.meta.state).toBe("ODM_SLOTS");
    expect(res.meta.progress).toEqual({ done: 0, total: 7, label: "questions" });
    expect(res.messages[0]).toContain("What are you looking to build");
    let d = await sessionData(sid);
    expect(d.slots.product_concept).toBeUndefined();
    expect(d.expected_slot).toBe("product_concept");

    // back again with zero slots answered: out to the org-size question
    res = await chat({ session_id: sid, kind: "chip", chip_id: "back" });
    expect(res.meta.state).toBe("CLIENT_ORGSIZE");
    expect(chipIds(res)).toContain("org:0");

    // re-answering org size resumes the track without re-issuing identities
    res = await chat({ session_id: sid, kind: "chip", chip_id: "org:0" });
    expect(res.meta.state).toBe("ODM_SLOTS");
    expect(res.messages[0]).toContain("What are you looking to build");

    res = await chat({ session_id: sid, kind: "text", text: "an RFID attendance tracker for school buses" });
    expect(res.meta.progress).toEqual({ done: 1, total: 7, label: "questions" });
    res = await chat({ session_id: sid, kind: "chip", chip_id: "back" });
    expect(res.meta.state).toBe("ODM_SLOTS");
    res = await chat({ session_id: sid, kind: "text", text: ODM_ANSWERS[0] });
    d = await sessionData(sid);
    // The re-answer replaced the popped value.
    expect(d.slots.product_concept).toBe(ODM_ANSWERS[0]);
    expect(d.expected_slot).toBe("key_features");

    // Identities issued before all that back-and-forth are untouched.
    expect(d.deal_id).toBe(d0.deal_id);
    expect(d.client_code).toBe(d0.client_code);
    expect(d.lead_id).toBe(d0.lead_id);
  }, 20_000);

  it("pops the last slot from ODM_REVIEW and returns ODM_LLD_REVIEW to ODM_REVIEW", async () => {
    const { sid } = await odmToSlots();
    const d0 = await sessionData(sid);

    let res: ChatOut | null = null;
    for (const ans of ODM_ANSWERS) {
      res = await chat({ session_id: sid, kind: "text", text: ans });
    }
    expect(res!.meta.state).toBe("ODM_REVIEW");

    // back at ODM_REVIEW: the LAST slot (references) pops and is re-asked
    res = await chat({ session_id: sid, kind: "chip", chip_id: "back" });
    expect(res.meta.state).toBe("ODM_SLOTS");
    expect(res.meta.progress).toEqual({ done: 6, total: 7, label: "questions" });
    expect(res.messages[0]).toContain("reference products");
    let d = await sessionData(sid);
    expect(d.slots.references).toBeUndefined();
    expect(d.expected_slot).toBe("references");

    // re-answer → back on the review card, with the new value on it
    const newRefs = "benchmark against the top three AIS-140 trackers on IndiaMART";
    res = await chat({ session_id: sid, kind: "text", text: newRefs });
    expect(res.meta.state).toBe("ODM_REVIEW");
    expect(cardBodies(res)).toContain(newRefs);
    expect(chipIds(res)).toContain("lld:generate");

    // generate the LLD, then back: ODM_LLD_REVIEW returns to ODM_REVIEW
    res = await chat({ session_id: sid, kind: "chip", chip_id: "lld:generate" });
    expect(res.meta.state).toBe("ODM_LLD_REVIEW");
    res = await chat({ session_id: sid, kind: "chip", chip_id: "back" });
    expect(res.meta.state).toBe("ODM_REVIEW");
    expect(res.meta.progress).toEqual({ done: 7, total: 7, label: "questions" });
    expect(chipIds(res)).toContain("lld:generate");

    // Issued identities survived every step of the back navigation.
    d = await sessionData(sid);
    expect(d.deal_id).toBe(d0.deal_id);
    expect(d.deal_id).toMatch(/^EB-C-\d{2}-\d{4}-D01$/);
    expect(d.client_code).toBe(d0.client_code);
  }, 30_000);
});

describe("ODM slot probing (model extracted nothing)", () => {
  it("re-asks up to maxProbeTurns, then accepts the raw text verbatim", async () => {
    const { sid } = await odmToSlots();

    probeCtl.active = true;

    // strike 1: no extraction → conversational re-ask, nothing stored
    let res = await chat({ session_id: sid, kind: "text", text: "paneer pakoda" });
    expect(res.meta.state).toBe("ODM_SLOTS");
    expect(res.meta.progress).toEqual({ done: 0, total: 7, label: "questions" });
    expect(res.messages[0]).toContain("doesn't tell me");
    let d = await sessionData(sid);
    expect(d.slots.product_concept).toBeUndefined();
    expect(d.slot_probes?.product_concept).toBe(1);

    // strike 2: still probing the same slot
    res = await chat({ session_id: sid, kind: "text", text: "asdf qwerty" });
    expect(res.meta.state).toBe("ODM_SLOTS");
    expect(res.meta.progress).toEqual({ done: 0, total: 7, label: "questions" });
    d = await sessionData(sid);
    expect(d.slots.product_concept).toBeUndefined();
    expect(d.slot_probes?.product_concept).toBe(2);

    // strike 3: the raw text is taken verbatim and the intake moves on
    const finalText = "a colour-screen bus ticketing validator";
    res = await chat({ session_id: sid, kind: "text", text: finalText });
    expect(res.meta.state).toBe("ODM_SLOTS");
    expect(res.meta.progress).toEqual({ done: 1, total: 7, label: "questions" });
    expect(res.messages[0]).toContain("must-have features");
    d = await sessionData(sid);
    expect(d.slots.product_concept).toBe(finalText);
    expect(d.expected_slot).toBe("key_features");
    expect(probeCtl.calls).toBe(3);
  }, 20_000);
});

describe("restart chip", () => {
  it("creates a fresh session and leaves the finished one intact", async () => {
    // quick PRODUCT run to DONE
    const opened = await chat({ kind: "open" });
    const sid = opened.session_id;
    let res = await chat({
      session_id: sid,
      kind: "text",
      text: "do you sell soundbox devices off the shelf",
    });
    expect(res.meta.state).toBe("TRACK_CONFIRM");
    res = await chat({ session_id: sid, kind: "chip", chip_id: "confirm:yes" });
    res = await chat({
      session_id: sid,
      kind: "form",
      form: { form_id: "contact", values: CONTACT },
    });
    res = await chat({ session_id: sid, kind: "chip", chip_id: "sec:4" });
    res = await chat({ session_id: sid, kind: "chip", chip_id: "org:0" });
    expect(res.meta.state).toBe("PRODUCT_CATEGORY");
    res = await chat({ session_id: sid, kind: "chip", chip_id: "cat:epay" });
    res = await chat({
      session_id: sid,
      kind: "form",
      form: {
        form_id: "product_details",
        values: { quantity: "500", timeline: "8 weeks", customization: "" },
      },
    });
    expect(res.meta.state).toBe("DONE");
    expect(chipIds(res)).toContain("restart");
    const oldDeal = (await sessionData(sid)).deal_id;

    // restart: a brand-new session with the fresh-visitor greeting
    res = await chat({ session_id: sid, kind: "chip", chip_id: "restart" });
    const freshSid = res.session_id;
    expect(freshSid).not.toBe(sid);
    expect(freshSid).toMatch(UUID_RE);
    expect(res.meta.state).toBe("DISCOVER");
    expect(res.meta.track).toBeNull();
    expect(res.messages[0]).toContain("Namaste");
    expect(chipIds(res)).toEqual(
      expect.arrayContaining(["track:ODM", "track:EMS", "track:PRODUCT", "ask"]),
    );

    // The fresh session carries nothing over…
    const freshData = await sessionData(freshSid);
    expect(freshData.contact).toEqual({});
    expect(freshData.slots).toEqual({});
    expect(freshData.deal_id).toBeNull();
    // …and the old one is untouched.
    const old = await getDb().getSession(sid);
    expect(old!.state).toBe("DONE");
    expect(old!.data.finalized).toBe(true);
    expect(old!.data.deal_id).toBe(oldDeal);

    // The fresh session is fully usable.
    res = await chat({ session_id: freshSid, kind: "text", text: ODM_TRIGGER });
    expect(res.meta.state).toBe("TRACK_CONFIRM");
  }, 20_000);
});

describe("open on an existing session", () => {
  it("returns the stored transcript in order and does not duplicate it", async () => {
    // Drive a session while recording what the transcript must contain:
    // user turns are stored only for kind:"text"; every assistant message
    // in every response is stored.
    const transcript: Msg[] = [];
    const rchat = async (payload: Partial<ChatIn>): Promise<ChatOut> => {
      const res = await chat(payload);
      if (payload.kind === "text" && payload.text) {
        transcript.push({ role: "user", content: payload.text });
      }
      for (const m of res.messages) transcript.push({ role: "assistant", content: m });
      return res;
    };

    const opened = await rchat({ kind: "open" });
    const sid = opened.session_id;
    expect(opened.history).toBeUndefined(); // a fresh open is not a reload
    let res = await rchat({ session_id: sid, kind: "text", text: ODM_TRIGGER });
    res = await rchat({ session_id: sid, kind: "chip", chip_id: "confirm:yes" });
    res = await rchat({
      session_id: sid,
      kind: "form",
      form: { form_id: "contact", values: CONTACT },
    });
    res = await rchat({ session_id: sid, kind: "chip", chip_id: "sec:4" });
    res = await rchat({ session_id: sid, kind: "chip", chip_id: "org:0" });
    expect(res.meta.state).toBe("ODM_SLOTS");
    res = await rchat({ session_id: sid, kind: "text", text: ODM_ANSWERS[0] });
    expect(res.meta.progress).toEqual({ done: 1, total: 7, label: "questions" });

    // Reload #1: the FULL stored transcript, in order, then the re-presented
    // pending question in messages (not duplicated inside history).
    const expected1 = [...transcript];
    const open1 = await rchat({ session_id: sid, kind: "open" });
    expect(open1.session_id).toBe(sid);
    expect(open1.meta.state).toBe("ODM_SLOTS");
    expect(open1.history).toEqual(expected1);
    expect(open1.messages[0]).toContain("must-have features");

    // Reload #2: re-presented resume prompts are never persisted, so the
    // stored transcript is EXACTLY what it was before reload #1 — repeated
    // reloads must not stack "where were we" lines (the triple
    // "This enquiry is logged…" bug).
    const open2 = await chat({ session_id: sid, kind: "open" });
    expect(open2.history).toEqual(expected1);

    // Belt and braces: each user turn appears exactly once.
    expect(open2.history!.filter((m) => m.role === "user")).toEqual([
      { role: "user", content: ODM_TRIGGER },
      { role: "user", content: ODM_ANSWERS[0] },
    ]);
  }, 20_000);
});

/**
 * The hybrid engine.
 *
 * The LLM (lib/llm.ts) understands language: triage, slot extraction, Q&A,
 * LLD drafting. This module owns everything deterministic: the state
 * machine, question order, file checklist, validation, the leads record and
 * the Drive/Sheets handoff. The LLM never decides what to collect; the
 * state machine never parses language.
 *
 * States: DISCOVER → TRACK_CONFIRM → CONTACT →
 *   ODM_SLOTS → ODM_REVIEW, or EMS_CHECKLIST → EMS_DETAILS, or
 *   PRODUCT_CATEGORY → PRODUCT_DETAILS → (finalize) → DONE
 */
import type { AuthUser } from "./auth-server";
import { cfg, PRODUCT_CATEGORIES, TRACK_LABELS } from "./config";
import {
  CONTACT_FORM,
  EMS_CHECKLIST,
  EMS_DETAILS_FORM,
  ODM_SLOTS,
  ODM_SLOT_LABELS,
  ORG_SIZES,
  PRODUCT_DETAILS_FORM,
  SECTORS,
} from "./flows";
import * as llm from "./llm";
import { getDb, type ClientRow, type SessionRow } from "./supabase";
import { noteTask, trackTask } from "./tasks";
import { istHuman, istTimestamp } from "./util";
import type {
  ChatIn,
  ChatOut,
  ChecklistItemDef,
  FormField,
  Msg,
  SessionState,
  Track,
  Widget,
} from "./widgets";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TRACK_CHIPS = [
  { id: "track:ODM", label: "Design a new product" },
  { id: "track:EMS", label: "I have a design — manufacture it" },
  { id: "track:PRODUCT", label: "Explore ready products" },
  { id: "ask", label: "Just a question" },
];

const GREETING =
  "Namaste, I'm XOR Assist. Tell me what you're building — or pick the " +
  "closest fit below — and I'll route you to the right Elecbits team with " +
  "everything they need to move fast.";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ─────────────────────────── widget helpers ───────────────────────────────
function chips(options: { id: string; label: string }[]): Widget {
  return { type: "chips", options };
}

function form(formId: string, title: string, fields: FormField[], submit = "Continue"): Widget {
  return { type: "form", form_id: formId, title, fields, submit_label: submit };
}

function checklistWidget(s: SessionRow): Widget {
  return {
    type: "checklist",
    title: "Your build package",
    items: EMS_CHECKLIST.map((item) => ({
      key: item.key,
      label: item.label,
      status: s.data.checklist[item.key]?.status ?? "pending",
      required: item.required,
    })),
  };
}

function uploadWidget(item: ChecklistItemDef): Widget {
  return { type: "upload", item, allow_skip: true };
}

function card(title: string, body = "", links: { label: string; url: string }[] = []): Widget {
  return { type: "card", title, body, links };
}

function meta(s: SessionRow): ChatOut["meta"] {
  let progress: ChatOut["meta"]["progress"] = null;
  if (s.track === "ODM" && (s.state === "ODM_SLOTS" || s.state === "ODM_REVIEW")) {
    progress = {
      done: Object.keys(s.data.slots).length,
      total: ODM_SLOTS.length,
      label: "questions",
    };
  } else if (s.track === "EMS" && (s.state === "EMS_CHECKLIST" || s.state === "EMS_DETAILS")) {
    progress = {
      done: Object.keys(s.data.checklist).length,
      total: EMS_CHECKLIST.length,
      label: "files",
    };
  }
  return { state: s.state, track: s.track, progress };
}

async function out(s: SessionRow, messages: string[], widgets: Widget[] = []): Promise<ChatOut> {
  const db = getDb();
  for (const m of messages) await db.addMessage(s.id, "assistant", m);
  await db.saveSession(s);
  // State transitions + lead_ref only — never PII (names, emails, message text).
  console.info(
    `xor session=${s.id} state=${s.state}` +
      (s.data.lead_ref ? ` lead=${s.data.lead_ref}` : ""),
  );
  return { session_id: s.id, messages, widgets, meta: meta(s) };
}

// ─────────────────────────── entry points ─────────────────────────────────
export async function handle(inp: ChatIn, authUser?: AuthUser | null): Promise<ChatOut> {
  const db = getDb();
  let s: SessionRow | null = null;
  if (inp.session_id && UUID_RE.test(inp.session_id)) {
    s = await db.getSession(inp.session_id);
  }
  if (!s) s = await db.createSession();

  // A verified login on the request binds this session (and its lead) to
  // that client account, so it shows up under "Your projects".
  if (authUser && s.data.auth_user_id !== authUser.id) {
    s.data.auth_user_id = authUser.id;
    s.data.auth_email = authUser.email;
  }

  if (inp.kind === "open") {
    const seen = await db.recentMessages(s.id, 1);
    if (s.state === "DISCOVER" && seen.length === 0) {
      return out(s, [GREETING], [chips(TRACK_CHIPS)]);
    }
    return resume(s);
  }

  if (inp.kind === "chip" && inp.chip_id === "restart") {
    const fresh = await db.createSession();
    return out(fresh, [GREETING], [chips(TRACK_CHIPS)]);
  }

  // History for the LLM excludes the current message; it is passed alongside.
  const history = await db.recentMessages(s.id, 12);
  if (inp.kind === "text" && inp.text) {
    await db.addMessage(s.id, "user", inp.text);
  }

  const state = s.state;
  try {
    switch (state) {
      case "DISCOVER":
        return await discover(s, inp, history);
      case "TRACK_CONFIRM":
        return await trackConfirm(s, inp, history);
      case "CONTACT":
        return await contact(s, inp);
      case "CLIENT_INDUSTRY":
        return await clientIndustry(s, inp);
      case "CLIENT_ORGSIZE":
        return await clientOrgsize(s, inp);
      case "ODM_SLOTS":
        return await odmSlots(s, inp);
      case "ODM_REVIEW":
        return await odmReview(s, inp);
      case "EMS_CHECKLIST":
        return await emsChecklist(s, inp, history);
      case "EMS_DETAILS":
        return await emsDetails(s, inp);
      case "PRODUCT_CATEGORY":
        return await productCategory(s, inp);
      case "PRODUCT_DETAILS":
        return await productDetails(s, inp);
      case "DONE":
        return await out(
          s,
          ["This enquiry is logged and the team will be in touch. Want to raise another one?"],
          [chips([{ id: "restart", label: "Start another enquiry" }])],
        );
    }
  } catch (err) {
    console.error(`orchestrator error in state ${state}`, err);
    const w = resumeWidget(s);
    return out(
      s,
      [
        "Something hiccuped on my side — could you say that again? If it " +
          "repeats, email sales@elecbits.in and we'll pick it up directly.",
      ],
      w ? [w] : [],
    );
  }
  return resume(s);
}

/**
 * Called by /api/upload-complete after the object is verified in Storage
 * and the lead_files row is recorded.
 */
export async function handleUpload(
  s: SessionRow,
  itemKey: string,
  filename: string,
): Promise<ChatOut> {
  if (s.state !== "EMS_CHECKLIST") {
    const w = resumeWidget(s);
    return out(s, ["Thanks — I've kept that file. Let's continue."], w ? [w] : []);
  }
  s.data.checklist[itemKey] = { status: "uploaded", filename };
  const label = EMS_CHECKLIST.find((i) => i.key === itemKey)?.label ?? itemKey;
  return emsNext(s, `${label} received.`);
}

// ─────────────────────────── state handlers ───────────────────────────────
function parseTrackChip(chipId: string | undefined): Track | null {
  const t = chipId?.split(":", 2)[1];
  return t === "ODM" || t === "EMS" || t === "PRODUCT" ? t : null;
}

async function discover(s: SessionRow, inp: ChatIn, history: Msg[]): Promise<ChatOut> {
  if (inp.kind === "chip") {
    if (inp.chip_id?.startsWith("track:")) {
      const t = parseTrackChip(inp.chip_id);
      return t ? setTrack(s, t) : resume(s);
    }
    if (inp.chip_id === "ask") {
      return out(s, ["Ask away — capabilities, certifications, process, anything."]);
    }
    return resume(s);
  }

  if (!inp.text) return resume(s);

  const t = await llm.triage(history, inp.text);
  for (const [k, v] of Object.entries(t.entities ?? {})) {
    if (v) s.data.entities[k] = v;
  }

  if (t.track === "QUESTION") {
    const ans = await llm.answerQuestion(history, inp.text);
    return out(s, [ans], [chips(TRACK_CHIPS)]);
  }

  if (
    (t.track === "ODM" || t.track === "EMS" || t.track === "PRODUCT") &&
    t.confidence >= cfg.triageConfidence
  ) {
    s.data.proposed_track = t.track;
    s.state = "TRACK_CONFIRM";
    const others = TRACK_CHIPS.slice(0, 3).filter((c) => c.id !== `track:${t.track}`);
    const opts = [{ id: "confirm:yes", label: "Yes, that's right" }, ...others];
    const reply = (t.reply ?? "").trim();
    const msg = reply ? `${reply} Have I got that right?` : "Have I got that right?";
    return out(s, [msg], [chips(opts)]);
  }

  // UNCLEAR or low confidence → probe, with a manual fallback after N turns.
  s.data.probe_turns += 1;
  if (s.data.probe_turns >= cfg.maxProbeTurns) {
    return out(s, ["Let me make this easy — which of these is closest?"], [chips(TRACK_CHIPS)]);
  }
  const reply =
    (t.reply ?? "").trim() ||
    "Got it. Do you already have a completed design (BoM/Gerbers ready), " +
      "or is this a new product you want designed?";
  return out(s, [reply]);
}

async function trackConfirm(s: SessionRow, inp: ChatIn, history: Msg[]): Promise<ChatOut> {
  if (inp.kind === "chip") {
    if (inp.chip_id === "confirm:yes" && s.data.proposed_track) {
      return setTrack(s, s.data.proposed_track as Track);
    }
    if (inp.chip_id?.startsWith("track:")) {
      const t = parseTrackChip(inp.chip_id);
      if (t) return setTrack(s, t);
    }
  }
  if (inp.kind === "text" && inp.text) {
    s.state = "DISCOVER";
    return discover(s, inp, history);
  }
  return resume(s);
}

async function setTrack(s: SessionRow, track: Track): Promise<ChatOut> {
  s.track = track;
  s.state = "CONTACT";
  const intro = {
    ODM:
      "New product design it is. Quick coordinates first, then seven short " +
      "questions — at the end I'll draft a first-cut LLD (low-level design) " +
      "you can take into the engineering call.",
    EMS:
      "Manufacturing it is. Quick coordinates first, then I'll walk you " +
      "through the build package we need for an accurate quote.",
    PRODUCT:
      "Let's find you the right product. Quick coordinates first so the " +
      "team can follow up with the catalogue and pricing.",
  }[track];
  return out(s, [intro], [form("contact", "How do we reach you?", CONTACT_FORM, "Save & continue")]);
}

async function contact(s: SessionRow, inp: ChatIn): Promise<ChatOut> {
  const contactForm = form("contact", "How do we reach you?", CONTACT_FORM, "Save & continue");
  if (inp.kind !== "form" || inp.form?.form_id !== "contact") {
    return out(s, ["The quickest way is the little form below — takes ten seconds."], [contactForm]);
  }
  const v: Record<string, string> = {};
  for (const [k, val] of Object.entries(inp.form.values ?? {})) v[k] = String(val).trim();

  const problems: string[] = [];
  if (!v.name) problems.push("your name");
  if (!v.company) problems.push("company");
  if (!EMAIL_RE.test(v.email ?? "")) problems.push("a valid email");
  if ((v.phone ?? "").replace(/\D/g, "").length < 8) problems.push("a valid phone number");
  if (problems.length) {
    return out(s, [`Almost — I still need ${problems.join(", ")}.`], [contactForm]);
  }
  s.data.contact = v;
  const first = v.name.split(/\s+/)[0];

  // Returning client? Matched by contact email — reused for FILING (client
  // ID + folder); the account view still requires a verified login.
  const existing = await getDb().findClientByEmail(v.email);
  if (existing) {
    s.data.client_id = existing.id;
    s.data.client_code = existing.client_code;
    return startTrackFlow(
      s,
      first,
      `Welcome back — filing this under client ID ${existing.client_code}. `,
    );
  }

  s.state = "CLIENT_INDUSTRY";
  return out(
    s,
    [
      `Thanks ${first}. Two quick company questions for our records. ` +
        `Which sector fits ${v.company} best?`,
    ],
    [industryChips()],
  );
}

function industryChips(): Widget {
  return chips(SECTORS.map((label, i) => ({ id: `sec:${i}`, label })));
}

function orgSizeChips(): Widget {
  return chips(ORG_SIZES.map((label, i) => ({ id: `org:${i}`, label })));
}

async function clientIndustry(s: SessionRow, inp: ChatIn): Promise<ChatOut> {
  if (inp.kind === "chip" && inp.chip_id?.startsWith("sec:")) {
    const i = Number(inp.chip_id.split(":", 2)[1]);
    if (Number.isInteger(i) && i >= 0 && i < SECTORS.length) {
      s.data.sector = SECTORS[i];
      s.state = "CLIENT_ORGSIZE";
      return out(s, ["And the organisation size?"], [orgSizeChips()]);
    }
  }
  return resume(s);
}

async function clientOrgsize(s: SessionRow, inp: ChatIn): Promise<ChatOut> {
  if (inp.kind === "chip" && inp.chip_id?.startsWith("org:")) {
    const i = Number(inp.chip_id.split(":", 2)[1]);
    if (Number.isInteger(i) && i >= 0 && i < ORG_SIZES.length) {
      s.data.org_size = ORG_SIZES[i];
      const first = (s.data.contact.name ?? "").split(/\s+/)[0] ?? "";
      return startTrackFlow(s, first);
    }
  }
  return resume(s);
}

async function startTrackFlow(s: SessionRow, first: string, prefix = ""): Promise<ChatOut> {
  if (s.track === "ODM") {
    s.state = "ODM_SLOTS";
    const [key, q, hint] = ODM_SLOTS[0];
    s.data.expected_slot = key;
    let msg = `${prefix}Thanks ${first}. ${q}`;
    if (hint) msg += ` (${hint})`;
    return out(s, [msg]);
  }

  if (s.track === "EMS") {
    s.state = "EMS_CHECKLIST";
    let templates: { name: string; url: string }[] = [];
    try {
      templates = await (await import("./drive")).fetchTemplates();
    } catch (err) {
      console.error("template fetch failed", err);
    }
    const widgets: Widget[] = [checklistWidget(s), uploadWidget(EMS_CHECKLIST[0])];
    if (templates.length) {
      widgets.unshift(
        card(
          "Handy templates",
          "If you'd like our formats:",
          templates.map((t) => ({ label: t.name, url: t.url })),
        ),
      );
    }
    return out(
      s,
      [
        `${prefix}Thanks ${first}. Upload whatever's ready from the list — skip ` +
          "anything you don't have yet and I'll flag it for the team. " +
          "First up: your BoM.",
      ],
      widgets,
    );
  }

  s.state = "PRODUCT_CATEGORY";
  const opts = PRODUCT_CATEGORIES.map(([cid, label]) => ({ id: `cat:${cid}`, label }));
  return out(s, [`${prefix}Thanks ${first}. Which category fits best?`], [chips(opts)]);
}

async function odmSlots(s: SessionRow, inp: ChatIn): Promise<ChatOut> {
  if (inp.kind !== "text" || !inp.text) return resume(s);
  const ext = await llm.extractSlots(s.data.slots, s.data.expected_slot, inp.text);
  Object.assign(s.data.slots, ext.updates ?? {});
  const nxt = ODM_SLOTS.find(([k]) => !(k in s.data.slots));
  if (nxt) {
    const [key, q, hint] = nxt;
    s.data.expected_slot = key;
    let msg = `${ext.ack || "Noted."} ${q}`;
    if (hint) msg += ` (${hint})`;
    return out(s, [msg]);
  }
  s.data.expected_slot = null;
  s.state = "ODM_REVIEW";
  const body = ODM_SLOTS.filter(([k]) => k in s.data.slots)
    .map(([k]) => `**${ODM_SLOT_LABELS[k]}** — ${s.data.slots[k]}`)
    .join("\n");
  return out(
    s,
    ["That's everything I need. Here's what I captured:"],
    [card("Your requirement", body), chips(reviewChips())],
  );
}

function reviewChips() {
  return [
    { id: "lld:generate", label: "Generate my LLD draft" },
    { id: "lld:edit", label: "Change an answer" },
    { id: "lld:skip", label: "Skip — connect me to sales" },
  ];
}

async function odmReview(s: SessionRow, inp: ChatIn): Promise<ChatOut> {
  const db = getDb();
  if (inp.kind === "chip") {
    if (inp.chip_id === "lld:generate") {
      if (!s.data.lead_ref) s.data.lead_ref = await db.nextLeadRef();
      const lldMd = await llm.generateLld(s.data.slots, s.data.contact, s.data.lead_ref);
      const fname = `LLD-draft-${s.data.lead_ref}.md`;
      const path = `${s.id}/generated/${fname}`;
      await db.putObject(path, new TextEncoder().encode(lldMd), "text/markdown");
      s.data.lld_file = fname;
      s.data.lld_path = path;
      return finalize(s);
    }
    if (inp.chip_id === "lld:skip") {
      return finalize(s);
    }
    if (inp.chip_id === "lld:edit") {
      const opts = ODM_SLOTS.map(([k]) => ({ id: `edit:${k}`, label: ODM_SLOT_LABELS[k] }));
      return out(s, ["Which answer should we revisit?"], [chips(opts)]);
    }
    if (inp.chip_id?.startsWith("edit:")) {
      const key = inp.chip_id.split(":", 2)[1];
      const slot = ODM_SLOTS.find(([k]) => k === key);
      if (slot) {
        delete s.data.slots[key];
        s.data.expected_slot = key;
        s.state = "ODM_SLOTS";
        const msg = slot[1] + (slot[2] ? ` (${slot[2]})` : "");
        return out(s, [msg]);
      }
    }
  }
  if (inp.kind === "text" && inp.text) {
    // Treat stray text as a correction to the whole set.
    const ext = await llm.extractSlots(s.data.slots, null, inp.text);
    Object.assign(s.data.slots, ext.updates ?? {});
    s.state = "ODM_SLOTS";
    return odmSlots(s, { session_id: s.id, kind: "text", text: "." });
  }
  return resume(s);
}

async function emsChecklist(s: SessionRow, inp: ChatIn, history: Msg[]): Promise<ChatOut> {
  if (inp.kind === "chip" && inp.chip_id?.startsWith("skip:")) {
    const key = inp.chip_id.split(":", 2)[1];
    const item = EMS_CHECKLIST.find((i) => i.key === key);
    if (item) {
      s.data.checklist[key] = { status: "skipped" };
      const note = item.required
        ? `No problem — noted that the ${item.label} will follow. We'll need it before a firm quote.`
        : "Skipped.";
      return emsNext(s, note);
    }
  }
  if (inp.kind === "text" && inp.text) {
    const ans = await llm.answerQuestion(history, inp.text);
    const cur = currentEmsItem(s);
    const widgets: Widget[] = [checklistWidget(s)];
    if (cur) widgets.push(uploadWidget(cur));
    return out(s, [ans], widgets);
  }
  return resume(s);
}

function currentEmsItem(s: SessionRow): ChecklistItemDef | null {
  return EMS_CHECKLIST.find((i) => !(i.key in s.data.checklist)) ?? null;
}

async function emsNext(s: SessionRow, prefix: string): Promise<ChatOut> {
  const cur = currentEmsItem(s);
  if (cur) {
    return out(
      s,
      [`${prefix} Next: ${cur.label.toLowerCase()}. ${cur.desc}`],
      [checklistWidget(s), uploadWidget(cur)],
    );
  }
  s.state = "EMS_DETAILS";
  return out(
    s,
    [`${prefix} That's the package done. Last step — a few build details:`],
    [
      checklistWidget(s),
      form("ems_details", "Build details", EMS_DETAILS_FORM, "Submit requirement"),
    ],
  );
}

async function emsDetails(s: SessionRow, inp: ChatIn): Promise<ChatOut> {
  const detailsForm = form("ems_details", "Build details", EMS_DETAILS_FORM, "Submit requirement");
  if (inp.kind !== "form" || inp.form?.form_id !== "ems_details") {
    return out(s, ["Just the short form below and we're done."], [detailsForm]);
  }
  const v: Record<string, string> = {};
  for (const [k, val] of Object.entries(inp.form.values ?? {})) v[k] = String(val).trim();
  if (!v.quantity || !v.target_date) {
    return out(s, ["I still need the quantity and the delivery target."], [detailsForm]);
  }
  s.data.ems_details = v;
  return finalize(s);
}

async function productCategory(s: SessionRow, inp: ChatIn): Promise<ChatOut> {
  if (inp.kind === "chip" && inp.chip_id?.startsWith("cat:")) {
    const cid = inp.chip_id.split(":", 2)[1];
    const label = PRODUCT_CATEGORIES.find(([id]) => id === cid)?.[1] ?? cid;
    s.data.product.category = label;
  } else if (inp.kind === "text" && inp.text) {
    s.data.product.category = inp.text.trim();
  } else {
    return resume(s);
  }
  s.state = "PRODUCT_DETAILS";
  return out(
    s,
    [`${s.data.product.category} — nice. A couple of specifics:`],
    [form("product_details", "What you need", PRODUCT_DETAILS_FORM, "Submit enquiry")],
  );
}

async function productDetails(s: SessionRow, inp: ChatIn): Promise<ChatOut> {
  const detailsForm = form("product_details", "What you need", PRODUCT_DETAILS_FORM, "Submit enquiry");
  if (inp.kind !== "form" || inp.form?.form_id !== "product_details") {
    return out(s, ["The short form below finishes this up."], [detailsForm]);
  }
  const v: Record<string, string> = {};
  for (const [k, val] of Object.entries(inp.form.values ?? {})) v[k] = String(val).trim();
  if (!v.quantity || !v.timeline) {
    return out(s, ["I still need the quantity and rough timeline."], [detailsForm]);
  }
  Object.assign(s.data.product, v);
  return finalize(s);
}

// ───────────────────────────── finalize ───────────────────────────────────
/**
 * The Google Drive handoff, per the build spec:
 *   1. Insert the leads row FIRST — Supabase is the transactional record;
 *      Drive/Sheets are projections.
 *   2. Drive folder + files (skipped entirely in MOCK_DRIVE — logged as a
 *      pre-resolved handoff_retries row instead).
 *   3. Funnel-sheet row.
 * Any Drive/Sheets failure lands in handoff_retries with the full payload
 * and the visitor UX still completes — a lead is never lost and never
 * blocks the visitor.
 */
async function finalize(s: SessionRow): Promise<ChatOut> {
  const db = getDb();
  const prevState = s.state;
  // One finalize per session: an atomic state claim, so a concurrent
  // double-submit cannot insert duplicate leads or funnel rows.
  const claimed = await db.claimSession(s.id, prevState, "DONE");
  if (!claimed) {
    return {
      session_id: s.id,
      messages: ["This enquiry is logged and the team will be in touch. Want to raise another one?"],
      widgets: [chips([{ id: "restart", label: "Start another enquiry" }])],
      meta: { state: "DONE", track: s.track, progress: null },
    };
  }
  s.state = "DONE";
  try {
    return await finalizeWork(s);
  } catch (err) {
    // Release the claim so a retry can finalize; the lead was not recorded.
    s.state = prevState;
    await db.claimSession(s.id, "DONE", prevState).catch(() => undefined);
    throw err;
  }
}

/**
 * Resolve (or create) the client behind this session. A NEW client is
 * issued by the Eb-Master Register FIRST (SOP Law 6) — this table only
 * caches the issued identity. A verified login binds only when its VERIFIED
 * email matches the client record — a typed contact email is enough for
 * filing, never for attaching someone's login to someone else's client.
 */
async function resolveClient(s: SessionRow): Promise<ClientRow> {
  const db = getDb();
  const d = s.data;
  const email = (d.contact.email ?? "").trim().toLowerCase();

  let client: ClientRow | null = null;
  if (d.auth_user_id) client = await db.findClientByAuthUserId(d.auth_user_id);
  if (!client && email) client = await db.findClientByEmail(email);

  if (client) {
    if (d.auth_user_id && !client.auth_user_id && d.auth_email && d.auth_email === client.email) {
      await db.updateClient(client.id, { auth_user_id: d.auth_user_id });
      client = { ...client, auth_user_id: d.auth_user_id };
    }
  } else {
    const { register } = await import("./register");
    client = await trackTask(
      s.id,
      "Issue client ID",
      async () => {
        const code = await register().issueClient({
          company: d.contact.company ?? "",
          sector: d.sector ?? "Individuals & Other",
          orgSize: d.org_size ?? "Individual / Unknown (UN)",
          contactName: d.contact.name ?? "",
        });
        return db.insertClient({
          client_code: code,
          company: d.contact.company ?? "",
          sector: d.sector,
          org_size: d.org_size,
          contact_name: d.contact.name ?? null,
          email: email || null,
          phone: d.contact.phone ?? null,
          auth_user_id: d.auth_user_id,
          drive_folder_id: null,
          drive_folder_url: null,
        });
      },
      { detail: (c) => c.client_code },
    );
  }
  d.client_id = client.id;
  d.client_code = client.client_code;
  return client;
}

async function finalizeWork(s: SessionRow): Promise<ChatOut> {
  const db = getDb();
  const d = s.data;
  if (!d.lead_ref) d.lead_ref = await db.nextLeadRef();
  const c = d.contact;
  const { summary, quantity, timeline } = leadSummary(s);

  // Register rows FIRST (SOP Law 6: no register row, no folder): the client
  // on the Clients tab, then the deal on the Deals tab (Status=Open). The
  // folder hierarchy and every downstream reference (ULM included) hang off
  // these identifiers.
  const client = await resolveClient(s);
  if (!d.deal_id) {
    const { register } = await import("./register");
    d.deal_id = await trackTask(
      s.id,
      "Register deal",
      () => register().issueDeal(client.client_code, summary.slice(0, 80)),
      { detail: (id) => id },
    );
  }
  let leadId = d.lead_id;
  if (!leadId) {
    const lead = await db.insertLead({
      lead_ref: d.lead_ref,
      session_id: s.id,
      track: s.track ?? "UNKNOWN",
      company: c.company ?? "",
      contact_name: c.name ?? "",
      email: c.email ?? "",
      phone: c.phone ?? "",
      summary,
      quantity,
      timeline,
      client_id: client.id,
      deal_id: d.deal_id,
    });
    leadId = lead.id;
    d.lead_id = leadId;
    await db.linkLeadFiles(s.id, leadId);
  }

  const summaryMd = intakeSummary(s);

  // Latest file per checklist item, in checklist order. Every artifact
  // written into the deal folder carries ONE capture timestamp (IST,
  // filename-safe) — stored in the payload so retries reuse the same names.
  const stamp = istTimestamp().replace(":", "");
  const allFiles = await db.leadFiles(s.id);
  const latest = new Map<string, { storage_path: string; filename: string }>();
  for (const f of allFiles) latest.set(f.item_key, { storage_path: f.storage_path, filename: f.filename });
  const files = [...latest.entries()].map(([item_key, f]) => ({
    storage_path: f.storage_path,
    filename: `${stamp} ${item_key}--${f.filename}`,
  }));

  const drivePayload = {
    lead_ref: d.lead_ref,
    deal_id: d.deal_id,
    client_code: client.client_code,
    client_folder_id: client.drive_folder_id,
    company: c.company ?? "",
    files,
    summary_md: summaryMd,
    lld:
      d.lld_path && d.lld_file
        ? { filename: `${stamp} ${d.lld_file}`, storage_path: d.lld_path }
        : null,
    stamp,
  };

  let handoffTrouble = false;
  if (cfg.mockDrive) {
    await db.insertHandoffRetry(leadId, "drive", drivePayload, "MOCK_DRIVE — logged, not sent", true);
    await noteTask(s.id, "Create Drive workspace", "completed", "demo mode — logged, not sent");
  } else {
    try {
      const res = await trackTask(
        s.id,
        "Create Drive workspace",
        async () => {
          const { driveHandoff } = await import("./drive");
          return driveHandoff(drivePayload);
        },
        { detail: () => d.deal_id ?? null, failDetail: "queued for automatic retry" },
      );
      d.drive = { folder_id: res.folder_id, folder_url: res.folder_url };
      await db.updateLead(leadId, {
        drive_folder_id: res.folder_id,
        drive_folder_url: res.folder_url,
        drive_committed: true,
      });
      if (res.client_folder_id && res.client_folder_id !== client.drive_folder_id) {
        await db.updateClient(client.id, {
          drive_folder_id: res.client_folder_id,
          drive_folder_url: res.client_folder_url,
        });
      }
      // Register step 7: write the Drive Folder Link back onto the Deals tab.
      try {
        const { register } = await import("./register");
        await register().setDealFolderLink(d.deal_id!, res.folder_url);
      } catch (err) {
        console.error(`register folder-link write failed deal=${d.deal_id}`, err);
      }
      console.info(`xor lead=${d.lead_ref} deal=${d.deal_id} handoff=drive ok`);
    } catch (err) {
      handoffTrouble = true;
      console.error(`drive handoff failed lead=${d.lead_ref}`, err);
      await db.insertHandoffRetry(leadId, "drive", drivePayload, String(err), false);
    }
  }

  const row = funnelRow(s, summary, quantity, timeline, files.length);
  if (cfg.mockDrive) {
    await db.insertHandoffRetry(leadId, "sheet", { row }, "MOCK_DRIVE — logged, not sent", true);
    await noteTask(s.id, "Log to sales funnel", "completed", "demo mode — logged, not sent");
  } else {
    try {
      await trackTask(
        s.id,
        "Log to sales funnel",
        async () => {
          const { appendFunnelRow } = await import("./sheets");
          await appendFunnelRow(row);
        },
        { failDetail: "queued for automatic retry" },
      );
      await db.updateLead(leadId, { sheet_appended: true });
      console.info(`xor lead=${d.lead_ref} handoff=sheet ok`);
    } catch (err) {
      handoffTrouble = true;
      console.error(`funnel append failed lead=${d.lead_ref}`, err);
      await db.insertHandoffRetry(leadId, "sheet", { row }, String(err), false);
    }
  }

  // The visitor gets only the LLD download link — the Drive folder is
  // internal to the team.
  const links: { label: string; url: string }[] = [];
  if (d.lld_file) {
    links.push({
      label: "Download your LLD draft",
      url: `/api/download/${s.id}/${encodeURIComponent(d.lld_file)}`,
    });
  }
  links.push({ label: "Track this in your account", url: "/account" });

  d.finalized = true;
  const first = (c.name ?? "").split(/\s+/)[0] ?? "";
  const trackLines: Record<string, string> = {
    ODM: "a sales engineer will review the requirement and your LLD draft, then set up an architecture call",
    EMS: "the team will review your build package and come back with clarifications and a quote plan",
    PRODUCT: "the team will share the matching catalogue and pricing",
  };
  const trackLine = trackLines[s.track ?? ""] ?? "the team will take it from here";
  let msg =
    `All set${first ? ", " + first : ""} — your requirement is logged as ` +
    `${d.deal_id ?? d.lead_ref}. Within one working day ${trackLine}, on ` +
    `${c.email ?? "your email"}.`;
  if (handoffTrouble) {
    msg += " (Our filing system had a hiccup just now, but your intake is saved and the team has it.)";
  }
  return out(
    s,
    [msg],
    [
      card("What happens next", "1. Sales engineering review\n2. Scoping call\n3. Proposal", links),
      chips([{ id: "restart", label: "Start another enquiry" }]),
    ],
  );
}

function leadSummary(s: SessionRow): { summary: string; quantity: string; timeline: string } {
  const d = s.data;
  if (s.track === "ODM") {
    return {
      summary: (d.slots.product_concept ?? "").slice(0, 120),
      quantity: d.slots.target_qty ?? "",
      timeline: d.slots.timeline ?? "",
    };
  }
  if (s.track === "EMS") {
    const n = Object.values(d.checklist).filter((v) => v.status === "uploaded").length;
    return {
      summary: `PCBA/build RFQ — ${n} files received`,
      quantity: d.ems_details.quantity ?? "",
      timeline: d.ems_details.target_date ?? "",
    };
  }
  return {
    summary:
      `Ready product: ${d.product.category ?? ""} — ` +
      `${(d.product.customization || "no customization").slice(0, 80)}`,
    quantity: d.product.quantity ?? "",
    timeline: d.product.timeline ?? "",
  };
}

function funnelRow(
  s: SessionRow,
  summary: string,
  quantity: string,
  timeline: string,
  fileCount: number,
): (string | number)[] {
  const c = s.data.contact;
  return [
    istTimestamp(),
    s.data.deal_id ?? s.data.lead_ref ?? "",
    c.company ?? "",
    c.name ?? "",
    c.email ?? "",
    c.phone ?? "",
    TRACK_LABELS[s.track ?? ""] ?? s.track ?? "",
    summary,
    quantity,
    timeline,
    fileCount,
    s.data.drive.folder_url ?? "",
    "XOR Bot",
    "New MQL",
  ];
}

function intakeSummary(s: SessionRow): string {
  const d = s.data;
  const c = d.contact;
  const lines = [
    `# Intake ${d.deal_id ?? d.lead_ref} — ${c.company ?? ""}`,
    `*Captured by XOR Assist · ${istHuman()}*`,
    "",
    `**Client ID:** ${d.client_code ?? "—"} · **Deal ID:** ${d.deal_id ?? "—"} · **Funnel ref:** ${d.lead_ref}`,
    `**Track:** ${TRACK_LABELS[s.track ?? ""] ?? s.track ?? ""}`,
    `**Contact:** ${c.name ?? ""} · ${c.email ?? ""} · ${c.phone ?? ""}`,
    "",
  ];
  if (Object.keys(d.entities).length) {
    lines.push(`**Triage hints:** ${JSON.stringify(d.entities)}`, "");
  }
  if (s.track === "ODM") {
    lines.push("## Requirement");
    for (const [k] of ODM_SLOTS) {
      if (k in d.slots) lines.push(`- **${ODM_SLOT_LABELS[k]}:** ${d.slots[k]}`);
    }
    if (d.lld_file) lines.push("", `LLD draft generated: \`${d.lld_file}\``);
  } else if (s.track === "EMS") {
    lines.push("## Build package");
    for (const item of EMS_CHECKLIST) {
      const st = d.checklist[item.key];
      const status = st?.status ?? "not provided";
      const fn = st?.filename ? ` — \`${st.filename}\`` : "";
      const flag = item.required && status !== "uploaded" ? " ⚠ required — needed for quote" : "";
      lines.push(`- ${item.label}: **${status}**${fn}${flag}`);
    }
    lines.push(
      "",
      `**Quantity:** ${d.ems_details.quantity ?? ""}`,
      `**Target date:** ${d.ems_details.target_date ?? ""}`,
      `**Notes:** ${d.ems_details.notes || "—"}`,
    );
  } else {
    lines.push(
      "## Product enquiry",
      `- **Category:** ${d.product.category ?? ""}`,
      `- **Quantity:** ${d.product.quantity ?? ""}`,
      `- **Timeline:** ${d.product.timeline ?? ""}`,
      `- **Customization:** ${d.product.customization || "—"}`,
    );
  }
  lines.push("", "---", "*Source: XOR page intake bot*");
  return lines.join("\n");
}

// ───────────────────────────── resume ─────────────────────────────────────
function resumeWidget(s: SessionRow): Widget | null {
  switch (s.state) {
    case "DISCOVER":
      return chips(TRACK_CHIPS);
    case "TRACK_CONFIRM": {
      const others = TRACK_CHIPS.slice(0, 3).filter(
        (c) => c.id !== `track:${s.data.proposed_track}`,
      );
      return chips([{ id: "confirm:yes", label: "Yes, that's right" }, ...others]);
    }
    case "CONTACT":
      return form("contact", "How do we reach you?", CONTACT_FORM, "Save & continue");
    case "CLIENT_INDUSTRY":
      return industryChips();
    case "CLIENT_ORGSIZE":
      return orgSizeChips();
    case "EMS_CHECKLIST": {
      const cur = currentEmsItem(s);
      return cur ? uploadWidget(cur) : checklistWidget(s);
    }
    case "EMS_DETAILS":
      return form("ems_details", "Build details", EMS_DETAILS_FORM, "Submit requirement");
    case "PRODUCT_CATEGORY":
      return chips(PRODUCT_CATEGORIES.map(([cid, label]) => ({ id: `cat:${cid}`, label })));
    case "PRODUCT_DETAILS":
      return form("product_details", "What you need", PRODUCT_DETAILS_FORM, "Submit enquiry");
    case "ODM_REVIEW":
      return chips(reviewChips());
    case "DONE":
      return chips([{ id: "restart", label: "Start another enquiry" }]);
    default:
      return null;
  }
}

async function resume(s: SessionRow): Promise<ChatOut> {
  const promptsByState: Record<SessionState, string> = {
    DISCOVER: "Where were we — what are you building?",
    TRACK_CONFIRM: "Have I got the track right?",
    CONTACT: "Just the contact form and we'll keep moving.",
    CLIENT_INDUSTRY: "Which industry fits your company best?",
    CLIENT_ORGSIZE: "And the organisation size?",
    ODM_SLOTS: resumeOdmQuestion(s),
    ODM_REVIEW: "Ready to generate the LLD draft, or change an answer?",
    EMS_CHECKLIST: "Whenever you're ready with the next file.",
    EMS_DETAILS: "Just the build details left.",
    PRODUCT_CATEGORY: "Pick the closest category.",
    PRODUCT_DETAILS: "Just the last form to go.",
    DONE: "This enquiry is logged. Want to start another?",
  };
  const w = resumeWidget(s);
  return out(s, [promptsByState[s.state] ?? "Go on…"], w ? [w] : []);
}

function resumeOdmQuestion(s: SessionRow): string {
  const nxt = ODM_SLOTS.find(([k]) => !(k in s.data.slots));
  if (!nxt) return "One second…";
  s.data.expected_slot = nxt[0];
  return nxt[1] + (nxt[2] ? ` (${nxt[2]})` : "");
}

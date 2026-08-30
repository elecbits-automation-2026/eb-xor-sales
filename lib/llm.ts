/**
 * LLM layer — the *language* half of the hybrid.
 *
 * Real mode: Anthropic API with forced tool-use for structured output.
 * Mock mode (MOCK_LLM=true): deterministic keyword rules, so the whole bot
 * can be demoed and tested with zero keys. Both modes expose the same 4
 * functions, and EVERY real-mode call falls back to the mock/template
 * behaviour on error — a dead LLM must never kill the intake.
 */
import Anthropic from "@anthropic-ai/sdk";

import { brainContext } from "@/lib/brain";
import { cfg } from "@/lib/config";
import { ODM_SLOT_LABELS } from "@/lib/flows";
import { retrieveContext } from "@/lib/knowledge";
import { templateBenchmark, templateLld } from "@/lib/lld";
import {
  TOOL_SLOTS,
  TOOL_TRIAGE,
  buildBenchmarkSystem,
  buildLldSystem,
  buildQaStable,
  buildSlotsSystem,
  buildTriageStable,
  kbBackground,
  qaExcerpts,
} from "@/lib/prompts";
import type { Msg, Track, TriageTrack } from "@/lib/widgets";

export interface TriageResult {
  reply: string;
  track: TriageTrack;
  confidence: number;
  entities: Record<string, string>;
}

// ─────────────────────────── real-mode helpers ───────────────────────────
// Created lazily on first use — the key may be absent in mock mode.
let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: cfg.anthropicApiKey });
  return client;
}

/**
 * System prompt as blocks with a cache breakpoint after the STABLE half.
 * The brain makes system prompts large (tens of KB) yet stable for an hour;
 * per-request material (retrieved excerpts) varies every call. Caching only
 * works on an unchanged prefix — so the stable text carries cache_control
 * and anything volatile rides in a second, uncached block. This is most of
 * the latency (and cost) of each opus call.
 */
function systemBlocks(stable: string, volatile = ""): Anthropic.TextBlockParam[] {
  const blocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: stable, cache_control: { type: "ephemeral" } },
  ];
  if (volatile.trim()) blocks.push({ type: "text", text: volatile });
  return blocks;
}

/**
 * Server-side web search (runs on Anthropic's infra inside the same request
 * — no client loop, no keys). Lets the bot pull REAL product benchmarks and
 * standards when a customer says "look at the top 5 on Amazon".
 */
function webSearchTool(maxUses: number): Anthropic.Tool {
  return {
    type: "web_search_20260209",
    name: "web_search",
    max_uses: maxUses,
  } as unknown as Anthropic.Tool;
}

/** Continue a response the server paused mid-search (stop_reason pause_turn).
 *  onTurn fires after every server round-trip with that round's response —
 *  callers use it to narrate live progress (e.g. the searches just run). */
async function createResuming(
  params: Omit<Anthropic.MessageCreateParamsNonStreaming, "messages">,
  messages: Anthropic.MessageParam[],
  onTurn?: (resp: Anthropic.Message) => void,
): Promise<Anthropic.Message> {
  let msgs = messages;
  let resp = await getClient().messages.create({ ...params, messages: msgs });
  onTurn?.(resp);
  for (let i = 0; i < 3 && resp.stop_reason === "pause_turn"; i++) {
    msgs = [...msgs, { role: "assistant", content: resp.content }];
    resp = await getClient().messages.create({ ...params, messages: msgs });
    onTurn?.(resp);
  }
  return resp;
}

/** The web searches a response actually ran, for progress narration. */
function searchQueries(resp: Anthropic.Message): string[] {
  const out: string[] = [];
  for (const block of resp.content) {
    if (block.type === "server_tool_use" && block.name === "web_search") {
      const q = (block.input as { query?: string } | null)?.query;
      if (q) out.push(q);
    }
  }
  return out;
}

/**
 * One Claude call that must answer via the given tool; returns its input.
 * With webSearch enabled the tool choice relaxes to auto so the model may
 * search FIRST — a nudge turn guarantees the recording tool still gets
 * called before we give up.
 */
async function callTool(
  stableSystem: string,
  messages: Anthropic.MessageParam[],
  tool: Anthropic.Tool,
  volatileSystem = "",
  webSearch = false,
): Promise<Record<string, unknown>> {
  let msgs = messages;
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await createResuming(
      {
        model: cfg.model,
        max_tokens: webSearch ? 4096 : 1024,
        system: systemBlocks(stableSystem, volatileSystem),
        tools: webSearch ? [webSearchTool(3), tool] : [tool],
        tool_choice: webSearch ? { type: "auto" } : { type: "tool", name: tool.name },
      },
      msgs,
    );
    for (const block of resp.content) {
      if (block.type === "tool_use" && block.name === tool.name) {
        return block.input as Record<string, unknown>;
      }
    }
    if (!webSearch) break; // forced choice — a retry can't change anything
    msgs = [
      ...msgs,
      { role: "assistant", content: resp.content },
      { role: "user", content: `Now record this turn by calling ${tool.name} exactly once.` },
    ];
  }
  throw new Error("model returned no tool_use block");
}

function history(msgs: Msg[], userText: string, limit = 12): Anthropic.MessageParam[] {
  // The Messages API requires the first message to be a user turn; the
  // sliding window can land on an assistant message, so trim the head.
  const win = msgs.slice(-limit);
  while (win.length && win[0].role !== "user") win.shift();
  const out: Anthropic.MessageParam[] = win.map((m) => ({ role: m.role, content: m.content }));
  out.push({ role: "user", content: userText });
  return out;
}

/** Web-search responses carry <cite index="…">…</cite> markup — strip it
 *  everywhere customer-facing; the words stay, the tags go. */
function stripCites(s: string): string {
  return s.replace(/<\/?cite[^>]*>/g, "");
}

function joinText(content: Anthropic.ContentBlock[]): string {
  return stripCites(
    content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim(),
  );
}

const TRIAGE_TRACKS: TriageTrack[] = ["ODM", "EMS", "PRODUCT", "QUESTION", "UNCLEAR"];

/** Coerce a tool_use input into a well-typed TriageResult. */
function coerceTriage(input: Record<string, unknown>): TriageResult {
  const track = TRIAGE_TRACKS.includes(input.track as TriageTrack)
    ? (input.track as TriageTrack)
    : "UNCLEAR";
  const entities: Record<string, string> = {};
  if (input.entities && typeof input.entities === "object") {
    for (const [k, v] of Object.entries(input.entities as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) entities[k] = v;
    }
  }
  return {
    reply: typeof input.reply === "string" ? input.reply : "",
    track,
    confidence: typeof input.confidence === "number" ? input.confidence : 0,
    entities,
  };
}

// ────────────────────────────── triage ───────────────────────────────────
export async function triage(history_: Msg[], userText: string): Promise<TriageResult> {
  if (cfg.mockLlm) return mockTriage(userText);
  try {
    // Retrieval never throws (returns [] on any error), so a KB outage
    // costs only the extra context, never the triage call itself. Same
    // guarantee from the brain: cached Drive-doc text, or "".
    const chunks = await retrieveContext(userText);
    const brain = await brainContext();
    const out = await callTool(
      buildTriageStable(brain),
      history(history_, userText),
      TOOL_TRIAGE,
      kbBackground(chunks.slice(0, 3)),
    );
    return coerceTriage(out);
  } catch (err) {
    console.error("triage failed; falling back to mock rules:", err);
    return mockTriage(userText);
  }
}

// ─────────────────────── ODM slot extraction ─────────────────────────────
export async function extractSlots(
  slotsSoFar: Record<string, string>,
  expectedSlot: string | null,
  userText: string,
  remainingSlots: { key: string; label: string }[] = [],
  recent: Msg[] = [],
  channel: "voice" | "text" = "text",
): Promise<{ updates: Record<string, string>; ack: string; nextQuestion?: string }> {
  if (cfg.mockLlm) {
    const updates: Record<string, string> = expectedSlot
      ? { [expectedSlot]: userText.trim() }
      : {};
    return { updates, ack: "Got it." };
  }
  const schemaDesc = JSON.stringify(ODM_SLOT_LABELS, null, 1);
  // The tail of the dialogue, so re-asks vary and questions can reference
  // what was actually said (kept short — the brain dominates the prompt).
  const convo = recent
    .slice(-8)
    .map((m) => `${m.role === "user" ? "Customer" : "You"}: ${m.content.slice(0, 240)}`)
    .join("\n");
  const context =
    `Slot schema (key -> label):\n${schemaDesc}\n\n` +
    `Values so far: ${JSON.stringify(slotsSoFar)}\n` +
    `The last question asked about slot: ${expectedSlot}\n` +
    `Remaining slots, in order (next_question targets the first one your ` +
    `updates leave unfilled): ${JSON.stringify(remainingSlots)}\n\n` +
    (convo ? `Recent conversation:\n${convo}\n\n` : "") +
    `Input channel: ${channel}\n` +
    `Customer message: ${userText}`;
  try {
    const brain = await brainContext(); // never throws — cached text or ""
    const out = await callTool(
      buildSlotsSystem(brain),
      [{ role: "user", content: context }],
      TOOL_SLOTS,
      "",
      true, // web search: real benchmarks when the customer references products
    );
    const raw =
      out.updates && typeof out.updates === "object"
        ? (out.updates as Record<string, unknown>)
        : {};
    const updates: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k in ODM_SLOT_LABELS && String(v).trim()) updates[k] = String(v);
    }
    // NO force-fill: when the model judged the message unusable for the
    // asked slot, the orchestrator re-asks (bounded by maxProbeTurns) —
    // "paneer pakoda" must never become the product concept.
    const ack = typeof out.ack === "string" && out.ack ? stripCites(out.ack) : "Noted.";
    const nq =
      typeof out.next_question === "string" ? stripCites(out.next_question).trim() : "";
    return { updates, ack, nextQuestion: nq && nq.length <= 300 ? nq : undefined };
  } catch (err) {
    console.error("slot extraction failed; using raw text:", err);
    return {
      updates: expectedSlot ? { [expectedSlot]: userText.trim() } : {},
      ack: "Noted.",
    };
  }
}

// ───────────────────────────── general Q&A ───────────────────────────────
export async function answerQuestion(history_: Msg[], userText: string): Promise<string> {
  if (cfg.mockLlm) {
    return (
      "Elecbits is a full-stack ESDM company — design (ODM), EMS " +
      "manufacturing and rapid prototyping under one roof, run on the " +
      "XoR platform. The engineering team can go deeper on a " +
      "call. What are you building?"
    );
  }
  try {
    const chunks = await retrieveContext(userText);
    const brain = await brainContext(); // never throws — cached text or ""
    const resp = await createResuming(
      {
        model: cfg.model,
        max_tokens: 1024,
        system: systemBlocks(buildQaStable(chunks.length > 0, brain), qaExcerpts(chunks)),
        tools: [webSearchTool(3)],
      },
      history(history_, userText),
    );
    return joinText(resp.content);
  } catch (err) {
    console.error("qa failed:", err);
    return (
      "Good question — the engineering team will pick that up in " +
      "the call. Meanwhile, tell me a bit about what you're building?"
    );
  }
}

// ─────────────────────────── LLD generation ──────────────────────────────
/**
 * Long-document author shared by the LLD and benchmark generators: retries
 * a failed attempt once, continues a max_tokens-truncated draft in place,
 * and REFUSES to return junk — a document under minChars is a failure, not
 * a deliverable. Callers surface the failure honestly; there is no silent
 * template fallback in real mode (a hollow shell reaching a customer is
 * strictly worse than an honest retry).
 */
async function authorDoc(p: {
  system: ReturnType<typeof systemBlocks>;
  userContent: string;
  maxTokens: number;
  searches: number;
  minChars: number;
  label: string;
  /** Live sub-stage narration (shows on the running task row). */
  onStage?: (stage: string) => void;
}): Promise<string> {
  const stage = p.onStage ?? (() => undefined);
  let lastErr: unknown = new Error(`${p.label}: no attempt ran`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Narrate the searches each server round actually ran; a round with
      // none means the engine is past research and writing the document.
      const narrate = (resp: Anthropic.Message): void => {
        const qs = searchQueries(resp);
        if (qs.length) {
          stage(`web research: "${qs[qs.length - 1]}"${qs.length > 1 ? ` (+${qs.length - 1} more)` : ""}`);
        } else if (resp.stop_reason !== "pause_turn") {
          stage("writing the document");
        }
      };
      stage(attempt === 0 ? "researching the market (web search on)" : "second pass — first draft was too thin");
      const msgs: Anthropic.MessageParam[] = [{ role: "user", content: p.userContent }];
      let resp = await createResuming(
        {
          model: cfg.model,
          max_tokens: p.maxTokens,
          system: p.system,
          tools: [webSearchTool(p.searches)],
        },
        msgs,
        narrate,
      );
      let text = joinText(resp.content);
      // Ran out of output budget mid-document → continue where it stopped
      // (tools off — the research happened in the first pass).
      for (let cont = 0; cont < 2 && resp.stop_reason === "max_tokens" && text; cont++) {
        stage("long document — continuing where it stopped");
        msgs.push(
          { role: "assistant", content: joinText(resp.content) },
          {
            role: "user",
            content:
              "Continue the document from EXACTLY where it stopped — no " +
              "preamble, no repetition; finish every remaining section.",
          },
        );
        resp = await createResuming(
          { model: cfg.model, max_tokens: p.maxTokens, system: p.system },
          msgs,
        );
        text += joinText(resp.content);
      }
      const clean = stripCites(text).trim();
      if (clean.length >= p.minChars) return clean;
      lastErr = new Error(`${p.label} came back too thin (${clean.length} chars)`);
      console.error(String(lastErr));
    } catch (err) {
      lastErr = err;
      console.error(`${p.label} attempt ${attempt + 1} failed:`, err);
    }
  }
  throw lastErr;
}

export async function generateLld(
  slots: Record<string, string>,
  contact: Record<string, string>,
  leadRef: string,
  recent: Msg[] = [],
  revision?: { prior: string; feedback: string },
  onStage?: (stage: string) => void,
): Promise<string> {
  if (cfg.mockLlm) return templateLld(slots, contact, leadRef);
  const stage = onStage ?? (() => undefined);
  const brief = Object.entries(slots)
    .map(([k, v]) => `- ${ODM_SLOT_LABELS[k] ?? k}: ${v}`)
    .join("\n");
  // The transcript usually carries MORE engineering signal than the slot
  // values (protocol discussions, references, constraints stated in
  // passing) — the architect must see it.
  const convo = recent
    .slice(-30)
    .map((m) => `${m.role === "user" ? "Customer" : "XoR"}: ${m.content.slice(0, 280)}`)
    .join("\n");
  stage("reading your conversation and the intake");
  const brain = await brainContext(); // never throws — cached text or ""
  // The REAL Elecbits LLD templates (Sales Collateral / LLD) are the
  // authoritative shape of the document; the playbook is the method.
  stage("loading the house LLD templates from Drive");
  const { lldTemplatesText } = await import("./drive");
  const houseTpl = await lldTemplatesText().catch(() => "");
  // Pull the most relevant company material for THIS product from the
  // pgvector KB — reference designs, SOP sections, past LLD patterns.
  stage(houseTpl ? "templates loaded — pulling matching knowledge" : "pulling matching knowledge");
  const query = [slots.product_concept, slots.key_features].filter(Boolean).join(" — ");
  const chunks = query ? await retrieveContext(query) : [];
  return authorDoc({
    onStage,
    system: systemBlocks(buildLldSystem(brain, houseTpl), kbBackground(chunks.slice(0, 6))),
    userContent:
      `Intake ref ${leadRef} for ${contact["company"] ?? "the customer"}.\n` +
      `Intake answers:\n${brief}\n\n` +
      (convo ? `Conversation transcript:\n${convo}\n\n` : "") +
      (revision
        ? `Previous draft:\n${revision.prior.slice(0, 12000)}\n\n` +
          `The customer reviewed it and asks:\n${revision.feedback}\n\n` +
          `Rewrite the COMPLETE LLD applying the requested changes (every section).`
        : `Write the LLD draft.`),
    maxTokens: 8000,
    searches: 5,
    minChars: 4000,
    label: "LLD generation",
  });
}

// ──────────── Product Definition & Benchmark Report (Outcome A) ───────────
export async function generateBenchmark(
  slots: Record<string, string>,
  contact: Record<string, string>,
  leadRef: string,
  recent: Msg[] = [],
  revision?: { prior: string; feedback: string },
  onStage?: (stage: string) => void,
): Promise<string> {
  if (cfg.mockLlm) return templateBenchmark(slots, contact, leadRef);
  const stage = onStage ?? (() => undefined);
  const brief = Object.entries(slots)
    .map(([k, v]) => `- ${ODM_SLOT_LABELS[k] ?? k}: ${v}`)
    .join("\n");
  // The transcript is the Stage-A goldmine: reference links, wishlist,
  // differentiation and price intent usually live there, not in the slots.
  const convo = recent
    .slice(-40)
    .map((m) => `${m.role === "user" ? "Customer" : "XoR"}: ${m.content.slice(0, 400)}`)
    .join("\n");
  stage("reading your conversation and the intake");
  const brain = await brainContext(); // never throws — cached text or ""
  const query = [slots.product_concept, slots.key_features].filter(Boolean).join(" — ");
  const chunks = query ? await retrieveContext(query) : [];
  return authorDoc({
    onStage,
    system: systemBlocks(buildBenchmarkSystem(brain), kbBackground(chunks.slice(0, 4))),
    userContent:
      `Intake ref ${leadRef} for ${contact["company"] ?? "the customer"}.\n` +
      `Intake answers:\n${brief}\n\n` +
      (convo ? `Conversation transcript:\n${convo}\n\n` : "") +
      (revision
        ? `Previous report:\n${revision.prior.slice(0, 12000)}\n\n` +
          `The customer reviewed it and asks:\n${revision.feedback}\n\n` +
          `Rewrite the COMPLETE report applying the requested changes.`
        : `Write the Product Definition & Benchmark Report.`),
    maxTokens: 8000,
    searches: 8, // the bench: re-verify listings, fill gaps
    minChars: 3000,
    label: "benchmark generation",
  });
}

// ───────────────────────── mock triage rules ─────────────────────────────
const _EMS_WORDS = [
  "gerber", "bom", "bill of material", "pcba", "assembl", "smt",
  "manufactur", "production run", "contract manufact", "fabricat",
  "existing design", "have the design", "have a design", "ems",
];
const _ODM_WORDS = [
  "design", "develop", "idea", "concept", "prototype", "odm",
  "build a", "new product", "r&d", "lld", "from scratch", "want to make",
];
const _PRODUCT_WORDS = [
  "buy", "catalog", "catalogue", "off the shelf", "off-the-shelf",
  "price of", "sell", "soundbox", "adapter", "charger",
  "white label", "white-label", "ready product", "your products",
];
const _QUESTION_STARTS = [
  "what", "who", "where", "how", "do you", "can you", "are you", "tell me about",
];

function mockTriage(text: string): TriageResult {
  const t = text.toLowerCase();
  const count = (words: string[]): number =>
    words.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
  const scores: Record<Track, number> = {
    EMS: count(_EMS_WORDS),
    ODM: count(_ODM_WORDS),
    PRODUCT: count(_PRODUCT_WORDS),
  };
  let best: Track = "EMS";
  for (const k of ["EMS", "ODM", "PRODUCT"] as Track[]) {
    if (scores[k] > scores[best]) best = k;
  }
  const top = scores[best];
  const tie = Object.values(scores).filter((v) => v === top).length > 1;
  const qty = /\b([\d,]{2,}\s*(?:k|units|pcs|pieces|nos)?)\b/.exec(t);
  const entities: Record<string, string> = qty ? { quantity_hint: qty[1] } : {};

  if (top === 0 || tie) {
    if (_QUESTION_STARTS.some((s) => t.trim().startsWith(s))) {
      return { reply: "", track: "QUESTION", confidence: 0.8, entities };
    }
    return {
      reply:
        "Happy to help. Quick one so I route you right — do you " +
        "already have a completed design (BoM/Gerbers), or is this " +
        "a new product you want designed?",
      track: "UNCLEAR",
      confidence: 0.4,
      entities,
    };
  }
  const replies: Record<Track, string> = {
    EMS: "Sounds like a manufacturing requirement — you have the design, we build it.",
    ODM: "Sounds like a new product you'd like designed end-to-end.",
    PRODUCT: "Sounds like you're after one of our ready products.",
  };
  return {
    reply: replies[best],
    track: best,
    confidence: top >= 2 ? 0.9 : 0.8,
    entities,
  };
}

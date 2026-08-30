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

import { cfg } from "@/lib/config";
import { ODM_SLOT_LABELS } from "@/lib/flows";
import { retrieveContext } from "@/lib/knowledge";
import { templateLld } from "@/lib/lld";
import {
  SYSTEM_LLD,
  SYSTEM_SLOTS,
  TOOL_SLOTS,
  TOOL_TRIAGE,
  buildQaSystem,
  buildTriageSystem,
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

/** One Claude call that must answer via the given tool; returns its input. */
async function callTool(
  system: string,
  messages: Anthropic.MessageParam[],
  tool: Anthropic.Tool,
): Promise<Record<string, unknown>> {
  const resp = await getClient().messages.create({
    model: cfg.model,
    max_tokens: 1024,
    system,
    messages,
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
  });
  for (const block of resp.content) {
    if (block.type === "tool_use") return block.input as Record<string, unknown>;
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

function joinText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
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
    // costs only the extra context, never the triage call itself.
    const chunks = await retrieveContext(userText);
    const out = await callTool(
      buildTriageSystem(chunks.slice(0, 3)),
      history(history_, userText),
      TOOL_TRIAGE,
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
): Promise<{ updates: Record<string, string>; ack: string }> {
  if (cfg.mockLlm) {
    const updates: Record<string, string> = expectedSlot
      ? { [expectedSlot]: userText.trim() }
      : {};
    return { updates, ack: "Got it." };
  }
  const schemaDesc = JSON.stringify(ODM_SLOT_LABELS, null, 1);
  const context =
    `Slot schema (key -> label):\n${schemaDesc}\n\n` +
    `Values so far: ${JSON.stringify(slotsSoFar)}\n` +
    `The last question asked about slot: ${expectedSlot}\n\n` +
    `Customer message: ${userText}`;
  try {
    const out = await callTool(SYSTEM_SLOTS, [{ role: "user", content: context }], TOOL_SLOTS);
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
    const ack = typeof out.ack === "string" && out.ack ? out.ack : "Noted.";
    return { updates, ack };
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
      "XoR platform. The sales engineering team can go deeper on a " +
      "call. What are you building?"
    );
  }
  try {
    const chunks = await retrieveContext(userText);
    const resp = await getClient().messages.create({
      model: cfg.model,
      max_tokens: 400,
      system: buildQaSystem(chunks),
      messages: history(history_, userText),
    });
    return joinText(resp.content);
  } catch (err) {
    console.error("qa failed:", err);
    return (
      "Good question — the sales engineering team will cover that on " +
      "the call. Meanwhile, tell me a bit about what you're building?"
    );
  }
}

// ─────────────────────────── LLD generation ──────────────────────────────
export async function generateLld(
  slots: Record<string, string>,
  contact: Record<string, string>,
  leadRef: string,
): Promise<string> {
  if (cfg.mockLlm) return templateLld(slots, contact, leadRef);
  const brief = Object.entries(slots)
    .map(([k, v]) => `- ${ODM_SLOT_LABELS[k] ?? k}: ${v}`)
    .join("\n");
  try {
    const resp = await getClient().messages.create({
      model: cfg.model,
      max_tokens: 2048,
      system: SYSTEM_LLD,
      messages: [
        {
          role: "user",
          content:
            `Intake ref ${leadRef} for ${contact["company"] ?? "the customer"}.\n` +
            `Intake answers:\n${brief}\n\nWrite the LLD draft.`,
        },
      ],
    });
    const text = joinText(resp.content);
    return text || templateLld(slots, contact, leadRef);
  } catch (err) {
    console.error("LLD generation failed; using template:", err);
    return templateLld(slots, contact, leadRef);
  }
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

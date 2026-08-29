"""LLM layer — the *language* half of the hybrid.

Real mode: Anthropic API with forced tool-use for structured output.
Mock mode (MOCK_LLM=true): deterministic keyword rules, so the whole bot can
be demoed and tested with zero keys. Both modes expose the same 4 functions.

Swap-friendly: to route through LiteLLM instead, reimplement _call_tool()
and generate_lld() against your proxy — nothing else changes.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

from . import config, prompts
from .flows import ODM_SLOT_LABELS

log = logging.getLogger("xor.llm")

_client = None
if not config.MOCK_LLM:
    import anthropic

    _client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)


# ─────────────────────────── real-mode helpers ───────────────────────────
def _call_tool(system: str, messages: list[dict], tool: dict) -> dict:
    """One Claude call that must answer via the given tool; returns its input."""
    resp = _client.messages.create(
        model=config.MODEL,
        max_tokens=1024,
        system=system,
        messages=messages,
        tools=[tool],
        tool_choice={"type": "tool", "name": tool["name"]},
    )
    for block in resp.content:
        if block.type == "tool_use":
            return block.input
    raise RuntimeError("model returned no tool_use block")


def _history(session: dict, user_text: str, limit: int = 12) -> list[dict]:
    msgs = [{"role": m["role"], "content": m["content"]}
            for m in session["history"][-limit:]]
    msgs.append({"role": "user", "content": user_text})
    return msgs


# ────────────────────────────── triage ───────────────────────────────────
def triage(session: dict, user_text: str) -> dict[str, Any]:
    """→ {reply, track, confidence, entities}"""
    if config.MOCK_LLM:
        return _mock_triage(user_text)
    try:
        out = _call_tool(prompts.SYSTEM_TRIAGE, _history(session, user_text), prompts.TOOL_TRIAGE)
        out.setdefault("entities", {})
        return out
    except Exception:
        log.exception("triage failed; falling back to mock rules")
        return _mock_triage(user_text)


# ─────────────────────── ODM slot extraction ─────────────────────────────
def extract_slots(session: dict, user_text: str) -> dict[str, Any]:
    """→ {updates: {slot: value}, ack: str}"""
    expected = session.get("expected_slot")
    if config.MOCK_LLM:
        updates = {expected: user_text.strip()} if expected else {}
        return {"updates": updates, "ack": "Got it."}
    schema_desc = json.dumps(
        {k: v for k, v in ODM_SLOT_LABELS.items()}, indent=1)
    context = (
        f"Slot schema (key -> label):\n{schema_desc}\n\n"
        f"Values so far: {json.dumps(session['slots'])}\n"
        f"The last question asked about slot: {expected}\n\n"
        f"Customer message: {user_text}"
    )
    try:
        out = _call_tool(prompts.SYSTEM_SLOTS,
                         [{"role": "user", "content": context}], prompts.TOOL_SLOTS)
        out["updates"] = {k: str(v) for k, v in (out.get("updates") or {}).items()
                          if k in ODM_SLOT_LABELS and str(v).strip()}
        # Guarantee forward progress even if the model returns nothing usable.
        if expected and expected not in out["updates"] and not out["updates"]:
            out["updates"][expected] = user_text.strip()
        out.setdefault("ack", "Noted.")
        return out
    except Exception:
        log.exception("slot extraction failed; using raw text")
        return {"updates": {expected: user_text.strip()} if expected else {},
                "ack": "Noted."}


# ───────────────────────────── general Q&A ───────────────────────────────
def answer_question(session: dict, user_text: str) -> str:
    if config.MOCK_LLM:
        return ("Elecbits is a full-stack ESDM company — design (ODM), EMS "
                "manufacturing and rapid prototyping under one roof, run on the "
                "XoR platform. The sales engineering team can go deeper on a "
                "call. What are you building?")
    try:
        resp = _client.messages.create(
            model=config.MODEL, max_tokens=400,
            system=prompts.SYSTEM_QA, messages=_history(session, user_text))
        return "".join(b.text for b in resp.content if b.type == "text").strip()
    except Exception:
        log.exception("qa failed")
        return ("Good question — the sales engineering team will cover that on "
                "the call. Meanwhile, tell me a bit about what you're building?")


# ─────────────────────────── LLD generation ──────────────────────────────
def generate_lld(slots: dict, contact: dict, lead_id: str) -> str:
    from .lld import template_lld  # local import avoids cycle
    if config.MOCK_LLM:
        return template_lld(slots, contact, lead_id)
    brief = "\n".join(f"- {ODM_SLOT_LABELS.get(k, k)}: {v}" for k, v in slots.items())
    try:
        resp = _client.messages.create(
            model=config.MODEL, max_tokens=2048,
            system=prompts.SYSTEM_LLD,
            messages=[{"role": "user",
                       "content": f"Intake ref {lead_id} for {contact.get('company','the customer')}.\n"
                                  f"Intake answers:\n{brief}\n\nWrite the LLD draft."}])
        text = "".join(b.text for b in resp.content if b.type == "text").strip()
        return text or template_lld(slots, contact, lead_id)
    except Exception:
        log.exception("LLD generation failed; using template")
        return template_lld(slots, contact, lead_id)


# ───────────────────────── mock triage rules ─────────────────────────────
_EMS_WORDS = ("gerber", "bom", "bill of material", "pcba", "assembl", "smt",
              "manufactur", "production run", "contract manufact", "fabricat",
              "existing design", "have the design", "have a design", "ems")
_ODM_WORDS = ("design", "develop", "idea", "concept", "prototype", "odm",
              "build a", "new product", "r&d", "lld", "from scratch", "want to make")
_PRODUCT_WORDS = ("buy", "catalog", "catalogue", "off the shelf", "off-the-shelf",
                  "price of", "sell", "soundbox", "adapter", "charger",
                  "white label", "white-label", "ready product", "your products")
_QUESTION_STARTS = ("what", "who", "where", "how", "do you", "can you", "are you", "tell me about")


def _mock_triage(text: str) -> dict[str, Any]:
    t = text.lower()
    scores = {
        "EMS": sum(w in t for w in _EMS_WORDS),
        "ODM": sum(w in t for w in _ODM_WORDS),
        "PRODUCT": sum(w in t for w in _PRODUCT_WORDS),
    }
    best = max(scores, key=scores.get)
    top = scores[best]
    tie = sum(1 for v in scores.values() if v == top) > 1
    qty = re.search(r"\b([\d,]{2,}\s*(?:k|units|pcs|pieces|nos)?)\b", t)
    entities = {"quantity_hint": qty.group(1)} if qty else {}

    if top == 0 or tie:
        if t.strip().startswith(_QUESTION_STARTS):
            return {"reply": "", "track": "QUESTION", "confidence": 0.8, "entities": entities}
        return {"reply": ("Happy to help. Quick one so I route you right — do you "
                          "already have a completed design (BoM/Gerbers), or is this "
                          "a new product you want designed?"),
                "track": "UNCLEAR", "confidence": 0.4, "entities": entities}
    replies = {
        "EMS": "Sounds like a manufacturing requirement — you have the design, we build it.",
        "ODM": "Sounds like a new product you'd like designed end-to-end.",
        "PRODUCT": "Sounds like you're after one of our ready products.",
    }
    return {"reply": replies[best], "track": best,
            "confidence": 0.9 if top >= 2 else 0.8, "entities": entities}

"""The hybrid engine.

The LLM (llm.py) understands language: triage, slot extraction, Q&A, LLD
drafting. This module owns everything deterministic: the state machine,
question order, file checklist, validation, Drive writes and the funnel row.

States
  DISCOVER          free text + track chips; LLM triage runs here
  TRACK_CONFIRM     bot proposed a track, user confirms/corrects
  CONTACT           name / company / email / phone form
  ODM_SLOTS         seven requirement questions (LLM extracts answers)
  ODM_REVIEW        summary card → generate LLD draft / edit / skip
  EMS_CHECKLIST     upload loop over the build package
  EMS_DETAILS       quantity / date / notes form
  PRODUCT_CATEGORY  category chips
  PRODUCT_DETAILS   quantity / timeline / customization form
  DONE              finalized: Drive folder + funnel row written
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from zoneinfo import ZoneInfo

from . import config, llm, sessions
from .drive import backbone
from .flows import (CONTACT_FORM, EMS_CHECKLIST, EMS_DETAILS_FORM, ODM_SLOTS,
                    ODM_SLOT_LABELS, PRODUCT_DETAILS_FORM)
from .models import ChatIn, ChatOut

log = logging.getLogger("xor.orchestrator")
IST = ZoneInfo("Asia/Kolkata")

_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

TRACK_CHIPS = [
    {"id": "track:ODM", "label": "Design a new product"},
    {"id": "track:EMS", "label": "I have a design — manufacture it"},
    {"id": "track:PRODUCT", "label": "Explore ready products"},
    {"id": "ask", "label": "Just a question"},
]

GREETING = ("Namaste, I'm XOR Assist. Tell me what you're building — or pick "
            "the closest fit below — and I'll route you to the right Elecbits "
            "team with everything they need to move fast.")


# ─────────────────────────── widget helpers ──────────────────────────────
def _chips(options: list[dict]) -> dict:
    return {"type": "chips", "options": options}


def _form(form_id: str, title: str, fields: list[dict], submit: str = "Continue") -> dict:
    return {"type": "form", "form_id": form_id, "title": title,
            "fields": fields, "submit_label": submit}


def _checklist(s: dict) -> dict:
    items = []
    for item in EMS_CHECKLIST:
        st = s["checklist"].get(item["key"], {}).get("status", "pending")
        items.append({"key": item["key"], "label": item["label"],
                      "status": st, "required": item["required"]})
    return {"type": "checklist", "title": "Your build package", "items": items}


def _upload(item: dict) -> dict:
    return {"type": "upload", "item": item, "allow_skip": True}


def _card(title: str, body: str = "", links: list[dict] | None = None) -> dict:
    return {"type": "card", "title": title, "body": body, "links": links or []}


def _meta(s: dict) -> dict:
    progress = None
    if s["track"] == "ODM" and s["state"] in ("ODM_SLOTS", "ODM_REVIEW"):
        progress = {"done": len(s["slots"]), "total": len(ODM_SLOTS), "label": "questions"}
    elif s["track"] == "EMS" and s["state"] in ("EMS_CHECKLIST", "EMS_DETAILS"):
        progress = {"done": len(s["checklist"]), "total": len(EMS_CHECKLIST), "label": "files"}
    return {"state": s["state"], "track": s["track"], "progress": progress}


def _out(s: dict, messages: list[str], widgets: list[dict] | None = None) -> ChatOut:
    for m in messages:
        s["history"].append({"role": "assistant", "content": m})
    s["history"] = s["history"][-40:]
    sessions.save(s)
    return ChatOut(session_id=s["id"], messages=messages,
                   widgets=widgets or [], meta=_meta(s))


# ─────────────────────────── entry points ────────────────────────────────
def handle(inp: ChatIn) -> ChatOut:
    s = sessions.get(inp.session_id)

    if inp.kind == "open":
        if s["state"] == "DISCOVER" and not s["history"]:
            return _out(s, [GREETING], [_chips(TRACK_CHIPS)])
        return _resume(s)

    if inp.kind == "chip" and inp.chip_id == "restart":
        s = sessions.create()
        return _out(s, [GREETING], [_chips(TRACK_CHIPS)])

    if inp.kind == "text" and inp.text:
        s["history"].append({"role": "user", "content": inp.text})

    state = s["state"]
    try:
        if state == "DISCOVER":
            return _discover(s, inp)
        if state == "TRACK_CONFIRM":
            return _track_confirm(s, inp)
        if state == "CONTACT":
            return _contact(s, inp)
        if state == "ODM_SLOTS":
            return _odm_slots(s, inp)
        if state == "ODM_REVIEW":
            return _odm_review(s, inp)
        if state == "EMS_CHECKLIST":
            return _ems_checklist(s, inp)
        if state == "EMS_DETAILS":
            return _ems_details(s, inp)
        if state == "PRODUCT_CATEGORY":
            return _product_category(s, inp)
        if state == "PRODUCT_DETAILS":
            return _product_details(s, inp)
        if state == "DONE":
            return _out(s, ["This enquiry is logged and the team will be in "
                            "touch. Want to raise another one?"],
                        [_chips([{"id": "restart", "label": "Start another enquiry"}])])
    except Exception:
        log.exception("orchestrator error in state %s", state)
        return _out(s, ["Something hiccuped on my side — could you say that "
                        "again? If it repeats, email sales@elecbits.in and "
                        "we'll pick it up directly."], [_resume_widget(s)] if _resume_widget(s) else [])
    return _resume(s)


def handle_upload(session_id: str, item_key: str, filename: str, path: str) -> ChatOut:
    """Called by the /api/upload endpoint after the file is safely on disk."""
    s = sessions.get(session_id)
    if s["state"] != "EMS_CHECKLIST":
        return _out(s, ["Thanks — I've kept that file. Let's continue."],
                    [_resume_widget(s)] if _resume_widget(s) else [])
    s["uploads"] = [u for u in s["uploads"] if u["item_key"] != item_key]
    s["uploads"].append({"item_key": item_key, "filename": filename, "path": path})
    s["checklist"][item_key] = {"status": "uploaded", "filename": filename}
    label = next((i["label"] for i in EMS_CHECKLIST if i["key"] == item_key), item_key)
    return _ems_next(s, f"{label} received.")


# ─────────────────────────── state handlers ──────────────────────────────
def _discover(s: dict, inp: ChatIn) -> ChatOut:
    if inp.kind == "chip":
        if inp.chip_id and inp.chip_id.startswith("track:"):
            return _set_track(s, inp.chip_id.split(":", 1)[1])
        if inp.chip_id == "ask":
            return _out(s, ["Ask away — capabilities, certifications, process, "
                            "anything."], [])
        return _resume(s)

    if not inp.text:
        return _resume(s)

    t = llm.triage(s, inp.text)
    s["entities"].update({k: v for k, v in (t.get("entities") or {}).items() if v})

    if t["track"] == "QUESTION":
        ans = llm.answer_question(s, inp.text)
        return _out(s, [ans], [_chips(TRACK_CHIPS)])

    if t["track"] in ("ODM", "EMS", "PRODUCT") and t.get("confidence", 0) >= config.TRIAGE_CONFIDENCE:
        s["proposed_track"] = t["track"]
        s["state"] = "TRACK_CONFIRM"
        others = [c for c in TRACK_CHIPS[:3] if c["id"] != f"track:{t['track']}"]
        chips = [{"id": "confirm:yes", "label": "Yes, that's right"}] + others
        msg = (t.get("reply") or "").strip()
        msg = f"{msg} Have I got that right?" if msg else "Have I got that right?"
        return _out(s, [msg], [_chips(chips)])

    # UNCLEAR or low confidence → probe, with a manual fallback after N turns
    s["probe_turns"] += 1
    if s["probe_turns"] >= config.MAX_PROBE_TURNS:
        return _out(s, ["Let me make this easy — which of these is closest?"],
                    [_chips(TRACK_CHIPS)])
    reply = (t.get("reply") or "").strip() or (
        "Got it. Do you already have a completed design (BoM/Gerbers ready), "
        "or is this a new product you want designed?")
    return _out(s, [reply], [])


def _track_confirm(s: dict, inp: ChatIn) -> ChatOut:
    if inp.kind == "chip":
        if inp.chip_id == "confirm:yes" and s.get("proposed_track"):
            return _set_track(s, s["proposed_track"])
        if inp.chip_id and inp.chip_id.startswith("track:"):
            return _set_track(s, inp.chip_id.split(":", 1)[1])
    if inp.kind == "text" and inp.text:
        s["state"] = "DISCOVER"
        return _discover(s, inp)
    return _resume(s)


def _set_track(s: dict, track: str) -> ChatOut:
    s["track"] = track
    s["state"] = "CONTACT"
    intro = {
        "ODM": "New product design it is. Quick coordinates first, then seven "
               "short questions — at the end I'll draft a first-cut LLD "
               "(low-level design) you can take into the engineering call.",
        "EMS": "Manufacturing it is. Quick coordinates first, then I'll walk "
               "you through the build package we need for an accurate quote.",
        "PRODUCT": "Let's find you the right product. Quick coordinates first "
                   "so the team can follow up with the catalogue and pricing.",
    }[track]
    return _out(s, [intro],
                [_form("contact", "How do we reach you?", CONTACT_FORM, "Save & continue")])


def _contact(s: dict, inp: ChatIn) -> ChatOut:
    if inp.kind != "form" or not inp.form or inp.form.get("form_id") != "contact":
        return _out(s, ["The quickest way is the little form below — takes ten "
                        "seconds."],
                    [_form("contact", "How do we reach you?", CONTACT_FORM, "Save & continue")])
    v = {k: str(val).strip() for k, val in (inp.form.get("values") or {}).items()}
    problems = []
    if not v.get("name"):
        problems.append("your name")
    if not v.get("company"):
        problems.append("company")
    if not _EMAIL.match(v.get("email", "")):
        problems.append("a valid email")
    if len(re.sub(r"\D", "", v.get("phone", ""))) < 8:
        problems.append("a valid phone number")
    if problems:
        return _out(s, [f"Almost — I still need {', '.join(problems)}."],
                    [_form("contact", "How do we reach you?", CONTACT_FORM, "Save & continue")])
    s["contact"] = v

    if s["track"] == "ODM":
        s["state"] = "ODM_SLOTS"
        key, q, hint = ODM_SLOTS[0]
        s["expected_slot"] = key
        first = f"Thanks {v['name'].split()[0]}. {q}"
        if hint:
            first += f" ({hint})"
        return _out(s, [first], [])

    if s["track"] == "EMS":
        s["state"] = "EMS_CHECKLIST"
        try:
            templates = backbone().fetch_templates()
        except Exception:
            log.exception("template fetch failed")
            templates = []
        widgets = [_checklist(s), _upload(EMS_CHECKLIST[0])]
        msgs = [f"Thanks {v['name'].split()[0]}. Upload whatever's ready from "
                "the list — skip anything you don't have yet and I'll flag it "
                "for the team. First up: your BoM."]
        if templates:
            widgets.insert(0, _card("Handy templates",
                                    "If you'd like our formats:",
                                    [{"label": t["name"], "url": t["url"]} for t in templates]))
        return _out(s, msgs, widgets)

    s["state"] = "PRODUCT_CATEGORY"
    chips = [{"id": f"cat:{cid}", "label": label} for cid, label in config.PRODUCT_CATEGORIES]
    return _out(s, [f"Thanks {v['name'].split()[0]}. Which category fits best?"],
                [_chips(chips)])


def _odm_slots(s: dict, inp: ChatIn) -> ChatOut:
    if inp.kind != "text" or not inp.text:
        return _resume(s)
    ext = llm.extract_slots(s, inp.text)
    s["slots"].update(ext.get("updates") or {})
    nxt = next(((k, q, h) for k, q, h in ODM_SLOTS if k not in s["slots"]), None)
    if nxt:
        key, q, hint = nxt
        s["expected_slot"] = key
        msg = f"{ext.get('ack', 'Noted.')} {q}"
        if hint:
            msg += f" ({hint})"
        return _out(s, [msg], [])
    s["expected_slot"] = None
    s["state"] = "ODM_REVIEW"
    body = "\n".join(f"**{ODM_SLOT_LABELS[k]}** — {s['slots'][k]}"
                     for k, _, _ in ODM_SLOTS if k in s["slots"])
    chips = [{"id": "lld:generate", "label": "Generate my LLD draft"},
             {"id": "lld:edit", "label": "Change an answer"},
             {"id": "lld:skip", "label": "Skip — connect me to sales"}]
    return _out(s, ["That's everything I need. Here's what I captured:"],
                [_card("Your requirement", body), _chips(chips)])


def _odm_review(s: dict, inp: ChatIn) -> ChatOut:
    if inp.kind == "chip":
        if inp.chip_id == "lld:generate":
            s["lead_id"] = s.get("lead_id") or _next_lead_id()
            lld_md = llm.generate_lld(s["slots"], s["contact"], s["lead_id"])
            fname = f"LLD-draft-{s['lead_id']}.md"
            (config.GENERATED_DIR / fname).write_text(lld_md, encoding="utf-8")
            s["lld_file"] = fname
            return _finalize(s)
        if inp.chip_id == "lld:skip":
            return _finalize(s)
        if inp.chip_id == "lld:edit":
            chips = [{"id": f"edit:{k}", "label": ODM_SLOT_LABELS[k]}
                     for k, _, _ in ODM_SLOTS]
            return _out(s, ["Which answer should we revisit?"], [_chips(chips)])
        if inp.chip_id and inp.chip_id.startswith("edit:"):
            key = inp.chip_id.split(":", 1)[1]
            slot = next(((k, q, h) for k, q, h in ODM_SLOTS if k == key), None)
            if slot:
                s["slots"].pop(key, None)
                s["expected_slot"] = key
                s["state"] = "ODM_SLOTS"
                msg = slot[1] + (f" ({slot[2]})" if slot[2] else "")
                return _out(s, [msg], [])
    if inp.kind == "text" and inp.text:
        # Treat stray text as a correction to the whole set
        ext = llm.extract_slots(s, inp.text)
        s["slots"].update(ext.get("updates") or {})
        s["state"] = "ODM_SLOTS"
        return _odm_slots(s, ChatIn(session_id=s["id"], kind="text", text="."))
    return _resume(s)


def _ems_checklist(s: dict, inp: ChatIn) -> ChatOut:
    if inp.kind == "chip" and inp.chip_id and inp.chip_id.startswith("skip:"):
        key = inp.chip_id.split(":", 1)[1]
        item = next((i for i in EMS_CHECKLIST if i["key"] == key), None)
        if item:
            s["checklist"][key] = {"status": "skipped"}
            note = (f"No problem — noted that the {item['label']} will follow. "
                    "We'll need it before a firm quote." if item["required"]
                    else "Skipped.")
            return _ems_next(s, note)
    if inp.kind == "text" and inp.text:
        ans = llm.answer_question(s, inp.text)
        cur = _current_ems_item(s)
        widgets = [_checklist(s)] + ([_upload(cur)] if cur else [])
        return _out(s, [ans], widgets)
    return _resume(s)


def _current_ems_item(s: dict) -> dict | None:
    return next((i for i in EMS_CHECKLIST if i["key"] not in s["checklist"]), None)


def _ems_next(s: dict, prefix: str) -> ChatOut:
    cur = _current_ems_item(s)
    if cur:
        return _out(s, [f"{prefix} Next: {cur['label'].lower()}. {cur['desc']}"],
                    [_checklist(s), _upload(cur)])
    s["state"] = "EMS_DETAILS"
    return _out(s, [f"{prefix} That's the package done. Last step — a few "
                    "build details:"],
                [_checklist(s),
                 _form("ems_details", "Build details", EMS_DETAILS_FORM, "Submit requirement")])


def _ems_details(s: dict, inp: ChatIn) -> ChatOut:
    if inp.kind != "form" or not inp.form or inp.form.get("form_id") != "ems_details":
        return _out(s, ["Just the short form below and we're done."],
                    [_form("ems_details", "Build details", EMS_DETAILS_FORM, "Submit requirement")])
    v = {k: str(val).strip() for k, val in (inp.form.get("values") or {}).items()}
    if not v.get("quantity") or not v.get("target_date"):
        return _out(s, ["I still need the quantity and the delivery target."],
                    [_form("ems_details", "Build details", EMS_DETAILS_FORM, "Submit requirement")])
    s["ems_details"] = v
    return _finalize(s)


def _product_category(s: dict, inp: ChatIn) -> ChatOut:
    if inp.kind == "chip" and inp.chip_id and inp.chip_id.startswith("cat:"):
        cid = inp.chip_id.split(":", 1)[1]
        label = dict(config.PRODUCT_CATEGORIES).get(cid, cid)
        s["product"]["category"] = label
    elif inp.kind == "text" and inp.text:
        s["product"]["category"] = inp.text.strip()
    else:
        return _resume(s)
    s["state"] = "PRODUCT_DETAILS"
    return _out(s, [f"{s['product']['category']} — nice. A couple of specifics:"],
                [_form("product_details", "What you need", PRODUCT_DETAILS_FORM, "Submit enquiry")])


def _product_details(s: dict, inp: ChatIn) -> ChatOut:
    if inp.kind != "form" or not inp.form or inp.form.get("form_id") != "product_details":
        return _out(s, ["The short form below finishes this up."],
                    [_form("product_details", "What you need", PRODUCT_DETAILS_FORM, "Submit enquiry")])
    v = {k: str(val).strip() for k, val in (inp.form.get("values") or {}).items()}
    if not v.get("quantity") or not v.get("timeline"):
        return _out(s, ["I still need the quantity and rough timeline."],
                    [_form("product_details", "What you need", PRODUCT_DETAILS_FORM, "Submit enquiry")])
    s["product"].update(v)
    return _finalize(s)


# ───────────────────────────── finalize ──────────────────────────────────
def _finalize(s: dict) -> ChatOut:
    s["lead_id"] = s.get("lead_id") or _next_lead_id()
    summary_md = _intake_summary(s)
    links: list[dict] = []
    drive_ok = True
    try:
        bb = backbone()
        folder = bb.ensure_account_folder(s["lead_id"], s["contact"].get("company", ""))
        s["drive"] = {"folder_id": folder["folder_id"], "folder_url": folder["folder_url"]}
        for up in s["uploads"]:
            bb.upload_file(folder, up["path"], up["filename"])
        bb.write_text(folder, f"{s['lead_id']}-intake-summary.md", summary_md)
        if s.get("lld_file"):
            lld_text = (config.GENERATED_DIR / s["lld_file"]).read_text(encoding="utf-8")
            bb.write_text(folder, s["lld_file"], lld_text)
        bb.append_funnel_row(_funnel_row(s))
        if not str(folder["folder_url"]).startswith("mock://"):
            links.append({"label": "Drive folder", "url": folder["folder_url"]})
    except Exception:
        drive_ok = False
        log.exception("Drive/funnel write failed — intake preserved locally")
        # Never lose a lead: keep summary + row on local disk for manual entry.
        fallback = config.GENERATED_DIR / f"{s['lead_id']}-FAILED-DRIVE.md"
        fallback.write_text(summary_md + "\n\nFUNNEL ROW:\n" +
                            json.dumps(_funnel_row(s)), encoding="utf-8")

    if s.get("lld_file"):
        links.append({"label": "Download your LLD draft",
                      "url": f"/api/download/{s['id']}/{s['lld_file']}"})

    s["state"] = "DONE"
    s["finalized"] = True
    name = (s["contact"].get("name", "").split() or [""])[0]
    track_line = {
        "ODM": "a sales engineer will review the requirement and your LLD draft, then set up an architecture call",
        "EMS": "the team will review your build package and come back with clarifications and a quote plan",
        "PRODUCT": "the team will share the matching catalogue and pricing",
    }.get(s["track"], "the team will take it from here")
    msg = (f"All set{', ' + name if name else ''} — your requirement is logged "
           f"as {s['lead_id']}. Within one working day {track_line}, on "
           f"{s['contact'].get('email', 'your email')}.")
    if not drive_ok:
        msg += " (Our filing system had a hiccup just now, but your intake is saved and the team has it.)"
    widgets = [_card("What happens next",
                     "1. Sales engineering review\n2. Scoping call\n3. Proposal",
                     links),
               _chips([{"id": "restart", "label": "Start another enquiry"}])]
    return _out(s, [msg], widgets)


def _funnel_row(s: dict) -> list:
    c, track = s["contact"], s["track"]
    if track == "ODM":
        summary = s["slots"].get("product_concept", "")[:120]
        qty = s["slots"].get("target_qty", "")
        timeline = s["slots"].get("timeline", "")
    elif track == "EMS":
        n = sum(1 for v in s["checklist"].values() if v.get("status") == "uploaded")
        summary = f"PCBA/build RFQ — {n} files received"
        qty = s["ems_details"].get("quantity", "")
        timeline = s["ems_details"].get("target_date", "")
    else:
        summary = f"Ready product: {s['product'].get('category', '')} — {s['product'].get('customization', 'no customization')[:80]}"
        qty = s["product"].get("quantity", "")
        timeline = s["product"].get("timeline", "")
    return [
        datetime.now(IST).strftime("%Y-%m-%d %H:%M"), s["lead_id"],
        c.get("company", ""), c.get("name", ""), c.get("email", ""), c.get("phone", ""),
        config.TRACK_LABELS.get(track, track), summary, qty, timeline,
        len(s["uploads"]),
        s.get("drive", {}).get("folder_url", ""), "XOR Bot", "New MQL",
    ]


def _intake_summary(s: dict) -> str:
    c = s["contact"]
    lines = [
        f"# Intake {s['lead_id']} — {c.get('company', '')}",
        f"*Captured by XOR Assist · {datetime.now(IST).strftime('%d %b %Y, %H:%M IST')}*",
        "",
        f"**Track:** {config.TRACK_LABELS.get(s['track'], s['track'])}",
        f"**Contact:** {c.get('name', '')} · {c.get('email', '')} · {c.get('phone', '')}",
        "",
    ]
    if s["entities"]:
        lines += [f"**Triage hints:** {json.dumps(s['entities'])}", ""]
    if s["track"] == "ODM":
        lines.append("## Requirement")
        for k, _, _ in ODM_SLOTS:
            if k in s["slots"]:
                lines.append(f"- **{ODM_SLOT_LABELS[k]}:** {s['slots'][k]}")
        if s.get("lld_file"):
            lines.append(f"\nLLD draft generated: `{s['lld_file']}`")
    elif s["track"] == "EMS":
        lines.append("## Build package")
        for item in EMS_CHECKLIST:
            st = s["checklist"].get(item["key"], {})
            status = st.get("status", "not provided")
            fn = f" — `{st['filename']}`" if st.get("filename") else ""
            lines.append(f"- {item['label']}: **{status}**{fn}")
        d = s["ems_details"]
        lines += ["", f"**Quantity:** {d.get('quantity', '')}",
                  f"**Target date:** {d.get('target_date', '')}",
                  f"**Notes:** {d.get('notes', '') or '—'}"]
    else:
        p = s["product"]
        lines += ["## Product enquiry",
                  f"- **Category:** {p.get('category', '')}",
                  f"- **Quantity:** {p.get('quantity', '')}",
                  f"- **Timeline:** {p.get('timeline', '')}",
                  f"- **Customization:** {p.get('customization', '') or '—'}"]
    lines += ["", "---", "*Source: XOR page intake bot*"]
    return "\n".join(lines)


def _next_lead_id() -> str:
    today = datetime.now(IST).strftime("%Y%m%d")
    data = {"date": today, "n": 0}
    if config.COUNTER_FILE.exists():
        try:
            data = json.loads(config.COUNTER_FILE.read_text())
        except Exception:
            pass
    if data.get("date") != today:
        data = {"date": today, "n": 0}
    data["n"] += 1
    config.COUNTER_FILE.write_text(json.dumps(data))
    return f"XOR-{today}-{data['n']:03d}"


# ───────────────────────────── resume ────────────────────────────────────
def _resume_widget(s: dict) -> dict | None:
    st = s["state"]
    if st == "DISCOVER":
        return _chips(TRACK_CHIPS)
    if st == "TRACK_CONFIRM":
        others = [c for c in TRACK_CHIPS[:3] if c["id"] != f"track:{s.get('proposed_track')}"]
        return _chips([{"id": "confirm:yes", "label": "Yes, that's right"}] + others)
    if st == "CONTACT":
        return _form("contact", "How do we reach you?", CONTACT_FORM, "Save & continue")
    if st == "EMS_CHECKLIST":
        cur = _current_ems_item(s)
        return _upload(cur) if cur else _checklist(s)
    if st == "EMS_DETAILS":
        return _form("ems_details", "Build details", EMS_DETAILS_FORM, "Submit requirement")
    if st == "PRODUCT_CATEGORY":
        return _chips([{"id": f"cat:{cid}", "label": label}
                       for cid, label in config.PRODUCT_CATEGORIES])
    if st == "PRODUCT_DETAILS":
        return _form("product_details", "What you need", PRODUCT_DETAILS_FORM, "Submit enquiry")
    return None


def _resume(s: dict) -> ChatOut:
    prompts_by_state = {
        "DISCOVER": "Where were we — what are you building?",
        "TRACK_CONFIRM": "Have I got the track right?",
        "CONTACT": "Just the contact form and we'll keep moving.",
        "ODM_SLOTS": _resume_odm_question(s),
        "ODM_REVIEW": "Ready to generate the LLD draft, or change an answer?",
        "EMS_CHECKLIST": "Whenever you're ready with the next file.",
        "EMS_DETAILS": "Just the build details left.",
        "PRODUCT_CATEGORY": "Pick the closest category.",
        "PRODUCT_DETAILS": "Just the last form to go.",
        "DONE": "This enquiry is logged. Want to start another?",
    }
    w = _resume_widget(s)
    if s["state"] == "ODM_REVIEW":
        w = _chips([{"id": "lld:generate", "label": "Generate my LLD draft"},
                    {"id": "lld:edit", "label": "Change an answer"},
                    {"id": "lld:skip", "label": "Skip — connect me to sales"}])
    if s["state"] == "DONE":
        w = _chips([{"id": "restart", "label": "Start another enquiry"}])
    return _out(s, [prompts_by_state.get(s["state"], "Go on…")], [w] if w else [])


def _resume_odm_question(s: dict) -> str:
    nxt = next(((k, q, h) for k, q, h in ODM_SLOTS if k not in s["slots"]), None)
    if not nxt:
        return "One second…"
    s["expected_slot"] = nxt[0]
    return nxt[1] + (f" ({nxt[2]})" if nxt[2] else "")

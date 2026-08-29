"""Session store: in-memory dict + JSON snapshot per session.

Good enough for a scaffold and survives restarts. For production put this
behind Redis or Postgres — the interface below is all you need to swap.
"""
from __future__ import annotations

import json
import re
import time
import uuid
from typing import Any

from .config import SESSIONS_DIR

_SAFE_ID = re.compile(r"^[a-f0-9]{32}$")
_cache: dict[str, dict[str, Any]] = {}


def _blank(session_id: str) -> dict[str, Any]:
    return {
        "id": session_id,
        "created": time.time(),
        "state": "DISCOVER",       # see orchestrator.py for the state machine
        "track": None,              # ODM | EMS | PRODUCT
        "proposed_track": None,
        "probe_turns": 0,
        "history": [],              # [{role, content}] — LLM context
        "entities": {},             # hints extracted during triage
        "contact": {},              # name, company, email, phone
        "slots": {},                # ODM requirement slots
        "expected_slot": None,      # slot the last ODM question asked about
        "checklist": {},            # EMS: key -> {status, filename}
        "ems_details": {},          # EMS: quantity / target_date / notes
        "product": {},              # PRODUCT track fields
        "uploads": [],              # [{item_key, filename, path}]
        "lead_id": None,
        "drive": {},                # {folder_url, folder_id} after finalize
        "lld_file": None,           # generated LLD filename (served for download)
        "finalized": False,
    }


def create() -> dict[str, Any]:
    sid = uuid.uuid4().hex
    s = _blank(sid)
    _cache[sid] = s
    save(s)
    return s


def get(session_id: str | None) -> dict[str, Any]:
    if not session_id or not _SAFE_ID.match(session_id):
        return create()
    if session_id in _cache:
        return _cache[session_id]
    path = SESSIONS_DIR / f"{session_id}.json"
    if path.exists():
        s = json.loads(path.read_text())
        _cache[session_id] = s
        return s
    return create()


def save(s: dict[str, Any]) -> None:
    _cache[s["id"]] = s
    (SESSIONS_DIR / f"{s['id']}.json").write_text(json.dumps(s, indent=1))

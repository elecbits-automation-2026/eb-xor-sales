"""API request/response models. Widgets stay plain dicts so the contract can
evolve without schema churn — the frontend renders by widget["type"]."""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class ChatIn(BaseModel):
    session_id: Optional[str] = None
    # "open"  → page just loaded, send the greeting
    # "text"  → free-text message
    # "chip"  → user clicked a quick-reply chip (chip_id)
    # "form"  → user submitted a rendered form (form = {form_id, values})
    kind: Literal["open", "text", "chip", "form"] = "text"
    text: Optional[str] = None
    chip_id: Optional[str] = None
    form: Optional[dict[str, Any]] = None


class ChatOut(BaseModel):
    session_id: str
    messages: list[str] = Field(default_factory=list)   # assistant bubbles, in order
    widgets: list[dict] = Field(default_factory=list)   # rendered below the last bubble
    meta: dict = Field(default_factory=dict)            # {state, track, progress}

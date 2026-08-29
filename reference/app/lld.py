"""Template LLD draft — used in mock mode and as the real-mode fallback."""
from __future__ import annotations

from datetime import datetime

from .flows import ODM_SLOT_LABELS


def template_lld(slots: dict, contact: dict, lead_id: str) -> str:
    g = lambda k: slots.get(k, "TBD") or "TBD"  # noqa: E731
    today = datetime.now().strftime("%d %b %Y")
    company = contact.get("company", "Customer")
    lines = "\n".join(f"| {ODM_SLOT_LABELS.get(k, k)} | {v} |" for k, v in slots.items())
    return f"""# LLD Draft — {g('product_concept')}

*Prepared by XOR Assist for {company} · Ref {lead_id} · {today} · v0.1 (intake draft)*

## 1. Product Overview
{g('product_concept')}

Captured intake summary:

| Field | Customer input |
|---|---|
{lines}

## 2. System Architecture
Block-level architecture to be drafted in the first engineering session:
processing core, power subsystem, connectivity, sensing/IO, and enclosure
interfaces derived from the features above. *(block diagram to follow)*

## 3. Functional Requirements
- FR-1: The product shall deliver: {g('key_features')}
- FR-2: The design shall support a production volume of {g('target_qty')}.
- FR-3: The BoM shall target a unit cost of {g('target_unit_cost')} (assumption — to be validated).

## 4. Electrical Design
Candidate MCU/SoC class, power architecture and interface set will be
proposed against FR-1 during architecture review. *(assumption placeholders —
Elecbits engineering to complete)*

## 5. Mechanical & Enclosure
To be derived from use environment and certification targets below.

## 6. Firmware & Connectivity
Derived from: {g('key_features')}

## 7. Compliance & Certifications
Target markets / known certifications: {g('certifications_markets')}

## 8. Manufacturing & DFM Considerations
Design for SMT assembly on Elecbits lines; DFM review is part of the design
phase. Volumes: {g('target_qty')}.

## 9. Open Questions & Assumptions
- All sections marked (assumption) require validation.
- References provided: {g('references')}

## 10. Suggested Next Steps
1. Architecture & scoping call with an Elecbits sales engineer.
2. Firm up FR list and certification plan.
3. Proposal with milestones for prototype → pilot → production ({g('timeline')}).
"""

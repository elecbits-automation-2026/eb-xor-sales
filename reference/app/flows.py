"""Track definitions — the *structured* half of the hybrid.

The LLM decides which track a query belongs to and extracts values from free
text; everything here (question order, required files, form fields) is
deterministic, so the intake is complete and predictable every time.
"""
from __future__ import annotations

# ── ODM: requirement slots, asked in order, answered in free text ────────
# key, question, short hint shown under the input
ODM_SLOTS: list[tuple[str, str, str]] = [
    ("product_concept",
     "What are you looking to build? A one-line description is perfect.",
     "e.g. \"a 4G GPS tracker for fleet two-wheelers\""),
    ("key_features",
     "What are the must-have features or specs?",
     "connectivity, sensors, display, battery life, IP rating…"),
    ("target_qty",
     "What quantities are you planning — first production run, and roughly per year?",
     "a range is fine"),
    ("target_unit_cost",
     "Do you have a target unit cost or BoM budget?",
     "\"not yet\" is a valid answer"),
    ("timeline",
     "When do you need working prototypes, and when do you want to be in production?",
     ""),
    ("certifications_markets",
     "Which markets will this sell in, and any certifications you already know you need?",
     "BIS, CE, FCC, automotive…"),
    ("references",
     "Any reference products, competitor devices, or existing docs we should look at?",
     "links or names are enough"),
]

ODM_SLOT_LABELS = {
    "product_concept": "Product concept",
    "key_features": "Must-have features",
    "target_qty": "Quantities",
    "target_unit_cost": "Target unit cost",
    "timeline": "Timeline",
    "certifications_markets": "Markets & certifications",
    "references": "References",
}

# ── EMS: file checklist for a manufacturing RFQ ──────────────────────────
EMS_CHECKLIST: list[dict] = [
    {"key": "bom", "label": "Bill of Materials (BoM)",
     "accept": ".xlsx,.xls,.csv", "required": True,
     "desc": "Part numbers, quantities, designators. Ask for our level-wise BoM template if you need one."},
    {"key": "gerber", "label": "PCB fabrication files (Gerber / ODB++)",
     "accept": ".zip,.rar,.7z", "required": True,
     "desc": "A zip of your fab outputs is ideal."},
    {"key": "pnp", "label": "Pick & place / centroid file",
     "accept": ".csv,.txt,.xlsx", "required": False,
     "desc": "Speeds up SMT programming."},
    {"key": "assembly", "label": "Assembly drawing / build notes",
     "accept": ".pdf,.zip", "required": False,
     "desc": "Polarity marks, special instructions, conformal coating…"},
    {"key": "cad", "label": "3D CAD / enclosure files (STEP)",
     "accept": ".step,.stp,.iges,.zip", "required": False,
     "desc": "Needed if we handle box-build or molding."},
    {"key": "test_fw", "label": "Test spec / firmware for programming",
     "accept": "*", "required": False,
     "desc": "How we should program and verify each board."},
]

EMS_DETAILS_FORM = [
    {"key": "quantity", "label": "Quantity (first run / annual)", "input": "text", "required": True,
     "placeholder": "e.g. 1,000 pilot + 10,000/yr"},
    {"key": "target_date", "label": "When do you need delivery?", "input": "text", "required": True,
     "placeholder": "e.g. pilot by November"},
    {"key": "notes", "label": "Anything else — PCB specs, coating, testing?", "input": "textarea", "required": False,
     "placeholder": "layers, finish, impedance control, burn-in…"},
]

# ── PRODUCT: ready / white-label products ────────────────────────────────
PRODUCT_DETAILS_FORM = [
    {"key": "quantity", "label": "Quantity you're evaluating", "input": "text", "required": True,
     "placeholder": "e.g. 500 to start"},
    {"key": "timeline", "label": "When do you need them?", "input": "text", "required": True,
     "placeholder": "e.g. within 8 weeks"},
    {"key": "customization", "label": "Any customization? (branding, firmware, enclosure)", "input": "textarea",
     "required": False, "placeholder": "white-label, custom firmware, different housing…"},
]

CONTACT_FORM = [
    {"key": "name", "label": "Your name", "input": "text", "required": True, "placeholder": ""},
    {"key": "company", "label": "Company", "input": "text", "required": True, "placeholder": ""},
    {"key": "email", "label": "Work email", "input": "email", "required": True, "placeholder": "you@company.com"},
    {"key": "phone", "label": "Phone / WhatsApp", "input": "tel", "required": True, "placeholder": "+91…"},
]

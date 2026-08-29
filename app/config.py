"""Central configuration. Everything is env-driven; see .env.example."""
from __future__ import annotations

import os
from pathlib import Path


def _bool(name: str, default: bool) -> bool:
    return os.getenv(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.getenv("XOR_DATA_DIR", BASE_DIR / "data"))
SESSIONS_DIR = DATA_DIR / "sessions"
UPLOADS_DIR = DATA_DIR / "uploads"
GENERATED_DIR = DATA_DIR / "generated"       # LLD drafts, intake summaries
MOCK_DRIVE_DIR = DATA_DIR / "mock_drive"     # mock-mode "Google Drive"
MOCK_FUNNEL_CSV = DATA_DIR / "mock_funnel.csv"
COUNTER_FILE = DATA_DIR / "lead_counter.json"

for d in (DATA_DIR, SESSIONS_DIR, UPLOADS_DIR, GENERATED_DIR, MOCK_DRIVE_DIR):
    d.mkdir(parents=True, exist_ok=True)

# ── Modes ────────────────────────────────────────────────────────────────
MOCK_LLM = _bool("MOCK_LLM", True)
MOCK_DRIVE = _bool("MOCK_DRIVE", True)

# ── Server ───────────────────────────────────────────────────────────────
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",")]
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "50"))

# ── LLM ──────────────────────────────────────────────────────────────────
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
MODEL = os.getenv("XOR_BOT_MODEL", "claude-sonnet-4-5")
MAX_PROBE_TURNS = int(os.getenv("MAX_PROBE_TURNS", "3"))
TRIAGE_CONFIDENCE = float(os.getenv("TRIAGE_CONFIDENCE", "0.75"))

# ── Google Drive backbone ────────────────────────────────────────────────
GOOGLE_SERVICE_ACCOUNT_FILE = os.getenv("GOOGLE_SERVICE_ACCOUNT_FILE", "./service-account.json")

# Folder IDs captured from the Eb-07-Sales sitemap crawl (14 Aug 2026).
# Verify against Drive before go-live — folders may have moved since.
DRIVE_IDS = {
    "sales_root": "1AAPnkRGEes2uWNxOamNdLdeE4d08AvoG",          # Eb-07-Sales
    "accounts_parent": os.getenv("ACCOUNTS_PARENT_FOLDER_ID", ""),
    "templates": os.getenv("TEMPLATES_FOLDER_ID", "1WS7FdLsETXJopVIwrkvemuzdijUOspK"),
    "funnel_spreadsheet": os.getenv("FUNNEL_SPREADSHEET_ID", ""),
    "funnel_tab": os.getenv("FUNNEL_SHEET_TAB", "XOR Intake"),
}

# Sub-folders created inside every new account folder — mirrors the proposed
# 01-Accounts structure from the Drive sitemap so sales can adopt it as-is.
ACCOUNT_SUBFOLDERS = ["00-Intake", "01-Research", "02-MoM", "03-Contracts", "04-Quotes-Orders"]

# Columns of the funnel row the bot appends (header auto-written if tab is empty).
FUNNEL_COLUMNS = [
    "Timestamp (IST)", "Lead ID", "Company", "Contact", "Email", "Phone",
    "Track", "Summary", "Quantity", "Timeline", "Files", "Drive Folder",
    "Source", "Stage",
]

# Ready-product categories shown on the Product track.
# Edit freely — keep ids stable once analytics depend on them.
PRODUCT_CATEGORIES = [
    ("iot", "IoT & smart devices"),
    ("it_hw", "IT hardware"),
    ("power", "Power electronics (supplies, adapters, chargers)"),
    ("epay", "E-payment devices (PoS, soundbox)"),
    ("ev", "EV electronics"),
    ("other", "Something else"),
]

TRACK_LABELS = {
    "ODM": "New product design (ODM)",
    "EMS": "Manufacturing (EMS)",
    "PRODUCT": "Ready products",
}

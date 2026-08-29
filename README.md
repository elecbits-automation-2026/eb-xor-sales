# XOR Intake Bot

Customer-intake chatbot for the **XoR first page** on elecbits.in. It takes any
visitor query, works out which engagement track it belongs to — **ODM** (design
a new product), **EMS** (manufacture an existing design), or **Product** (ready /
white-label) — then runs the right structured intake:

| Track | What the bot does |
|---|---|
| **ODM** | Seven requirement questions → generates a first-cut **LLD draft** the customer can download and the team gets in Drive |
| **EMS** | Walks through the **build package**: BoM, Gerbers/ODB++, pick-&-place, assembly drawings, STEP, test spec — upload or skip, everything tracked |
| **Product** | Category → quantity → customization enquiry |

Every completed intake lands in **Google Drive** (a per-customer account folder
with the standard sub-structure) and as a **new row in the funnel sheet** — the
two handoffs sales actually uses.

**Hybrid brain:** an LLM (Claude) handles the language — triage, entity
extraction, Q&A, LLD drafting — while a deterministic state machine owns the
question order, required files, validation and all writes. The bot can never
"forget" to collect a field, and it can never invent a price.

---

## Quickstart (zero keys, 2 minutes)

```bash
pip install -r requirements.txt
cp .env.example .env          # defaults: MOCK_LLM=true, MOCK_DRIVE=true
bash run.sh                   # → http://localhost:8000
```

Mock mode runs the full experience with keyword-based triage and a local
"Drive" so anyone can demo it: folders appear under `data/mock_drive/`, funnel
rows in `data/mock_funnel.csv`.

Tests: `pip install -r requirements-dev.txt && python -m pytest tests/ -q`

## Going live

**1. LLM** — set in `.env`:

```
MOCK_LLM=false
ANTHROPIC_API_KEY=sk-ant-…
XOR_BOT_MODEL=claude-sonnet-4-5     # pick your current preferred model
```

**2. Google Drive backbone** — one-time setup:

1. In Google Cloud console: create a project → enable **Drive API** and
   **Sheets API** → create a **service account** → download its JSON key as
   `service-account.json` in the repo root.
2. In Drive: create the accounts folder (recommended: `01-Accounts` under
   `Eb-07-Sales`) and **share it with the service account's client_email as
   Editor**. Do the same for the funnel spreadsheet and the templates folder.
3. Set in `.env`:

```
MOCK_DRIVE=false
ACCOUNTS_PARENT_FOLDER_ID=…    # the 01-Accounts folder ID
FUNNEL_SPREADSHEET_ID=…        # from the sheet URL: /spreadsheets/d/<ID>/edit
FUNNEL_SHEET_TAB=XOR Intake    # bot writes the header row if the tab is empty
TEMPLATES_FOLDER_ID=…          # pre-filled from the Aug-2026 sitemap — verify
```

> Folder IDs pre-filled in `config.py` were captured from the Eb-07-Sales
> sitemap crawl of 14 Aug 2026. Verify them before go-live — the migration
> plan moves several folders.

**3. Serve it** — any box that runs Python:

```bash
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Put nginx/Caddy in front for TLS, e.g. `xor.elecbits.in` → `localhost:8000`.

## Embedding on the XOR page

The bot ships with a full landing page (`web/index.html`) — hero copy on the
left, chat on the right — so the simplest deploy is to make it *the* XOR first
page at `xor.elecbits.in`.

To embed inside an existing page instead:

```html
<iframe src="https://xor.elecbits.in" style="width:100%;height:720px;border:0;border-radius:18px"></iframe>
```

or serve the API on a subdomain, copy the `<section class="chat">` block + JS
into your page, and set `const API = "https://xor-api.elecbits.in"` (then set
`CORS_ORIGINS=https://elecbits.in` in `.env`).

## What sales receives

**Drive** — per intake, under the accounts parent:

```
XOR-20260829-001 Acme Devices/
├── 00-Intake/
│   ├── XOR-20260829-001-intake-summary.md   ← track, contact, all answers
│   ├── bom--acme-bom.xlsx                   ← customer uploads (EMS)
│   ├── gerber--fab_rev3.zip
│   └── LLD-draft-xxxxxxxx.md                ← generated draft (ODM)
├── 01-Research/  02-MoM/  03-Contracts/  04-Quotes-Orders/
```

The sub-folders mirror the proposed `01-Accounts` structure from the sitemap,
so a converted lead's folder is already in the right shape — sales just renames
it to the `Eb-nn-XX-nnn` account ID on qualification.

**Funnel sheet** — one appended row:
`Timestamp · Lead ID · Company · Contact · Email · Phone · Track · Summary ·
Quantity · Timeline · Files · Drive folder link · Source=XOR Bot · Stage=New MQL`

If a Drive/Sheets write ever fails, the intake is preserved at
`data/generated/<lead>-FAILED-DRIVE.md` with the funnel row inside — a lead is
never lost to an API error.

## Conversation design

```
            free text                     ┌────────────────────────────┐
 visitor ──────────────► DISCOVER ──────► │ LLM triage:                │
            or chips        │             │ ODM/EMS/PRODUCT/QUESTION/  │
                            │             │ UNCLEAR + confidence       │
                            ▼             └────────────────────────────┘
                      TRACK_CONFIRM   (≥ TRIAGE_CONFIDENCE → propose;
                            │          QUESTION → answer, re-invite;
                            ▼          3 unclear turns → manual chips)
                        CONTACT  (name/company/email/phone, validated)
              ┌─────────────┼──────────────────┐
              ▼             ▼                  ▼
         ODM_SLOTS     EMS_CHECKLIST     PRODUCT_CATEGORY
         7 questions   6-file upload     category chips
              ▼         loop w/ skip           ▼
         ODM_REVIEW         ▼            PRODUCT_DETAILS
         (edit / LLD)  EMS_DETAILS             │
              └─────────────┼──────────────────┘
                            ▼
                        FINALIZE → Drive folder + uploads + summary
                                   + funnel row → DONE
```

Rules of the hybrid: the LLM never decides *what to collect* (the state
machine does), and the state machine never parses language (the LLM does).
Mid-flow free text is still handled — questions during the EMS upload loop get
answered, then the checklist resumes.

## Repo map

```
app/
  main.py          FastAPI: /, /api/chat, /api/upload, /api/download, /healthz
  orchestrator.py  state machine + finalize (Drive/funnel writes live here)
  llm.py           triage / slot-extraction / Q&A / LLD — Claude or mock rules
  prompts.py       all prompt text + tool schemas (tune wording here)
  flows.py         ODM slots, EMS checklist, forms (tune the intake here)
  knowledge.py     customer-safe company snapshot — REVIEW BEFORE GO-LIVE
  drive.py         GoogleDrive + MockDrive backbones (same interface)
  lld.py           template LLD (mock mode + fallback)
  sessions.py      JSON-snapshot session store (swap for Redis in prod)
  config.py        env + folder IDs + funnel columns + product categories
web/index.html     the XOR page — hero + chat UI (vanilla JS, no build step)
tests/test_flow.py mock-mode end-to-end: all three tracks + validation
```

## Production checklist (before real traffic)

- [ ] Review `knowledge.py` — it defines what the bot may say publicly
- [ ] Verify all Drive folder IDs; create the `01-Accounts` parent
- [ ] Rate-limit `/api/*` (nginx `limit_req` is enough) + captcha if spammed
- [ ] Swap `sessions.py` for Redis/Postgres if you run >1 worker
- [ ] Log review: conversations contain PII — set retention policy
- [ ] Add real-mode eval set: ~30 labelled real enquiries → check triage accuracy
- [ ] Alerting on `FAILED-DRIVE` files (a cron that emails sales ops)
- [ ] Optional next steps: WhatsApp channel via the same `/api/chat` contract;
      Zoho contact creation in `_finalize`; auto-notify the right pod

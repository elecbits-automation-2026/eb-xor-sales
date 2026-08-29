# XOR Intake Bot

The first page of **XoR**, Elecbits' AI-platform brand: a chat-first customer
intake that triages any visitor query into one of three engagement tracks —
**ODM** (design a new product), **EMS** (manufacture an existing design),
**PRODUCT** (ready / white-label) — and captures a complete, structured
requirement for the sales engineering team.

**Stack:** Next.js 15 (App Router, TypeScript) on Vercel · Supabase
(Postgres + pgvector + Storage) · Google Drive/Sheets · Claude (Anthropic API).

**Hybrid brain:** the LLM handles *language* (triage, entity extraction,
grounded Q&A, LLD drafting); a deterministic state machine owns *structure*
(question order, required files, validation, all writes). The bot can never
forget to collect a field, and it can never invent a price.

> The original Python/FastAPI scaffold lives under [`reference/`](reference/)
> — it is the behaviour spec this app was ported from, kept for comparison.

## How the stack splits

| Piece | Owns |
|---|---|
| **GitHub** | Source of truth, PR review, CI (lint · typecheck · tests) |
| **Vercel** | The XoR page + all API routes + cron jobs |
| **Supabase** | Postgres (dedicated **`xor` schema**): sessions, messages, **leads** (the transactional record), files metadata, handoff retries, pgvector KB. Storage bucket for customer uploads |
| **Google Drive** | Document system of record: account folders, uploads, intake summaries, LLD drafts, funnel sheet — and the KB source folders |

## Quickstart (zero keys, 2 minutes)

```bash
pnpm install
pnpm dev          # → http://localhost:3000
```

With no env at all the app runs fully mocked: keyword triage (`MOCK_LLM`),
no Google calls (`MOCK_DRIVE`), and an **in-memory DB/Storage driver** that
activates whenever Supabase creds are absent — the whole intake, uploads
included, is demoable end-to-end.

Tests: `pnpm test` · Types: `pnpm typecheck` · Lint: `pnpm lint`

## Going live

### 1 · Supabase (½ day)

1. Create the project (recommended region `ap-south-1` Mumbai).
2. Run [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql)
   in the SQL editor. Everything lands in a dedicated **`xor` schema** — no
   collisions with tables other repos keep in the same project.
3. **Expose the schema:** Dashboard → Settings → API → "Exposed schemas" →
   add `xor` (the API can't see it otherwise).
4. Create the **private** Storage bucket `intake-uploads` (50 MB per-file
   limit). If that name is taken by another app, pick another and set
   `SUPABASE_BUCKET`.
5. Copy `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` into Vercel env
   (server-side only, mark Sensitive). RLS is enabled deny-all on every
   table — only the service role passes, and the browser never talks to
   Postgres (files go up via short-lived signed upload URLs).
6. Decide the embeddings provider **before** go-live — the vector dimension
   is baked into the migration (default 1536 = OpenAI
   `text-embedding-3-small`; for Voyage `voyage-3.5` change `vector(1536)`
   to `vector(1024)` in the migration and set `EMBEDDINGS_DIM=1024`).
7. PII retention: schedule
   [`supabase/maintenance/purge_pii.sql`](supabase/maintenance/purge_pii.sql)
   (pg_cron) — purges sessions/messages of non-converted visitors after
   90 days; leads persist.

### 2 · Google Cloud + Drive (½ day, mostly waiting on admin)

1. Create a service account; enable **Drive API + Sheets API**; download the
   JSON key and store it base64-encoded:
   `base64 -w0 key.json` → Vercel env `GOOGLE_SERVICE_ACCOUNT_B64`.
   **Never commit the key file.**
2. ⚠ **Put the accounts area on a Shared Drive** (or accept that files the
   service account creates count against its own 15 GB quota and are owned
   by it). Recommended: `Eb-07-Sales/01-Accounts` on a Shared Drive, service
   account as Content Manager. This is the #1 production gotcha.
3. Grant Drive access — pick ONE of these two modes:

   **A. Per-folder sharing (least privilege).** Share with the SA's
   `client_email`: the `01-Accounts` parent (Editor/Content Manager), the
   funnel spreadsheet (Editor), the templates folder (Viewer), and every
   KB source folder (Viewer). The bot can touch only what you shared.

   **B. Full-Drive access (Workspace domain-wide delegation).** The bot
   impersonates a real user and can reach EVERY folder that user can —
   nothing needs to be shared, and files it creates are owned by that
   user (which also sidesteps the service account's 15 GB quota):
   1. In Cloud console → IAM → Service Accounts → your SA → copy its
      numeric **Unique ID** (OAuth2 client ID).
   2. In [admin.google.com](https://admin.google.com) → Security →
      Access and data control → API controls → **Domain-wide
      delegation** → Add new → paste the client ID, scopes:
      `https://www.googleapis.com/auth/drive,https://www.googleapis.com/auth/spreadsheets`
   3. Set env `GOOGLE_IMPERSONATED_USER=<user>@elecbits.in` (use a
      dedicated ops account if possible, e.g. the account that owns the
      sales Drive tree).

   ⚠ Mode B means a leaked service-account key = full read/write over
   that user's entire Drive. Keep the key only in Vercel (Sensitive),
   rotate it if it ever leaks, and prefer a dedicated user over a
   personal one.
4. Create the `XOR Intake` tab on the funnel sheet; grab the spreadsheet ID
   from its URL (`/spreadsheets/d/<ID>/edit`). The bot writes the header row
   if the tab is empty.
5. Verify all folder IDs before wiring them — the Drive migration plan moves
   folders.

### 3 · Vercel (½ day)

1. Import the GitHub repo — Next.js auto-detects; previews on PRs,
   production from `main`.
2. Set every var from [`.env.example`](.env.example); mark secrets Sensitive.
   Production wants `MOCK_LLM=false`, `MOCK_DRIVE=false`, a real
   `ANTHROPIC_API_KEY`, and `CRON_SECRET` (any long random string).
3. Crons ship in [`vercel.json`](vercel.json): KB sync nightly 03:00 IST,
   handoff retry daily 06:30 IST. The daily retry schedule is
   **Hobby-plan-safe** (Hobby rejects sub-daily crons and that fails the
   whole deployment); on a Pro plan, tighten the retry to
   `"*/15 * * * *"` for the intended 15-minute replay loop. Vercel
   automatically sends `Authorization: Bearer $CRON_SECRET` when the env
   var exists. `"framework": "nextjs"` is pinned there too, so the build
   is correct even if the project's dashboard preset is stale.
4. Domain: `xor.elecbits.in` → Vercel, or keep it standalone and iframe it
   into the current site.
5. Uploads never pass through Vercel (≈4.5 MB body cap) — the browser PUTs
   directly to Supabase Storage via signed URLs, so Gerber zips up to the
   bucket's 50 MB limit are fine.

### 4 · Knowledge base (pgvector RAG)

1. Pick the KB source folders in Drive (playbook, capability material, FAQ,
   product catalogue) → `KB_SOURCE_FOLDER_IDS` (comma-separated IDs).
   **Curate before you embed** — the bot can only leak what you index, so
   keep financials and NDA material out of source folders.
2. Set `EMBEDDINGS_API_KEY` (+ provider/model/dim if not the defaults).
3. First sync: `curl -X POST https://<app>/api/kb/sync -H "Authorization: Bearer $CRON_SECRET"`
   — exports Docs/PDFs/docx → text, chunks (~1,500 chars / 200 overlap),
   embeds, upserts. Re-runs are incremental on `modifiedTime`.
4. Wire-check retrieval in SQL:
   `select * from xor.match_kb_chunks(<embedding>, 6, 0.30);`
5. Eval before go-live: ~30 labelled real enquiries → triage accuracy ≥ 90%;
   ~20 FAQ questions → grounded answers, zero invented facts.
6. Until the KB is populated (or in mock mode), Q&A falls back to the
   static customer-safe snapshot in `lib/knowledge.ts` — review that text.

## What sales receives

**Supabase `xor.leads`** — the transactional record of every lead, written
*first*, before any Google call.

**Drive** — per intake, under the accounts parent:

```
XOR-20260829-001 Acme Devices/
├── 00-Intake/
│   ├── XOR-20260829-001-intake-summary.md   ← track, contact, all answers
│   ├── bom--acme-bom.xlsx                   ← customer uploads (EMS)
│   ├── gerber--fab_rev3.zip
│   └── LLD-draft-XOR-20260829-001.md        ← generated draft (ODM)
├── 01-Research/  02-MoM/  03-Contracts/  04-Quotes-Orders/
```

**Funnel sheet** — one appended row:
`Timestamp (IST) · Lead ID · Company · Contact · Email · Phone · Track ·
Summary · Quantity · Timeline · Files · Drive folder · Source=XOR Bot ·
Stage=New MQL`

**If a Drive/Sheets write fails** the intake is preserved in
`xor.handoff_retries` with the full payload; `/api/handoff/retry` (cron,
15 min) replays with exponential backoff. A lead is never lost and the
visitor is never blocked. Alert on any unresolved row older than 1 hour.

## API surface

| Route | Purpose |
|---|---|
| `POST /api/chat` | conversation turns (ChatIn → ChatOut) |
| `POST /api/upload-url` | validates file, issues signed Storage upload URL |
| `POST /api/upload-complete` | verifies the object, records it, advances the checklist |
| `GET /api/download/[session]/[file]` | streams the visitor's LLD draft |
| `POST /api/kb/sync` | Drive → pgvector sync (Bearer `CRON_SECRET`) |
| `POST /api/handoff/retry` | replays failed Drive/Sheets handoffs (Bearer `CRON_SECRET`) |
| `GET /api/health` | `{ok, mock_llm, mock_drive}` |

## Production checklist

- [ ] Review `lib/knowledge.ts` — it defines what the bot may say publicly
- [ ] Curate KB source folders; run the first sync; spot-check retrieval
- [ ] Verify Drive folder IDs; accounts area on a **Shared Drive**
- [ ] Rate limiting: in-memory token bucket ships by default — add Upstash
      Ratelimit or Vercel WAF for multi-instance enforcement; captcha only
      if spam appears
- [ ] Alerting on `xor.handoff_retries` unresolved > 1 h (a lead must never
      die silently)
- [ ] Sentry or Vercel log drains on API routes
- [ ] Schedule the PII purge (90 days, non-converted sessions)
- [ ] Soft-launch: `MOCK_LLM=false` with the team for a week, review
      transcripts, tune `lib/prompts.ts`, then put it on the XoR page

## Non-goals (bolt on later without rework)

Visitor authentication · WhatsApp channel · Zoho integration · admin
dashboard · multi-language UI (the bot mirrors Hindi/Hinglish in replies).

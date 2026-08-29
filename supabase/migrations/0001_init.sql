-- XOR Intake Bot — initial schema.
--
-- Everything this app owns lives in the dedicated "xor" schema, so it can
-- share the Supabase project with other Elecbits repos without touching (or
-- colliding with) their tables in public.
--
-- After running this migration:
--   1. Add "xor" to Exposed schemas (Dashboard → Settings → API).
--   2. Create the private Storage bucket for uploads (default name
--      "intake-uploads"; override with env SUPABASE_BUCKET), 50 MB file limit.
--
-- The pgvector extension may already exist in this project (installed by
-- another repo); "if not exists" keeps whatever is there. The search_path
-- below resolves the vector type/operators from either location.

create extension if not exists vector with schema extensions;

create schema if not exists xor;

set search_path = xor, extensions, public;

create table if not exists xor.sessions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  state text not null default 'DISCOVER',
  track text,
  data jsonb not null default '{}'::jsonb  -- contact, slots, checklist, entities, probe_turns, lld_path…
);

create table if not exists xor.messages (
  id bigint generated always as identity primary key,
  session_id uuid not null references xor.sessions(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists messages_session_idx on xor.messages(session_id, id);

create table if not exists xor.leads (
  id uuid primary key default gen_random_uuid(),
  lead_ref text unique not null,            -- XOR-YYYYMMDD-NNN (IST)
  session_id uuid references xor.sessions(id),
  track text not null,
  company text, contact_name text, email text, phone text,
  summary text, quantity text, timeline text,
  drive_folder_id text, drive_folder_url text,
  drive_committed boolean not null default false,
  sheet_appended boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists xor.lead_files (
  id bigint generated always as identity primary key,
  session_id uuid not null references xor.sessions(id) on delete cascade,
  lead_id uuid references xor.leads(id),
  item_key text not null,
  filename text not null,
  storage_path text not null,
  bytes bigint,
  drive_file_id text,
  created_at timestamptz not null default now()
);
create index if not exists lead_files_session_idx on xor.lead_files(session_id);

create table if not exists xor.kb_documents (
  id uuid primary key default gen_random_uuid(),
  drive_file_id text unique not null,
  name text not null,
  mime_type text,
  source_folder text,
  modified_at timestamptz,
  synced_at timestamptz,
  status text not null default 'active'     -- active | removed
);

create table if not exists xor.kb_chunks (
  id bigint generated always as identity primary key,
  document_id uuid not null references xor.kb_documents(id) on delete cascade,
  chunk_no int not null,
  content text not null,
  embedding vector(1536),                   -- must match env EMBEDDINGS_DIM
  unique(document_id, chunk_no)
);
create index if not exists kb_chunks_embedding_idx on xor.kb_chunks
  using hnsw (embedding vector_cosine_ops);

create table if not exists xor.handoff_retries (
  id bigint generated always as identity primary key,
  lead_id uuid not null references xor.leads(id),
  kind text not null check (kind in ('drive','sheet')),
  payload jsonb not null,
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists handoff_retries_open_idx
  on xor.handoff_retries(created_at) where resolved_at is null;

create table if not exists xor.lead_counters (
  day date primary key,
  n int not null default 0
);

create or replace function xor.next_lead_ref() returns text
language plpgsql
set search_path = xor
as $$
declare d date := (now() at time zone 'Asia/Kolkata')::date; v int;
begin
  insert into xor.lead_counters as lc (day, n) values (d, 1)
  on conflict (day) do update set n = lc.n + 1
  returning n into v;
  return 'XOR-' || to_char(d, 'YYYYMMDD') || '-' || lpad(v::text, 3, '0');
end $$;

create or replace function xor.match_kb_chunks(
  query_embedding vector(1536), match_count int default 6,
  min_similarity float default 0.30)
returns table(content text, document_name text, similarity float)
language sql stable
set search_path = xor, extensions, public
as $$
  select c.content, d.name, 1 - (c.embedding <=> query_embedding)
  from xor.kb_chunks c join xor.kb_documents d on d.id = c.document_id
  where d.status = 'active'
    and 1 - (c.embedding <=> query_embedding) > min_similarity
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- RLS: enabled everywhere with NO policies — deny-all. The browser never
-- talks to Postgres; only the Vercel API routes do, with the service role
-- (which bypasses RLS).
alter table xor.sessions enable row level security;
alter table xor.messages enable row level security;
alter table xor.leads enable row level security;
alter table xor.lead_files enable row level security;
alter table xor.kb_documents enable row level security;
alter table xor.kb_chunks enable row level security;
alter table xor.handoff_retries enable row level security;
alter table xor.lead_counters enable row level security;

-- Only the service role may reach the xor schema through the API.
grant usage on schema xor to service_role;
grant all on all tables in schema xor to service_role;
grant all on all sequences in schema xor to service_role;
grant execute on all functions in schema xor to service_role;
alter default privileges in schema xor grant all on tables to service_role;
alter default privileges in schema xor grant all on sequences to service_role;
alter default privileges in schema xor grant execute on functions to service_role;

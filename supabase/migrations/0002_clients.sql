-- Client accounts + the ClientID/DealID system (mirrors the PMS ODM tool).
--
--   Client ID: <ORG_SIZE_CODE><INDUSTRY_CODE>-<SEQ3>   e.g. PL03-001
--   Deal ID:   EbZ-<client_code>-<NN>                  e.g. EbZ-PL03-001-01
--
-- Drive mirrors this: "<client_code> <Company>"/<deal_id>/00-Intake…
-- created BEFORE any downstream (ULM) process picks the lead up.

set search_path = xor, extensions, public;

create table if not exists xor.clients (
  id uuid primary key default gen_random_uuid(),
  client_code text unique not null,           -- PL03-001
  company text not null,
  industry_code text,                          -- "01".."42"
  org_size_code text,                          -- PL/ML/EL/EM/UN/GO
  contact_name text,
  email text unique,                           -- stored lowercased
  phone text,
  auth_user_id uuid unique,                    -- supabase auth.users id, once signed up
  drive_folder_id text,
  drive_folder_url text,
  created_at timestamptz not null default now()
);
create index if not exists clients_email_idx on xor.clients(email);

alter table xor.leads add column if not exists client_id uuid references xor.clients(id);
alter table xor.leads add column if not exists deal_id text unique;

-- Generic atomic sequence (client numbering, per-client deal numbering).
create table if not exists xor.counters (
  name text primary key,
  n int not null default 0
);

create or replace function xor.next_seq(p_name text) returns int
language plpgsql
set search_path = xor
as $$
declare v int;
begin
  insert into xor.counters as c (name, n) values (p_name, 1)
  on conflict (name) do update set n = c.n + 1
  returning n into v;
  return v;
end $$;

alter table xor.clients enable row level security;
alter table xor.counters enable row level security;
-- no policies on purpose: deny-all; only the service role passes.

grant all on all tables in schema xor to service_role;
grant all on all sequences in schema xor to service_role;
grant execute on all functions in schema xor to service_role;

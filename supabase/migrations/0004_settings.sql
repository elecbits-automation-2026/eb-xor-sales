-- Small key/value store for the bot's own operational state — today the
-- cached Google bindings (which register spreadsheet, accounts folder and
-- funnel sheet the bot discovered by name), so discovery runs once and the
-- binding stays stable across deploys and file renames.

set search_path = xor, extensions, public;

create table if not exists xor.settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- Same posture as every xor table: RLS deny-all (no policies), reached
-- only by the API routes with the service role.
alter table xor.settings enable row level security;
grant all on xor.settings to service_role;

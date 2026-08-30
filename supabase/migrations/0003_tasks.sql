-- Background tasks — the activity column on the chat page ("Background
-- tasks", Claude-Code style): one row per pipeline step the server runs
-- for an enquiry (client/deal ID issuance, funnel row, Drive workspace,
-- file uploads), written as the step runs and polled read-only per
-- session by GET /api/tasks.

set search_path = xor, extensions, public;

create table if not exists xor.tasks (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references xor.sessions(id) on delete cascade,
  label text not null,
  detail text,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tasks_session_idx on xor.tasks (session_id, created_at);

-- Same posture as every xor table: RLS deny-all (no policies), reached
-- only by the API routes with the service role.
alter table xor.tasks enable row level security;
grant all on xor.tasks to service_role;

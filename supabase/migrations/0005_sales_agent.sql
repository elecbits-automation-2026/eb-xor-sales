-- The Elecbits sales agent a client chose at signup (picked from a
-- dropdown fed by the shared project's core.people, filtered to
-- sales-designated members). Stored on the client record so the team
-- knows who owns the relationship.

set search_path = xor, extensions, public;

alter table xor.clients add column if not exists sales_agent text;

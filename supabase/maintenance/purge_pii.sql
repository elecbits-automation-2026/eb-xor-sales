-- PII retention: conversations contain personal data. Run on a schedule
-- (e.g. Supabase cron / pg_cron, weekly) to purge sessions and messages of
-- visitors who never became a lead, after 90 days. Leads persist.
--
--   select cron.schedule('xor-purge-pii', '0 22 * * 0',
--     $$ delete from xor.sessions s
--        where s.created_at < now() - interval '90 days'
--          and not exists (select 1 from xor.leads l where l.session_id = s.id) $$);
--
-- One-off run:
delete from xor.sessions s
where s.created_at < now() - interval '90 days'
  and not exists (select 1 from xor.leads l where l.session_id = s.id);
-- xor.messages rows cascade via the session_id foreign key.

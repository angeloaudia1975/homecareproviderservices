-- Phase 2 add-on · Account class (Morning Brief signal eligibility) — 2026-10-05
--
-- Adds ONE optional label to each dealer/account record, set by President/Admin only:
--   dealer | prospect | manufacturer | vendor | service_provider | internal | other | not_relevant
-- It decides one thing only: whether the account may raise Morning Brief relationship signals.
--   eligible: blank (every existing record), dealer, prospect, other
--   excluded: manufacturer, vendor, service_provider, internal, not_relevant
-- It never deletes, hides, archives or reassigns an account, and changes no owner, rep scope,
-- permission or Dealer 360 visibility. Nothing is classified automatically: every existing record
-- stays blank (= eligible) until you set it. Zoho reads named columns only, so this is never pushed.
--
-- SAFE TO RE-RUN. Adds three nullable columns and one check; changes no existing value, removes nothing.

begin;

alter table public.dealers add column if not exists account_class text;
alter table public.dealers add column if not exists account_class_set_by text;
alter table public.dealers add column if not exists account_class_set_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'dealers_account_class_check') then
    alter table public.dealers add constraint dealers_account_class_check
      check (account_class is null or account_class in
        ('dealer','prospect','manufacturer','vendor','service_provider','internal','other','not_relevant'));
  end if;
end $$;

commit;

notify pgrst, 'reload schema';

-- Check: every existing account is still blank (expect one row: class (blank), with your dealer count).
select coalesce(account_class, '(blank)') as class, count(*) from public.dealers group by 1 order by 2 desc;

-- ROLLBACK (only if the code is rolled back too; any classes you set are lost):
-- alter table public.dealers drop constraint if exists dealers_account_class_check;
-- alter table public.dealers drop column if exists account_class_set_at;
-- alter table public.dealers drop column if exists account_class_set_by;
-- alter table public.dealers drop column if exists account_class;

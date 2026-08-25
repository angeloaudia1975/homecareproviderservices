-- ============================================================================
-- dealer_contacts — make EMAIL OPTIONAL.
--
-- Why: a rep may add a dealer contact (name / title / phone) before they have the
-- email address, and fill it in later. Previously the table's primary key was
-- (dealer_id, email), so email could never be blank and two email-less contacts
-- for the same dealer would have collided.
--
-- This migration:
--   1) adds a surrogate primary key  dealer_contacts.id (uuid),
--   2) keeps a UNIQUE constraint on (dealer_id, email) so real emails stay unique
--      per dealer AND the existing bulk-import upserts (on_conflict=dealer_id,email
--      in dealers-api.js / email-sync-api.js) keep working. Postgres treats NULLs
--      as distinct in a UNIQUE constraint, so any number of email-less contacts
--      can coexist for one dealer,
--   3) makes email nullable.
--
-- Idempotent — safe to re-run. Deploy the updated crm-api.js + dealer.html with it.
-- ============================================================================

-- 1) Surrogate id (each existing row gets a fresh uuid from the default).
alter table dealer_contacts add column if not exists id uuid not null default gen_random_uuid();

-- 2) Swap the composite (dealer_id,email) primary key for id, preserving a unique
--    constraint on (dealer_id,email). Only runs while the PK is still the composite.
do $$
declare
  pkname  text;
  pkcols  text;
begin
  select c.conname,
         string_agg(a.attname, ',' order by array_position(c.conkey, a.attnum))
    into pkname, pkcols
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
   where c.conrelid = 'public.dealer_contacts'::regclass
     and c.contype = 'p'
   group by c.conname;

  if pkcols is not null and pkcols <> 'id' then
    -- Keep (dealer_id,email) unique for the importer's on_conflict upserts.
    if not exists (
      select 1 from pg_constraint
       where conrelid = 'public.dealer_contacts'::regclass
         and conname  = 'dealer_contacts_dealer_email_uniq'
    ) then
      execute 'alter table dealer_contacts
                 add constraint dealer_contacts_dealer_email_uniq unique (dealer_id, email)';
    end if;

    execute format('alter table dealer_contacts drop constraint %I', pkname);
    execute 'alter table dealer_contacts add constraint dealer_contacts_pkey primary key (id)';
  end if;
end $$;

-- 3) Email is now optional.
alter table dealer_contacts alter column email drop not null;

-- ---- Verify (optional) -----------------------------------------------------
-- \d dealer_contacts
-- select id, dealer_id, email, name from dealer_contacts order by dealer_id, name limit 20;

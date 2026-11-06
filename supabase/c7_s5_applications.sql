-- ============================================================================
-- C3-07 STAGE 5 — MANUFACTURER ACCOUNT APPLICATIONS (owner directive 2026-11-05; decisions D1 + D5)
-- Additive only: two new tables + one private storage bucket. Nothing existing is read or changed.
--
-- dealer_applications   one application per dealer location + manufacturer form. The dealer's answers are stored ONLY
--                       encrypted (AES-256-GCM, key APPLICATIONS_ENC_KEY on the server — never in the database);
--                       the clear columns hold nothing sensitive (status, names of the form / signer, file paths).
--                       Written only by the server functions (dealer-applications-api, documenso-webhook,
--                       applications-admin-api). D5: President-only review; kept 7 years from the decision.
-- dealer_application_events  append-only history (who / what / when — never the answers).
-- storage dealer-applications  PRIVATE: the signed PDF, the signing certificate and audit log (reachable only through a
--                       two-minute signed link the President's admin page requests).
-- RULE 19: RLS on, no policies, no rights for anon / authenticated / public; service_role only.
-- Rollback (only while empty): drop table dealer_application_events; drop table dealer_applications;
--   delete from storage.buckets where id = 'dealer-applications';
-- ============================================================================
create table if not exists public.dealer_applications (
  id                uuid         primary key default gen_random_uuid(),
  dealer_id         uuid         not null references public.dealers(id),     -- the company (head office)
  location_id       uuid         not null references public.dealers(id),     -- the location applying
  manufacturer      text         not null check (manufacturer ~ '^[a-z0-9-]{2,60}$'),
  form_sha256       text         check (form_sha256 is null or form_sha256 ~ '^[0-9a-f]{64}$'),
  status            text         not null default 'draft' check (status in
                      ('draft','queued','signing','signed','signing_failed','offline_signed','under_review','sent_to_manufacturer','approved','declined','withdrawn')),
  answers_enc       text,                                                       -- base64 ( iv | tag | ciphertext ), never clear text
  business_name     text         check (business_name is null or char_length(business_name) <= 160),
  signer_name       text         check (signer_name is null or char_length(signer_name) <= 120),
  signer_email      text         check (signer_email is null or char_length(signer_email) <= 200),
  envelope_id       text         unique,
  signing_token_enc text,                                                       -- the signer's Documenso link token, encrypted
  sent_pdf_sha256   text,
  signed_path       text,
  signed_sha256     text,
  certificate_path  text,
  audit_path        text,
  signed_at         timestamptz,
  submitted_at      timestamptz,                                                -- when the dealer asked for it to be signed
  review_notes      text         check (review_notes is null or char_length(review_notes) <= 4000),
  decided_at        timestamptz,
  retention_until   date,                                                       -- D5: decision + 7 years
  version           int          not null default 1,
  created_by        text         not null,
  created_at        timestamptz  not null default now(),
  updated_by        text         not null,
  updated_at        timestamptz  not null default now()
);
create index if not exists dealer_applications_dealer_idx on public.dealer_applications (dealer_id, location_id, manufacturer);
create index if not exists dealer_applications_status_idx on public.dealer_applications (status, updated_at desc);
-- one open application per location + manufacturer (a declined / withdrawn one may be started again)
create unique index if not exists dealer_applications_open_uk on public.dealer_applications (location_id, manufacturer)
  where status not in ('declined','withdrawn','approved');

create table if not exists public.dealer_application_events (
  id             bigint       generated always as identity primary key,
  application_id uuid         not null references public.dealer_applications(id),
  at             timestamptz  not null default now(),
  actor          text         not null,
  action         text         not null check (char_length(action) <= 60),
  detail         jsonb        not null default '{}'::jsonb
);
create index if not exists dealer_application_events_app_idx on public.dealer_application_events (application_id, at);
create index if not exists dealer_application_events_action_idx on public.dealer_application_events (action, at);

-- the event log is append-only, for everyone (the owner included)
create or replace function public.dealer_application_events_guard() returns trigger language plpgsql as $$
begin raise exception 'dealer_application_events is append-only'; end $$;
drop trigger if exists dealer_application_events_no_change on public.dealer_application_events;
create trigger dealer_application_events_no_change before update or delete on public.dealer_application_events
  for each row execute function public.dealer_application_events_guard();
drop trigger if exists dealer_application_events_no_truncate on public.dealer_application_events;
create trigger dealer_application_events_no_truncate before truncate on public.dealer_application_events
  for each statement execute function public.dealer_application_events_guard();
revoke all on function public.dealer_application_events_guard() from public, anon, authenticated;

alter table public.dealer_applications enable row level security;
alter table public.dealer_application_events enable row level security;
revoke all on public.dealer_applications from public, anon, authenticated;
revoke all on public.dealer_application_events from public, anon, authenticated;
grant select, insert, update on public.dealer_applications to service_role;
grant select, insert on public.dealer_application_events to service_role;
revoke all on sequence public.dealer_application_events_id_seq from public, anon, authenticated;
grant usage on sequence public.dealer_application_events_id_seq to service_role;

-- private bucket for signed applications (lifecycle columns left NULL — production storage triggers expect that)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dealer-applications', 'dealer-applications', false, 15728640, array['application/pdf'])
on conflict (id) do nothing;

-- Check (one row): 2 tables, RLS on both, no policies, no public rights, private bucket, nothing written.
select
  (select count(*) from information_schema.tables where table_schema='public' and table_name in ('dealer_applications','dealer_application_events')) as tables_2,
  (select bool_and(relrowsecurity) from pg_class where oid in ('public.dealer_applications'::regclass,'public.dealer_application_events'::regclass))  as rls_on,
  (select count(*) from pg_policies where schemaname='public' and tablename in ('dealer_applications','dealer_application_events'))                   as policies_0,
  (select count(*) from information_schema.role_table_grants where table_schema='public' and table_name in ('dealer_applications','dealer_application_events')
     and grantee in ('anon','authenticated','PUBLIC'))                                                                                                as public_grants_0,
  (select public from storage.buckets where id='dealer-applications')                                                                               as bucket_public_false,
  (select count(*) from public.dealer_applications) + (select count(*) from public.dealer_application_events)                                        as rows_0;

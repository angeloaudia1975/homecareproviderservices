-- ============================================================================
-- REQUEST ACCESS (C3-06 closeout, owner 2026-11-05) — the record of a dealer asking for ordering access to a line it can
-- browse on Partner 360 but is not set up to order. Written ONLY by the dealer-tools-api function (service role), which
-- also emails HCPS staff. A request grants NOTHING: staff approve by turning the line on in the dealer's Ordering Access
-- grid. Additive only. RULE 19: RLS on, no policies, no rights for anon / authenticated — the public key cannot read or
-- write it. Rollback: drop table if exists public.dealer_access_requests;
-- ============================================================================
create table if not exists public.dealer_access_requests (
  id            bigint generated always as identity primary key,
  dealer_id     uuid        not null references public.dealers(id),
  manufacturer  text        not null,
  requested_by  text,
  status        text        not null default 'new' check (status in ('new','approved','declined','closed')),
  staff_note    text,
  created_at    timestamptz not null default now(),
  decided_at    timestamptz,
  decided_by    text
);
create index if not exists dealer_access_requests_dealer_idx on public.dealer_access_requests (dealer_id, manufacturer, created_at desc);

alter table public.dealer_access_requests enable row level security;
revoke all on public.dealer_access_requests from public, anon, authenticated;
grant select, insert, update on public.dealer_access_requests to service_role;

-- Check: table, RLS on, no policies, no public rights, no rows yet.
select
  (select count(*) from information_schema.tables where table_schema='public' and table_name='dealer_access_requests') as table_added,
  (select relrowsecurity from pg_class where oid='public.dealer_access_requests'::regclass)                       as rls_on,
  (select count(*) from pg_policies where schemaname='public' and tablename='dealer_access_requests')               as policies,
  (select count(*) from information_schema.role_table_grants where table_schema='public' and table_name='dealer_access_requests'
     and grantee in ('anon','authenticated','PUBLIC'))                                                              as public_grants,
  (select count(*) from public.dealer_access_requests)                                                              as rows_now;

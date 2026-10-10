-- ============================================================================================
--  MANUFACTURER CENTER — PHASE 1 FOUNDATION (approved by Angelo 2026-10-10)
--  Three tables Manufacturer Center owns + new columns on existing tables + a private bucket.
--  No product data moves and nothing a dealer sees changes: the shop and catalog-feed never
--  select any column added here (freight_terms is read only from Phase 5).
--
--  RULE 19 (every new table / view reviewed for public access) — stated per object:
--   * mfr_sources, mfr_decisions, mfr_verification_runs: RLS ON, NO policies, and
--     `revoke all ... from public, anon, authenticated`. Only service_role (catalog-api) reads or
--     writes them. Expected from outside with the public key: 401 / 42501.
--   * Their id sequences: the same revoke.
--   * New columns on product_skus / price_imports: those tables are already RLS-on with no
--     policies (public key returns 0 rows); nothing changes.
--   * New columns on manufacturer_meta (frozen, frozen_at, frozen_reason, deferrals,
--     freight_terms): manufacturer_meta is PUBLICLY READABLE by design (the storefront reads
--     logos and category maps from it). These columns are intentionally public and hold no
--     secrets: freight terms are dealer-facing by nature; the freeze flag and deferral notes are
--     operational labels. Write access is unchanged (service_role only).
--   * Storage bucket mfr-sources: public = false. storage.objects has RLS on; no policy grants
--     this bucket to anon/authenticated, so only service_role can read or write a file. The check
--     query at the end lists every storage.objects policy that does not name a bucket — it must
--     return no rows, or that policy would open this bucket too.
--  Run in the Supabase SQL editor (Run button) as one script. Safe to re-run.
-- ============================================================================================
begin;

-- 1. SOURCE REGISTER — one row per file received from a manufacturer.
create table if not exists public.mfr_sources (
  id                          bigserial primary key,
  manufacturer                text not null,
  kind                        text not null check (kind in ('price_list','terms','catalog','images','cross_reference','status_list','other')),
  title                       text not null check (length(trim(title)) > 0),
  file_name                   text,
  file_sha256                 text check (file_sha256 is null or file_sha256 ~ '^[0-9a-f]{64}$'),
  storage_path                text,
  received_date               date,
  legacy                      boolean not null default false,   -- registered after the fact; received date unknown
  manufacturer_effective_date date,
  effective_date_status       text not null default 'pending' check (effective_date_status in ('stated','pending','not_applicable')),
  supersedes_id               bigint references public.mfr_sources(id),
  status                      text not null default 'received' check (status in ('received','under_review','accepted','rejected','superseded')),
  accepted_by                 text,
  accepted_at                 timestamptz,
  note                        text,
  created_at                  timestamptz not null default now(),
  created_by                  text,
  -- A received date is never invented: a new source must carry one; only a legacy backfill may lack it.
  constraint mfr_sources_received check (legacy or received_date is not null),
  -- The manufacturer's effective date exists exactly when it is stated by the manufacturer.
  constraint mfr_sources_effective check ((effective_date_status = 'stated') = (manufacturer_effective_date is not null)),
  constraint mfr_sources_accepted check (status <> 'accepted' or (accepted_by is not null and accepted_at is not null))
);
create unique index if not exists mfr_sources_file_uk on public.mfr_sources (manufacturer, file_sha256) where file_sha256 is not null;
create index if not exists mfr_sources_mfr_idx on public.mfr_sources (manufacturer, status);
comment on table public.mfr_sources is 'Manufacturer Center source register: every file received from a manufacturer, its received date, the manufacturer effective date (or pending), what it supersedes and whether HCPS accepted it.';

-- 2. HCPS DECISIONS — interpretations and approvals, kept apart from manufacturer facts.
create table if not exists public.mfr_decisions (
  id                 bigserial primary key,
  manufacturer       text not null,
  source_id          bigint references public.mfr_sources(id),
  code               text,                                   -- null = line-wide
  field              text not null check (length(trim(field)) > 0),
  manufacturer_value jsonb,
  hcps_value         jsonb,
  kind               text not null check (kind in ('interpretation','conflict','exception','regression_fix','freight_terms','deferral','acceptance')),
  reason             text not null check (length(trim(reason)) > 0),
  decided_by         text not null,
  decided_at         timestamptz not null default now(),
  supersedes_id      bigint references public.mfr_decisions(id),
  used_at            timestamptz,                            -- a regression_fix is single-use
  used_by            text
);
create index if not exists mfr_decisions_mfr_idx on public.mfr_decisions (manufacturer, kind);
comment on table public.mfr_decisions is 'Manufacturer Center decisions log: each HCPS interpretation, conflict resolution, exception, deferral or regression fix, with the manufacturer value beside the HCPS value.';

-- 3. VERIFICATION RUNS — the evidence of every pre/post/regression check.
create table if not exists public.mfr_verification_runs (
  id             bigserial primary key,
  manufacturer   text not null,
  phase          text not null check (phase in ('baseline','pre','post','regression','release')),
  result         text not null check (result in ('pass','fail')),
  checks         jsonb not null,
  fingerprint    text,
  engine_version text,
  run_by         text,
  run_at         timestamptz not null default now()
);
create index if not exists mfr_verification_runs_mfr_idx on public.mfr_verification_runs (manufacturer, run_at desc);
comment on table public.mfr_verification_runs is 'Manufacturer Center verification evidence: product card, cart, server pricing, freight, both emails, impact, retired SKUs, images and the line fingerprint.';

-- Rule 19 for the three tables and their sequences.
alter table public.mfr_sources           enable row level security;
alter table public.mfr_decisions         enable row level security;
alter table public.mfr_verification_runs enable row level security;
revoke all on public.mfr_sources, public.mfr_decisions, public.mfr_verification_runs from public, anon, authenticated;
revoke all on sequence public.mfr_sources_id_seq, public.mfr_decisions_id_seq, public.mfr_verification_runs_id_seq from public, anon, authenticated;
grant all on public.mfr_sources, public.mfr_decisions, public.mfr_verification_runs to service_role;
grant usage, select on sequence public.mfr_sources_id_seq, public.mfr_decisions_id_seq, public.mfr_verification_runs_id_seq to service_role;

-- 4. NEW COLUMNS.
alter table public.product_skus
  add column if not exists source_id        bigint references public.mfr_sources(id),
  add column if not exists dealer_unit_cost numeric(12,2) check (dealer_unit_cost is null or dealer_unit_cost >= 0),
  add column if not exists msrp_basis       text check (msrp_basis is null or msrp_basis in ('each','order_unit')),
  add column if not exists map_basis        text check (map_basis  is null or map_basis  in ('each','order_unit'));
comment on column public.product_skus.dealer_unit_cost is 'The manufacturer''s per-piece dealer cost as accepted by HCPS. Never dealer-facing; never used to calculate a dealer price.';
comment on column public.product_skus.msrp_basis is 'each = the MSRP is quoted per piece; order_unit = per order unit (pack/case); null = today''s display rule.';
comment on column public.product_skus.map_basis  is 'each = the MAP is quoted per piece; order_unit = per order unit (pack/case); null = today''s display rule.';

alter table public.price_imports
  add column if not exists source_id        bigint references public.mfr_sources(id),
  add column if not exists parsed_case_qty  numeric check (parsed_case_qty is null or parsed_case_qty > 0),
  add column if not exists parsed_unit_cost numeric(12,2);

alter table public.manufacturer_meta
  add column if not exists frozen        boolean not null default false,
  add column if not exists frozen_at     timestamptz,
  add column if not exists frozen_reason text,
  add column if not exists deferrals     jsonb not null default '[]'::jsonb,
  add column if not exists freight_terms jsonb;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'manufacturer_meta_frozen_stamp') then
    alter table public.manufacturer_meta add constraint manufacturer_meta_frozen_stamp
      check (not frozen or (frozen_at is not null and frozen_reason is not null));
  end if;
  -- Every freight rule set carries where it came from: an accepted source and/or an HCPS decision.
  if not exists (select 1 from pg_constraint where conname = 'manufacturer_meta_freight_traced') then
    alter table public.manufacturer_meta add constraint manufacturer_meta_freight_traced
      check (freight_terms is null or coalesce(jsonb_typeof(freight_terms->'trace') = 'object'
             and (freight_terms->'trace' ? 'source_id' or freight_terms->'trace' ? 'decision_id'), false));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'manufacturer_meta_deferrals_array') then
    alter table public.manufacturer_meta add constraint manufacturer_meta_deferrals_array check (jsonb_typeof(deferrals) = 'array');
  end if;
end $$;

-- 5. PRIVATE BUCKET for source files.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('mfr-sources', 'mfr-sources', false, 52428800,
        array['application/pdf','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-excel',
              'text/csv','image/png','image/jpeg','application/zip'])
on conflict (id) do update set public = false;

commit;

-- ---------------------------------------------------------------------------------------------
-- CHECK (read-only, one result table — the SQL editor shows only the last result). Every row: ok = true.
select * from (
  select 1 as n, 'RLS on: ' || c.relname as check_name, c.relrowsecurity::text as value, (c.relrowsecurity) as ok
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('mfr_sources','mfr_decisions','mfr_verification_runs')
  union all
  select 2, 'policies on the three tables (expect 0)', count(*)::text, count(*) = 0
    from pg_policy where polrelid in ('public.mfr_sources'::regclass, 'public.mfr_decisions'::regclass, 'public.mfr_verification_runs'::regclass)
  union all
  select 3, 'grants to anon / authenticated / PUBLIC on the three tables (expect 0)', count(*)::text, count(*) = 0
    from information_schema.role_table_grants where table_schema = 'public'
     and table_name in ('mfr_sources','mfr_decisions','mfr_verification_runs') and grantee in ('anon','authenticated','PUBLIC')
  union all
  select 4, 'bucket mfr-sources is private', coalesce((select public::text from storage.buckets where id = 'mfr-sources'), 'missing'),
         coalesce((select not public from storage.buckets where id = 'mfr-sources'), false)
  union all
  select 5, 'storage.objects policies that name no bucket (expect 0)', count(*)::text, count(*) = 0
    from pg_policy where polrelid = 'storage.objects'::regclass
     and coalesce(pg_get_expr(polqual, polrelid), '') not like '%bucket_id%'
     and coalesce(pg_get_expr(polwithcheck, polrelid), '') not like '%bucket_id%'
  union all
  select 6, 'new columns present (product_skus 4, price_imports 3, manufacturer_meta 5)', count(*)::text, count(*) = 12
    from information_schema.columns where table_schema = 'public' and (
      (table_name = 'product_skus' and column_name in ('source_id','dealer_unit_cost','msrp_basis','map_basis')) or
      (table_name = 'price_imports' and column_name in ('source_id','parsed_case_qty','parsed_unit_cost')) or
      (table_name = 'manufacturer_meta' and column_name in ('frozen','frozen_at','frozen_reason','deferrals','freight_terms')))
) x order by n, check_name;

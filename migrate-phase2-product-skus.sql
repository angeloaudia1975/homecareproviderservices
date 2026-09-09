-- ============================================================================
--  HCPS Product Catalog rebuild — PHASE 2: THE NEW MODEL
--  Run once, in the Supabase SQL editor. Idempotent — safe to re-run.
--
--  WHAT THIS DOES
--    Creates the three tables the rebuild runs on. Nothing reads them yet:
--    the dealer shop and every admin screen carry on exactly as they are.
--
--  WHAT THIS DOES NOT DO
--    No existing table is altered, read from, or dropped. custom_products,
--    product_overrides, product_content and the deployed catalog files are
--    untouched. Nothing dealer-facing changes. Safe during business hours.
--
--  SECURITY
--    RLS is ON with NO policies, which means PostgREST serves these tables to
--    nobody — not the anon key, not a signed-in dealer. Only the service role
--    (the Netlify functions) can see them. A read policy gets added at cut-over,
--    deliberately, not by accident. These tables will eventually hold every
--    dealer price for every manufacturer.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
--  A quantity ladder has one shape from here on.
--
--  Today the same ladder exists as {minQty,price} in the catalog file and
--  {min_qty,price} in both database layers, which is why the shop carries code
--  to read either. Worse, a ladder could be any shape at all — nothing checked.
--  This constraint is what stops the next variation being invented.
-- ---------------------------------------------------------------------------
create or replace function public.hcps_valid_tier_ladder(t jsonb)
returns boolean language sql immutable as $$
  select t is null
      or ( jsonb_typeof(t) = 'array'
           and (select bool_and( jsonb_typeof(e) = 'object'
                             and jsonb_typeof(e->'min_qty') = 'number'
                             and jsonb_typeof(e->'price')   = 'number' )
                from jsonb_array_elements(t) e) is not false );
$$;

comment on function public.hcps_valid_tier_ladder(jsonb) is
  'A tier ladder is an array of {min_qty:number, price:number}. Null and empty array are valid.';


-- ===========================================================================
--  1. product_skus — ONE ROW PER SKU. The commercial record, and the only
--     place a price lives.
-- ===========================================================================
create table if not exists public.product_skus (
  id              bigserial primary key,
  manufacturer    text not null,

  -- The code exactly as the manufacturer writes it: MP-P08-KIT, CF002BL.
  code            text not null,

  -- THE CONSTRAINT THAT ENDS THE DUPLICATE CLASS.
  -- Every same-code duplicate we have chased — MP-P08-KIT / mp-p08-kit,
  -- FCOM / fcom, and the fifteen others — exists because two spellings of one
  -- part number could both be stored. Normalising the code and making it
  -- unique means the database refuses the second spelling outright. It stops
  -- being something to detect and clean up, and becomes something that cannot
  -- happen.
  code_norm       text generated always as (upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g'))) stored,

  -- Distinguishes SKUs on a multi-SKU page in a picker: "Large", "Black".
  -- NOT the product name. The product is named once, on its enrichment page.
  -- Calling this `name` is what let a stale per-SKU value override the title
  -- Angelo had approved, on every product, invisibly.
  option_label    text,

  -- Commercial terms. One home each.
  base_price      numeric(12,2),
  msrp            numeric(12,2),
  map             numeric(12,2),
  msrp_auto       boolean not null default false,
  tiers           jsonb,
  price_note      text,          -- dealer-facing only; never provenance, never a restated price
  uom             text,
  case_qty        integer,
  hcpcs           text,

  -- ONE GATE, replacing four.
  -- Today a product's sellability is decided by custom_products.active,
  -- product_overrides.patch.active, patch.disposition, product_content.status
  -- and product_content.disabled — five flags in three tables, which is how a
  -- page marked disabled stayed live to dealers while reading as hidden in the
  -- admin.
  status          text not null default 'active'
                  check (status in ('active','discontinued','not_listed')),
  status_note     text,
  status_at       timestamptz,
  status_by       text,

  -- Replaces merged_into. A superseded code keeps its order history and points
  -- at its replacement. Unlike merged_into it cannot point at itself or at a
  -- record that outranks it — see the check below.
  superseded_by   text,

  -- Where this price came from, so a wrong one is traceable to a file.
  effective_date  date,
  source_file     text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      text,

  constraint product_skus_code_not_blank check (length(btrim(code)) > 0),
  constraint product_skus_tiers_shape    check (public.hcps_valid_tier_ladder(tiers)),
  constraint product_skus_prices_sane    check (
        (base_price is null or base_price >= 0)
    and (msrp       is null or msrp       >= 0)
    and (map        is null or map        >= 0)
  ),
  -- A record cannot supersede itself, however it is spelled. This is exactly
  -- the state eleven Climbing Steps codes were found in: merged into their own
  -- lowercase twin, which made them read as retired while still being sold.
  constraint product_skus_no_self_supersede check (
    superseded_by is null
    or upper(regexp_replace(superseded_by, '[^A-Za-z0-9]', '', 'g'))
       <> upper(regexp_replace(code,          '[^A-Za-z0-9]', '', 'g'))
  )
);

-- One SKU per manufacturer, whatever the spelling.
create unique index if not exists product_skus_mfr_code_norm_uk
  on public.product_skus (manufacturer, code_norm);

create index if not exists product_skus_mfr_status_idx
  on public.product_skus (manufacturer, status);

comment on table public.product_skus is
  'One row per SKU. The master commercial record: price, MSRP, MAP, tiers, sellable status. Does NOT hold the product name, category, subcategory or grouping — those belong to the enrichment page and the category map.';
comment on column public.product_skus.option_label is
  'Picker label on a multi-SKU page ("Large", "Black"). Never the product name.';
comment on column public.product_skus.code_norm is
  'Case- and punctuation-insensitive code. Unique per manufacturer, so two spellings of one part number cannot both exist.';


-- ===========================================================================
--  2. price_imports — EVERY MANUFACTURER PRICE LIST, AS RECEIVED.
--     Never read by the shop. This is the audit trail and the diff source.
-- ===========================================================================
create table if not exists public.price_imports (
  id             bigserial primary key,
  manufacturer   text not null,
  import_label   text not null,          -- e.g. 'ovation-2026-01-01'
  source_file    text,                   -- '2026 ovation medical pricelist 992026.xlsx'
  effective_date date,
  imported_at    timestamptz not null default now(),
  imported_by    text,

  code           text not null,
  description    text,
  base_price     numeric(12,2),
  msrp           numeric(12,2),
  map            numeric(12,2),
  tiers          jsonb,
  raw            jsonb,                  -- the original row, so nothing is lost in parsing

  constraint price_imports_tiers_shape check (public.hcps_valid_tier_ladder(tiers))
);

create unique index if not exists price_imports_label_code_uk
  on public.price_imports (manufacturer, import_label, upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g')));

comment on table public.price_imports is
  'Manufacturer price lists exactly as received, one row per SKU per import. Never read by the dealer shop. An import produces a diff to accept, never a silent overwrite.';


-- ===========================================================================
--  3. reconcile_conflicts — WHAT THE RECONCILER REFUSES TO DECIDE.
--
--  The reconciler collapses the three existing layers into one product_skus
--  row. Where the layers AGREE it writes the value. Where they DISAGREE it
--  writes nothing and records the disagreement here, for a person.
--
--  That is the whole point. Every wrong price we found this week — the Nu-Form
--  Thumb Spica at the Classic's ladder, MP-P13 carrying Ascend & Go's price —
--  survived because some tool picked a winner silently.
-- ===========================================================================
create table if not exists snapshots.reconcile_conflicts (
  id            bigserial primary key,
  run_label     text not null,
  detected_at   timestamptz not null default now(),
  manufacturer  text not null,
  code          text not null,
  field         text not null,          -- 'base_price', 'tiers', 'option_label', ...
  layer_values  jsonb not null,         -- {"catalog_file":27.95,"added":27.95,"override":19.95}
  severity      text not null default 'blocking'
                check (severity in ('blocking','advisory')),
  resolution    text,                   -- what a person decided
  resolved_at   timestamptz,
  resolved_by   text,
  unique (run_label, manufacturer, code, field)
);

comment on table snapshots.reconcile_conflicts is
  'Layer disagreements the reconciler will not decide on its own. A blocking conflict stops that SKU migrating until a person resolves it.';


-- ---------------------------------------------------------------------------
--  Locked down until cut-over. RLS on, no policies: the service role (Netlify
--  functions) can read and write; PostgREST serves these to nobody.
-- ---------------------------------------------------------------------------
alter table public.product_skus            enable row level security;
alter table public.price_imports           enable row level security;
alter table snapshots.reconcile_conflicts  enable row level security;

commit;


-- ============================================================================
--  VERIFY — send me this output.
--  Expect 3 tables, 0 rows in each, rls_enabled true, policies 0.
-- ============================================================================
select t.table_schema || '.' || t.table_name                              as tbl,
       c.relrowsecurity                                                   as rls_enabled,
       (select count(*) from pg_policies p
         where p.schemaname = t.table_schema and p.tablename = t.table_name) as policies,
       (select count(*) from pg_indexes i
         where i.schemaname = t.table_schema and i.tablename = t.table_name) as indexes
from information_schema.tables t
join pg_class c     on c.relname = t.table_name
join pg_namespace n on n.oid = c.relnamespace and n.nspname = t.table_schema
where (t.table_schema, t.table_name) in
      (('public','product_skus'), ('public','price_imports'), ('snapshots','reconcile_conflicts'))
order by tbl;

-- Prove the duplicate class is now impossible. This must FAIL with a unique
-- violation on the second insert — that is the test passing.
--
--   insert into public.product_skus (manufacturer, code) values ('test-line','MP-P08-KIT');
--   insert into public.product_skus (manufacturer, code) values ('test-line','mp-p08-kit');
--   -- expected: duplicate key value violates unique constraint
--   delete from public.product_skus where manufacturer = 'test-line';

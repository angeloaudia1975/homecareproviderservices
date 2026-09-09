-- ============================================================================
--  HCPS Product Catalog rebuild — PHASE 3c: FIX THE GRANTS
--  Run once, in the Supabase SQL editor. Idempotent.
--
--  WHAT WENT WRONG
--    The apply step wrote 19 of Climbing Steps' 21 SKUs and held back TROL and
--    VLST, reporting their MSRP as unresolved — even though both resolutions
--    were recorded and verified. It reported `resolutions_used: 0`: it had read
--    NO decisions at all.
--
--    reconcile_conflicts was CREATED in the `snapshots` schema and later MOVED
--    to `public`. Supabase grants SELECT on newly created public tables to its
--    roles by default, but ALTER TABLE ... SET SCHEMA does not re-apply those
--    defaults. The table arrived in `public` with no grants for anyone —
--    including service_role, which the Netlify functions use. PostgREST
--    answered 42501 "Grant the required privileges", the function's error
--    handler swallowed it, and an unreadable table looked exactly like an empty
--    one.
--
--    product_skus and price_imports were created in public directly, so they
--    have the default grants and worked — which is why 19 rows wrote fine.
--
--  WHY IT DID NOT CORRUPT ANYTHING
--    The apply step holds back any SKU whose conflicts are not all resolved.
--    Unable to read the decisions, it declined to write those two rather than
--    guessing. The safety property did its job; the diagnosis was just wrong
--    until now.
-- ============================================================================

begin;

-- service_role runs the Netlify functions. It needs full access.
grant usage on schema public to service_role;
grant select, insert, update, delete on public.reconcile_conflicts to service_role;
grant usage, select on all sequences in schema public to service_role;

-- anon and authenticated must NOT see conflict records: they contain every
-- disputed dealer price, and the anon key ships in the shop's page source.
-- product_skus and price_imports are already protected by RLS with no policies
-- (they answer 200 with zero rows). This table is protected more simply, by
-- having no grant at all, which is why it answered 42501 rather than [].
revoke all on public.reconcile_conflicts from anon, authenticated;

-- Tell PostgREST to re-read the schema, since privileges changed.
notify pgrst, 'reload schema';

commit;

-- ============================================================================
--  VERIFY — service_role must be able to read; anon must not.
--  Expect exactly one row per grantee/privilege for service_role, and no rows
--  at all for anon or authenticated.
-- ============================================================================
select grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name   = 'reconcile_conflicts'
  and grantee in ('anon', 'authenticated', 'service_role')
group by grantee
order by grantee;

-- And the decisions are still all there, unchanged by any of the above.
select manufacturer,
       count(*)                                            as conflicts,
       count(*) filter (where resolved_value is not null)  as has_value
from public.reconcile_conflicts
where run_label = 'phase3-2026-09-09'
group by manufacturer
order by manufacturer;

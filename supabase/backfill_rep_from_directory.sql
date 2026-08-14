-- Backfill monthly_sales.rep_name from each dealer's assigned rep (dealer_directory).
-- Command Center reads the rep straight off monthly_sales.rep_name, and the sales-report
-- importer never stamped it — so imported sales (Strongback, AirAvant/Bongo) show as
-- "Unassigned". This assigns them to the dealer's rep. Match is by normalized business
-- name (same normalization the app uses), with a fallback to the family HQ's rep.
--
-- STEP 1 runs a PREVIEW (no writes). Review it. STEP 2 applies the update.

-- Normalizer matching the app's dnorm(): upper, HEALTHCARE, strip punctuation + legal suffixes.
create or replace function hcps_dnorm(t text) returns text language sql immutable as $$
  select btrim(regexp_replace(
           regexp_replace(
             regexp_replace(upper(coalesce(t,'')), 'HEALTH ?CARE', 'HEALTHCARE', 'g'),
             '[.,''&/#-]', ' ', 'g'),
           '\y(INC|INCORPORATED|LLC|CORP|CORPORATION|CO|COMPANY|LTD|LP|PLLC|PLC|DBA|THE)\y', ' ', 'g')
         )
$$;

-- rep for a dealer_id: its own directory row, else its parent/HQ's directory row.
create or replace view hcps_dealer_rep as
  select d.id as dealer_id,
         coalesce(nullif(btrim(dd.rep_name),''), nullif(btrim(pp.rep_name),'')) as rep_name
  from dealers d
  left join dealer_directory dd on hcps_dnorm(dd.dealer_name) = hcps_dnorm(d.business_name)
  left join dealers pd on pd.id = d.parent_id
  left join dealer_directory pp on hcps_dnorm(pp.dealer_name) = hcps_dnorm(pd.business_name);

-- ===========================================================================
-- STEP 1 — PREVIEW (safe, read-only). What each rep would gain, and what stays unassigned.
-- ===========================================================================
select coalesce(r.rep_name, '(still unassigned — no rep in directory)') as rep,
       count(*)                          as rows_to_set,
       round(sum(m.amount)::numeric, 2)  as sales
from monthly_sales m
left join hcps_dealer_rep r on r.dealer_id::text = m.dealer_id::text
where (m.rep_name is null or btrim(m.rep_name) = '')
group by 1
order by sales desc nulls last;

-- ===========================================================================
-- STEP 2 — APPLY. Run this only after the preview looks right.
-- ===========================================================================
-- update monthly_sales m
-- set rep_name = r.rep_name
-- from hcps_dealer_rep r
-- where r.dealer_id::text = m.dealer_id::text
--   and r.rep_name is not null
--   and (m.rep_name is null or btrim(m.rep_name) = '');

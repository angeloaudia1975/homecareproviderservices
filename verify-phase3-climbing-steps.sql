-- ============================================================================
--  PHASE 3 GATE — does the new model reproduce what dealers see today?
--  Read-only. Run in the Supabase SQL editor and send me the output.
--
--  This prints each of the 21 migrated Climbing Steps SKUs in exactly the same
--  shape I have already captured from the live shop, so the two can be compared
--  line for line. Any difference is a migration defect and stops Ovation.
--
--  Format:  CODE|dealer_price|msrp|map|tier ladder (breaks above qty 1)
-- ============================================================================

select string_agg(line, E'\n' order by line) as shop_comparison
from (
  select
    code || '|' ||
    coalesce(trim(to_char(base_price, 'FM9999999990.99')), '') || '|' ||
    coalesce(trim(to_char(msrp,       'FM9999999990.99')), '') || '|' ||
    coalesce(trim(to_char(map,        'FM9999999990.99')), '') || '|' ||
    coalesce((
      select string_agg((t->>'min_qty') || ':' || (t->>'price'), ' '
                        order by (t->>'min_qty')::int)
      from jsonb_array_elements(tiers) t
      where (t->>'min_qty')::int > 1
    ), '') as line
  from public.product_skus
  where manufacturer = 'climbing-steps'
) s;

-- Sanity counts alongside it.
select count(*)                                          as skus,
       count(*) filter (where base_price is null)        as missing_price,
       count(*) filter (where map is null)               as missing_map,
       count(*) filter (where status <> 'active')        as not_active,
       count(*) filter (where option_label is not null)  as with_option_label,
       count(distinct code_norm)                         as distinct_normalised_codes
from public.product_skus
where manufacturer = 'climbing-steps';

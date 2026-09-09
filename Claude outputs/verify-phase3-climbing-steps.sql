-- ============================================================================
--  PHASE 3 GATE — Climbing Steps. Read-only.
--  Prints the 21 migrated SKUs in the exact shape captured from the live shop,
--  so the two compare line for line.
--
--  The trailing '.' in the previous version was mine: to_char with FM leaves a
--  bare decimal point on whole numbers. Trimmed here so a real difference is
--  the only thing that can show up.
--
--  Format:  CODE|dealer_price|msrp|map|tier ladder above qty 1
-- ============================================================================

select string_agg(line, E'\n' order by line) as shop_comparison
from (
  select
    code || '|' ||
    coalesce(trim(trailing '.' from to_char(base_price, 'FM9999999990.99')), '') || '|' ||
    coalesce(trim(trailing '.' from to_char(msrp,       'FM9999999990.99')), '') || '|' ||
    coalesce(trim(trailing '.' from to_char(map,        'FM9999999990.99')), '') || '|' ||
    coalesce((
      select string_agg((t->>'min_qty') || ':' || (t->>'price'), ' '
                        order by (t->>'min_qty')::int)
      from jsonb_array_elements(tiers) t
      where (t->>'min_qty')::int > 1
    ), '') as line
  from public.product_skus
  where manufacturer = 'climbing-steps'
) s;

-- Case check on its own: every part number should be exactly as the
-- manufacturer writes it. Expect 0 rows.
select code as wrong_case_part_number
from public.product_skus
where manufacturer = 'climbing-steps'
  and code <> upper(code);

-- ============================================================================
--  PHASE 3 GATE — Ovation, second pass. Read-only.
--
--  WHY THERE IS A SECOND PASS
--    Six of fourteen buckets matched exactly. The eight that did not are, to the
--    row, the eight buckets containing a SKU whose MSRP the shop INVENTS at
--    display time rather than reading from anywhere:
--
--      matched   1  3  4  P  R  T      — suggested-MSRP SKUs in them: 0
--      differed  2  5  6  7  B  C  G  S — suggested-MSRP SKUs in them: 33
--
--    Thirty-three Ovation SKUs carry no MSRP in the price list, none in the
--    catalog file, none in either database layer. The storefront doubles the
--    dealer price and shows that. The reconciler had nothing to settle, so it
--    wrote null — which is honest, and is why the hashes differ.
--
--    This query applies the storefront's own rule to the stored data. If all
--    fourteen buckets now match, the difference is fully accounted for and
--    nothing else is hiding inside those eight buckets.
-- ============================================================================

with l as (
  select
    left(code, 1) as bucket,
    code || '|' ||
    coalesce(rtrim(to_char(base_price, 'FM9999999990.99'), '.'), '') || '|' ||
    -- the storefront's rule, applied here for comparison only. Nothing is written.
    coalesce(rtrim(to_char(coalesce(msrp, base_price * 2), 'FM9999999990.99'), '.'), '') || '|' ||
    coalesce(rtrim(to_char(map, 'FM9999999990.99'), '.'), '') || '|' ||
    coalesce((
      select string_agg((t->>'min_qty') || ':' || (t->>'price'), ' '
                        order by (t->>'min_qty')::int)
      from jsonb_array_elements(tiers) t
      where (t->>'min_qty')::int > 1
    ), '') as line
  from public.product_skus
  where manufacturer = 'ovation-medical'
)
select bucket,
       count(*) as n_rows,
       left(encode(sha256(convert_to(string_agg(line, E'\n' order by line collate "C"), 'UTF8')), 'hex'), 16) as sha16
from l
group by bucket

union all

select 'ALL',
       count(*),
       encode(sha256(convert_to(string_agg(line, E'\n' order by line collate "C"), 'UTF8')), 'hex')
from l
order by 1;

--  Expected, if the explanation is complete — these are the live shop's hashes:
--    ALL 303  c49752ae85c54ee50005d63b796a9dc6ebe608b86d56b515bf84fb87c285d45e
--    1  80  5be9a9a48fc19b40     6  21  28e8a881e499fbff
--    2  25  26dc762a4ac5e721     7  23  c9b0f7cd2dfacd47
--    3   8  9ca4e3f06bba2ec8     B  11  fb3bc7d2c348ace4
--    4  22  3f01ab4a5f77ec27     C  16  475da6cb710ba4ea
--    5  66  e009f72aa98b758a     G  13  756fc0ba1344af5c
--                                P   4  8b66036b1708d186
--                                R   8  fceaed6e7fb916b4
--                                S   4  ecbb508bb27f2f43
--                                T   2  7b8e3edf508035dc


-- ============================================================================
--  The thirty-three, for the record. No MSRP was stored for any of them; the
--  right-hand column is what a dealer is shown today.
-- ============================================================================
select code,
       to_char(base_price, 'FM9999999990.99')     as dealer_price,
       to_char(base_price * 2, 'FM9999999990.99') as msrp_the_shop_shows
from public.product_skus
where manufacturer = 'ovation-medical'
  and msrp is null
  and base_price is not null
order by code collate "C";

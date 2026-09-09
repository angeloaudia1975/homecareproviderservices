-- ============================================================================
--  PHASE 3 GATE — Ovation Medical. Read-only.
--
--  303 lines is far too many to eyeball, so this does not print them. It prints
--  a fingerprint of the same text the live shop produces, in 14 buckets keyed by
--  the first character of the part number, plus one hash of the whole thing.
--  A single wrong digit anywhere changes the bucket it lives in, which is how a
--  mismatch gets localised without pasting 303 rows.
--
--  I have already computed the shop side. Send me QUERY 1's output and I will
--  compare it against these, which were taken from the live shop just now:
--
--    all 303  c49752ae85c54ee50005d63b796a9dc6ebe608b86d56b515bf84fb87c285d45e
--      1  80  5be9a9a48fc19b40      6  21  28e8a881e499fbff
--      2  25  26dc762a4ac5e721      7  23  c9b0f7cd2dfacd47
--      3   8  9ca4e3f06bba2ec8      B  11  fb3bc7d2c348ace4
--      4  22  3f01ab4a5f77ec27      C  16  475da6cb710ba4ea
--      5  66  e009f72aa98b758a      G  13  756fc0ba1344af5c
--                                   P   4  8b66036b1708d186
--                                   R   8  fceaed6e7fb916b4
--                                   S   4  ecbb508bb27f2f43
--                                   T   2  7b8e3edf508035dc
--
--  Line format, identical on both sides:
--      CODE|dealer_price|msrp|map|tier ladder above qty 1
--
--  Two details that matter, both learned the hard way on Climbing Steps:
--    · `collate "C"` sorts by byte, the way the browser does. Without it the
--      database's en_US collation puts 61008-2 on the wrong side of 610082 and
--      every hash below it changes for no real reason.
--    · Tier rungs sort by NUMBER, not text, or 11 lands before 2.
-- ============================================================================


-- ============================================================================
--  QUERY 1 — the gate. Send me this whole output.
-- ============================================================================
with l as (
  select
    left(code, 1) as bucket,
    code || '|' ||
    coalesce(rtrim(to_char(base_price, 'FM9999999990.99'), '.'), '') || '|' ||
    coalesce(rtrim(to_char(msrp,       'FM9999999990.99'), '.'), '') || '|' ||
    coalesce(rtrim(to_char(map,        'FM9999999990.99'), '.'), '') || '|' ||
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


-- ============================================================================
--  QUERY 2 — the three things a hash match could still hide. Send this too.
--    wrong_case      expect 0   (part numbers must read as the manufacturer writes them)
--    rows_with_tiers expect 243
--    rows_with_map   expect 0   -- Ovation publishes no MAP anywhere: not in the
--                                  price list, not in the catalog file, not in a
--                                  price note. 0 here is correct, not missing data.
--    qty1_rungs      expect 0   (a qty-1 rung is base_price restated; it belongs
--                                  in base_price and nowhere else)
--    self_supersede  expect 0
-- ============================================================================
select
  count(*) filter (where code <> upper(code))                        as wrong_case,
  count(*) filter (where jsonb_array_length(coalesce(tiers,'[]')) > 0) as rows_with_tiers,
  count(*) filter (where map is not null)                            as rows_with_map,
  count(*) filter (where exists (
      select 1 from jsonb_array_elements(coalesce(tiers,'[]')) t
      where (t->>'min_qty')::int <= 1))                              as qty1_rungs,
  count(*) filter (where superseded_by is not null)                  as superseded_rows,
  count(*)                                                           as total
from public.product_skus
where manufacturer = 'ovation-medical';


-- ============================================================================
--  QUERY 3 — the eleven prices a person decided, now readable as prices.
--  These were recorded as conflicts because the deployed catalog file disagreed
--  with both live layers. In all eleven the two live layers agreed with each
--  other AND with the 2026 price list; the file was stale. This proves the
--  decision that was recorded is the value that actually landed.
-- ============================================================================
select s.code,
       c.field,
       case c.field
         when 'base_price' then to_char(s.base_price, 'FM9999999990.99')
         when 'tiers' then (select string_agg((t->>'min_qty')||':'||(t->>'price'), ' '
                                              order by (t->>'min_qty')::int)
                            from jsonb_array_elements(s.tiers) t)
       end                       as landed_in_product_skus,
       c.resolved_value::text    as decision_recorded,
       c.resolved_by
from public.reconcile_conflicts c
join public.product_skus s
  on s.manufacturer = c.manufacturer and s.code = c.code
where c.manufacturer = 'ovation-medical'
  and c.run_label    = 'phase3-2026-09-09'
order by s.code, c.field;


-- ============================================================================
--  QUERY 4 — both lines now live side by side in the new model.
--  Expect climbing-steps 21, ovation-medical 303. Nothing reads this table yet;
--  the shop is still served by the old three layers.
-- ============================================================================
select manufacturer,
       count(*)                                        as skus,
       count(*) filter (where status = 'active')       as active,
       count(*) filter (where superseded_by is not null) as superseded,
       min(updated_at)::date                           as migrated
from public.product_skus
group by manufacturer
order by manufacturer;

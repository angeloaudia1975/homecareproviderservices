-- ============================================================================
--  PHASE 3 GATE — both lines, final (revised). Read-only.
--
--  WHAT CHANGED FROM THE FIRST VERSION
--    The old comparison printed only tier rungs above quantity 1, so MP-P12's
--    rung AT quantity 1 — the one charging $629.99 against a $524.99 card —
--    could not have shown up in the hash. Query 4 caught it; the gate would not
--    have. The line now carries the effective unit price at quantity 1, worked
--    out exactly the way the storefront's unitPrice() works it out: the last
--    rung at or below qty 1 if there is one, otherwise base_price.
--
--    That closes the hole without creating false alarms. Twenty of Climbing
--    Steps' 21 SKUs carry a redundant qty-1 rung that simply restates
--    base_price; the reconciler drops those deliberately. Comparing raw ladders
--    would call all twenty a mismatch. Comparing the effective price calls none
--    of them a mismatch — and still catches MP-P12, whose two numbers disagree.
--
--  Line format:
--    CODE|dealer_price|msrp|map|effective_unit_price_at_qty_1|rungs above qty 1
-- ============================================================================


-- ============================================================================
--  QUERY 1 — the gate. Send me this whole output.
--
--  Live shop, captured just now:
--
--   ovation-medical  n=303
--     ALL  1b5e3fa0c4948c70cbc19645ff6c7b2326c7211ed179ee3516125d97b3b4b7a2
--     1 80 d8fbde2aee1e929a    6 21 bcd3e9e02ea09cab    P  4 09cd6fb5316e4f0c
--     2 25 45c2e728684eb571    7 23 5a427080d6ed5663    R  8 d6fe7bff4b00400c
--     3  8 c87508c7a261cd23    B 11 da3604c3f09eed0e    S  4 93ac7dc6bbee1bac
--     4 22 c8ba789eacfa62e3    C 16 0e1f02ac763f45b7    T  2 e1bfe496fb2d4923
--     5 66 712b25f1b4192b70    G 13 4b828a86108156d0
--
--   climbing-steps   n=21
--     ALL  010889a09565a4529945c67727585bcf1508fdbb7d553f3ffa887ac302aa6241
--     A  1 21dc2411d855f6fb    L  1 4e2847031d260bac    T  1 0f2ea71f6d868a75
--     F  2 b5f7b6355b9fe092    M 13 a6e2885576df4e24    V  1 243b5eb4bc5cd203
--     H  2 69879fc3069ed5d5
-- ============================================================================
with l as (
  select
    manufacturer,
    left(code, 1) as bucket,
    code || '|' ||
    coalesce(rtrim(to_char(base_price, 'FM9999999990.99'), '.'), '') || '|' ||
    coalesce(rtrim(to_char(msrp,       'FM9999999990.99'), '.'), '') || '|' ||
    coalesce(rtrim(to_char(map,        'FM9999999990.99'), '.'), '') || '|' ||
    -- what a dealer is actually charged for one unit, storefront rules
    coalesce(rtrim(to_char(coalesce((
        select (e.t->>'price')::numeric
        from jsonb_array_elements(coalesce(tiers, '[]')) with ordinality as e(t, ord)
        where (e.t->>'min_qty')::int <= 1
        order by e.ord desc
        limit 1
      ), base_price), 'FM9999999990.99'), '.'), '') || '|' ||
    coalesce((
      select string_agg((t->>'min_qty') || ':' || (t->>'price'), ' '
                        order by (t->>'min_qty')::int)
      from jsonb_array_elements(tiers) t
      where (t->>'min_qty')::int > 1
    ), '') as line
  from public.product_skus
)
select manufacturer, bucket,
       count(*) as n_rows,
       left(encode(sha256(convert_to(string_agg(line, E'\n' order by line collate "C"), 'UTF8')), 'hex'), 16) as sha16
from l
group by manufacturer, bucket

union all

select manufacturer, 'ALL',
       count(*),
       encode(sha256(convert_to(string_agg(line, E'\n' order by line collate "C"), 'UTF8')), 'hex')
from l
group by manufacturer
order by 1, 2;


-- ============================================================================
--  QUERY 2 — the six Nu-Form Thumb Spica records. Expect $27.95 dealer,
--  $55.90 MSRP, msrp_auto true on all six. $39.90 must not appear: it was
--  twice $19.95, a price these have not carried since it was corrected.
-- ============================================================================
select code,
       rtrim(to_char(base_price, 'FM9999999990.99'), '.') as dealer,
       rtrim(to_char(msrp,       'FM9999999990.99'), '.') as msrp,
       msrp_auto
from public.product_skus
where manufacturer = 'ovation-medical'
  and code in ('50072-5','50075-5','50078-5','51072-5','51075-5','51078-5')
order by code;


-- ============================================================================
--  QUERY 3 — how much of each line's MSRP the manufacturer actually quoted.
--
--  For Ovation the answer should be none of it: the price list carries no MSRP
--  column, so every figure is HCPS's own at twice the dealer price. Expect
--  ovation-medical to show 303 with an MSRP and 303 generated.
-- ============================================================================
select manufacturer,
       count(*)                                    as skus,
       count(msrp)                                 as with_msrp,
       count(*) filter (where msrp_auto)           as generated_by_us,
       count(*) filter (where msrp is not null and not msrp_auto) as quoted_by_manufacturer,
       count(*) filter (where msrp is not null and base_price > 0
                          and abs(msrp - base_price * 2) >= 0.005) as off_the_multiplier
from public.product_skus
group by manufacturer
order by manufacturer;


-- ============================================================================
--  QUERY 4 — already run. Kept here so the gate is one file.
--    ovation-medical  wrong_case 1 (4900-Wrap), tiers 243, map 0, qty1 0
--    climbing-steps   wrong_case 0, tiers 1, map 21, qty1 1 (MP-P12)
-- ============================================================================
select manufacturer,
  count(*) filter (where code <> upper(code))                          as wrong_case,
  count(*) filter (where jsonb_array_length(coalesce(tiers,'[]')) > 0) as rows_with_tiers,
  count(*) filter (where map is not null)                              as rows_with_map,
  count(*) filter (where exists (
      select 1 from jsonb_array_elements(coalesce(tiers,'[]')) t
      where (t->>'min_qty')::int <= 1))                                as qty1_rungs,
  count(*)                                                             as total
from public.product_skus
group by manufacturer
order by manufacturer;

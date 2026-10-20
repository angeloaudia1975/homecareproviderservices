-- HCPS Academy — Phase 2 / M9 ROLLBACK. Puts M8 back exactly as it was. Refused while any refund request, buyer review
-- or price-history row exists (those are business records and are never thrown away by a rollback).
begin;
do $$ begin
  if to_regclass('public.academy_refund_requests') is null then raise exception 'M9 is not installed'; end if;
  if exists (select 1 from academy_refund_requests) or exists (select 1 from academy_buyer_reviews) or exists (select 1 from academy_price_history) then
    raise exception 'M9 rollback refused: refund requests, buyer reviews or price history exist';
  end if;
end $$;
drop trigger academy_sale_price_history on public.academy_prices;
drop trigger academy_sale_refund_monotonic on public.academy_purchases;
drop trigger academy_sale_close_requests on public.academy_purchases;
drop trigger academy_sale_buyer_check on public.academy_purchases;
do $$ declare t text; begin
  foreach t in array array['academy_purchases','academy_prices','academy_stripe_events'] loop
    execute format('drop trigger academy_sale_no_truncate on public.%I', t);
  end loop;
end $$;
drop table public.academy_refund_requests, public.academy_buyer_reviews, public.academy_price_history;
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_sale\_%'
  loop execute format('drop function %s', f.sig); end loop;
end $$;
-- M8's eligibility rule, exactly as M8 installed it
create or replace function public.academy_purchase_dealer_eligible(p_dealer uuid) returns boolean
language sql stable set search_path = pg_catalog, public, pg_temp as $$
  with d as (select * from dealers where id = p_dealer),
       head as (select h.* from dealers h, d where h.id = coalesce(d.parent_id, d.id))
  select case
    when not exists (select 1 from d) then false
    when exists (select 1 from academy_dealer_eligibility e where e.dealer_id = p_dealer) then
      (select e.eligible from academy_dealer_eligibility e where e.dealer_id = p_dealer)
    when exists (select 1 from academy_dealer_eligibility e, head where e.dealer_id = head.id) then
      (select e.eligible from academy_dealer_eligibility e, head where e.dealer_id = head.id)
    when (select coalesce(d.is_test, false) from d) or (select coalesce(head.is_test, false) from head) then true
    else coalesce((select lower(coalesce(head.status, '')) = 'active'
                      and lower(btrim(coalesce(head.account_class, ''))) in ('', 'dealer') from head), false)
  end
$$;
revoke all on function public.academy_purchase_dealer_eligible(uuid) from public, anon, authenticated, service_role;
grant execute on function public.academy_purchase_op_set_price(text,uuid,jsonb) to service_role;
select 'M9 removed' as check, to_regclass('public.academy_refund_requests') is null
   and not exists (select 1 from pg_proc where proname like 'academy\_sale\_%')
   and has_function_privilege('service_role', 'public.academy_purchase_op_set_price(text,uuid,jsonb)', 'execute') as ok;
commit;

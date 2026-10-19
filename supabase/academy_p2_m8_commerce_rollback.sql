-- HCPS Academy — Phase 2 / M8 ROLLBACK. Refused while any commerce record exists (an organization, price, override,
-- buyer review, checkout, purchase or Stripe event) or any membership belongs to an outside organization: those are
-- business records and are never thrown away by a rollback. Before running it, turn academy_payments off and deploy
-- the code without the commerce functions.
begin;
do $$ begin
  if to_regprocedure('public.academy_commerce_op_set_price(text,uuid,jsonb,text)') is null then raise exception 'M8 is not installed'; end if;
  if exists (select 1 from academy_organizations) or exists (select 1 from academy_course_prices) or exists (select 1 from academy_eligibility_overrides)
     or exists (select 1 from academy_buyer_reviews) or exists (select 1 from academy_checkouts) or exists (select 1 from academy_purchases)
     or exists (select 1 from academy_stripe_events) or exists (select 1 from academy_memberships where organization_id is not null)
     or exists (select 1 from academy_enrollments where access_source = 'purchase') then
    raise exception 'M8 rollback refused: commerce records exist';
  end if;
end $$;

do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'academy_commerce_%' and p.proname not like '%guard%'
  loop execute format('drop function %s', f.sig); end loop;
end $$;
drop trigger academy_commerce_membership_guard on public.academy_memberships;
drop table public.academy_purchases, public.academy_checkouts, public.academy_stripe_events, public.academy_buyer_reviews,
           public.academy_course_price_history, public.academy_course_prices, public.academy_eligibility_overrides;
alter table public.academy_memberships drop constraint academy_memberships_outside_shape;
alter table public.academy_memberships drop constraint academy_memberships_one_owner;
drop index public.academy_memberships_org;
alter table public.academy_memberships drop column organization_id;
drop table public.academy_organizations;
drop function public.academy_commerce_guard(), public.academy_commerce_guard_truncate(), public.academy_commerce_membership_guard();
alter table public.academy_memberships drop constraint academy_memberships_access_type_check;
alter table public.academy_memberships add constraint academy_memberships_access_type_check check (access_type in ('dealer_user','training_only'));
alter table public.academy_enrollments drop constraint academy_enrollments_access_source_check;
alter table public.academy_enrollments add constraint academy_enrollments_access_source_check check (access_source in ('assigned','self','admin_grant'));
alter table public.academy_memberships alter column dealer_id set not null;

select 'M8 removed' as check, to_regclass('public.academy_purchases') is null and to_regclass('public.academy_organizations') is null
   and not exists (select 1 from pg_proc where proname like 'academy_commerce_%') as ok;
commit;

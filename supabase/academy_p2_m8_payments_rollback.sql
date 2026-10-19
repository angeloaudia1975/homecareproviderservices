-- HCPS Academy — Phase 2 / M8 ROLLBACK. Removes paid course access completely.
-- Refuses while any purchase, outside organization, price, override or Stripe event exists: purchase history is a
-- financial record and is never dropped by a rollback (a rollback is not a reaction to suspicion — CLAUDE.md §19).
-- To stop sales without a rollback: turn the academy_payments switch off (no deploy needed).
begin;
do $$ begin
  if to_regclass('public.academy_purchases') is null then raise exception 'M8 is not installed'; end if;
  if exists (select 1 from academy_purchases) or exists (select 1 from academy_organizations) or exists (select 1 from academy_prices)
     or exists (select 1 from academy_dealer_eligibility) or exists (select 1 from academy_stripe_events)
     or exists (select 1 from academy_memberships where organization_id is not null)
     or exists (select 1 from academy_enrollments where access_source = 'purchase') then
    raise exception 'M8 rollback refused: payment records exist';
  end if;
end $$;
drop trigger academy_purchase_member_guard on public.academy_memberships;
drop function public.academy_purchase_member_guard();
drop function public.academy_purchase_op_stripe_event(text, text, boolean, jsonb);
drop function public.academy_purchase_op_abandon(uuid, text);
drop function public.academy_purchase_op_attach(uuid, text, text, timestamptz, boolean);
drop function public.academy_purchase_op_open(text, text, text, text, text);
drop function public.academy_purchase_op_set_eligibility(text, uuid, boolean, text);
drop function public.academy_purchase_op_set_price(text, uuid, jsonb);
drop function public.academy_purchase_op_catalog();
drop function public.academy_purchase_restore(academy_purchases);
drop function public.academy_purchase_withdraw(academy_purchases, text);
drop function public.academy_purchase_grant(academy_purchases);
drop function public.academy_purchase_email_included(text);
drop function public.academy_purchase_dealer_eligible(uuid);
drop table public.academy_stripe_events;
drop table public.academy_purchases;
drop table public.academy_dealer_eligibility;
drop table public.academy_prices;
drop function public.academy_prices_rights_check();
alter table public.academy_enrollments drop constraint academy_enrollments_access_source_check;
alter table public.academy_enrollments add constraint academy_enrollments_access_source_check
  check (access_source in ('assigned','self','admin_grant'));
drop index public.academy_memberships_one_active_org;
alter table public.academy_memberships drop constraint academy_memberships_org_learner_only;
alter table public.academy_memberships drop constraint academy_memberships_one_owner;
alter table public.academy_memberships drop column organization_id;
alter table public.academy_memberships alter column dealer_id set not null;
drop table public.academy_organizations;
drop function public.academy_purchase_guard();
select 'M8 removed' as result, to_regclass('public.academy_purchases') is null as ok;
commit;

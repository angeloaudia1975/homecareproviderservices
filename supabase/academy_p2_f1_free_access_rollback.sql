-- HCPS Academy — Phase 2 / F1 ROLLBACK. Puts M8 back exactly as it was. Refused while any course access policy, free
-- registration or free enrollment exists (business records are never thrown away by a rollback). To stop free
-- enrollment without a rollback, set the course's access to 'off' in the Command Center (audited).
begin;
do $$ begin
  if to_regclass('public.academy_course_access') is null then raise exception 'F1 is not installed'; end if;
  if exists (select 1 from academy_course_access) or exists (select 1 from academy_free_registrations)
     or exists (select 1 from academy_enrollments where access_source = 'free') then
    raise exception 'F1 rollback refused: access policies, free registrations or free enrollments exist';
  end if;
end $$;
drop trigger academy_free_no_checkout on public.academy_purchases;
drop table public.academy_free_registrations, public.academy_course_access;
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_free\_%'
  loop execute format('drop function %s', f.sig); end loop;
end $$;
alter table public.academy_enrollments drop constraint academy_enrollments_access_source_check;
alter table public.academy_enrollments add constraint academy_enrollments_access_source_check
  check (access_source in ('assigned','self','admin_grant','purchase'));
-- M8's two functions, exactly as M8 installed them
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
create or replace function public.academy_purchase_member_guard() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.organization_id is not null and (tg_op = 'INSERT' or new.organization_id is distinct from old.organization_id)
     and coalesce(current_setting('academy.op', true), '') not in ('purchase_grant') then
    raise exception 'academy: an outside organization''s access comes only from a verified purchase' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.academy_purchase_dealer_eligible(uuid) from public, anon, authenticated, service_role;
select 'F1 removed' as check, to_regclass('public.academy_course_access') is null and not exists (select 1 from pg_proc where proname like 'academy\_free\_%') as ok;
commit;

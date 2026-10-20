-- HCPS Academy — Phase 2 / M9: refund requests, price history, buyer review, TEST eligibility fix (SANDBOX ONLY).
-- Incremental on top of M8 (supabase/academy_p2_m8_payments.sql) — it NEVER replaces M8 and refuses to run without it.
-- Owner decision (PR #26 comment 6293379665, 20 Oct 2026): main's M8 is the baseline; the additions from draft PR #26
-- are rebuilt here as a separate, reviewable step. Runbook: docs/academy/P2_M9_REFUNDS.md. Angelo runs it himself, after
-- M8 is installed and both have been reviewed (CLAUDE.md §7: financial migrations need his separate approval).
--
-- What it adds (nothing here takes or returns money; Stripe stays SANDBOX ONLY, academy_purchases.livemode = false):
--   1. TEST ELIGIBILITY FIX (replaces ONE M8 helper, academy_purchase_dealer_eligible, reviewed): a TEST dealership is
--      free only when the dealership ITSELF is TEST. A real (non-TEST) dealership whose head office is TEST no longer
--      inherits "free" — it is judged by the real rule (its head office active + account class blank/dealer is then
--      impossible to satisfy through a TEST head office, so it is NOT free unless the President overrides it). TEST
--      courses stay unsellable (M8). Everything else in M8's rule is unchanged.
--   2. PRICE HISTORY: every change to academy_prices is kept in append-only academy_price_history with WHO and WHY.
--      Prices change only through academy_sale_op_set_price (President + a reason); the server role loses M8's
--      reason-less academy_purchase_op_set_price.
--   3. REFUND REQUESTS: a buyer asks for a refund within 14 days of payment (academy_sale_op_refund_request); the
--      President approves or declines with a reason (academy_sale_op_refund_decide). The money is still refunded in the
--      Stripe Dashboard (no refund API key in HCPS); Stripe's signed charge.refunded event (M8) then closes the request.
--   4. REFUND RECORD SAFETY: a late or replayed charge.refunded never LOWERS the refunded amount, and a fully refunded
--      purchase never goes back to "partially refunded" (out-of-order events).
--   5. BUYER REVIEW: a buyer with two or more refunded purchases in 12 months cannot open a new checkout until the
--      President records "allow"; "block" stops one at any time (append-only decisions).
-- Security (RULE 19): new tables RLS on, no policies, nothing for public / anon / authenticated, SELECT only for the
-- server role; writes only inside an audited operation (M8's academy_purchase_guard). New functions: prefix academy_sale_.
begin;

do $$ begin
  if to_regclass('public.academy_purchases') is null or to_regprocedure('public.academy_purchase_op_set_price(text,uuid,jsonb)') is null then
    raise exception 'M9 needs M8 (academy_p2_m8_payments.sql) installed first';
  end if;
  if to_regclass('public.academy_refund_requests') is not null then raise exception 'M9 is already installed'; end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 1. TEST eligibility fix (the only M8 function this file replaces)
-- ---------------------------------------------------------------------------------------------
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
    -- M9: TEST is free only for a dealership that is itself TEST (sandbox / pilot); a real dealership under a TEST head
    -- office is never free by inheritance
    when (select coalesce(d.is_test, false) from d) then true
    when (select coalesce(head.is_test, false) from head) then false
    else coalesce((select lower(coalesce(head.status, '')) = 'active'
                      and lower(btrim(coalesce(head.account_class, ''))) in ('', 'dealer') from head), false)
  end
$$;

-- ---------------------------------------------------------------------------------------------
-- SCHEMA
-- ---------------------------------------------------------------------------------------------
create table public.academy_price_history (
  id         bigint generated always as identity primary key,
  course_id  uuid not null references public.academy_courses(id) on delete restrict,
  before     jsonb,
  after      jsonb not null,
  reason     text not null check (length(btrim(reason)) between 5 and 500),
  actor      text not null,
  at         timestamptz not null default now()
);
create table public.academy_refund_requests (
  id               uuid primary key default gen_random_uuid(),
  purchase_id      uuid not null references public.academy_purchases(id) on delete restrict,
  learner_id       uuid not null references public.academy_learners(id) on delete restrict,
  reason           text not null check (length(btrim(reason)) between 5 and 500),
  status           text not null default 'requested' check (status in ('requested','approved','declined','refunded')),
  requested_at     timestamptz not null default now(),
  decided_by       text,
  decided_at       timestamptz,
  decision_reason  text,
  closed_at        timestamptz,
  check ((status = 'requested') = (decided_at is null)),
  check (status = 'requested' or (decided_by is not null and decision_reason is not null) or status = 'refunded')
);
create unique index academy_refund_requests_one_open on public.academy_refund_requests (purchase_id) where status in ('requested','approved');
create table public.academy_buyer_reviews (
  id             bigint generated always as identity primary key,
  email          text not null check (email = lower(email) and length(email) <= 254),
  decision       text not null check (decision in ('allow','block')),
  reason         text not null check (length(btrim(reason)) between 5 and 500),
  decided_by     text not null,
  decided_at     timestamptz not null default now(),
  superseded_at  timestamptz
);
create unique index academy_buyer_reviews_current on public.academy_buyer_reviews (email) where superseded_at is null;

do $$ declare t text; begin
  foreach t in array array['academy_price_history','academy_refund_requests','academy_buyer_reviews'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on table public.%I to service_role', t);
    execute format('create trigger academy_purchase_guard before insert or update or delete on public.%I for each row execute function public.academy_purchase_guard()', t);
  end loop;
end $$;
-- History and decisions are never rewritten: price history is append-only; a buyer review may only be marked superseded.
create function public.academy_sale_append_only() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'DELETE' then raise exception 'academy: % is never deleted', tg_table_name using errcode = '42501'; end if;
  if tg_table_name = 'academy_price_history' then raise exception 'academy: price history is append-only' using errcode = '42501'; end if;
  if old.superseded_at is not null or new.superseded_at is null or (to_jsonb(new) - 'superseded_at') is distinct from (to_jsonb(old) - 'superseded_at') then
    raise exception 'academy: a decision is never edited; record a new one' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger academy_sale_append_only before update or delete on public.academy_price_history for each row execute function public.academy_sale_append_only();
create trigger academy_sale_append_only before update or delete on public.academy_buyer_reviews for each row execute function public.academy_sale_append_only();
create function public.academy_sale_no_truncate() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin raise exception 'academy: % is never truncated', tg_table_name using errcode = '42501'; end $$;
do $$ declare t text; begin
  foreach t in array array['academy_price_history','academy_refund_requests','academy_buyer_reviews','academy_purchases','academy_prices','academy_stripe_events'] loop
    execute format('create trigger academy_sale_no_truncate before truncate on public.%I for each statement execute function public.academy_sale_no_truncate()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 2. PRICE HISTORY — written by a trigger on academy_prices, so EVERY price change is kept; a change without a reason
--    (academy.price_reason, set by academy_sale_op_set_price) is refused.
-- ---------------------------------------------------------------------------------------------
create function public.academy_sale_price_history() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare v_reason text := nullif(btrim(coalesce(current_setting('academy.price_reason', true), '')), '');
begin
  if v_reason is null or length(v_reason) < 5 then
    raise exception 'academy: a price change needs a reason (5 to 500 characters)' using errcode = '22023';
  end if;
  insert into academy_price_history (course_id, before, after, reason, actor)
  values (new.course_id, case when tg_op = 'UPDATE' then to_jsonb(old) end, to_jsonb(new), left(v_reason, 500), new.updated_by);
  return null;
end $$;
create trigger academy_sale_price_history after insert or update on public.academy_prices
  for each row execute function public.academy_sale_price_history();

create function public.academy_sale_op_set_price(p_actor text, p_course_id uuid, p_spec jsonb, p_reason text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v jsonb;
begin
  perform academy_content_actor_president(p_actor);
  if p_reason is null or length(btrim(p_reason)) < 5 or length(p_reason) > 500 then
    raise exception 'academy: a reason (5 to 500 characters) is required' using errcode = '22023';
  end if;
  perform set_config('academy.price_reason', btrim(p_reason), true);
  v := academy_purchase_op_set_price(p_actor, p_course_id, p_spec);   -- M8's checks: price range, manufacturer rights, …
  perform set_config('academy.price_reason', '', true);
  return v;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 4. REFUND RECORD SAFETY (out-of-order / replayed charge.refunded) + closing refund requests
-- ---------------------------------------------------------------------------------------------
create function public.academy_sale_refund_monotonic() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.amount_refunded_cents < old.amount_refunded_cents then new.amount_refunded_cents := old.amount_refunded_cents; end if;
  if old.status = 'refunded' and new.status = 'partially_refunded' then new.status := 'refunded'; new.refunded_at := old.refunded_at; end if;
  return new;
end $$;
create trigger academy_sale_refund_monotonic before update on public.academy_purchases
  for each row execute function public.academy_sale_refund_monotonic();

create function public.academy_sale_close_requests() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.status = 'refunded' and old.status is distinct from 'refunded' then
    update academy_refund_requests set status = 'refunded', closed_at = now(), decided_at = coalesce(decided_at, now()),
           decided_by = coalesce(decided_by, 'system:stripe'), decision_reason = coalesce(decision_reason, 'Refunded in Stripe')
     where purchase_id = new.id and status in ('requested','approved');
  end if;
  return null;
end $$;
create trigger academy_sale_close_requests after update on public.academy_purchases
  for each row execute function public.academy_sale_close_requests();

-- ---------------------------------------------------------------------------------------------
-- 5. BUYER REVIEW — checked on every new checkout row (M8's academy_purchase_op_open inserts it)
-- ---------------------------------------------------------------------------------------------
create function public.academy_sale_buyer_check() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare v_rev academy_buyer_reviews; v_n int;
begin
  select * into v_rev from academy_buyer_reviews where email = new.email and superseded_at is null;
  select count(*) into v_n from academy_purchases
   where email = new.email and (status = 'refunded' or amount_refunded_cents > 0) and coalesce(paid_at, created_at) > now() - interval '12 months';
  if v_rev.decision = 'block' or (v_n >= 2 and v_rev.decision is distinct from 'allow') then
    raise exception 'academy: we need to review this purchase first. Please contact HCPS at info@homecareproviderservices.us.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger academy_sale_buyer_check before insert on public.academy_purchases
  for each row execute function public.academy_sale_buyer_check();

create function public.academy_sale_op_buyer_review(p_actor text, p_email text, p_decision text, p_reason text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_email text := lower(btrim(coalesce(p_email, ''))); v_old academy_buyer_reviews; v_new academy_buyer_reviews;
begin
  perform academy_content_actor_president(p_actor);
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(v_email) > 254 then raise exception 'academy: that is not an email address' using errcode = '22023'; end if;
  if p_decision not in ('allow','block') then raise exception 'academy: decide allow or block' using errcode = '22023'; end if;
  if p_reason is null or length(btrim(p_reason)) < 5 or length(p_reason) > 500 then raise exception 'academy: a reason (5 to 500 characters) is required' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('academy-buyer-review:' || v_email));
  perform academy_op_begin('sale_buyer_review', p_actor);
  select * into v_old from academy_buyer_reviews where email = v_email and superseded_at is null for update;
  if v_old.id is not null then update academy_buyer_reviews set superseded_at = now() where id = v_old.id; end if;
  insert into academy_buyer_reviews (email, decision, reason, decided_by) values (v_email, p_decision, btrim(p_reason), p_actor) returning * into v_new;
  perform academy_op_audit('staff', p_actor, 'academy_buyer_reviews', v_email, 'buyer_review',
    case when v_old.id is null then null else jsonb_build_object('decision', v_old.decision) end, jsonb_build_object('decision', p_decision, 'reason', btrim(p_reason)));
  perform academy_op_end();
  return jsonb_build_object('ok', true, 'review_id', v_new.id);
end $$;

-- ---------------------------------------------------------------------------------------------
-- 3. REFUND REQUESTS — the buyer asks (14 days), the President decides; Stripe's refund event closes it
-- ---------------------------------------------------------------------------------------------
create function public.academy_sale_op_refund_request(p_actor text, p_purchase_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_p academy_purchases; v_r academy_refund_requests;
begin
  select * into v_p from academy_purchases where id = p_purchase_id for update;
  if not found or v_p.learner_id is null then raise exception 'academy: purchase not found' using errcode = 'P0002'; end if;
  perform academy_op_actor_learner(p_actor, v_p.learner_id);
  if p_reason is null or length(btrim(p_reason)) < 5 or length(p_reason) > 500 then
    raise exception 'academy: tell us briefly why (5 to 500 characters)' using errcode = '22023';
  end if;
  if v_p.status <> 'paid' or v_p.amount_refunded_cents > 0 then
    raise exception 'academy: this purchase cannot be refunded from here' using errcode = '22023';
  end if;
  if v_p.paid_at is null or v_p.paid_at < now() - interval '14 days' then
    raise exception 'academy: refunds can be requested within 14 days of purchase' using errcode = '22023';
  end if;
  if exists (select 1 from academy_refund_requests where purchase_id = v_p.id and status in ('requested','approved','declined')) then
    raise exception 'academy: a refund was already requested for this purchase' using errcode = '22023';
  end if;
  perform academy_op_begin('sale_refund_request', p_actor);
  insert into academy_refund_requests (purchase_id, learner_id, reason) values (v_p.id, v_p.learner_id, btrim(p_reason)) returning * into v_r;
  perform academy_op_audit('learner', p_actor, 'academy_refund_requests', v_r.id::text, 'refund_request', null,
    jsonb_build_object('purchase_id', v_p.id, 'reason', btrim(p_reason)));
  perform academy_op_end();
  return jsonb_build_object('ok', true, 'request_id', v_r.id);
end $$;

create function public.academy_sale_op_refund_decide(p_actor text, p_request_id uuid, p_decision text, p_reason text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_r academy_refund_requests; v_p academy_purchases;
begin
  perform academy_content_actor_president(p_actor);
  if p_decision not in ('approve','decline') then raise exception 'academy: decide approve or decline' using errcode = '22023'; end if;
  if p_reason is null or length(btrim(p_reason)) < 5 or length(p_reason) > 500 then raise exception 'academy: a reason (5 to 500 characters) is required' using errcode = '22023'; end if;
  select * into v_r from academy_refund_requests where id = p_request_id for update;
  if not found then raise exception 'academy: request not found' using errcode = 'P0002'; end if;
  if v_r.status <> 'requested' then raise exception 'academy: this request was already decided' using errcode = '55000'; end if;
  select * into v_p from academy_purchases where id = v_r.purchase_id;
  perform academy_op_begin('sale_refund_decide', p_actor);
  update academy_refund_requests set status = case when p_decision = 'approve' then 'approved' else 'declined' end,
         decided_by = p_actor, decided_at = now(), decision_reason = btrim(p_reason) where id = v_r.id;
  perform academy_op_audit('staff', p_actor, 'academy_refund_requests', v_r.id::text, 'refund_' || p_decision,
    jsonb_build_object('status', v_r.status), jsonb_build_object('decision', p_decision, 'reason', btrim(p_reason), 'purchase_id', v_p.id));
  perform academy_op_end();
  -- approval does not move money: the President refunds this payment in the Stripe Dashboard
  return jsonb_build_object('ok', true, 'decision', p_decision, 'stripe_payment_intent', case when p_decision = 'approve' then v_p.stripe_payment_intent end,
                            'amount_cents', v_p.amount_cents - v_p.amount_refunded_cents);
end $$;

-- ---------------------------------------------------------------------------------------------
-- PRIVILEGES: M9 operations to the server role only; helpers and triggers to nobody; M8's reason-less price op revoked
-- ---------------------------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_sale\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
    if f.proname like 'academy\_sale\_op\_%' then execute format('grant execute on function %s to service_role', f.sig); end if;
  end loop;
end $$;
revoke all on function public.academy_purchase_op_set_price(text,uuid,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.academy_purchase_dealer_eligible(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- INSTALL CHECKS (every row must read ok = true)
-- ---------------------------------------------------------------------------------------------
select 'M9 tables private (RLS on, no policies, server reads only)' as check,
       (select count(*) from pg_class c where c.relname in ('academy_price_history','academy_refund_requests','academy_buyer_reviews') and c.relnamespace = 'public'::regnamespace
          and c.relrowsecurity and not exists (select 1 from pg_policy where polrelid = c.oid)
          and has_table_privilege('service_role', c.oid, 'select') and not has_table_privilege('service_role', c.oid, 'insert')
          and not has_table_privilege('anon', c.oid, 'select') and not has_table_privilege('authenticated', c.oid, 'select')) = 3 as ok
union all
select 'M9 operations: 4 for the server role, none public; helpers callable by nobody',
       (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_sale\_op\_%'
          and has_function_privilege('service_role', p.oid, 'execute')) = 4
   and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_sale\_%'
          and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')))
   and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_sale\_%' and p.proname not like 'academy\_sale\_op\_%'
          and has_function_privilege('service_role', p.oid, 'execute'))
union all
select 'M8 reason-less price change no longer callable by the server', not has_function_privilege('service_role', 'public.academy_purchase_op_set_price(text,uuid,jsonb)', 'execute')
union all
select 'operations are security definer with a pinned path', bool_and(p.prosecdef and p.proconfig::text like '%search_path=pg_catalog, public, pg_temp%')
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'academy\_sale\_op\_%'
union all
select 'triggers: guards x3, append-only x2, no-truncate x6, price history, refund safety, close requests, buyer check',
       (select count(*) from pg_trigger t where not t.tgisinternal and t.tgname = 'academy_purchase_guard'
          and t.tgrelid in ('public.academy_price_history'::regclass, 'public.academy_refund_requests'::regclass, 'public.academy_buyer_reviews'::regclass)) = 3
   and (select count(*) from pg_trigger where not tgisinternal and tgname = 'academy_sale_append_only') = 2
   and (select count(*) from pg_trigger where not tgisinternal and tgname = 'academy_sale_no_truncate') = 6
   and (select count(*) from pg_trigger where not tgisinternal and tgname in ('academy_sale_price_history','academy_sale_refund_monotonic','academy_sale_close_requests','academy_sale_buyer_check')) = 4
union all
select 'nothing sold, no request or review yet', not exists (select 1 from academy_refund_requests) and not exists (select 1 from academy_buyer_reviews)
   and not exists (select 1 from academy_prices where outside_sale_allowed);

commit;

-- HCPS Academy — Phase 2 / M9: LIVE card payments (Stripe), behind their own switch.
-- docs/academy/P2_M8_PAYMENTS.md is the runbook. Angelo runs this file himself in the Supabase SQL editor
-- (CLAUDE.md §7: financial migrations need his separate approval — given 2026-10-20 10:14 CT). Requires M8.
--
-- What it changes
--   * academy_purchases.livemode may now be true. Its old CHECK (livemode = false) is dropped.
--   * The MODE of every new checkout is decided in the database by one switch: phase2_flags.academy_payments_live
--     (exactly true = live; missing / anything else = sandbox). Turning it off returns to the Stripe sandbox at once.
--     The switch is NOT set by this file.
--   * academy_purchase_op_open stamps the purchase with that mode and never reuses an open checkout of the other mode.
--   * academy_purchase_op_attach accepts only a session of the purchase's own mode (cs_live_… for live, cs_test_… for
--     sandbox) and a live session only while the live switch is on.
--   * academy_purchase_op_stripe_event acts only when the event's mode equals the purchase's mode (a sandbox event can
--     never pay, refund or dispute a live purchase, nor the reverse — outcome 'mode_mismatch'). Refunds and disputes of
--     live purchases are still recorded after the live switch is turned off.
--   * Sales tax (optional, Stripe Tax): academy_purchases gains amount_tax_cents. When Stripe adds tax, the event's
--     amount BEFORE tax (amount_subtotal) must equal the course price and amount_total must equal subtotal + tax; the
--     tax Stripe charged is stored. Without tax, amount_total must equal the price exactly, as in M8.
--   * Security review 2026-10-20: a sandbox (test-card) payment never grants access while the live switch is on; a second
--     payment for a course the buyer already paid for goes to review; the payment id is stored even when a payment goes to
--     review; refunds / disputes that arrive before the payment confirmation are kept and applied when it arrives; a full
--     refund means everything charged (price + tax); a lost dispute withdraws access; a won dispute never restores a
--     refunded purchase; a dispute on a refunded purchase changes nothing.
--   Every other M8 rule is unchanged (signature-verified webhook only, amount/currency/reference match, one event id once,
--   network dealers free, Golden rights, RULE 19). The three functions keep their names, signatures and privileges.
--
-- Security (RULE 19): no new table. The new helper academy_purchase_live_mode() is callable by nobody but the owner.

begin;
set local lock_timeout = '5s';

do $$ begin
  if to_regclass('public.academy_purchases') is null then raise exception 'M9 needs M8 installed first'; end if;
  if coalesce((select (value->'academy_payments_live') = 'true'::jsonb from app_settings where key = 'phase2_flags'), false) then
    raise exception 'turn academy_payments_live off before installing M9 (live payments are switched on only after M9 is verified)';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.academy_purchases'::regclass
                  and pg_get_constraintdef(oid) like '%livemode = false%') then
    raise exception 'M9 is already installed (the sandbox-only check is gone)';
  end if;
  if exists (select 1 from academy_purchases where livemode) then raise exception 'unexpected live purchases before M9'; end if;
end $$;

do $$ declare c text; begin
  for c in select conname from pg_constraint where conrelid = 'public.academy_purchases'::regclass
            and pg_get_constraintdef(oid) like '%livemode = false%' loop
    execute format('alter table public.academy_purchases drop constraint %I', c);
  end loop;
end $$;
alter table public.academy_purchases add column amount_tax_cents int not null default 0 check (amount_tax_cents between 0 and 100000);
-- Every Stripe event keeps its mode and payment id, so a refund or dispute that arrives BEFORE the payment confirmation is
-- applied when the confirmation comes (Stripe does not guarantee event order). detail holds only amount_refunded /
-- dispute_status — never card data.
alter table public.academy_stripe_events add column livemode boolean, add column payment_intent text, add column detail jsonb;
create index academy_stripe_events_pi on public.academy_stripe_events (payment_intent) where payment_intent is not null;
comment on column public.academy_purchases.livemode is
  'true = a real (live Stripe) payment; false = Stripe sandbox. Set when the checkout opens, from phase2_flags.academy_payments_live.';

-- The one switch for real card payments (exactly true = live).
create function public.academy_purchase_live_mode() returns boolean
language sql stable set search_path = pg_catalog, public, pg_temp as $$
  select coalesce((select (value->'academy_payments_live') = 'true'::jsonb from app_settings where key = 'phase2_flags'), false)
$$;
revoke all on function public.academy_purchase_live_mode() from public, anon, authenticated, service_role;

create or replace function public.academy_purchase_op_open(p_email text, p_full_name text, p_company text, p_course_slug text, p_ip_hash text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_email text := lower(btrim(coalesce(p_email, ''))); v_c academy_courses; v_p academy_prices; v_v academy_course_versions;
        v_open academy_purchases; v_new academy_purchases; v_l academy_learners; v_live boolean := academy_purchase_live_mode();
begin
  if p_ip_hash !~ '^[0-9a-f]{64}$' or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(v_email) > 254
     or length(btrim(coalesce(p_full_name, ''))) not between 2 and 120 or length(btrim(coalesce(p_company, ''))) not between 2 and 160 then
    raise exception 'academy: please check your name, company and email' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('academy-buy-ip:' || p_ip_hash));
  perform pg_advisory_xact_lock(hashtext('academy-buy:' || v_email));
  if (select count(*) from academy_purchases where ip_hash = p_ip_hash and created_at > now() - interval '15 minutes') >= 10
     or (select count(*) from academy_purchases where email = v_email and created_at > now() - interval '15 minutes') >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'limited');
  end if;
  select * into v_c from academy_courses where slug = p_course_slug;
  select * into v_p from academy_prices where course_id = v_c.id;
  select * into v_v from academy_course_versions where course_id = v_c.id and status = 'published';
  if v_c.id is null or v_c.status <> 'published' or v_v.id is null or v_p.course_id is null or not v_p.outside_sale_allowed
     or v_p.price_outside_cents is null or (v_c.manufacturer_slug is not null and not v_p.commercial_rights_confirmed)
     or v_c.slug like 'test-%' or v_c.course_type = 'manufacturer_program' then
    return jsonb_build_object('ok', false, 'reason', 'not_for_sale');
  end if;
  if academy_access_is_staff(v_email) then return jsonb_build_object('ok', false, 'reason', 'staff'); end if;
  if v_p.network_included and academy_purchase_email_included(v_email) then
    return jsonb_build_object('ok', false, 'reason', 'included');
  end if;
  select * into v_l from academy_learners where email = v_email;
  if v_l.id is not null and v_l.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  if v_l.id is not null and exists (select 1 from academy_enrollments e join academy_memberships m on m.id = e.membership_id and m.status = 'active'
                                     where e.learner_id = v_l.id and e.version_id = v_v.id and e.status <> 'withdrawn') then
    return jsonb_build_object('ok', false, 'reason', 'already_enrolled');
  end if;
  -- one open checkout per buyer and course: reuse it while it is still valid at today's price
  select * into v_open from academy_purchases where email = v_email and course_id = v_c.id and status = 'open' for update;
  if v_open.id is not null and v_open.livemode = v_live and v_open.amount_cents = v_p.price_outside_cents and v_open.version_id = v_v.id
     and v_open.stripe_checkout_url is not null and v_open.expires_at > now() + interval '5 minutes' then
    return jsonb_build_object('ok', true, 'reuse', true, 'purchase_id', v_open.id, 'url', v_open.stripe_checkout_url, 'livemode', v_open.livemode);
  end if;
  perform academy_op_begin('purchase_open', 'system:checkout');
  if v_open.id is not null then
    update academy_purchases set status = 'superseded', updated_at = now() where id = v_open.id;
  end if;
  insert into academy_purchases (course_id, version_id, email, full_name, company, amount_cents, currency, ip_hash, livemode)
  values (v_c.id, v_v.id, v_email, btrim(p_full_name), btrim(p_company), v_p.price_outside_cents, v_p.currency, p_ip_hash, v_live)
  returning * into v_new;
  perform academy_op_audit('system', 'system:checkout', 'academy_purchases', v_new.id::text, 'open_checkout', null,
    jsonb_build_object('course_id', v_c.id, 'version_id', v_v.id, 'email', v_email, 'amount_cents', v_new.amount_cents, 'livemode', v_live));
  perform academy_op_end();
  return jsonb_build_object('ok', true, 'reuse', false, 'purchase_id', v_new.id, 'amount_cents', v_new.amount_cents,
    'currency', v_new.currency, 'course_title', v_c.title, 'version_id', v_v.id, 'email', v_email, 'livemode', v_live);
end $$;

create or replace function public.academy_purchase_op_attach(p_purchase_id uuid, p_session_id text, p_url text, p_expires_at timestamptz, p_livemode boolean) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v academy_purchases;
begin
  if p_livemode is null then raise exception 'academy: malformed checkout session' using errcode = '22023'; end if;
  if p_livemode and not academy_purchase_live_mode() then raise exception 'academy: live payments are not enabled' using errcode = '42501'; end if;
  if p_session_id !~ (case when p_livemode then '^cs_live_[A-Za-z0-9_]{8,250}$' else '^cs_test_[A-Za-z0-9_]{8,250}$' end)
     or p_url !~ '^https://checkout\.stripe\.com/' or length(p_url) > 2000 then
    raise exception 'academy: malformed checkout session' using errcode = '22023';
  end if;
  select * into v from academy_purchases where id = p_purchase_id for update;
  if not found then raise exception 'academy: purchase not found' using errcode = 'P0002'; end if;
  if v.status <> 'open' or v.stripe_session_id is not null then raise exception 'academy: this checkout is no longer open' using errcode = '55000'; end if;
  if v.livemode is distinct from p_livemode then raise exception 'academy: the checkout mode does not match this purchase' using errcode = '42501'; end if;
  perform academy_op_begin('purchase_attach', 'system:checkout');
  update academy_purchases set stripe_session_id = p_session_id, stripe_checkout_url = p_url, expires_at = p_expires_at, updated_at = now()
   where id = p_purchase_id returning * into v;
  perform academy_op_audit('system', 'system:checkout', 'academy_purchases', v.id::text, 'attach_session', null,
    jsonb_build_object('stripe_session_id', p_session_id, 'expires_at', p_expires_at, 'livemode', p_livemode));
  perform academy_op_end();
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.academy_purchase_op_stripe_event(p_event_id text, p_type text, p_livemode boolean, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_p academy_purchases; v_out text; v_amt bigint; v_ref bigint; v_pi text := nullif(p_data->>'payment_intent', '');
        v_last_dispute academy_stripe_events;
begin
  if p_event_id !~ '^evt_[A-Za-z0-9_]{1,250}$' or p_type !~ '^[a-z_.]{3,80}$' or p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'academy: malformed event' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('academy-stripe-event:' || p_event_id));
  -- Stripe does not promise order: everything about one payment is serialised on its payment id
  if v_pi is not null then perform pg_advisory_xact_lock(hashtext('academy-stripe-pi:' || v_pi)); end if;
  if exists (select 1 from academy_stripe_events where event_id = p_event_id) then
    return jsonb_build_object('ok', true, 'outcome', 'duplicate_event');
  end if;
  perform academy_op_begin('purchase_grant', 'system:stripe');
  if p_livemode is null then
    v_out := 'malformed_mode';
  elsif p_type in ('checkout.session.completed', 'checkout.session.async_payment_succeeded',
                   'checkout.session.async_payment_failed', 'checkout.session.expired') then
    select * into v_p from academy_purchases where stripe_session_id = p_data->>'session_id' for update;
    if v_p.id is null then
      v_out := 'unknown_session';
    elsif v_p.livemode is distinct from p_livemode then
      v_out := 'mode_mismatch';
    elsif p_type = 'checkout.session.expired' then
      if v_p.status = 'open' then update academy_purchases set status = 'expired', updated_at = now() where id = v_p.id returning * into v_p; v_out := 'expired';
      else v_out := 'ignored'; end if;
    elsif p_type = 'checkout.session.async_payment_failed' then
      if v_p.status = 'open' then update academy_purchases set status = 'failed', updated_at = now() where id = v_p.id returning * into v_p; v_out := 'failed';
      else v_out := 'ignored'; end if;
    elsif coalesce(p_data->>'payment_status', '') <> 'paid' then
      v_out := 'awaiting_payment';
    elsif v_p.status in ('paid','refunded','partially_refunded','disputed') then
      v_out := 'already_granted';
    elsif v_p.status not in ('open','superseded','expired') then
      v_out := 'ignored_status_' || v_p.status;
    else
      -- money was taken: the payment id is recorded whatever happens next, so a refund or dispute always finds it
      update academy_purchases set stripe_payment_intent = coalesce(v_pi, stripe_payment_intent), updated_at = now()
       where id = v_p.id returning * into v_p;
      if p_data->>'client_reference_id' is distinct from v_p.id::text
         or coalesce(p_data->>'amount_subtotal', p_data->>'amount_total') is distinct from v_p.amount_cents::text
         or (case when coalesce(p_data->>'amount_tax', '0') !~ '^[0-9]{1,5}$' or coalesce(p_data->>'amount_subtotal', '0') !~ '^[0-9]{1,7}$' then true
                  when coalesce(p_data->>'amount_tax', '0')::int > 100000 then true
                  when (p_data->>'amount_subtotal') is null then coalesce(p_data->>'amount_tax', '0') <> '0'
                  else (p_data->>'amount_total') is distinct from ((p_data->>'amount_subtotal')::bigint + coalesce((p_data->>'amount_tax')::bigint, 0))::text end)
         or lower(coalesce(p_data->>'currency', '')) is distinct from v_p.currency then
        update academy_purchases set status = 'review', review_reason = 'amount, currency or reference did not match the checkout', updated_at = now()
         where id = v_p.id returning * into v_p;
        v_out := 'review';
      elsif not p_livemode and academy_purchase_live_mode() then
        -- a test-card payment must never enroll anyone once real payments are on
        update academy_purchases set status = 'review', review_reason = 'sandbox (test-card) payment while live payments are on - no access given', updated_at = now()
         where id = v_p.id returning * into v_p;
        v_out := 'review';
      elsif exists (select 1 from academy_purchases o where o.email = v_p.email and o.course_id = v_p.course_id and o.id <> v_p.id
                     and o.livemode = v_p.livemode and o.status in ('paid','partially_refunded','disputed')) then
        update academy_purchases set status = 'review', review_reason = 'second payment for a course this buyer already paid for - refund one', updated_at = now()
         where id = v_p.id returning * into v_p;
        v_out := 'review';
      else
        -- paid (a superseded or expired checkout that the buyer had already paid is honoured at the price they paid)
        update academy_purchases set amount_tax_cents = coalesce((p_data->>'amount_tax')::int, 0) where id = v_p.id returning * into v_p;
        v_p := academy_purchase_grant(v_p);
        v_out := case when v_p.status = 'paid' then 'granted' else v_p.status end;
        -- a refund or dispute that reached HCPS before this payment confirmation is applied now
        if v_p.status = 'paid' and v_pi is not null then
          select coalesce(max((e.detail->>'amount_refunded')::bigint), 0) into v_ref from academy_stripe_events e
           where e.payment_intent = v_pi and e.type = 'charge.refunded' and e.livemode = p_livemode and (e.detail->>'amount_refunded') ~ '^[0-9]{1,9}$';
          select * into v_last_dispute from academy_stripe_events e
           where e.payment_intent = v_pi and e.type in ('charge.dispute.created','charge.dispute.closed') and e.livemode = p_livemode
           order by e.received_at desc, e.event_id desc limit 1;
          v_amt := v_p.amount_cents + v_p.amount_tax_cents;
          if v_ref >= v_amt or (v_last_dispute.type = 'charge.dispute.closed' and v_last_dispute.detail->>'dispute_status' = 'lost') then
            update academy_purchases set status = 'refunded', amount_refunded_cents = greatest(v_ref, amount_refunded_cents), refunded_at = now(), updated_at = now()
             where id = v_p.id returning * into v_p;
            perform academy_purchase_withdraw(v_p, 'refunded before the payment confirmation arrived');
            v_out := 'granted_then_refunded';
          elsif v_last_dispute.type = 'charge.dispute.created' then
            update academy_purchases set status = 'disputed', amount_refunded_cents = v_ref, updated_at = now() where id = v_p.id returning * into v_p;
            perform academy_purchase_withdraw(v_p, 'disputed before the payment confirmation arrived');
            v_out := 'granted_then_disputed';
          elsif v_ref > 0 then
            update academy_purchases set status = 'partially_refunded', amount_refunded_cents = v_ref, updated_at = now() where id = v_p.id returning * into v_p;
            v_out := 'granted_then_partially_refunded';
          end if;
        end if;
      end if;
    end if;
  elsif p_type in ('charge.refunded', 'charge.dispute.created', 'charge.dispute.closed') then
    select * into v_p from academy_purchases where stripe_payment_intent = v_pi for update;
    if v_p.id is null then
      v_out := 'unknown_payment';         -- kept with its payment id: applied if that payment's confirmation arrives later
    elsif v_p.livemode is distinct from p_livemode then
      v_out := 'mode_mismatch';
    elsif v_p.status in ('review') then
      v_out := 'recorded_for_review';     -- no access was given; the owner settles it in Stripe
    elsif p_type = 'charge.refunded' then
      v_ref := case when coalesce(p_data->>'amount_refunded', '') ~ '^[0-9]{1,9}$' then (p_data->>'amount_refunded')::bigint else 0 end;
      v_amt := v_p.amount_cents + v_p.amount_tax_cents;      -- full refund = everything charged, tax included
      if v_ref >= v_amt then
        update academy_purchases set status = 'refunded', amount_refunded_cents = v_ref, refunded_at = now(), updated_at = now() where id = v_p.id returning * into v_p;
        perform academy_purchase_withdraw(v_p, 'refunded');
        v_out := 'refunded';
      else
        update academy_purchases set status = case when status = 'paid' then 'partially_refunded' else status end, amount_refunded_cents = v_ref, updated_at = now()
         where id = v_p.id returning * into v_p;
        v_out := 'partially_refunded';
      end if;
    elsif p_type = 'charge.dispute.created' then
      if v_p.status = 'refunded' then
        v_out := 'dispute_after_refund';  -- access was already withdrawn; nothing to change
      else
        update academy_purchases set status = 'disputed', updated_at = now() where id = v_p.id returning * into v_p;
        perform academy_purchase_withdraw(v_p, 'disputed');
        v_out := 'disputed';
      end if;
    else
      if p_data->>'dispute_status' = 'won' then
        if v_p.status = 'disputed' and v_p.amount_refunded_cents < v_p.amount_cents + v_p.amount_tax_cents then
          update academy_purchases set status = case when amount_refunded_cents > 0 then 'partially_refunded' else 'paid' end, updated_at = now()
           where id = v_p.id returning * into v_p;
          perform academy_purchase_restore(v_p);
          v_out := 'dispute_won';
        else
          v_out := 'ignored';
        end if;
      elsif p_data->>'dispute_status' = 'lost' then
        update academy_purchases set status = 'refunded', refunded_at = coalesce(refunded_at, now()), updated_at = now() where id = v_p.id returning * into v_p;
        perform academy_purchase_withdraw(v_p, 'dispute lost');
        v_out := 'dispute_lost';
      else
        v_out := 'dispute_' || coalesce(p_data->>'dispute_status', 'unknown');
      end if;
    end if;
  else
    v_out := 'ignored';
  end if;
  insert into academy_stripe_events (event_id, type, outcome, purchase_id, livemode, payment_intent, detail)
  values (p_event_id, p_type, v_out, v_p.id, p_livemode, v_pi,
          case when p_type like 'charge.%' then jsonb_strip_nulls(jsonb_build_object('amount_refunded', p_data->>'amount_refunded', 'dispute_status', p_data->>'dispute_status')) end);
  perform academy_op_audit('system', 'system:stripe', 'academy_purchases', coalesce(v_p.id::text, p_event_id), 'stripe_event',
    null, jsonb_build_object('event_id', p_event_id, 'type', p_type, 'livemode', p_livemode, 'outcome', v_out, 'status', v_p.status));
  perform academy_op_end();
  return jsonb_build_object('ok', true, 'outcome', v_out, 'purchase_id', v_p.id);
end $$;

-- Privileges are kept by CREATE OR REPLACE; re-assert them.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('academy_purchase_op_open','academy_purchase_op_attach','academy_purchase_op_stripe_event')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- INSTALL CHECKS (every row must read ok = true)
-- ---------------------------------------------------------------------------------------------
select 'sandbox-only check removed; live purchases allowed by the table' as check,
       not exists (select 1 from pg_constraint where conrelid = 'public.academy_purchases'::regclass and pg_get_constraintdef(oid) like '%livemode = false%') as ok
union all
select 'live switch not set by this file (still sandbox)', not academy_purchase_live_mode()
union all
select 'operations still executable by service_role only',
       not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'academy\_purchase\_%'
                    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')))
   and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'academy\_purchase\_op\_%'
          and has_function_privilege('service_role', p.oid, 'execute')) = 7
   and not has_function_privilege('service_role', 'public.academy_purchase_live_mode()', 'execute')
union all
select 'tables still private', (select count(*) from pg_class c where c.relname in ('academy_organizations','academy_prices','academy_dealer_eligibility','academy_purchases','academy_stripe_events')
          and c.relrowsecurity and not has_table_privilege('anon', c.oid, 'select') and not has_table_privilege('authenticated', c.oid, 'select')
          and not has_table_privilege('service_role', c.oid, 'insert')) = 5;

commit;

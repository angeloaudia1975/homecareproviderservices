-- HCPS Academy — Phase 2 / M9 ROLLBACK: back to sandbox-only payments (the M8 functions and the livemode = false check).
-- Refuses while any live purchase exists: real payment records are never dropped or rewritten by a rollback.
-- To stop live payments without a rollback: set phase2_flags.academy_payments_live to false (no deploy needed).
begin;
do $$ begin
  if exists (select 1 from pg_constraint where conrelid = 'public.academy_purchases'::regclass and pg_get_constraintdef(oid) like '%livemode = false%') then
    raise exception 'M9 is not installed';
  end if;
  if exists (select 1 from academy_purchases where livemode) then raise exception 'M9 rollback refused: live purchases exist'; end if;
  if exists (select 1 from academy_purchases where amount_tax_cents <> 0) then raise exception 'M9 rollback refused: purchases with recorded sales tax exist'; end if;
end $$;
create or replace function public.academy_purchase_op_open(p_email text, p_full_name text, p_company text, p_course_slug text, p_ip_hash text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_email text := lower(btrim(coalesce(p_email, ''))); v_c academy_courses; v_p academy_prices; v_v academy_course_versions;
        v_open academy_purchases; v_new academy_purchases; v_l academy_learners;
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
  if v_open.id is not null and v_open.amount_cents = v_p.price_outside_cents and v_open.version_id = v_v.id
     and v_open.stripe_checkout_url is not null and v_open.expires_at > now() + interval '5 minutes' then
    return jsonb_build_object('ok', true, 'reuse', true, 'purchase_id', v_open.id, 'url', v_open.stripe_checkout_url);
  end if;
  perform academy_op_begin('purchase_open', 'system:checkout');
  if v_open.id is not null then
    update academy_purchases set status = 'superseded', updated_at = now() where id = v_open.id;
  end if;
  insert into academy_purchases (course_id, version_id, email, full_name, company, amount_cents, currency, ip_hash)
  values (v_c.id, v_v.id, v_email, btrim(p_full_name), btrim(p_company), v_p.price_outside_cents, v_p.currency, p_ip_hash)
  returning * into v_new;
  perform academy_op_audit('system', 'system:checkout', 'academy_purchases', v_new.id::text, 'open_checkout', null,
    jsonb_build_object('course_id', v_c.id, 'version_id', v_v.id, 'email', v_email, 'amount_cents', v_new.amount_cents));
  perform academy_op_end();
  return jsonb_build_object('ok', true, 'reuse', false, 'purchase_id', v_new.id, 'amount_cents', v_new.amount_cents,
    'currency', v_new.currency, 'course_title', v_c.title, 'version_id', v_v.id, 'email', v_email);
end $$;

create or replace function public.academy_purchase_op_attach(p_purchase_id uuid, p_session_id text, p_url text, p_expires_at timestamptz, p_livemode boolean) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v academy_purchases;
begin
  if p_livemode is distinct from false then raise exception 'academy: live payments are not enabled' using errcode = '42501'; end if;
  if p_session_id !~ '^cs_test_[A-Za-z0-9_]{8,250}$' or p_url !~ '^https://checkout\.stripe\.com/' or length(p_url) > 2000 then
    raise exception 'academy: malformed checkout session' using errcode = '22023';
  end if;
  select * into v from academy_purchases where id = p_purchase_id for update;
  if not found then raise exception 'academy: purchase not found' using errcode = 'P0002'; end if;
  if v.status <> 'open' or v.stripe_session_id is not null then raise exception 'academy: this checkout is no longer open' using errcode = '55000'; end if;
  perform academy_op_begin('purchase_attach', 'system:checkout');
  update academy_purchases set stripe_session_id = p_session_id, stripe_checkout_url = p_url, expires_at = p_expires_at, updated_at = now()
   where id = p_purchase_id returning * into v;
  perform academy_op_audit('system', 'system:checkout', 'academy_purchases', v.id::text, 'attach_session', null,
    jsonb_build_object('stripe_session_id', p_session_id, 'expires_at', p_expires_at));
  perform academy_op_end();
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.academy_purchase_op_stripe_event(p_event_id text, p_type text, p_livemode boolean, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_p academy_purchases; v_out text; v_before jsonb; v_amt bigint; v_ref bigint;
begin
  if p_event_id !~ '^evt_[A-Za-z0-9_]{1,250}$' or p_type !~ '^[a-z_.]{3,80}$' or p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'academy: malformed event' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('academy-stripe-event:' || p_event_id));
  if exists (select 1 from academy_stripe_events where event_id = p_event_id) then
    return jsonb_build_object('ok', true, 'outcome', 'duplicate_event');
  end if;
  perform academy_op_begin('purchase_grant', 'system:stripe');
  if p_livemode is distinct from false then
    v_out := 'live_mode_refused';
  elsif p_type in ('checkout.session.completed', 'checkout.session.async_payment_succeeded',
                   'checkout.session.async_payment_failed', 'checkout.session.expired') then
    select * into v_p from academy_purchases where stripe_session_id = p_data->>'session_id' for update;
    if v_p.id is null then
      v_out := 'unknown_session';
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
    elsif p_data->>'client_reference_id' is distinct from v_p.id::text
       or (p_data->>'amount_total') is distinct from v_p.amount_cents::text
       or lower(coalesce(p_data->>'currency', '')) is distinct from v_p.currency then
      update academy_purchases set status = 'review', review_reason = 'amount, currency or reference did not match the checkout', updated_at = now()
       where id = v_p.id returning * into v_p;
      v_out := 'review';
    else
      -- paid (a superseded or expired checkout that the buyer had already paid is honoured at the price they paid)
      update academy_purchases set stripe_payment_intent = nullif(p_data->>'payment_intent', '') where id = v_p.id returning * into v_p;
      v_p := academy_purchase_grant(v_p);
      v_out := case when v_p.status = 'paid' then 'granted' else v_p.status end;
    end if;
  elsif p_type in ('charge.refunded', 'charge.dispute.created', 'charge.dispute.closed') then
    select * into v_p from academy_purchases where stripe_payment_intent = p_data->>'payment_intent' for update;
    if v_p.id is null then
      v_out := 'unknown_payment';
    elsif p_type = 'charge.refunded' then
      v_ref := coalesce((p_data->>'amount_refunded')::bigint, 0); v_amt := v_p.amount_cents;
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
      update academy_purchases set status = 'disputed', updated_at = now() where id = v_p.id returning * into v_p;
      perform academy_purchase_withdraw(v_p, 'disputed');
      v_out := 'disputed';
    else
      if p_data->>'dispute_status' = 'won' then
        if v_p.status = 'disputed' then
          update academy_purchases set status = 'paid', updated_at = now() where id = v_p.id returning * into v_p;
          perform academy_purchase_restore(v_p);
          v_out := 'dispute_won';
        else
          v_out := 'ignored';
        end if;
      elsif p_data->>'dispute_status' = 'lost' then
        update academy_purchases set status = 'refunded', refunded_at = now(), updated_at = now() where id = v_p.id returning * into v_p;
        v_out := 'dispute_lost';
      else
        v_out := 'dispute_' || coalesce(p_data->>'dispute_status', 'unknown');
      end if;
    end if;
  else
    v_out := 'ignored';
  end if;
  insert into academy_stripe_events (event_id, type, outcome, purchase_id) values (p_event_id, p_type, v_out, v_p.id);
  perform academy_op_audit('system', 'system:stripe', 'academy_purchases', coalesce(v_p.id::text, p_event_id), 'stripe_event',
    null, jsonb_build_object('event_id', p_event_id, 'type', p_type, 'outcome', v_out, 'status', v_p.status));
  perform academy_op_end();
  return jsonb_build_object('ok', true, 'outcome', v_out, 'purchase_id', v_p.id);
end $$;

drop function public.academy_purchase_live_mode();
alter table public.academy_purchases drop column amount_tax_cents;
drop index public.academy_stripe_events_pi;
alter table public.academy_stripe_events drop column livemode, drop column payment_intent, drop column detail;
alter table public.academy_purchases add constraint academy_purchases_livemode_check check (livemode = false);
select 'M9 removed (sandbox only again)' as result,
       exists (select 1 from pg_constraint where conrelid = 'public.academy_purchases'::regclass and pg_get_constraintdef(oid) like '%livemode = false%') as ok;
commit;

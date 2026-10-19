-- HCPS Academy — Phase 2 / M8: paid course access (Stripe Checkout, SANDBOX ONLY)
-- docs/academy/P2_M8_PAYMENTS.md is the runbook. Angelo runs this file himself in the Supabase SQL editor
-- (CLAUDE.md §7: financial migrations need his separate approval). Requires A1 and M1–M7.
--
-- What it adds
--   * Eligibility: an HCPS network dealer (dealers.status = 'active', account_class blank or 'dealer', judged on the head
--     office for a branch; TEST dealers are always included and never billed) learns FREE. The President can override one
--     dealership (academy_dealer_eligibility, audited).
--   * Pricing: one academy_prices row per course — outside-dealer price, "included for HCPS dealers", outside sale on/off
--     and a commercial-rights confirmation. A manufacturer course (manufacturer_slug set, e.g. Golden) can NEVER be put on
--     sale to outside dealerships until the President records that the manufacturer confirmed commercial use.
--   * Outside dealerships: academy_organizations. They are NOT added to the CRM dealers table; their people get an
--     Academy membership with organization_id instead of dealer_id (exactly one is set), role learner only. Dealer 360,
--     reps' books, Training Manager scope (dealer families) and analytics never see them, and they never see a dealer.
--   * Purchases: academy_purchases (one row per checkout), academy_stripe_events (every Stripe event id once).
--     Access is granted ONLY by a signature-verified Stripe webhook (checked in netlify/functions/academy-stripe-webhook.js),
--     through academy_purchase_op_stripe_event: amount, currency, purchase id and session id must all match; a replayed or
--     duplicated event grants nothing twice. Refund (full) or dispute withdraws the enrollment unless the course was
--     already completed (an earned certificate stays — Phase 2 proposal, decision 3 recommendation); a won dispute restores it.
--   * SANDBOX ONLY: academy_purchases.livemode must be false (check constraint) and live-mode events are refused. Taking
--     real payments needs a reviewed follow-up migration and Angelo's approval.
--
-- Security (RULE 19): every new table has RLS on, no policies, and no rights for public / anon / authenticated; the
-- server role can only SELECT them. Every write is a SECURITY DEFINER academy_purchase_op_* function, executable only
-- by service_role, making its change and its academy_events audit row in one transaction (or neither).
-- Existing M1–M7 functions are NOT replaced (their postcheck fingerprints are unchanged).

begin;

do $$ begin
  if to_regprocedure('public.academy_cert_op_claim(text,uuid)') is null
     or to_regprocedure('public.academy_enroll_op_enroll(text,uuid,uuid,date)') is null
     or to_regprocedure('public.academy_content_actor_president(text)') is null then
    raise exception 'M8 needs A1 and M1–M7 installed first';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'dealers' and column_name = 'status')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'dealers' and column_name = 'account_class')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'dealers' and column_name = 'is_test') then
    raise exception 'M8 needs dealers.status, dealers.account_class and dealers.is_test';
  end if;
  if to_regclass('public.academy_purchases') is not null then
    raise exception 'M8 is already installed';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- SCHEMA
-- ---------------------------------------------------------------------------------------------
create table public.academy_organizations (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (length(btrim(name)) between 2 and 160),
  contact_email  text not null check (contact_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' and length(contact_email) <= 254),
  status         text not null default 'active' check (status in ('active','closed')),
  created_at     timestamptz not null default now(),
  created_by     text not null
);
create index academy_organizations_contact on public.academy_organizations (contact_email, lower(name));
comment on table public.academy_organizations is
  'Outside (non-HCPS-network) dealerships that bought Academy access. Never part of the CRM dealers table.';

alter table public.academy_memberships alter column dealer_id drop not null;
alter table public.academy_memberships add column organization_id uuid references public.academy_organizations(id) on delete restrict;
alter table public.academy_memberships add constraint academy_memberships_one_owner
  check (num_nonnulls(dealer_id, organization_id) = 1);
alter table public.academy_memberships add constraint academy_memberships_org_learner_only
  check (organization_id is null or (role = 'learner' and access_type = 'training_only'));
create unique index academy_memberships_one_active_org
  on public.academy_memberships (learner_id, organization_id) where status = 'active' and organization_id is not null;

alter table public.academy_enrollments drop constraint academy_enrollments_access_source_check;
alter table public.academy_enrollments add constraint academy_enrollments_access_source_check
  check (access_source in ('assigned','self','admin_grant','purchase'));

create table public.academy_prices (
  course_id                    uuid primary key references public.academy_courses(id) on delete restrict,
  price_outside_cents          int check (price_outside_cents is null or price_outside_cents between 99 and 100000),
  currency                     text not null default 'usd' check (currency = 'usd'),
  network_included             boolean not null default true,
  outside_sale_allowed         boolean not null default false,
  commercial_rights_confirmed  boolean not null default false,
  rights_note                  text check (rights_note is null or length(rights_note) <= 500),
  updated_at                   timestamptz not null default now(),
  updated_by                   text not null,
  check (not outside_sale_allowed or price_outside_cents is not null)
);
comment on table public.academy_prices is
  'Commercial settings per course (not part of the frozen published content). Written only by academy_purchase_op_set_price.';

create table public.academy_dealer_eligibility (
  dealer_id  uuid primary key references public.dealers(id) on delete restrict,
  eligible   boolean not null,
  reason     text not null check (length(btrim(reason)) between 5 and 500),
  set_by     text not null,
  set_at     timestamptz not null default now()
);

create table public.academy_purchases (
  id                      uuid primary key default gen_random_uuid(),
  course_id               uuid not null references public.academy_courses(id) on delete restrict,
  version_id              uuid not null references public.academy_course_versions(id) on delete restrict,
  email                   text not null check (email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' and length(email) <= 254),
  full_name               text not null check (length(btrim(full_name)) between 2 and 120),
  company                 text not null check (length(btrim(company)) between 2 and 160),
  amount_cents            int not null check (amount_cents between 99 and 100000),
  currency                text not null check (currency = 'usd'),
  status                  text not null default 'open'
                          check (status in ('open','paid','failed','expired','superseded','refunded','partially_refunded','disputed','review')),
  livemode                boolean not null default false check (livemode = false),     -- SANDBOX ONLY (see header)
  stripe_session_id       text unique,
  stripe_checkout_url     text,
  stripe_payment_intent   text,
  amount_refunded_cents   int not null default 0,
  organization_id         uuid references public.academy_organizations(id),
  learner_id              uuid references public.academy_learners(id),
  enrollment_id           uuid references public.academy_enrollments(id),
  review_reason           text,
  ip_hash                 text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  created_at              timestamptz not null default now(),
  expires_at              timestamptz,
  paid_at                 timestamptz,
  refunded_at             timestamptz,
  updated_at              timestamptz not null default now()
);
create unique index academy_purchases_one_open on public.academy_purchases (email, course_id) where status = 'open';
create unique index academy_purchases_intent on public.academy_purchases (stripe_payment_intent) where stripe_payment_intent is not null;
create index academy_purchases_ip on public.academy_purchases (ip_hash, created_at);

create table public.academy_stripe_events (
  event_id     text primary key check (event_id ~ '^evt_[A-Za-z0-9_]{1,250}$'),
  type         text not null,
  outcome      text not null,
  purchase_id  uuid references public.academy_purchases(id),
  received_at  timestamptz not null default now()
);

-- RULE 19: private. RLS on with no policies; nothing for public / anon / authenticated; the server role reads only.
do $$ declare t text; begin
  foreach t in array array['academy_organizations','academy_prices','academy_dealer_eligibility','academy_purchases','academy_stripe_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on table public.%I to service_role', t);
  end loop;
end $$;

-- The audited guard (M1) also covers the new tables: a change outside an audited operation is refused.
create function public.academy_purchase_guard() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if coalesce(current_setting('academy.op', true), '') <> '' and current_user = (select pg_get_userbyid(p.proowner) from pg_proc p
       where p.oid = 'public.academy_purchase_guard()'::regprocedure) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'academy: this change to % must go through its audited operation', tg_table_name using errcode = '42501';
end $$;
do $$ declare t text; begin
  foreach t in array array['academy_organizations','academy_prices','academy_dealer_eligibility','academy_purchases','academy_stripe_events'] loop
    execute format('create trigger academy_purchase_guard before insert or update or delete on public.%I for each row execute function public.academy_purchase_guard()', t);
  end loop;
end $$;
-- The manufacturer-rights rule holds on EVERY path (the owner included): a course with a manufacturer (e.g. Golden) is
-- never on sale to outside dealerships unless the manufacturer's commercial use is recorded as confirmed.
create function public.academy_prices_rights_check() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.outside_sale_allowed and not new.commercial_rights_confirmed
     and exists (select 1 from academy_courses c where c.id = new.course_id and c.manufacturer_slug is not null) then
    raise exception 'academy: a manufacturer course cannot be sold to outside dealerships until commercial use is confirmed' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger academy_prices_rights_check before insert or update on public.academy_prices
  for each row execute function public.academy_prices_rights_check();

-- An organization membership is only ever created by a verified purchase.
create function public.academy_purchase_member_guard() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.organization_id is not null and (tg_op = 'INSERT' or new.organization_id is distinct from old.organization_id)
     and coalesce(current_setting('academy.op', true), '') not in ('purchase_grant') then
    raise exception 'academy: an outside organization''s access comes only from a verified purchase' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger academy_purchase_member_guard before insert or update on public.academy_memberships
  for each row execute function public.academy_purchase_member_guard();

-- ---------------------------------------------------------------------------------------------
-- ELIGIBILITY (free for the HCPS network)
-- ---------------------------------------------------------------------------------------------
create function public.academy_purchase_dealer_eligible(p_dealer uuid) returns boolean
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

-- Is this address already covered free (an active learner at an eligible dealership, or an approved Partner 360 user)?
create function public.academy_purchase_email_included(p_email text) returns boolean
language sql stable set search_path = pg_catalog, public, pg_temp as $$
  select exists (select 1 from academy_learners l join academy_memberships m on m.learner_id = l.id and m.status = 'active'
                  where l.email = lower(btrim(p_email)) and l.status = 'active' and m.dealer_id is not null
                    and academy_purchase_dealer_eligible(m.dealer_id))
      or exists (select 1 from dealer_users du where lower(du.email) = lower(btrim(p_email)) and du.status = 'approved'
                  and du.dealer_id is not null and academy_purchase_dealer_eligible(du.dealer_id))
$$;

-- What the public may see: courses on sale to outside dealerships, with their current published version and price.
create function public.academy_purchase_op_catalog() returns jsonb
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('slug', c.slug, 'title', c.title, 'price_cents', p.price_outside_cents,
                                               'currency', p.currency) order by c.title), '[]'::jsonb)
    from academy_courses c join academy_prices p on p.course_id = c.id
   where c.status = 'published' and p.outside_sale_allowed and p.price_outside_cents is not null
     and (c.manufacturer_slug is null or p.commercial_rights_confirmed) and c.slug not like 'test-%'
     and c.course_type <> 'manufacturer_program'
     and exists (select 1 from academy_course_versions v where v.course_id = c.id and v.status = 'published')
$$;

-- ---------------------------------------------------------------------------------------------
-- PRESIDENT: prices and eligibility overrides
-- ---------------------------------------------------------------------------------------------
create function public.academy_purchase_op_set_price(p_actor text, p_course_id uuid, p_spec jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_c academy_courses; v_old academy_prices; v_new academy_prices; v_cents int; v_sale boolean; v_rights boolean;
begin
  perform academy_content_actor_president(p_actor);
  if p_spec is null or jsonb_typeof(p_spec) <> 'object' then raise exception 'academy: malformed request' using errcode = '22023'; end if;
  select * into v_c from academy_courses where id = p_course_id;
  if not found then raise exception 'academy: course not found' using errcode = 'P0002'; end if;
  select * into v_old from academy_prices where course_id = p_course_id for update;
  v_cents := case when p_spec ? 'price_outside_cents' then
               case when jsonb_typeof(p_spec->'price_outside_cents') = 'null' then null
                    when jsonb_typeof(p_spec->'price_outside_cents') = 'number' then (p_spec->>'price_outside_cents')::numeric::int
                    else -1 end
             else v_old.price_outside_cents end;
  if v_cents is not null and (v_cents < 99 or v_cents > 100000) then
    raise exception 'academy: the price must be from $0.99 to $1,000.00' using errcode = '22023';
  end if;
  v_rights := coalesce((p_spec->>'commercial_rights_confirmed')::boolean, v_old.commercial_rights_confirmed, false);
  v_sale := coalesce((p_spec->>'outside_sale_allowed')::boolean, v_old.outside_sale_allowed, false);
  if v_sale and v_cents is null then raise exception 'academy: set a price before selling to outside dealerships' using errcode = '22023'; end if;
  if v_sale and v_c.manufacturer_slug is not null and not v_rights then
    raise exception 'academy: a % course cannot be sold to outside dealerships until the manufacturer has confirmed commercial use', v_c.manufacturer_slug
      using errcode = '22023';
  end if;
  if v_sale and v_c.course_type = 'manufacturer_program' then
    raise exception 'academy: a manufacturer program is not sold here' using errcode = '22023';
  end if;
  perform academy_op_begin('purchase_set_price', p_actor);
  insert into academy_prices (course_id, price_outside_cents, network_included, outside_sale_allowed, commercial_rights_confirmed, rights_note, updated_at, updated_by)
  values (p_course_id, v_cents, coalesce((p_spec->>'network_included')::boolean, v_old.network_included, true), v_sale, v_rights,
          case when p_spec ? 'rights_note' then nullif(btrim(p_spec->>'rights_note'), '') else v_old.rights_note end, now(), p_actor)
  on conflict (course_id) do update set price_outside_cents = excluded.price_outside_cents, network_included = excluded.network_included,
    outside_sale_allowed = excluded.outside_sale_allowed, commercial_rights_confirmed = excluded.commercial_rights_confirmed,
    rights_note = excluded.rights_note, updated_at = now(), updated_by = p_actor
  returning * into v_new;
  -- a checkout already opened at the old price is never completed at it: it is superseded (the buyer simply starts again)
  if v_old.course_id is not null and v_old.price_outside_cents is distinct from v_new.price_outside_cents or not v_new.outside_sale_allowed then
    update academy_purchases set status = 'superseded', updated_at = now() where course_id = p_course_id and status = 'open';
  end if;
  perform academy_op_audit('staff', p_actor, 'academy_prices', p_course_id::text, 'set_price', to_jsonb(v_old), to_jsonb(v_new));
  perform academy_op_end();
  return to_jsonb(v_new);
end $$;

create function public.academy_purchase_op_set_eligibility(p_actor text, p_dealer_id uuid, p_eligible boolean, p_reason text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_old academy_dealer_eligibility; v_new academy_dealer_eligibility;
begin
  perform academy_content_actor_president(p_actor);
  if not exists (select 1 from dealers where id = p_dealer_id) then raise exception 'academy: dealership not found' using errcode = 'P0002'; end if;
  if p_reason is null or length(btrim(p_reason)) < 5 or length(p_reason) > 500 then
    raise exception 'academy: a reason (5 to 500 characters) is required' using errcode = '22023';
  end if;
  perform academy_op_begin('purchase_set_eligibility', p_actor);
  select * into v_old from academy_dealer_eligibility where dealer_id = p_dealer_id for update;
  if p_eligible is null then
    delete from academy_dealer_eligibility where dealer_id = p_dealer_id;
  else
    insert into academy_dealer_eligibility (dealer_id, eligible, reason, set_by) values (p_dealer_id, p_eligible, btrim(p_reason), p_actor)
    on conflict (dealer_id) do update set eligible = excluded.eligible, reason = excluded.reason, set_by = excluded.set_by, set_at = now()
    returning * into v_new;
  end if;
  perform academy_op_audit('staff', p_actor, 'academy_dealer_eligibility', p_dealer_id::text, 'set_eligibility',
    to_jsonb(v_old), coalesce(to_jsonb(v_new), jsonb_build_object('override', null, 'reason', btrim(p_reason))));
  perform academy_op_end();
  return jsonb_build_object('dealer_id', p_dealer_id, 'eligible_now', academy_purchase_dealer_eligible(p_dealer_id), 'override', p_eligible);
end $$;

-- ---------------------------------------------------------------------------------------------
-- CHECKOUT (public, before payment) — never grants access
-- ---------------------------------------------------------------------------------------------
create function public.academy_purchase_op_open(p_email text, p_full_name text, p_company text, p_course_slug text, p_ip_hash text) returns jsonb
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

-- The Stripe Checkout Session created for an open purchase (test mode only).
create function public.academy_purchase_op_attach(p_purchase_id uuid, p_session_id text, p_url text, p_expires_at timestamptz, p_livemode boolean) returns jsonb
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

-- Stripe refused to create the session: the purchase is closed so the buyer can start again.
create function public.academy_purchase_op_abandon(p_purchase_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform academy_op_begin('purchase_abandon', 'system:checkout');
  update academy_purchases set status = 'failed', review_reason = left(coalesce(p_reason, 'checkout not created'), 200), updated_at = now()
   where id = p_purchase_id and status = 'open' and stripe_session_id is null;
  if found then
    perform academy_op_audit('system', 'system:checkout', 'academy_purchases', p_purchase_id::text, 'abandon', null,
      jsonb_build_object('reason', left(coalesce(p_reason, ''), 200)));
  end if;
  perform academy_op_end();
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------------------------
-- STRIPE EVENTS (only after the webhook verified the Stripe signature)
-- ---------------------------------------------------------------------------------------------
-- Internal: access for a paid purchase. Learner (by email), outside organization, membership, enrollment.
create function public.academy_purchase_grant(v_p academy_purchases) returns academy_purchases
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare v_l academy_learners; v_o academy_organizations; v_m academy_memberships; v_e academy_enrollments; v_out academy_purchases;
begin
  if academy_access_is_staff(v_p.email) then
    update academy_purchases set status = 'review', review_reason = 'buyer email belongs to HCPS staff', updated_at = now()
     where id = v_p.id returning * into v_out; return v_out;
  end if;
  select * into v_l from academy_learners where email = v_p.email for update;
  if v_l.id is not null and v_l.status <> 'active' then
    update academy_purchases set status = 'review', review_reason = 'learner account is not active', updated_at = now()
     where id = v_p.id returning * into v_out; return v_out;
  end if;
  if v_l.id is null then
    insert into academy_learners (full_name, email) values (v_p.full_name, v_p.email) returning * into v_l;
    perform academy_op_audit('system', 'system:stripe', 'academy_learners', v_l.id::text, 'create_learner', null, to_jsonb(v_l));
  end if;
  select * into v_o from academy_organizations where contact_email = v_p.email and lower(name) = lower(v_p.company) and status = 'active'
   order by created_at limit 1;
  if v_o.id is null then
    insert into academy_organizations (name, contact_email, created_by) values (v_p.company, v_p.email, 'system:stripe') returning * into v_o;
    perform academy_op_audit('system', 'system:stripe', 'academy_organizations', v_o.id::text, 'create_organization', null, to_jsonb(v_o));
  end if;
  select * into v_m from academy_memberships where learner_id = v_l.id and organization_id = v_o.id and status = 'active';
  if v_m.id is null then
    insert into academy_memberships (learner_id, organization_id, role, access_type, created_by)
    values (v_l.id, v_o.id, 'learner', 'training_only', 'system:stripe') returning * into v_m;
    perform academy_op_audit('system', 'system:stripe', 'academy_memberships', v_m.id::text, 'purchase_access', null, to_jsonb(v_m));
  end if;
  select * into v_e from academy_enrollments where learner_id = v_l.id and version_id = v_p.version_id for update;
  if v_e.id is null then
    insert into academy_enrollments (learner_id, version_id, membership_id, access_source, assigned_by)
    values (v_l.id, v_p.version_id, v_m.id, 'purchase', 'system:stripe') returning * into v_e;
    perform academy_op_audit('system', 'system:stripe', 'academy_enrollments', v_e.id::text, 'enroll', null, to_jsonb(v_e));
  elsif v_e.status = 'withdrawn' then
    update academy_enrollments set status = case when exists (select 1 from academy_progress p where p.enrollment_id = v_e.id) then 'in_progress' else 'not_started' end,
           membership_id = v_m.id, assigned_by = 'system:stripe' where id = v_e.id returning * into v_e;
    perform academy_op_audit('system', 'system:stripe', 'academy_enrollments', v_e.id::text, 're_enroll', jsonb_build_object('status', 'withdrawn'), to_jsonb(v_e));
  else
    update academy_enrollments set membership_id = v_m.id where id = v_e.id returning * into v_e;   -- kept, now on the paid access
  end if;
  update academy_purchases set status = 'paid', paid_at = now(), learner_id = v_l.id, organization_id = v_o.id, enrollment_id = v_e.id, updated_at = now()
   where id = v_p.id returning * into v_out;
  return v_out;
end $$;

-- Internal: a refund or dispute takes the course away again unless it was already completed (an earned certificate stays).
create function public.academy_purchase_withdraw(v_p academy_purchases, p_why text) returns void
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare v_e academy_enrollments;
begin
  select * into v_e from academy_enrollments where id = v_p.enrollment_id for update;
  if v_e.id is null or v_e.status in ('withdrawn','completed') then return; end if;
  update academy_enrollments set status = 'withdrawn' where id = v_e.id;
  perform academy_op_audit('system', 'system:stripe', 'academy_enrollments', v_e.id::text, 'withdraw', to_jsonb(v_e), jsonb_build_object('reason', p_why));
end $$;

create function public.academy_purchase_restore(v_p academy_purchases) returns void
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare v_e academy_enrollments;
begin
  select * into v_e from academy_enrollments where id = v_p.enrollment_id for update;
  if v_e.id is null or v_e.status <> 'withdrawn' then return; end if;
  update academy_enrollments set status = case when exists (select 1 from academy_progress p where p.enrollment_id = v_e.id) then 'in_progress' else 'not_started' end
   where id = v_e.id;
  perform academy_op_audit('system', 'system:stripe', 'academy_enrollments', v_e.id::text, 'restore', null, jsonb_build_object('reason', 'dispute won'));
end $$;

-- One verified Stripe event. p_data carries only the fields the webhook extracted (never card data).
create function public.academy_purchase_op_stripe_event(p_event_id text, p_type text, p_livemode boolean, p_data jsonb) returns jsonb
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

-- ---------------------------------------------------------------------------------------------
-- PRIVILEGES: operations to the server role only; helpers to nobody
-- ---------------------------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'academy\_purchase\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
    if f.proname like 'academy\_purchase\_op\_%' then execute format('grant execute on function %s to service_role', f.sig); end if;
  end loop;
end $$;
revoke all on function public.academy_prices_rights_check() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- INSTALL CHECKS (every row must read ok = true)
-- ---------------------------------------------------------------------------------------------
select 'tables private (RLS on, no anon/authenticated rights)' as check,
       (select count(*) from pg_class c where c.relname in ('academy_organizations','academy_prices','academy_dealer_eligibility','academy_purchases','academy_stripe_events')
          and c.relrowsecurity and not has_table_privilege('anon', c.oid, 'select') and not has_table_privilege('authenticated', c.oid, 'select')
          and not has_table_privilege('service_role', c.oid, 'insert')) = 5 as ok
union all
select 'operations executable by service_role only',
       not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'academy\_purchase\_%'
                    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')))
   and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'academy\_purchase\_op\_%'
          and has_function_privilege('service_role', p.oid, 'execute')) = 7
   and not has_function_privilege('service_role', 'public.academy_prices_rights_check()', 'execute')
union all
select 'sandbox only (live payments refused by the table)',
       exists (select 1 from pg_constraint where conrelid = 'public.academy_purchases'::regclass and pg_get_constraintdef(oid) like '%livemode = false%')
union all
select 'no outside sales configured yet', not exists (select 1 from academy_prices where outside_sale_allowed);

commit;

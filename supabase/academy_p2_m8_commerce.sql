-- =============================================================================================
-- HCPS Academy — Phase 2 / M8: dealer eligibility, course pricing, outside organizations, purchases (DEVELOPMENT;
-- NOT run in production). Plan: docs/academy/PHASE2_PAYMENTS_PROPOSAL.md; defaults: PR #25 comment 6278300397.
--
-- What it adds:
--   * FREE ELIGIBILITY, decided in ONE place (academy_commerce_eligibility): the dealer AND its head office are
--     status = 'active', account_class blank or 'dealer', and neither is a TEST dealer. A President override (audited,
--     reason required, append-only history) on the dealer, else on its head office, wins. A prospect, manufacturer,
--     vendor, internal or inactive account is never free by accident.
--   * COURSE PRICES as commercial metadata, separate from the immutable course content: one row per course
--     (academy_course_prices), changed ONLY by the President through academy_commerce_op_set_price, every change kept in
--     append-only academy_course_price_history. Publishing a new content version never freezes or changes a price.
--     sale_mode: off (default) · test (Stripe TEST mode, TEST courses only — a test card must never open a real course)
--     · live (needs manufacturer commercial rights recorded as confirmed).
--   * OUTSIDE ORGANIZATIONS (academy_organizations): Academy-only buyers that are NOT dealers. Their access is an
--     academy_memberships row with organization_id instead of dealer_id (exactly one of the two), role learner only,
--     access_type 'purchased'. Nothing about them is a dealer, so Dealer 360, reps' books, analytics, Zoho and Training
--     Managers never see or reach them (every dealer-scoped read and check keys on dealer_id).
--   * CHECKOUTS and PURCHASES: the server opens a checkout at the DATABASE's price (never the browser's), Stripe takes the
--     card, and access is granted ONLY by a signature-verified Stripe webhook through academy_commerce_op_grant, which is
--     idempotent on the Stripe event id AND the Checkout Session id and refuses an amount / currency / mode that differs
--     from the checkout. Refunds: a buyer may request one within 14 days; the President approves or declines; Stripe's
--     refund event withdraws an unfinished enrollment. An earned certificate is never invalidated by a refund. A buyer
--     with two or more refunds in 12 months needs a President buyer review before buying again (audited).
--
-- Design (same as M1–M7): SECURITY DEFINER operations with a pinned search path, executable by the server role only;
-- helpers owner only; every change + its academy_events row in one transaction (M1's op_begin / op_audit / op_end).
-- The server role can READ the new tables but write none of them; a guard trigger refuses any write that is not made by
-- an operation (also by the owner by hand). M1–M7 functions are left byte-identical.
-- Changed constraints on existing tables (reviewed): academy_memberships.dealer_id becomes nullable with
-- "exactly one of dealer_id / organization_id"; access_type gains 'purchased'; academy_enrollments.access_source gains
-- 'purchase'. Every existing row keeps satisfying the new checks (all have a dealer_id; no new value is in use).
--
-- Run order: after A1, M1–M7. Rollback: academy_p2_m8_commerce_rollback.sql (refused while any organization, checkout,
-- purchase, price, override or review row exists). RULE 19: new tables RLS on, no policies, nothing for anon /
-- authenticated, SELECT only for the server. Every UPDATE / DELETE carries a WHERE clause (pg-safeupdate).
-- =============================================================================================
begin;

do $$ begin
  if to_regprocedure('public.academy_cert_op_claim(text,uuid)') is null
     or to_regprocedure('public.academy_exam_op_start(text,uuid)') is null
     or to_regprocedure('public.academy_access_op_request_code(text,text,text)') is null then
    raise exception 'M8 needs M1–M7 installed first';
  end if;
  if to_regprocedure('public.academy_commerce_op_set_price(text,uuid,jsonb,text)') is not null then
    raise exception 'M8 is already installed';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'dealers' and column_name = 'status')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'dealers' and column_name = 'account_class')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'dealers' and column_name = 'is_test')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'dealer_users' and column_name = 'status') then
    raise exception 'M8 needs dealers.status, dealers.account_class, dealers.is_test and dealer_users.status';
  end if;
  if exists (select 1 from academy_memberships where dealer_id is null) then
    raise exception 'M8 expects every membership to belong to a dealer';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- SCHEMA
-- ---------------------------------------------------------------------------------------------
create table public.academy_organizations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(btrim(name)) between 2 and 160),
  contact_email text not null check (contact_email = lower(contact_email) and contact_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' and length(contact_email) <= 254),
  status        text not null default 'active' check (status in ('active','closed')),
  created_at    timestamptz not null default now(),
  created_by    text not null
);
comment on table public.academy_organizations is
  'Academy-only outside buyers (Phase 2). Never dealers: not in Dealer 360, reps'' books, analytics or Zoho.';

-- memberships: a dealer OR an outside organization, never both, never neither
alter table public.academy_memberships alter column dealer_id drop not null;
alter table public.academy_memberships add column organization_id uuid references public.academy_organizations(id) on delete restrict;
do $$ declare c text; n int; begin
  select count(*), min(conname) into n, c from pg_constraint
   where conrelid = 'public.academy_memberships'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%access_type%';
  if n <> 1 then raise exception 'M8: expected exactly one access_type check on academy_memberships, found %', n; end if;
  execute format('alter table public.academy_memberships drop constraint %I', c);
  select count(*), min(conname) into n, c from pg_constraint
   where conrelid = 'public.academy_enrollments'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%access_source%';
  if n <> 1 then raise exception 'M8: expected exactly one access_source check on academy_enrollments, found %', n; end if;
  execute format('alter table public.academy_enrollments drop constraint %I', c);
end $$;
alter table public.academy_memberships add constraint academy_memberships_access_type_check
  check (access_type in ('dealer_user','training_only','purchased'));
alter table public.academy_memberships add constraint academy_memberships_one_owner
  check (num_nonnulls(dealer_id, organization_id) = 1);
alter table public.academy_memberships add constraint academy_memberships_outside_shape
  check ((organization_id is null) = (access_type <> 'purchased') and (organization_id is null or role = 'learner'));
alter table public.academy_enrollments add constraint academy_enrollments_access_source_check
  check (access_source in ('assigned','self','admin_grant','purchase'));
create index academy_memberships_org on public.academy_memberships (organization_id) where organization_id is not null;

-- President overrides of free eligibility. Append-only: a change supersedes the current row (one current per dealer).
create table public.academy_eligibility_overrides (
  id            bigint generated always as identity primary key,
  dealer_id     uuid not null references public.dealers(id) on delete restrict,
  eligible      boolean,                 -- null = override removed (the standard rule applies again)
  reason        text not null check (length(btrim(reason)) between 5 and 500),
  set_by        text not null,
  set_at        timestamptz not null default now(),
  superseded_at timestamptz
);
create unique index academy_eligibility_overrides_current on public.academy_eligibility_overrides (dealer_id) where superseded_at is null;

-- One price per course: commercial metadata, never part of a content version.
create table public.academy_course_prices (
  course_id       uuid primary key references public.academy_courses(id) on delete restrict,
  price_cents     int  not null check (price_cents between 0 and 1000000),
  currency        text not null default 'usd' check (currency = 'usd'),
  network_included boolean not null default true,   -- free for eligible HCPS network dealers
  sale_mode       text not null default 'off' check (sale_mode in ('off','test','live')),
  rights_status   text not null default 'not_confirmed' check (rights_status in ('not_confirmed','confirmed','not_required')),
  rights_ref      text check (rights_ref is null or length(btrim(rights_ref)) between 5 and 500),
  public_note     text check (public_note is null or length(public_note) <= 300),
  updated_at      timestamptz not null default now(),
  updated_by      text not null,
  check (sale_mode = 'off' or price_cents >= 50),                                      -- Stripe's minimum charge
  check (rights_status = 'not_confirmed' or rights_ref is not null),
  check (sale_mode <> 'live' or rights_status in ('confirmed','not_required'))
);
create table public.academy_course_price_history (
  id        bigint generated always as identity primary key,
  course_id uuid not null references public.academy_courses(id) on delete restrict,
  before    jsonb,
  after     jsonb not null,
  reason    text not null,
  actor     text not null,
  at        timestamptz not null default now()
);

-- A buyer with repeated refunds is reviewed by the President before buying again.
create table public.academy_buyer_reviews (
  id            bigint generated always as identity primary key,
  email         text not null check (email = lower(email)),
  decision      text not null check (decision in ('allow','block')),
  reason        text not null check (length(btrim(reason)) between 5 and 500),
  decided_by    text not null,
  decided_at    timestamptz not null default now(),
  superseded_at timestamptz
);
create unique index academy_buyer_reviews_current on public.academy_buyer_reviews (email) where superseded_at is null;

create table public.academy_checkouts (
  id                uuid primary key default gen_random_uuid(),
  course_id         uuid not null references public.academy_courses(id) on delete restrict,
  version_id        uuid not null references public.academy_course_versions(id) on delete restrict,
  buyer_email       text not null check (buyer_email = lower(buyer_email) and buyer_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' and length(buyer_email) <= 254),
  buyer_name        text not null check (length(btrim(buyer_name)) between 2 and 120),
  organization_name text not null check (length(btrim(organization_name)) between 2 and 160),
  amount_cents      int  not null check (amount_cents >= 50),
  currency          text not null check (currency = 'usd'),
  mode              text not null check (mode in ('test','live')),
  status            text not null default 'open' check (status in ('open','completed','expired','canceled')),
  stripe_session_id text unique check (stripe_session_id ~ '^cs_(test|live)_[A-Za-z0-9]{8,240}$'),
  ip_hash           text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  completed_at      timestamptz,
  check (stripe_session_id is null or stripe_session_id like 'cs\_' || mode || '\_%'),
  check (expires_at > created_at and expires_at <= created_at + interval '24 hours'),
  check ((status = 'completed') = (completed_at is not null))
);
create unique index academy_checkouts_one_open on public.academy_checkouts (buyer_email, course_id) where status = 'open';
create index academy_checkouts_ip on public.academy_checkouts (ip_hash, created_at desc);

create table public.academy_purchases (
  id                    uuid primary key default gen_random_uuid(),
  checkout_id           uuid not null unique references public.academy_checkouts(id) on delete restrict,
  stripe_session_id     text not null unique,
  payment_intent_id     text unique check (payment_intent_id ~ '^pi_[A-Za-z0-9]{8,240}$'),
  mode                  text not null check (mode in ('test','live')),
  amount_cents          int  not null check (amount_cents >= 50),
  currency              text not null check (currency = 'usd'),
  course_id             uuid not null references public.academy_courses(id) on delete restrict,
  version_id            uuid references public.academy_course_versions(id) on delete restrict,
  buyer_email           text not null,
  organization_id       uuid references public.academy_organizations(id) on delete restrict,
  learner_id            uuid references public.academy_learners(id) on delete restrict,
  membership_id         uuid references public.academy_memberships(id) on delete restrict,
  enrollment_id         uuid references public.academy_enrollments(id) on delete restrict,
  access                text not null check (access in ('granted','needs_review')),
  access_note           text,
  status                text not null default 'paid' check (status in ('paid','refund_requested','refund_approved','refunded','disputed')),
  paid_at               timestamptz not null default now(),
  refund_requested_at   timestamptz,
  refund_request_reason text,
  refunded_cents        int not null default 0,
  refunded_at           timestamptz,
  review_note           text,
  check (refunded_cents between 0 and amount_cents),
  check (access <> 'granted' or (organization_id is not null and learner_id is not null and membership_id is not null and enrollment_id is not null)),
  check (access <> 'needs_review' or access_note is not null),
  check (status <> 'refunded' or (refunded_at is not null and refunded_cents = amount_cents))
);
create index academy_purchases_email on public.academy_purchases (buyer_email);

-- Every Stripe event processed once (replays are recognised, never applied twice).
create table public.academy_stripe_events (
  event_id    text primary key check (event_id ~ '^evt_[A-Za-z0-9]{8,240}$'),
  type        text not null check (length(type) <= 100),
  mode        text not null check (mode in ('test','live')),
  received_at timestamptz not null default now(),
  outcome     text not null check (length(outcome) <= 200)
);

do $$
declare t text;
begin
  foreach t in array array['academy_organizations','academy_eligibility_overrides','academy_course_prices','academy_course_price_history',
                           'academy_buyer_reviews','academy_checkouts','academy_purchases','academy_stripe_events']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on table public.%I to service_role', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- GUARD: the commerce tables change only inside an M8 operation (marker + the owner's rights). History, events and
-- overrides are append-only (an override / review row may only be marked superseded, once).
-- ---------------------------------------------------------------------------------------------
create function public.academy_commerce_guard() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if coalesce(current_setting('academy.op', true), '') not like 'commerce\_%'
     or current_user <> (select pg_get_userbyid(p.proowner) from pg_proc p where p.oid = 'public.academy_commerce_guard()'::regprocedure) then
    raise exception 'academy: commerce records change only through the audited commerce operations' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then raise exception 'academy: commerce records are never deleted' using errcode = '42501'; end if;
  -- (nested IFs: PL/pgSQL does not promise to skip a field of a table that lacks it)
  if tg_op = 'UPDATE' then
    if tg_table_name = 'academy_course_price_history' then
      raise exception 'academy: % is append-only', tg_table_name using errcode = '42501';
    end if;
    -- a Stripe event is written as 'processing' and then given its final outcome, once
    if tg_table_name = 'academy_stripe_events' then
      if old.outcome <> 'processing' or (to_jsonb(new) - 'outcome') is distinct from (to_jsonb(old) - 'outcome') then
        raise exception 'academy: a processed Stripe event is never changed' using errcode = '42501';
      end if;
    end if;
    if tg_table_name in ('academy_eligibility_overrides','academy_buyer_reviews') then
      if old.superseded_at is not null or new.superseded_at is null
         or (to_jsonb(new) - 'superseded_at') is distinct from (to_jsonb(old) - 'superseded_at') then
        raise exception 'academy: a decision is never edited; record a new one' using errcode = '42501';
      end if;
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create function public.academy_commerce_guard_truncate() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  raise exception 'academy: commerce records are never truncated' using errcode = '42501';
end $$;
do $$
declare t text;
begin
  foreach t in array array['academy_organizations','academy_eligibility_overrides','academy_course_prices','academy_course_price_history',
                           'academy_buyer_reviews','academy_checkouts','academy_purchases','academy_stripe_events']
  loop
    execute format('create trigger academy_commerce_guard before insert or update or delete on public.%I for each row execute function public.academy_commerce_guard()', t);
    execute format('create trigger academy_commerce_guard_truncate before truncate on public.%I for each statement execute function public.academy_commerce_guard_truncate()', t);
  end loop;
end $$;

-- An outside organization's membership is created and changed only by the commerce operations; a dealer membership can
-- never be turned into one (or back).
create function public.academy_commerce_membership_guard() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.organization_id is not null and coalesce(current_setting('academy.op', true), '') not like 'commerce\_%' then
      raise exception 'academy: outside-organization access is created only by a verified purchase' using errcode = '42501';
    end if;
  elsif new.organization_id is distinct from old.organization_id or new.dealer_id is distinct from old.dealer_id then
    raise exception 'academy: a membership never changes owner' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger academy_commerce_membership_guard before insert or update on public.academy_memberships
  for each row execute function public.academy_commerce_membership_guard();

-- ---------------------------------------------------------------------------------------------
-- HELPERS (owner only, except the read-only eligibility answer, which the server calls)
-- ---------------------------------------------------------------------------------------------
create function public.academy_commerce_president(p_actor text) returns void
language plpgsql stable set search_path = pg_catalog, public, pg_temp as $$
declare v_email text;
begin
  v_email := academy_op_actor_staff(p_actor);
  if not exists (select 1 from staff_users s where lower(s.email) = v_email and coalesce(s.active, true)
                   and lower(coalesce(s.role, '')) = 'president') then
    raise exception 'academy: only the HCPS President may change pricing, eligibility or refunds' using errcode = '42501';
  end if;
end $$;

create function public.academy_commerce_norm_email(p text) returns text
language plpgsql immutable set search_path = pg_catalog, public, pg_temp as $$
declare v text := lower(btrim(coalesce(p, '')));
begin
  if v !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(v) > 254 then
    raise exception 'academy: that is not an email address' using errcode = '22023';
  end if;
  return v;
end $$;

-- FREE ELIGIBILITY — the one rule. {eligible, reason, dealer_id, head_office_id, override_id}
create function public.academy_commerce_eligibility(p_dealer uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_id uuid; v_parent uuid; v_status text; v_class text; v_test boolean;
        h_id uuid; h_status text; h_class text; h_test boolean; o academy_eligibility_overrides;
        out jsonb;
begin
  select d.id, d.parent_id, lower(coalesce(d.status::text, '')), lower(coalesce(d.account_class, '')), coalesce(d.is_test, false)
    into v_id, v_parent, v_status, v_class, v_test from dealers d where d.id = p_dealer;
  if v_id is null then return jsonb_build_object('eligible', false, 'reason', 'unknown_dealer'); end if;
  h_id := v_id; h_status := v_status; h_class := v_class; h_test := v_test;
  if v_parent is not null then
    select d.id, lower(coalesce(d.status::text, '')), lower(coalesce(d.account_class, '')), coalesce(d.is_test, false)
      into h_id, h_status, h_class, h_test from dealers d where d.id = v_parent;
    if h_id is null then h_id := v_id; h_status := v_status; h_class := v_class; h_test := v_test; end if;
  end if;
  out := jsonb_build_object('dealer_id', v_id, 'head_office_id', h_id);
  -- the dealer's own override, else its head office's
  select * into o from academy_eligibility_overrides where dealer_id = v_id and superseded_at is null and eligible is not null;
  if o.id is null and h_id <> v_id then
    select * into o from academy_eligibility_overrides where dealer_id = h_id and superseded_at is null and eligible is not null;
  end if;
  if o.id is not null then
    return out || jsonb_build_object('eligible', o.eligible, 'reason', 'override', 'override_id', o.id,
                                     'override_scope', case when o.dealer_id = v_id then 'dealer' else 'head_office' end);
  end if;
  if v_test or h_test then return out || jsonb_build_object('eligible', false, 'reason', 'test_dealer'); end if;
  if v_status <> 'active' or h_status <> 'active' then return out || jsonb_build_object('eligible', false, 'reason', 'not_active'); end if;
  if v_class not in ('', 'dealer') or h_class not in ('', 'dealer') then
    return out || jsonb_build_object('eligible', false, 'reason', 'account_class');
  end if;
  return out || jsonb_build_object('eligible', true, 'reason', 'network_dealer');
end $$;

-- Is this address already covered free (an approved Partner 360 login or an active Academy membership at an ELIGIBLE
-- dealer)? Returns the dealer id, or null.
create function public.academy_commerce_included_dealer(p_email text) returns uuid
language plpgsql stable set search_path = pg_catalog, public, pg_temp as $$
declare v uuid;
begin
  for v in select du.dealer_id from dealer_users du where lower(du.email) = p_email and du.status = 'approved' and du.dealer_id is not null
           union
           select m.dealer_id from academy_memberships m join academy_learners l on l.id = m.learner_id
            where l.email = p_email and m.status = 'active' and m.dealer_id is not null loop
    if (academy_commerce_eligibility(v)->>'eligible')::boolean then return v; end if;
  end loop;
  return null;
end $$;

-- The published version a purchase opens (the newest published one).
create function public.academy_commerce_live_version(p_course uuid) returns uuid
language sql stable set search_path = pg_catalog, public, pg_temp as $$
  select v.id from academy_course_versions v where v.course_id = p_course and v.status = 'published' order by v.version desc limit 1
$$;

create function public.academy_commerce_price_row(p academy_course_prices) returns jsonb
language sql immutable set search_path = pg_catalog, public, pg_temp as $$
  select case when p.course_id is null then null else jsonb_build_object('course_id', p.course_id, 'price_cents', p.price_cents,
    'currency', p.currency, 'network_included', p.network_included, 'sale_mode', p.sale_mode, 'rights_status', p.rights_status,
    'rights_ref', p.rights_ref, 'public_note', p.public_note) end
$$;

-- ---------------------------------------------------------------------------------------------
-- 1. PRESIDENT: eligibility overrides, prices, buyer reviews
-- ---------------------------------------------------------------------------------------------
-- p_eligible true / false sets an override; null removes it (the standard rule applies again). Always a new row.
create function public.academy_commerce_op_set_override(p_actor text, p_dealer_id uuid, p_eligible boolean, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_old academy_eligibility_overrides; v_new academy_eligibility_overrides; v_before jsonb;
begin
  perform academy_commerce_president(p_actor);
  if not exists (select 1 from dealers where id = p_dealer_id) then raise exception 'academy: dealer not found' using errcode = 'P0002'; end if;
  if p_reason is null or length(btrim(p_reason)) < 5 or length(p_reason) > 500 then
    raise exception 'academy: a reason (5 to 500 characters) is required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('academy-elig:' || p_dealer_id::text));
  v_before := academy_commerce_eligibility(p_dealer_id);
  select * into v_old from academy_eligibility_overrides where dealer_id = p_dealer_id and superseded_at is null for update;
  if v_old.id is not null and v_old.eligible is not distinct from p_eligible then
    return jsonb_build_object('ok', true, 'unchanged', true, 'eligibility', v_before);
  end if;
  if v_old.id is null and p_eligible is null then return jsonb_build_object('ok', true, 'unchanged', true, 'eligibility', v_before); end if;
  perform academy_op_begin('commerce_set_override', p_actor);
  if v_old.id is not null then update academy_eligibility_overrides set superseded_at = now() where id = v_old.id; end if;
  insert into academy_eligibility_overrides (dealer_id, eligible, reason, set_by)
  values (p_dealer_id, p_eligible, btrim(p_reason), p_actor) returning * into v_new;
  perform academy_op_audit('staff', p_actor, 'academy_eligibility_overrides', p_dealer_id::text, 'set_eligibility_override',
    jsonb_build_object('override', case when v_old.id is null then null else v_old.eligible end, 'eligibility', v_before),
    jsonb_build_object('override', p_eligible, 'reason', btrim(p_reason), 'eligibility', academy_commerce_eligibility(p_dealer_id)));
  perform academy_op_end();
  return jsonb_build_object('ok', true, 'override_id', v_new.id, 'eligibility', academy_commerce_eligibility(p_dealer_id));
end $$;

-- Patch keys: price_cents, network_included, sale_mode, rights_status, rights_ref, public_note. Anything else is refused.
create function public.academy_commerce_op_set_price(p_actor text, p_course_id uuid, p_patch jsonb, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_c academy_courses; v_old academy_course_prices; v_new academy_course_prices; k text;
begin
  perform academy_commerce_president(p_actor);
  if p_reason is null or length(btrim(p_reason)) < 5 or length(p_reason) > 500 then
    raise exception 'academy: a reason (5 to 500 characters) is required' using errcode = '22023';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    raise exception 'academy: nothing to change' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('price_cents','network_included','sale_mode','rights_status','rights_ref','public_note') then
      raise exception 'academy: % cannot be set here', k using errcode = '22023';
    end if;
  end loop;
  select * into v_c from academy_courses where id = p_course_id for share;
  if not found then raise exception 'academy: course not found' using errcode = 'P0002'; end if;
  if v_c.course_type = 'manufacturer_program' then raise exception 'academy: a manufacturer program is not sold here' using errcode = '22023'; end if;
  if p_patch ? 'price_cents' and (jsonb_typeof(p_patch->'price_cents') <> 'number' or (p_patch->>'price_cents') !~ '^[0-9]{1,7}$') then
    raise exception 'academy: the price must be a whole number of cents' using errcode = '22023';
  end if;
  if p_patch ? 'network_included' and jsonb_typeof(p_patch->'network_included') <> 'boolean' then
    raise exception 'academy: network_included must be true or false' using errcode = '22023';
  end if;
  -- Stripe TEST mode only for a TEST course: a test card must never open a real course.
  if p_patch->>'sale_mode' = 'test' and v_c.slug not like 'test-%' then
    raise exception 'academy: TEST-mode sales are only for TEST courses (slug test-…)' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('academy-price:' || p_course_id::text));
  select * into v_old from academy_course_prices where course_id = p_course_id for update;
  perform academy_op_begin('commerce_set_price', p_actor);
  if v_old.course_id is null then
    insert into academy_course_prices (course_id, price_cents, network_included, sale_mode, rights_status, rights_ref, public_note, updated_by)
    values (p_course_id, coalesce((p_patch->>'price_cents')::int, 0), coalesce((p_patch->>'network_included')::boolean, true),
            coalesce(p_patch->>'sale_mode', 'off'), coalesce(p_patch->>'rights_status', 'not_confirmed'),
            nullif(btrim(p_patch->>'rights_ref'), ''), nullif(btrim(p_patch->>'public_note'), ''), p_actor)
    returning * into v_new;
  else
    update academy_course_prices set
      price_cents      = case when p_patch ? 'price_cents' then (p_patch->>'price_cents')::int else price_cents end,
      network_included = case when p_patch ? 'network_included' then (p_patch->>'network_included')::boolean else network_included end,
      sale_mode        = case when p_patch ? 'sale_mode' then p_patch->>'sale_mode' else sale_mode end,
      rights_status    = case when p_patch ? 'rights_status' then p_patch->>'rights_status' else rights_status end,
      rights_ref       = case when p_patch ? 'rights_ref' then nullif(btrim(p_patch->>'rights_ref'), '') else rights_ref end,
      public_note      = case when p_patch ? 'public_note' then nullif(btrim(p_patch->>'public_note'), '') else public_note end,
      updated_at = now(), updated_by = p_actor
     where course_id = p_course_id returning * into v_new;
  end if;
  if v_new.sale_mode = 'test' and v_c.slug not like 'test-%' then
    raise exception 'academy: TEST-mode sales are only for TEST courses (slug test-…)' using errcode = '22023';
  end if;
  insert into academy_course_price_history (course_id, before, after, reason, actor)
  values (p_course_id, academy_commerce_price_row(v_old), academy_commerce_price_row(v_new), btrim(p_reason), p_actor);
  perform academy_op_audit('staff', p_actor, 'academy_course_prices', p_course_id::text, 'set_price',
    academy_commerce_price_row(v_old), academy_commerce_price_row(v_new) || jsonb_build_object('reason', btrim(p_reason)));
  perform academy_op_end();
  return jsonb_build_object('ok', true, 'price', academy_commerce_price_row(v_new));
end $$;

create function public.academy_commerce_op_buyer_review(p_actor text, p_email text, p_decision text, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_email text := academy_commerce_norm_email(p_email); v_old academy_buyer_reviews; v_new academy_buyer_reviews;
begin
  perform academy_commerce_president(p_actor);
  if p_decision not in ('allow','block') then raise exception 'academy: decide allow or block' using errcode = '22023'; end if;
  if p_reason is null or length(btrim(p_reason)) < 5 or length(p_reason) > 500 then
    raise exception 'academy: a reason (5 to 500 characters) is required' using errcode = '22023';
  end if;
  perform academy_op_begin('commerce_buyer_review', p_actor);
  select * into v_old from academy_buyer_reviews where email = v_email and superseded_at is null for update;
  if v_old.id is not null then update academy_buyer_reviews set superseded_at = now() where id = v_old.id; end if;
  insert into academy_buyer_reviews (email, decision, reason, decided_by) values (v_email, p_decision, btrim(p_reason), p_actor) returning * into v_new;
  perform academy_op_audit('staff', p_actor, 'academy_buyer_reviews', v_email, 'buyer_review',
    case when v_old.id is null then null else jsonb_build_object('decision', v_old.decision) end,
    jsonb_build_object('decision', p_decision, 'reason', btrim(p_reason)));
  perform academy_op_end();
  return jsonb_build_object('ok', true, 'review_id', v_new.id);
end $$;

-- ---------------------------------------------------------------------------------------------
-- 2. CHECKOUT (called by the public checkout function, before Stripe)
-- ---------------------------------------------------------------------------------------------
-- Opens (or re-uses) a checkout at the DATABASE's price. p_mode is the mode of the Stripe key the server holds; the
-- course must be on sale in exactly that mode. Returns {ok:true, checkout:{…}, reused} or {ok:false, reason}.
create function public.academy_commerce_op_checkout_open(p_email text, p_name text, p_org text, p_course_id uuid, p_mode text, p_ip_hash text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_email text := academy_commerce_norm_email(p_email); v_c academy_courses; v_p academy_course_prices; v_v uuid;
        v_old academy_checkouts; v_new academy_checkouts; v_rev academy_buyer_reviews; v_refunds int;
begin
  if p_mode not in ('test','live') or p_ip_hash !~ '^[0-9a-f]{64}$' then raise exception 'academy: malformed request' using errcode = '22023'; end if;
  if p_name is null or length(btrim(p_name)) not between 2 and 120 then raise exception 'academy: enter your name' using errcode = '22023'; end if;
  if p_org is null or length(btrim(p_org)) not between 2 and 160 then raise exception 'academy: enter your company name' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('academy-buy-ip:' || p_ip_hash));
  perform pg_advisory_xact_lock(hashtext('academy-buy:' || v_email));
  if (select count(*) from academy_checkouts where ip_hash = p_ip_hash and created_at > now() - interval '1 hour') >= 10
     or (select count(*) from academy_checkouts where buyer_email = v_email and created_at > now() - interval '1 hour') >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'limited');
  end if;
  select * into v_c from academy_courses where id = p_course_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_for_sale'); end if;
  select * into v_p from academy_course_prices where course_id = p_course_id;
  if v_p.course_id is null or v_p.sale_mode <> p_mode or v_p.price_cents < 50
     or (p_mode = 'live' and v_p.rights_status not in ('confirmed','not_required'))
     or (p_mode = 'test' and v_c.slug not like 'test-%') then
    return jsonb_build_object('ok', false, 'reason', 'not_for_sale');
  end if;
  v_v := academy_commerce_live_version(p_course_id);
  if v_v is null then return jsonb_build_object('ok', false, 'reason', 'not_for_sale'); end if;
  if academy_access_is_staff(v_email) then return jsonb_build_object('ok', false, 'reason', 'staff'); end if;
  if v_p.network_included and academy_commerce_included_dealer(v_email) is not null then
    return jsonb_build_object('ok', false, 'reason', 'included');
  end if;
  if exists (select 1 from academy_learners l where l.email = v_email and l.status <> 'active') then
    return jsonb_build_object('ok', false, 'reason', 'review');
  end if;
  if exists (select 1 from academy_enrollments e join academy_learners l on l.id = e.learner_id
              join academy_course_versions v on v.id = e.version_id join academy_memberships m on m.id = e.membership_id
             where l.email = v_email and v.course_id = p_course_id and e.status <> 'withdrawn' and m.status = 'active') then
    return jsonb_build_object('ok', false, 'reason', 'already_enrolled');
  end if;
  select * into v_rev from academy_buyer_reviews where email = v_email and superseded_at is null;
  select count(*) into v_refunds from academy_purchases where buyer_email = v_email and refunded_cents > 0 and paid_at > now() - interval '12 months';
  if v_rev.decision = 'block' or (v_refunds >= 2 and v_rev.decision is distinct from 'allow') then
    return jsonb_build_object('ok', false, 'reason', 'review');
  end if;
  perform academy_op_begin('commerce_checkout_open', 'system:checkout');
  select * into v_old from academy_checkouts where buyer_email = v_email and course_id = p_course_id and status = 'open' for update;
  if v_old.id is not null then
    if v_old.expires_at > now() + interval '35 minutes' and v_old.amount_cents = v_p.price_cents and v_old.mode = p_mode
       and v_old.version_id = v_v then
      perform academy_op_end();
      return jsonb_build_object('ok', true, 'reused', true, 'checkout', to_jsonb(v_old) - 'ip_hash');
    end if;
    update academy_checkouts set status = case when v_old.expires_at <= now() then 'expired' else 'canceled' end where id = v_old.id;
  end if;
  insert into academy_checkouts (course_id, version_id, buyer_email, buyer_name, organization_name, amount_cents, currency, mode, ip_hash, expires_at)
  values (p_course_id, v_v, v_email, btrim(p_name), btrim(p_org), v_p.price_cents, v_p.currency, p_mode, p_ip_hash, now() + interval '23 hours')
  returning * into v_new;
  perform academy_op_audit('system', 'system:checkout', 'academy_checkouts', v_new.id::text, 'checkout_open', null,
    jsonb_build_object('course_id', p_course_id, 'version_id', v_v, 'amount_cents', v_new.amount_cents, 'mode', p_mode, 'email', v_email));
  perform academy_op_end();
  return jsonb_build_object('ok', true, 'reused', false, 'checkout', to_jsonb(v_new) - 'ip_hash');
end $$;

-- Records the Stripe Checkout Session created for a checkout (once; the same id again is a no-op).
create function public.academy_commerce_op_checkout_attach(p_checkout_id uuid, p_session_id text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v academy_checkouts;
begin
  select * into v from academy_checkouts where id = p_checkout_id for update;
  if not found then raise exception 'academy: checkout not found' using errcode = 'P0002'; end if;
  if v.stripe_session_id = p_session_id then return jsonb_build_object('ok', true, 'unchanged', true); end if;
  if v.stripe_session_id is not null or v.status <> 'open' then raise exception 'academy: this checkout is already linked' using errcode = '55000'; end if;
  if p_session_id is null or p_session_id !~ ('^cs_' || v.mode || '_[A-Za-z0-9]{8,240}$') then
    raise exception 'academy: that is not a Stripe session of this mode' using errcode = '22023';
  end if;
  perform academy_op_begin('commerce_checkout_attach', 'system:checkout');
  update academy_checkouts set stripe_session_id = p_session_id where id = p_checkout_id;
  perform academy_op_end();
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------------------------
-- 3. STRIPE WEBHOOK OPERATIONS (called ONLY after the server verified the Stripe signature)
-- ---------------------------------------------------------------------------------------------
-- Records the event once. Returns false when it was already processed (a replay).
create function public.academy_commerce_event_once(p_event_id text, p_type text, p_mode text, p_outcome text) returns boolean
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare n int;
begin
  insert into academy_stripe_events (event_id, type, mode, outcome) values (p_event_id, p_type, p_mode, p_outcome)
  on conflict (event_id) do nothing;
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- A paid Checkout Session: grants access. Idempotent on the event id AND the session id. The amount, currency and mode
-- must be the checkout's own; anything else is recorded and grants nothing.
create function public.academy_commerce_op_grant(p_event_id text, p_mode text, p_session_id text, p_payment_intent text,
                                                 p_amount_cents int, p_currency text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_co academy_checkouts; v_pu academy_purchases; v_l academy_learners; v_org uuid; v_m uuid; v_e academy_enrollments;
        v_v uuid; v_note text; v_access text := 'granted';
begin
  if p_mode not in ('test','live') then raise exception 'academy: malformed request' using errcode = '22023'; end if;
  perform academy_op_begin('commerce_grant', 'system:stripe');
  perform pg_advisory_xact_lock(hashtext('academy-stripe:' || coalesce(p_session_id, '')));
  select * into v_co from academy_checkouts where stripe_session_id = p_session_id for update;
  if not found then
    perform academy_commerce_event_once(p_event_id, 'checkout.session.completed', p_mode, 'unknown_session');
    perform academy_op_end();
    return jsonb_build_object('ok', false, 'reason', 'unknown_session');
  end if;
  select * into v_pu from academy_purchases where checkout_id = v_co.id;
  if v_pu.id is not null then
    perform academy_commerce_event_once(p_event_id, 'checkout.session.completed', p_mode, 'duplicate');
    perform academy_op_end();
    return jsonb_build_object('ok', true, 'duplicate', true, 'purchase_id', v_pu.id);
  end if;
  if not academy_commerce_event_once(p_event_id, 'checkout.session.completed', p_mode, 'processing') then
    perform academy_op_end();
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  if v_co.mode <> p_mode or v_co.amount_cents <> p_amount_cents or v_co.currency <> lower(coalesce(p_currency, '')) then
    -- the event is kept with its outcome; nothing is granted (a person reviews it)
    update academy_stripe_events set outcome = 'mismatch' where event_id = p_event_id;
    perform academy_op_audit('system', 'system:stripe', 'academy_checkouts', v_co.id::text, 'payment_mismatch', to_jsonb(v_co) - 'ip_hash',
      jsonb_build_object('amount_cents', p_amount_cents, 'currency', p_currency, 'mode', p_mode, 'session', p_session_id));
    perform academy_op_end();
    return jsonb_build_object('ok', false, 'reason', 'mismatch');
  end if;

  -- who gets access
  v_v := v_co.version_id;
  if not exists (select 1 from academy_course_versions where id = v_v and status = 'published') then
    v_v := academy_commerce_live_version(v_co.course_id);
  end if;
  select * into v_l from academy_learners where email = v_co.buyer_email for update;
  if v_l.id is not null and v_l.status <> 'active' then v_access := 'needs_review'; v_note := 'the buyer''s Academy account is not active'; end if;
  if academy_access_is_staff(v_co.buyer_email) then v_access := 'needs_review'; v_note := 'HCPS staff addresses are not learners'; end if;
  if v_v is null then v_access := 'needs_review'; v_note := 'the course has no published version'; end if;

  if v_access = 'granted' then
    if v_l.id is null then
      insert into academy_learners (full_name, email) values (v_co.buyer_name, v_co.buyer_email) returning * into v_l;
      perform academy_op_audit('system', 'system:stripe', 'academy_learners', v_l.id::text, 'create_learner', null, to_jsonb(v_l));
    end if;
    -- the buyer's organization: re-used when this buyer already holds access through one of the same name
    select m.organization_id, m.id into v_org, v_m from academy_memberships m join academy_organizations o on o.id = m.organization_id
     where m.learner_id = v_l.id and m.status = 'active' and lower(o.name) = lower(v_co.organization_name) and o.status = 'active'
     order by m.started_at limit 1;
    if v_org is null then
      insert into academy_organizations (name, contact_email, created_by) values (v_co.organization_name, v_co.buyer_email, 'stripe:' || p_session_id)
      returning id into v_org;
      perform academy_op_audit('system', 'system:stripe', 'academy_organizations', v_org::text, 'create_organization', null,
        jsonb_build_object('name', v_co.organization_name, 'contact_email', v_co.buyer_email));
    end if;
    if v_m is null then
      insert into academy_memberships (learner_id, organization_id, role, access_type, created_by)
      values (v_l.id, v_org, 'learner', 'purchased', 'stripe:' || p_session_id) returning id into v_m;
      perform academy_op_audit('system', 'system:stripe', 'academy_memberships', v_m::text, 'purchase_access', null,
        jsonb_build_object('organization_id', v_org, 'learner_id', v_l.id));
    end if;
    select * into v_e from academy_enrollments where learner_id = v_l.id and version_id = v_v for update;
    if v_e.id is null then
      insert into academy_enrollments (learner_id, version_id, membership_id, access_source, assigned_by)
      values (v_l.id, v_v, v_m, 'purchase', 'stripe:' || p_session_id) returning * into v_e;
      perform academy_op_audit('system', 'system:stripe', 'academy_enrollments', v_e.id::text, 'enroll', null, to_jsonb(v_e));
    elsif v_e.status = 'withdrawn' or not exists (select 1 from academy_memberships m where m.id = v_e.membership_id and m.status = 'active') then
      update academy_enrollments set membership_id = v_m,
             status = case when v_e.status = 'withdrawn' then case when exists (select 1 from academy_progress p where p.enrollment_id = v_e.id) then 'in_progress' else 'not_started' end else status end,
             assigned_by = 'stripe:' || p_session_id
       where id = v_e.id returning * into v_e;
      perform academy_op_audit('system', 'system:stripe', 'academy_enrollments', v_e.id::text, 're_enroll', null, to_jsonb(v_e));
    else
      v_access := 'needs_review'; v_note := 'the buyer already has this course through other access';
    end if;
  end if;

  insert into academy_purchases (checkout_id, stripe_session_id, payment_intent_id, mode, amount_cents, currency, course_id, version_id,
                                 buyer_email, organization_id, learner_id, membership_id, enrollment_id, access, access_note)
  values (v_co.id, p_session_id, nullif(p_payment_intent, ''), p_mode, p_amount_cents, v_co.currency, v_co.course_id, v_v, v_co.buyer_email,
          case when v_access = 'granted' then v_org end, case when v_access = 'granted' then v_l.id end,
          case when v_access = 'granted' then v_m end, case when v_access = 'granted' then v_e.id end, v_access, v_note)
  returning * into v_pu;
  update academy_checkouts set status = 'completed', completed_at = now() where id = v_co.id;
  update academy_stripe_events set outcome = 'purchase:' || v_access where event_id = p_event_id;
  perform academy_op_audit('system', 'system:stripe', 'academy_purchases', v_pu.id::text, 'purchase', null,
    jsonb_build_object('amount_cents', p_amount_cents, 'mode', p_mode, 'course_id', v_co.course_id, 'access', v_access, 'note', v_note,
                       'email', v_co.buyer_email));
  perform academy_op_end();
  return jsonb_build_object('ok', true, 'duplicate', false, 'purchase_id', v_pu.id, 'access', v_access);
end $$;

-- An unpaid Checkout Session expired.
create function public.academy_commerce_op_checkout_expired(p_event_id text, p_mode text, p_session_id text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v academy_checkouts;
begin
  perform academy_op_begin('commerce_checkout_expired', 'system:stripe');
  if not academy_commerce_event_once(p_event_id, 'checkout.session.expired', p_mode, 'expired') then
    perform academy_op_end(); return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  select * into v from academy_checkouts where stripe_session_id = p_session_id for update;
  if found and v.status = 'open' then update academy_checkouts set status = 'expired' where id = v.id; end if;
  perform academy_op_end();
  return jsonb_build_object('ok', true);
end $$;

-- Stripe says how much of a payment has been refunded IN TOTAL. A full refund withdraws an unfinished enrollment;
-- a completed course and any certificate stay (an earned certificate is never invalidated by a refund).
create function public.academy_commerce_op_refund_record(p_event_id text, p_mode text, p_payment_intent text, p_refunded_total int)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v academy_purchases; v_e academy_enrollments; v_withdrawn boolean := false;
begin
  perform academy_op_begin('commerce_refund_record', 'system:stripe');
  if not academy_commerce_event_once(p_event_id, 'charge.refunded', p_mode, 'processing') then
    perform academy_op_end(); return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  select * into v from academy_purchases where payment_intent_id = p_payment_intent and mode = p_mode for update;
  if not found then
    update academy_stripe_events set outcome = 'unknown_payment' where event_id = p_event_id;
    perform academy_op_end(); return jsonb_build_object('ok', false, 'reason', 'unknown_payment');
  end if;
  if p_refunded_total is null or p_refunded_total < 0 or p_refunded_total > v.amount_cents then
    update academy_stripe_events set outcome = 'bad_amount' where event_id = p_event_id;
    perform academy_op_end(); return jsonb_build_object('ok', false, 'reason', 'bad_amount');
  end if;
  if p_refunded_total <= v.refunded_cents then   -- an older event arriving late never lowers the refunded total
    update academy_stripe_events set outcome = 'stale' where event_id = p_event_id;
    perform academy_op_end(); return jsonb_build_object('ok', true, 'stale', true);
  end if;
  update academy_purchases set refunded_cents = p_refunded_total,
         status = case when p_refunded_total = v.amount_cents then 'refunded' else status end,
         refunded_at = case when p_refunded_total = v.amount_cents then now() else refunded_at end
   where id = v.id;
  if p_refunded_total = v.amount_cents and v.enrollment_id is not null then
    select * into v_e from academy_enrollments where id = v.enrollment_id for update;
    if v_e.status in ('not_started','in_progress') then
      update academy_enrollments set status = 'withdrawn' where id = v_e.id;
      v_withdrawn := true;
    end if;
  end if;
  update academy_stripe_events set outcome = case when p_refunded_total = v.amount_cents then 'refunded' else 'partial_refund' end where event_id = p_event_id;
  perform academy_op_audit('system', 'system:stripe', 'academy_purchases', v.id::text, 'refund',
    jsonb_build_object('refunded_cents', v.refunded_cents, 'status', v.status),
    jsonb_build_object('refunded_cents', p_refunded_total, 'enrollment_withdrawn', v_withdrawn));
  perform academy_op_end();
  return jsonb_build_object('ok', true, 'purchase_id', v.id, 'full', p_refunded_total = v.amount_cents, 'enrollment_withdrawn', v_withdrawn);
end $$;

-- A dispute (chargeback) was opened: the purchase is marked for the President's review; access is left as it is.
create function public.academy_commerce_op_dispute(p_event_id text, p_mode text, p_payment_intent text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v academy_purchases;
begin
  perform academy_op_begin('commerce_dispute', 'system:stripe');
  if not academy_commerce_event_once(p_event_id, 'charge.dispute.created', p_mode, 'processing') then
    perform academy_op_end(); return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  select * into v from academy_purchases where payment_intent_id = p_payment_intent and mode = p_mode for update;
  if not found then
    update academy_stripe_events set outcome = 'unknown_payment' where event_id = p_event_id;
    perform academy_op_end(); return jsonb_build_object('ok', false, 'reason', 'unknown_payment');
  end if;
  if v.status <> 'refunded' then update academy_purchases set status = 'disputed' where id = v.id; end if;
  update academy_stripe_events set outcome = 'disputed' where event_id = p_event_id;
  perform academy_op_audit('system', 'system:stripe', 'academy_purchases', v.id::text, 'dispute', jsonb_build_object('status', v.status),
    jsonb_build_object('status', case when v.status = 'refunded' then v.status else 'disputed' end));
  perform academy_op_end();
  return jsonb_build_object('ok', true, 'purchase_id', v.id);
end $$;

-- ---------------------------------------------------------------------------------------------
-- 4. REFUNDS: the buyer asks (14 days), the President decides
-- ---------------------------------------------------------------------------------------------
create function public.academy_commerce_op_refund_request(p_actor text, p_purchase_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v academy_purchases;
begin
  select * into v from academy_purchases where id = p_purchase_id for update;
  if not found or v.learner_id is null then raise exception 'academy: purchase not found' using errcode = 'P0002'; end if;
  perform academy_op_actor_learner(p_actor, v.learner_id);
  if p_reason is null or length(btrim(p_reason)) < 5 or length(p_reason) > 500 then
    raise exception 'academy: tell us briefly why (5 to 500 characters)' using errcode = '22023';
  end if;
  if v.status <> 'paid' or v.refunded_cents > 0 then raise exception 'academy: a refund is already requested or settled for this purchase' using errcode = '22023'; end if;
  if v.paid_at < now() - interval '14 days' then
    raise exception 'academy: refunds can be requested within 14 days of purchase' using errcode = '22023';
  end if;
  perform academy_op_begin('commerce_refund_request', p_actor);
  update academy_purchases set status = 'refund_requested', refund_requested_at = now(), refund_request_reason = btrim(p_reason) where id = v.id;
  perform academy_op_audit('learner', p_actor, 'academy_purchases', v.id::text, 'refund_request', jsonb_build_object('status', v.status),
    jsonb_build_object('status', 'refund_requested', 'reason', btrim(p_reason)));
  perform academy_op_end();
  return jsonb_build_object('ok', true);
end $$;

-- approve: the purchase waits for Stripe's refund event (the server asks Stripe for the refund right after this).
-- decline: back to paid, with the reason kept. The President may also refund a purchase nobody asked about (approve).
create function public.academy_commerce_op_refund_decide(p_actor text, p_purchase_id uuid, p_decision text, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v academy_purchases;
begin
  perform academy_commerce_president(p_actor);
  if p_decision not in ('approve','decline') then raise exception 'academy: decide approve or decline' using errcode = '22023'; end if;
  if p_reason is null or length(btrim(p_reason)) < 5 or length(p_reason) > 500 then
    raise exception 'academy: a reason (5 to 500 characters) is required' using errcode = '22023';
  end if;
  select * into v from academy_purchases where id = p_purchase_id for update;
  if not found then raise exception 'academy: purchase not found' using errcode = 'P0002'; end if;
  if v.status = 'refunded' then raise exception 'academy: this purchase is already refunded' using errcode = '22023'; end if;
  if p_decision = 'decline' and v.status <> 'refund_requested' then raise exception 'academy: there is no request to decline' using errcode = '22023'; end if;
  if p_decision = 'approve' and v.payment_intent_id is null then raise exception 'academy: this purchase has no Stripe payment to refund' using errcode = '22023'; end if;
  perform academy_op_begin('commerce_refund_decide', p_actor);
  update academy_purchases set status = case when p_decision = 'approve' then 'refund_approved' else 'paid' end,
         review_note = btrim(p_reason) where id = v.id;
  perform academy_op_audit('staff', p_actor, 'academy_purchases', v.id::text, 'refund_' || p_decision,
    jsonb_build_object('status', v.status), jsonb_build_object('decision', p_decision, 'reason', btrim(p_reason)));
  perform academy_op_end();
  return jsonb_build_object('ok', true, 'payment_intent_id', case when p_decision = 'approve' then v.payment_intent_id end,
                            'mode', v.mode, 'amount_cents', v.amount_cents - v.refunded_cents);
end $$;

-- ---------------------------------------------------------------------------------------------
-- PRIVILEGES
-- ---------------------------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'academy_commerce_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
    if f.proname like 'academy_commerce_op_%' or f.proname = 'academy_commerce_eligibility' then
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- INSTALL CHECKS (each must read ok = true)
-- ---------------------------------------------------------------------------------------------
select 'M8 functions' as check, count(*) = 21 as ok from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like 'academy_commerce_%'
union all
select 'operations are security definer with a pinned path', bool_and(p.prosecdef and p.proconfig::text like '%search_path=pg_catalog, public, pg_temp%')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and (p.proname like 'academy_commerce_op_%' or p.proname = 'academy_commerce_eligibility')
union all
select 'server calls the 11 operations + eligibility and nothing else of M8',
       count(*) filter (where has_function_privilege('service_role', p.oid, 'execute')) = 12
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like 'academy_commerce_%'
union all
select 'anon and authenticated call nothing of M8', not bool_or(has_function_privilege(r, p.oid, 'execute'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(array['anon','authenticated']) r
 where n.nspname = 'public' and p.proname like 'academy_commerce_%'
union all
select 'new tables: RLS on, no policies, server reads only, nothing for anon / authenticated',
       bool_and(c.relrowsecurity and not exists (select 1 from pg_policy where polrelid = c.oid)
                and has_table_privilege('service_role', c.oid, 'select') and not has_table_privilege('service_role', c.oid, 'insert')
                and not has_table_privilege('service_role', c.oid, 'update') and not has_table_privilege('service_role', c.oid, 'delete')
                and not has_table_privilege('anon', c.oid, 'select') and not has_table_privilege('authenticated', c.oid, 'select'))
  from pg_class c where c.oid in ('public.academy_organizations'::regclass, 'public.academy_eligibility_overrides'::regclass,
    'public.academy_course_prices'::regclass, 'public.academy_course_price_history'::regclass, 'public.academy_buyer_reviews'::regclass,
    'public.academy_checkouts'::regclass, 'public.academy_purchases'::regclass, 'public.academy_stripe_events'::regclass)
union all
select 'guards on all 8 tables + memberships', (select count(*) from pg_trigger where tgname in ('academy_commerce_guard','academy_commerce_guard_truncate')) = 16
   and exists (select 1 from pg_trigger where tgname = 'academy_commerce_membership_guard')
union all
select 'membership owner check present', exists (select 1 from pg_constraint where conname = 'academy_memberships_one_owner')
   and exists (select 1 from pg_constraint where conname = 'academy_memberships_outside_shape')
union all
select 'no commerce records written', not exists (select 1 from academy_organizations) and not exists (select 1 from academy_course_prices)
   and not exists (select 1 from academy_purchases) and not exists (select 1 from academy_checkouts);

commit;

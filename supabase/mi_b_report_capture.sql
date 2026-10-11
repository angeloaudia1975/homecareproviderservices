-- ============================================================================================
-- MI Inbox Automation — Phase B (B1): automatic capture of manufacturer report email.
-- Approved for development by Angelo 2026-10-11 16:44 CT (CLAUDE.md §18). Runs AFTER MI-1b (mfr_sources report kinds,
-- hcps_mfr_report_register) and MI-1c. Safe to run twice.
--
-- What it adds
--   mfr_report_profiles       the approved rules per manufacturer + report kind (active / draft / retired)
--   mfr_report_capture_state  one row per captured mailbox: discovery checkpoint + run lease
--   mfr_report_capture_runs   one row per capture run (counts, checkpoint before/after, error)
--   mfr_report_messages       one row per report email per mailbox (Outlook identity = provenance)
--   mfr_report_items          one row per report attachment (or email body) of that email, with its state:
--                               discovered → classified | registered | linked | exception (durable retry queue)
--                               | ignored | processed (set later by an importer; never in Phase B)
--   mfr_report_capture_events append-only audit of every exception, registration and person's decision
--   hcps_mfr_capture_* functions — the ONLY way any of these rows change.
--
-- What it never does: import sales or commissions, accept or publish a report, touch dealers / reps / aliases /
-- contacts / deals / campaigns / Zoho, or send email. Registration goes through MI-1b's own
-- hcps_mfr_report_register (same file hash = the existing record is LINKED, never duplicated).
--
-- The switch: every capture write requires app_settings.phase2_flags.mi_report_capture to be exactly true (checked in
-- the database, on every call). This migration does NOT turn it on. A person's resolve decision does not need it.
--
-- RULE 19: every new table has RLS on and no policies; anon / authenticated / PUBLIC hold nothing; service_role may
-- only SELECT (all writes go through the security-definer functions, executable by service_role only). After running:
-- outside public-key probe (scripts/mi_b_public_probe_browser.js) — expect 401 / 42501 everywhere.
-- pg-safeupdate: every UPDATE / DELETE here carries a WHERE clause.
-- ============================================================================================
begin;

do $$ begin
  if to_regclass('public.mfr_sources') is null or to_regprocedure('public.hcps_mfr_report_register(jsonb)') is null then
    raise exception 'mi_b: MI-1b (mfr_sources report register) must be installed first'; end if;
  if to_regclass('public.app_settings') is null then raise exception 'mi_b: app_settings missing (holds the capture switch)'; end if;
  if to_regclass('public.manufacturers') is null then raise exception 'mi_b: manufacturers missing'; end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 1. Tables
create table if not exists public.mfr_report_profiles (
  id            bigserial primary key,
  code          text not null unique,
  manufacturer  text not null references public.manufacturers(slug),
  kind          text not null check (kind in ('sales_export','commission_statement','dealer_report')),
  label         text not null,
  status        text not null default 'draft' check (status in ('active','draft','retired')),
  rules         jsonb not null check (jsonb_typeof(rules) = 'object'),
  auto_register boolean not null default false,
  auto_import   boolean not null default false check (auto_import = false),          -- Phase B: never
  note          text,
  created_at    timestamptz not null default now(),
  created_by    text not null default 'migration',
  updated_at    timestamptz,
  updated_by    text,
  check (status = 'active' or auto_register = false)                                  -- only an active profile registers
);

create table if not exists public.mfr_report_capture_state (
  mailbox         text primary key check (mailbox = lower(mailbox) and mailbox like '%@%'),
  checkpoint_at   timestamptz not null,
  overlap_minutes integer not null default 360 check (overlap_minutes between 60 and 20160),   -- 6 hours re-listed every run
  lock_token      text,
  lock_until      timestamptz,
  last_run_at     timestamptz,
  last_ok_at      timestamptz,
  last_error      text,
  updated_at      timestamptz not null default now()
);

create table if not exists public.mfr_report_capture_runs (
  id                 bigserial primary key,
  mailbox            text not null references public.mfr_report_capture_state(mailbox),
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,
  checkpoint_before  timestamptz,
  checkpoint_after   timestamptz,
  complete           boolean,
  counts             jsonb,
  error              text
);

create table if not exists public.mfr_report_messages (
  id                  bigserial primary key,
  mailbox             text not null,
  internet_message_id text not null check (length(internet_message_id) > 0),
  graph_id            text,                       -- Graph immutable id: a locator, never the identity
  web_link            text,
  received_at         timestamptz not null,       -- Outlook's received timestamp (provenance; never edited)
  from_address        text,
  from_name           text,
  subject             text,
  folder              text,
  manufacturer        text,                       -- identified sender (null = unknown sender)
  match_basis         text,
  has_attachments     boolean not null default false,
  items_listed        boolean not null default false,
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  first_run_id        bigint,
  unique (mailbox, internet_message_id)
);
create index if not exists mfr_report_messages_received_ix on public.mfr_report_messages (mailbox, received_at);

create table if not exists public.mfr_report_items (
  id               bigserial primary key,
  message_id       bigint not null references public.mfr_report_messages(id),
  item_key         text not null,               -- 'att:<n>:<name>:<size>' | 'body' | 'listing'
  part             text not null check (part in ('attachment','body','listing')),
  ordinal          integer,
  file_name        text,
  content_type     text,
  size             bigint,
  sha256           text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  format           text,
  signals          jsonb,                       -- derived signals only — never file content
  manufacturer     text,
  profile_id       bigint references public.mfr_report_profiles(id),
  kind             text check (kind is null or kind in ('sales_export','commission_statement','dealer_report')),
  suggested        text,                         -- what the content looks like (incl. price_list / other / not_a_report)
  period_start     date,
  period_end       date,
  period_basis     text,
  cumulative       boolean,
  prepared_date    date,
  state            text not null default 'discovered'
                   check (state in ('discovered','classified','registered','linked','exception','ignored','processed')),
  attention        text check (attention is null or attention in ('unknown_sender','unidentified_type','format_changed',
                     'ambiguous_profile','period_unknown','period_conflict','duplicate_conflict','correction_needs_decision',
                     'possible_correction','attachment_failed','listing_failed','too_large','unreadable','storage_failed',
                     'register_failed','content_changed','cloud_attachment')),
  attention_detail text,
  retryable        boolean not null default false,
  attempts         integer not null default 0,
  next_retry_at    timestamptz,
  source_id        bigint references public.mfr_sources(id),
  resolved_at      timestamptz,
  resolved_by      text,
  resolution       text check (resolution is null or resolution in ('dismissed','ignored','retry_requested')),
  resolution_reason text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (message_id, item_key),
  check (state not in ('registered','linked','processed') or (source_id is not null and sha256 is not null and kind is not null)),
  check (state <> 'exception' or attention is not null),
  check (period_start is null or period_end is null or period_start <= period_end)
);
create index if not exists mfr_report_items_queue_ix on public.mfr_report_items (state, next_retry_at) where state = 'exception';
create index if not exists mfr_report_items_sha_ix on public.mfr_report_items (sha256);

create table if not exists public.mfr_report_capture_events (
  id         bigserial primary key,
  item_id    bigint references public.mfr_report_items(id),
  message_id bigint references public.mfr_report_messages(id),
  action     text not null,
  actor      text not null check (length(trim(actor)) > 0),
  reason     text,
  detail     jsonb,
  at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------
-- 2. RULE 19: closed to ordinary users; service_role reads only. Writes go through the functions below.
do $$ declare t text; begin
  foreach t in array array['mfr_report_profiles','mfr_report_capture_state','mfr_report_capture_runs','mfr_report_messages',
                           'mfr_report_items','mfr_report_capture_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to service_role', t);
  end loop;
  foreach t in array array['mfr_report_profiles_id_seq','mfr_report_capture_runs_id_seq','mfr_report_messages_id_seq',
                           'mfr_report_items_id_seq','mfr_report_capture_events_id_seq'] loop
    execute format('revoke all on sequence public.%I from public, anon, authenticated, service_role', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 3. Guard: rows change only inside the capture functions (session marker + the owner's rights); the event log is
--    append-only for everyone; nothing is ever deleted or truncated.
create or replace function public.hcps_mfr_capture_guard()
returns trigger language plpgsql as $$
declare v_owner text;
begin
  if tg_level = 'STATEMENT' then raise exception 'mfr_capture_guard: % of % is not allowed', tg_op, tg_table_name; end if;
  if tg_op = 'DELETE' then raise exception 'mfr_capture_guard: rows of % are never deleted', tg_table_name; end if;
  if tg_table_name = 'mfr_report_capture_events' and tg_op = 'UPDATE' then
    raise exception 'mfr_capture_guard: the capture event log is append-only'; end if;
  select pg_get_userbyid(relowner) into v_owner from pg_class where oid = tg_relid;
  if coalesce(current_setting('hcps.capture_op', true), '') <> 'on' or current_user <> v_owner then
    raise exception 'mfr_capture_guard: % of % happens only through the hcps_mfr_capture_* functions', tg_op, tg_table_name;
  end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['mfr_report_profiles','mfr_report_capture_state','mfr_report_capture_runs','mfr_report_messages',
                           'mfr_report_items','mfr_report_capture_events'] loop
    execute format('drop trigger if exists mfr_capture_guard on public.%I', t);
    execute format('create trigger mfr_capture_guard before insert or update or delete on public.%I for each row execute function public.hcps_mfr_capture_guard()', t);
    execute format('drop trigger if exists mfr_capture_guard_truncate on public.%I', t);
    execute format('create trigger mfr_capture_guard_truncate before truncate on public.%I for each statement execute function public.hcps_mfr_capture_guard()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 4. Helpers (owner only)
create or replace function public.hcps_mfr_capture_switch_on()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select value->'mi_report_capture' = 'true'::jsonb from public.app_settings where key = 'phase2_flags'), false)
$$;

-- A capture write needs the switch ON and the caller's live lease on that mailbox.
create or replace function public.hcps_mfr_capture_lease(p_mailbox text, p_token text, p_need_switch boolean default true)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.mfr_report_capture_state;
begin
  if p_need_switch and not hcps_mfr_capture_switch_on() then raise exception 'capture_switch_off: phase2_flags.mi_report_capture is not true'; end if;
  select * into s from public.mfr_report_capture_state where mailbox = lower(p_mailbox);
  if not found then raise exception 'capture_mailbox_unknown: %', p_mailbox; end if;
  if s.lock_token is null or s.lock_token <> coalesce(p_token, '') or s.lock_until < now() then
    raise exception 'capture_lease_lost: this run no longer holds the capture lease for %', p_mailbox; end if;
end $$;

create or replace function public.hcps_mfr_capture_event(p_item bigint, p_msg bigint, p_action text, p_actor text, p_reason text, p_detail jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.mfr_report_capture_events (item_id, message_id, action, actor, reason, detail)
  values (p_item, p_msg, p_action, p_actor, p_reason, p_detail);
end $$;

-- An item that is final for the capture (anything but 'discovered' is accounted for; these never change automatically).
create or replace function public.hcps_mfr_capture_settled(p_state text)
returns boolean language sql immutable as $$ select p_state in ('registered','linked','ignored','processed') $$;

-- ---------------------------------------------------------------------------------------------
-- 5. Capture functions (service_role)

-- begin: take the mailbox lease (one run at a time) and open a run row.
create or replace function public.hcps_mfr_capture_begin(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_mb text := lower(nullif(trim(p->>'mailbox'), '')); v_tok text := nullif(trim(p->>'token'), '');
  v_lease int := least(greatest(coalesce((p->>'lease_seconds')::int, 90), 30), 300); s public.mfr_report_capture_state; v_run bigint;
begin
  if not hcps_mfr_capture_switch_on() then raise exception 'capture_switch_off: phase2_flags.mi_report_capture is not true'; end if;
  if v_tok is null or length(v_tok) < 16 then raise exception 'capture_bad_token'; end if;
  perform set_config('hcps.capture_op', 'on', true);
  select * into s from public.mfr_report_capture_state where mailbox = v_mb for update;
  if not found then raise exception 'capture_mailbox_unknown: %', v_mb; end if;
  if s.lock_until is not null and s.lock_until > now() and s.lock_token is distinct from v_tok then
    perform set_config('hcps.capture_op', 'off', true);
    return jsonb_build_object('ok', true, 'busy', true, 'lock_until', s.lock_until);
  end if;
  update public.mfr_report_capture_state set lock_token = v_tok, lock_until = now() + make_interval(secs => v_lease),
         last_run_at = now(), updated_at = now() where mailbox = v_mb;
  insert into public.mfr_report_capture_runs (mailbox, checkpoint_before) values (v_mb, s.checkpoint_at) returning id into v_run;
  perform set_config('hcps.capture_op', 'off', true);
  return jsonb_build_object('ok', true, 'busy', false, 'run_id', v_run, 'checkpoint_at', s.checkpoint_at, 'overlap_minutes', s.overlap_minutes);
end $$;

-- record: the email (identity = mailbox + internetMessageId) and, once listed, its items. Idempotent: a re-listed
-- email only refreshes its locator; its identity, received time and items already recorded never change.
create or replace function public.hcps_mfr_capture_record(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_mb text := lower(p->>'mailbox'); m jsonb := p->'message'; v_id bigint; v_listed boolean; it jsonb; v_items jsonb;
begin
  perform hcps_mfr_capture_lease(v_mb, p->>'token');
  if coalesce(m->>'internet_message_id', '') = '' or (m->>'received_at') is null then raise exception 'capture_bad_message'; end if;
  perform set_config('hcps.capture_op', 'on', true);
  insert into public.mfr_report_messages (mailbox, internet_message_id, graph_id, web_link, received_at, from_address, from_name, subject,
      folder, manufacturer, match_basis, has_attachments, first_run_id)
  values (v_mb, m->>'internet_message_id', m->>'graph_id', m->>'web_link', (m->>'received_at')::timestamptz, lower(m->>'from_address'),
      m->>'from_name', left(m->>'subject', 500), m->>'folder', nullif(m->>'manufacturer', ''), m->>'match_basis',
      coalesce((m->>'has_attachments')::boolean, false), nullif(p->>'run_id', '')::bigint)
  on conflict (mailbox, internet_message_id) do update
     set graph_id = excluded.graph_id, web_link = coalesce(excluded.web_link, public.mfr_report_messages.web_link),
         folder = excluded.folder, last_seen_at = now()
     where public.mfr_report_messages.mailbox = excluded.mailbox
  returning id, items_listed into v_id, v_listed;
  -- relist: the attachment list could not be read before (a 'listing' placeholder in the queue). Its items are added
  -- now and the placeholder is closed; items already recorded never change.
  if jsonb_typeof(p->'items') = 'array' and v_listed and coalesce((p->>'relist')::boolean, false)
     and exists (select 1 from public.mfr_report_items where message_id = v_id and part = 'listing' and state = 'exception') then
    update public.mfr_report_items set state = 'ignored', resolved_at = now(), resolved_by = 'system:report-capture', resolution = 'ignored',
           resolution_reason = 'attachment list read again', retryable = false, next_retry_at = null, updated_at = now()
     where message_id = v_id and part = 'listing' and state = 'exception';
    perform hcps_mfr_capture_event(null, v_id, 'relisted', 'system:report-capture', null, null);
    v_listed := false;
  end if;
  if jsonb_typeof(p->'items') = 'array' and not v_listed then
    for it in select * from jsonb_array_elements(p->'items') loop
      if coalesce(it->>'item_key', '') = '' or (it->>'part') not in ('attachment','body','listing') then raise exception 'capture_bad_item'; end if;
      insert into public.mfr_report_items (message_id, item_key, part, ordinal, file_name, content_type, size)
      values (v_id, it->>'item_key', it->>'part', (it->>'ordinal')::int, left(it->>'file_name', 300), it->>'content_type', (it->>'size')::bigint)
      on conflict (message_id, item_key) do nothing;
    end loop;
    update public.mfr_report_messages set items_listed = true where id = v_id;
    v_listed := true;
  end if;
  perform set_config('hcps.capture_op', 'off', true);
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'item_key', i.item_key, 'part', i.part, 'ordinal', i.ordinal, 'file_name', i.file_name,
           'content_type', i.content_type, 'size', i.size, 'state', i.state, 'attention', i.attention, 'retryable', i.retryable,
           'attempts', i.attempts, 'sha256', i.sha256) order by i.id), '[]'::jsonb)
    into v_items from public.mfr_report_items i where i.message_id = v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'items_listed', v_listed, 'items', v_items);
end $$;

-- classify: what the item is (or why it needs a person). Settled items never change here.
create or replace function public.hcps_mfr_capture_classify(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_mb text := lower(p->>'mailbox'); i public.mfr_report_items; v_out text := p->>'outcome'; v_att text := nullif(p->>'attention', '');
  v_sha text := nullif(lower(p->>'sha256'), ''); v_prof public.mfr_report_profiles; v_msg public.mfr_report_messages;
begin
  perform hcps_mfr_capture_lease(v_mb, p->>'token');
  select * into i from public.mfr_report_items where id = (p->>'item_id')::bigint for update;
  if not found then raise exception 'capture_item_unknown'; end if;
  select * into v_msg from public.mfr_report_messages where id = i.message_id;
  if v_msg.mailbox <> v_mb then raise exception 'capture_item_other_mailbox'; end if;
  if hcps_mfr_capture_settled(i.state) then return jsonb_build_object('ok', true, 'unchanged', true, 'state', i.state); end if;
  if v_out not in ('classified','exception') then raise exception 'capture_bad_outcome: %', v_out; end if;
  if v_out = 'exception' and v_att is null then raise exception 'capture_attention_required'; end if;
  if nullif(p->>'profile_id', '') is not null then
    select * into v_prof from public.mfr_report_profiles where id = (p->>'profile_id')::bigint;
    if not found or v_prof.status = 'retired' then raise exception 'capture_bad_profile'; end if;
    if v_prof.kind is distinct from nullif(p->>'kind', '') or v_prof.manufacturer is distinct from nullif(p->>'manufacturer', '') then
      raise exception 'capture_profile_mismatch: profile % is a % report of %', v_prof.code, v_prof.kind, v_prof.manufacturer; end if;
  end if;
  perform set_config('hcps.capture_op', 'on', true);
  if i.sha256 is not null and v_sha is not null and i.sha256 <> v_sha then
    -- The same Outlook attachment now holds different bytes: never overwrite what was recorded.
    update public.mfr_report_items set state = 'exception', attention = 'content_changed', retryable = false,
      attention_detail = 'recorded ' || i.sha256 || ', now ' || v_sha, updated_at = now() where id = i.id;
    perform hcps_mfr_capture_event(i.id, i.message_id, 'exception', 'system:report-capture', 'content_changed', jsonb_build_object('new_sha256', v_sha));
    perform set_config('hcps.capture_op', 'off', true);
    return jsonb_build_object('ok', true, 'state', 'exception', 'attention', 'content_changed');
  end if;
  update public.mfr_report_items set
      sha256 = coalesce(v_sha, sha256), format = coalesce(p->>'format', format), signals = coalesce(p->'signals', signals),
      manufacturer = nullif(p->>'manufacturer', ''), profile_id = nullif(p->>'profile_id', '')::bigint, kind = nullif(p->>'kind', ''),
      suggested = nullif(p->>'suggested', ''), period_start = nullif(p->>'period_start', '')::date, period_end = nullif(p->>'period_end', '')::date,
      period_basis = nullif(p->>'period_basis', ''), cumulative = nullif(p->>'cumulative', '')::boolean,
      prepared_date = nullif(p->>'prepared_date', '')::date,
      state = v_out, attention = case when v_out = 'exception' then v_att end, attention_detail = left(nullif(p->>'detail', ''), 2000),
      retryable = false, next_retry_at = null,
      resolved_at = case when v_out = 'exception' then null else resolved_at end,
      resolution = case when v_out = 'exception' then null else resolution end, updated_at = now()
   where id = i.id;
  if v_out = 'exception' then
    perform hcps_mfr_capture_event(i.id, i.message_id, 'exception', 'system:report-capture', v_att, jsonb_build_object('detail', left(p->>'detail', 500)));
  end if;
  perform set_config('hcps.capture_op', 'off', true);
  return jsonb_build_object('ok', true, 'state', v_out, 'attention', v_att);
end $$;

-- fail: a technical failure (download, storage, listing, size). Durable retry queue with backoff; never blocks
-- discovery (an exception is accounted for). After 8 attempts it stops retrying and waits for a person.
create or replace function public.hcps_mfr_capture_fail(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_mb text := lower(p->>'mailbox'); i public.mfr_report_items; v_att text := p->>'attention';
  v_retry boolean := coalesce((p->>'retryable')::boolean, true); v_n int; v_msg public.mfr_report_messages;
begin
  perform hcps_mfr_capture_lease(v_mb, p->>'token');
  if v_att not in ('attachment_failed','listing_failed','too_large','unreadable','storage_failed','register_failed','cloud_attachment') then
    raise exception 'capture_bad_attention: %', v_att; end if;
  select * into i from public.mfr_report_items where id = (p->>'item_id')::bigint for update;
  if not found then raise exception 'capture_item_unknown'; end if;
  select * into v_msg from public.mfr_report_messages where id = i.message_id;
  if v_msg.mailbox <> v_mb then raise exception 'capture_item_other_mailbox'; end if;
  if hcps_mfr_capture_settled(i.state) then return jsonb_build_object('ok', true, 'unchanged', true, 'state', i.state); end if;
  v_n := i.attempts + 1;
  if v_n >= 8 then v_retry := false; end if;
  perform set_config('hcps.capture_op', 'on', true);
  update public.mfr_report_items set state = 'exception', attention = v_att, attention_detail = left(p->>'detail', 2000),
      attempts = v_n, retryable = v_retry,
      next_retry_at = case when v_retry then now() + least(interval '15 minutes' * power(2, v_n - 1), interval '24 hours') end,
      resolved_at = null, resolution = null, updated_at = now()
   where id = i.id;
  perform hcps_mfr_capture_event(i.id, i.message_id, 'exception', 'system:report-capture', v_att,
    jsonb_build_object('attempt', v_n, 'retryable', v_retry, 'detail', left(p->>'detail', 500)));
  perform set_config('hcps.capture_op', 'off', true);
  return jsonb_build_object('ok', true, 'state', 'exception', 'attempts', v_n, 'retryable', v_retry);
end $$;

-- register: hand a classified item of an ACTIVE, auto-registering profile to MI-1b's register, in the same transaction
-- as the item's new state. The register's own answer decides: a new record → 'registered'; the same file already
-- registered → 'linked' to that record (never a duplicate). A refusal becomes a recorded exception, not a lost email.
create or replace function public.hcps_mfr_capture_register(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_mb text := lower(p->>'mailbox'); i public.mfr_report_items; v_msg public.mfr_report_messages; v_prof public.mfr_report_profiles;
  r jsonb := p->'register'; v_res jsonb; v_err text; v_code text; v_att text; v_retry boolean; v_ext text; v_other bigint; v_state text;
  v_recv date;
begin
  perform hcps_mfr_capture_lease(v_mb, p->>'token');
  select * into i from public.mfr_report_items where id = (p->>'item_id')::bigint for update;
  if not found then raise exception 'capture_item_unknown'; end if;
  select * into v_msg from public.mfr_report_messages where id = i.message_id;
  if v_msg.mailbox <> v_mb then raise exception 'capture_item_other_mailbox'; end if;
  if hcps_mfr_capture_settled(i.state) then return jsonb_build_object('ok', true, 'unchanged', true, 'state', i.state, 'source_id', i.source_id); end if;
  if i.state <> 'classified' or i.profile_id is null or i.sha256 is null or i.period_start is null then
    raise exception 'capture_not_ready: item % must be classified under a profile, hashed and given a period first', i.id; end if;
  select * into v_prof from public.mfr_report_profiles where id = i.profile_id;
  if v_prof.status <> 'active' or not v_prof.auto_register then raise exception 'capture_profile_inactive: % does not register automatically', v_prof.code; end if;
  -- The register request must describe exactly this item; the received date is Outlook's, in Chicago.
  v_recv := (v_msg.received_at at time zone 'America/Chicago')::date;
  v_ext := lower(substring(r->>'storage_path' from '\.([a-z0-9]+)$'));
  if r->>'manufacturer' is distinct from v_prof.manufacturer or r->>'kind' is distinct from v_prof.kind
     or lower(r->>'file_sha256') is distinct from i.sha256
     or (r->>'report_period_start')::date is distinct from i.period_start or (r->>'report_period_end')::date is distinct from i.period_end
     or (r->>'received_date')::date is distinct from v_recv
     or nullif(r->>'prepared_date', '')::date is distinct from i.prepared_date
     or r->>'storage_path' is distinct from 'reports/' || v_prof.manufacturer || '/' || v_prof.kind || '/' || i.sha256 || '.' || v_ext
     or coalesce(nullif(r->>'supersedes_id', ''), nullif(r->>'supersede_reason', '')) is not null then
    raise exception 'capture_register_mismatch: the register request does not match item %', i.id; end if;
  r := r || jsonb_build_object('actor', 'system:report-capture');
  begin
    v_res := public.hcps_mfr_report_register(r);
  exception when others then
    v_err := sqlerrm;
  end;
  perform set_config('hcps.capture_op', 'on', true);
  if v_err is null then
    v_state := case when coalesce((v_res->>'existing')::boolean, false) then 'linked' else 'registered' end;
    -- Another record of the same manufacturer, kind and period (a different file): flag it for a look, never block.
    select s.id into v_other from public.mfr_sources s
     where s.manufacturer = v_prof.manufacturer and s.kind = v_prof.kind and s.report_period_start = i.period_start
       and s.report_period_end = i.period_end and s.id <> (v_res->>'id')::bigint and s.status in ('received','accepted') limit 1;
    update public.mfr_report_items set state = v_state, source_id = (v_res->>'id')::bigint, kind = v_prof.kind,
        attention = case when v_other is not null and v_state = 'registered' then 'possible_correction' end,
        attention_detail = case when v_other is not null and v_state = 'registered' then 'record ' || v_other || ' already covers this period' end,
        retryable = false, next_retry_at = null, updated_at = now()
     where id = i.id;
    perform hcps_mfr_capture_event(i.id, i.message_id, v_state, 'system:report-capture', null,
      jsonb_build_object('source_id', (v_res->>'id')::bigint, 'existing', coalesce((v_res->>'existing')::boolean, false)));
    perform set_config('hcps.capture_op', 'off', true);
    return jsonb_build_object('ok', true, 'state', v_state, 'source_id', (v_res->>'id')::bigint, 'possible_correction', v_other);
  end if;
  v_code := coalesce(substring(v_err from '(mi1b_[a-z_]+|mfr_report_guard|mfr_sources_[a-z_]+)'), 'database_error');
  v_att := case v_code when 'mi1b_period_already_registered' then 'correction_needs_decision'
                       when 'mi1b_hash_registered_as_other_kind' then 'duplicate_conflict' else 'register_failed' end;
  v_retry := v_att = 'register_failed' and i.attempts + 1 < 8;
  update public.mfr_report_items set state = 'exception', attention = v_att, attention_detail = left(v_err, 2000),
      attempts = i.attempts + 1, retryable = v_retry,
      next_retry_at = case when v_retry then now() + least(interval '15 minutes' * power(2, i.attempts), interval '24 hours') end,
      updated_at = now()
   where id = i.id;
  perform hcps_mfr_capture_event(i.id, i.message_id, 'exception', 'system:report-capture', v_att, jsonb_build_object('code', v_code, 'message', left(v_err, 500)));
  perform set_config('hcps.capture_op', 'off', true);
  return jsonb_build_object('ok', true, 'state', 'exception', 'attention', v_att, 'code', v_code);
end $$;

-- finish: close the run, release the lease, and move the checkpoint — never past an email that is not accounted for
-- (an item still 'discovered', or a recorded report email whose attachments / body were never listed).
create or replace function public.hcps_mfr_capture_finish(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_mb text := lower(p->>'mailbox'); s public.mfr_report_capture_state; v_cp timestamptz := nullif(p->>'checkpoint_at', '')::timestamptz;
  v_block timestamptz; v_new timestamptz;
begin
  perform hcps_mfr_capture_lease(v_mb, p->>'token', false);     -- a run may always close, even after the switch went off
  select * into s from public.mfr_report_capture_state where mailbox = v_mb for update;
  if v_cp is not null then
    select min(m.received_at) into v_block from public.mfr_report_messages m
     where m.mailbox = v_mb and m.received_at <= v_cp
       and (not m.items_listed
            or exists (select 1 from public.mfr_report_items i where i.message_id = m.id and i.state = 'discovered'));
    if v_block is not null then
      raise exception 'capture_checkpoint_unaccounted: an email received % is not accounted for yet', v_block; end if;
  end if;
  v_new := greatest(s.checkpoint_at, coalesce(v_cp, s.checkpoint_at));
  perform set_config('hcps.capture_op', 'on', true);
  update public.mfr_report_capture_state set checkpoint_at = v_new, lock_token = null, lock_until = null,
         last_ok_at = case when nullif(p->>'error', '') is null then now() else last_ok_at end,
         last_error = nullif(left(p->>'error', 2000), ''), updated_at = now()
   where mailbox = v_mb;
  update public.mfr_report_capture_runs set finished_at = now(), checkpoint_after = v_new, complete = coalesce((p->>'complete')::boolean, false),
         counts = p->'counts', error = nullif(left(p->>'error', 2000), '')
   where id = nullif(p->>'run_id', '')::bigint and mailbox = v_mb and finished_at is null;
  perform set_config('hcps.capture_op', 'off', true);
  return jsonb_build_object('ok', true, 'checkpoint_at', v_new);
end $$;

-- resolve: a person's decision on a Needs Attention item (the API passes the verified sign-in as 'staff:<email>').
--   dismiss — keep it as it is, out of the queue (reason kept);  ignore — not a report;  retry — process it again now.
-- No switch needed: a person can always clear the queue. Registered / linked / processed items are never un-done here.
create or replace function public.hcps_mfr_capture_resolve(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare i public.mfr_report_items; v_act text := p->>'action'; v_actor text := nullif(trim(p->>'actor'), '');
  v_reason text := nullif(trim(p->>'reason'), '');
begin
  if v_actor is null or v_actor !~ '^staff:[^@\s]+@[^@\s]+$' then raise exception 'capture_actor_required'; end if;
  if v_reason is null or length(v_reason) < 3 then raise exception 'capture_reason_required'; end if;
  if v_act not in ('dismiss','ignore','retry') then raise exception 'capture_bad_action: %', v_act; end if;
  select * into i from public.mfr_report_items where id = (p->>'item_id')::bigint for update;
  if not found then raise exception 'capture_item_unknown'; end if;
  perform set_config('hcps.capture_op', 'on', true);
  if v_act = 'dismiss' then
    if i.attention is null or i.resolved_at is not null then raise exception 'capture_nothing_to_resolve'; end if;
    update public.mfr_report_items set resolved_at = now(), resolved_by = v_actor, resolution = 'dismissed', resolution_reason = v_reason,
           retryable = false, next_retry_at = null, updated_at = now() where id = i.id;
  elsif v_act = 'ignore' then
    if i.state not in ('discovered','classified','exception') then raise exception 'capture_cannot_ignore: item is %', i.state; end if;
    update public.mfr_report_items set state = 'ignored', resolved_at = now(), resolved_by = v_actor, resolution = 'ignored',
           resolution_reason = v_reason, retryable = false, next_retry_at = null, updated_at = now() where id = i.id;
  else
    if i.state not in ('classified','exception') then raise exception 'capture_cannot_retry: item is %', i.state; end if;
    update public.mfr_report_items set state = 'exception', attention = coalesce(attention, 'unidentified_type'),
           attention_detail = coalesce(attention_detail, 'retry requested'), retryable = true, next_retry_at = now(),
           resolved_at = null, resolved_by = v_actor, resolution = 'retry_requested', resolution_reason = v_reason, updated_at = now()
     where id = i.id;
  end if;
  perform hcps_mfr_capture_event(i.id, i.message_id, v_act, v_actor, v_reason, jsonb_build_object('state_before', i.state, 'attention', i.attention));
  perform set_config('hcps.capture_op', 'off', true);
  return jsonb_build_object('ok', true, 'item_id', i.id, 'action', v_act);
end $$;

-- ---------------------------------------------------------------------------------------------
-- 6. Execute rights: the capture/resolve functions to service_role only; helpers to nobody but the owner (RULE 19).
do $$ declare f text; begin
  foreach f in array array['public.hcps_mfr_capture_guard()', 'public.hcps_mfr_capture_switch_on()', 'public.hcps_mfr_capture_lease(text,text,boolean)',
    'public.hcps_mfr_capture_event(bigint,bigint,text,text,text,jsonb)', 'public.hcps_mfr_capture_settled(text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
  foreach f in array array['public.hcps_mfr_capture_begin(jsonb)', 'public.hcps_mfr_capture_record(jsonb)', 'public.hcps_mfr_capture_classify(jsonb)',
    'public.hcps_mfr_capture_fail(jsonb)', 'public.hcps_mfr_capture_register(jsonb)', 'public.hcps_mfr_capture_finish(jsonb)',
    'public.hcps_mfr_capture_resolve(jsonb)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 7. Seed: the captured mailbox (from 1 Oct 2026, Chicago) and the report profiles. Existing rows are left as they are.
select set_config('hcps.capture_op', 'on', true);
insert into public.mfr_report_capture_state (mailbox, checkpoint_at)
values ('angelo@homecareproviderservices.us', '2026-10-01 00:00:00 America/Chicago')
on conflict (mailbox) do nothing;

insert into public.mfr_report_profiles (code, manufacturer, kind, label, status, auto_register, rules, note) values
-- ACTIVE — Strongback (the pilot). Content decides, never the subject.
('strongback-mobility:commission_statement:sr032', 'strongback-mobility', 'commission_statement', 'Monthly commission statement (SR032 PDF)', 'active', true,
 '{"senders":{"domains":["strongbackmobility.com"]},"formats":["pdf"],"file_name":"^\\d{4}-\\d{2}\\s*SR\\d+[^/]*\\.pdf$",
   "content":{"pdf_signals_all":["commission"]},"period":{"order":["file_name","content","received_prior_month"]},
   "expected":{"cadence":"monthly","days":[2,7]}}',
 'Phase A: amanda.erickson, monthly 2nd-7th; Mar-Sep 2026 found. Registered as a commission statement only - no financial import.'),
('strongback-mobility:sales_export:orders', 'strongback-mobility', 'sales_export', 'Order export (CSV / XLSX, on request)', 'active', true,
 '{"senders":{"domains":["strongbackmobility.com"]},"formats":["csv","xlsx","xls"],
   "content":{"columns_all":["order","sku","qty"],"columns_any":["amount"],"columns_none":["commission"]},
   "period":{"order":["content_dates","file_name","subject"]},"expected":{"cadence":"on_request"}}',
 'A sales export whatever the email subject says (often "Commission report ..."). No automatic import.'),
('strongback-mobility:dealer_report:overview', 'strongback-mobility', 'dealer_report', 'Monthly dealer overview (PDF)', 'active', true,
 '{"senders":{"domains":["strongbackmobility.com"]},"formats":["pdf"],"content":{"reader":"strongback-dealer-report"},
   "period":{"order":["reader"]},"expected":{"cadence":"monthly","days":[6,12]}}',
 'Read by the MI-1c reader (period + prepared date from the report itself). The September file is record 7 (linked, not re-registered).'),
-- DRAFT — recognised and shown in the Inbox, never registered automatically until Angelo activates the profile.
('ohio-medical:commission_statement:through', 'ohio-medical', 'commission_statement', 'Cumulative commission detail ("Commissions through <Month>")', 'draft', false,
 '{"senders":{"domains":["ohiomedical.com"]},"formats":["xlsx"],"content":{"sheet_names_any":["Current month payment","Sales-Commission Data"]},
   "period":{"order":["subject"],"cumulative":true,"subject_year":"from_received"},"expected":{"cadence":"monthly","days":[21,29]}}',
 'Three sheets (Summary / Sales-Commission Data / Current month payment). Subjects for Jan/Feb 2026 said 2025.'),
('access4u:commission_statement:monthly', 'access4u', 'commission_statement', 'Commission report (XLSX; months sometimes combined)', 'draft', false,
 '{"senders":{"domains":["access4uinc.com"]},"formats":["xlsx","xls"],"content":{"columns_all":["amount","commission"]},
   "period":{"order":["subject","file_name"],"combined":true},"expected":{"cadence":"monthly","days":[13,28]}}', null),
('airavant-bongorx:commission_statement:cash_basis', 'airavant-bongorx', 'commission_statement', 'QuickBooks "Commissions - Cash Basis" PDF', 'draft', false,
 '{"senders":{"domains":["airavant.com","bongorx.com"]},"formats":["pdf"],"content":{"pdf_signals_all":["cash_basis","commission"]},
   "period":{"order":["file_name","content","subject"]},"expected":{"cadence":"irregular"}}', null),
('climbing-steps:commission_statement:monthly', 'climbing-steps', 'commission_statement', 'Commission report (NetSuite export, or figures in the email body)', 'draft', false,
 '{"senders":{"domains":["climbingsteps.com"]},"formats":["xls","xlsx"],"file_name":"commi?ss?ion|comms","body_only":true,
   "period":{"order":["subject","file_name"]},"expected":{"cadence":"monthly","days":[4,12]}}', null),
('bemis:commission_statement:rep705', 'bemis', 'commission_statement', 'Rep 705 commission CSV', 'draft', false,
 '{"senders":{"domains":["bemismfg.com"]},"formats":["csv"],"file_name":"^705-\\d{4}-\\d{2}\\.csv$","content":{"columns_all":["commission"]},
   "period":{"order":["file_name"]},"expected":{"cadence":"monthly","days":[17,17]}}', 'Sent from faxstar03@bemismfg.com, often twice.'),
('complete-medical-supplies:commission_statement:monthly', 'complete-medical-supplies', 'commission_statement', 'Commission report (Homecare Providers <Month>)', 'draft', false,
 '{"senders":{"domains":["completemedical.com"]},"formats":["xlsx","pdf"],"file_name":"^homecare providers",
   "period":{"order":["file_name","subject"]},"expected":{"cadence":"irregular"}}', 'Arrives after reminders, 6-10 weeks late.'),
('ovation-medical:commission_statement:summary', 'ovation-medical', 'commission_statement', 'Monthly sales / commission summary (YYMM)', 'draft', false,
 '{"senders":{"domains":["ovationmed.com"]},"formats":["xlsx"],"file_name":"^\\d{4}\\s",
   "period":{"order":["file_name_yymm","subject"]},"expected":{"cadence":"monthly"}}', null),
('pedifix:sales_export:ytd', 'pedifix', 'sales_export', 'YTD customer sales workbook', 'draft', false,
 '{"senders":{"domains":["pedifix.com"]},"formats":["xlsx","xls","csv"],"content":{"columns_any":["customer","invoice"]},
   "period":{"order":["content_dates","subject"]},"expected":{"cadence":"irregular"}}', null),
('golden-technologies:commission_statement:irregular', 'golden-technologies', 'commission_statement', 'Rep commission statement (irregular)', 'draft', false,
 '{"senders":{"domains":["goldentech.com"]},"formats":["pdf","xlsx","csv"],"file_name":"commission",
   "period":{"order":["file_name","subject","content"]},"expected":{"cadence":"irregular"}}', 'Order acknowledgements are not reports.')
on conflict (code) do nothing;
select set_config('hcps.capture_op', 'off', true);

commit;

-- ---------------------------------------------------------------------------------------------
-- CHECK (read-only; the SQL editor shows only this last result). Every row: ok = true.
select * from (
  select 1 n, 'six capture tables, RLS on, 0 policies' check_name,
         count(*)::text || ' tables, ' || count(*) filter (where c.relrowsecurity) || ' with RLS, ' ||
         (select count(*) from pg_policy pp join pg_class pc on pc.oid = pp.polrelid where pc.relnamespace = 'public'::regnamespace and pc.relname like 'mfr_report_%') || ' policies' value,
         count(*) = 6 and bool_and(c.relrowsecurity)
         and (select count(*) from pg_policy pp join pg_class pc on pc.oid = pp.polrelid where pc.relnamespace = 'public'::regnamespace and pc.relname like 'mfr_report_%') = 0 ok
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname in ('mfr_report_profiles','mfr_report_capture_state',
      'mfr_report_capture_runs','mfr_report_messages','mfr_report_items','mfr_report_capture_events')
  union all select 2, 'grants to anon / authenticated / PUBLIC on the capture tables (expect 0)', count(*)::text, count(*) = 0
    from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon','authenticated','PUBLIC')
     and table_name in ('mfr_report_profiles','mfr_report_capture_state','mfr_report_capture_runs','mfr_report_messages','mfr_report_items','mfr_report_capture_events')
  union all select 3, 'service_role: SELECT only on the capture tables', count(*)::text, count(*) = 0
    from information_schema.role_table_grants where table_schema = 'public' and grantee = 'service_role' and privilege_type <> 'SELECT'
     and table_name in ('mfr_report_profiles','mfr_report_capture_state','mfr_report_capture_runs','mfr_report_messages','mfr_report_items','mfr_report_capture_events')
  union all select 4, 'capture functions executable by anon / authenticated (expect 0)', count(*)::text, count(*) = 0
    from pg_proc p cross join unnest(array['anon','authenticated']) r
   where p.pronamespace = 'public'::regnamespace and p.proname like 'hcps_mfr_capture_%' and has_function_privilege(r, p.oid, 'execute')
  union all select 5, 'guard triggers (row + truncate) on all six tables', count(*)::text, count(*) = 12
    from pg_trigger where tgname in ('mfr_capture_guard','mfr_capture_guard_truncate') and tgrelid in (select oid from pg_class
      where relnamespace = 'public'::regnamespace and relname like 'mfr_report_%')
  union all select 6, 'profiles: 3 active (Strongback) + 9 draft, none auto-importing',
         (select string_agg(status || ':' || n, ' ' order by status) from (select status, count(*) n from public.mfr_report_profiles group by status) x),
         (select count(*) from public.mfr_report_profiles where status = 'active' and manufacturer = 'strongback-mobility') = 3
         and (select count(*) from public.mfr_report_profiles where status = 'draft') = 9
         and not exists (select 1 from public.mfr_report_profiles where auto_import)
  union all select 7, 'capture switch is NOT on (this migration never turns it on)', coalesce(public.hcps_mfr_capture_switch_on()::text, 'false'),
         not public.hcps_mfr_capture_switch_on()
  union all select 8, 'captured mailbox seeded with checkpoint 1 Oct 2026 (Chicago)',
         (select mailbox || ' ' || checkpoint_at from public.mfr_report_capture_state order by mailbox limit 1),
         exists (select 1 from public.mfr_report_capture_state where mailbox = 'angelo@homecareproviderservices.us')
  union all select 9, 'no capture messages / items / events yet',
         (select count(*) from public.mfr_report_messages)::text || '/' || (select count(*) from public.mfr_report_items)::text || '/' ||
         (select count(*) from public.mfr_report_capture_events)::text,
         not exists (select 1 from public.mfr_report_messages) and not exists (select 1 from public.mfr_report_items)
) x order by n;

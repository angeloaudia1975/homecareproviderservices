-- ============================================================================================
-- HCPS Smart Email Learning — Phase 1: capture (owner decisions 2026-10-30; CLAUDE.md §16).
-- Safe to run twice. NOT RUN — Angelo runs it on approval, in the Supabase SQL editor.
--
-- ONE table, public.email_drafts: an HCPS-generated draft AS WRITTEN, and — only after Outlook accepted
-- the send — the version actually sent. It never holds a recipient address (only how many). Nothing
-- here sends, changes or re-sends an email; the application captures nothing until
-- phase2_flags.email_learning_capture is exactly true, and then only the President's own emails.
--
-- Writes only through three security-definer functions (service_role only):
--   hcps_email_draft_create(p)        a new draft (insert)
--   hcps_email_draft_record_send(p)   the sent version, ONCE, same author, same dealer
--   hcps_email_draft_purge_expired()  after 12 months (owner decision 4) the subject and body text of
--                                     both versions are cleared (called daily by email-learning-purge-cron); the
--                                     record keeps only its type, dates, dealer id and edited flag — no email text
-- A guard trigger (marker + the owner's rights) refuses every other insert, update, delete or truncate,
-- and refuses any change to the original draft or to a recorded send.
-- RULE 19: RLS on, no policies; anon / authenticated / PUBLIC nothing; service_role SELECT only.
-- pg-safeupdate: every UPDATE carries a WHERE clause; no DELETE.
-- After running: scripts/email_learning_p1_public_probe_browser.js (expect every check BLOCKED / 401).
-- ============================================================================================
begin;

create table if not exists public.email_drafts (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  author_email        text not null check (author_email = lower(author_email) and author_email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  dealer_id           uuid,
  email_type          text not null check (email_type in ('previsit_headsup','visit_followup','follow_up','dormant_account',
                        'product_intro','reorder_reminder','cross_sell','portal_activation','campaign')),
  template            text not null check (length(btrim(template)) between 1 and 60),
  generator           text not null check (generator in ('ai-email-api','routes-api','campaign-api')),
  original_subject    text check (original_subject is null or length(original_subject) between 1 and 300),
  original_body       text check (original_body is null or length(original_body) between 1 and 20000),
  original_sha256     text not null check (original_sha256 ~ '^[0-9a-f]{64}$'),
  sent_at             timestamptz,
  sent_subject        text check (sent_subject is null or length(sent_subject) between 1 and 300),
  sent_body           text check (sent_body is null or length(sent_body) <= 20000),
  sent_sha256         text check (sent_sha256 is null or sent_sha256 ~ '^[0-9a-f]{64}$'),
  edited              boolean,
  recipient_count     integer check (recipient_count is null or recipient_count between 1 and 50),
  content_expires_at  timestamptz not null default (now() + interval '12 months'),
  content_purged_at   timestamptz,
  constraint email_drafts_send_ck check ((sent_at is null) = (sent_sha256 is null) and (sent_at is null) = (edited is null)
                                          and (sent_at is null) = (recipient_count is null)),
  constraint email_drafts_content_ck check (content_purged_at is not null
                                          or (original_subject is not null and original_body is not null
                                              and (sent_at is null or (sent_subject is not null and sent_body is not null))))
);
create index if not exists email_drafts_type_ix on public.email_drafts(email_type, created_at desc);
create index if not exists email_drafts_author_ix on public.email_drafts(author_email, created_at desc);
create index if not exists email_drafts_expiry_ix on public.email_drafts(content_expires_at) where content_purged_at is null;

alter table public.email_drafts enable row level security;
revoke all on table public.email_drafts from public, anon, authenticated, service_role;
grant select on table public.email_drafts to service_role;

-- Guard: the marker hcps.email_draft_op ('create' | 'send' | 'purge') AND the owner's rights (only the
-- security-definer functions below have both). Each marker allows exactly its own change.
create or replace function public.hcps_email_draft_guard()
returns trigger language plpgsql as $$
declare v_owner text; v_op text := coalesce(current_setting('hcps.email_draft_op', true), '');
        v_keep text[] := array['sent_at','sent_subject','sent_body','sent_sha256','edited','recipient_count'];
        v_purge text[] := array['original_subject','original_body','sent_subject','sent_body','content_purged_at'];
begin
  if tg_level = 'STATEMENT' or tg_op = 'DELETE' then raise exception 'email_draft_guard: % of email_drafts is not allowed', tg_op; end if;
  select pg_get_userbyid(relowner) into v_owner from pg_class where oid = tg_relid;
  if current_user <> v_owner then raise exception 'email_draft_guard: email_drafts is written only by its functions'; end if;
  if tg_op = 'INSERT' then
    if v_op <> 'create' then raise exception 'email_draft_guard: rows are created only by hcps_email_draft_create'; end if;
    if new.sent_at is not null or new.content_purged_at is not null then raise exception 'email_draft_guard: a new draft is not sent or purged'; end if;
    return new;
  end if;
  -- UPDATE
  if v_op = 'send' then
    if old.sent_at is not null then raise exception 'email_draft_guard: the send of this draft is already recorded'; end if;
    if old.content_purged_at is not null then raise exception 'email_draft_guard: this draft has expired'; end if;
    if (to_jsonb(new) - v_keep) <> (to_jsonb(old) - v_keep) then raise exception 'email_draft_guard: recording a send changes only the sent fields'; end if;
    if new.sent_at is null then raise exception 'email_draft_guard: a send needs its time'; end if;
    return new;
  elsif v_op = 'purge' then
    if old.content_purged_at is not null or new.content_purged_at is null then raise exception 'email_draft_guard: purge happens once'; end if;
    if new.original_subject is not null or new.original_body is not null or new.sent_subject is not null or new.sent_body is not null then
      raise exception 'email_draft_guard: a purge clears all text'; end if;
    if (to_jsonb(new) - v_purge) <> (to_jsonb(old) - v_purge) then raise exception 'email_draft_guard: a purge changes only the text'; end if;
    return new;
  end if;
  raise exception 'email_draft_guard: email_drafts rows are not edited';
end $$;
drop trigger if exists email_draft_guard on public.email_drafts;
create trigger email_draft_guard before insert or update or delete on public.email_drafts for each row execute function public.hcps_email_draft_guard();
drop trigger if exists email_draft_guard_truncate on public.email_drafts;
create trigger email_draft_guard_truncate before truncate on public.email_drafts for each statement execute function public.hcps_email_draft_guard();

create or replace function public.hcps_email_draft_sha(s text, b text)
returns text language sql immutable set search_path = public, pg_temp as $$
  select encode(sha256(convert_to(coalesce(s, '') || E'\n\n' || coalesce(b, ''), 'UTF8')), 'hex')
$$;

-- p = { author_email, dealer_id?, email_type, template, generator, subject, body }
create or replace function public.hcps_email_draft_create(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_s text := btrim(coalesce(p->>'subject', '')); v_b text := coalesce(p->>'body', '');
        v_dealer uuid;
begin
  if nullif(btrim(coalesce(p->>'dealer_id', '')), '') is not null then
    begin v_dealer := (p->>'dealer_id')::uuid; exception when others then raise exception 'email_draft_bad_request: dealer_id is not an id'; end;
  end if;
  if length(v_s) = 0 or length(btrim(v_b)) = 0 then raise exception 'email_draft_bad_request: subject and body are required'; end if;
  perform set_config('hcps.email_draft_op', 'create', true);
  insert into public.email_drafts (author_email, dealer_id, email_type, template, generator, original_subject, original_body, original_sha256)
  values (lower(btrim(coalesce(p->>'author_email', ''))), v_dealer, p->>'email_type', btrim(coalesce(p->>'template', '')),
          p->>'generator', v_s, v_b, public.hcps_email_draft_sha(v_s, v_b))
  returning id into v_id;
  perform set_config('hcps.email_draft_op', '', true);
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- p = { draft_id, author_email, dealer_id?, subject, body, recipient_count }
-- Answers a status instead of raising, so the caller (after a successful send) never fails because of it.
create or replace function public.hcps_email_draft_record_send(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare d public.email_drafts; v_id uuid; v_dealer uuid; v_s text := btrim(coalesce(p->>'subject', '')); v_b text := coalesce(p->>'body', '');
        v_sha text; v_n int;
begin
  begin v_id := (p->>'draft_id')::uuid; exception when others then return jsonb_build_object('ok', false, 'status', 'not_found'); end;
  if nullif(btrim(coalesce(p->>'dealer_id', '')), '') is not null then
    begin v_dealer := (p->>'dealer_id')::uuid; exception when others then return jsonb_build_object('ok', false, 'status', 'dealer_mismatch'); end;
  end if;
  select * into d from public.email_drafts where id = v_id for update;
  if not found then return jsonb_build_object('ok', false, 'status', 'not_found'); end if;
  if d.author_email <> lower(btrim(coalesce(p->>'author_email', ''))) then return jsonb_build_object('ok', false, 'status', 'author_mismatch'); end if;
  if d.dealer_id is distinct from v_dealer then return jsonb_build_object('ok', false, 'status', 'dealer_mismatch'); end if;
  if d.sent_at is not null then return jsonb_build_object('ok', false, 'status', 'already_sent'); end if;
  if d.content_purged_at is not null then return jsonb_build_object('ok', false, 'status', 'expired'); end if;
  if length(v_s) = 0 or length(v_s) > 300 or length(v_b) > 20000 then return jsonb_build_object('ok', false, 'status', 'bad_request'); end if;
  v_n := greatest(1, least(50, coalesce(nullif(p->>'recipient_count', '')::int, 1)));
  v_sha := public.hcps_email_draft_sha(v_s, v_b);
  perform set_config('hcps.email_draft_op', 'send', true);
  update public.email_drafts set sent_at = now(), sent_subject = v_s, sent_body = v_b, sent_sha256 = v_sha,
         edited = (v_sha <> d.original_sha256), recipient_count = v_n
   where id = v_id;
  perform set_config('hcps.email_draft_op', '', true);
  return jsonb_build_object('ok', true, 'status', 'recorded', 'edited', v_sha <> d.original_sha256);
end $$;

-- After 12 months: clear every text field of both versions (owner decision 4). Masked learning evidence
-- (Phase 2) is kept in its own table and holds no email text. Returns how many drafts were cleared.
create or replace function public.hcps_email_draft_purge_expired()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n int;
begin
  perform set_config('hcps.email_draft_op', 'purge', true);
  update public.email_drafts set original_subject = null, original_body = null, sent_subject = null, sent_body = null, content_purged_at = now()
   where content_purged_at is null and content_expires_at <= now();
  get diagnostics v_n = row_count;
  perform set_config('hcps.email_draft_op', '', true);
  return v_n;
end $$;

revoke all on function public.hcps_email_draft_guard() from public, anon, authenticated, service_role;
revoke all on function public.hcps_email_draft_sha(text, text) from public, anon, authenticated;
revoke all on function public.hcps_email_draft_create(jsonb) from public, anon, authenticated;
revoke all on function public.hcps_email_draft_record_send(jsonb) from public, anon, authenticated;
revoke all on function public.hcps_email_draft_purge_expired() from public, anon, authenticated;
grant execute on function public.hcps_email_draft_sha(text, text) to service_role;
grant execute on function public.hcps_email_draft_create(jsonb) to service_role;
grant execute on function public.hcps_email_draft_record_send(jsonb) to service_role;
grant execute on function public.hcps_email_draft_purge_expired() to service_role;

commit;

-- CHECK (read-only; the SQL editor shows only this last result). Every row: ok = true.
select * from (
  select 1 n, 'table present, RLS on, 0 policies' check_name,
         count(*) || ' table, RLS ' || bool_and(c.relrowsecurity) value,
         count(*) = 1 and bool_and(c.relrowsecurity) and (select count(*) from pg_policy pp where pp.polrelid = 'public.email_drafts'::regclass) = 0 ok
    from pg_class c where c.oid = 'public.email_drafts'::regclass
  union all select 2, 'grants to anon / authenticated / PUBLIC (expect 0)', count(*)::text, count(*) = 0
    from information_schema.role_table_grants where table_schema = 'public' and table_name = 'email_drafts' and grantee in ('anon','authenticated','PUBLIC')
  union all select 3, 'service_role: SELECT only', coalesce(string_agg(privilege_type, ','), ''), coalesce(string_agg(privilege_type, ','), '') = 'SELECT'
    from information_schema.role_table_grants where table_schema = 'public' and table_name = 'email_drafts' and grantee = 'service_role'
  union all select 4, 'functions: service_role only, security definer; guard callable by nobody',
         (select count(*) from unnest(array['public.hcps_email_draft_create(jsonb)','public.hcps_email_draft_record_send(jsonb)','public.hcps_email_draft_purge_expired()']) f
           where has_function_privilege('service_role', f, 'execute') and not has_function_privilege('anon', f, 'execute')
             and not has_function_privilege('authenticated', f, 'execute') and (select prosecdef from pg_proc where oid = f::regprocedure))::text || ' of 3',
         (select count(*) from unnest(array['public.hcps_email_draft_create(jsonb)','public.hcps_email_draft_record_send(jsonb)','public.hcps_email_draft_purge_expired()']) f
           where has_function_privilege('service_role', f, 'execute') and not has_function_privilege('anon', f, 'execute')
             and not has_function_privilege('authenticated', f, 'execute') and (select prosecdef from pg_proc where oid = f::regprocedure)) = 3
         and not has_function_privilege('service_role', 'public.hcps_email_draft_guard()', 'execute')
  union all select 5, 'guard triggers (row + truncate)', count(*)::text, count(*) = 2
    from pg_trigger where tgrelid = 'public.email_drafts'::regclass and not tgisinternal
  union all select 6, 'no rows written by the install', (select count(*) from public.email_drafts)::text, (select count(*) from public.email_drafts) = 0
  union all select 7, 'capture switch NOT turned on by this migration',
         coalesce((select value->>'email_learning_capture' from public.app_settings where key = 'phase2_flags'), 'absent'),
         coalesce((select value->>'email_learning_capture' from public.app_settings where key = 'phase2_flags'), 'absent') <> 'true'
) c order by n;

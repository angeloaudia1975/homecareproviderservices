-- Manufacturer Center Phase 6 (approved by Angelo 2026-10-10): the evidence is append-only.
--
-- Verification runs (mfr_verification_runs) and decisions (mfr_decisions) are the record of what was
-- checked, decided and approved — including the two human approval gates. They are never deleted or
-- rewritten. The single change allowed is the one-time stamp that spends a single-use decision
-- (a regression_fix or a gate approval): used_at / used_by set once, from empty, with nothing else
-- touched. TRUNCATE is refused too. catalog-api only ever inserts into these tables and stamps
-- used_at, so nothing that works today changes.
--
-- Rule 19: the trigger function is not callable by public / anon / authenticated.
-- Safe to run more than once. Ends with ONE check table (the SQL editor shows only the last result);
-- every probe inside it is rolled back.

begin;

create or replace function public.mfr_append_only() returns trigger
language plpgsql set search_path = public as $$
begin
  if TG_OP = 'TRUNCATE' then
    raise exception 'append_only: % is never truncated', TG_TABLE_NAME using errcode = 'P0001';
  end if;
  if TG_OP = 'DELETE' then
    raise exception 'append_only: % rows are never deleted', TG_TABLE_NAME using errcode = 'P0001';
  end if;
  if TG_TABLE_NAME = 'mfr_decisions' then
    -- (nested: only a decision has used_at; plpgsql does not promise to short-circuit AND)
    if (to_jsonb(OLD) ->> 'used_at') is null and (to_jsonb(NEW) ->> 'used_at') is not null
       and (to_jsonb(NEW) - 'used_at' - 'used_by') = (to_jsonb(OLD) - 'used_at' - 'used_by') then
      return NEW;                       -- spending a single-use decision, once
    end if;
  end if;
  raise exception 'append_only: % rows are never rewritten', TG_TABLE_NAME using errcode = 'P0001';
end $$;

revoke all on function public.mfr_append_only() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.mfr_append_only() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.mfr_append_only() from authenticated'; end if;
end $$;

drop trigger if exists mfr_append_only on public.mfr_verification_runs;
create trigger mfr_append_only before update or delete on public.mfr_verification_runs
  for each row execute function public.mfr_append_only();
drop trigger if exists mfr_append_only_truncate on public.mfr_verification_runs;
create trigger mfr_append_only_truncate before truncate on public.mfr_verification_runs
  for each statement execute function public.mfr_append_only();
drop trigger if exists mfr_append_only on public.mfr_decisions;
create trigger mfr_append_only before update or delete on public.mfr_decisions
  for each row execute function public.mfr_append_only();
drop trigger if exists mfr_append_only_truncate on public.mfr_decisions;
create trigger mfr_append_only_truncate before truncate on public.mfr_decisions
  for each statement execute function public.mfr_append_only();

commit;

-- ── ONE CHECK TABLE ──────────────────────────────────────────────────────────────────────────────
create temp table if not exists _mc6_check (n int, check_name text, value text, ok boolean);
truncate _mc6_check;
do $$
declare rid bigint; did bigint; uid bigint; ok boolean; msg text;
begin
  insert into _mc6_check select 1, 'triggers installed', count(*)::text, count(*) = 4
    from pg_trigger where not tgisinternal and tgname in ('mfr_append_only','mfr_append_only_truncate')
     and tgrelid in ('public.mfr_verification_runs'::regclass, 'public.mfr_decisions'::regclass);
  insert into _mc6_check select 2, 'anon / authenticated cannot execute',
    coalesce(bool_or(has_function_privilege(r.rolname, 'public.mfr_append_only()', 'execute'))::text, 'no such roles'),
    not coalesce(bool_or(has_function_privilege(r.rolname, 'public.mfr_append_only()', 'execute')), false)
    from pg_roles r where r.rolname in ('anon','authenticated');
  select id into rid from public.mfr_verification_runs order by id limit 1;
  select id into did from public.mfr_decisions order by id limit 1;
  select id into uid from public.mfr_decisions where used_at is null order by id limit 1;
  -- each probe either is refused, or raises its own error so whatever it did is rolled back
  if rid is null then insert into _mc6_check values (3, 'rewrite a verification run', 'no runs to probe', true);
  else begin update public.mfr_verification_runs set result = result where id = rid; raise exception 'probe-allowed';
       exception when others then msg := sqlerrm; insert into _mc6_check values (3, 'rewrite a verification run', case when msg like 'append_only%' then 'blocked' else msg end, msg like 'append_only%'); end;
       begin delete from public.mfr_verification_runs where id = rid; raise exception 'probe-allowed';
       exception when others then msg := sqlerrm; insert into _mc6_check values (4, 'delete a verification run', case when msg like 'append_only%' then 'blocked' else msg end, msg like 'append_only%'); end;
  end if;
  if did is null then insert into _mc6_check values (5, 'rewrite a decision', 'no decisions to probe', true);
  else begin update public.mfr_decisions set reason = reason || ' (edited)' where id = did; raise exception 'probe-allowed';
       exception when others then msg := sqlerrm; insert into _mc6_check values (5, 'rewrite a decision', case when msg like 'append_only%' then 'blocked' else msg end, msg like 'append_only%'); end;
       begin delete from public.mfr_decisions where id = did; raise exception 'probe-allowed';
       exception when others then msg := sqlerrm; insert into _mc6_check values (6, 'delete a decision', case when msg like 'append_only%' then 'blocked' else msg end, msg like 'append_only%'); end;
  end if;
  if uid is null then insert into _mc6_check values (7, 'spend a single-use decision once (allowed)', 'no unused decision to probe', true);
  else begin update public.mfr_decisions set used_at = now(), used_by = 'probe' where id = uid; raise exception 'probe-ok';
       exception when others then msg := sqlerrm; insert into _mc6_check values (7, 'spend a single-use decision once (allowed, rolled back)', case when msg = 'probe-ok' then 'allowed' else msg end, msg = 'probe-ok'); end;
  end if;
end $$;
select n, check_name, value, case when ok then 'ok' else 'FAILED' end as result from _mc6_check order by n;

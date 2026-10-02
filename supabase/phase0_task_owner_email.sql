-- HCPS Connect 360 — Phase 0I / 0J: tasks and opportunities belong to a person by EMAIL.
--
-- Today a task's owner is a free-text name (dealer_tasks.assigned_rep) and so is a deal's
-- (opportunities.owner_rep). This adds the sign-in email beside each name, the same key the
-- dealer owner now uses (dealers.rep_email, Phase 0C), plus who closed a task.
--
--   dealer_tasks.assigned_email   the assignee's staff email (filled from assigned_rep)
--   dealer_tasks.completed_by     who marked it done/dismissed: a staff email, or 'system' for the engine
--   opportunities.owner_email     the owner's staff email (filled from owner_rep)
--
-- A trigger keeps each email in step with its name, so every existing writer (forms, the
-- engine, visit follow-ups, reassignment) gets it right without being changed. A name that
-- matches no staff member (or matches two) gets no email. Nothing is removed or renamed;
-- the app works with or without this file (it retries without the new columns).
--
-- SAFE TO RE-RUN. Adds 3 columns, 2 functions, 2 triggers, 2 indexes; fills the new email
-- columns on existing rows; changes no existing value.

alter table public.dealer_tasks  add column if not exists assigned_email text;
alter table public.dealer_tasks  add column if not exists completed_by   text;
alter table public.opportunities add column if not exists owner_email    text;

create index if not exists dealer_tasks_assigned_email_idx on public.dealer_tasks (lower(assigned_email)) where status = 'open';
create index if not exists opportunities_owner_email_idx   on public.opportunities (lower(owner_email)) where status = 'open';

-- The staff email for a rep name, or null when the name matches no one or more than one person.
create or replace function public.hcps_staff_email_for(p_rep text) returns text
language sql stable as $$
  select min(lower(s.email)) from public.staff_users s
  where nullif(btrim(p_rep), '') is not null and lower(btrim(s.rep_name)) = lower(btrim(p_rep))
  having count(*) = 1
$$;

-- New row: fill the email from the name unless the writer gave one. Changed name: refill it,
-- unless the same update also set the email explicitly.
create or replace function public.hcps_task_assigned_email() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.assigned_email is null then new.assigned_email := public.hcps_staff_email_for(new.assigned_rep); end if;
  elsif new.assigned_rep is distinct from old.assigned_rep and new.assigned_email is not distinct from old.assigned_email then
    new.assigned_email := public.hcps_staff_email_for(new.assigned_rep);
  end if;
  return new;
end $$;

create or replace function public.hcps_opportunity_owner_email() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.owner_email is null then new.owner_email := public.hcps_staff_email_for(new.owner_rep); end if;
  elsif new.owner_rep is distinct from old.owner_rep and new.owner_email is not distinct from old.owner_email then
    new.owner_email := public.hcps_staff_email_for(new.owner_rep);
  end if;
  return new;
end $$;

drop trigger if exists hcps_task_assigned_email on public.dealer_tasks;
create trigger hcps_task_assigned_email before insert or update on public.dealer_tasks
  for each row execute function public.hcps_task_assigned_email();

drop trigger if exists hcps_opportunity_owner_email on public.opportunities;
create trigger hcps_opportunity_owner_email before insert or update on public.opportunities
  for each row execute function public.hcps_opportunity_owner_email();

-- Fill existing rows (only where the email is still empty).
update public.dealer_tasks  set assigned_email = public.hcps_staff_email_for(assigned_rep)
  where assigned_email is null and nullif(btrim(assigned_rep), '') is not null;
update public.opportunities set owner_email = public.hcps_staff_email_for(owner_rep)
  where owner_email is null and nullif(btrim(owner_rep), '') is not null;

-- Check (read-only): how many open tasks / deals now carry an owner email.
select 'open tasks with an assignee email' as what, count(*) filter (where assigned_email is not null) || ' of ' || count(*) as result
  from public.dealer_tasks where status = 'open'
union all
select 'open deals with an owner email', count(*) filter (where owner_email is not null) || ' of ' || count(*)
  from public.opportunities where status = 'open';

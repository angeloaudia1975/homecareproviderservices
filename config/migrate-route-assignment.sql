-- HCPS Connect 360 — route assignment + per-rep start location
--
-- The problem this fixes: rep_routes only ever recorded owner_email, the address of
-- whoever CREATED the route. A route the president built "for Greg" still belonged to
-- the president, and Greg's portal — which lists routes where owner_email = his own
-- address — correctly returned nothing. The route existed and was simply never related
-- to him. Nothing was wrong with his login.
--
-- Safe to run more than once. No existing data is modified.

-- 1) Who the route is FOR, as distinct from who built it.
alter table if exists public.rep_routes add column if not exists assigned_to_email text;
alter table if exists public.rep_routes add column if not exists assigned_to_rep   text;
alter table if exists public.rep_routes add column if not exists assigned_at       timestamptz;
alter table if exists public.rep_routes add column if not exists assigned_by       text;

comment on column public.rep_routes.assigned_to_email is
  'Rep this route is assigned to (staff_users.email). The rep portal shows a route when it is owned by OR assigned to the signed-in rep. Null = personal route, visible to its owner only.';
comment on column public.rep_routes.assigned_to_rep is
  'Display name of the assigned rep (staff_users.rep_name), denormalised for listing.';

create index if not exists rep_routes_assigned_to on public.rep_routes (lower(assigned_to_email));
create index if not exists rep_routes_owner       on public.rep_routes (lower(owner_email));
create index if not exists rep_routes_sched       on public.rep_routes (scheduled_date desc);

-- 2) Each rep's own default starting point, so a rep's map never inherits the
--    administrator's home address. Shape: {label, address, lat, lng}.
alter table if exists public.staff_users add column if not exists home_base jsonb;
comment on column public.staff_users.home_base is
  'This rep''s default route start/end point {label,address,lat,lng}. Personal to the rep; never shared or inherited from whoever created a route.';

-- 3) Backfill: a route whose creator is a REP is, by definition, that rep''s own route.
--    Routes created by the president are deliberately left unassigned — only a person
--    knows who each of those was meant for, and they show up in the assignment queue.
update public.rep_routes r
   set assigned_to_email = r.owner_email,
       assigned_to_rep   = coalesce(r.rep_name, s.rep_name),
       assigned_at       = coalesce(r.assigned_at, r.updated_at, now()),
       assigned_by       = 'backfill'
  from public.staff_users s
 where r.assigned_to_email is null
   and r.owner_email is not null
   and lower(s.email) = lower(r.owner_email)
   and coalesce(lower(s.role),'rep') not in ('president','admin','owner');

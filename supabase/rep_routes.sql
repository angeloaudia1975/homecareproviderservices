-- ============================================================================
-- HCPS sales-rep route planning — saved & scheduled routes.
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- One row per saved route. `stops` is the ordered list of dealer stops; `home_base`
-- is where the trip starts/ends; `geometry` caches the drawn road path so a saved
-- route redraws instantly without re-calling the routing engine. Read/written
-- server-side (service_role) by routes-api.js; reps see only their own routes.
-- ============================================================================

create table if not exists rep_routes (
  id            uuid primary key default gen_random_uuid(),
  owner_email   text,                          -- staff email that created/owns the route
  rep_name      text,                          -- rep book (lets the President filter by rep)
  name          text not null,
  scheduled_date date,                         -- optional: the day/week this trip is planned for
  home_base     jsonb,                         -- {label,address,lat,lng}
  round_trip    boolean not null default true,
  stops         jsonb not null default '[]'::jsonb,   -- ordered [{dealer_id,name,address,city,state,lat,lng}]
  distance_m    numeric,                       -- total drive distance (meters)
  duration_s    numeric,                       -- total drive time (seconds)
  geometry      jsonb,                         -- cached road path (GeoJSON LineString coords) for redraw
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists rep_routes_owner_idx on rep_routes(owner_email);
create index if not exists rep_routes_rep_idx   on rep_routes(rep_name);

alter table rep_routes enable row level security;
-- No public/dealer policy: only service_role (routes-api.js) reads/writes. Rep-vs-president
-- scoping is enforced in the function, not RLS.

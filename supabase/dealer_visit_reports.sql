-- Field-visit reports for the mobile Scheduled Routes companion (Route → Visit → Intelligence).
-- One editable report per (route, dealer): check-in/complete timestamps, a structured `fields` payload
-- (purpose, manufacturers, products, interest, concerns, competitive, opportunities, followups, notes,
-- next_action + date, handout answers), plus the raw voice `transcript` and the AI-`structured` output.
-- On completion the routes-api write-through logs a dealer touch and creates tasks/opportunities.
-- Read/written server-side (service role) only; routes-api enforces rep-owns-route permission.
-- Applied 2026-08 (RLS enabled).

create table if not exists dealer_visit_reports (
  id            uuid primary key default gen_random_uuid(),
  route_id      uuid,
  dealer_id     uuid not null,
  rep_email     text,
  rep_name      text,
  scheduled_date date,
  checkin_at    timestamptz,
  completed_at  timestamptz,
  status        text not null default 'planned',   -- planned | checked_in | in_progress | completed
  fields        jsonb not null default '{}'::jsonb,
  transcript    text,
  structured    jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_dvr_route   on dealer_visit_reports(route_id);
create index if not exists idx_dvr_dealer  on dealer_visit_reports(dealer_id);
create index if not exists idx_dvr_rep_date on dealer_visit_reports(rep_email, scheduled_date);
create unique index if not exists uq_dvr_route_dealer on dealer_visit_reports(route_id, dealer_id);

alter table dealer_visit_reports enable row level security;
-- No policies: only the Supabase service role (server-side Netlify functions) may read/write.

-- HCPS — Sales Call Strategy & Outreach Assistant (Who to Call workspace).
--
-- Two tables. Everything else the workspace reads already exists: monthly_sales,
-- dealer_activity, dealer_visit_reports, dealer_notes, email_messages, dealer_line_status,
-- cross_sell, dealer_engagement, dealer_intent, marketing_campaigns, dealer_manufacturers.
--
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- call_briefs — the generated call strategy, cached.
--
-- A brief costs a Claude call, so it is kept and reused until the account's signals
-- actually change: signals_key is a digest of the inputs the brief was built from
-- (last order period, line statuses, latest note/activity/visit, intent score band,
-- open cart). Same key -> same brief, no second call. The dossier is stored alongside
-- it so a rep can always see the evidence the strategy was drawn from, and so a brief
-- can be explained months later without re-deriving the account's state.
-- ---------------------------------------------------------------------------
create table if not exists call_briefs (
  id            uuid primary key default gen_random_uuid(),
  dealer_id     uuid not null,
  brief         jsonb not null,
  dossier       jsonb,
  signals_key   text,
  angle         text,                  -- the primary opportunity the brief led with
  manufacturer  text,                  -- the line it led with, when it named one
  model         text,
  generated_by  text,
  created_at    timestamptz not null default now()
);
create index if not exists call_briefs_dealer_idx on call_briefs (dealer_id, created_at desc);
create index if not exists call_briefs_key_idx    on call_briefs (dealer_id, signals_key);

-- ---------------------------------------------------------------------------
-- call_outcomes — what actually happened on the call.
--
-- This is the only place outcome data lives, and it is what the learning layer reads.
-- angle and manufacturer are copied off the brief at log time on purpose: they are what
-- was actually PITCHED, and a brief regenerated later would no longer say the same thing.
-- Without that copy there is nothing to correlate an outcome against.
-- ---------------------------------------------------------------------------
create table if not exists call_outcomes (
  id             uuid primary key default gen_random_uuid(),
  dealer_id      uuid not null,
  brief_id       uuid,
  rep_name       text,
  rep_email      text,
  outcome        text not null,        -- interested | follow_up | quote_requested | appointment |
                                       -- send_info | call_later | not_interested | no_answer
  angle          text,
  manufacturer   text,
  talked_to      text,
  rep_notes      text,
  next_step      text,
  follow_up_on   date,
  note_id        uuid,                 -- the dealer_notes row this produced
  task_id        uuid,                 -- the dealer_tasks row this produced
  called_at      timestamptz not null default now(),
  call_hour      int,                  -- local hour the call was placed, for time-of-day learning
  created_at     timestamptz not null default now()
);
create index if not exists call_outcomes_dealer_idx  on call_outcomes (dealer_id, called_at desc);
create index if not exists call_outcomes_learn_idx   on call_outcomes (outcome, angle, manufacturer);
create index if not exists call_outcomes_rep_idx     on call_outcomes (rep_email, called_at desc);

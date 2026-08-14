-- HCPS Dealer 360 — Outlook Email & Contact Intelligence (Phase 0 schema)
-- New tables that sit beside the existing platform (dealers, dealer_aliases,
-- dealer_manufacturers, monthly_sales, partner_activity, contacts). Nothing here
-- touches order/sales flows. dealer_id is stored as text matching dealers.id used
-- elsewhere in the app; matching happens in the Netlify functions, not via SQL joins,
-- so no foreign keys are enforced against dealers (keeps this migration safe to run).
--
-- Run once in Supabase (SQL editor), then reload the admin tools.

-- ---------------------------------------------------------------------------
-- 1) dealer_domains — the fast, precise email→dealer matcher (domain to dealer).
-- ---------------------------------------------------------------------------
create table if not exists dealer_domains (
  id          bigint generated always as identity primary key,
  domain      text not null,                       -- lowercased email domain, e.g. "williamsbros.com"
  dealer_id   text not null,                       -- matches dealers.id used across the app
  source      text default 'seed',                 -- seed | email | manual
  confidence  numeric default 1,                   -- 0..1
  verified    boolean default false,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
create unique index if not exists dealer_domains_domain_uniq on dealer_domains (lower(domain));
create index if not exists dealer_domains_dealer_idx on dealer_domains (dealer_id);

-- ---------------------------------------------------------------------------
-- 2) email_messages — one row per RELEVANT message (metadata-first).
--    Idempotent on (mailbox_upn, graph_id) so re-ingesting updates, never dupes.
-- ---------------------------------------------------------------------------
create table if not exists email_messages (
  id                   bigint generated always as identity primary key,
  graph_id             text not null,              -- Microsoft Graph message id
  internet_message_id  text,                       -- RFC internet message id (cross-mailbox thread key)
  mailbox_upn          text not null,              -- the rep mailbox this was captured from
  direction            text check (direction in ('inbound','outbound')),
  subject              text,
  snippet              text,                        -- bodyPreview when permitted; null under metadata-only
  from_address         text,
  from_name            text,
  sent_at              timestamptz,
  received_at          timestamptz,
  dealer_id            text,                        -- resolved dealer (null if unmatched/candidate)
  contact_id           text,
  manufacturer         text,
  thread_id            text,                        -- Graph conversationId
  has_attachments      boolean default false,
  relevance_score      numeric,                     -- filter score that let it in
  match_confidence     text,                        -- high | medium | low
  folder               text,
  source               text default 'graph',
  imported_at          timestamptz default now()
);
create unique index if not exists email_messages_key_uniq on email_messages (mailbox_upn, graph_id);
create index if not exists email_messages_dealer_idx  on email_messages (dealer_id);
create index if not exists email_messages_thread_idx  on email_messages (thread_id);
create index if not exists email_messages_sent_idx    on email_messages (sent_at);
create index if not exists email_messages_imsgid_idx  on email_messages (internet_message_id);

-- ---------------------------------------------------------------------------
-- 3) email_participants — one row per person on a message (drives discovery).
-- ---------------------------------------------------------------------------
create table if not exists email_participants (
  id          bigint generated always as identity primary key,
  message_id  bigint references email_messages(id) on delete cascade,
  role        text check (role in ('from','to','cc','bcc')),
  address     text,
  display_name text,
  domain      text,
  contact_id  text
);
create index if not exists email_participants_msg_idx   on email_participants (message_id);
create index if not exists email_participants_addr_idx  on email_participants (lower(address));
create index if not exists email_participants_domain_idx on email_participants (lower(domain));

-- ---------------------------------------------------------------------------
-- 4) contact_candidates — suggested new contacts awaiting human validation.
-- ---------------------------------------------------------------------------
create table if not exists contact_candidates (
  id               bigint generated always as identity primary key,
  email            text not null,
  name             text,
  domain           text,
  dealer_id        text,
  first_seen       timestamptz default now(),
  last_seen        timestamptz default now(),
  msg_count        int default 1,
  status           text default 'pending' check (status in ('pending','approved','rejected')),
  suggested_reason text,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);
create unique index if not exists contact_candidates_email_uniq on contact_candidates (lower(email));
create index if not exists contact_candidates_status_idx on contact_candidates (status);
create index if not exists contact_candidates_dealer_idx on contact_candidates (dealer_id);

-- ---------------------------------------------------------------------------
-- 5) email_signals — derived, engine-ready facts (the seam to the AI engines).
--    Keeps raw content out of the engines; Command Center 360 reads signals.
-- ---------------------------------------------------------------------------
create table if not exists email_signals (
  id           bigint generated always as identity primary key,
  dealer_id    text,
  message_id   bigint references email_messages(id) on delete set null,
  thread_id    text,
  type         text,        -- awaiting_reply | quiet | interest | concern | opportunity | followup | cadence
  manufacturer text,
  weight       numeric default 1,
  detail       text,
  detected_at  timestamptz default now()
);
create index if not exists email_signals_dealer_type_idx on email_signals (dealer_id, type);
create index if not exists email_signals_detected_idx    on email_signals (detected_at);

-- ---------------------------------------------------------------------------
-- 6) graph_subscriptions — track live Graph change-notification subscriptions
--    so a scheduled job can renew them before they expire (~7 days for mail).
-- ---------------------------------------------------------------------------
create table if not exists graph_subscriptions (
  id             bigint generated always as identity primary key,
  subscription_id text not null,
  mailbox_upn    text not null,
  resource       text,
  expires_at     timestamptz,
  client_state   text,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);
create unique index if not exists graph_subscriptions_subid_uniq on graph_subscriptions (subscription_id);
create index if not exists graph_subscriptions_mailbox_idx on graph_subscriptions (mailbox_upn);

-- ---------------------------------------------------------------------------
-- RLS: service-role only (the Netlify functions use the service role, which
-- bypasses RLS; enabling it keeps these tables closed to anon/auth clients).
-- ---------------------------------------------------------------------------
alter table dealer_domains       enable row level security;
alter table email_messages       enable row level security;
alter table email_participants   enable row level security;
alter table contact_candidates   enable row level security;
alter table email_signals        enable row level security;
alter table graph_subscriptions  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['dealer_domains','email_messages','email_participants','contact_candidates','email_signals','graph_subscriptions']
  loop
    execute format('drop policy if exists %I_service on %I;', t, t);
    execute format('create policy %I_service on %I for all to service_role using (true) with check (true);', t, t);
  end loop;
end $$;

-- Per-location manufacturer exclusions for the Dealer Handout.
-- A rep (on their own accounts) or management marks a manufacturer as a POOR FIT for a specific
-- dealer location, so it never appears as the handout's featured pick or in "ways to grow" — WITHOUT
-- changing the dealer's line access or CRM relationship. Read/written server-side (service role) only;
-- routes-api enforces the rep-owns-dealer / management permission. Applied 2026-08 (RLS enabled).

create table if not exists dealer_handout_exclusions (
  dealer_id    uuid        not null references dealers(id) on delete cascade,
  manufacturer text        not null,              -- manufacturer slug (as used across the app)
  created_by   text,                              -- staff email/name who set it
  created_at   timestamptz not null default now(),
  primary key (dealer_id, manufacturer)
);
create index if not exists idx_dhx_dealer on dealer_handout_exclusions(dealer_id);

alter table dealer_handout_exclusions enable row level security;
-- No policies: only the Supabase service role (server-side Netlify functions) may read/write.

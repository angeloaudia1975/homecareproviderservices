-- ============================================================================
-- Dealer handout — the line this visit leads with.
--
-- The featured line on the dealer handout is computed (portal engagement, product
-- fit, regional demand, rotated weekly). That is right for planning a route and
-- wrong the moment a rep knows what a particular visit is about. This table lets
-- the rep pin one line per dealer; the pin overrides the automatic pick and is
-- consumed when the handout prints.
--
-- ONE ROW PER DEALER, not per manufacturer — the handout features exactly one
-- line, so pinning a second replaces the first rather than stacking. That is the
-- whole reason the primary key differs from dealer_handout_exclusions, which is
-- keyed (dealer_id, manufacturer) because a dealer can have many exclusions.
--
-- A pin is a display preference. It never changes the dealer's ordering access,
-- their CRM record, or what they can buy — exactly like the exclusion tickboxes
-- it sits beside. routes-api ignores a pin pointing at a line the dealer is not
-- approved for or that has since been excluded, so a stale row is inert rather
-- than wrong.
--
-- Purely additive. Safe & idempotent. Run once in the Supabase SQL editor.
-- ============================================================================

create table if not exists dealer_handout_feature (
  dealer_id     uuid not null,
  manufacturer  text not null,                      -- slug, matched the same way exclusions are
  created_by    text,                                -- staff email or name that set the pin
  created_at    timestamptz not null default now(),
  primary key (dealer_id)
);

-- service_role only, like dealer_handout_exclusions: every read and write goes
-- through routes-api, which does its own permission check (management anywhere,
-- or the rep this dealer is assigned to). No policies = no direct client access.
alter table dealer_handout_feature enable row level security;

-- The handout loads pins for the dealers on one screen at a time, so the primary
-- key already covers every lookup. This index is for the other direction: "who am
-- I leading with on <manufacturer> this week", which is worth having cheap if a
-- rollup ever wants it.
create index if not exists dealer_handout_feature_mfr_idx
  on dealer_handout_feature(manufacturer);

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
select
  (select count(*) from dealer_handout_feature)                      as pins_now,
  (select count(*) from information_schema.columns
     where table_name='dealer_handout_feature')                      as columns_created,
  (select relrowsecurity from pg_class
     where relname='dealer_handout_feature')                         as rls_on;
